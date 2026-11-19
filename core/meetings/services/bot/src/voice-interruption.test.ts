import assert from 'node:assert/strict';
import {test} from 'node:test';
import {VoiceInterruption,mergeVoiceRefinement} from './voice-interruption.js';

const frame={channel:2,participant:'p',speakerKey:'s',startMs:2000,endMs:2500,text:'Khoan, ý tôi là tuần sau.',final:true};
test('task refinements are explicit, same-caller and opt in to intent recognition',()=>{
  const value={...frame,text:'Chỉ lấy phần backend thôi.'};
  assert.equal(new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000).feed(value,''),null);
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  for(const patch of [{participant:'other'},{participant:undefined},{channel:3},{text:'ừ'},
    {text:'backend đang bị lỗi'},{startMs:100,endMs:500}])assert.equal(guard.feed({...value,...patch},'',true),null);
  const result=guard.feed(value,'',true);assert.equal(result?.refinement,true);
  assert.equal(result?.question,value.text);
  assert.equal(guard.feed(value,value.text,true),null);
  assert.equal(mergeVoiceRefinement('Tổng hợp quyết định cuộc họp.',value.text),
    'Tổng hợp quyết định cuộc họp.\nYêu cầu cập nhật: Chỉ lấy phần backend thôi.');
  assert.equal(mergeVoiceRefinement('x'.repeat(2000),value.text),null);
  for(const question of ['Tìm web về Kubernetes','Search the web for Kubernetes','Kiến thức chung: Kubernetes', 'JWT là gì?'])
    assert.equal(mergeVoiceRefinement(question,value.text),null);
});
test('only a fresh explicit same-caller command interrupts; backchannels and quoted playback do not',()=>{
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  for(const patch of [{channel:3},{participant:'other'},{participant:undefined},{text:'ừ'},{text:'đúng rồi'},
    {text:'mọi người dừng lại kiểm tra nhé'},{startMs:1000,endMs:1400},{endMs:NaN}]){
    assert.equal(guard.feed({...frame,...patch},'Lan phụ trách demo.'),null);
  }
  assert.equal(guard.feed({...frame,text:'Khoan một chút.'},'Khoan một chút.'),null);
  const before=structuredClone(frame),command=guard.feed(frame,'Lan phụ trách demo.');
  assert.equal(command?.question,'ý tôi là tuần sau.');assert(command?.resume);
  assert.deepEqual(frame,before);
});
test('draft commands need agreement, and old ASR windows require valid fresh segment spans',()=>{
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  assert.equal(guard.feed({...frame,final:false},''),null);
  assert(guard.feed({...frame,final:false},'')?.resume);
  const next=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  const old={text:'Câu hỏi cũ.',startMs:100,endMs:1000},fresh={text:'Dừng lại.',startMs:2000,endMs:2500};
  const value={...frame,startMs:0,text:old.text+' '+fresh.text,segments:[old,fresh]};
  assert.equal(next.feed({...value,segments:undefined},''),null);
  assert.equal(next.feed({...value,segments:[old,{...fresh,text:'khác'}]},''),null);
  assert.equal(next.feed(value,'')?.resume,false);
});
test('corrections preserve their intent, too-short and stale commands cannot stop speech',()=>{
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  assert.equal(guard.feed({...frame,endMs:2050},''),null);
  assert.equal(guard.feed({...frame,text:'Ý tôi là bản production.'},'')?.question,'Ý tôi là bản production.');
});
test('a genuine short stop is accepted even when playback mentions the stop command',()=>{
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  assert.equal(guard.feed({...frame,text:'Dừng lại.'},'Bạn có thể nói dừng lại để ngắt TINA.')?.resume,false);
});

test('speaking accepts stable substantive corrections, but never short confirmations or noise-like snippets',()=>{
  for(const text of ['Không phải sprint này, sprint trước.', 'Không, ý tôi là sprint trước.',
    'Ý mình là phần backend.', 'Chỉ lấy phần backend thôi.', 'Cho tôi hỏi ai làm demo?']){
    const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
    assert(guard.feed({...frame,text},'',true,true)?.resume,text);
  }
  for(const text of ['ừ','ừ đúng rồi','đúng rồi','okay','yes','vâng','à','Tiếng rè nền','Backend bị lỗi', 'Thêm']){
    assert.equal(new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000).feed({...frame,text},'',true,true),null,text);
  }
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>3000);
  const text='Chỉ lấy phần backend thôi.';
  assert.equal(guard.feed({...frame,text,endMs:2200},'',true,true),null);
  assert.equal(guard.feed({...frame,text,final:false},'',true,true),null);
  assert.equal(guard.feed({...frame,text,final:false},'',true,true),null);
  assert(guard.feed({...frame,text,final:true},'',true,true)?.refinement);
});

test('recent playback remains an echo fence after a sentence change and expires without extending from echoes',()=>{
  let now=3000;
  const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>now);
  const echo='Ý mình là phần backend.';
  guard.observePlayback(echo);
  now+=100;
  assert.equal(guard.feed({...frame,text:echo},'Một câu khác.',true,true),null);
  now+=1900;
  assert(guard.feed({...frame,startMs:4000,endMs:4500,text:echo},'',true,true)?.refinement);
});

test('bare pause opens a continuation and a stop remains terminal throughout the full voice turn budget',()=>{
  let now=1000;const guard=new VoiceInterruption({channel:2,participant:'p'},1500,()=>now);
  const stop=new VoiceInterruption({channel:2,participant:'p'},1500,()=>now);
  now+=250000;
  const value={...frame,startMs:now-600,endMs:now-100};
  assert.equal(guard.feed({...value,text:'Đợi một chút.'},'',true,true)?.question,'');
  assert.equal(stop.feed({...value,text:'TINA dừng.'},'',true,true)?.resume,false);
});
