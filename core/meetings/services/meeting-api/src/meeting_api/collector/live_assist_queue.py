"""Durable two-role job outbox. A lease is persisted before enqueue; expired jobs replay."""
import hashlib
import hmac
import json
import os
import time

from .live_assist import REQUESTS, RESULTS, validator


async def tick(redis, store, cursor=0):
    secret = os.environ.get('INTERNAL_API_SECRET', '')
    if not secret:
        return 0
    try:
        await redis.xgroup_create(RESULTS, 'meeting-state', id='0-0', mkstream=True)
    except Exception as exc:
        if 'BUSYGROUP' not in str(exc):
            raise
    rows = await redis.xreadgroup('meeting-state', 'meeting-api', {RESULTS: '0'}, count=20)
    if not rows or not rows[0][1]:
        rows = await redis.xreadgroup('meeting-state', 'meeting-api', {RESULTS: '>'}, count=20)
    for _, entries in rows or []:
        for entry, fields in entries:
            raw = fields.get('payload') or '{}'
            try:
                if len(raw) > 512000:
                    raise ValueError()
                result = json.loads(raw)
                if not isinstance(result, dict) or any(type(result.get(k)) is not int for k in ('user_id', 'meeting_id')):
                    raise ValueError()
                if not validator('result').is_valid(result):
                    raise ValueError()
            except (ValueError, TypeError):
                result = None
            if result:
                started = time.perf_counter()
                outcome = await store.live_assist(result['user_id'], result['meeting_id'], action='result', payload=result)
                execution_key = f'meeting_state_lease:{result["meeting_id"]}:{result["role"]}:{result["generation"]}'
                if outcome and outcome.get('heartbeat'):
                    await redis.set(execution_key, '1', ex=outcome['signal_ttl'])
                else:
                    await redis.delete(execution_key)
                try:
                    accepted = bool((outcome or {}).get('accepted'))
                    span = {
                        'meeting_id': result['meeting_id'], 'generation': result.get('generation'), 'role': result.get('role'),
                        'stage': 'validate_and_commit', 'duration_ms': (time.perf_counter()-started)*1000,
                        'publication_revision': (outcome or {}).get('publication_revision'),
                        'status': 'accepted' if accepted else 'rejected'}
                    if not accepted:
                        span['rejection_reason'] = (outcome or {}).get('reason') or 'no_outcome'
                    await redis.xadd('meeting_state_spans', {'payload': json.dumps(span)}, maxlen=10000, approximate=True)
                except Exception:
                    pass  # committed results must be ACKed even when diagnostic transport is down
            await redis.xack(RESULTS, 'meeting-state', entry)
            await redis.xdel(RESULTS, entry)
    candidates = await store.assist_candidates(cursor)
    for row in candidates:
        cursor = row['meeting_id']
        if row.get('status') in ('completed', 'failed'):
            await drain_source(redis, store, row)
        for role in ('fast', 'reason', 'publish'):
            job = await store.live_assist(row['user_id'], row['meeting_id'], action='claim', payload={'role': role})
            if job:
                if role in ('fast', 'reason'):
                    job['execution_key'] = f'meeting_state_lease:{row["meeting_id"]}:{role}:{job["generation"]}'
                    await redis.set(job['execution_key'], '1', ex=max(1, int(job['lease_until'] - time.time())))
                job['proof'] = hmac.new(secret.encode(), json.dumps(job, sort_keys=True, ensure_ascii=False,
                    separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
                await redis.xadd(REQUESTS, {'payload': json.dumps(job, ensure_ascii=False)}, maxlen=1000, approximate=True)
    return cursor if candidates else 0


async def drain_source(redis, store, row):
    """Conservative ingestion watermark gate; ACK means hash written, then flush it durably."""
    from .ingest import STREAM_NAME, CONSUMER_GROUP
    from .db_writer import flush_meeting_segments
    tail = await redis.xrevrange(STREAM_NAME, count=1)
    watermark = str(tail[0][0]) if tail else '0-0'
    if tail:
        groups = await redis.xinfo_groups(STREAM_NAME)
        group = next((g for g in groups if g.get('name') == CONSUMER_GROUP), None)
        position = lambda v: tuple(int(p) for p in str(v).split('-'))
        if not group or position(group['last-delivered-id']) < position(watermark):
            await store.live_assist(row['user_id'], row['meeting_id'], action='drain', payload={'ready': False})
            return False
        pending = await redis.xpending_range(STREAM_NAME, CONSUMER_GROUP, min='-', max=watermark, count=1000)
        for item in pending or []:
            entry_id = item.get('message_id') or item.get('id')
            if entry_id is None:
                continue
            frame = await redis.xrange(STREAM_NAME, min=entry_id, max=entry_id, count=1)
            for _entry_id, fields in frame:
                try:
                    payload = json.loads(fields.get('payload') or '{}')
                except (ValueError, TypeError):
                    payload = {}
                if str(payload.get('meeting_id') or payload.get('uid') or '') == str(row['meeting_id']):
                    await store.live_assist(row['user_id'], row['meeting_id'], action='drain', payload={'ready': False})
                    return False
    await flush_meeting_segments(redis, store, row['meeting_id'], immutability_threshold=0)
    await store.live_assist(row['user_id'], row['meeting_id'], action='drain', payload={'watermark': watermark})
    return True


async def purge(redis, meeting_id):
    async for key in redis.scan_iter(match=f'meeting_state_job:{int(meeting_id)}:*', count=100):
        await redis.delete(key)
    async for key in redis.scan_iter(match=f'meeting_state_lease:{int(meeting_id)}:*', count=100):
        await redis.delete(key)
    for stream, group in ((REQUESTS, 'meeting-state-agent'), (RESULTS, 'meeting-state')):
        cursor = '-'
        while True:
            rows = await redis.xrange(stream, min=cursor, max='+', count=200)
            if not rows:
                break
            for eid, fields in rows:
                try:
                    matches = json.loads(fields.get('payload') or '{}').get('meeting_id') == meeting_id
                except (ValueError, AttributeError):
                    matches = False
                if matches:
                    try:
                        await redis.xack(stream, group, eid)
                    except Exception as exc:
                        if 'NOGROUP' not in str(exc):
                            raise
                    await redis.xdel(stream, eid)
            cursor = '(' + str(rows[-1][0])
