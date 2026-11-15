import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {SettingsDialog} from '../settings';
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
const services={wake:{method:'livekit_wakeword',engine:'LiveKit WakeWord',version:'2.1.1',device:'cpu',status:'no_active_bot',
  sessions:[] as Array<{meeting_id:number;status:string}>,names:['TINA ơi','hey TINA'],platforms:['google_meet']},voice_pipeline_configured:true,default_prepare_new_bots:true,
  new_meeting_policy:{enabled:true,include_transcript:true,documents:[],revision:0,wake_variants:[],noise_suppression:true,
    allow_general_knowledge:true,allow_web_search:true,engine:'livekit'},
  noise_filter:{id:'dtln',label:'DTLN',device:'cpu',ready:true},
  tts:{configured:true,ready:true,busy:false,model:'vieneu-v3-turbo',voice:'Trúc Ly',device:'cpu',profiles_supported:true,
    voices:[{id:'Trúc Ly',label:'Trúc Ly',region:'Bắc'},{id:'Mai Anh',label:'Mai Anh',region:'Bắc'}]}};

it('saves voice, pronunciations and the new-bot default atomically for this account',async()=>{
  const requests:Array<{url:string;body:any}>=[];
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>{
    const url=String(input),body=options?.body?JSON.parse(options.body as string):null;
    if(options?.method==='PUT'){requests.push({url,body});return Response.json(body);}
    if(url==='/api/user/voice')return Response.json({prepare_new_bots:null,speech_voice:'auto',pronunciations:{}});
    if(url==='/api/bots/voice/services')return Response.json(services);
    if(url==='/api/user/transcription')return Response.json({effective:{label:'VieGem'}});
    return new Response('',{status:404});
  }));
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  const voice=await screen.findByLabelText('Voice preset');
  await waitFor(()=>expect((voice as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(voice,{target:{value:'Mai Anh'}});
  fireEvent.click(screen.getByText('Pronunciations'));
  fireEvent.change(screen.getByLabelText('Default for new Google Meet bots'),{target:{value:'off'}});
  fireEvent.change(screen.getByLabelText('Pronunciation overrides'),{target:{value:'PostgreSQL = pốt gờ rét'}});
  fireEvent.click(screen.getByRole('tab',{name:'Meeting'}));
  expect(screen.getByText('Unsaved changes')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab',{name:'Voice'}));
  expect((screen.getByLabelText('Voice preset') as HTMLSelectElement).value).toBe('Mai Anh');
  fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
  await waitFor(()=>expect(requests).toContainEqual({url:'/api/user/voice',body:{prepare_new_bots:false,speech_voice:'Mai Anh',pronunciations:{PostgreSQL:'pốt gờ rét'}}}));
  expect(requests).toHaveLength(1);
  await waitFor(()=>expect(screen.getByRole('button',{name:'Save changes'}).hasAttribute('disabled')).toBe(true));
});

it('Settings exposes local KWS, question ASR and actual TTS metadata; saving only updates this account default',async()=>{
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json(init?.method==='PUT'?JSON.parse(init.body as string):{prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({effective:{label:'VieGem + LM'}});
    if(path==='/api/bots/voice/services')return Response.json(services);
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);
  fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');
  fireEvent.click(screen.getByRole('tab',{name:'Behavior'}));fireEvent.click(screen.getByText('Technical details'));
  expect(screen.getByText(/Questions use VieGem \+ LM/)).toBeTruthy();
  expect(screen.getByText(/LiveKit WakeWord 2.1.1/)).toBeTruthy();
  expect(screen.getByText('Audio filter: DTLN · CPU')).toBeTruthy();
  expect(screen.getByText(/No active bot/)).toBeTruthy();
  expect(screen.getByText('TINA ơi')).toBeTruthy();expect(screen.getByText('hey TINA')).toBeTruthy();
  const defaults=within(screen.getByRole('region',{name:'New meeting defaults'}));
  expect(defaults.getByText('LiveKit Agents')).toBeTruthy();
  expect(defaults.getAllByText('On')).toHaveLength(4);
  expect(screen.queryByLabelText('Active meeting')).toBeNull();
  expect(screen.queryByText('Meeting overrides (optional)')).toBeNull();
  fireEvent.click(screen.getByRole('tab',{name:'Meeting'}));
  const sources=within(screen.getByRole('region',{name:'Meeting sources'}));
  expect(sources.getByText('Approved tasks and decisions')).toBeTruthy();
  expect(sources.getByText('Other meeting transcripts · up to 4')).toBeTruthy();
  expect(sources.getByText('No active Google Meet bot')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab',{name:'Behavior'}));
  fireEvent.change(screen.getByLabelText('Default for new Google Meet bots'),{target:{value:'off'}});
  expect(defaults.getAllByText('On')).toHaveLength(3);
  expect(defaults.getByText('Off')).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
  await waitFor(()=>expect(fetch.mock.calls.some(([url,init])=>url==='/api/user/voice'&&init?.method==='PUT'&&init.body==='{"prepare_new_bots":false,"speech_voice":"auto","pronunciations":{}}')).toBe(true));
  expect(fetch.mock.calls.some(([url])=>String(url).includes('/meetings/'))).toBe(false);
});

it('Refresh shows actual per-bot KWS readiness and failure instead of claiming deployment readiness',async()=>{
  let status='ready';
  vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL)=>{
    if(String(input)==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(String(input)==='/api/user/transcription')return Response.json({effective:{label:'Gipformer 1.5'}});
    if(String(input)==='/api/bots/voice/services')return Response.json({...services,wake:{...services.wake,status,sessions:[{meeting_id:14,status}]}});
    return new Response('',{status:404});
  }));
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');
  fireEvent.click(screen.getByRole('tab',{name:'Behavior'}));fireEvent.click(screen.getByText('Technical details'));
  await screen.findByText('Meeting #14 · Ready');
  status='failed';fireEvent.click(screen.getByRole('tab',{name:'Voice'}));fireEvent.click(screen.getByRole('button',{name:'Refresh status'}));
  await screen.findByText('Meeting #14 · Unavailable');
  expect(screen.getByText(/Questions use Gipformer 1.5/)).toBeTruthy();
});

it('preview is local WAV playback and its URL is revoked when settings closes',async()=>{
  const create=vi.fn(()=> 'blob:synthetic'),revoke=vi.fn();
  vi.stubGlobal('URL',class extends URL{static createObjectURL=create;static revokeObjectURL=revoke;});
  vi.spyOn(HTMLMediaElement.prototype,'play').mockResolvedValue();vi.spyOn(HTMLMediaElement.prototype,'pause').mockImplementation(()=>{});
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({});
    if(path==='/api/bots/voice/services')return Response.json(services);
    if(path==='/api/bots/voice/preview')return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'audio/wav'}});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  const view=render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');fireEvent.click(screen.getByRole('button',{name:'Preview voice'}));
  expect(await screen.findByLabelText('TINA voice preview')).toBeTruthy();
  expect(fetch.mock.calls.find(([url])=>url==='/api/bots/voice/preview')?.[1]?.method).toBe('POST');
  view.unmount();expect(revoke).toHaveBeenCalledWith('blob:synthetic');
});

it('room answer permissions preserve the full CAS policy and do not touch other rooms',async()=>{
  const policy={enabled:true,include_transcript:true,documents:['wiki/shared.md'],revision:9,wake_variants:['custom name'],noise_suppression:true,
    allow_general_knowledge:false,allow_web_search:false};
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({});
    if(path==='/api/bots/voice/services')return Response.json({...services,wake:{...services.wake,sessions:[{meeting_id:14,status:'ready'}]}});
    if(path==='/api/meetings/14/voice-assistant')return Response.json({policy:init?.method==='PUT'?{...JSON.parse(init.body as string),revision:10}:policy,replies:[{reason:'retrieval_empty'}]});
    if(path==='/api/workspace/meeting-knowledge/14')return Response.json({documents:[{path:'wiki/shared.md',title:'Shared'}]});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');
  fireEvent.click(screen.getByRole('tab',{name:'Behavior'}));fireEvent.click(screen.getByText('Technical details'));
  await screen.findByText('Meeting #14 · Ready');fireEvent.click(screen.getByRole('tab',{name:'Meeting'}));fireEvent.change(screen.getByLabelText('Active meeting'),{target:{value:'14'}});
  await screen.findByText('Last answer: retrieval empty');
  expect((screen.getByLabelText('Share approved tasks and decisions from this meeting') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByLabelText('Share approved tasks and decisions from this meeting'));
  fireEvent.click(screen.getByLabelText('Allow general knowledge'));fireEvent.click(screen.getByLabelText('Allow public web search'));
  fireEvent.click(screen.getByRole('button',{name:'Apply to meeting'}));
  await screen.findByText('Saved. The current voice turn stops when settings change.');
  const body=JSON.parse(fetch.mock.calls.find(([url,init])=>url==='/api/meetings/14/voice-assistant'&&init?.method==='PUT')![1]!.body as string);
  expect(body).toEqual({...policy,include_approved_actions:true,allow_general_knowledge:true,allow_web_search:true});
});

it('shares only explicitly checked meetings, preserves revision and enforces the four-selection UI limit',async()=>{
  const policy={enabled:true,include_transcript:true,documents:[],revision:9,wake_variants:[],noise_suppression:true,
    engine:'livekit',shared_meeting_ids:[] as number[]};
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({});
    if(path==='/api/bots/voice/services')return Response.json({...services,wake:{...services.wake,sessions:[{meeting_id:14,status:'ready'}]}});
    if(path==='/api/meetings/14/voice-assistant')return Response.json({policy:init?.method==='PUT'?{...JSON.parse(init.body as string),revision:10}:policy,livekit_available:true});
    if(path==='/api/workspace/meeting-knowledge/14')return Response.json({documents:[]});
    if(path==='/api/meetings?limit=100')return Response.json({meetings:[{id:14,title:'Current room'},
      ...[1,2,3,4,5].map(id=>({id,title:`Previous ${id}`}))]});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');
  fireEvent.click(screen.getByRole('tab',{name:'Behavior'}));fireEvent.click(screen.getByText('Technical details'));
  await screen.findByText('Meeting #14 · Ready');fireEvent.click(screen.getByRole('tab',{name:'Meeting'}));
  fireEvent.change(screen.getByLabelText('Active meeting'),{target:{value:'14'}});
  await screen.findByText('Other meeting transcripts (0/4)');
  fireEvent.click(screen.getByText('Choose meetings'));await screen.findByLabelText('Previous 1');
  expect(screen.queryByLabelText('Current room')).toBeNull();
  for(const id of [1,2,3,4])fireEvent.click(screen.getByLabelText(`Previous ${id}`));
  expect((screen.getByLabelText('Previous 5') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByLabelText('Previous 2'));
  fireEvent.click(screen.getByRole('button',{name:'Apply to meeting'}));
  await screen.findByText('Saved. The current voice turn stops when settings change.');
  const request=fetch.mock.calls.find(([url,init])=>url==='/api/meetings/14/voice-assistant'&&init?.method==='PUT')!;
  expect(JSON.parse(request[1]!.body as string)).toEqual({...policy,shared_meeting_ids:[1,3,4]});
});

it('LiveKit runtime is an explicit room choice and preserves source permissions',async()=>{
  const policy={enabled:true,include_transcript:true,documents:['wiki/shared.md'],revision:4,wake_variants:[],noise_suppression:true,
    allow_general_knowledge:true,allow_web_search:false,engine:'tina'};
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({});
    if(path==='/api/bots/voice/services')return Response.json({...services,wake:{...services.wake,sessions:[{meeting_id:14,status:'ready'}]}});
    if(path==='/api/meetings/14/voice-assistant')return Response.json({policy:init?.method==='PUT'?{...JSON.parse(init.body as string),revision:5}:policy,livekit_available:true});
    if(path==='/api/workspace/meeting-knowledge/14')return Response.json({documents:[]});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');
  fireEvent.click(screen.getByRole('tab',{name:'Behavior'}));fireEvent.click(screen.getByText('Technical details'));
  await screen.findByText('Meeting #14 · Ready');fireEvent.click(screen.getByRole('tab',{name:'Meeting'}));fireEvent.change(screen.getByLabelText('Active meeting'),{target:{value:'14'}});
  const runtime=await screen.findByLabelText('Voice runtime');fireEvent.change(runtime,{target:{value:'livekit'}});
  expect(screen.getByText(/Up to 3 concurrent meetings/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Apply to meeting'}));
  await screen.findByText('Saved. The current voice turn stops when settings change.');
  const body=JSON.parse(fetch.mock.calls.find(([url,init])=>url==='/api/meetings/14/voice-assistant'&&init?.method==='PUT')![1]!.body as string);
  expect(body).toEqual({...policy,engine:'livekit'});
});

it('new room defaults show LiveKit and four enabled options without saving or granting documents',async()=>{
  const policy={enabled:true,include_transcript:true,documents:[],revision:0,wake_variants:[],noise_suppression:true,
    allow_general_knowledge:true,allow_web_search:true,engine:'livekit'};
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/user/transcription')return Response.json({});
    if(path==='/api/bots/voice/services')return Response.json({...services,wake:{...services.wake,sessions:[{meeting_id:14,status:'ready'}]}});
    if(path==='/api/meetings/14/voice-assistant')return Response.json({policy,livekit_available:true});
    if(path==='/api/workspace/meeting-knowledge/14')return Response.json({documents:[{path:'wiki/linked.md',title:'Linked'}]});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');
  fireEvent.click(screen.getByRole('tab',{name:'Behavior'}));fireEvent.click(screen.getByText('Technical details'));
  await screen.findByText('Meeting #14 · Ready');fireEvent.click(screen.getByRole('tab',{name:'Meeting'}));fireEvent.change(screen.getByLabelText('Active meeting'),{target:{value:'14'}});
  expect((await screen.findByLabelText('Voice runtime') as HTMLSelectElement).value).toBe('livekit');
  for(const label of ['Enable voice','Use this meeting’s transcript','Allow general knowledge','Allow public web search'])
    expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('Linked') as HTMLInputElement).checked).toBe(false);
  expect(fetch.mock.calls.some(([,init])=>init?.method==='PUT')).toBe(false);
});


it('tabs support keyboard navigation and Discard restores every account preference without writing',async()=>{
  const fetch=vi.fn(async(input:RequestInfo|URL,_init?:RequestInit)=>{
    const path=String(input);
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null,speech_voice:'auto',pronunciations:{TINA:'ti na'}});
    if(path==='/api/bots/voice/services')return Response.json(services);
    if(path==='/api/user/transcription')return Response.json({});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');
  const voiceTab=screen.getByRole('tab',{name:'Voice'});voiceTab.focus();fireEvent.keyDown(voiceTab,{key:'ArrowRight'});
  expect(document.activeElement).toBe(screen.getByRole('tab',{name:'Behavior'}));
  expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  fireEvent.keyDown(document.activeElement!,{key:'End'});
  expect(document.activeElement).toBe(screen.getByRole('tab',{name:'Meeting'}));
  fireEvent.keyDown(document.activeElement!,{key:'Home'});
  expect(document.activeElement).toBe(voiceTab);
  fireEvent.change(screen.getByLabelText('Voice preset'),{target:{value:'Mai Anh'}});
  fireEvent.change(screen.getByLabelText('Default for new Google Meet bots'),{target:{value:'off'}});
  fireEvent.click(screen.getByText('Pronunciations'));
  fireEvent.change(screen.getByLabelText('Pronunciation overrides'),{target:{value:'invalid entry'}});
  expect(screen.getByLabelText('Pronunciation overrides').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('button',{name:'Save changes'}).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button',{name:'Preview voice'}).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Discard'}));
  expect((screen.getByLabelText('Voice preset') as HTMLSelectElement).value).toBe('auto');
  expect((screen.getByLabelText('Default for new Google Meet bots') as HTMLSelectElement).value).toBe('default');
  expect((screen.getByLabelText('Pronunciation overrides') as HTMLTextAreaElement).value).toBe('TINA = ti na');
  expect(screen.getByText('All changes saved')).toBeTruthy();
  expect(fetch.mock.calls.every(call=>call.length===1||!(call[1] as RequestInit)?.method)).toBe(true);
});

it('failed account saves retain edits and allow retry',async()=>{
  let fail=true;
  const fetch=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=String(input);
    if(init?.method==='PUT')return fail?new Response('',{status:503}):Response.json(JSON.parse(init.body as string));
    if(path==='/api/user/voice')return Response.json({prepare_new_bots:null});
    if(path==='/api/bots/voice/services')return Response.json(services);
    if(path==='/api/user/transcription')return Response.json({});
    return new Response('',{status:404});
  });vi.stubGlobal('fetch',fetch);
  render(<SettingsDialog onClose={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Voice assistant'}));
  await screen.findByText('Trúc Ly');
  fireEvent.change(screen.getByLabelText('Voice preset'),{target:{value:'Mai Anh'}});
  fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
  await screen.findByRole('alert');expect(screen.getByText('Unsaved changes')).toBeTruthy();
  expect((screen.getByLabelText('Voice preset') as HTMLSelectElement).value).toBe('Mai Anh');
  fail=false;fireEvent.click(screen.getByRole('button',{name:'Save changes'}));
  await screen.findByText('All changes saved');expect(screen.queryByRole('alert')).toBeNull();
});
