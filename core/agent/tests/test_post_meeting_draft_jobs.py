from concurrent.futures import ThreadPoolExecutor
import io
import shutil
from threading import Event

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from control_plane import meeting_knowledge
from control_plane.post_meeting_draft_jobs import register
from control_plane.workspace_reader import WorkspaceReader
from control_plane.workspace_store import S3WorkspaceStore


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


def test_draft_job_allows_wildcard_pilot_users(tmp_path, monkeypatch):
    app = FastAPI()
    monkeypatch.setenv('TINA_DRAFT_PILOT_USER_IDS', '*')
    monkeypatch.setattr(meeting_knowledge, 'meeting_get',
                        lambda *_: {'status': 'completed', 'user_id': 99})
    register(app, lambda request: request.headers['x-user-id'],
             lambda _: [], '', WorkspaceReader(str(tmp_path)), lambda *_: tmp_path,
             lambda *_: [], lambda *_, **__: '', lambda *_: [], lambda *_: {})
    with TestClient(app) as client:
        assert client.get('/api/workspace/meeting-knowledge/3/draft-job', headers={'x-user-id': '99'}).status_code == 200
        monkeypatch.setenv('TINA_DRAFT_PILOT_USER_IDS', '')
        assert client.get('/api/workspace/meeting-knowledge/3/draft-job', headers={'x-user-id': '99'}).status_code == 404


class _FakeS3Error(Exception):
    def __init__(self, code: str, status: int | None = None) -> None:
        super().__init__(code)
        self.response = {'Error': {'Code': code}}
        if status is not None:
            self.response['ResponseMetadata'] = {'HTTPStatusCode': status}


class _FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str, dict]] = {}
        self.seq = 0
        self.get_calls = 0

    def put_object(self, *, Bucket, Key, Body, **kwargs):
        self.seq += 1
        etag = f'"etag-{self.seq}"'
        raw = Body if isinstance(Body, bytes) else Body.read()
        self.objects[Key] = (raw, etag, kwargs)
        return {'ETag': etag}

    def get_object(self, *, Bucket, Key, IfNoneMatch=None, **kwargs):
        self.get_calls += 1
        if Key not in self.objects:
            raise _FakeS3Error('NoSuchKey', 404)
        raw, etag, _ = self.objects[Key]
        if IfNoneMatch and IfNoneMatch == etag:
            raise _FakeS3Error('304', 304)
        return {'Body': io.BytesIO(raw), 'ETag': etag}


def test_draft_job_persists_to_s3_and_recovers_after_container_restart(tmp_path, monkeypatch):
    monkeypatch.setenv('TINA_DRAFT_PILOT_USER_IDS', '*')
    monkeypatch.setattr(meeting_knowledge, 'meeting_get',
                        lambda *_: {'status': 'completed', 'user_id': 7})
    s3 = _FakeS3()
    answer = {
        'claims': [{'text': 'Confirmed milestone', 'source_ids': ['s0', 's1']}],
        'sources': [
            {'key': 'tr:1', 'fingerprint': 'fp1', 'id': 's0'},
            {'key': 'doc:spec:0', 'fingerprint': 'fp2', 'id': 's1'},
        ],
    }

    def build_app(root):
        app = FastAPI()
        app.state.s3_workspace_store = S3WorkspaceStore(
            s3=s3, bucket='tina-test-bucket', root=root, kms_key_id='kms-data-key',
        )
        register(
            app,
            lambda request: request.headers['x-user-id'],
            lambda _: [{'slug': 'wiki', 'name': 'Team Wiki'}],
            '',
            WorkspaceReader(str(root)),
            lambda *_: root,
            lambda *_: ['notes/spec.md'],
            lambda *_, **__: 'Spec content',
            lambda *_: answer['sources'],
            lambda *_: answer,
        )
        return app

    url = '/api/workspace/meeting-knowledge/42/draft-job'
    headers = {'x-user-id': '7'}
    root_a = tmp_path / 'container-a'
    root_a.mkdir()
    with TestClient(build_app(root_a)) as client_a:
        res = client_a.post(url, headers=headers, json={'workspace': 'wiki', 'path': 'notes/spec.md'})
        assert res.status_code == 202
        after = client_a.get(url, headers=headers)
        assert after.status_code == 200
        assert after.json()['job']['status'] == 'completed'
        assert after.json()['job']['answer'] == answer

    expected_key = '_post-meeting-drafts/7/42/latest.json'
    assert expected_key in s3.objects
    raw, _etag, put_kwargs = s3.objects[expected_key]
    assert put_kwargs.get('ServerSideEncryption') == 'aws:kms'
    assert put_kwargs.get('SSEKMSKeyId') == 'kms-data-key'
    assert b'Confirmed milestone' in raw

    # Simulate Fargate container restart with brand-new empty local ephemeral volume.
    shutil.rmtree(root_a)
    root_b = tmp_path / 'container-b'
    root_b.mkdir()
    with TestClient(build_app(root_b)) as client_b:
        recovered = client_b.get(url, headers=headers)
        assert recovered.status_code == 200
        job = recovered.json()['job']
        assert job['status'] == 'completed'
        assert job['workspace'] == 'wiki'
        assert job['path'] == 'notes/spec.md'
        assert job['answer'] == answer
        assert (root_b / '.post-meeting-drafts' / '7' / '42' / 'latest.json').is_file()
