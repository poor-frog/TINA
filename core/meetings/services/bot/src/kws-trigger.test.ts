import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VoiceTrigger, invocation, turnPauseMs, type VoiceHypothesis} from './voice-trigger.js';

test('name calls with only polite particles do not become questions or broaden ASR-only activation', () => {
  for (const text of ['TINA ơi ạ', 'Tina à!', 'tin anh ơi, ạ.', 'TINA, ơi ạ…'])
    assert.equal(invocation(text), '', text);
  for (const text of ['ti nà ơi', 'hey tiên na', 'hey TINA ơi ạ']) assert.equal(invocation(text), null, text);
  assert.equal(invocation('TINA ơi, ạ ai phụ trách demo?'), 'ạ ai phụ trách demo?');
});

test('KWS name variants acknowledge while real questions and raw ASR remain intact', () => {
  const cases = [
    ['TINA ơi', ''], ['TINA ơi ạ', ''], ['ti nà ơi', ''], ['HEY TI NÀ ƠI', ''],
    ['hey tiên na', ''], ['hey tiên na ơi ạ', ''],
    ['Hey TINA, task này đã giao cho ai chưa?', 'task này đã giao cho ai chưa?'],
    ['ti nà ơi, ai phụ trách demo?', 'ai phụ trách demo?'],
    ['hey tiên na, có?', 'có?'], ['TINA ơi, dừng', 'dừng'],
    ['TINA ơi, ạ ai phụ trách demo?', 'ạ ai phụ trách demo?'],
    ['Hey, tìm tài liệu demo', 'Hey, tìm tài liệu demo'],
  ];
  for (const [text, expected] of cases) {
    let now = 5000; const trigger = new VoiceTrigger(() => now, [], true); trigger.reset(1000);
    assert(trigger.wake({channel: 1, startMs: 3000, endMs: 3800}));
    const h = {channel: 1, speakerKey: 's', startMs: 3000, endMs: 4400, text, final: true};
    trigger.feed(h); now += 350;
    assert.equal(trigger.question(4400), expected, text);
    assert.equal(h.text, text); assert.equal(trigger.heard?.text, text);
  }
  let now = 5000; const custom = new VoiceTrigger(() => now, ['hey trợ lý'], true); custom.reset(1000);
  assert(custom.wake({channel: 1, startMs: 3000, endMs: 3800}));
  custom.feed({channel: 1, speakerKey: 's', startMs: 3000, endMs: 4400, text: 'hey trợ lý ạ', final: true});
  now += 350; assert.equal(custom.question(4400), '');
});

test('fragmented acoustic wake phrases are cleaned after assembly without becoming a question',()=>{
  for(const [parts,expected] of [
    [['hey','TINA'],''],[['Hey,','TINA!'],''],[['ti','na','ơi'],''],[['TINA','ơi','ạ'],''],
    [['hây','ti','na'],''],[['hey','TINA','ai phụ trách demo?'],'ai phụ trách demo?'],
    [['Hey,','tìm tài liệu demo'],'Hey, tìm tài liệu demo'],
  ] as Array<[string[],string]>){
    let now=5000;const t=new VoiceTrigger(()=>now,[],true);t.reset(1000);
    assert(t.wake({channel:1,startMs:3000,endMs:3800}));
    parts.forEach((text,i)=>t.feed({channel:1,speakerKey:'s',startMs:3000+i*500,
      endMs:3500+i*500,text,final:true}));
    now+=350;assert.equal(t.question(3000+parts.length*500),expected,parts.join(' / '));
    assert.equal(t.heard?.text,parts.at(-1));
  }
});

test('KWS authorizes a same-channel ASR question without requiring an ASR name match', () => {
  let now = 5000; const t = new VoiceTrigger(() => now, [], true); t.reset(1000);
  const h: VoiceHypothesis = {channel: 2, participant: 'p', speakerKey: 's', startMs: 3000,
    endMs: 4400, text: 'Ai phụ trách demo?', final: true};
  assert.equal(t.feed({...h, text: 'TINA ơi ai phụ trách demo?'}), 'ignore');
  assert(t.wake({channel: 2, participant: 'p', startMs: 3000, endMs: 3800}));
  assert(t.active); assert.equal(t.channel, 2);
  assert.equal(t.feed({...h, channel: 3}), 'ignore');
  assert.equal(t.feed({...h, participant: 'someone-else'}), 'ignore');
  assert.equal(t.feed(h), 'wake'); now += 350;
  assert.equal(t.question(4400), h.text); assert.equal(t.answeringContinuation, false);
});

test('KWS prefix cleanup preserves raw ASR, accepts revisions and allows a standalone-name ack', () => {
  let now = 5000; const t = new VoiceTrigger(() => now, [], true);
  const h = {channel: 1, speakerKey: 's', startMs: 3000, endMs: 4400, text: 'tinh anh ơi, ai làm demo?', final: false};
  t.reset(1000); assert(t.wake({channel: 1, startMs: 3000, endMs: 3800}));
  assert.equal(t.feed(h), 'update'); assert.equal(t.feed({...h, text: 'hey ti na, ai phụ trách demo?', final: true}), 'wake');
  now += 350; assert.equal(t.question(4400), 'ai phụ trách demo?');
  assert.equal(h.text, 'tinh anh ơi, ai làm demo?');
  t.reset(1000); t.wake({channel: 1, startMs: 3000, endMs: 3800});
  t.feed({...h, text: 'anh ơi', final: true}); now += 350;
  assert.equal(t.question(4400), '');
});

test('Stop/rearm fences old KWS and ASR; pending acoustic turns expire without ASR', () => {
  let now = 5000; const t = new VoiceTrigger(() => now, [], true); t.reset(4000);
  assert(!t.wake({channel: 1, startMs: 2000, endMs: 3800}));
  assert(t.wake({channel: 1, startMs: 3000, endMs: 4500}));
  assert.equal(t.startMs, 4000);
  assert.equal(t.feed({channel: 1, speakerKey: 's', startMs: 3000, endMs: 4400, text: 'old question', final: true}), 'ignore');
  now += 20001; assert(t.expired()); t.reset(now);
  assert(!t.active); assert(!t.wake({channel: 1, startMs: 4000, endMs: 4500}));
});

test('an acoustic continuation cannot authorize another channel or an expired ASR name', () => {
  let now = 5000; const t = new VoiceTrigger(() => now, [], true);
  t.continueAfter(4000, {channel: 1, participant: 'p'});
  const h = {channel: 2, participant: 'other', speakerKey: 's', startMs: 4500, endMs: 5000,
    text: 'TINA ơi câu hỏi của người khác?', final: true};
  assert.equal(t.feed(h), 'ignore');
  now += 10001; assert(!t.hasContinuation);
  assert.equal(t.feed({...h, channel: 1, participant: 'p', startMs: now-100, endMs: now}), 'ignore');
});

test('missing ASR identity does not erase an acoustic call on the same channel, but a known conflict is refused', () => {
  let now=5000;const t=new VoiceTrigger(()=>now,[],true);t.reset(1000);
  assert(t.wake({channel:1,participant:'p',startMs:3000,endMs:3800}));
  const h={channel:1,speakerKey:'s',startMs:3000,endMs:4400,text:'Ai làm demo?',final:true};
  assert.equal(t.feed({...h,participant:'other'}),'ignore');
  assert.equal(t.feed(h),'wake');now+=350;assert.equal(t.question(4400),h.text);
});

test('post-answer continuation has an absolute deadline even after waiting for room quiet', () => {
  let now=1000;const t=new VoiceTrigger(()=>now,[],true);
  now=9000;t.continueAfter(1000,{channel:1,participant:'p'},16000);
  now=16001;
  assert(!t.hasContinuation);
  assert.equal(t.feed({channel:1,participant:'p',speakerKey:'s',startMs:15000,endMs:16000,
    text:'Còn deadline?',final:true}),'ignore');
});

test('a timely VAD onset reserves the caller reply while ASR finishes, with a bounded capture deadline', () => {
  let now=1000;const t=new VoiceTrigger(()=>now,[],true);
  const arm=()=>t.continueAfter(1000,{channel:1,participant:'p'},6000);
  const h={channel:1,participant:'p',speakerKey:'s',startMs:5500,endMs:6500,text:'Backend.',final:true};
  arm();now=5500;
  assert(!t.continuationSpeech(2,'p',5500));assert(!t.continuationSpeech(1,'other',5500));
  assert(!t.continuationSpeech(1,undefined,5500));assert(!t.continuationSpeech(1,'p',999));
  assert(t.continuationSpeech(1,'p',5500));now=7000;
  assert.equal(t.takeExpiredContinuation(),undefined);assert(t.hasContinuation);
  assert.equal(t.feed({...h,participant:'other'}),'ignore');
  assert.equal(t.feed(h),'wake');now=7350;assert.equal(t.question(6500),'Backend.');
  now=1000;arm();now=5500;t.continuationSpeech(1,'p',5500);now=25501;
  assert(t.takeExpiredContinuation());assert.equal(t.feed(h),'ignore');
  now=1000;arm();now=6001;assert(!t.continuationSpeech(1,'p',5500));
  assert.equal(t.feed(h),'ignore');
  now=1000;arm();now=5500;t.continuationSpeech(1,'p',5500);t.reset();
  assert(!t.hasContinuation);
});

test('unfinished requests wait for thought pauses, complete questions and clarification replies do not', () => {
  for(const text of ['Tóm tắt giúp tôi', 'Ngân sách của…', 'Hạn demo và', 'Tell me about', 'Ý tôi là']) assert.equal(turnPauseMs(text),2000);
  for(const text of ['Ai phụ trách demo?', 'Production.', 'Tóm tắt ngân sách.', 'Hạn demo là khi nào?']) assert.equal(turnPauseMs(text),0);
  let now=2200;const t=new VoiceTrigger(()=>now);t.reset(0);
  const first={channel:0,speakerKey:'s',startMs:1000,endMs:1500,text:'TINA ơi tóm tắt giúp tôi',final:true};
  t.feed(first);assert.equal(t.question(1500),null);
  t.feed({...first,startMs:1600,endMs:2100,text:'phần ngân sách',final:true});now=2500;
  assert.equal(t.question(2100),'tóm tắt giúp tôi phần ngân sách');
  t.reset(0);now=2200;t.feed(first);now=3501;
  assert.equal(t.question(1500),'tóm tắt giúp tôi','incomplete speech still has a bounded wait');
});
