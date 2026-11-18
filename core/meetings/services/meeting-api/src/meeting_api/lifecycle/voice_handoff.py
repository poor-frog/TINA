"""Owner-authenticated voice-to-chat context, bounded and revalidated on every read."""
import hashlib
import json
import time
from typing import Literal
from uuid import UUID

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field
from redis.exceptions import WatchError
from .voice_replies import VoiceSource

ELIGIBLE={'clarification_exhausted','llm_unavailable','verification_unavailable','draft_unavailable','generation_format_invalid'}


class VoiceHandoffHint(BaseModel):
    model_config=ConfigDict(extra='forbid')
    request_id:UUID
    expires_at_ms:int=Field(ge=0)
    kind:Literal['task','decision','question']


class HandoffTask(BaseModel):
    model_config=ConfigDict(extra='forbid')
    title:str=Field(max_length=200)
    assignee:str|None=Field(max_length=128)
    due:str|None=Field(max_length=80)
    missing_field:Literal['title','assignee','due','review']
    save_uncertain:bool=False


class HandoffTurn(BaseModel):
    model_config=ConfigDict(extra='forbid')
    question:str=Field(max_length=2000)
    answer:str=Field(max_length=4000)


class HandoffDecision(BaseModel):
    model_config=ConfigDict(extra='forbid')
    title:str=Field(max_length=200)
    requested_status:Literal['proposed','decided']|None
    evidence_status:Literal['unchecked','supported','missing','conflict']
    missing_field:Literal['title','decision_status','decision_evidence','review']
    save_uncertain:bool=False


class VoiceHandoff(VoiceHandoffHint):
    meeting_id:int=Field(gt=0)
    reason:Literal['clarification_exhausted','llm_unavailable','verification_unavailable','draft_unavailable','generation_format_invalid']
    original_request:str=Field(min_length=1,max_length=2000)
    task:HandoffTask|None
    decision:HandoffDecision|None=None
    heard_turns:list[HandoffTurn]=Field(max_length=3)
    sources:list[VoiceSource]=Field(max_length=8)


class VoiceHandoffs:
    def __init__(self,redis,playback):
        self.redis,self.playback=redis,playback

    def key(self,mid,rid): return f'meeting:voice:{mid}:handoff:{rid}'
    def index(self,mid): return f'meeting:voice:{mid}:handoff-latest'

    async def stage(self,mid,session: str,revision,request_id,question,result,history,flow,proposal,lock,holder):
        if result.get('reason') not in ELIGIBLE or self.playback is None:return
        state=proposal['state'] if flow else None
        if state and not state.get('utterances'):return
        refs=[{'key':s['key'],'fingerprint':s['fingerprint']} for s in result.get('sources',[])]
        if state and state.get('kind')=='decision':
            refs += [{'key':s['key'],'fingerprint':s['fingerprint']} for s in state.get('evidence',[])]
        refs+= [r for t in history for r in t.get('sources',[])]
        refs=list({(r['key'],r['fingerprint']):r for r in refs}.values())[:32]
        now=int(time.time()*1000);rid=str(request_id)
        value={'request_id':rid,'session_uid':session,'revision':revision,'created_at_ms':now,'expires_at_ms':now+300000,
            'reason':result['reason'],'question':question,'history':history[-3:],'source_refs':refs,
            'state':state,'claimed':False,'flow_key':flow['key'] if flow else None,
            'flow_fingerprint':hashlib.sha256(json.dumps(state,sort_keys=True).encode()).hexdigest() if state else None}
        async with self.redis.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(lock)
                held=await pipe.get(lock)
                if isinstance(held,bytes):held=held.decode()
                if held!=holder:raise HTTPException(409,'Voice turn changed')
                pipe.multi();pipe.set(self.key(mid,rid),json.dumps(value),ex=300);pipe.set(self.index(mid),rid,ex=300)
                await pipe.execute()
            except WatchError:raise HTTPException(409,'Voice turn changed') from None

    async def read(self,mid,rid,revision,session: str | None = None):
        raw=await self.redis.get(self.key(mid,rid))
        if not raw:raise HTTPException(409,'Voice handoff expired')
        value=json.loads(raw)
        if value['revision']!=revision or value['expires_at_ms']<=int(time.time()*1000):
            raise HTTPException(409,'Voice sharing changed or handoff expired')
        if not value['claimed']:
            if value['session_uid']!=session:raise HTTPException(409,'Voice session changed')
            runtime=json.loads(await self.redis.get(f'meeting:voice:{mid}:state') or '{}')
            if (runtime.get('session_uid')!=session or runtime.get('state') not in ('LISTENING','QUIET','ERROR')
                    or runtime.get('request_id') not in (None,rid)):
                raise HTTPException(409,'Voice conversation changed')
            receipt=await self.playback.get(mid,rid)
            if not receipt or receipt.get('session_uid')!=session or receipt.get('state') not in ('completed','failed'):
                raise HTTPException(409,'Voice turn has not ended')
            if value['flow_key']:
                current=json.loads(await self.redis.get(value['flow_key']) or '{}')
                fingerprint=hashlib.sha256(json.dumps(current.get('state'),sort_keys=True).encode()).hexdigest()
                if current.get('request_id')!=rid or fingerprint!=value['flow_fingerprint']:
                    raise HTTPException(409,'Task conversation changed')
        return value

    async def hint(self,mid,revision,session: str | None,runtime):
        if runtime.get('state') not in ('LISTENING','QUIET','ERROR'):return None
        rid=await self.redis.get(self.index(mid))
        if isinstance(rid,bytes):rid=rid.decode()
        if not rid:return None
        try:value=await self.read(mid,rid,revision,session)
        except HTTPException:return None
        return {'request_id':rid,'expires_at_ms':value['expires_at_ms'],
            'kind':'decision' if (value['state'] or {}).get('kind')=='decision' else 'task' if value['state'] else 'question'}

    async def claim(self,mid,rid,value):
        if value['claimed']:return value
        lock=f'meeting:voice:{mid}:lock';key=self.key(mid,rid);state_key=f'meeting:voice:{mid}:state'
        async with self.redis.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(lock,key,state_key,*([value['flow_key']] if value['flow_key'] else []))
                if await pipe.get(lock):raise HTTPException(409,'Voice is busy; wait until the turn ends')
                runtime=json.loads(await pipe.get(state_key) or '{}')
                if (runtime.get('session_uid')!=value['session_uid'] or runtime.get('state') not in ('LISTENING','QUIET','ERROR')
                        or runtime.get('request_id') not in (None,rid)):
                    raise HTTPException(409,'Voice conversation changed')
                latest=json.loads(await pipe.get(key) or '{}')
                if latest!=value:raise HTTPException(409,'Voice handoff changed')
                if value['flow_key']:
                    flow=json.loads(await pipe.get(value['flow_key']) or '{}')
                    fingerprint=hashlib.sha256(json.dumps(flow.get('state'),sort_keys=True).encode()).hexdigest()
                    if flow.get('request_id')!=rid or fingerprint!=value['flow_fingerprint']:
                        raise HTTPException(409,'Task conversation changed')
                value=value|{'claimed':True,'expires_at_ms':int(time.time()*1000)+900000}
                pipe.multi();pipe.set(key,json.dumps(value),ex=900);pipe.set(self.index(mid),rid,ex=900)
                if value['flow_key']:pipe.delete(value['flow_key'])
                await pipe.execute()
            except WatchError:raise HTTPException(409,'Voice handoff changed') from None
        return value


def public_context(mid,value,sources):
    state=value['state'];task=None;decision=None
    if state and state.get('kind')=='decision':
        decision={'title':state.get('title',''),'requested_status':state.get('requested_status'),
            'evidence_status':state.get('evidence_status','unchecked')}
        if state.get('save_uncertain'):decision['save_uncertain']=True
        decision['missing_field']=('title' if not decision['title'] else 'decision_status' if decision['requested_status'] is None
            else 'decision_evidence' if decision['requested_status']=='decided' and decision['evidence_status']!='supported' else 'review')
    elif state:
        task={k:state.get(k) for k in ('title','assignee','due')}
        if state.get('save_uncertain'):task['save_uncertain']=True
        task['missing_field']='title' if not task['title'] else 'assignee' if task['assignee'] is None else 'due' if task['due'] is None else 'review'
    selected=[];budget=8000
    for source in sources[:8]:
        row=source.model_dump(exclude_none=True) if hasattr(source,'model_dump') else dict(source)
        row['quote']=row['quote'][:min(budget,2000)];budget-=len(row['quote']);selected.append(row)
        if budget<=0:break
    return {'meeting_id':mid,'request_id':value['request_id'],'expires_at_ms':value['expires_at_ms'],
        'kind':'decision' if decision else 'task' if task else 'question','reason':value['reason'],
        'original_request':state['utterances'][0] if state else value['question'],
        'task':task,**({'decision':decision} if decision else {}),
        'heard_turns':[{k:t[k] for k in ('question','answer')} for t in value['history'][-3:]],'sources':selected}
