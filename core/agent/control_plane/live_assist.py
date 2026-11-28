"""Signed meeting-state dispatch and best-effort, metadata-only operator diagnostics."""
import collections
import hashlib
import hmac
import json
import logging
import math
import os
import re
import threading
import time
import urllib.request

from llm.errors import MODEL_REQUEST_FAILURE_CODES
from shared import units

log = logging.getLogger(__name__)
_traces = collections.deque(maxlen=10000)
_lock = threading.Lock()


def record(span):
    # Allowlist only; never accept arbitrary provider bodies or prompts in diagnostics.
    allowed = {'meeting_id', 'generation', 'role', 'stage', 'duration_ms', 'attempt', 'model', 'provider',
               'input_tokens', 'output_tokens', 'cache_read_tokens', 'provider_timings', 'status'}
    allowed.add('publication_revision')
    clean = {k: v for k, v in span.items() if k in allowed}
    if clean.get('stage') == 'model_request' and clean.get('status') == 'error':
        code = span.get('failure_code')
        if isinstance(code, str) and code in MODEL_REQUEST_FAILURE_CODES:
            clean['failure_code'] = code
        status = span.get('http_status')
        if type(status) is int and 400 <= status <= 599:
            clean['http_status'] = status
    if clean.get('stage') == 'parse_and_schema' and clean.get('status') == 'error':
        kind = span.get('error_kind')
        if kind in ('invalid_json', 'schema_invalid', 'non_object', 'validation_error'):
            clean['error_kind'] = kind
        if kind == 'invalid_json':
            for key in ('json_line', 'json_column'):
                value = span.get(key)
                if type(value) is int and 0 < value <= 1000000:
                    clean[key] = value
        if kind == 'schema_invalid':
            for key, pattern in (('schema_keyword', r'[A-Za-z]{1,32}'),
                                 ('schema_path', r'[A-Za-z0-9_/$]{1,240}')):
                value = span.get(key)
                if isinstance(value, str) and re.fullmatch(pattern, value):
                    clean[key] = value
    if clean.get('stage') == 'validate_and_commit' and clean.get('status') == 'rejected':
        reason = span.get('rejection_reason')
        if reason in ('stale_job', 'stale_source', 'model_error', 'invalid_provenance', 'invalid_output',
                      'schema_invalid', 'invalid_items', 'incomplete_reconciliation',
                      'invalid_citation_or_item', 'invalid_details', 'context_only_extraction',
                      'publication_failed', 'no_outcome'):
            clean['rejection_reason'] = reason
    for key in ('duration_ms', 'input_tokens', 'output_tokens', 'cache_read_tokens'):
        v = clean.get(key)
        if v is not None and (type(v) not in (int, float) or not math.isfinite(v) or v < 0):
            clean[key] = None
    if 'provider_timings' in clean:
        timings = clean['provider_timings']
        clean['provider_timings'] = {k: v for k, v in timings.items() if k in ('queue_ms', 'prefill_ms', 'generation_ms')
                                     and type(v) in (int, float) and math.isfinite(v) and v >= 0} if isinstance(timings, dict) else None
    clean['at'] = time.time()
    with _lock:
        _traces.append(clean)
    log.info('meeting_state_span %s', json.dumps(clean, ensure_ascii=False))


def traces(meeting_id):
    with _lock:
        cutoff = time.time() - 86400
        while _traces and _traces[0]['at'] < cutoff:
            _traces.popleft()
        rows = [dict(s) for s in _traces if s.get('meeting_id') == meeting_id]
    timings = {}
    for stage in {r.get('stage') for r in rows}:
        values = sorted(r['duration_ms'] for r in rows if r.get('stage') == stage and isinstance(r.get('duration_ms'), (int, float)))
        if values:
            timings[stage] = {'count': len(values), 'p50_ms': values[(len(values)-1)//2], 'p95_ms': values[min(len(values)-1, int(len(values)*.95))]}
    return {'spans': rows, 'timings': timings, 'best_effort': True, 'ttl_seconds': 86400,
            'missing_spans_possible': True, 'provider_internal_timings': 'available only when reported'}


def workspace_roster(settings, workspace_id):
    return sorted({int(m['subject']) for m in workspace_members(settings, workspace_id)
                   if m['subject'].isdigit() and int(m['subject']) > 0})


def workspace_members(settings, workspace_id):
    from pathlib import Path
    import stat
    from control_plane import workspace_membership as membership
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', workspace_id):
        raise ValueError('Invalid workspace')
    path = membership._ws_dir(Path(settings.workspaces_dir), workspace_id) / membership.MEMBERS_FILE
    if not path.exists():
        return []
    if path.is_symlink():
        raise ValueError('Workspace roster cannot be a symlink')
    if hasattr(os, 'O_NOFOLLOW'):
        from control_plane.workspace_routines import _routine_directory
        directory = _routine_directory(path)
        try:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(fd, 'rb') as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError('Workspace roster must be a regular file')
                raw = stream.read(1000001)
        finally:
            os.close(directory)
    else:
        with path.open('rb') as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode):
                raise ValueError('Workspace roster must be a regular file')
            raw = stream.read(1000001)
    if len(raw) > 1000000:
        raise ValueError('Roster too large')
    members = json.loads(raw)
    if (not isinstance(members, list) or len(members) > 10000
            or any(not isinstance(m, dict) or not isinstance(m.get('subject'), str)
                   or m.get('role') not in ('owner', 'contributor', 'viewer') for m in members)):
        raise ValueError('Invalid roster')
    return members


def meeting_post(settings, job, action, payload, *, workspaces=None):
    secret = settings.internal_api_secret.get_secret_value()
    headers = {'X-User-Id': str(job['user_id']), 'X-Internal-Secret': secret, 'Content-Type': 'application/json'}
    if workspaces:
        headers['X-User-Workspaces'] = ','.join(sorted(workspaces))
    req = urllib.request.Request(settings.meeting_api_url.rstrip('/') + f'/transcripts/by-id/{job["meeting_id"]}/state/{action}',
        method='POST', data=json.dumps(payload).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)


def dispatch_request(dispatcher, job, client=None):
    secret = dispatcher.settings.internal_api_secret.get_secret_value()
    if not secret or not isinstance(job, dict) or not isinstance(job.get('proof'), str):
        raise ValueError('Unsigned meeting-state request')
    unsigned = {k: v for k, v in job.items() if k != 'proof'}
    proof = hmac.new(secret.encode(), json.dumps(unsigned, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(proof, job['proof']):
        raise ValueError('Invalid meeting-state proof')
    from contracts.loader import validate_meeting_state_job
    from jsonschema import ValidationError
    try:
        validate_meeting_state_job(job)
    except ValidationError:
        raise ValueError('Invalid meeting-state request') from None
    admission_start = time.perf_counter()
    validation = {'role': job['role'], 'generation': job['generation']}
    if job['role'] == 'publish':
        validation.update(audience_stamp=job.get('audience_stamp'), publication_revision=job.get('publication_revision'), source_keys=job.get('source_keys'))
    admitted = meeting_post(dispatcher.settings, job, 'validate', validation).get('valid')
    record({'meeting_id': job['meeting_id'], 'generation': job['generation'], 'role': job['role'],
            'stage': 'admission_and_source_check', 'duration_ms': (time.perf_counter()-admission_start)*1000,
            'status': 'admitted' if admitted else 'revoked'})
    if not admitted:
        return
    role = job['role']
    if role == 'publish':
        outcome = publish_snapshot(dispatcher.settings, job)
        result = {'role': role, 'generation': job['generation'], 'outcome': outcome,
                  'audience_stamp': job['audience_stamp'], 'publication_revision': job['publication_revision'],
                  'source_keys': job['source_keys']}
        accepted = meeting_post(dispatcher.settings, job, 'result', result)
        if outcome == 'published' and not accepted.get('accepted'):
            scrub_stale_snapshot(dispatcher.settings, job)
        return
    from control_plane.meeting_voice_completion import resolve_voice_model_env
    resolver = getattr(dispatcher, 'resolve_model_config', None)
    user_model_env = (
        resolve_voice_model_env(
            resolver(str(job['user_id'])),
            allowlist=dispatcher.settings.model_allowlist,
            subject=str(job['user_id']),
        )
        if callable(resolver) else {}
    )
    model = (
        (user_model_env.get('TINA_LLM_MODEL') or '').strip()
        or (dispatcher.settings.state_fast_model if role == 'fast' else dispatcher.settings.state_reason_model)
    )
    allow = dispatcher.settings.model_allowlist
    if not model or (allow and model not in {m.strip() for m in allow.split(',')}):
        meeting_post(dispatcher.settings, job, 'result', {'role': role, 'generation': job['generation'], 'error': 'model_not_configured'})
        return
    job = dict(unsigned, model=model, dispatched_at=time.time())
    worker_input = job
    if client is not None:
        from uuid import UUID
        generation = str(UUID(job['generation']))
        key = f'meeting_state_job:{int(job["meeting_id"])}:{generation}'
        client.set(key, json.dumps(job, ensure_ascii=False), ex=max(1, int(job['lease_until'] - time.time()) + 30), nx=True)
        worker_input = {'job_key': key, 'user_id': job['user_id'], 'meeting_id': job['meeting_id']}
    inv = units.make_dispatch(subject=str(job['user_id']), trigger='transcription',
        start=units.entrypoint(inline=units.MEETING_STATE_PREFIX + json.dumps(worker_input, ensure_ascii=False)),
        context={'kind': 'meeting', 'meeting': {'meeting_id': str(job['meeting_id']),
                 'session_uid': f'state-{role}-{job["generation"]}', 'platform': job.get('platform', 'google_meet')}})
    started = time.perf_counter()
    dispatcher.dispatch(inv, trusted_meeting_state=True)
    record({'meeting_id': job['meeting_id'], 'generation': job['generation'], 'role': role,
            'stage': 'dispatch', 'duration_ms': (time.perf_counter() - started)*1000, 'model': model})


def publish_snapshot(settings, job):
    from pathlib import Path
    from control_plane import workspace_membership as membership
    from control_plane.workspace_documents import atomic_write
    from shared.adapters import workspace_write_lock
    from llm.ports import commit_workspace_paths
    slug = job.get('workspace_id')
    if not slug:
        return 'export_only'
    validation = {'role': 'publish', 'generation': job['generation'], 'audience_stamp': job['audience_stamp'],
                  'publication_revision': job['publication_revision'], 'source_keys': job['source_keys']}
    if not meeting_post(settings, job, 'validate', validation).get('valid'):
        return 'export_only'
    root = Path(settings.workspaces_dir)
    members = workspace_members(settings, slug)
    if not any(m.get('subject') == str(job['user_id']) and m.get('role') in ('owner', 'contributor') for m in members):
        return 'export_only'
    policy = job.get('policy', {})
    if policy.get('organization') and 'readers' in policy:
        return 'export_only'  # shared Wiki has workspace ACLs, not per-state reader ACLs
    base = membership._ws_dir(root, slug)
    if not (base / '.git').exists():
        return 'export_only'
    # A shared workspace resolves through the membership boundary, never through a private mount.
    relative = f'wiki/meetings/{int(job["meeting_id"])}/state.md'
    target = base / relative
    if any(p.is_symlink() for p in [target, *target.parents] if p == base or base in p.parents):
        return 'conflict'
    content = job['markdown'].encode('utf-8')
    created = False
    with workspace_write_lock(base):
        members = workspace_members(settings, slug)
        if not any(m.get('subject') == str(job['user_id']) and m.get('role') in ('owner', 'contributor') for m in members):
            return 'export_only'
        if target.exists():
            if target.read_bytes() != content:
                return 'conflict'
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            atomic_write(target, content, create=True)
            created = True
        commit_workspace_paths(base, [relative], message=f'Meeting {job["meeting_id"]} final state')
    if not meeting_post(settings, job, 'validate', validation).get('valid'):
        if created:
            with workspace_write_lock(base):
                if target.is_file() and target.read_bytes() == content:
                    target.unlink()
                    commit_workspace_paths(base, [relative], message=f'Revoke stale meeting {job["meeting_id"]} state')
                else:
                    return 'conflict'
        return 'export_only'
    return 'published'


def scrub_stale_snapshot(settings, job):
    """Remove only an exact generated snapshot that failed the post-write audience/source CAS."""
    from pathlib import Path
    from control_plane import workspace_membership as membership
    from shared.adapters import workspace_write_lock
    from llm.ports import commit_workspace_paths
    slug = job.get('workspace_id')
    if not slug:
        return False
    try:
        members = workspace_members(settings, slug)
        if not any(m.get('subject') == str(job['user_id']) and m.get('role') in ('owner', 'contributor') for m in members):
            return False
        base = membership._ws_dir(Path(settings.workspaces_dir), slug)
        relative = f'wiki/meetings/{int(job["meeting_id"])}/state.md'
        target = base / relative
        expected = job['markdown'].encode('utf-8')
        if any(p.is_symlink() for p in [target, *target.parents] if p == base or base in p.parents):
            return False
        with workspace_write_lock(base):
            if not target.is_file() or target.read_bytes() != expected:
                return False  # a participant changed it; preserve their work
            target.unlink()
            commit_workspace_paths(base, [relative], message=f'Revoke stale meeting {job["meeting_id"]} state')
        return True
    except (OSError, ValueError):
        return False


def start(redis_url, dispatcher):
    def run():
        import redis
        client = redis.from_url(redis_url, decode_responses=True)
        while True:
            try:
                try:
                    client.xgroup_create('meeting_state_requests', 'meeting-state-agent', id='0-0', mkstream=True)
                except redis.exceptions.ResponseError as exc:
                    if 'BUSYGROUP' not in str(exc):
                        raise
                rows = client.xreadgroup('meeting-state-agent', 'agent-api', {'meeting_state_requests': '0'}, count=10)
                if not rows or not rows[0][1]:
                    rows = client.xreadgroup('meeting-state-agent', 'agent-api', {'meeting_state_requests': '>'}, count=10, block=1000)
                for _, entries in rows or []:
                    for eid, fields in entries:
                        raw = fields.get('payload', '{}')
                        try:
                            if len(raw) > 4 * 1024 * 1024:
                                raise ValueError('Oversize request')
                            job = json.loads(raw)
                            if job.get('lease_until', 0) > time.time():
                                dispatch_request(dispatcher, job, client)
                        except (ValueError, KeyError, TypeError):
                            log.warning('Invalid meeting-state dispatch rejected')
                        else:
                            client.xack('meeting_state_requests', 'meeting-state-agent', eid)
                            client.xdel('meeting_state_requests', eid)
                            continue
                        client.xack('meeting_state_requests', 'meeting-state-agent', eid)
                        client.xdel('meeting_state_requests', eid)
                spans = client.xread({'meeting_state_spans': span_cursor[0]}, count=100, block=100)
                for _, entries in spans or []:
                    for eid, fields in entries:
                        span_cursor[0] = eid
                        try:
                            record(json.loads(fields.get('payload', '{}')))
                        except (ValueError, TypeError, AttributeError):
                            pass
                        client.xdel('meeting_state_spans', eid)
            except Exception:
                log.warning('Meeting-state dispatch unavailable; leases will recover', exc_info=False)
                time.sleep(2)
    span_cursor = ['0-0']
    thread = threading.Thread(target=run, daemon=True, name='meeting-state-dispatch')
    thread.start()
    return thread
