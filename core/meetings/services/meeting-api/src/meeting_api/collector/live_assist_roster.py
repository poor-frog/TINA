"""Internal membership authority lookup; never called while holding a meeting row lock."""
import os

import httpx


async def fetch_roster(workspace):
    if not workspace:
        return []
    base = os.environ.get('MEETING_AGENT_API_URL', 'http://agent-api:8100').rstrip('/')
    secret = os.environ.get('INTERNAL_API_SECRET', '')
    if not secret:
        raise RuntimeError('Workspace membership authority is unavailable')
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.get(base + '/api/internal/meeting-state-roster', params={'workspace_id': workspace},
                                    headers={'X-Internal-Secret': secret})
        response.raise_for_status()
        try:
            body = response.json()
        except ValueError:
            raise RuntimeError('Invalid membership authority response') from None
        value = body.get('subjects') if isinstance(body, dict) else None
    if not isinstance(value, list) or len(value) > 10000 or any(type(v) is not int or v <= 0 for v in value):
        raise RuntimeError('Invalid membership authority response')
    return value


async def fetch_sources(workspace, documents, viewers, meeting_id=None):
    base = os.environ.get('MEETING_AGENT_API_URL', 'http://agent-api:8100').rstrip('/')
    secret = os.environ.get('INTERNAL_API_SECRET', '')
    if not secret or not workspace:
        raise RuntimeError('Shared document authority is unavailable')
    descriptors = [{k: d.get(k) for k in ('document_id', 'path', 'sha256', 'manual_removed')} for d in documents]
    payload = {'workspace_id': workspace, 'documents': descriptors, 'viewers': viewers}
    if meeting_id is not None:
        payload['meeting_id'] = meeting_id
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.post(base + '/api/internal/meeting-state-sources',
            json=payload, headers={'X-Internal-Secret': secret})
        response.raise_for_status()
        try:
            body = response.json()
        except ValueError:
            raise RuntimeError('Invalid document authority response') from None
    if not isinstance(body, dict):
        raise RuntimeError('Invalid document authority response')
    valid, subjects = body.get('valid_ids'), body.get('subjects')
    if (not isinstance(valid, list) or any(not isinstance(v, str) for v in valid)
            or not isinstance(subjects, list) or any(type(v) is not int for v in subjects)):
        raise RuntimeError('Invalid document authority response')
    return set(valid), subjects
