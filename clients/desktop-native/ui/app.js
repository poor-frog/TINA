const tauri=window.__TAURI__;
if(typeof tauri?.core?.invoke!=='function'||typeof tauri?.event?.listen!=='function'){
  throw new Error('TINA Capture requires the Tauri runtime');
}
const invoke=tauri.core.invoke;
const listen=tauri.event.listen;
const writeText=tauri.clipboardManager?.writeText??(async text=>{
  if(!navigator.clipboard?.writeText)throw new Error('Clipboard is unavailable');
  await navigator.clipboard.writeText(text);
});
const { clock }=window.TinaOverlayUtils;
const { normalizeAudioSource, audioSourceFlags, startCaptureArgs, shouldPlayChime, audioProcessingLabel }=window.TinaCaptureSettings;
const $ = (id) => document.getElementById(id);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let busy=false,dictationResult='',lastDiagnosticError='';
let polling=false,previousTranscript='',actionError='';
let transcriptionPreview=null,previewAt=0;
let paused=false,captionsOn=false,savedPath='',meetingId='';
let activeDictation=null;
let dictationOriginal='';
let latestCapture=null;
let capturePlatform='macos';
let liveSnapshot=null;
let liveOutputMode='transcript';
let liveTarget='off';
let liveTranslationBusy=false;
const liveTranslationQueue=[];
const liveTranslationQueued=new Set();
const liveTranslationDone=new Set();
const liveTranslationFailed=new Set();

function meter(level){
  const raw=Math.max(0,Math.min(1,Number(level)||0));
  return Math.min(1,Math.sqrt(raw)*2.4+.02);
}

function detectedText(apps){
  const name=(app)=>app&&app.name?app.name:'A meeting app';
  if(apps.length===1)return `${name(apps[0])} is using your microphone.`;
  return `${name(apps[0])} and ${apps.length-1} other ${apps.length===2?'app is':'apps are'} using your microphone.`;
}

function setCaptions(on){
  captionsOn=Boolean(on);
  $('captions').setAttribute('aria-pressed',String(captionsOn));
  $('captions').textContent=captionsOn?'Hide captions':'Live captions';
}

async function overlaySnapshot(){
  try{return await invoke('overlay_state');}
  catch{return null;}
}

function showPermission(id,status,granted,showSettings=!granted){
  const permRow = $(`${id}-permission`);
  if(permRow) permRow.dataset.granted=String(granted);
  const statusEl = $(`${id}-status`);
  if(statusEl) statusEl.textContent=status;
  const settingsStatus=$(`settings-${id}-status`);
  if(settingsStatus)settingsStatus.textContent=status;
  const settingsBadge=$(`settings-${id}-badge`);
  if(settingsBadge){
    settingsBadge.textContent=granted?'Granted':'Not granted';
    settingsBadge.className=`badge badge-${granted?'ok':'warn'}`;
  }
  const settingsBtn = $(`${id}-settings`);
  if(settingsBtn) settingsBtn.hidden=!showSettings;
  const helpEl = $(`${id}-help`);
  if(granted && helpEl) helpEl.hidden=true;
}

async function refreshPermissions(capture){
  let p;
  try{p=await invoke('permissions_status');}
  catch{
    for(const id of ['accessibility','microphone','screen-audio'])showPermission(id,'Can’t check this permission.',false);
    return;
  }
  if(p.platform==='windows'){
    capturePlatform='windows';
    const copy=window.TinaCaptureSettings.platformPresentation(capturePlatform);
    document.querySelector('.footer-platform').textContent=copy.name;
    document.querySelector('.dictation-hero-lede').textContent=copy.dictation;
    document.querySelector('.footnote').textContent=copy.privacy;
    document.querySelector('.permission-note').textContent='Allow desktop apps to access the microphone in Windows Settings. Headphones help prevent echo.';
    document.querySelector('.about-brand-tagline').textContent='Voice dictation and meeting capture for Windows.';
    $('about-platform').textContent='Windows 11 · x64';
    for(const id of ['reveal','live-reveal','settings-show-app'])$(id).textContent=copy.reveal;
    for(const button of document.querySelectorAll('[data-open-privacy]'))button.textContent='Open Windows Settings';
    $('settings-accessibility-badge').closest('.settings-row').hidden=true;
    const shortcuts=$('settings-shortcut-status').closest('.settings-card');
    shortcuts.hidden=true;
    shortcuts.previousElementSibling.hidden=true;
    document.querySelector('.shortcut').hidden=true;
    $('setting-auto-paste').checked=false;
    $('setting-auto-paste').disabled=true;
    $('setting-auto-paste').closest('.settings-row').querySelector('p').textContent='Automatic paste is unavailable on Windows. Use Ctrl+V after dictation.';
    $('settings-show-app').closest('.settings-details').hidden=true;
    document.querySelectorAll('[data-macos-only]').forEach(element=>{element.hidden=true;});
  }
  showPermission('accessibility',p.accessibility?'Granted':'Not granted',Boolean(p.accessibility));
  const microphone=p.microphone==='not-determined'
    ? capture?.capturing&&capture.microphone&&capture.level>0.005
      ? ['Working · microphone signal received',true,false]
      : [capture?.capturing&&capture.microphone?'Capture active · no microphone signal right now':'Not confirmed until microphone capture starts',false,true]
    : ({authorized:['Granted',true],denied:['Not granted',false],restricted:['Restricted',false],unavailable:['Unable to check',false],unknown:['Unable to check',false],unsupported:['Unavailable',false]}[p.microphone]||['Unable to check',false]);
  showPermission('microphone',microphone[0],microphone[1],microphone[2]??!microphone[1]);
  showPermission('screen-audio',p.screenAudio?'Granted':'Not granted',Boolean(p.screenAudio));
  if(capturePlatform==='windows')showPermission('screen-audio','Available · WASAPI audio only',true,false);
}

function renderSettingsNetwork(capture,asr){
  $('settings-desktop-status').textContent=capture?.running
    ? capture.meeting?'Connected for this session':'Connecting'
    : asr&&asr.configured!==false?'Ready':'Unavailable';
  $('settings-asr-status').textContent=asr&&asr.configured!==false?asr.label:'Unavailable';
}

const SETTINGS_ALIASES={
  account:'dictation',
  app:'dictation',
  general:'dictation',
  features:'dictation',
  data:'permissions',
  privacy:'permissions'
};

const settingsDialog=$('settings-dialog');
const settingsTabs=[...document.querySelectorAll('.settings-tab')];
function selectSettingsTab(name){
  const targetName=SETTINGS_ALIASES[name]||name;
  for(const tab of settingsTabs){
    const tabName=tab.dataset.settingsTab;
    const selected=tabName===targetName;
    tab.classList.toggle('active',selected);
    tab.setAttribute('aria-selected',String(selected));
    tab.tabIndex=selected?0:-1;
    const panel=document.querySelector(`[data-settings-panel="${tabName}"]`);
    if(panel)panel.hidden=!selected;
  }
  $('settings-content').scrollTop=0;
}
settingsTabs.forEach(tab=>{
  tab.addEventListener('click',()=>selectSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener('keydown',event=>{
    const visibleTabs=settingsTabs.filter(item=>!item.hidden);
    const currentIndex=visibleTabs.indexOf(tab);
    let nextIndex;
    switch(event.key){
      case 'ArrowDown':
      case 'ArrowRight':
        nextIndex=(currentIndex+1)%visibleTabs.length;
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        nextIndex=(currentIndex-1+visibleTabs.length)%visibleTabs.length;
        break;
      case 'Home':
        nextIndex=0;
        break;
      case 'End':
        nextIndex=visibleTabs.length-1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextTab=visibleTabs[nextIndex];
    selectSettingsTab(nextTab.dataset.settingsTab);
    nextTab.focus();
  });
});
$('settings-search').addEventListener('input',()=>{
  const query=$('settings-search').value.trim().toLowerCase();
  let firstVisible=null,selectionVisible=false;
  for(const tab of settingsTabs){
    const panel=document.querySelector(`[data-settings-panel="${tab.dataset.settingsTab}"]`);
    const tabText=tab.textContent.toLowerCase();
    const panelText=panel?panel.textContent.toLowerCase():'';
    const matches=tabText.includes(query)||panelText.includes(query);
    tab.hidden=!matches;
    if(matches){
      firstVisible??=tab;
      selectionVisible||=tab.getAttribute('aria-selected')==='true';
    }
  }
  $('settings-search-empty').hidden=Boolean(firstVisible);
  $('settings-content').hidden=!firstVisible;
  if(firstVisible&&!selectionVisible)selectSettingsTab(firstVisible.dataset.settingsTab);
});
function openSettings(tabName='dictation'){
  settingsDialog.showModal();
  $('settings-search').value='';
  settingsTabs.forEach(tab=>tab.hidden=false);
  $('settings-search-empty').hidden=true;
  $('settings-content').hidden=false;
  selectSettingsTab(tabName);
  const status=latestCapture?.transcription||transcriptionPreview;
  renderSettingsNetwork(latestCapture,status);
  void refreshPermissions(latestCapture);
  void invoke('fn_shortcut_status').then(status=>{
    $('settings-shortcut-status').textContent=fnStatus[status]||fnStatus.unavailable;
  }).catch(()=>{$('settings-shortcut-status').textContent='Unavailable';});
  void invoke('capture_app_path').then(path=>{
    const codeEl=$('settings-app-path');
    if(codeEl&&path)codeEl.textContent=path;
  }).catch(()=>{});
}
$('settings-open').addEventListener('click',()=>openSettings('dictation'));
$('sidebar-permissions')?.addEventListener('click',()=>openSettings('permissions'));
$('settings-close').addEventListener('click',()=>settingsDialog.close());
settingsDialog.addEventListener('close',()=>$('settings-open').focus());
settingsDialog.addEventListener('click',event=>{if(event.target===settingsDialog)settingsDialog.close();});
document.querySelectorAll('[data-open-privacy]').forEach(button=>button.addEventListener('click',async()=>{
  try{await invoke('open_privacy_settings',{section:button.dataset.openPrivacy});}
  catch(e){$('settings-data-message').textContent=String(e);}
}));
$('settings-check-permissions').addEventListener('click',()=>void refreshPermissions(latestCapture));
$('settings-check-network').addEventListener('click',async()=>{
  const button=$('settings-check-network');
  button.disabled=true;
  $('settings-network-message').textContent='Checking TINA Desktop…';
  try{
    const asr=await invoke('transcription_config');
    transcriptionPreview=asr;
    renderSettingsNetwork(latestCapture,latestCapture?.running?latestCapture.transcription:asr);
    $('settings-network-message').textContent='Connection check complete.';
  }catch{
    renderSettingsNetwork(null,null);
    $('settings-network-message').textContent='Could not reach TINA Desktop. Start the local service and try again.';
  }finally{button.disabled=false;}
});

// Settings state & persistence
const AUTO_PASTE_KEY='tina.dictation.auto_paste';
const DICTATION_MODE_KEY='tina.dictation.mode';
const AUDIO_SOURCE_KEY='tina.audio_source';
const LIVE_TARGET_KEY='tina.live_translation.target';
const LIVE_OUTPUT_KEY='tina.live_translation.output';

function setAudioSource(value,persist=true){
  const source=normalizeAudioSource(value);
  const microphone=$('microphone'),system=$('system');
  if(microphone)microphone.checked=source!=='system';
  if(system)system.checked=source!=='microphone';
  const liveSource=$('live-source'),settingsSource=$('setting-audio-source');
  if(liveSource)liveSource.value=source;
  if(settingsSource)settingsSource.value=source;
  if(persist)localStorage.setItem(AUDIO_SOURCE_KEY,source);
  return source;
}

function initSettingsControls(){
  const chimesInput=$('setting-chimes-enabled');
  if(chimesInput){
    chimesInput.checked=chimesEnabled;
    chimesInput.addEventListener('change',()=>{
      chimesEnabled=chimesInput.checked;
      localStorage.setItem(CHIMES_KEY,String(chimesEnabled));
    });
  }

  const testChimesBtn=$('btn-test-chimes');
  if(testChimesBtn){
    testChimesBtn.addEventListener('click',()=>{
      playChime('record-start',true);
      setTimeout(()=>playChime('record-end',true),750);
    });
  }

  const savedMode=localStorage.getItem(DICTATION_MODE_KEY)||'polish';
  const polishCard=$('mode-card-polish');
  const faithfulCard=$('mode-card-faithful');
  function updateDictationMode(mode){
    for(const card of [polishCard,faithfulCard]){
      if(!card)continue;
      const selected=card.dataset.mode===mode;
      card.classList.toggle('active',selected);
      card.setAttribute('aria-pressed',String(selected));
    }
    localStorage.setItem(DICTATION_MODE_KEY,mode);
  }
  updateDictationMode(savedMode);
  if(polishCard)polishCard.addEventListener('click',()=>updateDictationMode('polish'));
  if(faithfulCard)faithfulCard.addEventListener('click',()=>updateDictationMode('faithful'));

  const autoPasteInput=$('setting-auto-paste');
  if(autoPasteInput){
    autoPasteInput.checked=localStorage.getItem(AUTO_PASTE_KEY)!=='false';
    autoPasteInput.addEventListener('change',()=>{
      localStorage.setItem(AUTO_PASTE_KEY,String(autoPasteInput.checked));
    });
  }

  const audioSourceSelect=$('setting-audio-source');
  if(audioSourceSelect){
    setAudioSource(localStorage.getItem(AUDIO_SOURCE_KEY)||'both',false);
    audioSourceSelect.addEventListener('change',()=>setAudioSource(audioSourceSelect.value));
  }

}

function renderDiagnostics(capture,asr){
  const state=!capture.running?(capture.error?'Error':'Idle'):capture.paused?'Paused':capture.capturing?'Capturing':'Connecting';
  $('diagnostic-state').textContent=state;
  $('capture-diagnostics').dataset.state=state.toLowerCase();
  $('diagnostic-microphone').textContent=!capture.microphone?'Not selected':!capture.running?'Ready · not recording':!capture.capturing?'Waiting for capture stream':capture.paused?'Paused':capture.level>0.005?`Signal detected · ${Math.round(capture.level*100)}% RMS`:'Stream active · no mic signal right now';
  $('diagnostic-system').textContent=!capture.system_audio?'Not selected':capture.capturing?'Included in active stream':capture.running?'Waiting for capture stream':'Ready · not recording';
  $('diagnostic-desktop').textContent=capture.running?(capture.meeting?'Connected · session accepted':'Connecting to local TINA Desktop'):asr&&asr.configured!==false?'Available · not connected': 'Unavailable · check TINA Desktop';
  $('diagnostic-delivery').textContent=capture.running?`${capture.frames.toLocaleString()} packets sent · ${capture.dropped.toLocaleString()} dropped`:capture.frames?`Last session · ${capture.frames.toLocaleString()} packets sent · ${capture.dropped.toLocaleString()} dropped`:'No packets sent yet';
  $('diagnostic-processing').textContent=audioProcessingLabel(capture);
  const error=capture.error||actionError;
  if(error&&error!==lastDiagnosticError)$('capture-diagnostics').open=true;
  lastDiagnosticError=error||'';
}

function liveTranslationKey(session,segment,target){
  return `${session}|${segment.id}|${target}|${segment.text}`;
}

function resetLiveTranslations(){
  liveTranslationQueue.length=0;
  liveTranslationQueued.clear();
  liveTranslationDone.clear();
  liveTranslationFailed.clear();
  $('live-translation-error').hidden=true;
  $('live-translation-retry').hidden=true;
}

function queueLiveTranslations(capture,snapshot){
  const target=capture?.translation_target;
  if(!capture?.running||!capture.live_translation||!target)return;
  for(const segment of (snapshot?.segments||[]).slice(-20)){
    if(!segment.id||!segment.text?.trim()||segment.translation?.target_language===target)continue;
    const key=liveTranslationKey(capture.meeting,segment,target);
    if(liveTranslationDone.has(key)||liveTranslationFailed.has(key)||liveTranslationQueued.has(key))continue;
    if(liveTranslationQueue.length>=20)break;
    liveTranslationQueued.add(key);
    liveTranslationQueue.push({key,session:capture.meeting,captionId:segment.id,text:segment.text,target});
  }
  void drainLiveTranslations();
}

async function drainLiveTranslations(){
  if(liveTranslationBusy)return;
  liveTranslationBusy=true;
  while(liveTranslationQueue.length){
    const item=liveTranslationQueue.shift();
    if(!item)continue;
    if(latestCapture?.meeting!==item.session||latestCapture?.translation_target!==item.target){
      liveTranslationQueued.delete(item.key);
      continue;
    }
    try{
      await invoke('translate_live_caption',{
        captionId:item.captionId,
        sourceText:item.text,
        targetLanguage:item.target,
        session:item.session
      });
      liveTranslationDone.add(item.key);
    }catch{
      liveTranslationFailed.add(item.key);
      if(latestCapture?.meeting===item.session&&latestCapture?.translation_target===item.target&&liveTarget===item.target){
        $('live-translation-error').textContent='Translation is unavailable. Check TINA Agent and model settings.';
        $('live-translation-error').hidden=false;
        $('live-translation-retry').hidden=false;
        liveTranslationQueue.length=0;
      }
    }finally{
      liveTranslationQueued.delete(item.key);
    }
  }
  liveTranslationBusy=false;
}

function renderLiveCaptions(capture,snapshot){
  const target=capture?.translation_target||'';
  const segments=Array.isArray(snapshot?.segments)?snapshot.segments:[];
  const rows=segments.map(segment=>{
    const row=document.createElement('li');
    row.className='live-caption-row';
    const meta=document.createElement('div');
    meta.className='live-caption-meta';
    const speaker=document.createElement('span');
    speaker.textContent=segment.speaker||'Audio';
    const time=document.createElement('time');
    const start=Number(segment.start),end=Number(segment.end);
    const stamp=value=>{
      const date=new Date(value*1000);
      return Number.isFinite(value)&&Number.isFinite(date.getTime())
        ?date.toLocaleTimeString(undefined,{hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit'})
        :'—';
    };
    time.textContent=`${stamp(start)} – ${stamp(end)}`;
    meta.append(speaker,time);
    const original=document.createElement('p');
    original.className='live-caption-original';
    original.textContent=segment.text||'';
    row.append(meta,original);
    if(target){
      const available=segment.translation?.target_language===target&&segment.translation?.text;
      const key=liveTranslationKey(capture?.meeting,segment,target);
      const translationText=available?segment.translation.text
        :liveTranslationFailed.has(key)?'Translation unavailable'
          :liveTranslationQueued.has(key)?'Translating…':'';
      if(translationText){
        const translated=document.createElement('p');
        translated.className=available?'live-caption-translation':'live-caption-waiting';
        translated.textContent=translationText;
        row.append(translated);
      }
    }
    return row;
  });
  const pending=String(snapshot?.pending||'').trim();
  $('live-transcript').replaceChildren(...rows);
  $('live-transcript-empty').hidden=rows.length>0||Boolean(pending);
  $('live-transcript-count').textContent=`${rows.length} ${rows.length===1?'segment':'segments'}`;
  $('live-pending').hidden=!pending;
  $('live-pending').textContent=pending?`Live draft · ${pending}`:'';
  if(snapshot?.error&&capture?.running){
    $('live-session-detail').textContent=snapshot.error;
  }
}

async function setSubtitleOverlay(visible){
  const state=await overlaySnapshot();
  if(Boolean(state?.subtitles)!==visible)await invoke('toggle_subtitles');
}

function setLiveOutputMode(mode,updateOverlay=true){
  liveOutputMode=mode==='subtitle'?'subtitle':'transcript';
  localStorage.setItem(LIVE_OUTPUT_KEY,liveOutputMode);
  $('live-mode-transcript').classList.toggle('active',liveOutputMode==='transcript');
  $('live-mode-transcript').setAttribute('aria-pressed',String(liveOutputMode==='transcript'));
  $('live-mode-subtitle').classList.toggle('active',liveOutputMode==='subtitle');
  $('live-mode-subtitle').setAttribute('aria-pressed',String(liveOutputMode==='subtitle'));
  if(updateOverlay&&latestCapture?.running&&latestCapture.live_translation){
    void setSubtitleOverlay(liveOutputMode==='subtitle').catch(()=>{});
  }
}

function initializeLiveTranslationControls(){
  liveTarget=localStorage.getItem(LIVE_TARGET_KEY)||'off';
  if(!['off','en','vi','ja','ko','zh-CN','es','fr','de'].includes(liveTarget))liveTarget='off';
  $('live-target').value=liveTarget;
  const savedOutput=localStorage.getItem(LIVE_OUTPUT_KEY)||'transcript';
  setLiveOutputMode(savedOutput,false);
  setAudioSource(localStorage.getItem(AUDIO_SOURCE_KEY)||'both',false);
  $('live-source').addEventListener('change',()=>setAudioSource($('live-source').value));
  const syncSourceChecks=()=>{
    const microphone=$('microphone').checked,system=$('system').checked;
    if(microphone||system)setAudioSource(microphone?(system?'both':'microphone'):'system');
  };
  $('microphone').addEventListener('change',()=>{
    syncSourceChecks();
  });
  $('system').addEventListener('change',()=>{
    syncSourceChecks();
  });
  $('live-target').addEventListener('change',async()=>{
    liveTarget=$('live-target').value;
    localStorage.setItem(LIVE_TARGET_KEY,liveTarget);
    resetLiveTranslations();
    if(latestCapture?.running&&latestCapture.live_translation){
      try{
        await invoke('set_live_translation_target',{targetLanguage:liveTarget==='off'?null:liveTarget});
      }catch(e){
        $('live-translation-error').textContent=String(e);
        $('live-translation-error').hidden=false;
      }
      await refresh();
    }
  });
  $('live-mode-transcript').addEventListener('click',()=>setLiveOutputMode('transcript'));
  $('live-mode-subtitle').addEventListener('click',()=>setLiveOutputMode('subtitle'));
  $('live-start').addEventListener('click',async()=>{
    if(busy||latestCapture?.running)return;
    const sources=audioSourceFlags($('live-source').value);
    busy=true;
    $('live-start').disabled=true;
    $('live-translation-error').hidden=true;
    resetLiveTranslations();
    try{
      await invoke('start_capture',startCaptureArgs({
        ...sources,
        dictation:false,
        liveTranslation:true,
        translationTarget:liveTarget==='off'?null:liveTarget
      }));
      if(liveOutputMode==='subtitle')await setSubtitleOverlay(true);
      actionError='';
    }catch(e){
      $('live-translation-error').textContent=String(e);
      $('live-translation-error').hidden=false;
    }finally{busy=false;await refresh();}
  });
  $('live-stop').addEventListener('click',async()=>{
    if(busy)return;
    busy=true;
    try{await invoke('stop_capture');}
    catch(e){actionError=String(e);$('error').textContent=actionError;}
    finally{busy=false;await refresh();}
  });
  $('live-pause').addEventListener('click',()=>action(paused?'resume_capture':'pause_capture'));
  $('live-subtitles-toggle').addEventListener('click',async()=>{
    if(busy)return;
    busy=true;
    try{await invoke('toggle_subtitles');}
    catch(e){$('live-translation-error').textContent=String(e);$('live-translation-error').hidden=false;}
    finally{busy=false;await refresh();}
  });
  $('live-translation-retry').addEventListener('click',()=>{
    liveTranslationFailed.clear();
    liveTranslationDone.clear();
    liveTranslationQueue.length=0;
    liveTranslationQueued.clear();
    $('live-translation-error').hidden=true;
    queueLiveTranslations(latestCapture,liveSnapshot);
  });
  $('live-save').addEventListener('click',async()=>{
    if(busy)return;
    busy=true;$('live-save').disabled=true;
    try{
      const path=await invoke('export_transcript');
      savedPath=path;
      $('live-save-result').textContent=`Saved ${String(path).split('/').pop()}`;
      $('live-reveal').hidden=false;
    }catch(e){$('live-translation-error').textContent=String(e);$('live-translation-error').hidden=false;}
    finally{busy=false;await refresh();}
  });
  $('live-reveal').addEventListener('click',async()=>{
    if(!savedPath)return;
    try{await invoke('reveal_path',{path:savedPath});}catch(e){$('live-translation-error').textContent=String(e);$('live-translation-error').hidden=false;}
  });
}

for(const section of ['accessibility','microphone','screen-audio']){
  $(`${section}-settings`)?.addEventListener('click',async()=>{
    const helpEl = $(`${section}-help`);
    if(helpEl) helpEl.hidden=false;
    try{
      const pathEl = $(`${section}-app-path`);
      if(pathEl) pathEl.textContent=await invoke('capture_app_path');
      await invoke('open_privacy_settings',{section});
    }
    catch(e){$('error').textContent=String(e);}
  });
  $(`${section}-show-app`)?.addEventListener('click',async()=>{
    try{await invoke('reveal_capture_app');}
    catch(e){$('error').textContent=String(e);}
  });
  $(`${section}-copy-path`)?.addEventListener('click',async()=>{
    try{
      const path=await invoke('capture_app_path');
      await writeText(path);
      const btn = $(`${section}-copy-path`);
      if(btn){
        btn.textContent='Copied';
        setTimeout(()=>btn.textContent='Copy app path',1200);
      }
    }catch(e){$('error').textContent=String(e);}
  });
  $(`${section}-recheck`)?.addEventListener('click',()=>void refreshPermissions(latestCapture));
}

$('settings-show-app')?.addEventListener('click',async()=>{
  try{await invoke('reveal_capture_app');}
  catch(e){
    const msg=$('settings-data-message');
    if(msg)msg.textContent=String(e);
  }
});
$('settings-copy-path')?.addEventListener('click',async()=>{
  try{
    const path=await invoke('capture_app_path');
    await writeText(path);
    const btn=$('settings-copy-path');
    if(btn){
      btn.textContent='Copied!';
      setTimeout(()=>{btn.textContent='Copy app path';},1500);
    }
  }catch(e){
    const msg=$('settings-data-message');
    if(msg)msg.textContent=String(e);
  }
});

window.addEventListener('focus',()=>void refreshPermissions(latestCapture));

async function refresh(){
  if(polling)return;
  polling=true;
  try{
    const s=await invoke('capture_status');
    latestCapture=s;
    const overlay=await overlaySnapshot();
    if(s.live_translation&&!s.running&&overlay?.subtitles)void invoke('toggle_subtitles').catch(()=>{});
    paused=Boolean(s.paused);
    if((s.meeting||'')!==meetingId){
      meetingId=s.meeting||'';
      savedPath='';
      $('save-result').textContent='';
      $('live-save-result').textContent='';
      $('reveal').hidden=true;
      $('live-reveal').hidden=true;
      liveSnapshot=null;
      resetLiveTranslations();
    }
    if(!s.running&&Date.now()-previewAt>5000){
      previewAt=Date.now();
      try{transcriptionPreview=await invoke('transcription_config');}
      catch{transcriptionPreview=null;}
    }
    const asr=s.running?s.transcription:transcriptionPreview;
    $('asr').textContent=asr&&asr.configured!==false?`ASR · ${asr.label}`:s.running?'ASR · Connecting…':'ASR · Unavailable';
    renderSettingsNetwork(s,asr);
    void refreshPermissions(s);
    renderDiagnostics(s,asr);
    const isHandsFree=Boolean(activeDictation?.handsFree);
    $('state').textContent=!s.running?'Ready':s.dictation?(s.capturing?(isHandsFree?'Listening (Hands-free)':'Listening'):'Connecting…'):(s.paused?'Paused':s.capturing?'Recording':'Connecting…');
    $('dictation-activity').textContent=s.capturing&&s.dictation?(isHandsFree?'Hands-free dictation active · Tap Fn or Esc to stop':'Let go when you’re done'):s.running&&s.dictation?'Waiting for macOS…':activeDictation?.released?'Finishing up…':dictationResult||'Your mic is ready.';
    $('dictation-toggle').textContent=s.running&&s.dictation?'Stop dictation':'Start dictation';
    $('dictation-toggle').setAttribute('aria-pressed',String(Boolean(s.running&&s.dictation)));
    $('dictation-panel').dataset.active=String(Boolean(s.capturing&&s.dictation));
    $('dictation-panel').dataset.handsFree=String(Boolean(s.capturing&&s.dictation&&isHandsFree));
    $('error').textContent=s.error||actionError;
    $('start').disabled=busy||s.running;
    $('stop').disabled=busy||!s.running;
    $('start').hidden=s.running;
    $('stop').hidden=!s.running;
    $('sources').disabled=busy||s.running;
    $('pause').hidden=!s.running||s.dictation;
    $('pause').disabled=busy;
    $('pause').textContent=s.paused?'Resume':'Pause';
    $('captions').hidden=!s.running||s.dictation;
    $('captions').disabled=busy;
    setCaptions(Boolean(overlay&&overlay.subtitles));
    $('recording').hidden=!s.running||s.dictation;
    if(s.running&&!s.dictation){
      $('elapsed').textContent=clock(s.elapsed_ms);
      $('record-state').textContent=s.paused?'Paused':s.capturing?'Recording':'Connecting…';
      $('record-state').dataset.paused=String(Boolean(s.paused));
      $('level-fill').style.transform=`scaleX(${s.paused?0:meter(s.level).toFixed(3)})`;
    }
    const liveActive=Boolean(s.live_translation&&s.running);
    $('live-start').disabled=busy||s.running;
    $('live-start').hidden=liveActive;
    $('live-stop').hidden=!liveActive;
    $('live-stop').disabled=busy;
    $('live-pause').hidden=!liveActive;
    $('live-pause').disabled=busy;
    $('live-pause').textContent=s.paused?'Resume':'Pause';
    $('live-subtitles-toggle').hidden=!liveActive;
    $('live-subtitles-toggle').disabled=busy;
    $('live-subtitles-toggle').setAttribute('aria-pressed',String(Boolean(overlay&&overlay.subtitles)));
    $('live-subtitles-toggle').textContent=overlay&&overlay.subtitles?'Hide subtitles':'Show subtitles';
    $('live-source').disabled=busy||s.running;
    $('live-target').disabled=busy||(s.running&&!s.live_translation);
    $('setting-audio-source').disabled=busy||s.running;
    $('live-save').disabled=busy||!s.meeting||s.dictation;
    $('live-reveal').hidden=!savedPath;
    $('live-session-card').dataset.active=String(liveActive);
    $('live-session-dot').dataset.active=String(liveActive&&!s.paused);
    $('live-session-state').textContent=liveActive?(s.paused?'Paused':s.capturing?'Live session':'Connecting…')
      :s.live_translation&&s.meeting?'Session finished':s.running?'Another capture session is active':'Ready';
    $('live-elapsed').textContent=s.live_translation&&s.meeting?clock(s.elapsed_ms):'00:00';
    $('live-session-detail').textContent=s.running&&!s.live_translation
      ?'Stop the active Dictation or Meeting session before starting Live Translation.'
      :s.live_translation&&s.meeting?'Transcript is available in this session. Translation is a temporary display layer.'
        :'Choose an audio source and target language, then start a session.';
    if(s.live_translation&&s.meeting&&s.running&&s.translation_target!==undefined){
      const target=s.translation_target||'off';
      if($('live-target').value!==target){liveTarget=target;$('live-target').value=target;}
    }
    if(s.live_translation&&s.meeting){
      liveSnapshot=await invoke('captions_snapshot',{limit:400});
      renderLiveCaptions(s,liveSnapshot);
      queueLiveTranslations(s,liveSnapshot);
      if(liveSnapshot.error&&s.running)$('live-session-detail').textContent=liveSnapshot.error;
    }else{
      liveSnapshot=null;
      renderLiveCaptions(null,null);
    }
    const apps=overlay&&Array.isArray(overlay.apps)?overlay.apps:[];
    $('detected').hidden=Boolean(s.running||s.dictation||!apps.length);
    if(!$('detected').hidden){
      $('detected-text').textContent=`${detectedText(apps)} A floating prompt can start capture.`;
    }
    const hasMeetingApp=apps.length>0&&!s.running&&!s.dictation;
    const banner=$('meeting-detect-banner');
    if(banner){
      banner.hidden=!hasMeetingApp||meetingBannerDismissed;
      if(hasMeetingApp&&!meetingBannerDismissed){
        const appName=apps[0].name||'Cuộc họp';
        const bannerApp=$('meeting-banner-app');
        if(bannerApp)bannerApp.textContent=appName;
        const bannerIcon=$('meeting-banner-icon');
        if(bannerIcon){
          const lower=appName.toLowerCase();
          if(lower.includes('zoom'))bannerIcon.style.background='#2D8CFF';
          else if(lower.includes('teams'))bannerIcon.style.background='#6264A7';
          else if(lower.includes('meet')||lower.includes('chrome'))bannerIcon.style.background='#00AC47';
          else if(lower.includes('slack'))bannerIcon.style.background='#4A154B';
          else bannerIcon.style.background='#22c55e';
        }
      }
    }
    $('save').disabled=busy||!s.meeting||s.dictation;
    $('reveal').hidden=!savedPath;

    if(s.meeting&&s.running&&!s.dictation&&captionsOn){
      const snap=await invoke('captions_snapshot',{limit:2});
      const last=(snap.segments||[]).slice(-1)[0];
      const pending=String(snap.pending||'').trim();
      $('live-line').hidden=false;
      $('live-line').dataset.pending=String(Boolean(pending));
      $('live-line').textContent=pending||last?.text||(snap.error?'Captions paused — retrying…':'Listening for speech…');
    }else{
      $('live-line').hidden=true;
      $('live-line').textContent='';
    }

    if(s.meeting){
      const data=await invoke('capture_transcript');
      const key=JSON.stringify(data.segments);
      if(key!==previousTranscript){
        previousTranscript=key;
        const rows=data.segments.map(segment=>{
          const row=document.createElement('li'),meta=document.createElement('div'),time=document.createElement('time'),speaker=document.createElement('span'),text=document.createElement('span');
          const stamp=value=>{const seconds=Number(value),date=new Date(seconds*1000);return Number.isFinite(seconds)&&Number.isFinite(date.getTime())?date.toLocaleTimeString(undefined,{hourCycle:'h23',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:2}):'—';};
          meta.className='transcript-meta';
          time.className='transcript-time-range';
          time.textContent=`${stamp(segment.start)} – ${stamp(segment.end)}`;
          const speakerName=segment.speaker||'Audio';
          speaker.className=`transcript-speaker${speakerName==='You'?' is-you':''}`;
          speaker.textContent=speakerName;
          text.textContent=segment.text||'';
          meta.append(time,speaker);row.append(meta,text);return row;
        });
        $('transcript').replaceChildren(...rows);$('empty').hidden=rows.length>0;$('transcript-count').textContent=`${rows.length} ${rows.length===1?'segment':'segments'}`;
      }
    }
  }catch(e){$('error').textContent=String(e);}
  finally{polling=false;}
}

async function action(command,args){
  busy=true;$('start').disabled=true;$('stop').disabled=true;
  actionError='';
  try{await invoke(command,args);}catch(e){actionError=String(e);$('error').textContent=actionError;}
  finally{busy=false;await refresh();}
}

$('start').addEventListener('click',()=>action('start_capture',startCaptureArgs({
  microphone:$('microphone').checked,
  systemAudio:$('system').checked,
  dictation:false
})));
$('stop').addEventListener('click',()=>action('stop_capture'));
$('pause').addEventListener('click',()=>action(paused?'resume_capture':'pause_capture'));
$('captions').addEventListener('click',async()=>{
  if(busy)return;
  busy=true;$('captions').disabled=true;
  try{setCaptions(await invoke('toggle_subtitles'));actionError='';}
  catch(e){actionError=String(e);$('error').textContent=actionError;}
  finally{busy=false;await refresh();}
});
$('save').addEventListener('click',async()=>{
  if(busy)return;
  busy=true;$('save').disabled=true;
  try{
    const path=await invoke('export_transcript');
    savedPath=path;
    $('save-result').textContent=`Saved ${String(path).split('/').pop()}`;
    $('reveal').hidden=false;
    actionError='';
  }catch(e){actionError=e instanceof Error?e.message:String(e);$('error').textContent=actionError;}
  finally{busy=false;await refresh();}
});
$('reveal').addEventListener('click',async()=>{
  if(!savedPath)return;
  try{await invoke('reveal_path',{path:savedPath});}
  catch(e){actionError=String(e);$('error').textContent=actionError;}
});

let meetingBannerDismissed = false;
$('meeting-banner-dismiss')?.addEventListener('click', () => {
  meetingBannerDismissed = true;
  const banner = $('meeting-detect-banner');
  if (banner) banner.hidden = true;
  invoke('overlay_action', { action: 'dismiss' }).catch(() => {});
});
$('meeting-banner-record')?.addEventListener('click', async () => {
  switchMode('meeting');
  meetingBannerDismissed = true;
  const banner = $('meeting-detect-banner');
  if (banner) banner.hidden = true;
  $('start')?.click();
});

function switchMode(targetMode){
  ['dictation', 'meeting', 'live-translation', 'history'].forEach(m => {
    const panel = $(`${m}-panel`);
    if(panel) panel.hidden = (m !== targetMode);
  });
  document.querySelectorAll('.nav-item[data-mode]').forEach(tab => {
    const selected = tab.dataset.mode === targetMode;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-pressed', String(selected));
  });
  if(targetMode === 'history'){
    renderDictationHistory();
  }
  if(targetMode === 'dictation')renderDictationHome();
  if(targetMode==='live-translation'&&liveOutputMode==='subtitle'&&latestCapture?.running&&latestCapture.live_translation){
    void setSubtitleOverlay(true).catch(()=>{});
  }
  void refresh();
}
document.querySelectorAll('.nav-item[data-mode]').forEach(button => {
  button.addEventListener('click', () => switchMode(button.dataset.mode));
});

// ─── Dictation History Hub ───
const HISTORY_KEY = 'tina.dictation.history';

function getDictationHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveDictationHistory(text, original, mode) {
  if (!text || !text.trim()) return;
  const history = getDictationHistory();
  const newEntry = {
    id: Date.now().toString(),
    text: text.trim(),
    original: (original && original !== text) ? original.trim() : '',
    mode: mode || 'polish',
    timestamp: Date.now(),
    charCount: text.trim().length,
    wordCount: text.trim().split(/\s+/).filter(Boolean).length
  };
  const updated = [newEntry, ...history.filter(h => h.text !== newEntry.text)].slice(0, 100);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(updated));
  renderDictationHistory();
  renderDictationHome();
}

function formatRelativeTime(ts) {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return 'Vừa xong';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`;
  const d = new Date(ts);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function renderDictationHome(){
  const history=getDictationHistory().filter(item=>item&&typeof item.text==='string');
  const wordCount=history.reduce((total,item)=>total+(Number(item.wordCount)||item.text.trim().split(/\s+/).filter(Boolean).length),0);
  $('dictation-stat-count').textContent=history.length.toLocaleString();
  $('dictation-stat-words').textContent=wordCount.toLocaleString();
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderDictationHistory(query = '') {
  const listEl = $('history-list');
  const emptyEl = $('history-empty');
  if (!listEl) return;
  
  let history = getDictationHistory();
  if (query) {
    const q = query.toLowerCase();
    history = history.filter(h => h.text.toLowerCase().includes(q) || (h.original && h.original.toLowerCase().includes(q)));
  }

  if (!history.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.hidden = false;
    return;
  }

  if (emptyEl) emptyEl.hidden = true;
  listEl.innerHTML = history.map(item => `
    <div class="history-card" data-history-id="${item.id}" role="listitem">
      <div class="history-card-header">
        <div class="history-card-meta">
          <span class="badge ${item.mode === 'polish' ? 'badge-accent' : 'badge-muted'}">${item.mode === 'polish' ? 'AI Polish' : 'Verbatim'}</span>
          <span>${formatRelativeTime(item.timestamp)}</span>
          <span>·</span>
          <span>${item.wordCount} từ (${item.charCount} ký tự)</span>
        </div>
      </div>
      <div class="history-card-body">${escapeHtml(item.text)}</div>
      ${item.original ? `<div class="history-card-raw">Gốc: ${escapeHtml(item.original)}</div>` : ''}
      <div class="history-card-actions">
        <button class="secondary compact-btn action-copy" type="button" data-text="${escapeHtml(item.text)}" aria-label="Sao chép bản chép lời">
          <svg viewBox="0 0 24 24" class="btn-icon" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span class="btn-copy-label">Sao chép</span>
        </button>
        <button class="ghost compact-btn action-delete" type="button" data-id="${item.id}" title="Xóa" aria-label="Xóa mục đọc chính tả">
          <svg viewBox="0 0 24 24" class="btn-icon" style="width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  listEl.querySelectorAll('.action-copy').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.text;
      const label = btn.querySelector('.btn-copy-label');
      try {
        await writeText(text);
        btn.dataset.copied = 'true';
        btn.setAttribute('aria-label', 'Đã sao chép bản chép lời');
        if (label) label.textContent = 'Đã chép! ✓';
        setTimeout(() => {
          delete btn.dataset.copied;
          btn.setAttribute('aria-label', 'Sao chép bản chép lời');
          if (label) label.textContent = 'Sao chép';
        }, 1500);
      } catch (error) {
        actionError = error instanceof Error ? error.message : String(error);
        $('error').textContent = actionError;
      }
    });
  });

  listEl.querySelectorAll('.action-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const history = getDictationHistory().filter(h => h.id !== id);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
      renderDictationHistory($('history-search')?.value.trim() || '');
      renderDictationHome();
    });
  });
}

$('history-search')?.addEventListener('input', () => {
  renderDictationHistory($('history-search').value.trim());
});

$('history-clear-all')?.addEventListener('click', () => {
  if (confirm('Bạn có chắc muốn xóa toàn bộ lịch sử đọc chính tả không?')) {
    localStorage.removeItem(HISTORY_KEY);
    renderDictationHistory();
    renderDictationHome();
  }
});

const CHIMES_KEY='tina.chimes.enabled';
let chimesEnabled=localStorage.getItem(CHIMES_KEY)!=='false';

function playChime(type,preview=false){
  if(!shouldPlayChime(chimesEnabled,preview))return;
  try{
    const audio=new Audio(`audio/${type}.wav`);
    audio.volume=0.55;
    audio.play().catch(()=>{});
  }catch{}
}

async function finishDictation(run){
  if(run.finishing||!run.started)return;
  run.finishing=true;
  try{
    await invoke('stop_capture');
    dictationResult='Transcribing speech…';
    await refresh();
    const deadline=Date.now()+10000;
    let text='',stableSince=0;
    while(Date.now()<deadline){
      const data=await invoke('capture_transcript');
      const next=(data.segments||[]).map(s=>String(s.text||'').trim()).filter(Boolean).join(' ').trim();
      if(next!==text){text=next;stableSince=text?Date.now():0;}
      if(text&&Date.now()-stableSince>=1000)break;
      await wait(200);
    }
    if(!text){
      dictationResult='No speech detected';
      playChime('record-end');
      return;
    }
    const rawText=text;
    const mode=localStorage.getItem(DICTATION_MODE_KEY)||'polish';
    let processed={text:rawText,polished:false,unavailable:false};
    if(mode==='faithful'){
      dictationOriginal='';
      $('dictation-original').hidden=true;
    }else{
      dictationResult='Polishing transcript…';
      await refresh();
      processed=await window.TinaDictation.polishOrKeepRaw(
        rawText,
        raw=>invoke('polish_dictation',{text:raw})
      );
      text=processed.text;
      dictationOriginal=processed.polished?rawText:'';
      $('dictation-original').hidden=!dictationOriginal;
    }

    saveDictationHistory(text, dictationOriginal, mode);
    
    const autoPasteEnabled=localStorage.getItem(AUTO_PASTE_KEY)!=='false';
    const shouldPaste=capturePlatform!=='windows'&&run.pasteToActiveApp&&autoPasteEnabled;
    if(shouldPaste){
      dictationResult='Inserting text…';
      await refresh();
      try{
        await invoke('insert_text_to_active_app',{text});
      }catch{
        await writeText(text);
        await wait(80);
        await invoke('paste_active_app');
      }
    }else{
      await writeText(text);
    }

    playChime('record-end');
    
    dictationResult=processed.unavailable
      ?(processed.polished
          ?`${shouldPaste?'Pasted':'Copied'} formatted transcript · AI offline`
          :`${shouldPaste?'Pasted':'Copied'} raw transcript · AI polish unavailable`)
      :processed.polished
        ?`${shouldPaste?'Pasted':'Copied'} polished transcript`
        :shouldPaste?'Pasted':'Copied to clipboard';
    actionError='';
  }catch(e){
    playChime('record-end');
    actionError=e instanceof Error?e.message:String(e);
  }
  finally{
    dictationMachine.reset();
    if(activeDictation===run)activeDictation=null;
    await refresh();
  }
}

function startDictation(runInfo={}){
  if(activeDictation)return;
  playChime('record-start');
  dictationResult='';
  dictationOriginal='';
  $('dictation-original').hidden=true;
  const run={
    started:false,
    released:false,
    finishing:false,
    pasteToActiveApp:false,
    handsFree:Boolean(runInfo?.handsFree)
  };
  activeDictation=run;
  run.start=invoke('start_capture',startCaptureArgs({
    microphone:true,
    systemAudio:false,
    dictation:true
  }))
    .then(pasteToActiveApp=>{
      run.started=true;
      run.pasteToActiveApp=pasteToActiveApp;
      if(run.released)void finishDictation(run);
      else void refresh();
    })
    .catch(e=>{
      if(activeDictation===run)activeDictation=null;
      dictationMachine.reset();
      actionError=e instanceof Error?e.message:String(e);
      void refresh();
    });
}

async function cancelDictation(){
  if(activeDictation){
    const run=activeDictation;
    activeDictation=null;
    dictationMachine.reset();
    try{await invoke('stop_capture');}catch{}
    playChime('record-end');
    dictationResult='Dictation cancelled';
    await refresh();
  }
}

const dictationMachine=window.TinaDictation.createDictationStateMachine({
  onStartCapture:(runInfo)=>{startDictation(runInfo);},
  onStopCapture:()=>{
    if(activeDictation&&!activeDictation.released){
      activeDictation.released=true;
      if(activeDictation.started){void finishDictation(activeDictation);}
    }
  },
  onCancel:()=>{void cancelDictation();},
  onModeChange:(mode)=>{
    if(activeDictation&&mode==='hands-free'){activeDictation.handsFree=true;}
    void refresh();
  },
  onStateChange:()=>{void refresh();}
});

$('dictation-original').addEventListener('click',async()=>{
  if(!dictationOriginal)return;
  try{
    await writeText(dictationOriginal);
    dictationResult='Original transcript copied to clipboard';
    actionError='';
  }catch(e){actionError=e instanceof Error?e.message:String(e);}
  await refresh();
});

const dictationCard=document.querySelector('.dictation-card');
if(dictationCard){
  dictationCard.addEventListener('click',e=>{
    if(e.target.closest('#dictation-original')||e.target.closest('#dictation-toggle'))return;
    dictationMachine.handleToggleClick();
  });
}
$('dictation-toggle').addEventListener('click',e=>{
  e.stopPropagation();
  dictationMachine.handleToggleClick();
});

window.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    dictationMachine.handleEscape();
  }
});

const fnStatus={
  checking:'Checking Fn shortcut…',
  ready:'Fn ready · Hold or Double-tap to dictate',
  'needs-accessibility':'Accessibility needed for Fn · restart after enabling',
  unavailable:'Fn shortcut unavailable',
  unsupported:'Fn is only available on Mac'
};
Promise.all([
  listen('fn-shortcut-state',event=>{
    if(event.payload){
      dictationMachine.handleKeyDown();
    }else{
      dictationMachine.handleKeyUp();
    }
  }),
  listen('fn-shortcut-status',event=>{$('hotkey').textContent=fnStatus[event.payload]||fnStatus.unavailable;})
]).then(()=>invoke('fn_shortcut_status')).then(status=>{
  $('hotkey').textContent=fnStatus[status]||fnStatus.unavailable;
}).catch(e=>{
  $('hotkey').textContent=`Fn shortcut unavailable: ${String(e)}`;
});

async function checkInitialPermissions(){
  try{
    const p=await invoke('permissions_status');
    const isMicGranted=p.microphone==='authorized'||p.microphone==='granted';
    const isAccessibilityGranted=Boolean(p.accessibility);
    const isScreenAudioGranted=Boolean(p.screenAudio);
    const allGranted=isMicGranted&&isAccessibilityGranted&&isScreenAudioGranted;
    const sessionPrompted=sessionStorage.getItem('tina.permissions_prompted');
    if(!allGranted&&!sessionPrompted){
      sessionStorage.setItem('tina.permissions_prompted','true');
      openSettings('permissions');
    }
  }catch{}
}

window.TinaApp = {
  openSettings,
  checkInitialPermissions
};

void refreshPermissions();
initSettingsControls();
initializeLiveTranslationControls();
renderDictationHome();
void checkInitialPermissions();

setInterval(refresh,1000);
refresh();
