import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MeetingVoiceDrafts } from '../MeetingVoiceDrafts';

vi.mock('../../ui-kit/docLinks',()=>({invalidateDocLinkCaches:vi.fn(),useOpenEntity:()=>vi.fn()}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
const draft={id:'a'.repeat(32),kind:'task',title:'Demo cho An',details:'Tạo task demo cho An, hạn thứ Sáu',
  revision:1,status:'pending',path:null};

it('requires explicit owner review, sends edited fields and shows the saved document',async()=>{
  let value={...draft};
  const fetch=vi.fn(async(_url:string,init?:RequestInit)=>{
    if(init?.method==='POST') {value={...value,status:'approved'};return Response.json(value);}
    return Response.json({drafts:[value]});
  });vi.stubGlobal('fetch',fetch);
  render(<MeetingVoiceDrafts meetingId="42"/>);
  await screen.findByText('Task · Chờ chủ meeting xác nhận');
  expect(fetch.mock.calls.some(([,init])=>init?.method==='POST')).toBe(false);
  fireEvent.change(screen.getByLabelText('Tiêu đề bản nháp voice'),{target:{value:'Demo đã duyệt'}});
  fireEvent.change(screen.getByLabelText('Người phụ trách task'),{target:{value:'An'}});
  fireEvent.change(screen.getByLabelText('Hạn task'),{target:{value:'2026-11-20'}});
  await waitFor(()=>expect((screen.getByLabelText('Tiêu đề bản nháp voice') as HTMLInputElement).value).toBe('Demo đã duyệt'));
  fireEvent.click(screen.getByText('Xác nhận tạo task'));
  await screen.findByText('Task · Đã lưu');
  const post=fetch.mock.calls.find(([,init])=>init?.method==='POST')!;
  expect(post[0]).toBe(`/api/workspace/meeting-knowledge/42/voice-drafts/${draft.id}/review`);
  expect(JSON.parse(post[1]!.body as string)).toMatchObject({expected_revision:1,status:'approved',
    title:'Demo đã duyệt',assignee_label:'An',due:'2026-11-20'});
});

it('preserves edits across polling failures and cannot approve unverified or stale drafts',async()=>{
  vi.useFakeTimers();let failed=false,revision=1;
  vi.stubGlobal('fetch',vi.fn(async()=>failed?new Response('',{status:403}):Response.json({drafts:[{...draft,revision}]})));
  const view=render(<MeetingVoiceDrafts meetingId="42"/>);
  await act(async()=>{await Promise.resolve();});
  fireEvent.change(screen.getByLabelText('Nội dung bản nháp voice'),{target:{value:'Nội dung đang sửa'}});
  failed=true;await act(async()=>{await vi.advanceTimersByTimeAsync(3001);});
  expect((screen.getByText('Xác nhận tạo task') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('Nội dung bản nháp voice') as HTMLTextAreaElement).value).toBe('Nội dung đang sửa');
  failed=false;revision=2;await act(async()=>{await vi.advanceTimersByTimeAsync(3001);});
  expect((screen.getByText('Xác nhận tạo task') as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Bản nháp đã thay đổi ở nơi khác/)).toBeTruthy();
  view.unmount();
});

it('records decisions only after confirmation and discards without approval',async()=>{
  const fetch=vi.fn(async(_url:string,init?:RequestInit)=>Response.json(init?.method==='POST'
    ?{...draft,status:'discarded'}:{drafts:[{...draft,kind:'decision'}]}));vi.stubGlobal('fetch',fetch);
  render(<MeetingVoiceDrafts meetingId="42"/>);
  await screen.findByText('Xác nhận ghi quyết định');
  expect(screen.queryByLabelText('Hạn task')).toBeNull();
  fireEvent.click(screen.getByText('Bỏ bản nháp'));
  await waitFor(()=>expect(fetch.mock.calls.some(([,init])=>init?.method==='POST')).toBe(true));
  const request=fetch.mock.calls.find(([,init])=>init?.method==='POST')!;
  expect(JSON.parse(request[1]!.body as string).status).toBe('discarded');
});

it('reaches older pending drafts and retains edits by blocking page changes',async()=>{
  const fetch=vi.fn(async(url:string)=>Response.json(url.includes('offset=20')
    ?{drafts:[draft]}:{drafts:[{...draft,id:'b'.repeat(32),status:'discarded'}],next_offset:20}));
  vi.stubGlobal('fetch',fetch);
  const view=render(<MeetingVoiceDrafts meetingId="42"/>);
  await screen.findByText('Task · Đã bỏ');
  fireEvent.click(screen.getByText(/Bản nháp từ voice/));
  fireEvent.click(screen.getByRole('button',{name:'Cũ hơn'}));
  await screen.findByText('Task · Chờ chủ meeting xác nhận');
  expect(fetch.mock.calls.some(([url])=>url.endsWith('/voice-drafts?offset=20'))).toBe(true);
  expect(screen.getByText('Trang 2')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Tiêu đề bản nháp voice'),{target:{value:'Đang sửa'}});
  expect((screen.getByRole('button',{name:'Mới hơn'}) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText('Tiêu đề bản nháp voice') as HTMLInputElement).value).toBe('Đang sửa');
  fireEvent.change(screen.getByLabelText('Tiêu đề bản nháp voice'),{target:{value:draft.title}});
  expect((screen.getByRole('button',{name:'Mới hơn'}) as HTMLButtonElement).disabled).toBe(false);
  view.rerender(<MeetingVoiceDrafts meetingId="43"/>);
  await screen.findByText('Task · Đã bỏ');
  expect(fetch.mock.calls.some(([url])=>url.endsWith('/43/voice-drafts'))).toBe(true);
  expect(screen.getByText('Trang 1')).toBeTruthy();
});
