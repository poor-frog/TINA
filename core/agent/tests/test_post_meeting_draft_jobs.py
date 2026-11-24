from concurrent.futures import ThreadPoolExecutor
from threading import Event

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from control_plane import meeting_knowledge
from control_plane.post_meeting_draft_jobs import register
from control_plane.workspace_reader import WorkspaceReader


def test_draft_job_deduplicates_and_checks_permissions_on_reload(tmp_path, monkeypatch):
    app = FastAPI()
    monkeypatch.setenv('TINA_DRAFT_PILOT_USER_IDS', '1,2')
    monkeypatch.setattr(meeting_knowledge, 'meeting_get',
                        lambda *_: {'status': 'completed', 'user_id': 1})
    entered, release = Event(), Event()
    shared = ['wiki']
    answer = {'claims': [{'text': 'Next steps', 'source_ids': ['s0']}],
              'sources': [{'key': 'doc:plan:0', 'fingerprint': 'current', 'id': 's0'}]}

    def read_target(request, workspace):
        if workspace not in shared:
            raise HTTPException(403)
        return tmp_path

    def generate(*_):
        entered.set()
        assert release.wait(5)
        return answer

    register(app, lambda request: request.headers['x-user-id'],
             lambda _: [{'slug': slug, 'name': slug} for slug in shared],
             '', WorkspaceReader(str(tmp_path)), read_target, lambda *_: ['notes/plan.md'],
             lambda *_, **__: 'Allowed source', lambda *_: answer['sources'], generate)
    url = '/api/workspace/meeting-knowledge/3/draft-job'
    owner, other = {'x-user-id': '1'}, {'x-user-id': '2'}
    payload = {'workspace': 'wiki', 'path': 'notes/plan.md'}
    with TestClient(app) as client:
        assert client.get(url, headers=owner).json()['job'] is None
        assert client.post(url, headers=owner, json=payload | {'workspace': 'private'}).status_code == 403
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(client.post, url, headers=owner, json=payload)
            try:
                assert entered.wait(5)
                duplicate = client.post(url, headers=owner, json=payload)
                assert duplicate.status_code == 202
                assert client.get(url, headers=owner).json()['job']['status'] == 'running'
                assert client.get(url, headers=other).status_code == 404
            finally:
                release.set()
            assert duplicate.json()['job']['id'] == running.result().json()['job']['id']
        saved = client.get(url, headers=owner)
        assert saved.headers['Cache-Control'] == 'private, no-store'
        assert saved.json()['job']['answer'] == answer
        shared.clear()
        assert client.get(url, headers=owner).json()['job'] is None
