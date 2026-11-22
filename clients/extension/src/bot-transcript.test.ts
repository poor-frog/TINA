import assert from 'node:assert/strict';
import { botBase, botSegments, hasOwnedBotInRoom, listBotMeetings, readBotProcessedNotes, readBotRecap, readBotSpeakerLinks, stopBotMeeting, watchBotTranscript } from './bot-transcript';
import { meetAvatarUrl, readMeetAvatars } from './meet-avatars';
import { notesPreview, recapGroups, recapText } from './meet-notes';
import { voiceReplies,voiceSources } from './voice-replies';

const botGatewayUrl = 'http://127.0.0.1:28056';
const config = { botGatewayUrl, account: { id: '7', email: 'fixture@example.test', key: 'a'.repeat(43),
  gateway: botGatewayUrl, terminal: 'http://127.0.0.1:23000' } };
(globalThis as any).chrome = { runtime: { sendMessage: async () => ({ ok: true, token: 'fixture-secret' }) } };
const calculation={id:'ctx-'+'c'.repeat(64),kind:'calculation',quote:'100+200 = 300',calculation_query:'{"expression":"100+200"}'};
assert.equal(voiceSources({sources:[calculation],unavailable:0}).sources[0].kind,'calculation');
assert.throws(()=>voiceSources({sources:[{...calculation,calculation_query:undefined}],unavailable:0}));
const crossSource={id:'ctx-'+'d'.repeat(64),kind:'transcript',quote:'Deadline cũ.',segment_id:'same-id',
  meeting_id:2,meeting_title:'Sprint trước',meeting_start_time:'2026-11-04T08:00:00Z'};
assert.equal(voiceSources({sources:[crossSource],unavailable:0}).sources[0].meeting_id,2);
assert.throws(()=>voiceSources({sources:[{...crossSource,meeting_id:'2'}],unavailable:0}));
const meeting = { id: 12, platform: 'teams', nativeMeetingId: 'same-room', title: 'Review', status: 'active', startMs: Date.parse('2026-10-30T01:00:00Z') };
const doc = (text = 'Xin chào / hello', revision = 0) => ({ id: 12, platform: 'teams', native_meeting_id: 'same-room', start_time: '2026-10-30T01:00:00Z', segments: [{ segment_id: 'one', text, revision, start: 2, end: 4, completed: false, speaker: 'Hà' }] });
for (const url of ['http://remote.test', 'http://person:secret@localhost', 'https://example.test?token=x', 'javascript:alert(1)']) assert.throws(() => botBase(url));
assert.equal(botBase(' http://localhost:123/ '), 'http://localhost:123');
assert.equal(botSegments(doc(), meeting)[0].absolute_start_time, '2026-10-30T01:00:02.000Z');
assert.equal(botSegments(doc(), meeting)[0].completed, false);
assert.throws(() => botSegments({ ...doc(), id: 13 }, meeting), /selected meeting/);
assert.throws(() => botSegments({ ...doc(), platform: 'zoom' }, meeting));
assert.throws(() => botSegments({ ...doc(), native_meeting_id: 'other' }, meeting));
assert.equal(botSegments(doc('User edit', 2), meeting)[0].text, 'User edit');
assert.equal(botSegments({ ...doc(), segments: [] }, meeting).length, 0, 'authoritative removal');
assert.equal(botSegments({ ...doc(), segments: [{ ...doc().segments[0], segment_id: undefined }] }, meeting)[0].text, 'Xin chào / hello', 'legacy API row without a segment ID remains readable');
assert.throws(() => botSegments({ ...doc(), segments: [null] }, meeting));

assert.equal(meetAvatarUrl('https://lh3.googleusercontent.com/a/photo=s64-c'), 'https://lh3.googleusercontent.com/a/photo=s64-c');
assert.equal(meetAvatarUrl('https://lh3.googleusercontent.com.example.org/photo'), undefined);
assert.equal(meetAvatarUrl('https://user@lh3.googleusercontent.com/photo'), undefined);
assert.equal(meetAvatarUrl('http://lh3.googleusercontent.com/photo'), undefined);
{
  const cache = new Map<string, string>();
  const avatar = 'https://lh3.googleusercontent.com/a/photo=s64-c';
  const updated = 'https://lh3.googleusercontent.com/a/updated=s64-c';
  const read = (...urls: string[]) => readMeetAvatars({
    querySelectorAll: () => urls.map(src => ({
      src, getClientRects: () => [1],
      closest: () => ({ getAttribute: () => 'meet-a' }),
    })),
  } as unknown as Document, cache);
  assert.deepEqual(read(avatar), [['meet-a', avatar]]);
  assert.deepEqual(read(), [['meet-a', avatar]], 'a departed participant keeps their last observed photo');
  assert.deepEqual(read(updated), [['meet-a', updated]]);
  assert.deepEqual(read(avatar, updated), [], 'conflicting URLs invalidate the cached photo');
  assert.deepEqual(read(), []);
}
{
  const originalFetch = globalThis.fetch;
  const observed = { speaker_id: 'speaker-a', participant_id: 'meet-a', source: 'meet_dom', status: 'observed', revision: 2 };
  const signal = new AbortController().signal;
  try {
    globalThis.fetch = (async (url: string) => {
      assert.equal(url, 'http://127.0.0.1:28056/transcripts/by-id/12/speakers');
      return Response.json({ meeting_id: 12, speakers: [
        observed, { ...observed, speaker_id: 'speaker-b', source: 'manual' }, { ...observed, speaker_id: 'speaker-c', revision: 0 },
      ] });
    }) as typeof fetch;
    assert.deepEqual([...await readBotSpeakerLinks(config, 12, signal)], [['speaker-a', { participantId: 'meet-a', revision: 2 }]]);
    globalThis.fetch = async () => Response.json({ meeting_id: 13, speakers: [observed] });
    assert.equal((await readBotSpeakerLinks(config, 12, signal)).size, 0);
    globalThis.fetch = async () => new Response('', { status: 403 });
    assert.equal((await readBotSpeakerLinks(config, 12, signal)).size, 0);
  } finally { globalThis.fetch = originalFetch; }
}

const original = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const calls: { url: string; options: RequestInit }[] = [], timers: (() => void)[] = [];
let respond = () => Promise.resolve(Response.json(doc())), updates: string[] = [], errors: boolean[] = [];
globalThis.fetch = (async (url: any, options: any) => { calls.push({ url: String(url), options }); return respond(); }) as typeof fetch;
globalThis.setTimeout = ((fn: () => void) => { timers.push(fn); return timers.length; }) as any;
globalThis.clearTimeout = (() => {}) as any;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
try {
  respond = async () => Response.json({ meetings: [{ id: 12, platform: 'teams', native_meeting_id: 'same-room', status: 'active', shared: true,
    data:{join_failure_summary:'Platform refused the bot.'} }, { id: 13, platform: 'note', native_meeting_id: 'note' }] });
  const listed=await listBotMeetings(config);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].shared, true);
  assert.equal(listed[0].joinFailureSummary,'Platform refused the bot.');
  assert.equal(calls[0].options.headers!['Authorization' as keyof HeadersInit], 'Bearer fixture-secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls.every(call => !call.url.includes('fixture-secret')));
  const room = { platform: 'google_meet', nativeMeetingId: 'abc-defg-hij' };
  const active = { id: 23, platform: 'google_meet', native_meeting_id: 'ABC-DEFG-HIJ', status: 'active', shared: false };
  respond = async () => Response.json({ meetings: [
    { ...active, shared: true }, { ...active, shared: undefined },
    { ...active, native_meeting_id: 'other-room' }, { ...active, status: 'stopping' },
  ] });
  assert.equal(await hasOwnedBotInRoom(config, room), false);
  respond = async () => Response.json({ meetings: [active] });
  assert.equal(await hasOwnedBotInRoom(config, room), true);
  respond = async () => new Response('', { status: 503 });
  assert.equal(await hasOwnedBotInRoom(config, room), false);
  respond = async () => Response.json(doc());
  const stop = watchBotTranscript(config, meeting, rows => updates.push(rows[0]?.text), (_message, denied) => errors.push(denied));
  await turn(); assert.equal(updates.length, 1);
  respond = async () => Response.json(doc('Edited', 1)); timers.pop()!();
  await turn(); assert.equal(updates.at(-1), 'Edited');
  respond = async () => { throw new Error('offline'); }; timers.pop()!();
  await turn(); assert.deepEqual(errors, [false]);
  respond = async () => Response.json(doc('Restored', 2)); timers.pop()!();
  await turn(); assert.equal(updates.at(-1), 'Restored');
  stop(); timers.length = 0;
  let release!: (response: Response) => void;
  respond = () => new Promise(resolve => release = resolve);
  const old = watchBotTranscript(config, meeting, () => updates.push('stale'), () => {});
  await turn(); old(); release(Response.json(doc())); await turn();
  assert.notEqual(updates.at(-1), 'stale');
  const activityUpdates:unknown[]=[];let voiceDenied=false;
  globalThis.fetch=(async(url:any,options:any)=>{
    calls.push({url:String(url),options});
    if(String(url).endsWith('/voice-assistant'))return voiceDenied?new Response('',{status:403}):Response.json({replies:[],policy:{enabled:true},runtime:{state:'CAPTURING',session_active:true,heartbeat_fresh:true}});
    return Response.json({...doc(),platform:'google_meet'});
  }) as typeof fetch;
  const stopActivity=watchBotTranscript(config,{...meeting,platform:'google_meet'},(_rows,_status,_replies,activity)=>activityUpdates.push(activity),()=>{});
  await turn();await turn();
  assert.equal((activityUpdates.at(-1) as any)?.runtime.state,'CAPTURING');
  voiceDenied=true;timers.pop()!();await turn();await turn();
  assert.equal(activityUpdates.at(-1),null,'voice denial clears readiness without blocking transcript');
  stopActivity();timers.length=0;
  globalThis.fetch=(async(url:any,options:any)=>{calls.push({url:String(url),options});return respond();}) as typeof fetch;
  respond = async () => new Response('', { status: 403 });
  watchBotTranscript(config, meeting, () => {}, (_message, denied) => errors.push(denied));
  await turn(); assert.equal(errors.at(-1), true); assert.equal(timers.length, 0);
  assert.ok(calls.every(call => !call.options.method || call.options.method === 'GET'), 'viewer never mutates or starts/stops bots');
  const reply = { request_id: '00000000-0000-4000-8000-000000000001', text: '<script>plain text</script>', state: 'stopped', created_at_ms: 1800000000000 };
  assert.equal(voiceReplies([reply])[0].text, reply.text);
  assert.equal(voiceReplies([{...reply,answer_kind:'assistant'}])[0].answer_kind,'assistant');
  assert.equal(voiceReplies([{...reply,played_text:'<script>'}])[0].played_text,'<script>');
  assert.throws(()=>voiceReplies([{...reply,played_text:'invented'}]));
  assert.throws(()=>voiceReplies([{...reply,played_text:[]} ]));
  assert.throws(() => voiceReplies([reply, { ...reply, text: 'x'.repeat(4001) }]));
  assert.throws(() => voiceReplies([{ ...reply, state: 'constructor' }]));
  assert.throws(() => voiceReplies([{ ...reply, state: ['started'] }]));
  assert.throws(() => voiceReplies([{ ...reply, request_id: '-'.repeat(36) }]));
  assert.deepEqual(voiceReplies(undefined), []);
  const google = { ...meeting, platform: 'google_meet' };
  const googleDoc = { ...doc(), platform: 'google_meet' };
  let answerResponse!: (value: Response) => void;
  globalThis.fetch = (async (url: any) => String(url).endsWith('/voice-assistant')
    ? new Promise(resolve => { answerResponse = resolve; }) : Response.json(googleDoc)) as typeof fetch;
  const received: any[] = [];
  const watching = watchBotTranscript(config, google, (rows, _, replies) => received.push({ rows, replies }), () => {});
  await turn(); assert.equal(received.length, 1, 'slow voice requests cannot stall ASR');
  answerResponse(Response.json({ replies: [reply] })); await turn();
  assert.deepEqual(received.at(-1).replies, [reply]);
  timers.pop()!(); await turn(); watching();
  const count = received.length; answerResponse(Response.json({ replies: [reply] })); await turn();
  assert.equal(received.length, count, 'aborted voice history cannot reappear after account/meeting switch');
  timers.length = 0;
} finally { Object.assign(globalThis, original); }
console.log('Bot transcript: scoped history/drafts/edits, reconnect, denied access and cancellation PASS');

{
  const item={request_id:'00000000-0000-4000-8000-000000000001',text:'Theo web.',state:'completed',created_at_ms:1,
    answer_kind:'web',links:[{url:'https://redis.io/docs/',title:'Redis'}]};
  assert.deepEqual(voiceReplies([item])[0].links,item.links);
  for(const url of ['javascript:alert(1)','file:///tmp/secret','https://user:password@example.com'])
    assert.throws(()=>voiceReplies([{...item,links:[{url,title:'bad'}]}]));
}

// Voice evidence rejects unsafe source identities and preserves literal quotations.
{
  const { voiceSources } = await import('./voice-replies');
  const source = { id: 'ctx-' + 'b'.repeat(64), kind: 'document', path: 'wiki/demo.md', paragraph: 0, quote: '<script>not executable</script>' };
  assert.equal(voiceSources({ sources: [source], unavailable: 0 }).sources[0].quote, source.quote);
  assert.throws(() => voiceSources({ sources: [{ ...source, path: '../private.md' }], unavailable: 0 }));
  assert.throws(() => voiceSources({ sources: [{ ...source, quote: 'x'.repeat(1201) }], unavailable: 0 }));
  assert.throws(() => voiceSources({ sources: [{ id: 'ctx-' + 'a'.repeat(64), kind: 'transcript', quote: 'Missing segment' }], unavailable: 0 }));
  assert.throws(() => voiceReplies([{ request_id: '00000000-0000-4000-8000-000000000001', text: 'Answer', state: 'completed', created_at_ms: 1, source_count: 33 }]));
}

// The in-meeting panel stops only the Bot bound to the exact current meeting identity.
{
  const originalFetch = globalThis.fetch;
  let request: { url: string; options: RequestInit } | undefined;
  let responseBody: any = { configured: true, enabled: true, finished: false, publication_revision: 7,
    view: { id: 'copilot-notes', status: 'stale', doc: { notes: [
      { id: 'seg-1', text: 'Decision', speaker: 'Lan', chapter: 'Roadmap', t: 1760000000, stale: true, evidence: [{ segment_id: 'confirmed-1' }] },
      { id: 'seg-2', text: '', withdrawn: true },
      { id: '', text: 'missing ID' },
    ] } } };
  globalThis.fetch = (async (url: any, options: RequestInit = {}) => {
    request = { url: String(url), options };
    return Response.json(responseBody);
  }) as typeof fetch;
  try {
    const notes = await readBotProcessedNotes(config, 12);
    assert.equal(request?.url, 'http://127.0.0.1:28056/transcripts/by-id/12/processed-notes');
    assert.equal(request?.options.method, undefined, 'processed-notes is read-only');
    assert.equal((request?.options.headers as Record<string, string>)['Authorization'], 'Bearer fixture-secret');
    assert.equal(notes.status, 'stale');
    assert.equal(notes.publicationRevision, 7);
    assert.deepEqual(notes.notes, [
      { id: 'seg-1', segmentId: 'confirmed-1', text: 'Decision', speaker: 'Lan', chapter: 'Roadmap', t: 1760000000, stale: true, withdrawn: false },
      { id: 'seg-2', segmentId: 'seg-2', text: '', stale: false, withdrawn: true },
    ]);
    const recap = recapGroups([...notes.notes, { id: 'seg-3', text: 'Lan gửi demo.', chapter: 'Roadmap', t: 5, stale: false, withdrawn: false }]);
    assert.deepEqual(recap[0].notes.map(note => note.id), ['seg-3', 'seg-1']);
    assert.equal(recapText(recap), 'Roadmap\n- [0:05] Lan gửi demo.');

    const preview = { notes_preview: true, meeting_id: 12, claims: [{ text: 'Đã chốt lịch chạy thử.', source_ids: ['s0'] }],
      sources: [{ id: 's0', segment_id: 'seg-live', start_ms: 3000 }], coverage: { bounded: true } };
    const summary = notesPreview(preview, 12);
    assert.equal(summary.bounded, true);
    assert.equal(recapText(summary.groups), 'Ý chính\n- [0:03] Đã chốt lịch chạy thử.');
    assert.equal(summary.groups[0].notes[0].segmentId, 'seg-live');
    assert.throws(() => notesPreview(preview, 13), /không hợp lệ/);
    assert.throws(() => notesPreview({ ...preview, sources: [] }, 12), /chưa có nguồn/);
    responseBody = { id: 12, platform: 'teams', native_meeting_id: 'same-room',
      data: { summary: '  Đã chốt lịch.  ', metadata: { tina_summary: 'Cũ' } } };
    assert.equal(await readBotRecap(config, meeting), 'Đã chốt lịch.');
    assert.equal(request?.url, 'http://127.0.0.1:28056/meetings/12');
    responseBody.data = { metadata: { tina_summary: 'Recap cũ' } };
    assert.equal(await readBotRecap(config, meeting), 'Recap cũ');
    responseBody.id = 13;
    await assert.rejects(() => readBotRecap(config, meeting), /không khớp cuộc họp/);
    responseBody = { configured: false, enabled: false, finished: true, publication_revision: 0, view: null };
    assert.deepEqual(await readBotProcessedNotes(config, 12), {
      configured: false, enabled: false, finished: true, publicationRevision: 0, status: 'disabled', notes: [],
    }, 'disabled notes are reported without enabling processing');
    await assert.rejects(() => readBotProcessedNotes(config, 0), /Invalid meeting identity/);

    const requests: string[] = [];
    let detail = 'Not Found';
    globalThis.fetch = (async url => {
      requests.push(String(url));
      if (String(url).endsWith('/processed-notes')) return Response.json({ detail }, { status: 404 });
      return Response.json({ id: 12, status: 'completed', data: { processed: { views: [
        { id: 'copilot-notes', status: 'current', doc: { notes: [{ id: 'shared-note', text: 'Must not be fetched' }] } },
      ] } } });
    }) as typeof fetch;
    await assert.rejects(() => readBotProcessedNotes(config, 12), /Gateway chưa hỗ trợ processed-notes/);
    assert.equal(requests.length, 1, 'an older Gateway never falls back to a shareable transcript route');
    detail = 'Meeting 12 not found';
    requests.length = 0;
    await assert.rejects(() => readBotProcessedNotes(config, 12), /returned 404/);
    assert.equal(requests.length, 1, 'owner failures never fall back');
  } finally { globalThis.fetch = originalFetch; }
}

{
  const originalFetch = globalThis.fetch;
  let request: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    request = { url: String(input), init };
    return new Response('', { status: 202 });
  }) as typeof fetch;
  try {
    await stopBotMeeting(config, { platform: 'google_meet', nativeMeetingId: 'abc-defg/hij' });
    assert.equal(request?.url, 'http://127.0.0.1:28056/bots/google_meet/abc-defg%2Fhij');
    assert.equal(request?.init.method, 'DELETE');
    assert.equal(request?.init.credentials, 'omit');
    assert.equal(request?.init.redirect, 'error');
    assert.equal((request?.init.headers as Record<string, string>)['Authorization'], 'Bearer fixture-secret');
    assert.ok(!request?.url.includes('fixture-secret'));
  } finally { globalThis.fetch = originalFetch; }
}
