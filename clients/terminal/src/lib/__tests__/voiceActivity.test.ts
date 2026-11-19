import { describe, it, expect } from 'vitest';
import { voiceActivity, voiceActivityStatus } from '../voiceActivity';
import { voiceActivity as extensionActivity, voiceActivityStatus as extensionStatus } from '../../../../extension/src/voice-activity';
const now = 1800000000000;
const snapshot = (state: string) => ({ available:true, policy:{enabled:true}, runtime:{state,session_active:true,heartbeat_fresh:true,kws:{status:'ready',observed_at_ms:now}} });

describe.each([['Terminal',voiceActivity],['Extension',extensionActivity]] as const)('%s voice activity',(_name,project)=>{
  it('shows only fresh session-bound voice readiness and maps the four stages',()=>{
    for (const state of ['LISTENING','CAPTURING','THINKING','SPEAKING','QUIET'] as const) expect(project(snapshot(state),now)).toBe(state);
    expect(project(snapshot('constructor'),now)).toBe('UNAVAILABLE');
    const value=snapshot('LISTENING');
    expect(project({...value,runtime:{...value.runtime,heartbeat_fresh:false}},now)).toBe('UNAVAILABLE');
    expect(project({...value,runtime:{...value.runtime,session_active:false}},now)).toBe('NO_BOT');
    expect(project({...value,policy:{enabled:false}},now)).toBe('OFF');
    expect(project(value,now+15000)).toBe('UNAVAILABLE');
    expect(project({...value,runtime:{...value.runtime,kws:{status:'failed',observed_at_ms:now}}},now)).toBe('ERROR');
  });
  it('does not infer listening from transcript, missing runtime or closed meetings',()=>{
    expect(project(undefined,now)).toBe('CHECKING');
    for (const value of [null,{},[],true,{runtime:{state:'LISTENING'}},{segments:[{text:'Speech'}]}]) expect(project(value,now)).toBe('UNAVAILABLE');
    expect(project(snapshot('LISTENING'),now,true)).toBe('ENDED');
  });
});

describe.each([['Terminal',voiceActivityStatus],['Extension',extensionStatus]] as const)('%s tool progress',(_name,status)=>{
  it('shows recovery only for a fresh matching-session diagnostic after returning to idle',()=>{
    const value={...snapshot('LISTENING'),runtime:{...snapshot('LISTENING').runtime,session_uid:'session',diagnostic:{
      code:'no_input',session_uid:'session',observed_at_ms:now,expires_at_ms:now+30000}}};
    expect(status(value,now).label).toBe('Chờ bạn gọi lại');
    for(const patch of [{session_uid:'old'},{observed_at_ms:now-15001},{observed_at_ms:now+1},{expires_at_ms:now}])
      expect(status({...value,runtime:{...value.runtime,diagnostic:{...value.runtime.diagnostic,...patch}}},now).label).toBe('Chờ gọi tên');
    expect(status({...value,runtime:{...value.runtime,state:'SPEAKING'}},now).label).toBe('Đang trả lời');
    expect(status({...value,runtime:{...value.runtime,diagnostic:{...value.runtime.diagnostic,code:'playback_failed'}}},now).label).toBe('Không phát được audio');
  });
  it('only presents allowlisted progress for the active request/session/revision',()=>{
    const value = {...snapshot('THINKING'), policy:{enabled:true,revision:2},runtime:{...snapshot('THINKING').runtime,
      request_id:'turn',session_uid:'session',progress:{request_id:'turn',session_uid:'session',revision:2,
        stage:'reading_documents',observed_at_ms:now}}};
    expect(status(value,now).label).toBe('Đang đọc tài liệu');
    for (const patch of [{stage:'private text'}, {request_id:'old'}, {session_uid:'old'}, {revision:1},
      {observed_at_ms:now-180001}, {observed_at_ms:now+1000}]) {
      expect(status({...value,runtime:{...value.runtime,progress:{...value.runtime.progress,...patch}}},now).label).toBe('Đang xử lý');
    }
    expect(status({...value,runtime:{...value.runtime,state:'SPEAKING'}},now).label).toBe('Đang trả lời');
    expect(status(value,now,true).label).toBe('Đã kết thúc');
  });
});
