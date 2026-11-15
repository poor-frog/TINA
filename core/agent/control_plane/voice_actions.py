"""Voice proposals stay private drafts until the authenticated meeting owner reviews them."""
import json
import os
import re
import tempfile
from itertools import islice
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from contracts import validate_entity_frontmatter
from shared.adapters import render_entity, parse_entity, workspace_write_lock, WorkspaceBusyError
from shared.models import WorkspaceWrite


class VoiceActionDraft(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(pattern=r'^[0-9a-f]{32}$')
    request_id: UUID
    meeting_id: int = Field(gt=0)
    owner: str = Field(min_length=1, max_length=128)
    policy_revision: int = Field(ge=0)
    kind: Literal['task', 'decision']
    title: str = Field(min_length=1, max_length=200)
    details: str = Field(min_length=1, max_length=10000)
    readback: str = Field(min_length=1, max_length=4000)
    status: Literal['pending', 'approved', 'discarded'] = 'pending'
    revision: int = Field(default=1, ge=1)
    created_at: str
    path: str | None = None


class VoiceActionReview(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_revision: int = Field(ge=1)
    status: Literal['approved', 'discarded']
    title: str = Field(min_length=1, max_length=200)
    details: str = Field(min_length=1, max_length=10000)
    assignee_label: str = Field(default='', max_length=128)
    due: date | None = None

    @field_validator('title', 'details')
    @classmethod
    def nonblank(cls, value):
        if not value.strip(): raise ValueError('Enter draft content')
        return value.strip()


class VoiceActionDraftPage(BaseModel):
    model_config=ConfigDict(extra='forbid')
    drafts:list[VoiceActionDraft]=Field(max_length=20)
    next_offset:int|None=Field(default=None,ge=0)


def action_intent(question):
    text = question.strip()
    text = re.sub(r'^(?:hey tina|tina ơi|tina)\s*[,!:]?\s*', '', text, flags=re.I)
    text = re.sub(r'^(?:hãy|giúp tôi|please)\s+', '', text, flags=re.I)
    for kind, pattern in (
        ('task', r'(?:tạo|lập|thêm)\s+(?:bản nháp\s+)?(?:task|công việc)|(?:create|draft)\s+(?:a\s+)?task'),
        ('decision', r'(?:ghi|lưu)(?:\s+lại)?\s+(?:bản nháp\s+)?quyết định|(?:record|draft)\s+(?:a\s+)?decision'),
    ):
        match = re.match(r'^(?:' + pattern + r')\b', text, re.I)
        if match:
            if re.fullmatch(r'(?:là gì|như thế nào|thế nào)[?.!]*', text[match.end():].strip(), re.I): return None
            return kind
    return None


def action_context(question, pending):
    kind = action_intent(question)
    if kind: return kind, question
    if re.match(r'^(?:bỏ qua|hủy|huỷ|không cần|đừng|cancel|never mind|stop)\b', question.strip(), re.I):
        return None, question
    if pending and len(question.split()) <= 30 and not re.match(
            r'^(?:ai|khi nào|tại sao|vì sao|tóm tắt|tổng hợp|who|when|why|what|summari[sz]e)\b', question.strip(), re.I):
        kind = action_intent(pending['question'])
        if kind:
            return kind, '\n'.join([pending['question'], *pending['replies'], question])
    return None, question


def readback(kind, title):
    label = 'task' if kind == 'task' else 'quyết định'
    return f'Em đã chuẩn bị bản nháp {label}: {title}. Chủ meeting xem và xác nhận trong TINA Terminal để lưu chính thức nhé.'


def _read(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
        raise HTTPException(404, 'Voice draft unavailable')
    return VoiceActionDraft.model_validate_json(path.read_text())


def _write(path, text, *, exclusive=False):
    with tempfile.NamedTemporaryFile(dir=path.parent, mode='w', encoding='utf-8', delete=False) as out:
        temporary = Path(out.name)
        out.write(text)
    try:
        if exclusive: os.link(temporary, path)
        else: os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def create_draft(directory, *, request_id, meeting_id, owner, policy_revision, kind, title, details):
    identifier = UUID(request_id).hex
    draft = VoiceActionDraft(id=identifier, request_id=request_id, meeting_id=meeting_id, owner=str(owner),
        policy_revision=policy_revision, kind=kind, title=title.strip(), details=details,
        readback=readback(kind, title.strip()), created_at=datetime.now(timezone.utc).isoformat())
    target = directory / f'{identifier}.json'
    try:
        _write(target, draft.model_dump_json(), exclusive=True)
    except FileExistsError:
        previous = _read(target)
        if any(getattr(previous, key) != getattr(draft, key) for key in
               ('request_id','meeting_id','owner','policy_revision','kind','title','details')):
            raise HTTPException(409, 'Voice request already has a different draft') from None
        return previous
    return draft


def draft_list(directory, *, owner, meeting_id, policy_revision, replies, draft_id=None, offset=0, limit=20):
    if draft_id is not None and not re.fullmatch(r'[0-9a-f]{32}',draft_id):
        raise HTTPException(404,'Voice draft unavailable')
    heard = {r['request_id']: r for r in replies if r.get('state') == 'completed'}
    result = [];skipped=0
    paths=[directory/f'{draft_id}.json'] if draft_id is not None else sorted(directory.glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)
    for path in paths:
        if not re.fullmatch(r'[0-9a-f]{32}', path.stem): continue
        draft = _read(path)
        receipt = heard.get(str(draft.request_id), {})
        if (draft.owner == str(owner) and draft.meeting_id == meeting_id
                and draft.policy_revision == policy_revision and receipt.get('text') == draft.readback):
            if skipped<offset:skipped+=1
            else:result.append(draft.model_dump(mode='json'))
        if len(result) == limit: break
    return result


def approved_action_documents(directory, *, owner, meeting_id, read_document):
    """Only owner-approved records from this meeting can nominate a generated entity path."""
    documents = {}
    if not directory.is_dir() or directory.is_symlink(): return documents
    paths = list(islice(directory.glob('*.json'),1001))
    if len(paths)>1000: raise HTTPException(413,'Too many voice drafts to read safely')
    for path in sorted(paths):
        if not re.fullmatch(r'[0-9a-f]{32}',path.stem): continue
        draft = _read(path)
        expected = f'kg/entities/{draft.kind}/voice-{draft.id}.md'
        if (draft.status!='approved' or draft.owner!=str(owner) or draft.meeting_id!=meeting_id
                or draft.path!=expected): continue
        text = read_document(expected)
        if text is None: continue
        frontmatter,_ = parse_entity(text)
        if not isinstance(frontmatter,dict): continue
        if any(frontmatter.get(k)!=v for k,v in {'type':draft.kind,'id':f'voice-{draft.id}',
                'owner':str(owner),'reviewed_by':str(owner),'meeting_id':meeting_id}.items()): continue
        if len(documents)>=32: raise HTTPException(413,'Too many approved voice actions to read safely')
        documents[expected]=text
    return documents


def review_draft(base, directory, draft, review, safe_directory, authorize):
    try:
        with workspace_write_lock(base):
            authorize()
            current = _read(directory / f'{draft.id}.json')
            if current.status != 'pending' or current.revision != review.expected_revision:
                raise HTTPException(409, 'Draft changed; reload before reviewing')
            path = None
            if review.status == 'approved':
                path = f'kg/entities/{current.kind}/voice-{current.id}.md'
                frontmatter = {'type': current.kind, 'id': f'voice-{current.id}', 'title': review.title,
                    'owner': current.owner, 'source': 'meeting', 'meeting_id': current.meeting_id,
                    'voice_request_id': str(current.request_id), 'created': current.created_at,
                    'reviewed_by': current.owner}
                if current.kind == 'task':
                    frontmatter.update(state='open', status='open')
                    if review.assignee_label: frontmatter['assignee_label'] = review.assignee_label
                    if review.due: frontmatter['due'] = review.due.isoformat()
                validate_entity_frontmatter(frontmatter)
                text = render_entity(WorkspaceWrite(path=path, frontmatter=frontmatter,
                    body=review.details + f'\n\nSource: [Meeting {current.meeting_id}](/meetings/{current.meeting_id}).\n'))
                target = safe_directory(f'kg/entities/{current.kind}') / f'voice-{current.id}.md'
                try: _write(target, text, exclusive=True)
                except FileExistsError:
                    if target.is_symlink() or target.read_text() != text:
                        raise HTTPException(409, 'Existing document was kept; it differs from this draft') from None
            updated = current.model_copy(update={'status': review.status, 'revision': current.revision + 1,
                'title': review.title, 'details': review.details, 'path': path})
            _write(directory / f'{current.id}.json', updated.model_dump_json())
            return updated.model_dump(mode='json')
    except WorkspaceBusyError:
        raise HTTPException(409, 'Workspace is busy; retry shortly') from None
