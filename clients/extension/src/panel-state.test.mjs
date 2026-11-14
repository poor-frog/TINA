import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import vm from 'node:vm';

let selection = null;
const textWaiters = new Set();
class Element {
  constructor() {
    this._text='';this.textWrites=0;this.innerHTML='';this.style={};this.dataset={};this.value='';this.listeners={};
    this.children=[];this.parentElement=null;this.hidden=false;this.scrollTop=0;this.scrollHeight=2000;this.clientHeight=400;
    const classes=new Set();this.classList={add(...names){names.forEach(name=>classes.add(name));},
      remove(...names){names.forEach(name=>classes.delete(name));},contains(name){return classes.has(name);},
      toggle(name){if(classes.has(name)){classes.delete(name);return false;}classes.add(name);return true;}};
  }
  get childNodes(){return this.children;}
  contains(node){for(let current=node;current;current=current.parentElement)if(current===this)return true;return false;}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set textContent(value){
    this._text=value;this.textWrites++;this.replaceChildren();
    for(const notify of textWaiters)notify(this,String(value));
  }
  setAttribute(name,value){this[name]=value;}
  addEventListener(type,fn){this.listeners[type]=fn;}
  append(...nodes){for(const node of nodes)this.insertBefore(node,null);}
  insertBefore(node,before){node.remove();const index=before?this.children.indexOf(before):this.children.length;this.children.splice(index,0,node);node.parentElement=this;}
  remove(){if(this.parentElement){if(selection&&this.contains(selection.anchorNode)){selection.anchorNode=this.parentElement;selection.focusNode=this.parentElement;selection.anchorOffset=0;selection.focusOffset=0;}const list=this.parentElement.children;list.splice(list.indexOf(this),1);this.parentElement=null;}}
  replaceChildren(...nodes){for(const child of [...this.children])child.remove();this.append(...nodes);}
  get lastElementChild(){return this.children.at(-1);}
  get isConnected(){return !!this.parentElement;}
  getBoundingClientRect(){return {top:0,bottom:24};}
}
const elements = new Map(), sockets = [], messages = [], intervals = [], opened = [];
const element = id => {if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
function waitForTranscriptText(expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const notify = (_element, value) => {
      if (value.trim() !== expected) return;
      clearTimeout(timeout);
      textWaiters.delete(notify);
      resolve();
    };
    const timeout = setTimeout(() => {
      textWaiters.delete(notify);
      reject(new Error(`Timed out waiting for transcript text: ${expected}`));
    }, timeoutMs);
    textWaiters.add(notify);
  });
}
element('feed').append(element('emptyState'),element('transcriptTurns'));
let configFails = true, gatewayFails = false, releaseHistory, historyResponse;
let historyRequests=0;
let botStatus = 200;
const botDocument = (id = 12, text = 'Bot says hello · Chào mọi người') => ({ id, platform: 'teams', native_meeting_id: 'same-room', start_time: '2026-10-30T01:00:00Z', status: 'active', segments: [{segment_id:'bot-one',text,speaker:'Hà',start:2,end:4,completed:true,revision:1}] });
const historyGate = new Promise(r => releaseHistory = r);
class Socket {
  static OPEN = 1; static CONNECTING = 0;
  constructor(url) { this.url = url; this.readyState = 1; sockets.push(this); }
  send() {} close() { this.readyState = 3; this.onclose?.(); }
}
const context = { document: { getSelection: () => selection, createElement: () => new Element(), getElementById: element, documentElement: { setAttribute() {} } },
  window: { matchMedia: () => ({ matches: false, addEventListener() {} }) }, console, URL, Date, WebSocket: Socket, AbortSignal, AbortController, setTimeout, clearTimeout,
  setInterval: (fn,ms) => {intervals.push({fn,ms});return 0;},
  chrome: { storage: { local: { get: async () => ({ apiKey: 'synthetic-key', theme: 'system' }), set: async () => {} } },
    tabs: { create: details => opened.push(details.url) },
    runtime: { getURL: p => 'chrome-extension://review/' + p, onMessage: { addListener() {} }, sendMessage: async m => {messages.push(m);return ({ state: { status: 'idle', platform: null, nativeMeetingId: null, meetingId: null, streams: 0, error: null } });} } },
  fetch: async url => {
    if (url.includes('build-stamp')) return Response.json({ human: 'test' });
    if (url.endsWith('/transcription/config')) return configFails ? new Response('', { status: 503 }) : Response.json({ backend: 'funasr', label: 'Qwen', source: 'platform', configured: true });
    if (url.endsWith('/bots')) { if (gatewayFails) throw Error('offline'); return Response.json({ meetings: [] }); }
    if (url.includes('/meetings?')) return Response.json({meetings:[12,13].map(id=>({id,platform:'teams',native_meeting_id:'same-room',status:'active',start_time:'2026-10-30T01:00:00Z'}))});
    if (url.includes('/transcripts/by-id/')) return botStatus === 200 ? Response.json(botDocument(Number(url.split('/').at(-1)))) : new Response('',{status:botStatus});
    if (url.includes('/transcripts/')) { historyRequests++; if(historyResponse)return historyResponse(); await historyGate; return Response.json({ segments: [{ segment_id: 'one', text: 'older', start: 1792431211, end: 1792431212, completed: true }] }); }
    throw Error('Unexpected URL');
  } };
const source = readFileSync(new URL('./sidepanel.ts', import.meta.url), 'utf8') + '\nglobalThis.probe={applyState,refreshTranscription,verifyConnection,toBrickSeg,segments:()=>mgr.getSegments(),setTranscriptSource,configureBot(){cfg.botGatewayUrl="http://127.0.0.1:28056";cfg.terminalUrl="http://127.0.0.1:23000"},renderSegments(rows){txSegs=mgr.bootstrap(rows.map(toBrickSeg));renderFeed()}};';
const result = await build({ stdin: { contents: source, loader: 'ts', resolveDir: new URL('.', import.meta.url).pathname }, bundle: true, write: false, platform: 'browser', format: 'iife' });
vm.createContext(context); vm.runInContext(result.outputFiles[0].text, context);
const turn = () => new Promise(r => setImmediate(r));
await turn(); await turn();
const { probe } = context;
await probe.refreshTranscription();
const failure = element('asrBackend').textContent;
assert.ok(failure.includes('settings unavailable'));
probe.applyState({ status: 'idle', platform: null, nativeMeetingId: null, meetingId: null });
assert.equal(element('asrBackend').textContent, failure, 'polling cannot overwrite the ASR error');
const segment = probe.toBrickSeg({ start: 1792431211, end: 1792431213 });
assert.equal(segment.absolute_start_time, '2026-10-19T17:33:31.000Z');
assert.equal(Date.parse(segment.absolute_end_time) - Date.parse(segment.absolute_start_time), 2000);
configFails = false; await probe.refreshTranscription(); assert.ok(element('asrBackend').textContent.includes('Qwen'));
await probe.verifyConnection(); assert.equal(element('connText').textContent, 'Gateway connected');
gatewayFails = true; await probe.verifyConnection(); assert.equal(element('connText').textContent, 'Gateway unreachable');

probe.applyState({ status: 'capturing', sessionId: 'new', startedAt: 1792431211000, platform: 'google_meet', nativeMeetingId: 'meeting', meetingId: 1, transcription: { label: 'Qwen' } });
let socket = sockets.at(-1); socket.onopen();
socket.onmessage({ data: JSON.stringify({ type: 'transcript', meeting: 'google_meet/meeting', confirmed: [{ segment_id: 'one', text: 'newer', start: 1792431211, end: 1792431212, completed: true }] }) });
socket.onmessage({ data: JSON.stringify({ type: 'transcript', meeting: 'google_meet/other', confirmed: [{ segment_id: 'foreign', text: 'wrong meeting', start: 1792431211, end: 1792431212, completed: true }] }) });
releaseHistory(); await turn();
assert.equal(probe.segments().length, 1); assert.equal(probe.segments()[0].text, 'newer', 'WS changes after the REST snapshot must win');
assert.equal(element('apiKey').disabled, true);
socket.onmessage({ data: JSON.stringify({ type: 'health', meeting: 'google_meet/meeting', source: 'stt', kind: 'unavailable', detail: 'ASR is unavailable' }) });
assert.ok(element('asrBackend').textContent.includes('ASR is unavailable'));
socket.onmessage({ data: JSON.stringify({ type: 'transcript', meeting: 'google_meet/meeting', confirmed: [], pending: [] }) });
assert.ok(element('asrBackend').textContent.includes('ASR is unavailable'), 'empty pending snapshots cannot hide an ASR failure');
// Stable DOM, readable drafts and a reader-controlled scroll position.
const live={status:'capturing',sessionId:'new',platform:'google_meet',nativeMeetingId:'meeting',meetingId:1};
const root=element('transcriptTurns'), feed=element('feed'), latest=element('latestBtn');
const turnRow=root.children[0], confirmed=turnRow.children[1], stableSpan=confirmed.children[0];
const writes=stableSpan.textWrites;
probe.applyState(live);assert.equal(root.children[0],turnRow);assert.equal(stableSpan.textWrites,writes,'status polls do not rewrite confirmed text');
probe.applyState({...live,paused:true});assert.equal(root.children[0],turnRow);assert.ok(element('captureNoticeText').textContent.includes('tạm dừng'));
probe.applyState(live);
feed.scrollTop=100;feed.listeners.scroll();
socket.onmessage({data:JSON.stringify({type:'transcript',meeting:'google_meet/meeting',speaker:'Hà',pending:[{segment_id:'draft',speaker:'Hà',text:'Bản nháp tiếng Việt',start:1792431214,end:1792431215}]})});
assert.equal(feed.scrollTop,100,'new speech never yanks a reader back to the bottom');assert.equal(latest.hidden,false);
assert.equal(root.children[0],turnRow);assert.equal(confirmed.children[0],stableSpan);
const draftTurn=root.children.at(-1),draftBox=draftTurn.children[2],draftSpan=draftBox.children[1].children[0];
assert.equal(draftBox.hidden,false);assert.equal(draftBox.children[0].textContent,'Đang nhận dạng…');
socket.onmessage({data:JSON.stringify({type:'transcript',meeting:'google_meet/meeting',speaker:'Hà',confirmed:[{segment_id:'draft',speaker:'Hà',text:'Câu đã chốt tiếng Việt.',start:1792431214,end:1792431215,completed:true}],pending:[]})});
assert.equal(draftTurn.children[1].children[0],draftSpan,'finalization promotes the existing span');assert.equal(draftBox.hidden,true);
latest.listeners.click();assert.equal(feed.scrollTop,feed.scrollHeight);assert.equal(latest.hidden,true);
// Canonical refreshes are scoped, serialized and independent from the draft lane.
const rawDraft={segment_id:'draft',speaker:'Hà',text:'Câu đã chốt tiếng Việt.',start:1792431214,end:1792431215,completed:true};
const baseRows=[{segment_id:'one',text:'newer',start:1792431211,end:1792431212,completed:true},rawDraft];
const snapshot=(text,revision)=>Response.json({id:1,platform:'google_meet',native_meeting_id:'meeting',segments:[baseRows[0],{...rawDraft,text,revision}]});
const revision=(number,extra={})=>socket.onmessage({data:JSON.stringify({version:'transcript-revision.v1',type:'transcript.revised',platform:'google_meet',native_meeting_id:'meeting',meeting_id:1,segment_id:'draft',revision:number,kind:'manual',...extra})});
const draftText=()=>probe.segments().find(s=>s.segment_id==='draft')?.text;
socket.onmessage({data:JSON.stringify({type:'transcript',meeting:'google_meet/meeting',speaker:'Minh',pending:[{segment_id:'forming',speaker:'Minh',text:'I will review the metrics.',start:1792431218,end:1792431220}]})});
feed.scrollTop=100;feed.listeners.scroll();
historyResponse=()=>snapshot('Câu chủ cuộc họp đã sửa.',1);
const beforeForeign=historyRequests;
revision(1,{native_meeting_id:'other'});revision(1,{platform:'zoom'});revision(1,{meeting_id:99});
assert.equal(historyRequests,beforeForeign,'foreign revisions cannot fetch or touch this meeting');
revision(1);await turn();assert.equal(draftText(),'Câu chủ cuộc họp đã sửa.');
assert.ok(probe.segments().some(s=>s.segment_id==='forming'),'canonical refresh preserves unrelated drafts');
assert.equal(feed.scrollTop,100);assert.equal(confirmed.children[0],stableSpan,'canonical refresh preserves unchanged DOM/selection anchors');
const afterEdit=historyRequests;revision(1);revision(0);await turn();assert.equal(historyRequests,afterEdit,'duplicate and old notices are ignored');
socket.onmessage({data:JSON.stringify({type:'transcript',meeting:'google_meet/meeting',speaker:'Hà',confirmed:[{...rawDraft,text:'late raw ASR'}],pending:[{...rawDraft,text:'stale forming tail'}]})});
assert.equal(draftText(),'Câu chủ cuộc họp đã sửa.');
assert.equal(probe.segments().filter(s=>s.segment_id==='draft').length,1,'stale ASR draft cannot duplicate an edited segment');
let responses=[];historyResponse=()=>new Promise(resolve=>responses.push(resolve));
revision(2);socket.onmessage({data:JSON.stringify({type:'transcript',confirmed:'malformed'})});revision(3);assert.equal(responses.length,1,'only one canonical request runs at a time');
responses.shift()(snapshot('Intermediate revision',2));await turn();assert.equal(responses.length,1,'a notice during refresh triggers another snapshot');
responses.shift()(snapshot('Latest owner revision',3));await turn();assert.equal(draftText(),'Latest owner revision');
historyResponse=()=>snapshot('Old HTTP snapshot',1);revision(4,{kind:'alignment'});await turn();
assert.equal(draftText(),'Latest owner revision','an older snapshot cannot roll back accepted canonical text');
historyResponse=()=>snapshot(rawDraft.text,4);revision(5,{kind:'restore'});await turn();assert.equal(draftText(),rawDraft.text);
socket.onmessage({data:JSON.stringify({type:'transcript',meeting:'google_meet/meeting',speaker:'Hà',confirmed:[{...rawDraft,text:'late raw after Restore'}]})});
assert.equal(draftText(),rawDraft.text,'Restore is a protected revision too');
historyResponse=()=>new Response('',{status:503});revision(6);await turn();
assert.equal(draftText(),rawDraft.text);assert.ok(element('feedStatus').textContent.includes('chưa đồng bộ'));
probe.applyState(live);assert.ok(element('feedStatus').textContent.includes('chưa đồng bộ'),'status polling cannot hide an unsynchronized canonical snapshot');
const recovered=waitForTranscriptText('Recovered canonical refresh');
historyResponse=()=>snapshot('Recovered canonical refresh',5);
await recovered;
assert.equal(draftText(),'Recovered canonical refresh','failed refresh retries even if no further event arrives');
const retired=socket;retired.close();historyResponse=()=>snapshot('Edit missed while disconnected',6);
probe.applyState(live);socket=sockets.at(-1);socket.onopen();await turn();
assert.equal(draftText(),'Edit missed while disconnected','reconnect loads the canonical snapshot even without an event');
assert.ok(probe.segments().some(s=>s.segment_id==='forming'),'reconnect preserves the separate draft lane');
const speakerNotice={version:'speaker-revision.v1',type:'speaker.revised',platform:'google_meet',native_meeting_id:'meeting',meeting_id:1,speaker_id:'voice-one',revision:1};
const renamed=()=>Response.json({id:1,platform:'google_meet',native_meeting_id:'meeting',segments:[baseRows[0],{...rawDraft,speaker:'An',text:'Edit missed while disconnected',revision:6}]});
historyResponse=renamed;
const beforeSpeaker=historyRequests;
socket.onmessage({data:JSON.stringify({...speakerNotice,native_meeting_id:'other'})});
assert.equal(historyRequests,beforeSpeaker,'foreign speaker revisions cannot read another meeting');
socket.onmessage({data:JSON.stringify(speakerNotice)});await turn();
assert.equal(probe.segments().find(s=>s.segment_id==='draft')?.speaker,'An');
socket.onmessage({data:JSON.stringify({type:'transcript',meeting:'google_meet/meeting',confirmed:[{...rawDraft,speaker:'An',text:'late raw after rename'}]})});
assert.equal(draftText(),'Edit missed while disconnected','speaker-only ticks cannot replace accepted text');
assert.ok(probe.segments().some(s=>s.segment_id==='forming'),'speaker-only ticks preserve unrelated drafts');
assert.ok(probe.segments().some(s=>s.segment_id==='one'),'partial final ticks preserve unrelated confirmed segments');
assert.equal(root.children[0],turnRow,'speaker refresh preserves unrelated DOM and selection anchors');
retired.onmessage({data:JSON.stringify({type:'transcript',meeting:'google_meet/meeting',confirmed:[{...rawDraft,text:'retired callback'}]})});
assert.equal(draftText(),'Edit missed while disconnected');
socket.onmessage({data:JSON.stringify({type:'transcript',meeting:'google_meet/meeting',speaker:'Minh',confirmed:[],pending:[]})});
probe.applyState({...live,status:'no-signal'});assert.equal(root.children[0],turnRow);
probe.applyState({...live,status:'error',error:'Mic disconnected'});assert.equal(root.children[0],turnRow);assert.equal(element('captureNoticeText').textContent,'Mic disconnected');
probe.applyState({...live,status:'stopping'});assert.equal(root.children[0],turnRow);
probe.applyState({...live,status:'idle',sessionId:null,meetingId:null});
assert.equal(probe.segments().length,2,'Stop retains transcript and session display identity');assert.equal(root.children[0],turnRow);
assert.ok(element('captureNoticeText').textContent.includes('Đã dừng'));
socket.onmessage({data:JSON.stringify({type:'transcript',meeting:{id:1},speaker:'Hà',confirmed:[{segment_id:'last',speaker:'Hà',text:'Final flush after Stop',start:1792431216,end:1792431217,completed:true}],pending:[]})});
assert.ok(probe.segments().some(s=>s.segment_id==='last'),'final server flush remains visible after Stop');
historyResponse=()=>new Promise(resolve=>responses.push(resolve));revision(7);
probe.applyState({...live,sessionId:'next'});assert.equal(root.children.length,0,'a new capture clears the retained view');
socket.onmessage({data:JSON.stringify({type:'transcript',meeting:'google_meet/meeting',confirmed:[{segment_id:'stale',text:'stale socket',start:1792431218,end:1792431219}]})});
assert.equal(probe.segments().length,0,'retired socket cannot refill a new capture');
responses.shift()(snapshot('Wrong session HTTP',7));await turn();assert.equal(probe.segments().length,0,'retired HTTP response cannot refill a new capture');
historyResponse=()=>snapshot(rawDraft.text,0);
probe.applyState({status:'error',sessionId:'pending',platform:'google_meet',nativeMeetingId:'meeting',pendingAudioFrames:3,error:'Audio still queued',swBuild:'old',diskBuild:'new'});
assert.equal(element('toggleBtn').textContent,'Retry audio delivery','stale build cannot hide the retry control');
assert.equal(element('apiKey').disabled,true,'pending audio keeps endpoint credentials pinned');
await element('toggleBtn').listeners.click(); assert.equal(messages.at(-1).type,'RETRY_AUDIO');
await intervals.find(t=>t.ms===2000).fn(); assert.notEqual(messages.at(-1).type,'RELOAD_NOW','pending audio blocks auto-reload');
const grouped=['a','b','c'].map((id,index)=>({segment_id:id,speaker:'Hà',text:id.repeat(130),start:1792431211+index,end:1792431212+index,completed:true}));
probe.renderSegments(grouped);
const selectedSpan=root.children[0].children[1].children[2];
selection={rangeCount:1,anchorNode:selectedSpan,focusNode:selectedSpan,anchorOffset:0,focusOffset:0,setBaseAndExtent(anchor,anchorOffset,focus,focusOffset){Object.assign(this,{anchorNode:anchor,anchorOffset,focusNode:focus,focusOffset});}};
probe.renderSegments([{...grouped[0],text:'Longer accepted correction. '.repeat(16)},grouped[1],grouped[2]]);
assert.equal(selection.anchorNode,selectedSpan,'paragraph regrouping restores selection to the unchanged segment');
selection=null;
console.log('PASS panel: canonical edit/Restore/retry/reconnect, stale ASR and event isolation, stable DOM/selection, scroll follow, pending→final, Pause/Stop retention, final flush, new-session isolation, timestamps and REST/WS recovery');

probe.applyState({status:'idle',platform:null,nativeMeetingId:null,meetingId:null});
probe.configureBot(); probe.setTranscriptSource('bot'); await turn(); await turn();
assert.equal(element('botMeeting').children.length, 3, 'exact rows on the same URL remain separate choices');
element('botMeeting').value='12'; element('botMeeting').listeners.change();
const countMessages = messages.length;
const viewed = waitForTranscriptText('Bot says hello · Chào mọi người');
await element('toggleBtn').listeners.click(); await viewed;
assert.equal(element('stopBtn').textContent,'Ngừng xem');
probe.applyState({status:'idle',platform:null,nativeMeetingId:null,meetingId:null});
assert.ok(element('transcriptTurns').textContent.includes('Bot says hello'));
element('dashBtn').listeners.click(); assert.equal(opened.at(-1),'http://127.0.0.1:23000/meetings/12');
element('stopBtn').listeners.click();
assert.equal(messages.length, countMessages, 'Watch/unwatch never sends capture START/STOP');
assert.ok(element('transcriptTurns').textContent.includes('Bot says hello'), 'unwatch retains the last transcript');
botStatus=403; await element('toggleBtn').listeners.click(); await turn();
assert.equal(element('transcriptTurns').children.length,0,'access revocation clears private transcript');
assert.ok(element('botNotice').textContent.includes('403'));
assert.equal(messages.length,countMessages);
probe.setTranscriptSource('capture');
assert.equal(element('stopBtn').textContent,'■ Stop','local capture restores its Stop label');
console.log('PASS Bot panel: row isolation, background STATUS isolation, Terminal link, unwatch retention, denied-access clearing and no capture control');
