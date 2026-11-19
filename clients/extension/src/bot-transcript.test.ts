import assert from 'node:assert/strict';
import { botBase, botSegments, listBotMeetings, watchBotTranscript } from './bot-transcript';
import { voiceReplies,voiceSources } from './voice-replies';

const config = { botGatewayUrl: 'http://127.0.0.1:28056', apiKey: 'fixture-secret' };
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

const original = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
const calls: { url: string; options: RequestInit }[] = [], timers: (() => void)[] = [];
let respond = () => Promise.resolve(Response.json(doc())), updates: string[] = [], errors: boolean[] = [];
globalThis.fetch = (async (url: any, options: any) => { calls.push({ url: String(url), options }); return respond(); }) as typeof fetch;
globalThis.setTimeout = ((fn: () => void) => { timers.push(fn); return timers.length; }) as any;
globalThis.clearTimeout = (() => {}) as any;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
try {
  respond = async () => Response.json({ meetings: [{ id: 12, platform: 'teams', native_meeting_id: 'same-room', status: 'active',
    data:{join_failure_summary:'Platform refused the bot.'} }, { id: 13, platform: 'note', native_meeting_id: 'note' }] });
  const listed=await listBotMeetings(config);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].joinFailureSummary,'Platform refused the bot.');
  assert.equal(calls[0].options.headers!['X-API-Key' as keyof HeadersInit], 'fixture-secret');
  assert.equal(calls[0].options.redirect, 'error');
  assert.ok(calls.every(call => !call.url.includes('fixture-secret')));
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
  old(); release(Response.json(doc())); await turn();
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
