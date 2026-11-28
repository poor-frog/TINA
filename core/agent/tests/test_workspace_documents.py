import hashlib
import subprocess

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from control_plane.workspace_documents import register
from control_plane.workspace_reader import WorkspaceReader


@pytest.fixture
def setup(tmp_path):
    base = tmp_path / 'owner'; base.mkdir()
    subprocess.run(['git', 'init', '-q', str(base)], check=True)
    reader = WorkspaceReader(str(tmp_path))
    def target(request, slug):
        if request.headers.get('x-user-id', 'owner') != 'owner' or slug == 'foreign':
            raise HTTPException(403, 'Not yours')
        return base
    app = FastAPI()
    register(app, lambda r: 'owner', target, target, reader)
    return TestClient(app), base


def test_save_preserves_concurrent_edits_and_commits_only_the_selected_path(setup):
    client, base = setup
    (base / 'unrelated.md').write_text('keep')
    subprocess.run(['git', '-C', str(base), 'add', 'unrelated.md'], check=True)
    body = {'path': 'wiki/test.md', 'content': '# First', 'expected_sha256': None, 'commit': True}
    result = client.put('/api/workspace/document', json=body)
    assert result.status_code == 200 and result.json()['commit']
    assert subprocess.check_output(['git', '-C', str(base), 'show', '--format=', '--name-only', 'HEAD']).decode().strip() == 'wiki/test.md'
    assert 'unrelated.md' in subprocess.check_output(['git', '-C', str(base), 'diff', '--cached', '--name-only']).decode()
    loaded = client.get('/api/workspace/document?path=wiki/test.md').json()
    assert loaded['sha256'] == hashlib.sha256(b'# First').hexdigest()
    (base / 'wiki/test.md').write_text('Changed elsewhere')
    assert client.put('/api/workspace/document', json=body | {'expected_sha256': loaded['sha256'], 'content': 'draft'}).status_code == 409
    assert (base / 'wiki/test.md').read_text() == 'Changed elsewhere'


def test_rejects_foreign_workspace_traversal_policy_and_invalid_entities(setup, tmp_path):
    client, base = setup
    for path in ['../secret.md', '/tmp/secret.md', '.claude/secret.md', 'policy/access.md']:
        assert client.put('/api/workspace/document', json={'path': path, 'content': 'bad'}).status_code in (400, 403)
    assert client.put('/api/workspace/document', json={'path': 'kg/entities/person/bad.md', 'content': 'missing schema'}).status_code == 422
    assert client.put('/api/workspace/document', json={'path': 'wiki/a.md', 'content': 'bad', 'slug': 'foreign'}).status_code == 403
    (base / 'wiki').symlink_to(tmp_path)
    assert client.put('/api/workspace/document', json={'path': 'wiki/a.md', 'content': 'bad'}).status_code == 400


def test_search_content_and_guarded_move_delete(setup, tmp_path):
    client, base = setup
    (base / 'wiki').mkdir()
    (base / 'wiki/a.md').write_text('# Notes\n\nNgân sách được chốt.')
    (base / '.private').mkdir()
    (base / '.private/secret.md').write_text('Ngân sách bí mật')
    (tmp_path / 'outside.md').write_text('Ngân sách ngoài workspace')
    (base / 'wiki/escape.md').symlink_to(tmp_path / 'outside.md')
    hits = client.get('/api/workspace/search', params={'q': 'NGÂN SÁCH'}).json()['hits']
    assert [(h['path'], h['line']) for h in hits] == [('wiki/a.md', 3)]
    assert client.get('/api/workspace/search', params={'q': 'x', 'slug': 'foreign'}).status_code == 403
    loaded = client.get('/api/workspace/document', params={'path': 'wiki/a.md'}).json()
    body = {'path': 'wiki/a.md', 'destination': 'notes/moved.md', 'expected_sha256': loaded['sha256']}
    assert client.post('/api/workspace/document/move', json=body | {'expected_sha256': '0' * 64}).status_code == 409
    assert client.post('/api/workspace/document/move', json=body).status_code == 200
    assert not (base / 'wiki/a.md').exists()
    assert (base / 'notes/moved.md').read_text() == '# Notes\n\nNgân sách được chốt.'
    assert client.post('/api/workspace/document/delete', json={'path': 'notes/moved.md', 'expected_sha256': '0' * 64}).status_code == 409
    assert client.post('/api/workspace/document/delete', json={'path': 'notes/moved.md', 'expected_sha256': loaded['sha256']}).status_code == 200
    assert not (base / 'notes/moved.md').exists()


def test_file_changes_reject_overwrite_symlinks_and_foreign_workspaces(setup):
    client, base = setup
    (base / 'wiki').mkdir()
    source, existing = base / 'wiki/a.md', base / 'wiki/existing.md'
    source.write_text('Original'); existing.write_text('Keep destination')
    fingerprint = hashlib.sha256(b'Original').hexdigest()
    body = {'path': 'wiki/a.md', 'destination': 'wiki/existing.md', 'expected_sha256': fingerprint}
    assert client.post('/api/workspace/document/move', json=body).status_code == 409
    assert source.read_text() == 'Original' and existing.read_text() == 'Keep destination'
    (base / 'wiki/link.md').symlink_to(source)
    assert client.post('/api/workspace/document/delete', json={'path': 'wiki/link.md', 'expected_sha256': fingerprint}).status_code == 400
    for destination in ['../outside.md', '.private/policy.md', 'kg/entities/person/invalid.md']:
        assert client.post('/api/workspace/document/move', json=body | {'destination': destination}).status_code in (400, 403, 422)
    assert source.read_text() == 'Original'
    assert client.post('/api/workspace/document/move', json=body | {'slug': 'foreign'}).status_code == 403
    assert client.post('/api/workspace/document/delete', json={'path': 'wiki/a.md', 'expected_sha256': fingerprint, 'slug': 'foreign'}).status_code == 403


def test_search_reports_bounded_results(setup):
    client, base = setup
    (base / 'README.md').write_text('match\n' * 60)
    response = client.get('/api/workspace/search', params={'q': 'match'}).json()
    assert len(response['hits']) == 50 and response['bounded'] is True
    assert client.get('/api/workspace/search', params={'q': '  '}).status_code == 422


def test_move_preview_rewrites_links_only_after_confirmation(setup):
    client, base = setup
    (base / 'wiki').mkdir(); (base / 'docs').mkdir()
    original = '# Budget\n\n[Other](other.md)\n'
    (base / 'wiki/budget.md').write_text(original)
    references = '[[Budget|The plan]] [Budget](../wiki/budget.md#decision)\n`[[Budget]]`\n'
    (base / 'docs/index.md').write_text(references)
    fingerprint = hashlib.sha256(original.encode()).hexdigest()
    body = {'path': 'wiki/budget.md', 'destination': 'notes/renamed.md', 'expected_sha256': fingerprint}
    preview = client.post('/api/workspace/document/move/preview', json=body)
    assert preview.status_code == 200
    plan = preview.json()
    assert {change['path'] for change in plan['changes']} == {'wiki/budget.md', 'docs/index.md'}
    assert plan['warnings'] == []
    assert (base / 'wiki/budget.md').read_text() == original
    assert (base / 'docs/index.md').read_text() == references
    assert not (base / 'notes').exists()
    assert client.post('/api/workspace/document/move', json=body | {'update_links': True}).status_code == 422
    result = client.post('/api/workspace/document/move', json=body | {'update_links': True, 'expected_plan': plan['fingerprint']})
    assert result.status_code == 200 and result.json()['updated_links'] == 3
    assert not (base / 'wiki/budget.md').exists()
    assert (base / 'notes/renamed.md').read_text() == '# Budget\n\n[Other](../wiki/other.md)\n'
    assert (base / 'docs/index.md').read_text() == '[[notes/renamed.md|The plan]] [Budget](../notes/renamed.md#decision)\n`[[Budget]]`\n'


@pytest.mark.parametrize('edit', ['reference', 'new-reference', 'source', 'destination'])
def test_move_rejects_stale_preview_without_mutating_files(setup, edit):
    client, base = setup
    (base / 'wiki').mkdir()
    (base / 'wiki/a.md').write_text('Original')
    (base / 'README.md').write_text('[Link](wiki/a.md)')
    body = {'path': 'wiki/a.md', 'destination': 'notes/b.md', 'expected_sha256': hashlib.sha256(b'Original').hexdigest()}
    plan = client.post('/api/workspace/document/move/preview', json=body).json()
    target = {'reference': 'README.md', 'new-reference': 'wiki/new.md', 'source': 'wiki/a.md', 'destination': 'notes/b.md'}[edit]
    changed = base / target
    changed.parent.mkdir(parents=True, exist_ok=True)
    changed.write_text('Changed ' + ('[Link](wiki/a.md)' if edit == 'new-reference' else 'elsewhere'))
    snapshot = {str(path.relative_to(base)): path.read_bytes() for path in base.rglob('*.md')}
    result = client.post('/api/workspace/document/move', json=body | {'update_links': True, 'expected_plan': plan['fingerprint']})
    assert result.status_code == 409
    assert {str(path.relative_to(base)): path.read_bytes() for path in base.rglob('*.md')} == snapshot


def test_move_rolls_back_link_changes_when_publication_fails(setup, monkeypatch):
    from control_plane import workspace_documents as api
    client, base = setup
    (base / 'wiki').mkdir()
    (base / 'wiki/a.md').write_text('Original')
    (base / 'README.md').write_text('[Link](wiki/a.md)')
    (base / 'wiki/c.md').write_text('[Link](a.md)')
    body = {'path': 'wiki/a.md', 'destination': 'notes/b.md', 'expected_sha256': hashlib.sha256(b'Original').hexdigest()}
    plan = client.post('/api/workspace/document/move/preview', json=body).json()
    write = api.atomic_write
    def fail(path, content, **kwargs):
        if path == base / 'wiki/c.md' and content != b'[Link](a.md)':
            raise OSError('Injected disk failure')
        return write(path, content, **kwargs)
    monkeypatch.setattr(api, 'atomic_write', fail)
    result = client.post('/api/workspace/document/move', json=body | {'update_links': True, 'expected_plan': plan['fingerprint']})
    assert result.status_code == 503
    assert (base / 'wiki/a.md').read_text() == 'Original'
    assert (base / 'README.md').read_text() == '[Link](wiki/a.md)'
    assert (base / 'wiki/c.md').read_text() == '[Link](a.md)'
    assert not (base / 'notes/b.md').exists()


def test_preview_reports_ambiguous_and_uneditable_links_without_touching_them(setup):
    client, base = setup
    (base / 'wiki').mkdir(); (base / 'notes').mkdir(); (base / 'policy').mkdir()
    (base / 'wiki/a.md').write_text('Original')
    (base / 'notes/a.md').write_text('Other')
    (base / 'README.md').write_text('[[A]]')
    (base / 'policy/help.md').write_text('[Link](wiki/a.md)')
    body = {'path': 'wiki/a.md', 'destination': 'notes/b.md', 'expected_sha256': hashlib.sha256(b'Original').hexdigest()}
    plan = client.post('/api/workspace/document/move/preview', json=body).json()
    assert any('ambiguous' in warning for warning in plan['warnings'])
    assert any('read-only' in warning for warning in plan['warnings'])
    assert client.post('/api/workspace/document/move/preview', json=body | {'slug': 'foreign'}).status_code == 403
    assert client.post('/api/workspace/document/move', json=body | {'update_links': True, 'expected_plan': plan['fingerprint']}).status_code == 200
    assert (base / 'README.md').read_text() == '[[A]]'
    assert (base / 'policy/help.md').read_text() == '[Link](wiki/a.md)'


def test_move_keeps_original_if_an_external_writer_changes_the_new_destination(setup, monkeypatch):
    from control_plane import workspace_documents as api
    client, base = setup
    (base / 'wiki').mkdir()
    (base / 'wiki/a.md').write_text('Original')
    (base / 'README.md').write_text('[Link](wiki/a.md)')
    body = {'path': 'wiki/a.md', 'destination': 'notes/b.md', 'expected_sha256': hashlib.sha256(b'Original').hexdigest()}
    plan = client.post('/api/workspace/document/move/preview', json=body).json()
    write = api.atomic_write
    def external_write(path, content, **kwargs):
        write(path, content, **kwargs)
        if kwargs.get('create'):
            path.write_text('External edit')
    monkeypatch.setattr(api, 'atomic_write', external_write)
    result = client.post('/api/workspace/document/move', json=body | {'update_links': True, 'expected_plan': plan['fingerprint']})
    assert result.status_code == 503
    assert (base / 'wiki/a.md').read_text() == 'Original'
    assert (base / 'notes/b.md').read_text() == 'External edit'
    assert (base / 'README.md').read_text() == '[Link](wiki/a.md)'


def test_accepts_entity_frontmatter_with_quoted_or_unquoted_dates_and_crlf(setup):
    client, base = setup
    # 1. Quoted ISO date-time (generated by Knowledge UI templates)
    quoted_doc = (
        '---\n'
        'id: person/tquang\n'
        'type: person\n'
        'title: TQuang\n'
        'updated: "2026-11-28T05:07:03.000Z"\n'
        '---\n\n# TQuang\n'
    )
    res1 = client.put('/api/workspace/document', json={
        'path': 'kg/entities/person/tquang.md',
        'content': quoted_doc,
        'expected_sha256': None,
        'commit': True,
    })
    assert res1.status_code == 200
    assert (base / 'kg/entities/person/tquang.md').is_file()

    # 2. Unquoted YAML date (raw hand-edit / AI) + CRLF line endings
    crlf_doc = (
        '---\r\n'
        'id: project/q4-plan\r\n'
        'type: project\r\n'
        'title: "2026"\r\n'
        'updated: 2026-11-28\r\n'
        '---\r\n\r\n# 2026\r\n'
    )
    res2 = client.put('/api/workspace/document', json={
        'path': 'kg/entities/project/q4-plan.md',
        'content': crlf_doc,
        'expected_sha256': None,
        'commit': False,
    })
    assert res2.status_code == 200

    # 3. Still rejects truly invalid entity frontmatter (missing required fields or non-string title)
    bad_numeric_title = '---\nid: person/2026\ntype: person\ntitle: 2026\n---\n\n# 2026\n'
    assert client.put('/api/workspace/document', json={
        'path': 'kg/entities/person/2026.md',
        'content': bad_numeric_title,
        'expected_sha256': None,
    }).status_code == 422
