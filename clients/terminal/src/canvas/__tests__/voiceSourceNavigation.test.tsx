import React,{useEffect} from 'react';
import {act,cleanup,render,screen} from '@testing-library/react';
import {vi,expect,it,afterEach} from 'vitest';
import {navigationHint,navigationSource,useVoiceSourceNavigation,VOICE_SOURCE_REVEAL} from '../useVoiceSourceNavigation';

const mocks=vi.hoisted(()=>({layout:{openTab:vi.fn()},openDoc:vi.fn()}));
vi.mock('../../platform',()=>({useService:()=>mocks.layout}));
vi.mock('../../workbench/layout',()=>({LayoutServiceId:'layout'}));
vi.mock('../../ui-kit/docLinks',()=>({useOpenEntity:()=>mocks.openDoc}));
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();vi.useRealTimers();mocks.openDoc.mockClear();mocks.layout.openTab.mockClear();});
const rid='00000000-0000-4000-8000-000000000123';
const hint=()=>({request_id:rid,session_uid:'session',revision:1,created_at_ms:Date.now(),expires_at_ms:Date.now()+60000});
const snapshot=(navigation=hint())=>({available:true,policy:{enabled:true,revision:1},runtime:{state:'QUIET',session_uid:'session',
  session_active:true,heartbeat_fresh:true,navigation}});
function Harness({value,id='42'}:{value:unknown;id?:string}){
  const {follow,message}=useVoiceSourceNavigation(id);
  useEffect(()=>{follow(value);},[follow,value]);
  return <div data-voice-meeting-id={id}><span role="status">{message}</span><p data-transcript-segments='["segment-a"]'>Source transcript</p></div>;
}
function visible(){
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  vi.spyOn(HTMLElement.prototype,'getClientRects').mockReturnValue([{width:100,height:20}] as unknown as DOMRectList);
  vi.stubGlobal('matchMedia',()=>({matches:true}));
  HTMLElement.prototype.scrollIntoView=vi.fn();
}

it.each(['wiki/demo.md','README.md'])('opens a freshly claimed authorized %s document and consumes the hint once',async(path)=>{
  visible();const nav=hint(),value=snapshot(nav);
  const fetch=vi.fn(async()=>Response.json({...nav,source:{id:'ctx-'+'a'.repeat(64),kind:'document',path}}));
  vi.stubGlobal('fetch',fetch);
  const view=render(<Harness value={value}/>);
  await act(async()=>{await Promise.resolve();});
  expect(mocks.openDoc).toHaveBeenCalledWith({path,slug:undefined});
  expect(fetch).toHaveBeenCalledWith(`/api/meetings/42/voice-assistant/navigation/${rid}`,expect.objectContaining({method:'POST'}));
  view.rerender(<Harness value={{...value}}/>);await act(async()=>{await Promise.resolve();});
  expect(fetch).toHaveBeenCalledTimes(1);expect(mocks.openDoc).toHaveBeenCalledTimes(1);
});

it('reveals and focuses the source transcript without playing audio or routing elsewhere',async()=>{
  visible();const nav=hint();
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...nav,source:{id:'ctx-'+'a'.repeat(64),kind:'transcript',segment_id:'segment-a'}})));
  const listener=vi.fn();window.addEventListener(VOICE_SOURCE_REVEAL,listener);
  try{
    render(<Harness value={snapshot(nav)}/>);
    await act(async()=>{await vi.advanceTimersByTimeAsync(110);});
    const target=screen.getByText('Source transcript');
    expect(target.dataset.voiceSourceTarget).toBe('true');expect(document.activeElement).toBe(target);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({detail:{meetingId:'42',segmentId:'segment-a'}}));
    expect(mocks.layout.openTab).not.toHaveBeenCalled();expect(mocks.openDoc).not.toHaveBeenCalled();
  }finally{window.removeEventListener(VOICE_SOURCE_REVEAL,listener);}
});

it('opens another source meeting using the existing layout and reveals its segment after it renders',async()=>{
  visible();const nav=hint();
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({...nav,source:{id:'ctx-'+'a'.repeat(64),kind:'transcript',
    segment_id:'segment-b',meeting_id:2,meeting_title:'Sprint trước'}})));
  render(<Harness value={snapshot(nav)}/>);await act(async()=>{await Promise.resolve();});
  expect(mocks.layout.openTab).toHaveBeenCalledWith({id:'meeting:2',title:'Sprint trước',kind:'meeting',params:{meetingId:'2'}});
  const target=document.createElement('div');target.dataset.voiceMeetingId='2';
  const segment=document.createElement('p');segment.dataset.transcriptSegments='["segment-b"]';target.append(segment);document.body.append(target);
  try{await act(async()=>{await vi.advanceTimersByTimeAsync(110);});expect(segment.dataset.voiceSourceTarget).toBe('true');}
  finally{target.remove();}
});

it('never steals focus from a hidden meeting, settings dialog, or an old hint after reload',async()=>{
  visible();const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
  const old=hint();old.created_at_ms-=1000;
  const view=render(<Harness value={snapshot(old)}/>);expect(fetch).not.toHaveBeenCalled();
  vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');view.rerender(<Harness value={snapshot()}/>);
  expect(fetch).not.toHaveBeenCalled();view.unmount();
  vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  const dialog=document.createElement('dialog');dialog.open=true;document.body.append(dialog);
  try{render(<Harness value={snapshot()}/>);expect(fetch).not.toHaveBeenCalled();}finally{dialog.remove();}
});

it('drops a delayed claim when the policy snapshot changes or the meeting unmounts',async()=>{
  visible();let respond!:(r:Response)=>void;
  const nav=hint();vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{respond=resolve;})));
  const view=render(<Harness value={snapshot(nav)}/>);
  view.rerender(<Harness value={null}/>);
  await act(async()=>{respond(Response.json({...nav,source:{id:'ctx-'+'a'.repeat(64),kind:'document',path:'wiki/demo.md'}}));});
  expect(mocks.openDoc).not.toHaveBeenCalled();view.unmount();
});

it('does not navigate on a failed claim or an unmounted meeting',async()=>{
  visible();let respond!:(r:Response)=>void;
  const nav=hint();vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{respond=resolve;})));
  const view=render(<Harness value={snapshot(nav)}/>);
  view.unmount();
  await act(async()=>{respond(Response.json({...nav,source:{id:'ctx-'+'a'.repeat(64),kind:'document',path:'wiki/demo.md'}}));});
  expect(mocks.openDoc).not.toHaveBeenCalled();
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('',{status:409})));
  render(<Harness value={snapshot()}/>);await act(async()=>{await Promise.resolve();});
  expect(mocks.openDoc).not.toHaveBeenCalled();
});

it('refuses unsafe/mismatched targets and expired or different-session hints',()=>{
  visible();const nav=hint(),value=snapshot(nav);
  expect(navigationHint(value,'42',Date.now())).toEqual(nav);
  for(const patch of [{revision:2},{session_uid:'other'},{request_id:'bad'},{expires_at_ms:Date.now()-1}])
    expect(navigationHint(snapshot({...nav,...patch}),'42',Date.now())).toBeNull();
  for(const source of [{kind:'document',path:'../../private.md'},{kind:'document',path:'https://evil/file.md'},
      ...['readme.md','private.md','/README.md','../README.md','README.md/file.md','README.md.bak','README.md?x',
          'README.md\\..\\private.md'].map(path=>({kind:'document',path})),
      {kind:'document',path:'wiki/.secret.md'},{kind:'transcript',segment_id:''},{kind:'calculation'}]){
    expect(()=>navigationSource({...nav,source:{id:'ctx-'+'a'.repeat(64),...source}},nav)).toThrow();
  }
});
