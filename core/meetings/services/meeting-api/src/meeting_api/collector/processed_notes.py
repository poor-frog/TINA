"""Canonical-window jobs and compare-before-publish for derived AI notes.

All state transitions run under the meeting row lock. No LLM runs in that transaction.
"""
from __future__ import annotations

import copy
import time
from datetime import datetime, timezone
from uuid import uuid4

VIEW_ID = 'copilot-notes'
REQUESTS = 'canonical_notes_requests'
RESULTS = 'canonical_notes_results'
LEASE_SECONDS = 180
MAX_ATTEMPTS = 3
FINISHED_MEETING_STATUSES = ('completed', 'failed')


def notify(data, meeting_id, note_ids=None, card_ids=None):
    state = data.setdefault('canonical_notes', {})
    state['event_revision'] = int(state.get('event_revision', 0)) + 1
    data.setdefault('transcript_outbox', []).append({
        'type': 'meeting.notes.updated', 'version': 'processed-notes.v1',
        'meeting_id': meeting_id, 'event_id': str(uuid4()),
        'revision': state['event_revision'],
        'note_ids': note_ids, 'card_ids': card_ids,
        'at': datetime.now(timezone.utc).isoformat(),
    })


def snapshots(canon, memory):
    from .memory import digest
    by_id = {s['segment_id']: s for s in canon['segments']}
    result = {}
    for window in memory['windows']:
        segments = [by_id[e['segment_id']] for e in window['evidence']]
        fingerprint = digest({'meeting_id': canon['meeting_id'], 'version': 2, 'segments': segments})
        result[window['id']] = {'window_id': window['id'], 'fingerprint': fingerprint,
                               'canonical_revision': canon['revision'], 'evidence': window['evidence']}
    return result


def reconcile(data, canon, memory):
    state = data.get('canonical_notes')
    if state is None:
        return
    current = snapshots(canon, memory)
    canonical_ids = {s['segment_id'] for s in canon['segments']}
    jobs = state.setdefault('windows', {})
    for wid in list(jobs):
        if wid not in current:
            del jobs[wid]
    for wid, source in current.items():
        if jobs.get(wid, {}).get('fingerprint') != source['fingerprint']:
            prior = jobs.get(wid, {})
            jobs[wid] = {'fingerprint': source['fingerprint'], 'status': 'pending', 'attempts': 0,
                         'inflight_until': prior.get('inflight_until', 0) or (prior.get('lease_until', 0) if prior.get('status') == 'running' else 0),
                         'revoked_generation': prior.get('revoked_generation') or (prior.get('generation') if prior.get('status') == 'running' else None),
                         'revoked_admitted': prior.get('revoked_admitted', False) or (prior.get('admitted', False) if prior.get('status') == 'running' else False),
                         'segment_ids': [e['segment_id'] for e in source['evidence']],
                         'speaker_ids': list({e['speaker_id'] for e in source['evidence']})}
    dirty = False
    changed_notes, changed_cards = [], []
    publication = int(state.get('revision', 0)) + 1
    for view in data.get('processed', {}).get('views', []):
        if view.get('id') != VIEW_ID:
            continue
        for note in [*view.get('doc', {}).get('notes', []), *view.get('doc', {}).get('cards', [])]:
            source = note.get('source') or {}
            expected = current.get(source.get('window_id'), {})
            stale = not expected or source.get('fingerprint') != expected.get('fingerprint')
            if stale and not note.get('stale'):
                note['stale'] = True
                note['publication_revision'] = publication
                dirty = True
                (changed_cards if 'kind' in note else changed_notes).append(note['id'])
            if 'kind' not in note and note.get('id') not in canonical_ids and not note.get('withdrawn'):
                note.update(text='', stale=True, withdrawn=True, publication_revision=publication)
                dirty = True
                changed_notes.append(note['id'])
        view['status'] = 'stale' if any(n.get('stale') for n in view.get('doc', {}).get('notes', [])) else 'current'
    if dirty:
        state['revision'] = publication
        notify(data, canon['meeting_id'], changed_notes, changed_cards)


def invalidate(data, meeting_id, *, segment_id=None, speaker_id=None):
    """Revoke affected leases and mark notes stale in the SAME edit/rename transaction."""
    state = data.get('canonical_notes')
    if state is None:
        return
    affected = {wid for wid, job in state.get('windows', {}).items()
                if (segment_id in job.get('segment_ids', []) if segment_id is not None
                    else speaker_id in job.get('speaker_ids', []))}
    if not affected:
        return
    state['revision'] = int(state.get('revision', 0)) + 1
    for wid in affected:
        job = state['windows'][wid]
        if job['status'] == 'running':
            job['inflight_until'] = job.get('lease_until', 0)
            job['revoked_generation'] = job.get('generation')
            job['revoked_admitted'] = job.get('admitted', False)
        job.update(status='pending', attempts=0, lease_until=0)
        job.pop('generation', None)
    for view in data.get('processed', {}).get('views', []):
        if view.get('id') == VIEW_ID:
            for note in [*view.get('doc', {}).get('notes', []), *view.get('doc', {}).get('cards', [])]:
                if (note.get('source') or {}).get('window_id') in affected:
                    note.update(stale=True, publication_revision=state['revision'])
            view['status'] = 'stale'
    notify(data, meeting_id,
           [n['id'] for v in data.get('processed', {}).get('views', []) if v.get('id') == VIEW_ID for n in v.get('doc', {}).get('notes', []) if (n.get('source') or {}).get('window_id') in affected],
           [c['id'] for v in data.get('processed', {}).get('views', []) if v.get('id') == VIEW_ID for c in v.get('doc', {}).get('cards', []) if (c.get('source') or {}).get('window_id') in affected])


def configure(data, canon, memory, enabled):
    state = data.setdefault('canonical_notes', {'windows': {}})
    if state.get('enabled') == enabled and not any(j['status'] == 'failed' for j in state['windows'].values()):
        return
    state['enabled'] = enabled
    # Preserve completed windows; OFF revokes outstanding work and explicit retry resets failures.
    for job in state['windows'].values():
        if job['status'] != 'completed':
            job.update(status='pending', attempts=0, lease_until=0)
            job.pop('generation', None)
    reconcile(data, canon, memory)
    from .adapters import _upsert_processed_view
    data['processed'] = _upsert_processed_view(data, view_id=VIEW_ID, kind='cleaned_transcript',
        notes=[], source_cursor=None, params=None)['processed']
    notify(data, canon['meeting_id'])


def claim(data, canon, memory, now=None):
    now = time.time() if now is None else now
    state = data.get('canonical_notes') or {}
    if not state.get('enabled'):
        return None
    if any((j.get('status') == 'running' and j.get('lease_until', 0) > now) or j.get('inflight_until', 0) > now
           for j in state.get('windows', {}).values()):
        return None  # one model request per meeting at a time
    sources = snapshots(canon, memory)
    for wid, job in state.get('windows', {}).items():
        if job['status'] == 'completed' or max(job.get('lease_until', 0), job.get('inflight_until', 0)) > now:
            continue
        if job.get('attempts', 0) >= MAX_ATTEMPTS:
            if job['status'] != 'failed':
                notify(data, canon['meeting_id'])
            job['status'] = 'failed'
            continue
        source = sources[wid]
        import json
        if (sum(len(e['quote']) for e in source['evidence']) > 12000 or len(source['evidence']) > 120
                or len(json.dumps(source, ensure_ascii=False).encode()) > 90000):
            job.update(status='failed', attempts=MAX_ATTEMPTS, error='window_too_large')
            notify(data, canon['meeting_id'])
            continue
        job.update(status='running', attempts=job.get('attempts', 0) + 1,
                   generation=str(uuid4()), lease_until=now + LEASE_SECONDS,
                   canonical_revision=canon['revision'], admitted=False)
        job.pop('error', None)
        job.pop('revoked_generation', None)
        job.pop('revoked_admitted', None)
        job.pop('inflight_until', None)
        return {'meeting_id': canon['meeting_id'], 'lease_until': job['lease_until'],
                'source': copy.deepcopy(source) | {'generation': job['generation']}}
    return None


def valid_claim(data, canon, memory, source):
    if not isinstance(source, dict) or not isinstance(source.get('window_id'), str):
        return False
    state = data.get('canonical_notes') or {}
    job = state.get('windows', {}).get(source['window_id'], {})
    current = snapshots(canon, memory).get(source['window_id'], {})
    return bool(state.get('enabled') and current and job.get('status') == 'running'
                and job.get('lease_until', 0) > time.time()
                and source.get('generation') == job.get('generation')
                and source.get('fingerprint') == current.get('fingerprint'))


def admit(data, canon, memory, source):
    if not isinstance(source, dict) or not isinstance(source.get('window_id'), str):
        return False
    valid = valid_claim(data, canon, memory, source)
    job = (data.get('canonical_notes') or {}).get('windows', {}).get(source.get('window_id'), {})
    if valid:
        job['admitted'] = True
    elif source.get('generation') == job.get('revoked_generation') and not job.get('revoked_admitted'):
        job['inflight_until'] = 0  # canceled before any model call; the latest source may start now
    return valid


def accept(data, canon, memory, result):
    source = result.get('source') or {}
    if not isinstance(source, dict) or any(not isinstance(source.get(k), str) for k in ('window_id', 'generation', 'fingerprint')):
        return {'accepted': False, 'reason': 'invalid_source'}
    state = data.get('canonical_notes') or {}
    job = state.get('windows', {}).get(source.get('window_id'), {})
    if source.get('generation') and source.get('generation') == job.get('revoked_generation'):
        job.pop('revoked_generation', None)
        job.pop('revoked_admitted', None)
        job['inflight_until'] = 0
    current = snapshots(canon, memory).get(source.get('window_id'), {})
    if (state.get('enabled') and current and job.get('status') == 'completed'
            and source.get('generation') == job.get('generation')
            and source.get('fingerprint') == current.get('fingerprint')):
        return {'accepted': True, 'duplicate': True}
    if (not state.get('enabled') or not current or job.get('status') != 'running'
            or job.get('lease_until', 0) <= time.time()
            or source.get('generation') != job.get('generation')
            or source.get('fingerprint') != current.get('fingerprint')):
        return {'accepted': False, 'reason': 'stale_source'}
    if result.get('error'):
        job.update(status='pending', lease_until=time.time() + 10, error=str(result['error'])[:160])
        notify(data, canon['meeting_id'])
        return {'accepted': False, 'reason': 'model_error'}
    evidence = {e['segment_id']: e for e in current['evidence']}
    notes = result.get('notes')
    if (not isinstance(notes, list) or len(notes) != len(evidence)
            or any(not isinstance(n, dict) or not isinstance(n.get('id'), str) or not isinstance(n.get('text'), str)
                   or not n['text'].strip() or len(n['text']) > 16000 for n in notes)
            or {n['id'] for n in notes} != set(evidence)):
        job.update(status='pending', lease_until=time.time() + 10, error='invalid_notes')
        return {'accepted': False, 'reason': 'invalid_notes'}
    approved_source = {k: source[k] for k in ('window_id', 'fingerprint', 'generation')}
    approved_source['canonical_revision'] = job['canonical_revision']
    raw_params = result.get('params') if isinstance(result.get('params'), dict) else {}
    params = {'pipeline': 'canonical-readable', 'version': 2, 'prompt_version': 1,
              **{k: str(raw_params.get(k) or '')[:256] for k in ('provider', 'model')}}
    prompt_hash = raw_params.get('prompt_sha256')
    if isinstance(prompt_hash, str) and len(prompt_hash) == 64 and all(c in '0123456789abcdef' for c in prompt_hash):
        params['prompt_sha256'] = prompt_hash
    approved = []
    publication = int(state.get('revision', 0)) + 1
    for note in notes:
        e = evidence[note['id']]
        approved.append({'id': note['id'], 'text': note['text'], 'speaker': e['speaker_name'],
                         'chapter': str(note.get('chapter') or '')[:512], 't': e['start_ms'] / 1000,
                         'pass': 1, 'frozen': True, 'stale': False,
                         'withdrawn': False,
                         'publication_revision': publication,
                         'source': approved_source, 'provenance': params, 'evidence': [copy.deepcopy(e)]})
    from .adapters import _upsert_processed_view
    merged = _upsert_processed_view(data, view_id=VIEW_ID, kind='cleaned_transcript', notes=approved,
                                   source_cursor=None, params=params)
    data['processed'] = merged['processed']
    view = next(v for v in data['processed']['views'] if v['id'] == VIEW_ID)
    cards = result.get('cards') if isinstance(result.get('cards'), list) else []
    from .memory import digest
    approved_cards = []
    for index, card in enumerate(cards[:20]):
        if not isinstance(card, dict) or not isinstance(card.get('title'), str) or not card['title'].strip():
            continue
        grounded = [e for e in current['evidence'] if card['title'].casefold() in e['quote'].casefold()][:3]
        if not grounded:
            continue
        approved_cards.append({'id': digest([source['window_id'], index]),
            'kind': str(card.get('kind') or 'signal')[:80], 'title': card['title'][:512],
            'body': str(card.get('body') or '')[:4000], 'source': approved_source, 'provenance': params,
            'evidence': copy.deepcopy(grounded), 'stale': False, 'publication_revision': publication})
    card_ids = {c['id'] for c in approved_cards}
    remaining = []
    for card in view['doc'].get('cards', []):
        if card.get('id') in card_ids:
            continue
        if (card.get('source') or {}).get('window_id') == source['window_id']:
            card = dict(card, stale=True, publication_revision=publication)
        remaining.append(card)
    view['doc']['cards'] = remaining + approved_cards
    state['revision'] = publication
    job.update(status='completed', lease_until=0)
    job.pop('error', None)
    notify(data, canon['meeting_id'], [n['id'] for n in approved],
           [c['id'] for c in view['doc']['cards'] if (c.get('source') or {}).get('window_id') == source['window_id']])
    return {'accepted': True, 'notes': approved}


def refresh_status(data):
    state = data.get('canonical_notes') or {}
    jobs = list(state.get('windows', {}).values())
    status = ('disabled' if not state.get('enabled') else 'failed' if any(j['status'] == 'failed' for j in jobs)
              else 'pending' if any(j['status'] in ('pending', 'running') for j in jobs) else 'current')
    for view in data.get('processed', {}).get('views', []):
        if view.get('id') == VIEW_ID:
            view['status'] = status


async def publish_projection(redis, state, event):
    """Publish changed derived rows; a complete final snapshot precedes its terminal marker."""
    import json
    if not state or not state.get('configured'):
        return
    view = state.get('view') or {}
    mid = event['meeting_id']
    complete = state.get('enabled') and state.get('finished') and all(w['status'] in ('completed', 'failed') for w in state['windows'])
    version = state.get('publication_revision', 0)
    closed_key = f'canonical:meeting:{mid}:closed-version'
    closing = complete and int(await redis.get(closed_key) or '-1') < version
    if event['type'] != 'meeting.notes.updated' and not closing:
        return
    pipe = redis.pipeline(transaction=True)
    for kind, field in (('notes', 'note'), ('cards', 'card')):
        selected = None if closing else event.get('note_ids' if kind == 'notes' else 'card_ids')
        wanted = set(selected) if selected is not None else None
        for item in view.get('doc', {}).get(kind, []):
            if wanted is None or item.get('id') in wanted:
                pipe.xadd(f'proc:meeting:{mid}', {field: json.dumps(item, ensure_ascii=False),
                          'params': json.dumps(view.get('params') or {})})
    if view.get('status') == 'failed':
        pipe.xadd(f'proc:meeting:{mid}', {'error': json.dumps({'stage': 'canonical-notes',
                  'message': 'AI notes could not be refreshed. Check model settings and retry processing.'})})
    if closing:
        pipe.xadd(f'proc:meeting:{mid}', {'type': 'view_end'})
        pipe.set(closed_key, str(version), ex=604800)
    await pipe.execute()


async def publish_request(redis, store, user_id, meeting_id):
    import json
    import os
    import hmac
    import hashlib
    state = await store.processed_notes(user_id, meeting_id)
    # Migrate existing opt-in flags once. An explicit OFF always creates durable configuration.
    if state and not state.get('configured') and await redis.get(f'proc:meeting:{meeting_id}:on'):
        state = await store.processed_notes(user_id, meeting_id, action='configure', payload={'enabled': True})
    if not state or not state.get('enabled') or not state.get('finished'):
        return None
    secret = os.environ.get('INTERNAL_API_SECRET', '')
    if not secret:
        raise RuntimeError('Canonical notes request signing is not configured')
    job = await store.processed_notes(user_id, meeting_id, action='claim')
    if job:
        job['proof'] = hmac.new(secret.encode(), json.dumps(job, sort_keys=True, ensure_ascii=False,
            separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
        await redis.xadd(REQUESTS, {'payload': json.dumps(job, ensure_ascii=False)})
    return job


async def drain_results(redis, store):
    import json
    try:
        await redis.xgroup_create(RESULTS, 'canonical-notes', id='0-0', mkstream=True)
    except Exception as exc:
        if 'BUSYGROUP' not in str(exc):
            raise
    rows = await redis.xreadgroup('canonical-notes', 'meeting-api', {RESULTS: '0'}, count=20)
    if not rows or not rows[0][1]:
        rows = await redis.xreadgroup('canonical-notes', 'meeting-api', {RESULTS: '>'}, count=20)
    for _, entries in rows or []:
        for entry_id, fields in entries:
            try:
                raw = fields.get('payload') or fields.get(b'payload') or '{}'
                if len(raw) > 256000:
                    raise ValueError('Result too large')
                result = json.loads(raw)
                if (not isinstance(result, dict) or type(result.get('user_id')) is not int
                        or type(result.get('meeting_id')) is not int):
                    raise ValueError('Invalid result identity')
            except (ValueError, TypeError):
                await redis.xack(RESULTS, 'canonical-notes', entry_id)
                await redis.xdel(RESULTS, entry_id)
                continue
            # DB commit precedes ACK; redelivery is idempotent and leases survive process crashes.
            await store.processed_notes(result['user_id'], result['meeting_id'], action='result', payload=result)
            await redis.xack(RESULTS, 'canonical-notes', entry_id)
            await redis.xdel(RESULTS, entry_id)


async def purge_queued(redis, meeting_id):
    """Remove source text held in pending queues when meeting artifacts are deleted."""
    import json
    for stream, group in ((REQUESTS, 'canonical-agent'), (RESULTS, 'canonical-notes')):
        tail = await redis.xrevrange(stream, count=1)
        if not tail:
            continue
        stop, cursor = tail[0][0], '-'
        while True:
            rows = await redis.xrange(stream, min=cursor, max=stop, count=200)
            if not rows:
                break
            for entry_id, fields in rows:
                try:
                    payload = json.loads(fields.get('payload') or fields.get(b'payload') or '{}')
                    matches = isinstance(payload, dict) and payload.get('meeting_id') == meeting_id
                except (ValueError, TypeError):
                    matches = False
                if matches:
                    try:
                        await redis.xack(stream, group, entry_id)
                    except Exception as exc:
                        if 'NOGROUP' not in str(exc): raise
                    await redis.xdel(stream, entry_id)
            last = rows[-1][0]
            cursor = '(' + (last.decode() if isinstance(last, bytes) else last)
    await redis.delete(f'canonical:meeting:{meeting_id}:on', f'canonical:meeting:{meeting_id}:closed-version')
