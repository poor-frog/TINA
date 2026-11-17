"""Durable owner-only voice answers; independent of canonical ASR transcript rows."""
from typing import Literal
from uuid import UUID
import time

from pydantic import BaseModel, ConfigDict, Field, model_validator
from urllib.parse import urlsplit

FINAL = {'completed', 'failed', 'stopped'}


class VoiceLink(BaseModel):
    model_config = ConfigDict(extra='forbid')
    title: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=4096)

    @model_validator(mode='after')
    def safe_url(self):
        parsed = urlsplit(self.url)
        if (parsed.scheme not in ('https', 'http') or not parsed.hostname or parsed.username is not None
                or any(c.isspace() or ord(c) < 32 for c in self.url)):
            raise ValueError('Invalid public source URL')
        parsed.port
        return self


class VoiceLookup(BaseModel):
    model_config = ConfigDict(extra='forbid')
    tool: Literal['get_recent_transcript', 'search_meeting', 'search_shared_documents', 'search_web', 'read_source_context', 'draft_task', 'draft_decision', 'search_approved_actions', 'calculate', 'search_shared_meetings', 'open_source']
    source_count: int = Field(ge=0, le=32, strict=True)


class VoiceSourceRef(BaseModel):
    model_config = ConfigDict(extra='forbid')
    key: str = Field(min_length=1, max_length=1024)
    fingerprint: str = Field(pattern=r'^[0-9a-f]{64}$')


class VoiceSource(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(pattern=r'^ctx-[0-9a-f]{64}$')
    kind: Literal['transcript', 'document', 'calculation']
    quote: str = Field(min_length=1, max_length=1200)
    segment_id: str | None = Field(default=None, max_length=512)
    speaker_name: str | None = Field(default=None, max_length=512)
    start_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    end_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    path: str | None = Field(default=None, max_length=512)
    paragraph: int | None = Field(default=None, ge=0)
    calculation_query: str | None = Field(default=None,max_length=200)
    meeting_id: int | None = Field(default=None,gt=0,strict=True)
    meeting_title: str | None = Field(default=None,max_length=300)
    meeting_start_time: str | None = Field(default=None,max_length=64)

    @model_validator(mode='after')
    def source_identity(self):
        if self.kind == 'document':
            if not self.path or not self.path.endswith('.md') or self.path.startswith('/') or '..' in self.path.split('/'):
                raise ValueError('Invalid document source')
        elif self.kind == 'calculation':
            if not self.calculation_query: raise ValueError('Missing calculation input')
        elif not self.segment_id:
            raise ValueError('Missing transcript segment')
        return self


class VoiceSources(BaseModel):
    model_config = ConfigDict(extra='forbid')
    sources: list[VoiceSource] = Field(max_length=32)
    unavailable: int = Field(ge=0, le=32)


class VoiceReply(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    text: str = Field(min_length=1, max_length=4000)
    # Legacy reply metadata is read-only; retain saved history when changing runtimes.
    detail_text: str | None = Field(default=None,min_length=1,max_length=4000)
    answer_complete: bool = True
    played_text: str | None = Field(default=None, max_length=4000)
    answer_kind: Literal['meeting', 'general', 'web', 'assistant'] = 'meeting'
    reason: Literal['answered', 'clarification', 'no_shared_sources', 'retrieval_empty', 'insufficient_evidence',
                    'verification_rejected', 'verification_unavailable', 'llm_unavailable', 'generation_format_invalid',
                    'general_disabled', 'web_disabled', 'web_unavailable', 'web_no_sources', 'summary_pending',
                    'clarification_exhausted', 'draft_unavailable'] = 'answered'
    links: list[VoiceLink] = Field(default_factory=list, max_length=6)
    source_refs: list[VoiceSourceRef] = Field(default_factory=list, max_length=32)
    source_count: int = Field(default=0, ge=0, le=32)
    lookups: list[VoiceLookup] = Field(default_factory=list, max_length=4)
    verification: list[Literal['approved','numeric_mismatch','unsupported_claim','contradiction',
                               'ambiguous','unavailable','repair_failed']] = Field(default_factory=list,max_length=2)
    state: Literal['queued', 'started', 'completed', 'failed', 'stopped', 'unconfirmed']
    created_at_ms: int = Field(ge=0, strict=True)
    updated_at_ms: int = Field(ge=0, strict=True)
    started_at_ms: int | None = Field(default=None, ge=0, strict=True)
    ended_at_ms: int | None = Field(default=None, ge=0, strict=True)

    @model_validator(mode='after')
    def played_prefix(self):
        if self.played_text is not None and not ' '.join(self.text.split()).startswith(self.played_text):
            raise ValueError('Played text is not an answer prefix')
        return self


def merge_reply(data, session, reply):
    if (data or {}).get('artifact_deletion'):
        raise ValueError('Meeting artifacts were deleted')
    value = VoiceReply.model_validate(reply).model_dump(mode='json')
    history = dict((data or {}).get('voice_replies') or {})
    key = value['request_id']
    previous = history.get(key)
    if previous:
        if previous['session_uid'] != session or previous['text'] != value['text']:
            raise ValueError('Voice reply identity changed')
        if previous['state'] in FINAL or (previous['state'] == 'started' and value['state'] == 'queued'):
            return data
    history[key] = value | {'session_uid': session}
    # shortcut: replies share meeting JSONB; use a paginated table when histories make row writes expensive.
    return dict(data or {}, voice_replies=history)


def public_replies(row, active_session, heartbeat_fresh=True):
    replies = []
    for record in ((row.get('data') or {}).get('voice_replies') or {}).values():
        value = {key: val for key, val in record.items() if key != 'session_uid'}
        if value['state'] not in FINAL and (record.get('session_uid') != active_session
                or (not heartbeat_fresh and int(time.time() * 1000) - value['updated_at_ms'] > 15000)):
            value['state'] = 'unconfirmed'
        reply = VoiceReply.model_validate(value).model_dump(mode='json')
        reply['source_count'] = len(reply.pop('source_refs'))
        replies.append(reply)
    return sorted(replies, key=lambda item: (item['created_at_ms'], item['request_id']))
