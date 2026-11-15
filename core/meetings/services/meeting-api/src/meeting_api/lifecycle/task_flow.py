"""Ephemeral draft conversations belong to one identified caller and a live room lease."""
import json

from fastapi import HTTPException
from redis.exceptions import WatchError


NODES = {'title', 'assignee', 'due', 'review', 'decision_status', 'decision_evidence'}


class TaskFlowStore:
    def __init__(self, redis, playback):
        self.redis, self.playback = redis, playback

    async def context(self, mid, session: str, revision, speaker, requested):
        if not speaker or self.playback is None:
            return None
        key = f'meeting:voice:{mid}:{session}:task-flow:{revision}:{speaker}'
        if requested=='decision':
            return {'key':key,'kind':'decision','node':'title','state':{'kind':'decision','title':'','utterances':[]}}
        if requested:
            return {'key':key,'node':'title','state':{'title':'','assignee':None,'due':None,'utterances':[]}}
        raw = await self.redis.get(key)
        if not raw:
            return None
        try:
            stored = json.loads(raw)
            receipt = await self.playback.get(mid, stored['request_id'])
            if (stored['node'] in NODES and receipt and receipt.get('session_uid') == session
                    and receipt.get('state') in ('completed','failed') and (receipt.get('voice_reply') or {}).get('text') == stored['text']):
                return {'key':key,'node':stored['node'],'state':stored['state'],
                        **({'kind':'decision'} if stored['state'].get('kind')=='decision' else {}),
                        **({'recover_prompt':True} if receipt['state']=='failed' else {})}
        except (ValueError, KeyError, TypeError):
            pass
        return None

    async def save_reservation(self, lock, key, holder, previous, updated, clear_key=None):
        async with self.redis.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(lock, key + ':agent')
                held = await pipe.get(lock)
                if isinstance(held, bytes): held = held.decode()
                current = json.loads(await pipe.get(key + ':agent') or '{}')
                if held != holder or current != previous:
                    raise HTTPException(409, 'Task flow turn changed')
                pipe.multi(); pipe.set(key + ':agent', json.dumps(updated), ex=240)
                if clear_key: pipe.delete(clear_key)
                await pipe.execute()
            except WatchError:
                raise HTTPException(409, 'Task flow turn changed') from None

    async def stage(self, flow, proposal, request_id, text, lock, holder):
        async with self.redis.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(lock)
                held = await pipe.get(lock)
                if isinstance(held, bytes): held = held.decode()
                if held != holder:
                    raise HTTPException(409, 'Task flow turn stopped')
                pipe.multi()
                if proposal['action'] in ('finish','cancel','leave'):
                    pipe.delete(flow['key'])
                else:
                    pipe.set(flow['key'],json.dumps({'state':proposal['state'],'node':proposal['node'],
                        'request_id':str(request_id),'text':text}),ex=300)
                await pipe.execute()
            except WatchError:
                raise HTTPException(409, 'Task flow turn stopped') from None


def checked_proposal(result):
    if (not isinstance(result,dict) or set(result) != {'action','node','state','text'}
            or result['action'] not in ('update','finish','cancel','leave','pause','service_error') or result['node'] not in NODES
            or not isinstance(result['text'],str) or len(result['text'])>1000
            or not isinstance(result['state'],dict) or len(json.dumps(result,ensure_ascii=False))>20000):
        raise HTTPException(502, 'Invalid task flow proposal')
    return result


def service_error(flow, question, *, saving=False):
    state=dict(flow['state'])
    if not state.get('utterances'): state['utterances']=[question]
    return {'action':'service_error','node':flow['node'],'state':state,
        'text':('Em chưa xác nhận được việc tạo bản nháp. Thông tin bạn yêu cầu vẫn được giữ.' if saving else
                'Em chưa xử lý được lúc này vì dịch vụ đang gặp lỗi. Chưa có bản nháp nào được tạo.')}


def decision_sources_changed(proposal):
    state=dict(proposal['state'],evidence=[],evidence_status='unchecked')
    return {'action':'update','node':'decision_evidence' if state.get('requested_status')=='decided' else 'review',
        'state':state,'text':'Nguồn hoặc trạng thái quyết định vừa thay đổi. Chưa có bản nháp mới được tạo. Bạn chỉ giúp đoạn xác nhận, hoặc nói “ghi dưới dạng đề xuất” nhé.'}
