"""Bounded deterministic shared-document research. No tools, private mounts, or web egress."""
import hashlib
import json
import os
import re
import time
import urllib.error
import stat
from pathlib import Path, PurePosixPath

from fastapi import HTTPException, Request

from control_plane import workspace_membership as membership
from control_plane.live_assist import meeting_post, record, workspace_roster


def document_file(settings, workspace, relative):
    if not isinstance(relative, str) or '\\' in relative or len(relative) > 500:
        raise ValueError('Invalid document path')
    parts = PurePosixPath(relative)
    if (parts.is_absolute() or '..' in parts.parts or not parts.parts or any(p.startswith('.') for p in parts.parts)
            or parts.suffix != '.md' or (relative != 'README.md' and parts.parts[0] not in ('wiki', 'kg', 'notes', 'sources', 'concepts', 'docs'))):
        raise ValueError('Unsupported document path')
    base = membership._ws_dir(Path(settings.workspaces_dir), workspace)
    path = base.joinpath(*parts.parts)
    if any(p.is_symlink() for p in [path, *path.parents] if p == base or base in p.parents):
        raise ValueError('Symlinked documents are not research sources')
    return path


def read_document(settings, workspace, relative):
    path = document_file(settings, workspace, relative)
    if hasattr(os, 'O_NOFOLLOW'):
        # Reuse the existing Linux no-follow directory anchor used by governed routine files.
        from control_plane.workspace_routines import _routine_directory
        directory = _routine_directory(path)
        try:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            with os.fdopen(fd, 'rb') as stream:
                if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                    raise ValueError('Document must be a regular file')
                raw = stream.read(200001)
        finally:
            os.close(directory)
    else:
        # Native development hosts: reject replaced files as well as static links.
        before = path.stat(follow_symlinks=False)
        with path.open('rb') as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino):
                raise ValueError('Document changed while opening')
            raw = stream.read(200001)
        document_file(settings, workspace, relative)
    if len(raw) > 200000:
        raise ValueError('Document too large')
    return raw.decode('utf-8'), hashlib.sha256(raw).hexdigest()


def validate_sources(settings, payload):
    from contracts.loader import validate_meeting_state_sources
    from jsonschema import ValidationError
    try:
        validate_meeting_state_sources(payload)
    except ValidationError:
        raise ValueError('Invalid source validation request') from None
    workspace, docs, viewers = payload.get('workspace_id'), payload.get('documents'), payload.get('viewers')
    if not isinstance(workspace, str) or not isinstance(docs, list) or len(docs) > 37 or not isinstance(viewers, list):
        raise ValueError('Invalid source validation request')
    subjects = set(workspace_roster(settings, workspace))
    if not set(viewers) <= subjects:
        return {'subjects': sorted(subjects), 'valid_ids': []}
    valid, hashes = [], {}
    for doc in docs:
        if not isinstance(doc, dict) or not isinstance(doc.get('document_id'), str):
            raise ValueError('Invalid source descriptor')
        if doc.get('workspace_id') != workspace:
            continue
        if doc.get('manual_removed'):
            continue
        relative = doc.get('path')
        try:
            if relative not in hashes:
                _, hashes[relative] = read_document(settings, workspace, relative)
            if hashes[relative] == doc.get('sha256'):
                valid.append(doc['document_id'])
        except (OSError, ValueError):
            continue
    return {'subjects': sorted(subjects), 'valid_ids': valid}


def retrieve(settings, workspace, query, viewers):
    subjects = set(workspace_roster(settings, workspace))
    if not set(viewers) <= subjects:
        raise PermissionError('Every meeting viewer must have access to the bound shared workspace')
    base = membership._ws_dir(Path(settings.workspaces_dir), workspace)
    terms = set(re.findall(r'\w+', query.casefold()))
    if not terms:
        raise ValueError('Enter document search terms')
    candidates, scanned, size = [], 0, 0
    # Fixed budgets: deterministic traversal, at most 1000 files / 4 MiB per explicit request.
    for directory, folders, files in os.walk(base):
        folders[:] = sorted(f for f in folders if not f.startswith('.') and not (Path(directory) / f).is_symlink())
        for name in sorted(files):
            if scanned >= 1000 or size >= 4_000_000:
                break
            if not name.endswith('.md'):
                continue
            scanned += 1
            relative = (Path(directory) / name).relative_to(base).as_posix()
            try:
                source_size = document_file(settings, workspace, relative).stat().st_size
                if source_size > 200000:
                    continue
                if size + source_size > 4_000_000:
                    break
                size += source_size
                text, sha = read_document(settings, workspace, relative)
            except (OSError, ValueError):
                continue
            tokens = set(re.findall(r'\w+', text.casefold()))
            score = len(terms & tokens)
            if not score:
                continue
            match = next((m for m in re.finditer(r'\w+', text) if m.group().casefold() in terms), None)
            start = max(0, (match.start() if match else 0) - 500)
            excerpt = text[start:start+2000]
            key = hashlib.sha256(json.dumps([workspace, relative, sha, start], ensure_ascii=False).encode()).hexdigest()
            candidates.append({'document_id': key, 'workspace_id': workspace, 'path': relative, 'sha256': sha, 'text': excerpt, '_score': score})
        if scanned >= 1000 or size >= 4_000_000:
            break
    selected = sorted(candidates, key=lambda d: (-d['_score'], d['path']))[:5]
    for doc in selected:
        doc.pop('_score')
    return selected


def register(app, subject_of, settings, membership_index):
    @app.post('/api/meeting-state-metrics/{meeting_id}')
    def browser_metric(meeting_id: int, request: Request, body: dict):
        import math
        subject = subject_of(request)
        duration, revision = body.get('duration_ms'), body.get('revision')
        if (not subject.isdigit() or set(body) != {'duration_ms', 'revision'} or type(duration) not in (int, float)
                or not math.isfinite(duration) or not 0 <= duration <= 60000 or type(revision) is not int or revision < 0):
            raise HTTPException(422, 'Invalid browser timing')
        workspaces = {m['workspace_id'] for m in membership_index.list(subject)}
        try:
            context = meeting_post(settings, {'user_id': int(subject), 'meeting_id': meeting_id}, 'metric-context', {}, workspaces=workspaces)
        except OSError:
            raise HTTPException(403, 'Meeting metric is not authorized') from None
        if revision > context['revision']:
            raise HTTPException(409, 'Unknown publication revision')
        record({'meeting_id': meeting_id, 'stage': 'browser_request_to_paint', 'duration_ms': duration,
                'publication_revision': revision, 'status': 'client-reported'})
        return {'recorded': True}

    @app.post('/api/meeting-state-research/{meeting_id}')
    def research(meeting_id: int, request: Request, body: dict):
        if set(body) != {'query'} or not isinstance(body.get('query'), str) or not 0 < len(body['query']) <= 300 or not re.search(r'\w', body['query']):
            raise HTTPException(422, 'Expected a document query of at most 300 characters')
        subject = subject_of(request)
        if not subject.isdigit() or int(subject) <= 0:
            raise HTTPException(401, 'Authenticated TINA account required')
        workspaces = {m['workspace_id'] for m in membership_index.list(subject)}
        identity = {'user_id': int(subject), 'meeting_id': meeting_id}
        try:
            context = meeting_post(settings, identity, 'research-context', {}, workspaces=workspaces)
            workspace = context.get('workspace_id')
            if not workspace:
                raise HTTPException(409, 'Bind a shared workspace before document research')
            subjects = set(workspace_roster(settings, workspace))
            if int(subject) not in subjects:
                raise PermissionError('Shared workspace membership required')
            started = time.perf_counter()
            docs = retrieve(settings, workspace, body['query'], context['viewers'])
            record({'meeting_id': meeting_id, 'stage': 'document_retrieval', 'duration_ms': (time.perf_counter()-started)*1000})
            if not docs:
                return {'sources_added': 0}
            meeting_post(settings, identity, 'ingest-documents', dict(context, documents=docs), workspaces=workspaces)
            return {'sources_added': len(docs)}
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        except urllib.error.HTTPError as exc:
            raise HTTPException(exc.code if exc.code in (403, 404, 409, 422) else 503, 'Meeting research state or access changed; reload and retry') from None
        except (ValueError, OSError) as exc:
            raise HTTPException(503, 'Shared document research unavailable; check source access and retry') from exc
