import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MeetingVoice } from '../MeetingVoice';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('failed polling invalidates listening and recovery clears only the polling error without losing edits', async () => {
  vi.useFakeTimers(); let online = true;
  const now = Date.now();
  const value = { available: true, policy: { enabled: true, include_transcript: true, documents: [], revision: 1, wake_variants: [] },
    runtime: { state: 'LISTENING', session_active: true, heartbeat_fresh: true,
      diagnostic: { event_id: 'd1', code: 'listening', observed_at_ms: now, expires_at_ms: now + 30000, heard_prefix: 'private prefix' },
      audio: { observed_at_ms: now, channels: [] } } };
  vi.stubGlobal('fetch', vi.fn(async () => { if (!online) throw Error('offline'); return { ok: true, json: async () => value }; }));
  await act(async () => { render(<MeetingVoice meetingId="42" />); });
  fireEvent.change(screen.getByLabelText('Biến thể tên TINA'), { target: { value: 'ti na' } });
  expect(screen.getByText(/Voice assistant · Đang nghe/)).toBeTruthy();
  online = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText(/Voice assistant · Chưa nhận trạng thái bot/)).toBeTruthy();
  expect(screen.queryByText('private prefix')).toBeNull(); expect(screen.queryByText('Audio theo kênh · 0')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(screen.queryByText(/Voice assistant · Đang nghe/)).toBeNull();
  online = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(screen.getByText(/Voice assistant · Đang nghe/)).toBeTruthy();
  expect(screen.queryByText('Không tải được trạng thái Voice assistant.')).toBeNull();
  expect((screen.getByLabelText('Biến thể tên TINA') as HTMLInputElement).value).toBe('ti na');
});

it('a hanging status read expires listening after 15 seconds without overlapping polls', async () => {
  vi.useFakeTimers(); let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (calls++ > 0) return new Promise(() => {});
    return { ok: true, json: async () => ({ available: true, policy: { enabled: true, documents: [], wake_variants: [] },
      runtime: { state: 'LISTENING', session_active: true, heartbeat_fresh: true } }) };
  }));
  await act(async () => { render(<MeetingVoice meetingId="42" />); });
  await act(async () => { await vi.advanceTimersByTimeAsync(14999); });
  expect(screen.getByText(/Voice assistant · Đang nghe/)).toBeTruthy(); expect(calls).toBe(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.getByText(/Voice assistant · Chưa nhận trạng thái bot/)).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(calls).toBe(2);
});

it('renders server-seeded new room defaults without adding documents or requiring a Save',async()=>{
  const fetch=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>({ok:true,json:async()=>({available:true,
    policy:{enabled:true,include_transcript:true,documents:[],revision:0,wake_variants:[],noise_suppression:true},runtime:{state:'LISTENING'}})}));
  vi.stubGlobal('fetch',fetch);render(<MeetingVoice meetingId="42"/>);
  const voice=await screen.findByLabelText('Bật Voice assistant cho meeting này');
  await waitFor(()=>expect((voice as HTMLInputElement).checked).toBe(true));
  expect((screen.getByLabelText('Lọc tạp âm') as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Transcript của meeting này') as HTMLInputElement).checked).toBe(true);
  expect(fetch.mock.calls.every(([,init])=>init?.method!=='PUT')).toBe(true);
});

it('noise suppression is off by default and saving the trial does not enable room voice',async()=>{
  const fetch=vi.fn(async(_:string,init?:RequestInit)=>({ok:true,json:async()=>({available:true,
    policy:init?.method==='PUT'?{...JSON.parse(init.body as string),revision:2}:{enabled:false,include_transcript:false,documents:[],revision:1,wake_variants:[],noise_suppression:false},
    runtime:{state:'OFF'},documents:[]})}));vi.stubGlobal('fetch',fetch);
  render(<MeetingVoice meetingId="42"/>);
  const checkbox=await screen.findByLabelText('Lọc tạp âm');
  await waitFor(()=>expect((checkbox as HTMLInputElement).disabled).toBe(false));
  expect((checkbox as HTMLInputElement).checked).toBe(false);fireEvent.click(checkbox);
  fireEvent.click(screen.getByText('Lưu cấu hình'));
  await waitFor(()=>expect(fetch.mock.calls.some(([,init])=>init?.method==='PUT'&&JSON.parse(init.body as string).noise_suppression===true&&JSON.parse(init.body as string).enabled===false)).toBe(true));
});

it('shows per-channel numbers and leaves missing queue measurements blank', async () => {
  const now=Date.now();
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({available:true,
    policy:{enabled:true,include_transcript:true,documents:[],revision:1,wake_variants:[]},
    runtime:{state:'LISTENING',session_active:true,heartbeat_fresh:true,audio:{observed_at_ms:now,channels:[
      {channel:0,frames:100,last_frame_ms:now,rms:.1,sample_clock:true,gap_samples:1024,overlap_samples:0,clock_resets:0,asr_inflight:0,asr_errors:1,asr_at_ms:now,capture_lag_ms:12,roundtrip_ms:130,queue_ms:18},
      {channel:1,frames:20,last_frame_ms:now,rms:0,sample_clock:false,gap_samples:0,overlap_samples:0,clock_resets:0,asr_inflight:1,asr_errors:0,asr_at_ms:now},
    ]}}})})));
  render(<MeetingVoice meetingId="42"/>);
  await screen.findByText('Audio theo kênh · 2');
  expect(screen.getByText('#0 · Có âm thanh')).toBeTruthy();expect(screen.getByText('#1 · Yên')).toBeTruthy();
  expect(screen.getByText('1024 / 0')).toBeTruthy();expect(screen.getByText('18 ms')).toBeTruthy();
  expect(screen.getByText('Không có sample clock')).toBeTruthy();
});

it('expires audio snapshots while the next status poll is still pending', async () => {
  vi.useFakeTimers();
  const observedAt = Date.now() - 11000;
  const fetch = vi.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      available: true,
      policy: { enabled: true, include_transcript: true, documents: [], revision: 1, wake_variants: [] },
      runtime: { state: 'LISTENING', audio: { observed_at_ms: observedAt, channels: [] } },
    }),
  }).mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal('fetch', fetch);
  await act(async () => { render(<MeetingVoice meetingId="42" />); });

  await act(async () => { await vi.advanceTimersByTimeAsync(3999); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Audio theo kênh · 0')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(screen.queryByText('Audio theo kênh · 0')).toBeNull();
});

it('shows verified TINA text independently of the closed settings and marks interrupted playback', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ available: true,
    policy: { enabled: true, include_transcript: true, documents: [], revision: 1, wake_variants: [] },
    runtime: { state: 'OFF', session_active: false }, replies: [{ request_id: 'reply-one', text: 'Lan phụ trách demo. <script>unsafe()</script>', state: 'stopped', created_at_ms: 1800000000000 }] }) })));
  const { container, rerender } = render(<MeetingVoice meetingId="42" />);
  expect(await screen.findByRole('region', { name: 'TINA trả lời' })).toBeTruthy();
  expect(screen.getByText('Đã dừng')).toBeTruthy(); expect(screen.getByText('TINA có thể chưa đọc hết nội dung này.')).toBeTruthy();
  expect(container.querySelector('script')).toBeNull(); expect((container.querySelector('details') as HTMLDetailsElement).open).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
  rerender(<MeetingVoice meetingId="43" />);
  await waitFor(() => expect(screen.queryByRole('region', { name: 'TINA trả lời' })).toBeNull());
});

it('interrupted cards display only completed sentences and keep the unspoken tail out of the view',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({available:true,
    policy:{enabled:true,include_transcript:true,documents:[],revision:1,wake_variants:[]},
    runtime:{state:'QUIET'},replies:[{request_id:'partial',text:'Lan phụ trách demo. UNHEARD TAIL.',
      played_text:'Lan phụ trách demo.',state:'stopped',created_at_ms:1800000000000}]})})));
  render(<MeetingVoice meetingId="42"/>);
  expect(await screen.findByText('Lan phụ trách demo.')).toBeTruthy();
  expect(screen.queryByText(/UNHEARD/)).toBeNull();
  expect(screen.getByText('Chỉ hiển thị các câu đã phát trọn vẹn.')).toBeTruthy();
});

it('requires explicit source approval and sends the policy revision', async () => {
  const policy = { enabled: false, include_transcript: false, documents: [], revision: 3, wake_variants: [] };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/meeting-knowledge/')) return { ok: true, json: async () => ({ documents: [{ path: 'wiki/shared.md', title: 'Shared brief' }] }) };
    return { ok: true, json: async () => ({ available: true, policy: init?.method === 'PUT' ? { ...JSON.parse(init.body as string), revision: 4 } : policy, runtime: { state: 'OFF' } }) };
  });
  vi.stubGlobal('fetch', fetch);
  render(<MeetingVoice meetingId="42" nativeId="abc-defg-hij" />);
  fireEvent.click(screen.getByText(/Voice assistant ·/));
  await screen.findByLabelText('Shared brief');
  const enabled = await screen.findByLabelText('Bật Voice assistant cho meeting này');
  await waitFor(() => expect((enabled as HTMLInputElement).disabled).toBe(false));
  expect((screen.getByLabelText('Transcript của meeting này') as HTMLInputElement).checked).toBe(false);
  expect((screen.getByLabelText('Shared brief') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(enabled); fireEvent.click(screen.getByLabelText('Shared brief'));
  fireEvent.click(screen.getByRole('button', { name: 'Lưu cấu hình' }));
  await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true));
  const [, init] = fetch.mock.calls.find(([, options]) => options?.method === 'PUT')!;
  expect(JSON.parse(init!.body as string)).toEqual({ enabled: true, include_transcript: false, documents: ['wiki/shared.md'], revision: 3, wake_variants: [] });
});

it('uses existing Speak Stop route without stopping the transcript bot', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => ({ ok: true, json: async () => url.includes('/meeting-knowledge/')
    ? { documents: [] } : { available: true, policy: { enabled: true, include_transcript: true, documents: [], revision: 1 }, runtime: { state: 'THINKING' } } }));
  vi.stubGlobal('fetch', fetch);
  render(<MeetingVoice meetingId="42" nativeId="abc-defg-hij" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Dừng câu trả lời' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/bots/google_meet/abc-defg-hij/speak', { method: 'DELETE' }));
});


it('saves exact ASR name variants only after owner approval', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => ({ok:true,json:async()=>url.includes('/meeting-knowledge/') ? {documents:[]} :
    {available:true,policy:init?.method==='PUT'?{...JSON.parse(init.body as string),revision:2}:{enabled:false,include_transcript:false,documents:[],revision:1,wake_variants:[]},runtime:{state:'OFF'}}}));
  vi.stubGlobal('fetch', fetch);
  render(<MeetingVoice meetingId="42" />);
  const input = await screen.findByLabelText('Biến thể tên TINA');
  await waitFor(() => expect((input as HTMLInputElement).disabled).toBe(false));
  fireEvent.change(input, {target:{value:'ti na, ti na ơi'}});
  expect(fetch.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Lưu cấu hình'}));
  await waitFor(()=>expect(fetch.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(true));
  const [,init] = fetch.mock.calls.find(([,init])=>init?.method==='PUT')!;
  expect(JSON.parse(init!.body as string).wake_variants).toEqual(['ti na','ti na ơi']);
});


it('default aliases are already available without a room policy write', async () => {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => ({ok:true,json:async()=>url.includes('/meeting-knowledge/') ? {documents:[]} :
    {available:true,policy:init?.method==='PUT'?{...JSON.parse(init.body as string),revision:2}:{enabled:false,include_transcript:false,documents:[],revision:1,wake_variants:[]},runtime:{state:'OFF'}}}));
  vi.stubGlobal('fetch', fetch);
  render(<MeetingVoice meetingId="42" />);
  await screen.findByText(/Các tên mặc định ở trên đã có sẵn/);
  expect(screen.getByText(/Tên gọi có sẵn:.*tin anh ơi/)).toBeTruthy();
  expect(fetch.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
  const value=(screen.getByLabelText('Biến thể tên TINA') as HTMLInputElement).value;
  expect(value).toBe('');
  expect(screen.queryByRole('button',{name:'Thêm biến thể TINA gợi ý'})).toBeNull();
});

it('shows the actual name mismatch and bounded ASR prefix only from owner runtime status', async () => {
  const now=Date.now();
  vi.stubGlobal('fetch',vi.fn(async (url:string)=>({ok:true,json:async()=>url.includes('/meeting-knowledge/')?{documents:[]}:{
    available:true,policy:{enabled:true,include_transcript:true,documents:[],revision:1,wake_variants:[]},
    runtime:{state:'LISTENING',session_active:true,heartbeat_fresh:true,diagnostic:{event_id:'diagnostic-1',code:'name_not_matched',
      observed_at_ms:now,expires_at_ms:now+30000,heard_prefix:'tiên na ơi'}}}})));
  render(<MeetingVoice meetingId="42" />);
  expect(await screen.findByText('tiên na ơi')).toBeTruthy();
  expect(screen.getByText(/đầu câu chưa khớp tên TINA/)).toBeTruthy();
  expect(screen.getByRole('status',{name:'Chẩn đoán Voice assistant'}).textContent).toContain('3 từ đầu');
});

it('expired diagnostics do not remain visible when status polling fails', async () => {
  let calls=0;const now=Date.now();
  vi.stubGlobal('fetch',vi.fn(async ()=>{
    if(calls++>0)throw new Error('offline');
    return{ok:true,json:async()=>({available:true,policy:{enabled:true,include_transcript:true,documents:[],revision:1,wake_variants:[]},
      runtime:{state:'LISTENING',session_active:true,heartbeat_fresh:true,diagnostic:{event_id:'diagnostic-2',code:'name_not_matched',
        observed_at_ms:now-29900,expires_at_ms:now+100,heard_prefix:'private prefix sample'}}})};
  }));
  render(<MeetingVoice meetingId="42" />);
  await screen.findByText('private prefix sample');
  await waitFor(()=>expect(screen.queryByText('private prefix sample')).toBeNull());
});

it('missing heartbeats and ended sessions are not presented as a listening bot', async () => {
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({available:true,policy:{enabled:true,include_transcript:true,documents:[],revision:1,wake_variants:[]},
    runtime:{state:'OFF',session_active:false,heartbeat_fresh:false,diagnostic:null}})})));
  render(<MeetingVoice meetingId="42" />);
  expect(await screen.findByText(/Voice assistant · Chưa có bot đang hoạt động/)).toBeTruthy();
  expect(screen.getByText('Tạo hoặc tiếp tục bot để nhận trạng thái mới.')).toBeTruthy();
});

it('web replies are labeled and show provider source links without adding transcript rows',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({available:true,
    policy:{enabled:true,include_transcript:true,documents:[],revision:1,wake_variants:[],noise_suppression:true},runtime:{state:'QUIET'},
    replies:[{request_id:'00000000-0000-4000-8000-000000000001',text:'Theo thông tin trên web: Redis là một kho dữ liệu.',
      state:'completed',created_at_ms:1,answer_kind:'web',links:[{url:'https://redis.io/docs/',title:'Redis documentation'}]}]})));
  render(<MeetingVoice meetingId="42"/>);
  expect(await screen.findByText('Web')).toBeTruthy();
  const link=screen.getByRole('link',{name:'Redis documentation'});
  expect(link.getAttribute('href')).toBe('https://redis.io/docs/');expect(link.getAttribute('rel')).toContain('noopener');
});

it('assistant replies are labeled without claiming meeting evidence',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({available:true,
    policy:{enabled:true,include_transcript:false,documents:[],revision:1,wake_variants:[],noise_suppression:true},runtime:{state:'QUIET'},
    replies:[{request_id:'00000000-0000-4000-8000-000000000001',text:'Tôi là TINA.',
      state:'completed',created_at_ms:1,answer_kind:'assistant'}]})));
  render(<MeetingVoice meetingId="42"/>);
  expect(await screen.findByText('Trợ lý')).toBeTruthy();
  expect(screen.getByText('Tôi là TINA.')).toBeTruthy();
  expect(screen.queryByText('Nguồn meeting')).toBeNull();
});
