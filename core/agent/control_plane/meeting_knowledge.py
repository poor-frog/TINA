"""Owner-scoped meeting questions and explicitly reviewed, create-only Wiki pages."""
import json
import hmac
import math
import os
import re
import tempfile
import urllib.error
import urllib.request
import uuid
import time
import yaml
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException, Request, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, PositiveInt, StrictBool, field_validator
from typing import Literal, Annotated

from shared.meeting_knowledge import digest, select_sources, sources_for, stale, validate_answer, wiki_page
from shared.adapters import WorkspaceBusyError, parse_entity, workspace_write_lock
from shared.document_links import wikilink_paths
from shared.voice_knowledge import (voice_sources, current_history, validate_voice_answer, voice_route,
    voice_failure, FAILURES, voice_tool_calls, lookup_voice_sources, assistant_reply, voice_chunks, context_handle,
    pending_clarification, semantic_assistant_intent, dialogue_context)
from llm import safe_web_source
from control_plane.voice_retrieval import semantic_rank
from shared.voice_lexical import domain_dictionary
from shared.voice_evidence import evidence_pack
from shared.voice_tools import SEARCH_TOOLS, parse_search_query
from control_plane.voice_summary import recap
from shared.voice_summary import wants_summary
from shared.voice_trace import trace_voice_request, voice_span
from control_plane.voice_actions import (VoiceActionDraft, VoiceActionReview, VoiceActionDraftPage, action_context, create_draft, draft_list,
    review_draft, readback, approved_action_documents, action_intent)
from shared.voice_task_flow import TaskState, apply_task_patch, task_prompt, CONFIRM, CANCEL
from shared.voice_decision_flow import (DecisionState, apply_decision_patch, decision_prompt, checked_evidence,
    CANCEL as DECISION_CANCEL)
from shared.voice_recovery import clarification_attempts
from shared.voice_calculate import calculate_source, calculation_from_key


class Question(BaseModel):
    model_config = {'extra': 'forbid'}
    question: str = Field(min_length=1, max_length=2000)
    documents: list[str] = Field(default_factory=list, max_length=8)
    meeting_ids: list[PositiveInt] = Field(default_factory=list, max_length=4)
    catch_up: StrictBool = False
    notes_preview: StrictBool = False
    assistant: StrictBool = False
    reply_to: str | None = Field(default=None, pattern=r'^[0-9a-f]{32}$')
    draft_document_workspace: str | None = Field(default=None, min_length=1, max_length=120)


def meeting_time_ms(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
        return int(parsed.timestamp() * 1000) if parsed.tzinfo is not None else None
    except (ValueError, OverflowError, OSError):
        return None


def catch_up_sources(canonical, meeting, requested_at_ms):
    origin = meeting_time_ms(meeting.get('start_time'))
    ended = meeting_time_ms(meeting.get('end_time'))
    if ended is None and meeting.get('status') in ('completed', 'failed'):
        raise HTTPException(409, {'code': 'catch_up_clock_unavailable'})
    end_ms = min(requested_at_ms, ended) if ended is not None else requested_at_ms
    start_ms = end_ms - 60_000
    confirmed_through_ms = None
    boundary_omitted = False
    eligible = []
    for source in sources_for(canonical, {}):
        start, end = source['start_ms'], source['end_ms']
        if any(type(stamp) not in (int, float) or not math.isfinite(stamp) for stamp in (start, end)):
            continue
        # Meeting API preserves legacy relative offsets as well as epoch timestamps.
        if 0 <= start < end < 10**12 and origin is not None:
            start, end = origin + start, origin + end
        elif not 10**12 <= start < end:
            continue
        if end <= end_ms:
            confirmed_through_ms = max(confirmed_through_ms or end, end)
        if start_ms <= start and end <= end_ms:
            eligible.append((start, source))
        elif start < end_ms and end > start_ms:
            # shortcut: skip segments crossing the window edge until word timing is reliable for all sources.
            boundary_omitted = True
    window = {'start_ms': start_ms, 'end_ms': end_ms, 'confirmed_through_ms': confirmed_through_ms,
              'boundary_omitted': boundary_omitted}
    return [source for _, source in sorted(eligible, key=lambda item: item[0])], window


class FactReview(BaseModel):
    model_config = {'extra': 'forbid'}
    fact_id: str = Field(pattern=r'^[0-9a-f-]{36}$')
    expected_fingerprint: str = Field(pattern=r'^[0-9a-f]{64}$')
    expected_revision: int = Field(ge=0)
    status: str = Field(pattern=r'^(approved|discarded|pending)$')
    text: str = Field(min_length=1, max_length=4000)


class VoiceSourceRef(BaseModel):
    model_config = {'extra': 'forbid'}
    key: str = Field(min_length=1, max_length=1024)
    fingerprint: str = Field(pattern=r'^[0-9a-f]{64}$')


class VoiceSourceProfile(BaseModel):
    model_config = {'extra': 'forbid'}
    name: str = Field(min_length=1, max_length=80)
    documents: list[Annotated[str, Field(min_length=1, max_length=512)]] = Field(default_factory=list, max_length=8)
    shared_meeting_ids: list[PositiveInt] = Field(default_factory=list, max_length=4)
    include_transcript: StrictBool = True
    include_approved_actions: StrictBool = True
    allow_general_knowledge: StrictBool = True
    allow_web_search: StrictBool = False
    auto_web_search: StrictBool = False


class VoiceHistoryTurn(BaseModel):
    model_config = {'extra': 'forbid'}
    question: str = Field(min_length=1, max_length=2000)
    answer: str = Field(min_length=1, max_length=4000)
    created_at_ms: int = Field(ge=0)
    sources: list[VoiceSourceRef] = Field(max_length=32)
    clarification: bool = False
    heard_partial: StrictBool = False
    heard_source_guards: list[VoiceSourceRef] = Field(default_factory=list,max_length=32)
    follow_up: str | None = Field(default=None, min_length=1, max_length=200)


class VoiceSourcesQuery(BaseModel):
    model_config = {'extra': 'forbid'}
    sources: list[VoiceSourceRef] = Field(max_length=32)


class VoiceQuestion(BaseModel):
    model_config = {'extra': 'forbid'}
    question: str = Field(min_length=1, max_length=2000)
    revision: int = Field(ge=0)
    history: list[VoiceHistoryTurn] = Field(default_factory=list, max_length=3)
    lookups: list['VoiceLookupQuery'] | None = Field(default=None,max_length=4)
    web_result: dict | None = None
    retrieval_deadline_ms: int | None = Field(default=None,strict=True,gt=0)


class VoiceLookupQuery(BaseModel):
    model_config = {'extra':'forbid'}
    name: Literal['get_recent_transcript','search_meeting','search_shared_documents','search_web','read_source_context','draft_task','draft_decision','search_approved_actions','calculate','search_shared_meetings']
    query: str = Field(default='',max_length=200)

    @field_validator('query')
    @classmethod
    def query_text(cls,value,info):
        if info.data.get('name')!='get_recent_transcript' and not value.strip():
            raise ValueError('Search query is empty')
        if info.data.get('name')=='read_source_context' and not re.fullmatch(r'ctx-[0-9a-f]{64}',value.strip()):
            raise ValueError('Invalid context handle')
        if info.data.get('name') in SEARCH_TOOLS: parse_search_query(value)
        return value.strip()


class VoiceAgentQuery(VoiceQuestion):
    operation: Literal['context','plan','lookup']
    lookup: VoiceLookupQuery | None = None
    context_handles: list[str] = Field(default_factory=list,max_length=128)


    @field_validator('context_handles')
    @classmethod
    def valid_handles(cls,values):
        if any(not re.fullmatch(r'ctx-[0-9a-f]{64}',v) for v in values): raise ValueError('Invalid context handle')
        return values


class TaskFlowQuestion(VoiceQuestion):
    operation: Literal['plan', 'finish']
    task_state: TaskState
    recover_prompt: StrictBool = False


class DecisionFlowQuestion(VoiceQuestion):
    operation:Literal['plan','finish']
    decision_state:DecisionState
    recover_prompt:StrictBool=False


def meeting_get(base, subject, meeting_id, suffix):
    if not base:
        raise HTTPException(503, 'Meeting service is not configured')
    headers = {'X-User-Id': subject}
    if suffix.startswith('/internal/meeting-voice/'):
        secret = os.environ.get('TINA_INTERNAL_API_SECRET', '')
        if not secret: raise HTTPException(503, 'Internal voice credential is missing')
        headers['X-Internal-Secret'] = secret
    req = urllib.request.Request(base.rstrip('/') + suffix, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            data = response.read(4_000_001)
            if len(data) > 4_000_000:
                raise HTTPException(413, 'Meeting is too large')
            return json.loads(data)
    except urllib.error.HTTPError as exc:
        raise HTTPException(404 if exc.code in (403, 404) else 503, 'Meeting unavailable') from exc
    except (OSError, ValueError) as exc:
        raise HTTPException(503, 'Could not read meeting sources; retry shortly') from exc


def safe_dir(reader, base, relative):
    target = reader._workspace_child(base, relative)
    if target is None or any(p.is_symlink() for p in [base / relative, *(base / relative).parents] if p != base and base in p.parents):
        raise HTTPException(409, 'Invalid knowledge storage directory')
    target.mkdir(parents=True, exist_ok=True)
    return target


def register(app, subject_of, read_target, reader, meeting_api_url, complete, list_workspaces=None):
    def content_path(base, path):
        parts = Path(path).parts
        if (not parts or Path(path).is_absolute() or Path(path).suffix != '.md'
                or any(part.startswith('.') for part in parts)
                or not (path == 'README.md' or parts[0] in {'kg', 'wiki', 'notes', 'docs', 'sources', 'concepts'})):
            return None
        raw = base / path
        if any(p.is_symlink() for p in [raw, *raw.parents] if base in p.parents):
            return None
        return reader._workspace_child(base, path)

    def document_paths(request, base):
        if not hasattr(request.state, 'knowledge_paths'):
            request.state.knowledge_paths = {}
        cache = request.state.knowledge_paths
        if base not in cache:
            paths = []
            def unreadable(error):
                raise error
            try:
                for directory, folders, files in os.walk(base, onerror=unreadable):
                    folders[:] = sorted(name for name in folders if not name.startswith('.') and not (Path(directory) / name).is_symlink())
                    for name in sorted(files):
                        path = (Path(directory) / name).relative_to(base).as_posix()
                        if content_path(base, path) is not None:
                            paths.append(path)
                            if len(paths) > 1000:
                                raise HTTPException(413, 'Workspace has too many Markdown documents to locate meeting sources safely')
            except OSError as exc:
                raise HTTPException(503, 'Could not read workspace documents; retry shortly') from exc
            cache[base] = paths
        return cache[base]

    def related_text(base, path, *, required=False):
        try:
            target = content_path(base, path)
            if target is None or not target.is_file(): return None
            with target.open('rb') as stream:
                raw = stream.read(200001)
            if len(raw) > 200000:
                if required: raise HTTPException(413, 'A Wiki document exceeds the readable source size')
                return None
            text = raw.decode('utf-8')
            if required and len(text)>50000: raise HTTPException(413, 'A Wiki document exceeds the readable source size')
            return text if len(text) <= 50000 else None
        except (OSError, ValueError) as exc:
            raise HTTPException(503, 'Could not read related documents') from exc

    def facts(request, meeting_id, base):
        memory = meeting_get(meeting_api_url, subject_of(request), meeting_id,
                             f'/transcripts/by-id/{meeting_id}/memory')
        current = {fact['id']: fact for fact in memory.get('facts', [])}
        folder = reader._workspace_child(base, f'.meeting-knowledge/{meeting_id}/reviews')
        reviewed = {}
        if folder and folder.is_dir() and not folder.is_symlink():
            for path in folder.glob('*.json'):
                if not path.is_symlink() and re.fullmatch(r'[0-9a-f-]{36}', path.stem):
                    reviewed[path.stem] = json.loads(path.read_text())
        items = []
        for fact_id in dict.fromkeys([*current, *reviewed]):
            review = reviewed.get(fact_id)
            fact = current.get(fact_id) or review['fact']
            fingerprint = digest(fact)
            items.append({'fact': fact, 'fingerprint': fingerprint, 'review': review,
                          'stale': fact_id not in current or bool(review and review['fingerprint'] != fingerprint)})
        return items

    def load(request, meeting_id, slug=None, *, with_canonical=True, preferred=None, profile_documents=(),
             include_workspace_wiki=False, meeting_row=None, transcript_only=False):
        voice = preferred is not None
        preferred = set(preferred or ())
        subject = subject_of(request)
        row = meeting_row if meeting_row is not None else meeting_get(meeting_api_url, subject, meeting_id, f'/meetings/{meeting_id}')
        canonical = (meeting_get(meeting_api_url, subject, meeting_id, f'/transcripts/by-id/{meeting_id}/canonical')
                     if with_canonical else {'segments': []})
        base = read_target(request, slug)
        if transcript_only:
            return base, canonical, {}
        if voice and include_workspace_wiki:
            documents = {}; size = 0
            for path in document_paths(request,base):
                text = related_text(base,path,required=True)
                if text is None: continue
                size += len(text.encode('utf-8'))
                if size > 20000000: raise HTTPException(413,'Workspace Wiki is too large for voice retrieval; choose individual documents')
                documents[path] = text
            return base,canonical,documents
        native = str(row.get('native_meeting_id') or row.get('platform_specific_id') or '')
        paths = set()
        paths.update(profile_documents)
        for doc in (row.get('data') or {}).get('docs', []):
            if (isinstance(doc, dict) and isinstance(doc.get('path'), str)
                    and not doc.get('slug') and doc.get('workspace') in (None, '', subject, base.name)):
                paths.add(doc['path'])
        if re.fullmatch(r'[\w.-]{1,200}', native):
            paths.add(f'kg/entities/meeting/{native}.md')
        unavailable_roots = False
        def read_document(path):
            nonlocal unavailable_roots
            try: return related_text(base, path)
            except HTTPException as exc:
                if not voice or path in preferred or exc.status_code != 503: raise
                if path in paths: unavailable_roots = True
                return None
        documents = {}
        for path in sorted(paths, key=lambda path: (path not in preferred, path)):
            if len(documents) >= 8:
                break
            text = read_document(path)
            if text is not None:
                documents[path] = text
        roots = tuple(documents.items())
        def linked_roots():
            yield from roots
            if preferred.difference(documents):
                if len(paths) > 1000:
                    raise HTTPException(413, 'Meeting has too many document links to locate voice sources safely')
                # Extra meeting roots prove selected Wiki links; they do not consume evidence slots.
                for path in sorted(paths.difference(documents)):
                    if not preferred.difference(documents): break
                    text = read_document(path)
                    if text is not None: yield path, text
        # Only direct meeting roots grant link eligibility, never a selected path by itself.
        links = ((path, match.group(1)) for path, text in linked_roots()
                 for match in re.finditer(r'\[\[([^\]]+)\]\]', text))
        visible = None
        for origin, link in links:
            if len(documents) >= 8 and not preferred.difference(documents): break
            if visible is None: visible = document_paths(request, base)
            matches = wikilink_paths(link, origin, visible)
            if len(matches) != 1: continue
            path = matches[0]
            if len(documents) >= 8 and path not in preferred: continue
            text = read_document(path)
            if text is not None: documents[path] = text
        if preferred:
            # Priority changes the evidence budget, never whether a path is linked to this meeting.
            documents = dict(sorted(documents.items(), key=lambda item: (item[0] not in preferred, item[0]))[:8])
        if voice and preferred.difference(documents) and unavailable_roots:
            raise HTTPException(503, 'Could not verify selected document links')
        return base, canonical, documents

    def stored(reader_base, meeting_id, answer_id):
        if not re.fullmatch(r'[0-9a-f]{32}', answer_id):
            raise HTTPException(404, 'Answer not found')
        path = reader._workspace_child(reader_base, f'.meeting-knowledge/{meeting_id}/{answer_id}.json')
        if path is None or not path.is_file() or path.is_symlink():
            raise HTTPException(404, 'Answer not found')
        return json.loads(path.read_text())

    def page_path(meeting_id, answer_id):
        return f'wiki/meetings/{meeting_id}/{answer_id}.md'

    def saved_page(request, base, meeting_id, answer_id):
        original = page_path(meeting_id, answer_id)
        target = content_path(base, original)
        if target is not None and target.is_file():
            return original
        if not hasattr(request.state, 'knowledge_pages'):
            request.state.knowledge_pages = {}
        cache = request.state.knowledge_pages
        key = (base, meeting_id)
        if key not in cache:
            pages, size = {}, 0
            for path in document_paths(request, base):
                target = content_path(base, path)
                if target is None or not target.is_file():
                    continue
                try:
                    with target.open('rb') as stream:
                        raw = stream.read(500001)
                    size += len(raw)
                    if len(raw) > 500000 or size > 10_000_000:
                        raise HTTPException(413, 'Markdown content exceeds the saved Wiki page discovery limit')
                    metadata, _ = parse_entity(raw.decode('utf-8').replace('\r\n', '\n'))
                except OSError as exc:
                    raise HTTPException(503, 'Could not locate saved Wiki pages; retry shortly') from exc
                except (UnicodeDecodeError, yaml.YAMLError):
                    # Unrelated malformed YAML must not make ordinary document browsing fail.
                    continue
                if not isinstance(metadata, dict) or str(metadata.get('meeting_id')) != str(meeting_id):
                    continue
                identifier = metadata.get('meeting_answer_id')
                if isinstance(identifier, str) and re.fullmatch(r'[0-9a-f]{32}', identifier):
                    pages.setdefault(identifier, []).append(path)
            cache[key] = pages
        matches = cache[key].get(answer_id, [])
        if len(matches) > 1:
            raise HTTPException(409, 'Multiple Wiki pages refer to this answer. Review the copies before saving again.')
        return matches[0] if matches else None

    def scoped_sources(request, meeting_id, current, additional):
        result = [s | {'meeting_id': meeting_id} for s in current]
        if not hasattr(request.state, 'knowledge_sources'):
            request.state.knowledge_sources = {}
        cache = request.state.knowledge_sources
        for mid in dict.fromkeys(additional):
            if mid == meeting_id:
                continue
            if mid in cache:
                result.extend(cache[mid])
                continue
            subject = subject_of(request)
            row = meeting_get(meeting_api_url, subject, mid, f'/meetings/{mid}')
            canonical = meeting_get(meeting_api_url, subject, mid, f'/transcripts/by-id/{mid}/canonical')
            cache[mid] = [s | {'key': f'meeting:{mid}:' + s['key'], 'meeting_id': mid,
                              'meeting_title': row.get('title') or f'Cuộc họp {mid}'}
                          for s in sources_for(canonical, {})]
            result.extend(cache[mid])
        return result

    def view(request, base, meeting_id, answer, current):
        try:
            current = scoped_sources(request, meeting_id, current, answer.get('meeting_ids', []))
        except HTTPException as exc:
            if exc.status_code not in (403, 404):
                raise
            # A removed/revoked meeting cannot expose old quotes or block the remaining history.
            return answer | {'claims': [], 'sources': [], 'stale': True, 'saved_path': None}
        return answer | {'stale': stale(answer, current),
                         'saved_path': saved_page(request, base, meeting_id, answer['id'])}

    def profile_path(base, subject):
        if not str(subject).isdecimal(): raise HTTPException(401, 'Owner identity required')
        path = base / '.meeting-knowledge' / 'voice-source-profiles' / f'{subject}.json'
        if any(p.is_symlink() for p in (path, path.parent, path.parent.parent)):
            raise HTTPException(409, 'Invalid source profile storage')
        return path

    def profiles(base, subject):
        path = profile_path(base, subject)
        try:
            if not path.exists(): return []
            if path.stat().st_size > 100000: raise ValueError()
            rows = json.loads(path.read_text())
            if not isinstance(rows, list) or len(rows) > 20: raise ValueError()
            for item in rows:
                checked = VoiceSourceProfile(name=item['name'], **item['sources'])
                if not re.fullmatch(r'[0-9a-f]{32}', item['id']) or digest(checked.model_dump(exclude={'name'})) != item['fingerprint']:
                    raise ValueError()
            return rows
        except (OSError, ValueError, KeyError, TypeError): raise HTTPException(503, 'Source profiles unavailable') from None

    def write_profiles(base, subject, rows):
        payload = json.dumps(rows, ensure_ascii=False)
        if len(payload.encode()) > 100000: raise HTTPException(413, 'Source profiles are too large')
        directory = safe_dir(reader, base, '.meeting-knowledge/voice-source-profiles')
        with tempfile.NamedTemporaryFile(dir=directory, mode='w', delete=False) as out:
            temporary = Path(out.name)
            out.write(payload)
        try: os.replace(temporary, profile_path(base, subject))
        finally: temporary.unlink(missing_ok=True)

    def resolve_profile(base, subject, policy):
        identifier = policy.get('source_profile_id')
        fingerprint = policy.get('source_profile_fingerprint')
        if not identifier and not fingerprint: return []
        item = next((p for p in profiles(base, subject) if p['id'] == identifier), None)
        if not item or item['fingerprint'] != fingerprint:
            raise HTTPException(409, 'Source profile changed or was removed; apply it again')
        return item['sources']['documents']

    @app.get('/api/workspace/meeting-knowledge/{meeting_id}/source-profiles')
    def source_profiles(request: Request, meeting_id: int):
        base, _, _ = load(request, meeting_id, with_canonical=False)
        return {'profiles': profiles(base, subject_of(request))}

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/source-profiles')
    def save_source_profile(request: Request, meeting_id: int, body: VoiceSourceProfile):
        base, _, _ = load(request, meeting_id, with_canonical=False)
        subject = subject_of(request)
        if not body.name.strip(): raise HTTPException(422, 'Profile name is empty')
        if len(set(body.documents)) != len(body.documents) or len(set(body.shared_meeting_ids)) != len(body.shared_meeting_ids):
            raise HTTPException(422, 'Choose distinct sources')
        for path in body.documents:
            if related_text(base, path) is None: raise HTTPException(422, 'Choose readable workspace documents')
        for mid in body.shared_meeting_ids:
            row = meeting_get(meeting_api_url, subject, mid, f'/meetings/{mid}')
            if str(row.get('user_id')) != str(subject) or (row.get('data') or {}).get('artifact_deletion'):
                raise HTTPException(403, 'Choose owned meetings with available sources')
        sources = body.model_dump(exclude={'name'})
        item = {'id': uuid.uuid4().hex, 'name': body.name.strip(), 'sources': sources, 'fingerprint': digest(sources)}
        try:
            with workspace_write_lock(base):
                rows = profiles(base, subject)
                if len(rows) >= 20: raise HTTPException(409, 'At most 20 source profiles')
                if any(p['name'].casefold() == item['name'].casefold() for p in rows):
                    raise HTTPException(409, 'Choose a different profile name')
                write_profiles(base, subject, rows + [item])
        except WorkspaceBusyError: raise HTTPException(409, 'Workspace busy; retry shortly') from None
        return item

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/source-profiles/remove')
    def remove_source_profile(request: Request, meeting_id: int, body: VoiceSourceRef):
        base, _, _ = load(request, meeting_id, with_canonical=False)
        subject = subject_of(request)
        try:
            with workspace_write_lock(base):
                rows = profiles(base, subject)
                if not any(p['id'] == body.key and p['fingerprint'] == body.fingerprint for p in rows):
                    raise HTTPException(409, 'Source profile changed; reload before removing')
                write_profiles(base, subject, [p for p in rows if p['id'] != body.key])
        except WorkspaceBusyError: raise HTTPException(409, 'Workspace busy; retry shortly') from None
        return {'removed': True}

    @app.post('/api/internal/meeting-voice/{meeting_id}/profile')
    def check_source_profile(request: Request, meeting_id: int, body: dict):
        _, _, _, _, documents = voice_context(request, meeting_id, with_canonical=False, source_policy=body)
        if any(p not in documents for p in body.get('documents', [])): raise HTTPException(409, 'A profile document is unavailable')
        return {'documents': list(documents)}

    def voice_context(request, meeting_id, *, with_canonical=True, source_policy=None):
        expected = os.environ.get('TINA_INTERNAL_API_SECRET', '')
        supplied = request.headers.get('x-internal-secret', '')
        if not expected or not hmac.compare_digest(expected.encode(), supplied.encode()):
            raise HTTPException(401, 'Internal voice authentication required')
        subject = request.headers.get('x-user-id', '')
        if not subject.isdecimal():
            raise HTTPException(401, 'Missing voice owner identity')
        # Only this authenticated internal edge may create the identity marker.
        headers = [(k, v) for k, v in request.scope['headers'] if k != b'x-gateway-verified']
        request.scope['headers'] = headers + [(b'x-gateway-verified', b'meeting-voice-internal')]
        # Starlette's cached Headers is reconstructed by a fresh Request.
        request = Request(request.scope)
        row = meeting_get(meeting_api_url, subject, meeting_id, f'/meetings/{meeting_id}')
        if str(row.get('user_id')) != subject:
            raise HTTPException(404, 'Meeting unavailable')
        policy = source_policy if source_policy is not None else (row.get('data') or {}).get('voice_assistant') or {}
        if (subject == os.environ.get('TINA_CHATGPT_VOICE_OWNER')
                and row.get('platform') == 'google_meet'
                and (row.get('platform_specific_id') or row.get('native_meeting_id')) == os.environ.get('TINA_CHATGPT_VOICE_ROOM')
                and os.environ.get('TINA_CHATGPT_VOICE_SECRET_ARN')):
            if (not policy.get('include_transcript') or policy.get('agent_backend') != 'completion'
                    or any(policy.get(key) for key in ('include_workspace_wiki', 'include_approved_actions',
                        'allow_general_knowledge', 'allow_web_search', 'shared_meeting_ids', 'documents', 'source_profile_id'))):
                raise HTTPException(409, 'ChatGPT plan pilot requires the current transcript only')
            request.state.chatgpt_voice_pilot = True
        base = read_target(request, None)
        paths = resolve_profile(base, subject, policy)
        base, canonical, documents = load(request, meeting_id, with_canonical=with_canonical,
            preferred=policy.get('documents', []), profile_documents=paths,
            include_workspace_wiki=policy.get('include_workspace_wiki') is True)
        if policy.get('source_profile_id') and any(p not in documents for p in policy.get('documents', [])):
            raise HTTPException(409, 'A selected project document is unavailable')
        return request, row, base, canonical, documents

    def voice_shared_rows(request,row,*,allow_missing=False):
        identifiers=((row.get('data') or {}).get('voice_assistant') or {}).get('shared_meeting_ids',[])
        if (not isinstance(identifiers,list) or len(identifiers)>4
                or any(type(i) is not int or i<=0 or i==row['id'] for i in identifiers)
                or len(set(identifiers))!=len(identifiers)):
            raise HTTPException(409,'Invalid shared meeting selection')
        rows=[]
        for identifier in identifiers:
            try:
                shared=meeting_get(meeting_api_url,str(row['user_id']),identifier,f'/meetings/{identifier}')
                if shared.get('id')!=identifier or str(shared.get('user_id'))!=str(row['user_id']):
                    raise HTTPException(403,'Only owned meetings may be shared with the room')
                if (shared.get('data') or {}).get('artifact_deletion'):
                    raise HTTPException(409,'Shared meeting artifacts were deleted')
                rows.append(shared)
            except HTTPException as exc:
                if not allow_missing or exc.status_code not in (403,404,409): raise
        return rows

    def voice_candidates(request,row,base,canonical,documents,*,allow_missing=False):
        policy=(row.get('data') or {}).get('voice_assistant') or {}
        if (row.get('data') or {}).get('artifact_deletion'): raise HTTPException(404,'Meeting artifacts were deleted')
        actions={}
        relative=f'.meeting-knowledge/{row["id"]}/voice-drafts'
        directory=reader._workspace_child(base,relative)
        if policy.get('include_approved_actions') and directory is not None and directory.exists():
            directory=safe_dir(reader,base,relative)
            actions=approved_action_documents(directory,owner=row['user_id'],meeting_id=row['id'],
                read_document=lambda path:related_text(base,path))
        docs=(documents if policy.get('include_workspace_wiki') is True else
              {path:documents[path] for path in policy.get('documents',[]) if path in documents})|actions
        sources=[s|({'approved_action':True} if s.get('path') in actions else {})
            for s in sources_for(canonical if policy.get('include_transcript') else {'segments':[]},docs)]
        if not policy.get('shared_meeting_ids'): return voice_chunks(sources)
        def attributed(source,meeting,current):
            metadata={'meeting_id':meeting['id'],'meeting_title':str(meeting.get('title') or f'Cuộc họp {meeting["id"]}')[:300],
                      'meeting_start_time':str(meeting.get('start_time') or '')[:64] or None}
            return source|metadata|{'key':source['key'] if current else f'meeting:{meeting["id"]}:'+source['key'],
                'fingerprint':digest([source['fingerprint'],metadata]),'current_meeting':current}
        sources=[attributed(s,row,True) for s in sources]
        for shared in voice_shared_rows(request,row,allow_missing=allow_missing):
            try:
                transcript=meeting_get(meeting_api_url,str(row['user_id']),shared['id'],f'/transcripts/by-id/{shared["id"]}/canonical')
                sources.extend(attributed(s,shared,False) for s in sources_for(transcript,{}))
            except HTTPException as exc:
                if not allow_missing or exc.status_code not in (403,404): raise
        return voice_chunks(sources)

    def with_calculations(candidates, question, lookups):
        rows=list(candidates)
        for lookup in lookups or []:
            if lookup.name!='calculate': continue
            try:
                result,_=calculate_source(lookup.query,question,candidates)
                if not any(s['key']==result['key'] for s in rows): rows.append(result)
            except (ValueError,TypeError,SyntaxError,OverflowError): continue
        return rows

    @app.get('/api/internal/meeting-voice/{meeting_id}/ready', include_in_schema=False)
    def voice_ready(request: Request, meeting_id: int):
        request, row, _, _, documents = voice_context(request, meeting_id, with_canonical=False)
        voice_shared_rows(request,row)
        if row.get('platform') != 'google_meet':
            raise HTTPException(422, 'Voice assistant requires Google Meet')
        return {'documents': list(documents)}

    @app.post('/api/internal/meeting-voice/{meeting_id}/sources', include_in_schema=False)
    def voice_sources_view(request: Request, meeting_id: int, body: VoiceSourcesQuery):
        request, row, base, canonical, documents = voice_context(request, meeting_id)
        policy = (row.get('data') or {}).get('voice_assistant') or {}
        if (row.get('data') or {}).get('artifact_deletion'):
            raise HTTPException(404, 'Meeting artifacts were deleted')
        def approved(row,base,canonical,documents):
            sources=voice_candidates(request,row,base,canonical,documents,allow_missing=True)
            for ref in body.sources:
                if not ref.key.startswith('calc:'): continue
                try: sources.append(calculation_from_key(ref.key,sources))
                except (ValueError,TypeError,SyntaxError,OverflowError): continue
            return sources
        candidates = {s['key']: s for s in approved(row,base,canonical,documents)}
        selected = [candidates[r.key] for r in body.sources
                    if r.key in candidates and candidates[r.key]['fingerprint'] == r.fingerprint]
        _, fresh_row, fresh_base, fresh, fresh_docs = voice_context(request, meeting_id)
        if (fresh_base != base or (fresh_row.get('data') or {}).get('voice_assistant') != policy
                or (fresh_row.get('data') or {}).get('artifact_deletion')):
            raise HTTPException(409, 'Voice sources changed')
        latest = {s['key']: s['fingerprint'] for s in approved(fresh_row,fresh_base,fresh,fresh_docs)}
        selected = [s for s in selected if latest.get(s['key']) == s['fingerprint']]
        fields = ('kind', 'quote', 'segment_id', 'speaker_name', 'start_ms', 'end_ms', 'path', 'paragraph','calculation_query',
                  'meeting_id','meeting_title','meeting_start_time')
        return {'sources': [dict({k:s[k] for k in fields if k in s}, id=context_handle(s)) for s in selected],
                'unavailable': len(body.sources) - len(selected)}

    def authorized_voice(request,meeting_id,body):
        request, row, base, canonical, documents = voice_context(request, meeting_id)
        policy = (row.get('data') or {}).get('voice_assistant') or {}
        if (row.get('status') != 'active' or row.get('platform') != 'google_meet'
                or not policy.get('enabled') or policy.get('revision') != body.revision):
            raise HTTPException(409, 'Voice sharing policy changed')
        paths = policy.get('documents', [])
        if any(path not in documents for path in paths):
            raise HTTPException(409, 'A shared source is no longer linked')
        candidates=voice_candidates(request,row,base,canonical,documents)
        return request,row,base,policy,candidates

    def available_voice_drafts(request, meeting_id, *, draft_id=None, offset=0, limit=20):
        subject = subject_of(request)
        row = meeting_get(meeting_api_url,subject,meeting_id,f'/meetings/{meeting_id}')
        if str(row.get('user_id')) != str(subject): raise HTTPException(404,'Meeting unavailable')
        if (row.get('data') or {}).get('artifact_deletion'): raise HTTPException(404,'Meeting artifacts were deleted')
        base = read_target(request,None)
        relative = f'.meeting-knowledge/{meeting_id}/voice-drafts'
        directory = reader._workspace_child(base,relative)
        if directory is None: raise HTTPException(409,'Invalid draft directory')
        if not directory.exists(): return base,directory,[]
        directory = safe_dir(reader,base,relative)
        status = meeting_get(meeting_api_url,subject,meeting_id,f'/meetings/{meeting_id}/voice-assistant')
        policy = (row.get('data') or {}).get('voice_assistant') or {}
        if not policy.get('enabled'): return base,directory,[]
        return base,directory,draft_list(directory,owner=subject,meeting_id=meeting_id,
            policy_revision=policy.get('revision',0),replies=status.get('replies',[]),draft_id=draft_id,offset=offset,limit=limit)

    @app.get('/api/workspace/meeting-knowledge/{meeting_id}/voice-drafts',response_model=VoiceActionDraftPage,response_model_exclude_unset=True)
    def voice_drafts(request:Request,meeting_id:int,offset:int=Query(default=0,ge=0)):
        _,_,drafts = available_voice_drafts(request,meeting_id,offset=offset,limit=21)
        return {'drafts':drafts[:20],**({'next_offset':offset+20} if len(drafts)>20 else {})}

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/voice-drafts/{draft_id}/review')
    def voice_draft_review(request:Request,meeting_id:int,draft_id:str,body:VoiceActionReview):
        base,directory,drafts = available_voice_drafts(request,meeting_id,draft_id=draft_id)
        draft = next((d for d in drafts if d['id']==draft_id),None)
        if draft is None: raise HTTPException(404,'Heard voice draft unavailable')
        def authorize():
            fresh_base,_,fresh = available_voice_drafts(request,meeting_id,draft_id=draft_id)
            if fresh_base != base or not any(d['id']==draft_id for d in fresh):
                raise HTTPException(409,'Voice draft or sharing changed')
        return review_draft(base,directory,VoiceActionDraft.model_validate(draft),body,
            lambda relative:safe_dir(reader,base,relative),authorize)

    def semantic_for(row, policy):
        def rank(question, sources):
            with voice_span('semantic_retrieval') as metrics:
                result = semantic_rank(f"{row['user_id']}:{row['id']}:{policy['revision']}", question, sources)
                metrics.update(input_sources=len(sources), output_sources=len(result))
                return result
        return rank

    def voice_complete(request, policy, text):
        value = json.loads(text)
        if policy.get('agent_backend') == 'sandbox' and str(value.get('mode', '')).startswith('voice'):
            value['use_sandbox_agent'] = True
        return complete(request, json.dumps(value, ensure_ascii=False))

    source_routes = {}

    def source_route(request, question, policy, history, deadline_ms=None):
        from shared.voice_prices import gold_followup
        followup = gold_followup(question,history,int(time.time()*1000))
        if followup and policy.get('allow_web_search') and (deadline_ms is None or deadline_ms>int(time.time()*1000)):
            return 'web',followup
        route = voice_route(question)
        if (route[0] != 'meeting' or not policy.get('allow_web_search') or not policy.get('auto_web_search') or len(question) > 200
                or deadline_ms is not None and deadline_ms <= int(time.time()*1000)
                or wants_summary(question) or action_intent(question)
                or re.search(r'cuộc họp|meeting|dự án|project|ngân sách|budget|deadline|phụ trách|nội bộ|'
                             r'của (?:tôi|mình|chúng)|\b(?:our|my|task)\b|(?:sk-|ghp_)[\w-]+', question, re.I)):
            return route
        # A self-contained public price question starts a new topic, even during an old clarification.
        gold_price = (r'(?:(?:tôi muốn hỏi(?: là)?|cho tôi (?:hỏi|biết))\s+)?'
                      r'(?:(?:hôm nay|hiện tại)\s+)?giá vàng'
                      r'(?:\s+(?:SJC|DOJI|PNJ|nhẫn|miếng|9999|24k|quốc tế|trong nước))?'
                      r'(?:\s+(?:hôm nay|hiện tại|mới nhất))?(?:\s+(?:là|đang))?'
                      r'(?:\s+(?:bao nhiêu|thế nào))?[\s?!.]*')
        if re.fullmatch(gold_price,question.strip(),re.I):
            with voice_span('source_routing') as metrics: metrics['outcome']='applied'
            return 'web',question
        if dialogue_context(question,history,int(time.time()*1000)): return route
        cached = getattr(request.state, 'voice_source_route', None)
        if cached and cached[0] == question: return cached[1]
        turn = request.headers.get('x-tina-voice-request-id')
        cache_key = (subject_of(request), turn, policy.get('revision'), question)
        now = time.monotonic()
        for key, (stamp, _) in list(source_routes.items()):
            if now - stamp > 60: source_routes.pop(key, None)
        if turn and cache_key in source_routes: return source_routes[cache_key][1]
        try:
            payload = {'mode':'voice_source_intent','question':question}
            if deadline_ms is not None: payload['retrieval_deadline_ms'] = deadline_ms
            value = json.loads(voice_complete(request, policy, json.dumps(payload, ensure_ascii=False)))
            kind = value.get('route') if isinstance(value, dict) and set(value) == {'route'} else None
            if kind == 'web' or kind == 'general' and policy.get('allow_general_knowledge'):
                route = (kind, question)
        except (HTTPException, ValueError, TypeError, TimeoutError):
            pass  # An uncertain/outage verdict stays on the authorized local evidence path.
        request.state.voice_source_route = (question, route)
        if turn:
            if len(source_routes) >= 128: source_routes.pop(next(iter(source_routes)), None)
            source_routes[cache_key] = (time.monotonic(), route)
        return route

    @app.post('/api/internal/meeting-voice/{meeting_id}/agent',include_in_schema=False)
    @trace_voice_request('agent')
    def voice_agent(request:Request,meeting_id:int,body:VoiceAgentQuery):
        request,row,base,policy,candidates=authorized_voice(request,meeting_id,body)
        if policy.get('engine')!='livekit': raise HTTPException(409,'LiveKit room policy required')
        now_ms=int(time.time()*1000)
        candidates=with_calculations(candidates,body.question,body.lookups)
        history=current_history([t.model_dump() for t in body.history],candidates,now_ms)
        kind,public_query=source_route(request,body.question,policy,history,body.retrieval_deadline_ms)
        draft_kind, draft_details = action_context(body.question, pending_clarification(history,now_ms)
            if kind == 'meeting' else None)
        if draft_kind: kind = 'draft'
        tools=[]
        if policy.get('include_transcript'):tools+=['get_recent_transcript','search_meeting']
        if policy.get('documents') or policy.get('include_workspace_wiki'):tools.append('search_shared_documents')
        if policy.get('include_approved_actions'):tools.append('search_approved_actions')
        if policy.get('shared_meeting_ids'):tools.append('search_shared_meetings')
        tools.append('calculate')
        if kind=='web':tools=['search_web'] if policy.get('allow_web_search') else []
        if kind in ('general','assistant') or kind=='meeting' and wants_summary(body.question):tools=[]
        if kind=='meeting' and wants_summary(body.question):
            candidates=[s for s in candidates if s.get('current_meeting',True)]
        if kind == 'draft': tools = [] if body.lookups else ['draft_' + draft_kind]
        if kind=='meeting' and tools and (body.lookups or body.operation=='lookup'):
            tools.append('read_source_context')
        selected=[]
        if body.operation=='context':
            result={'history':[{k:t[k] for k in ('question','answer','created_at_ms')} for t in history],
                    'available_tools':tools, **({'task_flow_requested':True} if action_intent(body.question)=='task' else
                        {'decision_flow_requested':True} if action_intent(body.question)=='decision' else {})}
        elif body.operation=='plan':
            if body.retrieval_deadline_ms is not None and body.retrieval_deadline_ms <= now_ms:
                calls=[]
            elif kind=='draft' and not tools:
                calls=[]
            elif kind=='web':
                if tools and len(public_query)>200: raise HTTPException(422,'Public tool query exceeds 200 characters')
                calls=[{'name':'search_web','query':public_query}] if tools and len(public_query)<=200 and not body.lookups else []
            elif not tools:
                calls=[]
            else:
                if kind == 'draft':
                    selected=[]
                elif body.lookups:
                    selected,_=lookup_voice_sources(candidates,[],[c.model_dump() for c in body.lookups],now_ms,semantic=semantic_for(row,policy),dictionary=domain_dictionary(base))
                else:
                    selected,_=voice_sources(candidates,body.question,history,now_ms,semantic=semantic_for(row,policy),dictionary=domain_dictionary(base))
                selected=[s|({'context_handle':context_handle(s)} if context_handle(s) in body.context_handles else {}) for s in selected]
                raw=voice_complete(request,policy,json.dumps({'mode':'voice_plan','question':body.question,
                    'retrieval_deadline_ms':body.retrieval_deadline_ms,
                    'available_tools':tools,'sources':selected,'evidence_pack':evidence_pack(selected,available=len(candidates)),'pending_clarification':pending_clarification(history,now_ms),
                    'dialogue_context':dialogue_context(body.question,history,now_ms),
                    'previous_lookups':[c.model_dump() for c in body.lookups or []],
                    'history':[{k:t[k] for k in ('question','answer','created_at_ms')} for t in history]},ensure_ascii=False))
                try:
                    calls=voice_tool_calls(raw,allowed_tools=tools)
                except (ValueError, TypeError):
                    raise HTTPException(502,'Invalid voice tool plan') from None
                if calls is None: raise HTTPException(502,'Invalid voice tool plan')
                calls=[c|{'query':c['query'].strip()} for c in calls]
                previous=[c.model_dump() for c in body.lookups or []]
                calls=[c for c in calls if c not in previous and (c['name']!='read_source_context' or c['query'] in body.context_handles)]
                calls=list({(c['name'],c['query']):c for c in calls}.values())
                if kind == 'draft': calls = calls[:1]
            result={'tool_calls':calls}
        else:
            if body.lookup is None or body.lookup.name not in (tools + (['draft_' + draft_kind] if kind == 'draft' else [])):
                raise HTTPException(403,'This room has not authorized the requested tool')
            lookup=body.lookup.model_dump()
            if kind == 'draft':
                result={'tool':lookup['name'],'source_count':0,'sources':[],
                        'draft':{'kind':draft_kind,'title':lookup['query']}}
            elif lookup['name']=='calculate':
                try:
                    calculation,parents=calculate_source(lookup['query'],body.question,candidates,
                        allowed_handles=body.context_handles)
                    result={'tool':'calculate','source_count':1,'sources':[calculation],
                            'context_handles':[context_handle(s) for s in parents]}
                except (ValueError,TypeError,SyntaxError,OverflowError):
                    result={'tool':'calculate','source_count':0,'sources':[],'error':'invalid_or_unsupported_inputs'}
            elif lookup['name']=='search_web':
                if lookup['query']!=public_query: raise HTTPException(403,'Only the explicit public query may be searched')
                answer=voice_answer(request,meeting_id,VoiceQuestion(question=body.question,revision=body.revision,
                    history=body.history,
                    retrieval_deadline_ms=body.retrieval_deadline_ms))
                result={'tool':'search_web','source_count':len(answer.get('links',[])),
                        'web_result':{'text':answer['text'].removeprefix('Theo thông tin trên web: '),
                                      'links':answer.get('links',[]),'reason':answer.get('reason'),
                                      'clarification':answer.get('clarification',False),
                                      'verification':answer.get('verification',[])}}
            else:
                selected,trace=lookup_voice_sources(candidates,[],[lookup],now_ms,semantic=semantic_for(row,policy),dictionary=domain_dictionary(base))
                result={'tool':lookup['name'],'source_count':trace[0]['source_count'],
                        'sources':[s|{'context_handle':context_handle(s)} for s in selected],
                        'evidence_pack':evidence_pack(selected,available=len(candidates)),
                        'context_handles':[context_handle(s) for s in selected]}
        _,fresh_row,fresh_base,_,_=voice_context(request,meeting_id,with_canonical=False)
        if fresh_base!=base or (fresh_row.get('data') or {}).get('voice_assistant')!=policy:
            raise HTTPException(409,'Voice sharing policy changed')
        return result

    @app.post('/api/internal/meeting-voice/{meeting_id}/task-flow', include_in_schema=False)
    @trace_voice_request('task_flow')
    def task_flow(request: Request, meeting_id: int, body: TaskFlowQuestion):
        request,row,base,policy,_=authorized_voice(request,meeting_id,body)
        if policy.get('engine')!='livekit': raise HTTPException(409,'LiveKit room policy required')
        state=body.task_state
        if state.utterances and action_intent(state.utterances[0])!='task':
            raise HTTPException(403,'Task flow must start with an explicit task request')
        if not state.utterances and action_intent(body.question)!='task':
            raise HTTPException(403,'An explicit task request is required')
        if state.save_uncertain:
            if body.operation=='finish':raise HTTPException(409,'Check the previous draft write before retrying')
            if CANCEL.fullmatch(body.question.strip()):
                return apply_task_patch(body.question,state.model_dump(),json.dumps({'intent':'cancel','title':None,
                    'assignee':None,'due':None,'skip_assignee':False,'skip_due':False}))
            return {'action':'pause','node':state.node,'state':state.model_dump(),
                'text':'Em chưa xác nhận được lần lưu trước. Bạn kiểm tra bản nháp trong Terminal hoặc chuyển sang chat trước khi thử lại nhé.'}
        if body.operation=='plan' and body.recover_prompt and not CANCEL.fullmatch(body.question.strip()):
            return {'action':'update','node':state.node,'state':state.model_dump(),
                    'text':'Em vẫn giữ thông tin task. '+task_prompt(state)}
        if body.operation=='plan':
            try:
                explicit='cancel' if CANCEL.fullmatch(body.question.strip()) else 'confirm' if state.node=='review' and CONFIRM.fullmatch(body.question.strip()) else None
                raw=json.dumps({'intent':explicit,'title':None,'assignee':None,'due':None,
                    'skip_assignee':False,'skip_due':False}) if explicit else voice_complete(request,policy,json.dumps({
                    'mode':'voice_task_flow','question':body.question,'node':state.node,'task_state':state.model_dump()},ensure_ascii=False))
                result=apply_task_patch(body.question,state.model_dump(),raw)
            except (ValueError,TypeError):
                raise HTTPException(502,'Could not extract the requested task fields') from None
        else:
            if state.node!='review' or not CONFIRM.fullmatch(body.question.strip()) or state.utterances[-1]!=body.question:
                raise HTTPException(409,'The task draft requires explicit confirmation')
            turn_id=request.headers.get('x-tina-voice-request-id')
            try: turn_id=str(uuid.UUID(turn_id))
            except (ValueError,TypeError,AttributeError): raise HTTPException(409,'Current voice turn required') from None
            permit=meeting_get(meeting_api_url,str(row['user_id']),meeting_id,
                f'/internal/meeting-voice/{meeting_id}/turn/{turn_id}')
            if permit.get('current') is not True: raise HTTPException(409,'Voice turn was stopped')
            details=(f'User-requested draft, not an agreed meeting assignment.\n'
                f'Task: {state.title}\nRequested assignee: {state.assignee or "unspecified"}\n'
                f'Requested deadline (literal): {state.due or "unspecified"}\n\nUser input:\n'+'\n'.join(state.utterances))
            directory=safe_dir(reader,base,f'.meeting-knowledge/{meeting_id}/voice-drafts')
            create_draft(directory,request_id=turn_id,meeting_id=meeting_id,owner=row['user_id'],
                policy_revision=policy['revision'],kind='task',title=state.title,details=details)
            result={'text':readback('task',state.title),'sources':[],'answer_kind':'assistant','reason':'answered','clarification':False}
        _,fresh_row,fresh_base,_,_=voice_context(request,meeting_id,with_canonical=False)
        if fresh_base!=base or (fresh_row.get('data') or {}).get('voice_assistant')!=policy:
            raise HTTPException(409,'Voice sharing policy changed')
        return result

    @app.post('/api/internal/meeting-voice/{meeting_id}/decision-flow',include_in_schema=False)
    @trace_voice_request('decision_flow')
    def decision_flow(request:Request,meeting_id:int,body:DecisionFlowQuestion):
        request,row,base,policy,candidates=authorized_voice(request,meeting_id,body)
        if policy.get('engine')!='livekit':raise HTTPException(409,'LiveKit room policy required')
        state=body.decision_state
        if action_intent(state.utterances[0] if state.utterances else body.question)!='decision':
            raise HTTPException(403,'An explicit decision request is required')
        if state.save_uncertain:
            if body.operation=='finish':raise HTTPException(409,'Check the previous draft write before retrying')
            if DECISION_CANCEL.fullmatch(body.question.strip()):
                return apply_decision_patch(body.question,state.model_dump(),json.dumps({'intent':'cancel',
                    'title':None,'requested_status':None,'status_text':None,'source_hint':None}))
            return {'action':'pause','node':state.node,'state':state.model_dump(),
                'text':'Em chưa xác nhận được lần lưu trước. Bạn kiểm tra bản nháp trong Terminal hoặc chuyển sang chat trước khi thử lại nhé.'}
        # Previous source proofs authorize no new content; recheck the exact snapshot before confirmation.
        candidates=[s for s in candidates if s.get('current_meeting',True)]
        by_key={s['key']:s for s in candidates}
        def proof_sources(current):
            return [by_key[p.key] for p in current.evidence if p.key in by_key
                and by_key[p.key]['fingerprint']==p.fingerprint and p.quote in by_key[p.key]['quote']]
        if state.evidence and len(proof_sources(state))!=len(state.evidence):
            state=state.model_copy(update={'evidence':[],'evidence_status':'unchecked'})
        if body.operation=='plan':
            if body.recover_prompt and not DECISION_CANCEL.fullmatch(body.question.strip()):
                return {'action':'update','node':state.node,'state':state.model_dump(),
                    'text':'Em vẫn giữ thông tin quyết định. '+decision_prompt(state)}
            explicit='cancel' if DECISION_CANCEL.fullmatch(body.question.strip()) else 'confirm' if state.node=='review' and CONFIRM.fullmatch(body.question.strip()) else None
            try:
                raw=json.dumps({'intent':explicit,'title':None,'requested_status':None,'status_text':None,'source_hint':None}) if explicit else voice_complete(request,policy,json.dumps({
                    'mode':'voice_decision_flow','question':body.question,'node':state.node,'decision_state':state.model_dump()},ensure_ascii=False))
                result=apply_decision_patch(body.question,state.model_dump(),raw)
                current=DecisionState.model_validate(result['state'])
                if result['action']=='update' and current.node=='decision_evidence' and current.evidence_status=='unchecked':
                    selected,_=voice_sources(candidates,current.title+' '+current.source_hint,[],int(time.time()*1000),semantic=semantic_for(row,policy),dictionary=domain_dictionary(base))
                    if selected:
                        try:
                            raw=voice_complete(request,policy,json.dumps({'mode':'voice_decision_evidence','title':current.title,
                                'sources':selected[:16]},ensure_ascii=False))
                            status,proof=checked_evidence(raw,selected[:16])
                        except (HTTPException,ValueError,TypeError) as exc:
                            if isinstance(exc,HTTPException) and exc.status_code not in (502,503,504):raise
                            result.update(action='service_error',state=current.model_dump(),node=current.node,
                                text='Em vẫn giữ nội dung bạn yêu cầu, nhưng chưa kiểm tra được nguồn vì dịch vụ đang gặp lỗi. Chưa có bản nháp nào được tạo.')
                            status,proof='unchecked',[]
                    else:status,proof='missing',[]
                    current=current.model_copy(update={'evidence_status':status,'evidence':proof})
                    result.update(node=current.node,state=current.model_dump())
                    if result['action']!='service_error':result['text']=decision_prompt(current)
            except (ValueError,TypeError):raise HTTPException(502,'Could not validate decision fields or evidence') from None
            used=proof_sources(current) if result['action']=='update' else []
        else:
            if state.node!='review' or not CONFIRM.fullmatch(body.question.strip()) or state.utterances[-1]!=body.question:
                raise HTTPException(409,'The decision draft requires explicit confirmation and current evidence')
            turn_id=request.headers.get('x-tina-voice-request-id')
            try:turn_id=str(uuid.UUID(turn_id))
            except (ValueError,TypeError,AttributeError):raise HTTPException(409,'Current voice turn required') from None
            if meeting_get(meeting_api_url,str(row['user_id']),meeting_id,f'/internal/meeting-voice/{meeting_id}/turn/{turn_id}').get('current') is not True:
                raise HTTPException(409,'Voice turn was stopped')
            used=proof_sources(state)
            status='Đề xuất theo yêu cầu người gọi; chưa xác nhận đã chốt' if state.requested_status=='proposed' else 'Đã chốt theo nguồn được đối chiếu; chưa được chủ meeting duyệt'
            details=f'Nội dung: {state.title}\nTrạng thái thảo luận: {status}\n\nNguồn: [Meeting {meeting_id}](/meetings/{meeting_id}).\n'
            for proof in state.evidence:
                source=by_key[proof.key]
                details+='\n'+str(source.get('path') or source.get('segment_id') or proof.key)[:512]+'\n> '+proof.quote+'\n'
            details+='\nLời yêu cầu (trích đoạn, không phải bằng chứng đồng thuận):\n'+'\n'.join(state.utterances)[-4000:]
            result={'text':readback('decision',state.title),'sources':used,'answer_kind':'assistant','reason':'answered','clarification':False}
        _,fresh_row,fresh_base,fresh_policy,fresh_sources=authorized_voice(request,meeting_id,body)
        if fresh_base!=base or fresh_policy!=policy or stale({'sources':used},fresh_sources):
            raise HTTPException(409,'Decision sources changed')
        if body.operation=='finish':
            # Recheck Stop after the final source read, immediately before the existing draft write.
            if meeting_get(meeting_api_url,str(row['user_id']),meeting_id,f'/internal/meeting-voice/{meeting_id}/turn/{turn_id}').get('current') is not True:
                raise HTTPException(409,'Voice turn was stopped')
            directory=safe_dir(reader,base,f'.meeting-knowledge/{meeting_id}/voice-drafts')
            create_draft(directory,request_id=turn_id,meeting_id=meeting_id,owner=row['user_id'],policy_revision=policy['revision'],
                kind='decision',title=state.title,details=details)
        return result

    @app.post('/api/internal/meeting-voice/{meeting_id}/answer', include_in_schema=False)
    @trace_voice_request('answer')
    def voice_answer(request: Request, meeting_id: int, body: VoiceQuestion):
        request,row,base,policy,candidates=authorized_voice(request,meeting_id,body)
        candidates=with_calculations(candidates,body.question,body.lookups)
        documents_allowed=bool(policy.get('documents')) or policy.get('include_workspace_wiki') is True
        history = current_history([t.model_dump() for t in body.history], candidates, int(time.time()*1000))
        kind, question = source_route(request,body.question,policy,history,body.retrieval_deadline_ms)
        draft_kind, draft_details = action_context(body.question, pending_clarification(history,int(time.time()*1000))
            if kind == 'meeting' else None)
        if draft_kind: kind = 'draft'
        social_intent = None
        if kind == 'meeting' and not pending_clarification(history,int(time.time()*1000)):
            try:
                social_intent = semantic_assistant_intent(body.question, lambda utterance: voice_complete(request,policy,
                    json.dumps({'mode':'voice_intent','question':utterance},ensure_ascii=False)))
            except (HTTPException, TimeoutError):
                pass  # Classification is optional; the evidence-backed path remains available.
            if social_intent: kind = 'assistant'
        trace, selected, conversation = [], [], []
        summary_sources = None
        answer = None
        draft_query = None
        if kind == 'draft':
            matching = [c for c in body.lookups or [] if c.name == 'draft_' + draft_kind]
            if matching:
                draft_query = matching[0].query
                answer={'text':readback(draft_kind,draft_query),'sources':[], 'answer_kind':'assistant','reason':'answered'}
                trace=[{'tool':'draft_' + draft_kind,'source_count':0}]
            else:
                answer={'text':'Bạn muốn tạo task gì?' if draft_kind == 'task' else 'Bạn muốn ghi lại nội dung quyết định nào?',
                    'sources':[],'answer_kind':'assistant','reason':'clarification','clarification':True}
        elif kind == 'assistant':
            answer = {'text':assistant_reply(body.question,policy,intent=social_intent),'sources':[], 'answer_kind':'assistant','reason':'answered'}
        elif kind != 'meeting':
            if not policy.get('allow_' + ('web_search' if kind == 'web' else 'general_knowledge')):
                answer = voice_failure('web_disabled' if kind == 'web' else 'general_disabled', kind=kind)
            else:
                # Public routes never receive the room's transcript, documents or conversation history.
                try:
                    public = body.web_result if kind=='web' and body.web_result is not None else json.loads(voice_complete(request,policy, json.dumps({'mode': 'voice_' + kind, 'question': question,
                        **({'retrieval_deadline_ms':body.retrieval_deadline_ms} if kind=='web' and body.retrieval_deadline_ms is not None else {})}, ensure_ascii=False)))
                    text = public.get('text')
                    links = [safe_web_source(link) for link in public.get('links', [])[:6]] if kind == 'web' else []
                    links = [{k: link[k] for k in ('url', 'title')} for link in links if link]
                    if kind=='web' and public.get('reason') in (
                            'web_unavailable','web_no_sources','web_answer_empty','web_numeric_mismatch',
                            'llm_unavailable','generation_format_invalid','verification_rejected','verification_unavailable'):
                        answer = voice_failure(public['reason'],kind=kind)
                    elif kind=='web' and public.get('clarification') is True:
                        from shared.voice_prices import CLARIFICATION, gold_request
                        if public.get('reason')!='clarification' or text!=CLARIFICATION or not gold_request(question):
                            raise ValueError('Invalid public clarification')
                        answer={'text':text,'sources':[],'links':[],'answer_kind':'web',
                                'reason':'clarification','clarification':True}
                    elif kind == 'web' and not links:
                        answer = voice_failure('web_no_sources', kind=kind)
                    elif not isinstance(text, str) or not text.strip() or len(text) > 2000:
                        answer = voice_failure('llm_unavailable', kind=kind)
                    else:
                        text = re.sub(r'cite[^]*|【[^】]*】', '', text)
                        text = re.sub(r'\[([^\]]+)\]\(https?://[^)]+\)', r'\1', text).strip()
                        answer = {'text': ('Theo thông tin trên web: ' if kind == 'web' else 'Về kiến thức chung: ') + text,
                                  'sources': [], 'links': links, 'answer_kind': kind, 'reason': 'answered'}
                    if kind=='web':
                        checks=public.get('verification',[])
                        if not isinstance(checks,list) or len(checks)>2 or any(c not in (
                                'approved','numeric_mismatch','unsupported_claim','contradiction','ambiguous','unavailable','repair_failed') for c in checks):
                            raise ValueError('Invalid web verification metadata')
                        answer['verification']=checks
                except (HTTPException, ValueError, TypeError, AttributeError):
                    answer = voice_failure('web_unavailable' if kind == 'web' else 'llm_unavailable', kind=kind)
        now_ms = int(time.time() * 1000)
        if kind == 'meeting' and wants_summary(body.question):
            summary_sources = [s for s in candidates if s['kind']=='transcript' and s.get('current_meeting',True)]
            turn_id = request.headers.get('x-tina-voice-request-id')
            if turn_id:
                try: turn_id = str(uuid.UUID(turn_id))
                except ValueError: raise HTTPException(409, 'Invalid summary turn') from None
            def current_turn():
                if turn_id:
                    value = meeting_get(meeting_api_url, str(row['user_id']), meeting_id,
                        f'/internal/meeting-voice/{meeting_id}/turn/{turn_id}')
                    if value.get('current') is not True: raise HTTPException(409, 'Summary turn was stopped')
            def summary_complete(payload):
                scoped_request = Request({**request.scope, 'state': {}})
                _,fresh_row,fresh_base,fresh_policy,fresh_sources = authorized_voice(scoped_request,meeting_id,body)
                if fresh_base!=base or fresh_policy!=policy or stale({'sources':summary_sources},fresh_sources):
                    raise HTTPException(409,'Summary sources changed')
                current_turn()
                result = voice_complete(scoped_request,policy,json.dumps(payload,ensure_ascii=False))
                current_turn()
                return result
            answer = recap(body.question,summary_sources,f"{row['user_id']}:{meeting_id}:{policy['revision']}:{turn_id or 'legacy'}",
                summary_complete,current=current_turn)
        elif kind == 'meeting':
            history = current_history([t.model_dump() for t in body.history], candidates, now_ms)
            selected, recent_ids = voice_sources(candidates, body.question, history, now_ms,semantic=semantic_for(row,policy),dictionary=domain_dictionary(base))
            recent_keys = {s['key'] for s in selected if s['id'] in recent_ids}
            indices = {s['key']: i for i, s in enumerate(candidates)}
            selected = [s | {'id': f"s{indices[s['key']]}"} for s in selected]
            if body.lookups is not None:
                requested=[c.model_dump() for c in body.lookups]
                if any(c['name'] in ('search_web','draft_task','draft_decision') or c['name']=='search_shared_documents' and not documents_allowed
                       or c['name']=='search_approved_actions' and not policy.get('include_approved_actions')
                       or c['name']=='search_shared_meetings' and not policy.get('shared_meeting_ids')
                       or c['name'] in ('search_meeting','get_recent_transcript') and not policy.get('include_transcript') for c in requested):
                    raise HTTPException(403,'Lookup is not authorized for this room')
                selected,trace=lookup_voice_sources(candidates,selected,requested,now_ms,semantic=semantic_for(row,policy),dictionary=domain_dictionary(base))
            def conversation_for(rows):
                ids = {s['key']: s['id'] for s in rows}
                return [{'question': t['question'], 'answer': t['answer'],
                         'heard_partial': t.get('heard_partial',False),
                         'clarification': t.get('clarification', False) and now_ms - t['created_at_ms'] <= 30000,
                         'follow_up': t.get('follow_up') if now_ms - t['created_at_ms'] <= 30000 else None,
                         'source_ids': [ids[r['key']] for r in t['sources']]}
                        for t in history if all(r['key'] in ids for r in t['sources'])]
            if not candidates:
                answer = ({'text':'Bạn nói rõ các số hoặc ngày theo dạng năm-tháng-ngày cần tính giúp em nhé?',
                    'sources':[],'answer_kind':'assistant','reason':'clarification','clarification':True}
                    if any(c.name=='calculate' for c in body.lookups or []) else voice_failure('no_shared_sources'))
            else:
                try:
                    # One lookup round (at most two tools), then a verified final answer.
                    for remaining in ((1,0) if body.lookups is None else (0,)):
                        conversation = conversation_for(selected)
                        raw = voice_complete(request,policy, json.dumps({'mode': 'voice', 'question': body.question,
                            'sources':selected,
                            'evidence_pack':evidence_pack(selected,available=len(candidates)),
                            'clarification_attempt':clarification_attempts(history),
                            'recent_source_ids': [s['id'] for s in selected if s['key'] in recent_keys],
                            'history': conversation, 'pending_clarification':pending_clarification(history,now_ms),
                            'dialogue_context':dialogue_context(body.question,history,now_ms),
                            'tools_remaining': remaining}, ensure_ascii=False))
                        calls = voice_tool_calls(raw)
                        if calls is not None:
                            if not remaining: raise ValueError('Voice lookup budget exhausted')
                            selected, trace = lookup_voice_sources(candidates, selected, calls, now_ms,semantic=semantic_for(row,policy),dictionary=domain_dictionary(base))
                            continue
                        validated = validate_voice_answer(raw, selected)
                        reason = json.loads(raw).get('reason')
                        verification = json.loads(raw).get('verification', [])
                        if not isinstance(verification,list) or len(verification)>2 or any(c not in (
                            'approved','numeric_mismatch','unsupported_claim','contradiction','ambiguous','unavailable','repair_failed'
                        ) for c in verification): raise ValueError('Invalid verification metadata')
                        text = validated.get('clarification') or ' '.join(c['text'] for c in validated['claims'])
                        if validated.get('follow_up'): text += ' ' + validated['follow_up']
                        if text:
                            answer = {'text': text, 'sources': validated['sources'], 'answer_kind': 'meeting',
                                      'reason': 'clarification' if validated.get('clarification') else 'answered',
                                      'clarification': bool(validated.get('clarification'))}
                            if validated.get('follow_up'): answer['follow_up'] = validated['follow_up']
                        else:
                            answer = voice_failure(reason if reason in FAILURES else 'retrieval_empty' if not selected else 'insufficient_evidence')
                        answer['verification'] = verification
                        break
                except HTTPException as exc:
                    if exc.status_code not in (502, 503, 504): raise
                    answer = voice_failure('llm_unavailable')
                except (ValueError, TypeError, AttributeError):
                    answer = voice_failure('llm_unavailable')
        if answer and answer.get('clarification') and clarification_attempts(history)>=3:
            answer=voice_failure('clarification_exhausted',kind='assistant')|{'clarification':False}
        _, fresh_row, fresh_base, fresh, fresh_docs = voice_context(request, meeting_id)
        if fresh_base != base or (fresh_row.get('data') or {}).get('voice_assistant') != policy:
            raise HTTPException(409, 'Voice sharing policy changed')
        latest_sources = with_calculations(voice_candidates(request,fresh_row,fresh_base,fresh,fresh_docs),body.question,body.lookups)
        # Keep original operand evidence alongside derived results for inspection and revocation.
        for source in list(answer.get('sources',[])):
            if source['kind']!='calculation': continue
            _,parents=calculate_source(source['calculation_query'],body.question,candidates)
            for parent in parents:
                if len(answer['sources'])<32 and not any(s['key']==parent['key'] for s in answer['sources']):
                    answer['sources'].append(parent)
        history_ids = {identifier for turn in conversation for identifier in turn['source_ids']}
        checked = selected if answer.get('clarification') or answer.get('follow_up') else answer['sources'] + [s for s in selected if s['id'] in history_ids]
        if summary_sources is not None: checked = summary_sources
        if stale({'sources': checked}, latest_sources):
            raise HTTPException(409, 'Shared evidence changed during the answer')
        if draft_query is not None:
            turn_id = request.headers.get('x-tina-voice-request-id')
            try: turn_id = str(uuid.UUID(turn_id))
            except (ValueError,TypeError,AttributeError): raise HTTPException(409,'Current voice turn required') from None
            permit = meeting_get(meeting_api_url,str(row['user_id']),meeting_id,
                f'/internal/meeting-voice/{meeting_id}/turn/{turn_id}')
            if permit.get('current') is not True: raise HTTPException(409,'Voice turn was stopped')
            directory = safe_dir(reader,base,f'.meeting-knowledge/{meeting_id}/voice-drafts')
            create_draft(directory,request_id=turn_id,meeting_id=meeting_id,owner=row['user_id'],
                policy_revision=policy['revision'],kind=draft_kind,title=draft_query,details=draft_details)
        if kind=='web' and body.lookups:
            trace=[{'tool':'search_web','source_count':len(answer.get('links',[]))}]
        context_sources = list({s['key']:s for s in answer.get('sources',[]) + selected}.values())
        return answer | {'lookups': trace,
                'context_refs': [{'key': s['key'], 'fingerprint': s['fingerprint']} for s in context_sources[:32]]
                                if answer.get('clarification') or answer.get('follow_up') else []}

    @app.get('/api/workspace/meeting-knowledge/{meeting_id}')
    def knowledge(request: Request, meeting_id: int, facts_only: bool = False):
        if facts_only:
            base, _, _ = load(request, meeting_id, with_canonical=False, transcript_only=True)
            return {'facts': facts(request, meeting_id, base)}
        base, canonical, documents = load(request, meeting_id)
        folder = reader._workspace_child(base, f'.meeting-knowledge/{meeting_id}')
        answers = []
        if folder and folder.is_dir() and not folder.is_symlink():
            for path in sorted(folder.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)[:20]:
                if path.is_symlink() or not re.fullmatch(r'[0-9a-f]{32}', path.stem):
                    continue
                answer = stored(base, meeting_id, path.stem)
                answers.append(view(request, base, meeting_id, answer, sources_for(canonical, documents)))
        return {'documents': [{'path': path, 'title': Path(path).stem} for path in documents],
                'answers': answers, 'segment_count': len(canonical.get('segments', [])),
                'facts': facts(request, meeting_id, base)}

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/facts/review')
    def review_fact(request: Request, meeting_id: int, body: FactReview):
        base, canonical, _ = load(request, meeting_id, transcript_only=True)
        if not body.text.strip():
            raise HTTPException(422, 'Review text is empty')
        try:
            with workspace_write_lock(base):
                item = next((item for item in facts(request, meeting_id, base)
                             if item['fact']['id'] == body.fact_id), None)
                if not item or item['stale'] or item['fingerprint'] != body.expected_fingerprint:
                    raise HTTPException(409, 'Evidence changed. Reload before reviewing.')
                previous = item['review']
                revision = previous['revision'] if previous else 0
                if revision != body.expected_revision:
                    raise HTTPException(409, 'This review changed elsewhere. Your draft was kept.')
                by_id = {s['segment_id']: s for s in canonical.get('segments', [])}
                for evidence in item['fact'].get('evidence', []):
                    segment = by_id.get(evidence.get('segment_id'))
                    if (not segment or segment['text'] != evidence['quote']
                            or any(segment.get(k) != evidence.get(k) for k in ('revision', 'speaker_name', 'start_ms', 'end_ms'))):
                        raise HTTPException(409, 'Evidence changed. Reload before reviewing.')
                result = {'fact': item['fact'], 'fingerprint': item['fingerprint'],
                          'status': body.status, 'text': body.text.strip(), 'revision': revision + 1,
                          'reviewed_at': datetime.now(timezone.utc).isoformat()}
                directory = safe_dir(reader, base, f'.meeting-knowledge/{meeting_id}/reviews')
                with tempfile.NamedTemporaryFile(dir=directory, mode='w', delete=False) as out:
                    temporary = Path(out.name)
                    json.dump(result, out, ensure_ascii=False)
                try:
                    os.replace(temporary, directory / f'{body.fact_id}.json')
                finally:
                    temporary.unlink(missing_ok=True)
                return result
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Retry shortly.') from exc

    def draft_sources(request, meeting_id, workspace, path):
        subject = subject_of(request)
        row = meeting_get(meeting_api_url, subject, meeting_id, f'/meetings/{meeting_id}')
        if row.get('status') != 'completed':
            raise HTTPException(409, 'Meeting is not completed')
        base = read_target(request, workspace)
        document = related_text(base, path, required=True)
        if not document or not document.strip():
            raise HTTPException(404, 'Workspace document not found')
        canonical = meeting_get(meeting_api_url, subject, meeting_id, f'/transcripts/by-id/{meeting_id}/canonical')
        return sources_for(canonical, {path: document})

    def generate_draft(request, meeting_id, workspace, path, question):
        candidates = draft_sources(request, meeting_id, workspace, path)
        transcript = [source for source in candidates if source['kind'] == 'transcript']
        document = [source for source in candidates if source['kind'] == 'document']
        if not transcript:
            raise HTTPException(409, 'No confirmed transcript yet')
        # Reserve context for each source type, even when one dominates the ranking.
        selected = select_sources(transcript, question)[:12]
        selected.extend(source | {'id': f's{index}'} for index, source in
                        enumerate(select_sources(document, question)[:6], start=len(selected)))
        selected = [source | {'quote': source['quote'][:900]} for source in selected]
        request.state.post_meeting_draft = True
        raw = complete(request, json.dumps({
            'question': ('Prepare a draft for the user to review. ' + question.strip()),
            'sources': selected,
        }, ensure_ascii=False))
        try:
            answer = validate_answer(raw, selected)
        except (ValueError, TypeError) as exc:
            raise HTTPException(502, 'The draft had invalid sources. Please retry.') from exc
        if stale({'sources': selected}, draft_sources(request, meeting_id, workspace, path)):
            raise HTTPException(409, 'Sources changed. Generate the draft again.')
        return answer

    if list_workspaces is not None:
        from control_plane.post_meeting_draft_jobs import register as register_draft_jobs
        register_draft_jobs(app, subject_of, list_workspaces, meeting_api_url, reader, read_target,
                            document_paths, related_text, draft_sources, generate_draft)

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/ask')
    def ask(request: Request, meeting_id: int, body: Question):
        if not body.question.strip():
            raise HTTPException(422, 'Enter a question')
        if body.draft_document_workspace is not None:
            if (len(body.documents) != 1 or body.assistant or body.notes_preview
                    or body.catch_up or body.reply_to or body.meeting_ids):
                raise HTTPException(422, 'Select one workspace document for the post-meeting draft')
            answer = generate_draft(request, meeting_id, body.draft_document_workspace, body.documents[0], body.question)
            return JSONResponse({'draft': True, 'meeting_id': meeting_id, **answer},
                                headers={'Cache-Control': 'no-store'})
        if body.assistant and (body.notes_preview or body.catch_up or body.meeting_ids):
            raise HTTPException(422, 'Meeting assistant uses only this meeting and its selected documents')
        if body.notes_preview:
            if body.catch_up or body.reply_to or body.documents or body.meeting_ids:
                raise HTTPException(422, 'Notes preview uses only this meeting transcript')
            subject = subject_of(request)
            meeting_get(meeting_api_url, subject, meeting_id, f'/meetings/{meeting_id}')
            path = f'/transcripts/by-id/{meeting_id}/canonical'
            canonical = meeting_get(meeting_api_url, subject, meeting_id, path)
            sources = sources_for(canonical, {})
            if not sources:
                raise HTTPException(409, 'No confirmed transcript yet')
            # Spread the existing per-request budget across the conversation.
            count = min(40, len(sources))
            sampled = [sources[i * (len(sources) - 1) // max(1, count - 1)] for i in range(count)]
            selected = select_sources([source | {'quote': source['quote'][:1200]} for source in sampled], '')
            prompt = ('Viết ghi chú cuộc họp bằng tiếng Việt. Tổng hợp tối đa 4 ý ngắn theo thứ tự thảo luận. '
                      'Ưu tiên kết luận, quyết định, việc cần làm và vấn đề còn mở. '
                      'Gộp các câu cùng ý, bỏ chào hỏi và lặp lại. Chỉ nêu người phụ trách hoặc hạn chót '
                      'khi nguồn nói rõ. Nếu không có ý đáng ghi, trả về danh sách rỗng.')
            raw = complete(request, json.dumps({'question': prompt, 'sources': selected}, ensure_ascii=False))
            try:
                answer = validate_answer(raw, selected)
            except (ValueError, TypeError) as exc:
                raise HTTPException(502, 'The notes had invalid sources. Please retry.') from exc
            latest = meeting_get(meeting_api_url, subject, meeting_id, path)
            if stale(answer, sources_for(latest, {})):
                raise HTTPException(409, 'Transcript changed. Generate notes again.')
            claims = answer['claims'][:4]
            used = {source_id for claim in claims for source_id in claim['source_ids']}
            return {'notes_preview': True, 'meeting_id': meeting_id, 'claims': claims,
                    'sources': [source for source in answer['sources'] if source['id'] in used],
                    'coverage': {'selected': len(selected), 'available': len(sources),
                                 'bounded': len(selected) < len(sources) or any(len(s['quote']) > 1200 for s in sampled)}}
        if body.reply_to and (body.catch_up or body.documents or body.meeting_ids):
            raise HTTPException(422, 'Follow-up uses only this meeting transcript')
        transcript_only = body.catch_up or (body.reply_to is not None and not body.assistant)
        meeting_row = None
        if body.catch_up:
            if body.documents or body.meeting_ids:
                raise HTTPException(422, 'Catch Up uses only this meeting transcript')
            requested_at_ms = int(time.time() * 1000)
            meeting_row = meeting_get(meeting_api_url, subject_of(request), meeting_id, f'/meetings/{meeting_id}')
        base, canonical, documents = load(request, meeting_id, meeting_row=meeting_row, transcript_only=transcript_only)
        if any(path not in documents for path in body.documents):
            raise HTTPException(422, 'Choose documents linked to this meeting')
        additional = list(dict.fromkeys(mid for mid in body.meeting_ids if mid != meeting_id))
        question = body.question.strip()
        prompt = question
        window = None
        if body.catch_up:
            recent, window = catch_up_sources(canonical, meeting_row, requested_at_ms)
            candidates = scoped_sources(request, meeting_id, recent, [])
            question = 'Bắt kịp 60 giây'
            prompt = ('Tóm tắt các ý chính đã nói trong những đoạn transcript được cung cấp, bằng tiếng Việt. '
                      'Dùng tối đa 4 ý ngắn, theo thứ tự cuộc họp. Chỉ nêu quyết định, việc cần làm '
                      'và chi tiết được nguồn xác nhận; không suy đoán phần chưa có transcript.')
        else:
            candidates = scoped_sources(request, meeting_id,
                                        sources_for(canonical, {path: documents[path] for path in body.documents}), additional)
        parent = None
        previous_turn = None
        ranking_context = ''
        if body.reply_to:
            try:
                parent = stored(base, meeting_id, body.reply_to)
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
                raise HTTPException(409, {'code': 'reply_to_unavailable'}) from exc
            if (not parent['claims'] or not parent['sources'] or parent.get('meeting_ids')
                    or any((s['kind'] != 'transcript' and not (body.assistant and s['kind'] == 'document'))
                           or s.get('meeting_id', meeting_id) != meeting_id for s in parent['sources'])):
                raise HTTPException(409, {'code': 'reply_to_unavailable'})
            if body.assistant:
                linked = parent.get('assistant_documents', [])
                if any(path not in documents for path in linked):
                    raise HTTPException(409, {'code': 'reply_to_stale'})
                candidates = scoped_sources(request, meeting_id, sources_for(canonical, {p: documents[p] for p in linked}), [])
            if stale(parent, candidates):
                raise HTTPException(409, {'code': 'reply_to_stale'})
            previous_turn = {'question': parent['question'][:500],
                             'claims': [claim['text'][:400] for claim in parent['claims'][:4]]}
            ranking_context = ' '.join([previous_turn['question'], *previous_turn['claims']])
        if body.assistant:
            from shared.meeting_knowledge import assistant_sources
            selected, bounded = assistant_sources(candidates, question, ranking_context)
        else:
            selected = select_sources(candidates, '' if body.catch_up else question, ranking_context)
            bounded = len(selected) < len(candidates) or any(len(s['quote']) > 2400 for s in candidates)
        if not selected:
            if window is not None:
                raise HTTPException(409, {'code': 'catch_up_no_transcript', 'window': window})
            raise HTTPException(409, 'No confirmed transcript or selected documents yet')
        payload = {'question': prompt, 'sources': selected}
        if body.assistant:
            payload.update(mode='meeting_assistant', bounded=bounded)
        if previous_turn is not None:
            payload['previous_turn'] = previous_turn
        raw = complete(request, json.dumps(payload, ensure_ascii=False))
        try:
            answer = validate_answer(raw, selected)
        except (ValueError, TypeError) as exc:
            raise HTTPException(502, 'The answer had invalid sources. Please retry.') from exc
        answer.update(id=uuid.uuid4().hex, question=question,
                      meeting_ids=additional,
                      created_at=datetime.now(timezone.utc).isoformat(),
                      coverage={'selected': len(selected), 'available': len(candidates),
                                'bounded': bounded})
        if body.assistant:
            answer['assistant'] = True
            answer['assistant_documents'] = parent.get('assistant_documents', []) if parent else body.documents
        if window is not None:
            answer['catch_up_window'] = window
        if parent is not None:
            answer['reply_to'] = body.reply_to
        # Re-read after inference: a delayed answer may already refer to an edited transcript.
        latest_base, latest, docs = load(request, meeting_id, transcript_only=transcript_only)
        request.state.knowledge_sources = {}
        if latest_base != base:
            raise HTTPException(409, 'Workspace changed. Ask again in the current workspace.')
        latest_sources = sources_for(latest, docs)
        if parent is not None and stale(parent, latest_sources):
            raise HTTPException(409, {'code': 'reply_to_stale'})
        directory = safe_dir(reader, base, f'.meeting-knowledge/{meeting_id}')
        target = directory / f'{answer["id"]}.json'
        with tempfile.NamedTemporaryFile(dir=directory, mode='w', delete=False) as out:
            temporary = Path(out.name)
            json.dump(answer, out, ensure_ascii=False)
        try:
            os.link(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        return view(request, base, meeting_id, answer, latest_sources)

    @app.get('/api/workspace/meeting-knowledge/{meeting_id}/answers/{answer_id}')
    def answer_state(request: Request, meeting_id: int, answer_id: str, slug: str | None = None):
        base, canonical, documents = load(request, meeting_id, slug)
        answer = stored(base, meeting_id, answer_id)
        return view(request, base, meeting_id, answer, sources_for(canonical, documents))

    @app.post('/api/workspace/meeting-knowledge/{meeting_id}/answers/{answer_id}/apply')
    def apply(request: Request, meeting_id: int, answer_id: str):
        base, canonical, documents = load(request, meeting_id)
        answer = stored(base, meeting_id, answer_id)
        current = scoped_sources(request, meeting_id, sources_for(canonical, documents), answer.get('meeting_ids', []))
        if not answer['claims'] or stale(answer, current):
            raise HTTPException(409, 'Sources changed or evidence is missing. Ask again before saving.')
        content = wiki_page(answer, meeting_id)
        try:
            with workspace_write_lock(base):
                request.state.knowledge_paths = {}
                request.state.knowledge_pages = {}
                existing = saved_page(request, base, meeting_id, answer_id)
                if existing:
                    target = content_path(base, existing)
                    if target is None or target.read_text() != content:
                        raise HTTPException(409, 'This Wiki page was edited. Existing content was kept.')
                    return {'path': existing}
                directory = safe_dir(reader, base, f'wiki/meetings/{meeting_id}')
                target = directory / f'{answer_id}.md'
                # Exclusive publication never overwrites an existing page, including external writes.
                with tempfile.NamedTemporaryFile(dir=directory, mode='w', delete=False) as out:
                    temporary = Path(out.name)
                    out.write(content)
                try:
                    try:
                        os.link(temporary, target)
                    except FileExistsError:
                        if target.is_symlink() or target.read_text() != content:
                            raise HTTPException(409, 'This Wiki page was edited. Existing content was kept.')
                finally:
                    temporary.unlink(missing_ok=True)
                return {'path': page_path(meeting_id, answer_id)}
        except WorkspaceBusyError as exc:
            raise HTTPException(409, 'Workspace is busy. Retry shortly.') from exc
