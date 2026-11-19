"""Source navigation selects only fresh, authorized evidence; it never accepts a path or URL."""
import re
from uuid import UUID

from pydantic import BaseModel,ConfigDict,Field

from .voice_replies import VoiceSource


class VoiceNavigationHint(BaseModel):
    model_config=ConfigDict(extra='forbid')
    request_id:UUID
    session_uid:str=Field(min_length=1,max_length=128)
    revision:int=Field(ge=0)
    created_at_ms:int=Field(ge=0,strict=True)
    expires_at_ms:int=Field(ge=0,strict=True)


class VoiceNavigation(VoiceNavigationHint):
    source:VoiceSource


def open_source_intent(question):
    text=re.sub(r'^(?:hey tina|tina ơi|tina)\s*[,!:]?\s*','',question.strip(),flags=re.I)
    if re.search(r'https?://|file:|javascript:|\.\.|[/\\]',text,re.I):return False
    if re.search(r'\b(?:và|and|rồi|then)\b',text,re.I):return False
    return bool(re.match(r'^(?:(?:hãy|giúp tôi|please)\s+)?(?:mở|hiển thị|cho (?:tôi|mình) xem|open|show)\s+'
        r'(?:(?:giúp (?:tôi|mình)|cho (?:tôi|mình)|the)\s+)?(?:nguồn|đoạn|tài liệu|wiki|transcript|source|document)\b',text,re.I))


def select_open_source(question,sources):
    """Ordinals refer to the same original evidence order shown in the owner's source panel."""
    text=question.casefold()
    ordinal=re.search(r'(?:nguồn|source)\s*(?:số|thứ|number)?\s*(\d+|một|hai|ba|bốn|năm|one|two|three|four|five)\b',text)
    if ordinal:
        number=ordinal[1]
        index=(int(number) if number.isdigit() else {'một':1,'hai':2,'ba':3,'bốn':4,'năm':5,
               'one':1,'two':2,'three':3,'four':4,'five':5}[number])-1
        if not 0<=index<len(sources):return None,'missing'
        selected=sources[index]
        return (selected,'ready') if selected.kind!='calculation' else (None,'unsupported')
    kind='document' if re.search(r'tài liệu|wiki|document',text) else 'transcript' if re.search(r'đoạn|transcript',text) else None
    choices=[s for s in sources if s.kind!='calculation' and (kind is None or s.kind==kind)]
    named=[s for s in choices if s.path and len(s.path.rsplit('/',1)[-1])>=4
           and s.path.rsplit('/',1)[-1].casefold() in text]
    if re.search(r'\S+\.md\b',text) and not named:return None,'missing'
    if named:choices=named
    groups={}
    for source in choices:
        key=(source.kind,source.path) if source.kind=='document' else (source.kind,source.meeting_id,source.segment_id)
        groups.setdefault(key,source)
    if len(groups)==1:return next(iter(groups.values())),'ready'
    return None,'ambiguous' if groups else 'missing'


def navigation_reply(status):
    if status=='ready':return {'text':'Em đã chuẩn bị nguồn để mở trên TINA Terminal đang xem meeting này.',
        'sources':[],'answer_kind':'assistant','reason':'answered'}
    text={
        'ambiguous':'Có nhiều nguồn phù hợp. Bạn nói “mở nguồn số 1” hoặc số tương ứng trong danh sách nguồn của câu trả lời vừa rồi nhé?',
        'unsupported':'Đó là nguồn phép tính. Bạn mở phần Nguồn của câu trả lời trong Terminal để xem biểu thức giúp em nhé?',
        'missing':'Em chưa xác định được nguồn vừa nói. Bạn hỏi lại nội dung cần tra, rồi yêu cầu mở nguồn giúp em nhé?',
        'revoked':'Nguồn vừa dùng đã thay đổi hoặc không còn được chia sẻ. Bạn hỏi lại nội dung đó trước khi mở nguồn giúp em nhé?',
    }[status]
    return {'text':text,'sources':[],'answer_kind':'assistant','reason':'clarification','clarification':True}
