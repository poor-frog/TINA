"""Backend-owned phrase boundaries over finalized canonical transcript segments.

No model calls or transcript edits. Clients render these groups rather than inventing
their own boundaries. A live tail waits for five seconds without a new finalized
segment; completed meetings flush it immediately.
"""
import hashlib
import json
import re

TAIL_QUIET_SECONDS = 5
PAUSE_MS = 3000
MAX_SPAN_MS = 12000
MAX_WORDS = 40
MAX_CHARACTERS = 360
SENTENCE_END = re.compile(r'[.!?。！？][\"\u201d\u2019\)\]]*$')


def tail_fingerprint(segments: list[dict]) -> str:
    if not segments:
        return ''
    row = segments[-1]
    return hashlib.sha256(json.dumps([row['segment_id'], row['text']], ensure_ascii=False).encode()).hexdigest()


def source_fingerprint(group: dict) -> str:
    return hashlib.sha256(json.dumps(group['members'], ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def phrases(segments: list[dict], *, tail_ready: bool) -> list[dict]:
    groups, current = [], []

    def speaker(row):
        return row.get('speaker_id') or row.get('speaker_name') or row.get('speaker') or ''

    def joined(rows):
        return ' '.join(row['text'].strip() for row in rows)

    def finish(ready):
        if not current:
            return
        first, last = current[0], current[-1]
        groups.append({
            'group_id': 'phrase:' + hashlib.sha256(first['segment_id'].encode()).hexdigest()[:24],
            'members': [{'segment_id': row['segment_id'], 'source_text': row['text'],
                         'revision': row.get('revision', 0)} for row in current],
            'source_text': joined(current),
            'speaker_id': first.get('speaker_id') or '',
            'speaker_name': first.get('speaker_name') or first.get('speaker') or '',
            'start_ms': first.get('start_ms', 0), 'end_ms': last.get('end_ms', last.get('start_ms', 0)),
            'ready': ready,
        })
        current.clear()

    for row in segments:
        if current:
            gap = row.get('start_ms', 0) - current[-1].get('end_ms', current[-1].get('start_ms', 0))
            if (speaker(row) != speaker(current[-1]) or gap >= PAUSE_MS
                    or len(joined(current)) + len(row['text']) + 1 > MAX_CHARACTERS):
                finish(True)
        current.append(row)
        text = joined(current)
        span = row.get('end_ms', row.get('start_ms', 0)) - current[0].get('start_ms', 0)
        words = len(text.split())
        if ((words >= 6 and SENTENCE_END.search(text)) or words >= MAX_WORDS
                or len(text) >= MAX_CHARACTERS or span >= MAX_SPAN_MS):
            finish(True)
    finish(tail_ready)
    return groups
