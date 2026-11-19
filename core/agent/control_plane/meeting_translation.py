"""Owner-authorized, durable English translations; raw/canonical transcripts are read-only.

Clients advance one ready phrase per POST while a translated view is open. SQLite
leases deduplicate concurrent web/extension requests, including separate API processes.
Phrase failures back off independently; service failures cool down the owner's translations.
GET never invokes inference.
"""
from __future__ import annotations

from contextlib import contextmanager
import sqlite3
import time
import uuid
from pathlib import Path

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from control_plane.meeting_knowledge import meeting_get
from shared.translation_text import TRANSLATION_FAILURE_STATUS, visible_translation
from shared.translation_groups import TAIL_QUIET_SECONDS, phrases, source_fingerprint, tail_fingerprint


class Advance(BaseModel):
    model_config = ConfigDict(extra='forbid')
    retry: bool = False
    segment_ids: list[str] = Field(default_factory=list, max_length=128)


MAX_PHRASE_FAILURES = 3
SERVICE_FAILURES = {'auth', 'configuration', 'rate_limit', 'unavailable'}


def retry_delay(failures):
    return (15, 60, 300)[min(failures, 3) - 1]


def cached_text(saved, group):
    if not group['ready'] or not saved:
        return None
    fingerprints = {source_fingerprint(group)}
    if all(member.get('revision', 0) == 0 for member in group['members']):
        # Existing unedited phrase results predate revision-bearing source members.
        legacy = {**group, 'members': [{'segment_id': m['segment_id'], 'source_text': m['source_text']}
                                     for m in group['members']]}
        fingerprints.add(source_fingerprint(legacy))
    if saved['source_hash'] not in fingerprints:
        return None
    try:
        return visible_translation(saved['translated'])
    except ValueError:
        return None


def failure_code(exc):
    if isinstance(exc, HTTPException):
        return {401: 'auth', 403: 'auth', 404: 'configuration', 429: 'rate_limit',
                422: 'invalid_translation', 400: 'request_rejected', 408: 'timeout',
                504: 'timeout'}.get(exc.status_code, 'unavailable')
    return 'invalid_translation' if isinstance(exc, ValueError) else 'unavailable'


class TranslationStore:
    def __init__(self, path: Path):
        self.path = path

    @contextmanager
    def connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.executescript('''
            CREATE TABLE IF NOT EXISTS phrase_translations (
                owner TEXT, meeting INTEGER, phrase TEXT, source_hash TEXT, translated TEXT,
                PRIMARY KEY(owner, meeting, phrase));
            CREATE TABLE IF NOT EXISTS translation_tails (
                owner TEXT, meeting INTEGER, source_hash TEXT, observed_at REAL,
                PRIMARY KEY(owner, meeting));
            CREATE TABLE IF NOT EXISTS translation_jobs (
                owner TEXT, meeting INTEGER, token TEXT DEFAULT '', lease REAL DEFAULT 0,
                failures INTEGER DEFAULT 0, retry_at REAL DEFAULT 0,
                PRIMARY KEY(owner, meeting));
            CREATE TABLE IF NOT EXISTS translation_phrase_attempts (
                owner TEXT, meeting INTEGER, phrase TEXT, source_hash TEXT,
                attempts INTEGER DEFAULT 0, failures INTEGER DEFAULT 0,
                retry_at REAL DEFAULT 0, error_code TEXT DEFAULT '',
                PRIMARY KEY(owner, meeting, phrase));
            CREATE TABLE IF NOT EXISTS translation_services (
                owner TEXT PRIMARY KEY, failures INTEGER DEFAULT 0, retry_at REAL DEFAULT 0,
                error_code TEXT DEFAULT '', generation INTEGER DEFAULT 0);
        ''')
        try:
            if connection.execute('PRAGMA user_version').fetchone()[0] < 1:
                connection.execute('BEGIN IMMEDIATE')
                # Another API process may have migrated while this connection waited.
                if connection.execute('PRAGMA user_version').fetchone()[0] < 1:
                    columns = {row['name'] for row in connection.execute('PRAGMA table_info(translation_jobs)')}
                    for name, definition in (('phrase', "TEXT DEFAULT ''"), ('source_hash', "TEXT DEFAULT ''"),
                                             ('service_generation', 'INTEGER DEFAULT 0')):
                        if name not in columns:
                            connection.execute(f'ALTER TABLE translation_jobs ADD COLUMN {name} {definition}')
                    # Legacy errors have no phrase identity/type. Preserve their remaining
                    # cooldown as a conservative owner service failure, and preserve leases.
                    for row in connection.execute('SELECT owner, MAX(retry_at) AS retry_at, MAX(failures) AS failures FROM translation_jobs WHERE retry_at > 0 GROUP BY owner').fetchall():
                        connection.execute('INSERT OR IGNORE INTO translation_services(owner, failures, retry_at, error_code) VALUES (?,?,?,?)',
                                           (row['owner'], row['failures'], row['retry_at'], 'unavailable'))
                    connection.execute('UPDATE translation_jobs SET failures=0, retry_at=0')
                    connection.execute('PRAGMA user_version=1')
                connection.commit()
            yield connection
        finally:
            connection.close()

    def observe(self, owner, meeting, segments):
        """Use observed stability, not capture wall time: delayed ASR must still be buffered."""
        digest, now = tail_fingerprint(segments), time.time()
        with self.connect() as db:
            db.execute('''INSERT INTO translation_tails VALUES (?,?,?,?)
                          ON CONFLICT(owner, meeting) DO UPDATE SET
                          source_hash=excluded.source_hash, observed_at=excluded.observed_at
                          WHERE translation_tails.source_hash != excluded.source_hash''',
                       (owner, meeting, digest, now))

    def snapshot(self, owner, meeting, segments, live=False):
        with self.connect() as db:
            db.execute('BEGIN')
            cached = {row['phrase']: row for row in db.execute(
                'SELECT * FROM phrase_translations WHERE owner=? AND meeting=?', (owner, meeting))}
            attempts = {row['phrase']: row for row in db.execute(
                'SELECT * FROM translation_phrase_attempts WHERE owner=? AND meeting=?', (owner, meeting))}
            job = db.execute('SELECT * FROM translation_jobs WHERE owner=? AND meeting=?', (owner, meeting)).fetchone()
            tail = db.execute('SELECT * FROM translation_tails WHERE owner=? AND meeting=?', (owner, meeting)).fetchone()
            service = db.execute('SELECT * FROM translation_services WHERE owner=?', (owner,)).fetchone()
            db.commit()
        now = time.time()
        tail_ready = not live or bool(tail and tail['source_hash'] == tail_fingerprint(segments)
                                      and now - tail['observed_at'] >= TAIL_QUIET_SECONDS)
        rows = []
        running = bool(job and job['lease'] > now)
        for group in phrases(segments, tail_ready=tail_ready):
            digest = source_fingerprint(group)
            attempt = attempts.get(group['group_id'])
            if attempt and attempt['source_hash'] != digest:
                attempt = None
            translated = cached_text(cached.get(group['group_id']), group)
            status = 'pending'
            if translated:
                status = 'complete'
            elif not group['ready']:
                status = 'waiting'
            elif running and job['phrase'] == group['group_id'] and job['source_hash'] == digest:
                status = 'running'
            elif attempt and attempt['failures'] >= MAX_PHRASE_FAILURES:
                status = 'failed'
            elif attempt and attempt['retry_at'] > now:
                status = 'retrying'
            row = {**group, 'translated_text': translated, 'status': status,
                   'attempts': attempt['attempts'] if attempt else 0,
                   'retry_after': max(0, int(attempt['retry_at'] - now) + 1) if status == 'retrying' else 0}
            if attempt and attempt['error_code'] and status in ('pending', 'retrying', 'failed'):
                row['error_code'] = attempt['error_code']
            rows.append(row)
        pending = sum(row['translated_text'] is None for row in rows)
        service_paused = bool(service and service['retry_at'] > now)
        eligible = any(row['status'] == 'pending' for row in rows)
        blocked = [row for row in rows if row['status'] in ('retrying', 'failed')]
        paused = service_paused or (not eligible and bool(blocked))
        wait = max(0, int(service['retry_at'] - now) + 1) if service_paused else min(
            (row['retry_after'] or 300 for row in blocked), default=0)
        return {'version': 'meeting-translation.v2', 'meeting_id': meeting, 'target_language': 'en',
                'status': 'complete' if not pending else 'running' if running else 'paused' if paused else 'pending',
                'retry_after': wait if paused and pending else 0,
                'can_advance': bool(eligible and not running and not service_paused),
                **({'service_error': service['error_code']} if service_paused and pending else {}),
                'total': len(rows), 'completed': len(rows) - pending, 'groups': rows}

    def claim(self, owner, meeting, groups, retry=False):
        now, token = time.time(), uuid.uuid4().hex
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT OR IGNORE INTO translation_jobs(owner, meeting) VALUES (?,?)', (owner, meeting))
            row = db.execute('SELECT * FROM translation_jobs WHERE owner=? AND meeting=?', (owner, meeting)).fetchone()
            db.execute('INSERT OR IGNORE INTO translation_services(owner) VALUES (?)', (owner,))
            service = db.execute('SELECT * FROM translation_services WHERE owner=?', (owner,)).fetchone()
            if row['lease'] > now or (service['retry_at'] > now and not retry):
                db.commit()
                return None
            cached = {item['phrase']: item for item in db.execute(
                'SELECT * FROM phrase_translations WHERE owner=? AND meeting=?', (owner, meeting))}
            attempts = {item['phrase']: item for item in db.execute(
                'SELECT * FROM translation_phrase_attempts WHERE owner=? AND meeting=?', (owner, meeting))}
            candidates = []
            for index, group in enumerate(groups):
                if not group['ready'] or cached_text(cached.get(group['group_id']), group):
                    continue
                attempt = attempts.get(group['group_id'])
                if attempt and attempt['source_hash'] != source_fingerprint(group):
                    attempt = None
                if not retry and attempt and (attempt['retry_at'] > now or attempt['failures'] >= MAX_PHRASE_FAILURES):
                    continue
                candidates.append((0 if retry and attempt and attempt['error_code'] else 1, index, group, attempt))
            if not candidates:
                db.commit()
                return None
            _, _, group, attempt = min(candidates, key=lambda item: item[:2])
            digest = source_fingerprint(group)
            db.execute('INSERT OR REPLACE INTO translation_phrase_attempts VALUES (?,?,?,?,?,?,?,?)',
                       (owner, meeting, group['group_id'], digest, (attempt['attempts'] if attempt else 0) + 1,
                        attempt['failures'] if attempt else 0, 0, 'interrupted'))
            db.execute('UPDATE translation_jobs SET token=?, lease=?, phrase=?, source_hash=?, service_generation=? WHERE owner=? AND meeting=?',
                       (token, now + 120, group['group_id'], digest, service['generation'], owner, meeting))
            db.commit()
        return token, group

    def finish(self, owner, meeting, token, group, translated, error_code=None, *, current=True):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            job = db.execute('SELECT * FROM translation_jobs WHERE owner=? AND meeting=?', (owner, meeting)).fetchone()
            if not job or job['token'] != token or job['lease'] <= time.time():
                db.commit()
                return
            attempt = db.execute('SELECT * FROM translation_phrase_attempts WHERE owner=? AND meeting=? AND phrase=?',
                                 (owner, meeting, group['group_id'])).fetchone()
            if job['phrase'] != group['group_id'] or job['source_hash'] != source_fingerprint(group):
                db.commit()
                return
            service = db.execute('SELECT * FROM translation_services WHERE owner=?', (owner,)).fetchone()
            if error_code in SERVICE_FAILURES:
                failures = service['failures'] + 1
                db.execute('UPDATE translation_services SET failures=?, retry_at=?, error_code=?, generation=generation+1 WHERE owner=?',
                           (failures, time.time() + retry_delay(failures), error_code, owner))
                db.execute('UPDATE translation_phrase_attempts SET error_code=? WHERE owner=? AND meeting=? AND phrase=?',
                           (error_code, owner, meeting, group['group_id']))
            elif current and translated:
                db.execute('INSERT OR REPLACE INTO phrase_translations VALUES (?,?,?,?,?)',
                           (owner, meeting, group['group_id'], source_fingerprint(group), translated))
                db.execute('UPDATE translation_phrase_attempts SET failures=0, retry_at=0, error_code=? WHERE owner=? AND meeting=? AND phrase=?',
                           ('', owner, meeting, group['group_id']))
                # An older in-flight success must not undo a newer failure from another meeting.
                db.execute('UPDATE translation_services SET failures=0, retry_at=0, error_code=? WHERE owner=? AND generation=?',
                           ('', owner, job['service_generation']))
            elif current:
                failures = attempt['failures'] + 1
                code = error_code if error_code in TRANSLATION_FAILURE_STATUS else 'invalid_translation'
                db.execute('UPDATE translation_phrase_attempts SET failures=?, retry_at=?, error_code=? WHERE owner=? AND meeting=? AND phrase=?',
                           (failures, time.time() + retry_delay(failures), code, owner, meeting, group['group_id']))
            db.execute('UPDATE translation_jobs SET token=?, lease=0, phrase=?, source_hash=? WHERE owner=? AND meeting=?',
                       ('', '', '', owner, meeting))
            db.commit()


def register(app, subject_of, root: Path, meeting_api_url: str, complete):
    # Outside workspace Git trees; persisted by the existing agent workspace volume.
    store = TranslationStore(root / '.meeting-translations' / 'translations.sqlite3')

    def load(request, meeting_id):
        if meeting_id < 1:
            raise HTTPException(422, 'Invalid meeting')
        subject = subject_of(request)
        canonical = meeting_get(meeting_api_url, subject, meeting_id, f'/transcripts/by-id/{meeting_id}/canonical')
        meeting = meeting_get(meeting_api_url, subject, meeting_id, f'/meetings/{meeting_id}')
        segments = [row for row in canonical.get('segments', [])
                    if row.get('segment_id') and row.get('completed') is not False and row.get('text', '').strip()]
        # The canonical contract bounds the archive; reject unsupported inputs before inference.
        if len(segments) > 2000 or any(len(row['text']) > 10000 for row in segments):
            raise HTTPException(413, 'Transcript exceeds translation limits')
        segments.sort(key=lambda row: row.get('start_ms', 0))
        live = meeting.get('status') not in {'completed', 'stopped', 'failed', 'past', 'cancelled'}
        store.observe(subject, meeting_id, segments)
        return subject, segments, live

    @app.get('/api/meeting-translations/{meeting_id}')
    def read(request: Request, meeting_id: int):
        subject, segments, live = load(request, meeting_id)  # Reauthorize even a fully cached archive.
        return store.snapshot(subject, meeting_id, segments, live)

    @app.post('/api/meeting-translations/{meeting_id}')
    def advance(request: Request, meeting_id: int, body: Advance):
        subject, segments, live = load(request, meeting_id)
        state = store.snapshot(subject, meeting_id, segments, live)
        priority = {sid: index for index, sid in enumerate(body.segment_ids) if len(sid) <= 512}
        pending = [row for row in state['groups'] if row['ready'] and row['translated_text'] is None]
        if not pending:
            return state
        # Rendered live turns may be a tail of the archive. Show their translations before backfill.
        pending.sort(key=lambda row: min((priority.get(member['segment_id'], len(priority)) for member in row['members']), default=len(priority)))
        claimed = store.claim(subject, meeting_id, pending, body.retry)
        if not claimed:
            return store.snapshot(subject, meeting_id, segments, live)
        token, missing = claimed
        translated, error = None, None
        try:
            candidate = complete(request, missing['source_text'])
            if not isinstance(candidate, str):
                raise ValueError('Invalid translation')
            translated = visible_translation(candidate)
        except Exception as exc:  # Provider details, credentials and transcript stay private.
            error = failure_code(exc)
        current = False
        try:
            # Reauthorize and reread after inference: edits, deletion or regrouping
            # while a model was running must not publish an old response.
            _, segments, live = load(request, meeting_id)
            latest = store.snapshot(subject, meeting_id, segments, live)
            current = any(row['ready'] and row['group_id'] == missing['group_id']
                          and source_fingerprint(row) == source_fingerprint(missing) for row in latest['groups'])
        finally:
            store.finish(subject, meeting_id, token, missing, translated, error, current=current)
        return store.snapshot(subject, meeting_id, segments, live)
