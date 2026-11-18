"use client";
import { useEffect, useId, useRef, useState } from 'react';
import styles from './voiceSettings.module.css';

interface Services {
  noise_filter?:{id:string;label:string;device:string;ready:boolean}|null;
  new_meeting_policy?:RoomPolicy;
  wake:{method:string;names:string[];platforms:string[];engine?:string;version?:string;device?:string;
    status?:string;sessions?:Array<{meeting_id:number;status:string}>};voice_pipeline_configured:boolean;default_prepare_new_bots:boolean;
  tts:{configured:boolean;ready:boolean;busy:boolean;model:string|null;voice:string|null;device:string|null;
    profiles_supported?:boolean;voices?:Array<{id:string;label:string;region?:string}>};
}
const button={padding:'8px 12px',border:'1px solid var(--line2)',borderRadius:8,background:'var(--panel2)',color:'var(--t1)',cursor:'pointer',boxSizing:'border-box',maxWidth:'100%'} as const;

function pronunciationMap(text:string):Record<string,string>{
  const result:Record<string,string>={};const seen=new Set<string>();
  for(const line of text.split('\n').filter(value=>value.trim())){
    const parts=line.split('=');const term=parts[0]?.trim(),spoken=parts[1]?.trim();
    if(parts.length!==2||!term||!spoken||seen.has(term.toLowerCase()))throw Error('Use one unique term = pronunciation per line.');
    if(term.length>80||spoken.length>120||!/^[\p{L} .'\-,]+$/u.test(term+spoken))throw Error('Use words, spaces and punctuation in pronunciation entries.');
    result[term]=spoken;seen.add(term.toLowerCase());
  }
  if(seen.size>32||new TextEncoder().encode(JSON.stringify(result)).length>2048)throw Error('Use up to 32 short pronunciation entries.');
  return result;
}

export function VoiceSettings(){
  const [tab,setTab]=useState<'voice'|'behavior'|'meeting'>('voice'),prefix=useId();
  const [loaded,setLoaded]=useState(false);
  const [speechVoice,setSpeechVoice]=useState('auto'),[terms,setTerms]=useState(''),[savedSpeech,setSavedSpeech]=useState({voice:'auto',terms:''});
  const [services,setServices]=useState<Services|null>(null),[backend,setBackend]=useState('Unavailable');
  const [saved,setSaved]=useState('default'),[value,setValue]=useState('default');
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[previewBusy,setPreviewBusy]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[audioUrl,setAudioUrl]=useState('');
  const controller=useRef<AbortController|null>(null),audio=useRef<HTMLAudioElement|null>(null),alive=useRef(true);
  const kwsLabels:Record<string,string>={ready:'Ready',starting:'Starting…',failed:'Unavailable',off:'Disabled',
    unknown:'Needs a new bot',no_active_bot:'No active bot'};
  const kwsLabel = (status?:string) => kwsLabels[status||'']||'Checking…';
  const defaultVoice=services?.voice_pipeline_configured&&(value==='on'||(value==='default'&&services.default_prepare_new_bots));
  useEffect(()=>{
    alive.current=true;const abort=new AbortController();
    void Promise.all([fetch('/api/user/voice',{cache:'no-store',signal:abort.signal}),
      fetch('/api/bots/voice/services',{cache:'no-store',signal:abort.signal}),
      fetch('/api/user/transcription',{cache:'no-store',signal:abort.signal})]).then(async([prefs,status,asr])=>{
        if(!prefs.ok||!status.ok)throw Error('Could not load voice settings.');
        const [p,s,t]=await Promise.all([prefs.json(),status.json(),asr.ok?asr.json():{effective:undefined}]);
        if(abort.signal.aborted)return;
        const selection=p.prepare_new_bots==null?'default':p.prepare_new_bots?'on':'off';
        setSaved(selection);setValue(selection);setServices(s);setBackend(t.effective?.label||'Choose a model in Settings → Models → Transcription');
        const speech={voice:p.speech_voice==='Trúc Ly'?'auto':p.speech_voice||'auto',terms:Object.entries(p.pronunciations||{}).map(([key,value])=>`${key} = ${value}`).join('\n')};
        setSpeechVoice(speech.voice);setTerms(speech.terms);setSavedSpeech(speech);setLoaded(true);
      }).catch(()=>{if(!abort.signal.aborted)setError('Could not load voice settings.');})
      .finally(()=>{if(!abort.signal.aborted)setLoading(false);});
    return()=>{alive.current=false;abort.abort();controller.current?.abort();audio.current?.pause();};
  },[]);
  useEffect(()=>{if(!audioUrl)return;void audio.current?.play().catch(()=>{if(alive.current)setNotice('Press Play to hear the preview.');});
    return()=>URL.revokeObjectURL(audioUrl);},[audioUrl]);
  useEffect(()=>{controller.current?.abort();audio.current?.pause();setAudioUrl('');setPreviewBusy(false);},[speechVoice,terms]);
  async function save(){
    setBusy(true);setError('');setNotice('');
    try{const pronunciations=pronunciationMap(terms);
      const r=await fetch('/api/user/voice',{method:'PUT',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({prepare_new_bots:value==='default'?null:value==='on',
          ...(services?.tts.profiles_supported===false?{}:{speech_voice:speechVoice,pronunciations})})});
      if(!r.ok)throw Error('Could not save voice preferences.');
      if(alive.current){setSaved(value);setSavedSpeech({voice:speechVoice,terms});setNotice('Saved. Applies to new Google Meet bots.');}
    }catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setBusy(false);}
  }
  async function check(){
    setChecking(true);setError('');setNotice('');
    try{const r=await fetch('/api/bots/voice/services',{cache:'no-store'});if(!r.ok)throw Error();const s=await r.json();
      if(alive.current){setServices(s);setNotice(s.tts.ready?'TTS is connected.':'TTS is unavailable. Check the server configuration.');}
    }catch{if(alive.current)setError('Could not check voice services.');}finally{if(alive.current)setChecking(false);}
  }
  async function preview(){
    controller.current?.abort();const abort=new AbortController();controller.current=abort;
    setPreviewBusy(true);setError('');setNotice('');audio.current?.pause();
    try{const pronunciations=pronunciationMap(terms);const r=await fetch('/api/bots/voice/preview',{method:'POST',signal:abort.signal,
      headers:{'Content-Type':'application/json'},body:JSON.stringify({voice:speechVoice,pronunciations})});
      if(!r.ok)throw Error(r.status===429?'Wait a few seconds before trying again.':'Could not create the preview. Check TTS.');
      const blob=await r.blob();if(!abort.signal.aborted&&alive.current)setAudioUrl(URL.createObjectURL(blob));
    }catch(e){if(!abort.signal.aborted&&alive.current)setError((e as Error).message);}
    finally{if(alive.current&&!abort.signal.aborted)setPreviewBusy(false);}
  }
  const dirty=saved!==value||savedSpeech.voice!==speechVoice||savedSpeech.terms!==terms;
  let pronunciationError='';
  try{pronunciationMap(terms);}catch(e){pronunciationError=(e as Error).message;}
  const selectedVoice=speechVoice==='auto'?(services?.tts.voice||'Trúc Ly')
    :services?.tts.voices?.find(voice=>voice.id===speechVoice)?.label||speechVoice;
  const speechStatus=loading?'Checking…':services?.tts.ready?services.tts.busy?'Synthesizing…':'Ready':services?.tts.configured?'Offline':'Not configured';
  function discard(){
    controller.current?.abort();audio.current?.pause();setAudioUrl('');setPreviewBusy(false);
    setValue(saved);setSpeechVoice(savedSpeech.voice);setTerms(savedSpeech.terms);setError('');setNotice('');
  }
  return <div className={styles.root} aria-label="Voice assistant settings" aria-busy={loading}>
    <div className={styles.summary}>
      <div><span className={styles.eyebrow}>Selected voice</span><strong>{loading?'Loading…':selectedVoice}</strong></div>
      <div className={styles.defaultControl}>
        <label htmlFor={`${prefix}-default`}>Voice for<br/>new bots</label>
        <select id={`${prefix}-default`} aria-label="Default for new Google Meet bots" value={value} disabled={!loaded||busy} onChange={e=>setValue(e.target.value)}>
          <option value="default">Use deployment default{services?` (${services.default_prepare_new_bots?'on':'off'})`:''}</option>
          <option value="on">Enable voice</option><option value="off">Disable voice</option>
        </select>
      </div>
    </div>
    <div className={styles.tabs} role="tablist" aria-label="Voice assistant tasks">
      {(['voice','behavior','meeting'] as const).map(name=><button key={name} type="button" role="tab"
        id={`${prefix}-tab-${name}`} aria-controls={`${prefix}-panel-${name}`} aria-selected={tab===name} tabIndex={tab===name?0:-1}
        onClick={()=>setTab(name)} onKeyDown={e=>{
          const tabs=['voice','behavior','meeting'] as const,index=tabs.indexOf(name);
          const next=e.key==='ArrowRight'?(index+1)%3:e.key==='ArrowLeft'?(index+2)%3:e.key==='Home'?0:e.key==='End'?2:-1;
          if(next<0)return;e.preventDefault();setTab(tabs[next]);
          document.getElementById(`${prefix}-tab-${tabs[next]}`)?.focus();
        }}>{name[0].toUpperCase()+name.slice(1)}</button>)}
    </div>
    <div className={styles.content}>
      <section role="tabpanel" id={`${prefix}-panel-voice`} aria-labelledby={`${prefix}-tab-voice`} hidden={tab!=='voice'} tabIndex={0}>
        <h2>Choose how TINA sounds</h2><p className={styles.lead}>Pick a voice, then try a short introduction.</p>
        <div className={styles.voiceRow}>
          <div className={styles.voiceSelect}><label htmlFor={`${prefix}-voice`}>Voice preset</label>
            <select id={`${prefix}-voice`} value={speechVoice} disabled={!loaded||busy||services?.tts.profiles_supported===false} onChange={e=>setSpeechVoice(e.target.value)}>
              <option value="auto">{services?.tts.voice||'Trúc Ly'} (default)</option>
              {(services?.tts.voices||[]).filter(voice=>voice.id!==services?.tts.voice).map(voice=><option key={voice.id} value={voice.id}>{voice.label}{voice.region?` · ${voice.region}`:''}</option>)}
            </select>
          </div>
          <button type="button" className={styles.primary} disabled={!loaded||busy||previewBusy||!services?.tts.ready||!!pronunciationError} onClick={preview}>{previewBusy?'Preparing preview…':'Preview voice'}</button>
        </div>
        <p className={styles.helper}>Preview plays in your browser only.</p>
        {audioUrl&&<audio ref={audio} controls src={audioUrl} aria-label="TINA voice preview" className={styles.audio}/>}
        <details className={styles.disclosure}>
          <summary>Pronunciations <span>{terms.split('\n').filter(line=>line.trim()).length} / 32</span></summary>
          <label htmlFor={`${prefix}-pronunciations`}>Pronunciation overrides</label>
          <textarea id={`${prefix}-pronunciations`} value={terms} rows={3} disabled={!loaded||busy||services?.tts.profiles_supported===false}
            placeholder={'PostgreSQL = pốt gờ rét\nTINA = ti na'} spellCheck={false}
            aria-describedby={`${prefix}-pronunciation-help`} aria-invalid={!!pronunciationError} onChange={e=>setTerms(e.target.value)}/>
          <p id={`${prefix}-pronunciation-help`} className={styles.helper}>One term = pronunciation per line, up to 32. Only TINA’s speech changes.</p>
          {pronunciationError&&<p role="alert" className={styles.error}>{pronunciationError}</p>}
        </details>
        <section className={styles.wake} aria-label="Wake phrases">
          <div><span className={styles.eyebrow}>Wake phrases</span><div className={styles.phrases}>{services?.wake.names.map(name=><span key={name}>{name}</span>)||'Loading phrases…'}</div></div>
          <div className={styles.health}><span role="status">Wake: {kwsLabel(services?.wake.status)} · Speech: {speechStatus}</span>
            <button type="button" className={styles.textButton} disabled={loading||checking} onClick={check}>{checking?'Checking…':'Refresh status'}</button></div>
        </section>
        {services?.tts.profiles_supported===false&&<p role="status" className={styles.helper}>Speech profiles are not configured on this deployment.</p>}
        {services&&!services.voice_pipeline_configured&&<p role="status" className={styles.helper}>The voice pipeline is disabled in deployment settings.</p>}
      </section>
      <section role="tabpanel" id={`${prefix}-panel-behavior`} aria-labelledby={`${prefix}-tab-behavior`} hidden={tab!=='behavior'} tabIndex={0}>
        <h2>Start new bots your way</h2><p className={styles.lead}>Your default applies when a new Google Meet bot joins.</p>
        <p className={styles.helper}>{value==='default'?`Following deployment default. Voice is currently ${defaultVoice?'on':'off'}.`:value==='on'?'Voice is enabled for new bots, even if the deployment default changes.':'Voice is disabled for new bots, even if the deployment default changes.'}</p>
        <section aria-label="New meeting defaults" className={styles.defaults}>
          <div className={styles.sectionHeading}><strong>New meeting defaults</strong><span>{services?.new_meeting_policy?.engine==='livekit'?'LiveKit Agents':services?.new_meeting_policy?.engine==='tina'?'TINA':'Checking…'}</span></div>
          <dl>{([['enabled','Voice assistant'],['include_transcript','Meeting transcript'],['include_workspace_wiki','Private workspace Wiki'],
            ['allow_general_knowledge','General knowledge'],['allow_web_search','Public web search']] as const).map(([key,label])=>
            <div key={key}><dt>{label}</dt><dd>{!services?.new_meeting_policy?'Unavailable':(key==='enabled'?defaultVoice:services.new_meeting_policy[key])?'On':'Off'}</dd></div>)}</dl>
          <p className={styles.helper}>Answer agent · {!services?.new_meeting_policy?'Checking…':services.new_meeting_policy.agent_backend==='sandbox'?'Sandbox agent':'Direct LLM'}</p>
        </section>
        <p className={styles.helper}>Saved meeting settings stay unchanged. Documents require sharing in the Meeting tab.</p>
        <details className={styles.disclosure}>
          <summary>Technical details</summary>
          <p>{services?.wake.engine||'LiveKit WakeWord'} {services?.wake.version||''} · Local CPU · Google Meet</p>
          <p>Questions use {backend}. Starts with a new voice-enabled bot.</p>
          <p>Audio filter: {services?.noise_filter?.ready?`${services.noise_filter.label} · ${services.noise_filter.device.toUpperCase()}`:'Unavailable'}</p>
          <p>Speech: {services?.tts.model||'Unavailable'} · {services?.tts.device?.toUpperCase()||'Unavailable'}</p>
          {services?.wake.sessions?.map(s=><p key={s.meeting_id}>Meeting #{s.meeting_id} · {kwsLabel(s.status)}</p>)}
        </details>
      </section>
      <section role="tabpanel" id={`${prefix}-panel-meeting`} aria-labelledby={`${prefix}-tab-meeting`} hidden={tab!=='meeting'} tabIndex={0}>
        <div className={styles.meetingHeading}><img src="/platform-logos/google-meet.svg" width={28} height={28} alt="Google Meet"/><div><h2>Meeting sources</h2><p className={styles.helper}>Choose what TINA can read aloud to this room.</p></div></div>
        <RoomVoiceSettings sessions={services?.wake.sessions||[]}/>
      </section>
    </div>
    {error&&<p role="alert" className={styles.error}>{error}</p>}
    {notice&&<p role="status" className={styles.notice}>{notice}</p>}
    <footer className={styles.footer}>
      <div className={styles.footerCopy}><p role="status">{loading?'Loading preferences…':!loaded?'Preferences unavailable':pronunciationError?'Check pronunciations':dirty?'Unsaved changes':'All changes saved'}</p><span>Voice preferences · defaults for new bots</span></div>
      <button type="button" className={styles.discard} disabled={!dirty||busy} onClick={discard}>Discard</button>
      <button type="button" className={styles.primary} disabled={!loaded||busy||!dirty||!!pronunciationError} onClick={save}>{busy?'Saving…':'Save changes'}</button>
    </footer>
  </div>;
}

interface RoomPolicy {enabled:boolean;include_transcript:boolean;include_workspace_wiki?:boolean;include_approved_actions?:boolean;shared_meeting_ids?:number[];documents:string[];revision:number;wake_variants:string[];
  noise_suppression:boolean;allow_general_knowledge?:boolean;allow_web_search?:boolean;auto_web_search?:boolean;engine?:'tina'|'livekit';agent_backend?:'completion'|'sandbox';source_profile_id?:string|null;source_profile_fingerprint?:string|null}
interface SourceProfile {id:string;name:string;fingerprint:string;sources:Pick<RoomPolicy,'documents'|'shared_meeting_ids'|'include_transcript'|'include_approved_actions'|'allow_general_knowledge'|'allow_web_search'|'auto_web_search'>}
function RoomVoiceSettings({sessions}:{sessions:Array<{meeting_id:number;status:string}>}){
  const [meeting,setMeeting]=useState(''),[policy,setPolicy]=useState<RoomPolicy|null>(null);
  const [profiles,setProfiles]=useState<SourceProfile[]>([]),[profileName,setProfileName]=useState('');
  const [savedPolicy,setSavedPolicy]=useState<RoomPolicy|null>(null);
  const [documents,setDocuments]=useState<Array<{path:string;title:string}>>([]),[reason,setReason]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [livekit,setLivekit]=useState(false);
  const [choices,setChoices]=useState<Array<{id:number;title:string}>>([]),[choicesMessage,setChoicesMessage]=useState('');
  const identity=useRef(meeting);identity.current=meeting;
  useEffect(()=>{
    if(!meeting)return;const abort=new AbortController();setPolicy(null);setMessage('');setDocuments([]);setReason('');setChoices([]);setChoicesMessage('');setProfiles([]);setProfileName('');
    void Promise.all([fetch(`/api/meetings/${meeting}/voice-assistant`,{cache:'no-store',signal:abort.signal}),
      fetch(`/api/workspace/meeting-knowledge/${meeting}`,{cache:'no-store',signal:abort.signal}),
      fetch(`/api/workspace/meeting-knowledge/${meeting}/source-profiles`,{cache:'no-store',signal:abort.signal}).catch(()=>null)]).then(async([room,docs,presets])=>{
      if(!room.ok)throw Error();const r=await room.json(),d=docs.ok?await docs.json():{documents:[]};
      if(abort.signal.aborted)return;setPolicy(r.policy);setSavedPolicy(r.policy);setDocuments(d.documents||[]);setLivekit(r.livekit_available===true);
      if(presets?.ok){const value=await presets.json();if(!abort.signal.aborted){
        setProfiles(value.profiles||[]);
        const selected=(value.profiles||[]).find((p:SourceProfile)=>p.id===r.policy.source_profile_id);
        if(selected)setDocuments(current=>[...new Map([...current,...selected.sources.documents.map((path:string)=>({path,title:path}))].map(d=>[d.path,d])).values()]);
      }}
      setReason(r.replies?.at(-1)?.reason||'');
    }).catch(()=>{if(!abort.signal.aborted)setMessage('Could not load room settings.');});
    return()=>abort.abort();
  },[meeting]);
  function chooseProfile(id:string){
    if(!policy)return;
    const item=profiles.find(p=>p.id===id);
    if(!item){setPolicy({...policy,source_profile_id:null,source_profile_fingerprint:null,documents:policy.source_profile_id?[]:policy.documents});return;}
    setPolicy({...policy,...item.sources,shared_meeting_ids:(item.sources.shared_meeting_ids||[]).filter(i=>String(i)!==meeting),
      source_profile_id:item.id,source_profile_fingerprint:item.fingerprint});
    setDocuments(current=>[...new Map([...current,...item.sources.documents.map(path=>({path,title:path}))].map(d=>[d.path,d])).values()]);
  }
  async function saveProfile(){
    if(!policy||!profileName.trim())return;
    const id=meeting;setBusy(true);setMessage('');
    try{
      const sources={documents:policy.documents,shared_meeting_ids:policy.shared_meeting_ids||[],
        include_transcript:policy.include_transcript,include_approved_actions:!!policy.include_approved_actions,
        allow_general_knowledge:!!policy.allow_general_knowledge,allow_web_search:!!policy.allow_web_search,auto_web_search:!!policy.auto_web_search};
      const response=await fetch(`/api/workspace/meeting-knowledge/${id}/source-profiles`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:profileName.trim(),...sources})});
      if(!response.ok)throw Error('Could not save project sources. Check the name and selected sources.');
      const item:SourceProfile=await response.json();if(identity.current!==id)return;
      setProfiles(current=>[...current,item]);setProfileName('');
      setPolicy({...policy,source_profile_id:item.id,source_profile_fingerprint:item.fingerprint});
      setMessage('Project sources saved. Apply to this meeting when ready.');
    }catch(error){if(identity.current===id)setMessage(error instanceof Error?error.message:'Could not save project sources.');}
    finally{if(identity.current===id)setBusy(false);}
  }
  async function removeProfile(){
    const item=profiles.find(p=>p.id===policy?.source_profile_id);
    if(!item||!window.confirm('Remove these project sources? Voice in meetings using this profile will stop until sources are applied again.'))return;
    const id=meeting;setBusy(true);setMessage('');
    try{
      const response=await fetch(`/api/workspace/meeting-knowledge/${id}/source-profiles/remove`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:item.id,fingerprint:item.fingerprint})});
      if(!response.ok)throw Error();if(identity.current!==id)return;
      setProfiles(current=>current.filter(p=>p.id!==item.id));
      setPolicy(current=>current?{...current,source_profile_id:null,source_profile_fingerprint:null,documents:[]}:null);
      setMessage('Project sources removed. Apply new room sources to resume voice.');
    }catch{if(identity.current===id)setMessage('Could not remove project sources. Reload and retry.');}
    finally{if(identity.current===id)setBusy(false);}
  }
  async function chooseMeetings(){
    const id=meeting;setChoicesMessage('Loading meetings…');
    try{
      const response=await fetch('/api/meetings?limit=100',{cache:'no-store',signal:AbortSignal.timeout(7000)});
      if(!response.ok)throw Error();const value=await response.json();
      if(identity.current!==id)return;
      setChoices((value.meetings||[]).filter((m:{id:number|string})=>Number(m.id)!==Number(id))
        .map((m:{id:number|string;title?:string})=>({id:Number(m.id),title:m.title||`Meeting #${m.id}`})));
      setChoicesMessage('Only meetings you own can be shared. The server checks ownership on Save.');
    }catch{if(identity.current===id)setChoicesMessage('Could not load meetings. Existing selections were kept.');}
  }
  async function save(){
    if(!policy)return;const id=meeting;setBusy(true);setMessage('');
    try{const r=await fetch(`/api/meetings/${id}/voice-assistant`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)});
      if(!r.ok)throw Error(r.status===409?'Room changed. Select the meeting again to reload.':'Could not save. Check shared sources and services.');
      const data=await r.json();if(identity.current===id){setPolicy(data.policy);setSavedPolicy(data.policy);setMessage('Saved. The current voice turn stops when settings change.');}
    }catch(e){if(identity.current===id)setMessage((e as Error).message);}
    finally{if(identity.current===id)setBusy(false);}
  }
  if(!sessions.length)return <section className={styles.empty} aria-label="Meeting sources">
    <strong>No active Google Meet bot</strong>
    <div style={{fontSize:13}}>Approved tasks and decisions</div>
    <span style={{fontSize:12,color:'var(--t3)'}}>Read saved actions from this meeting after you allow sharing.</span>
    <div style={{fontSize:13}}>Other meeting transcripts · up to 4</div>
    <span style={{fontSize:12,color:'var(--t3)'}}>Compare transcripts from other meetings you own. Each answer keeps its sources.</span>
    <p role="status" style={{margin:0,fontSize:12,color:'var(--t2)'}}>Start a bot, then refresh status in the Voice tab to choose its shared sources.</p>
  </section>;
  return <section className={styles.room} aria-label="Room answers">
    <div className={styles.roomControls}>
    <label htmlFor="voice-room">Active meeting</label>
    <select id="voice-room" value={meeting} disabled={busy} onChange={e=>setMeeting(e.target.value)} style={button}>
      <option value="">Choose a meeting</option>{sessions.map(s=><option key={s.meeting_id} value={s.meeting_id}>Meeting #{s.meeting_id}</option>)}
    </select>
    {meeting&&policy&&<>
      <label htmlFor="voice-project-sources">Project sources</label>
      <select id="voice-project-sources" value={policy.source_profile_id||''} disabled={busy} style={button} onChange={e=>chooseProfile(e.target.value)}>
        <option value="">Custom meeting sources</option>{profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <span className={styles.helper}>Reuse project defaults; room changes do not edit the saved profile. Apply to meeting to start using them.</span>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <input aria-label="Project source name" value={profileName} maxLength={80} disabled={busy} placeholder="Project name" onChange={e=>setProfileName(e.target.value)} style={button}/>
        <button type="button" disabled={busy||!profileName.trim()} style={button} onClick={saveProfile}>Save as project sources</button>
        {policy.source_profile_id&&<button type="button" disabled={busy} style={button} onClick={removeProfile}>Remove profile</button>}
      </div>
      <label htmlFor="voice-runtime">Voice runtime</label>
      <select id="voice-runtime" value={policy.engine||'tina'} disabled={busy} style={button}
        onChange={e=>setPolicy({...policy,engine:e.target.value as 'tina'|'livekit'})}>
        <option value="tina">TINA</option><option value="livekit" disabled={!livekit}>LiveKit Agents{livekit?'':' · not configured'}</option>
      </select>
      <label htmlFor="voice-answer-agent">Answer agent</label>
      <select id="voice-answer-agent" value={policy.agent_backend||'completion'} disabled={busy} style={button}
        onChange={e=>setPolicy({...policy,agent_backend:e.target.value as 'completion'|'sandbox'})}>
        <option value="sandbox">Sandbox agent</option><option value="completion">Direct LLM</option>
      </select>
      <span className={styles.helper}>Sandbox uses your configured chat harness with meeting-approved evidence. TINA executes source tools and verifies the answer before speech.</span>
      {policy.engine==='livekit'&&<span style={{fontSize:12,color:'var(--t3)'}}>Up to 3 concurrent meetings. Uses your selected ASR, approved sources and local voice.</span>}
      {([['enabled','Enable voice'],['include_transcript','Use this meeting’s transcript'],
        ['include_workspace_wiki','Read all Wiki documents in my private workspace'],
        ['include_approved_actions','Share approved tasks and decisions from this meeting'],
        ['allow_general_knowledge','Allow general knowledge'],['allow_web_search','Allow public web search'],['auto_web_search','Let agent choose public web search']] as const).map(([key,label])=>
        <label key={key}><input type="checkbox" checked={!!policy[key]} disabled={busy||key==='auto_web_search'&&!policy.allow_web_search} onChange={e=>setPolicy({...policy,[key]:e.target.checked})}/> {label}</label>)}
      <span className={styles.helper}>All-Wiki sharing lets TINA answer aloud from your private Markdown knowledge documents. Other accounts and hidden files are excluded. Turn it off to use only selected documents below.</span>
      {!!documents.length&&<details><summary>Shared documents ({policy.documents.length})</summary>
        {documents.map(doc=><label key={doc.path} style={{display:'block',marginTop:8}}><input type="checkbox" disabled={busy} checked={policy.documents.includes(doc.path)}
          onChange={e=>setPolicy({...policy,documents:e.target.checked?[...policy.documents,doc.path]:policy.documents.filter(p=>p!==doc.path)})}/> {doc.title}</label>)}
      </details>}
      <span className={styles.helper}>Agent may choose web for self-contained public questions. Meeting and follow-up context stays with approved local sources.</span>
      {!documents.length&&<p className={styles.helper}>Shared documents · None linked</p>}
      <details><summary>Other meeting transcripts ({policy.shared_meeting_ids?.length||0}/4)</summary>
        <p style={{fontSize:12,color:'var(--t3)'}}>Selected transcripts can be read aloud to everyone in this room. Documents and tasks from those meetings are excluded.</p>
        <button type="button" style={button} disabled={busy} onClick={()=>void chooseMeetings()}>Choose meetings</button>
        {choicesMessage&&<p role="status" style={{fontSize:12}}>{choicesMessage}</p>}
        {[...new Map([...(policy.shared_meeting_ids||[]).map(id=>({id,title:choices.find(m=>m.id===id)?.title||`Meeting #${id}`})),...choices].map(m=>[m.id,m])).values()].map(item=>{
          const selected=(policy.shared_meeting_ids||[]).includes(item.id);
          return <label key={item.id} style={{display:'block',marginTop:8}}><input type="checkbox" checked={selected}
            disabled={busy||!selected&&(policy.shared_meeting_ids?.length||0)>=4}
            onChange={e=>setPolicy({...policy,shared_meeting_ids:e.target.checked?[...(policy.shared_meeting_ids||[]),item.id]
              :(policy.shared_meeting_ids||[]).filter(id=>id!==item.id)})}/> {item.title}</label>;
        })}
      </details>
      <span style={{fontSize:12,color:'var(--t3)',lineHeight:1.5}}>General: “ASR là gì?” or “Kiến thức chung: …”. Web: “Tìm trên web về …”. Only the spoken search query leaves the room; verified public search must be configured.</span>
      {reason&&<span role="status" style={{fontSize:12,color:'var(--t3)'}}>Last answer: {reason.replaceAll('_',' ')}</span>}
      <div className={styles.meetingActions}><button type="button" disabled={busy||JSON.stringify(policy)===JSON.stringify(savedPolicy)} style={button} onClick={save}>{busy?'Applying…':'Apply to meeting'}</button>
        <span className={styles.helper}>{JSON.stringify(policy)===JSON.stringify(savedPolicy)?'No meeting changes':'Unsaved meeting changes'}</span></div>
      <p className={styles.helper}>Applies to this meeting only. New-bot defaults stay unchanged.</p>
    </>}
    {message&&<p role="status" style={{margin:0,fontSize:12}}>{message}</p>}
    </div>
  </section>;
}
