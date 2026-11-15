import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Chat } from '../chat';
import { requestChat } from '../../canvas/actions';
import { VoiceActivity } from '../../canvas/VoiceActivity';
import { ServicesProvider, createContainer, reg, CommandServiceId, createCommandService, useStore } from '../../platform';
import { LayoutServiceId, createLayoutService } from '../../workbench/layout';

vi.mock('../liveMeetings', () => ({ useLiveMeetings: () => [] }));
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const rid='00000000-0000-4000-8000-000000000123';
const session='voice-handoff-42-'+rid;
const status=(hint=true)=>({available:true,policy:{enabled:true},runtime:{state:'QUIET',session_active:true,heartbeat_fresh:true,
  kws:{status:'ready',observed_at_ms:Date.now()},handoff:hint?{request_id:rid,expires_at_ms:Date.now()+300000,kind:'task'}:null}});

function mount(collapsed=false) {
  const layout=createLayoutService('sessions');
  if (layout.store.getState().rightCollapsed!==collapsed) layout.toggleRight();
  const container=createContainer([
    reg(LayoutServiceId,()=>layout),
    reg(CommandServiceId,services=>createCommandService(services)),
  ]);
  function Rail(){const {rightCollapsed}=useStore(layout.store);return rightCollapsed?null:<Chat params={{subject:'handoff-test'}}/>;}
  render(<ServicesProvider container={container}><Rail/><VoiceActivity meetingId="42"/></ServicesProvider>);
  return layout;
}

it('shows a compact handoff only when needed and prepares a separate chat without sending',async()=>{
  const fetch=vi.fn(async(url:string,init?:RequestInit)=>url==='/api/chat'
    ?new Response('data: {"type":"message-delta","text":"Bạn muốn đặt hạn khi nào?"}\n\ndata: {"type":"turn-complete"}\n\n',{headers:{'Content-Type':'text/event-stream'}})
    :Response.json(
    url.includes('/handoff/')?{meeting_id:42,request_id:rid,original_request:'Tạo task demo',task:{title:'demo',assignee:'Lan',due:null}}
    :url.endsWith('/voice-assistant')?status():url.endsWith('/history')?{turns:[]}:{sessions:[]}));
  vi.stubGlobal('fetch',fetch);
  const layout=mount(true);
  fireEvent.click(await screen.findByRole('button',{name:'Continue in chat'}));
  const input=await screen.findByRole('textbox') as HTMLTextAreaElement;
  await vi.waitFor(()=>expect(input.value).toContain('Phụ trách: Lan'));
  expect(layout.store.getState().activeSession).toBe(session);
  expect(screen.getByText('Voice handoff: private chat')).toBeTruthy();
  expect(fetch.mock.calls.some(([url])=>url==='/api/chat')).toBe(false);
  expect(screen.queryByRole('button',{name:'Continue in chat'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Send'}));
  await vi.waitFor(()=>expect(fetch.mock.calls.some(([url])=>url==='/api/chat')).toBe(true));
  const wire=JSON.parse(String(fetch.mock.calls.find(([url])=>url==='/api/chat')?.[1]?.body));
  expect(wire.session).toBe(session);
  expect(wire.active).toBeUndefined();expect(wire.context).toBeUndefined();
});

it('keeps an existing composer draft and leaves the handoff available to retry',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.endsWith('/voice-assistant')?status(false):{turns:[],sessions:[]})));
  const layout=mount();
  const input=screen.getByRole('textbox') as HTMLTextAreaElement;
  fireEvent.change(input,{target:{value:'My unfinished request'}});
  const before=layout.store.getState().activeSession;
  expect(()=>act(()=>requestChat({prompt:'Transferred request',session,composeOnly:true}))).toThrow('Finish or clear');
  expect(input.value).toBe('My unfinished request');
  expect(layout.store.getState().activeSession).toBe(before);
  expect(screen.queryByRole('button',{name:'Continue in chat'})).toBeNull();
});

it('does not open chat when the owner service rejects a stale request',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('/handoff/')?new Response('',{status:409})
    :Response.json(url.endsWith('/voice-assistant')?status():{turns:[],sessions:[]})));
  const layout=mount(),before=layout.store.getState().activeSession;
  fireEvent.click(await screen.findByRole('button',{name:'Continue in chat'}));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('changed or expired'));
  expect(layout.store.getState().activeSession).toBe(before);
});

it('preserves a decision and its unverified status without presenting it as a task',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.includes('/handoff/')?{
    meeting_id:42,request_id:rid,kind:'decision',original_request:'Ghi quyết định dùng PostgreSQL',task:null,
    decision:{title:'dùng PostgreSQL',requested_status:'decided',evidence_status:'missing'}}
    :url.endsWith('/voice-assistant')?status():{turns:[],sessions:[]})));
  mount();fireEvent.click(await screen.findByRole('button',{name:'Continue in chat'}));
  const input=await screen.findByRole('textbox') as HTMLTextAreaElement;
  await vi.waitFor(()=>expect(input.value).toContain('Quyết định: dùng PostgreSQL'));
  expect(input.value).toContain('đã chốt (cần đối chiếu nguồn)');
  expect(input.value).toContain('Kiểm tra nguồn: chưa có đoạn xác nhận');
  expect(input.value).not.toContain('Phụ trách:');
});

it('carries an uncertain task save into chat before any retry',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>Response.json(url.includes('/handoff/')?{
    meeting_id:42,request_id:rid,kind:'task',original_request:'Tạo task demo',
    task:{title:'demo',assignee:'Lan',due:null,save_uncertain:true}}
    :url.endsWith('/voice-assistant')?status():{turns:[],sessions:[]})));
  mount();fireEvent.click(await screen.findByRole('button',{name:'Continue in chat'}));
  const input=await screen.findByRole('textbox') as HTMLTextAreaElement;
  await vi.waitFor(()=>expect(input.value).toContain('Kiểm tra bản nháp đã có trước khi thử tạo lại.'));
});
