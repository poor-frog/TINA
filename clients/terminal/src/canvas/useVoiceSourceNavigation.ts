"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { useService } from '../platform';
import { LayoutServiceId } from '../workbench/layout';
import { useOpenEntity } from '../ui-kit/docLinks';

export const VOICE_SOURCE_REVEAL = 'tina:voice-source-reveal';
type Hint = { request_id:string; session_uid:string; revision:number; created_at_ms:number; expires_at_ms:number };
type Source = { id:string; kind:'document'|'transcript'; path?:string; segment_id?:string; meeting_id?:number|null; meeting_title?:string|null };
const record = (v:unknown):Record<string,unknown> => v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const uuid = (v:unknown):v is string => typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function activeRoom(meetingId:string) {
  return document.visibilityState==='visible'&&!document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')
    && [...document.querySelectorAll<HTMLElement>('[data-voice-meeting-id]')]
      .some(node=>node.dataset.voiceMeetingId===meetingId&&node.getClientRects().length>0);
}

export function navigationHint(value:unknown,meetingId:string,after:number,now=Date.now()):Hint|null {
  if(!/^\d+$/.test(meetingId))return null;
  const body=record(value),policy=record(body.policy),runtime=record(body.runtime),hint=record(runtime.navigation);
  if(body.available!==true||policy.enabled!==true||runtime.session_active!==true||runtime.heartbeat_fresh!==true
    ||['OFF','ERROR'].includes(String(runtime.state))||!uuid(hint.request_id)||hint.session_uid!==runtime.session_uid
    ||typeof hint.session_uid!=='string'||!hint.session_uid||hint.session_uid.length>128
    ||hint.revision!==policy.revision||!Number.isSafeInteger(hint.revision)
    ||!Number.isSafeInteger(hint.created_at_ms)||!Number.isSafeInteger(hint.expires_at_ms)
    ||(hint.created_at_ms as number)<after||(hint.created_at_ms as number)>now+1000
    ||(hint.expires_at_ms as number)<=now||(hint.expires_at_ms as number)-(hint.created_at_ms as number)>60000)return null;
  return hint as Hint;
}

export function navigationSource(value:unknown,hint:Hint):Source {
  const body=record(value),source=record(body.source);
  if(body.request_id!==hint.request_id||body.session_uid!==hint.session_uid||body.revision!==hint.revision
    ||body.created_at_ms!==hint.created_at_ms||body.expires_at_ms!==hint.expires_at_ms||hint.expires_at_ms<=Date.now()
    ||typeof source.id!=='string'||!/^ctx-[0-9a-f]{64}$/.test(source.id)
    ||source.meeting_id!=null&&(!Number.isSafeInteger(source.meeting_id)||(source.meeting_id as number)<=0)
    ||source.meeting_title!=null&&(typeof source.meeting_title!=='string'||source.meeting_title.length>300))throw Error('Source changed');
  if(source.kind==='document'&&typeof source.path==='string'&&source.path.length<=512&&source.path.endsWith('.md')
    &&(source.path==='README.md'||/^(kg|wiki|notes|docs|sources|concepts)\//.test(source.path))&&!source.path.includes('\\')
    &&!source.path.split('/').some(part=>part.startsWith('.')))return source as Source;
  if(source.kind==='transcript'&&typeof source.segment_id==='string'&&source.segment_id.length>0&&source.segment_id.length<=512)return source as Source;
  throw Error('Unsupported navigation source');
}

/** Only the visible owner's meeting view consumes a fresh, once-claimable navigation hint. */
export function useVoiceSourceNavigation(meetingId:string) {
  const layout=useService(LayoutServiceId),openDoc=useOpenEntity(),opener=useRef(openDoc);opener.current=openDoc;
  const [message,setMessage]=useState('');
  const state=useRef({after:Date.now(),seen:new Set<string>(),abort:new AbortController(),timer:undefined as ReturnType<typeof setTimeout>|undefined,
    reveal:undefined as ReturnType<typeof setInterval>|undefined,latest:null as Hint|null});
  useEffect(()=>{
    const current={after:Date.now(),seen:new Set<string>(),abort:new AbortController(),timer:undefined as ReturnType<typeof setTimeout>|undefined,
      reveal:undefined as ReturnType<typeof setInterval>|undefined,latest:null as Hint|null};state.current=current;setMessage('');
    return()=>{current.abort.abort();clearTimeout(current.timer);clearInterval(current.reveal);};
  },[meetingId]);
  const follow=useCallback((value:unknown)=>{
    const current=state.current,hint=navigationHint(value,meetingId,current.after);
    current.latest=hint;
    if(!hint)return;
    const id=hint.request_id;
    if(current.seen.has(id))return;
    current.seen.add(id);while(current.seen.size>64)current.seen.delete(current.seen.values().next().value!);
    if(!activeRoom(meetingId))return;
    void(async()=>{
      try{
        const response=await fetch(`/api/meetings/${meetingId}/voice-assistant/navigation/${id}`,{
          method:'POST',cache:'no-store',signal:AbortSignal.any([current.abort.signal,AbortSignal.timeout(7000)])});
        if(!response.ok){if(response.status===409)return;throw Error('Source unavailable');}
        const source=navigationSource(await response.json(),hint);
        if(current.abort.signal.aborted||current!==state.current||current.latest?.request_id!==id||!activeRoom(meetingId))return;
        if(source.kind==='document'){
          opener.current({path:source.path,slug:undefined});setMessage('Đang mở tài liệu nguồn…');
        }else{
          const mid=String(source.meeting_id||meetingId);
          if(mid!==meetingId)layout.openTab({id:`meeting:${mid}`,title:source.meeting_title||`Meeting ${mid}`,kind:'meeting',params:{meetingId:mid}});
          setMessage('Đang tới đoạn transcript nguồn…');
          const deadline=Date.now()+10000;
          clearInterval(current.reveal);
          current.reveal=setInterval(()=>{
            if(current.abort.signal.aborted||current!==state.current||current.latest?.request_id!==id
                ||document.visibilityState!=='visible'||Date.now()>deadline){clearInterval(current.reveal);return;}
            const root=[...document.querySelectorAll<HTMLElement>('[data-voice-meeting-id]')]
              .find(node=>node.dataset.voiceMeetingId===mid&&node.getClientRects().length>0);
            if(!root)return;
            window.dispatchEvent(new CustomEvent(VOICE_SOURCE_REVEAL,{detail:{meetingId:mid,segmentId:source.segment_id}}));
            const node=[...root.querySelectorAll<HTMLElement>('[data-transcript-segments]')].find(el=>{
              try{return (JSON.parse(el.dataset.transcriptSegments||'[]') as unknown[]).includes(source.segment_id);}catch{return false;}
            });
            if(node){node.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
              node.tabIndex=-1;node.focus({preventScroll:true});node.dataset.voiceSourceTarget='true';
              setTimeout(()=>{delete node.dataset.voiceSourceTarget;},5000);clearInterval(current.reveal);}
          },100);
        }
        clearTimeout(current.timer);current.timer=setTimeout(()=>{if(!current.abort.signal.aborted)setMessage('');},8000);
      }catch{if(!current.abort.signal.aborted&&current===state.current)setMessage('Chưa mở được nguồn. Bạn có thể dùng nút Nguồn của câu trả lời.');}
    })();
  },[meetingId,layout]);
  return {follow,message};
}
