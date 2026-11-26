"""Owner-scoped background drafts stored with the meeting workspace data."""

import json
import logging
import os
import tempfile
import time
import uuid

from fastapi import BackgroundTasks, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from shared.adapters import WorkspaceBusyError, workspace_write_lock
from shared.meeting_knowledge import stale

logger = logging.getLogger(__name__)
PROMPT = (
    'Viết bản nháp sau cuộc họp bằng tiếng Việt với hai phần. '
    'Phần đầu tóm tắt các quyết định, việc cần làm hoặc câu hỏi còn mở đã được ghi nhận, '
    'trích ít nhất một nguồn loại transcript. '
    'Phần thứ hai nêu một điểm cụ thể cần đối chiếu hoặc làm rõ từ tài liệu đã chọn, '
    'trích ít nhất một nguồn loại document. Ghi rõ đâu là gợi ý từ tài liệu '
    'và đâu là quyết định đã được xác nhận trong cuộc họp. Mỗi ý cần nguồn hỗ trợ.'
)
JOB_LEASE_SECONDS = 240


class DraftSelection(BaseModel):
    model_config = {'extra': 'forbid'}
    workspace: str = Field(min_length=1, max_length=120)
    path: str = Field(min_length=1, max_length=500)


def register(app, subject_of, list_workspaces, meeting_api_url, reader, read_target,
             document_paths, related_text, draft_sources, generate_draft):
    from control_plane.meeting_knowledge import meeting_get, safe_dir

    endpoint = '/api/workspace/meeting-knowledge/{meeting_id}/draft-job'

    def authorize(request, meeting_id):
        subject = subject_of(request)
        allowed = {value.strip() for value in os.getenv('TINA_DRAFT_PILOT_USER_IDS', '').split(',') if value.strip()}
        if not subject.isascii() or not subject.isdecimal() or ('*' not in allowed and subject not in allowed):
            raise HTTPException(404, 'Draft pilot unavailable')
        row = meeting_get(meeting_api_url, subject, meeting_id, f'/meetings/{meeting_id}')
        if str(row.get('user_id')) != subject or (row.get('data') or {}).get('artifact_deletion'):
            raise HTTPException(404, 'Meeting unavailable')
        if row.get('status') != 'completed':
            raise HTTPException(409, 'Meeting is not completed')
        return subject

    def workspaces(request):
        return [{'slug': item['slug'], 'name': item['name']} for item in list_workspaces(request)
                if item['slug'] and not item['slug'].startswith(('.', '_'))]

    def location(subject, meeting_id):
        directory = safe_dir(reader, reader.root, f'.post-meeting-drafts/{subject}/{meeting_id}')
        return directory / 'latest.json'

    def load(path):
        try:
            record = json.loads(path.read_text())
        except FileNotFoundError:
            return None
        if record['status'] == 'running' and time.time() >= record['expires_at']:
            return record | {'status': 'failed'}
        return record

    def save(path, record):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, mode='w', encoding='utf-8', delete=False) as handle:
                temporary = handle.name
                json.dump(record, handle, ensure_ascii=False)
            os.replace(temporary, path)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def run(request, meeting_id, path, record):
        try:
            authorize(request, meeting_id)
            answer = generate_draft(request, meeting_id, record['workspace'], record['path'], PROMPT)
            result = record | {'status': 'completed', 'answer': answer}
        except HTTPException as exc:
            logger.info('post-meeting draft unavailable status=%s', exc.status_code)
            result = record | {'status': 'failed'}
        except Exception as exc:
            logger.warning('post-meeting draft failed error=%s', type(exc).__name__)
            result = record | {'status': 'failed'}
        with workspace_write_lock(path.parent):
            current = load(path)
            if current and current['id'] == record['id'] and current['status'] == 'running':
                save(path, result)

    def respond(payload, status_code=200):
        return JSONResponse(payload, status_code=status_code, headers={'Cache-Control': 'private, no-store'})

    def public(record):
        return {key: record[key] for key in ('id', 'workspace', 'path', 'status')}

    @app.get(endpoint)
    def get_draft(request: Request, meeting_id: int, workspace: str | None = Query(None, max_length=120)):
        subject = authorize(request, meeting_id)
        options = workspaces(request)
        if workspace is not None:
            if not any(option['slug'] == workspace for option in options):
                raise HTTPException(403, 'Workspace unavailable')
            base = read_target(request, workspace)
            return respond({'documents': document_paths(request, base) if base.is_dir() else []})
        record = load(location(subject, meeting_id))
        if record is None:
            return respond({'workspaces': options, 'job': None})
        job = public(record)
        # Revocation or changed sources must also hide results already generated.
        if not any(option['slug'] == record['workspace'] for option in options):
            return respond({'workspaces': options, 'job': None})
        if record['status'] == 'completed':
            try:
                current = draft_sources(request, meeting_id, record['workspace'], record['path'])
                answer = record['answer']
                if stale(answer, current):
                    job['status'] = 'failed'
                else:
                    job['answer'] = answer
            except HTTPException as exc:
                if exc.status_code in (403, 404):
                    return respond({'workspaces': options, 'job': None})
                raise
        return respond({'workspaces': options, 'job': job})

    @app.post(endpoint, status_code=202)
    def start_draft(request: Request, meeting_id: int, body: DraftSelection, background: BackgroundTasks):
        subject = authorize(request, meeting_id)
        if not any(option['slug'] == body.workspace for option in workspaces(request)):
            raise HTTPException(403, 'Workspace unavailable')
        document = related_text(read_target(request, body.workspace), body.path, required=True)
        if not document or not document.strip():
            raise HTTPException(404, 'Workspace document not found')
        path = location(subject, meeting_id)
        try:
            with workspace_write_lock(path.parent, timeout=0.5):
                record = load(path)
                if record and record['status'] == 'running':
                    return respond({'job': {'id': record['id'], 'status': 'running'}}, 202)
                record = body.model_dump() | {'id': uuid.uuid4().hex, 'status': 'running',
                                             'expires_at': time.time() + JOB_LEASE_SECONDS}
                save(path, record)
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Draft is busy. Retry shortly.') from exc
        background.add_task(run, request, meeting_id, path, record)
        return respond({'job': public(record)}, 202)
