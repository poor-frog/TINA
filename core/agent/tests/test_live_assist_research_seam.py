"""Source-only seam: real HTTP routes, real bounded retrieval, fake durable store/model."""
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient


def test_research_excerpts_reach_reconciler_and_authorized_meeting_viewers(tmp_path, monkeypatch):
    from pathlib import Path
    # Test-only cross-domain seam; production shares JSON contracts, never Python imports.
    root = next(p for p in Path(__file__).resolve().parents if (p / 'core' / 'meetings').is_dir())
    monkeypatch.syspath_prepend(str(root / 'core/meetings/services/meeting-api/src'))
    from meeting_api.collector.app import create_app as meeting_app
    from meeting_api.collector.fakes import InMemoryTranscriptStore
    from control_plane.api import create_app as agent_app
    from control_plane.dispatch import Dispatcher
    from control_plane.workspace_membership import InMemoryMembershipIndex
    from control_plane import live_assist_documents as documents
    from shared.config import load_settings
    from shared.units import MEETING_STATE_PREFIX
    from llm.ports import CompletionResult
    from worker.live_assist import run
    from .test_api import _FakeIdentity, _FakeRuntime
    from .test_live_assist import Stream

    monkeypatch.setenv('INTERNAL_API_SECRET', 'research-seam-secret')
    monkeypatch.setenv('TINA_OWNER', '7')
    policy = tmp_path / 'team' / 'policy'; policy.mkdir(parents=True)
    wiki = tmp_path / 'team' / 'wiki'; wiki.mkdir()
    (policy / 'members.json').write_text(json.dumps([{'subject': '7', 'role': 'owner'}, {'subject': '8', 'role': 'contributor'}]), encoding='utf-8')
    (wiki / 'retry.md').write_text('Retry policy: exponential backoff with a three-attempt budget.', encoding='utf-8')
    store = InMemoryTranscriptStore()
    store.seed_meeting(user_id=7, meeting_id=1, platform='google_meet', native_meeting_id='abc',
                       data={'workspace_id': 'team', 'transcript_viewers': [8]})
    store.workspace_rosters['team'] = [7, 8]
    backend = TestClient(meeting_app(store, None))
    headers = {'X-User-Id': '7', 'X-Internal-Secret': 'research-seam-secret'}
    assert backend.post('/transcripts/by-id/1/state/configure', headers=headers, json={'enabled': True}).status_code == 200

    def meeting_post(settings, identity, action, payload, *, workspaces=None):
        h = dict(headers, **{'X-User-Id': str(identity['user_id']), 'X-User-Workspaces': ','.join(workspaces or [])})
        response = backend.post(f'/transcripts/by-id/1/state/{action}', headers=h, json=payload)
        assert response.status_code == 200, response.text
        return response.json()
    monkeypatch.setattr(documents, 'meeting_post', meeting_post)
    index = InMemoryMembershipIndex(); index.add('7', 'team', 'owner', '')
    settings = load_settings(workspaces_dir=str(tmp_path), internal_api_secret='research-seam-secret')
    client = TestClient(agent_app(Dispatcher(settings, _FakeRuntime(), _FakeIdentity()), membership_index=index))
    response = client.post('/api/meeting-state-research/1', headers={'X-User-Id': '7'}, json={'query': 'retry policy'})
    assert response.status_code == 200, response.text
    assert response.json()['sources_added'] == 1
    job = backend.post('/transcripts/by-id/1/state/claim', headers=headers, json={'role': 'reason'}).json()
    assert job and job['segments'][0]['document_id']
    job['model'] = 'reason-test'
    patches = [{k: item[k] for k in ('id', 'text', 'evidence')} for item in job['context']['items']]
    completion = SimpleNamespace(name='fake', complete=lambda *args, **kwargs: CompletionResult(text=json.dumps({
        'patches': patches, 'summaries': {'current': 'Document research is available.', 'meeting': 'Retry policy evidence was attached.'}})))
    result = run(Stream(), MEETING_STATE_PREFIX + json.dumps(job), completion=completion)
    accepted = backend.post('/transcripts/by-id/1/state/result', headers=headers, json=result)
    assert accepted.json()['accepted'], accepted.text
    state = backend.get('/transcripts/by-id/1/state', headers={'X-User-Id': '8'}).json()
    assert state['items'][0]['evidence'][0]['path'] == 'wiki/retry.md'
    assert state['summaries']['current'] == 'Document research is available.'
    assert backend.get('/transcripts/by-id/1/state', headers={'X-User-Id': '99'}).status_code == 404
