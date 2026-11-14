/** In-bot voice orchestration. Native inference is isolated from the transcript event loop. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Invocation } from './config.js';
import type { Act } from './contracts.js';
import type { SpeakController } from './capture-bridge.js';
import { VoiceTrigger, speechSentences, turnPauseMs, voiceProgressNotice, VOICE_NOTICES, VOICE_SERVICE_ERROR, isFixedVoiceNotice, type VoiceHypothesis } from './voice-trigger.js';
import {VoiceInterruption, mergeVoiceRefinement, isVoiceRefinement} from './voice-interruption.js';
import type { SpeechReporter } from './speech-status.js';
import { AudioDiagnostics, type AudioSnapshot } from './audio-diagnostics.js';
import type { AsrDiagnostic } from '@tina/gmeet-pipeline';
import {NoiseSuppressor,type NoiseFrame} from './noise-suppression.js';
import { TurnShadow } from './turn-shadow.js';
import { VadShadow } from './vad-shadow.js';
import type { PreparedSpeech, SpeechTiming } from './tts-playback.js';

const FOLLOW_UP_MS = 5_000;
const ACK_TIMEOUT_MS = 3_000;
const WAIT_NOTICE_TIMEOUT_MS = 6_000;
const RECOVERY_TIMEOUT_MS = 10_000;

export type VoiceState = 'OFF' | 'LISTENING' | 'CAPTURING' | 'THINKING' | 'SPEAKING' | 'QUIET' | 'ERROR';
export type VoiceDiagnosticCode = 'starting' | 'listening' | 'waiting_asr' | 'tts_unavailable' | 'sources_unavailable' | 'name_not_matched' | 'name_unconfirmed' | 'wake_confirmed'
  | 'waiting_speech_end' | 'waiting_asr_tail' | 'waiting_question' | 'thinking' | 'speaking'
  | 'waiting_quiet' | 'stopped' | 'completed' | 'question_timeout' | 'ambiguous_audio'
  | 'ambiguous_window' | 'stale_asr' | 'asr_unavailable' | 'services_unavailable'
  | 'worker_failed' | 'kws_unavailable' | 'answer_failed' | 'no_evidence' | 'playback_failed' | 'policy_changed'
  | 'interrupted' | 'waiting_turn_end' | 'livekit_unavailable' | 'no_input' | 'dialogue_paused';
export interface KwsStatus {
  engine: 'livekit-wakeword'; version: '2.1.1'; mode: 'activation'; device: 'cpu';
  status: 'off' | 'starting' | 'ready' | 'failed'; models: string[]; observed_at_ms: number;
}
export interface VoiceDiagnostic {
  event_id: string; code: VoiceDiagnosticCode; observed_at_ms: number;
  heard_prefix?: string; heard_at_ms?: number; channel?: number; source_start_ms?: number;
}
export interface VoiceConfig { enabled: boolean; ready: boolean; revision: number; wake_variants?: string[]; noise_suppression?:boolean; speech_profile?:string|null; progress?:unknown; unavailable_reason?: 'tts_unavailable' | 'sources_unavailable' | 'livekit_unavailable' | null; engine?:'tina'|'livekit'; agent_url?:string|null }
export interface VoiceApi {
  config(signal: AbortSignal): Promise<VoiceConfig>;
  answer(question: string, requestId: string, revision: number, signal: AbortSignal, speakerKey?: string): Promise<{ text: string; evidence_available?: boolean; clarification?: boolean; reason?:string; answer_kind?:string }>;
  state(state: VoiceState, requestId?: string, diagnostic?: VoiceDiagnostic, audio?: AudioSnapshot, kws?: KwsStatus): Promise<void>;
  speechService?(text?:string): {baseUrl:string;token:string;revision:number;requestId:string} | undefined;
  cancelTurn?(requestId:string): Promise<void> | void;
  speechProfile?():string|undefined;
}
export interface VoiceWorker {
  send(message: object): boolean;
  close(): void;
}
export type WorkerFactory = (event: (value: Record<string, unknown>) => void, failed: () => void) => VoiceWorker;
type TimingStage = 'speech_end' | 'vad_detected' | 'asr_started' | 'asr_completed' | 'asr_received'
  | 'wake_confirmed' | 'question_ready' | 'answer_requested' | 'answer_received'
  | `${'ack' | 'notice' | 'answer'}_${'tts_requested' | 'pcm_received' | 'buffer_ready' | 'playback_started'}` | 'turn_finished';

export function nativeVoiceWorker(event: (value: Record<string, unknown>) => void, failed: () => void,
  env: NodeJS.ProcessEnv = process.env, mode: 'vad' | 'kws' | 'turn' = 'vad'): VoiceWorker {
  const directory = env.TINA_VOICE_MODEL_DIR || '/models/meeting-voice';
  const child: ChildProcessWithoutNullStreams = spawn(env.TINA_VOICE_PYTHON || '/opt/tina-voice/bin/python',
    mode === 'turn' ? ['-m','tina_meeting_voice.turn_worker',directory+'/turn-models']
      : ['-m', 'tina_meeting_voice.bot', mode === 'vad' ? directory : directory + '/livekit-tina-v1',
          mode === 'vad' ? '--vad-only' : '--kws'],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: env.PATH, PYTHONUNBUFFERED: '1' } });
  let buffer = '', closed = false;
  const readyTimeout = setTimeout(() => fail(), 20_000); readyTimeout.unref();
  const fail = () => { if (!closed) { closed = true; clearTimeout(readyTimeout); child.kill('SIGKILL'); failed(); } };
  child.on('error', fail); child.on('exit', fail);
  child.stdin.on('error', fail);
  // Native diagnostics may contain audio-dependent values; only a fixed error reaches logs.
  child.stderr.on('data', () => {});
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 1_000_000) { fail(); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const value = JSON.parse(line);
        if (value.event === 'state' && value.state === 'LISTENING'
            || mode === 'kws' && value.event === 'kws' && value.status === 'ready'
            || mode === 'turn' && value.event === 'turn-ready') clearTimeout(readyTimeout);
        event(value);
      } catch { fail(); return; }
    }
  });
  return {
    send(message) {
      if (closed || child.stdin.writableLength > (mode==='turn'?720_000:128_000)) { fail(); return false; }
      child.stdin.write(JSON.stringify(message) + '\n');
      return true;
    },
    close() { closed = true; clearTimeout(readyTimeout); child.stdin.end(); child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000); timer.unref(); },
  };
}

export const nativeKwsWorker: WorkerFactory = (event, failed) => nativeVoiceWorker(event, failed, process.env, 'kws');
export const nativeTurnWorker: WorkerFactory = (event, failed) => nativeVoiceWorker(event, failed, process.env, 'turn');
const KWS_MODELS = ['hey_tina', 'tina_oi'];

export async function voiceAsrReady(inv: Invocation, fetchImpl = globalThis.fetch): Promise<boolean> {
  if (!inv.transcriptionServiceUrl || inv.transcribeEnabled === false) return false;
  try {
    const base = inv.transcriptionServiceUrl.replace(/\/v1(?:\/audio\/transcriptions)?\/?$/, '').replace(/\/$/, '');
    const response = await fetchImpl(base + '/health', { headers: inv.transcriptionServiceToken
      ? { Authorization: `Bearer ${inv.transcriptionServiceToken}` } : {}, signal: AbortSignal.timeout(2500) });
    await response.body?.cancel();
    return response.ok;
  } catch { return false; }
}

export function voiceApi(url: string, token: string, fetchImpl = globalThis.fetch): VoiceApi {
  let speechProfile:string|undefined;
  let agent: {baseUrl:string;token:string;revision:number} | undefined, currentId: string | undefined;
  async function call(path: string, method: string, body?: object, signal?: AbortSignal, speakerKey?: string, base = url) {
    const response = await fetchImpl(base + path, { method, headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-TINA-Voice-Runtime':'livekit-v1',
      ...(speakerKey ? { 'X-Voice-Speaker-Key': speakerKey } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(170_000)]) : AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error('Voice service unavailable');
    const text = await response.text();
    if (text.length > 200_000) throw new Error('Voice response exceeds bound');
    return JSON.parse(text);
  }
  const cancelTurn = async (requestId:string) => {
    if(currentId===requestId)currentId=undefined;
    const target=agent;
    const result=target
      ?await call('/turn','DELETE',{request_id:requestId},AbortSignal.timeout(15_000),undefined,target.baseUrl)
      :await call('/state','POST',{state:'QUIET',request_id:requestId},AbortSignal.timeout(5000));
    if(result[target?'stopped':'accepted']!==true)throw new Error('Voice cancellation was not confirmed');
  };
  return {
    config: async signal => {
      const value = await call('/config', 'GET', undefined, signal);
      if (typeof value.enabled !== 'boolean' || typeof value.ready !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('Invalid voice config');
      if (value.wake_variants !== undefined && (!Array.isArray(value.wake_variants) || value.wake_variants.length > 8 || value.wake_variants.some((v: unknown) => typeof v !== 'string' || v.length > 40))) throw new Error('Invalid voice variants');
      if (value.unavailable_reason != null && !['tts_unavailable', 'sources_unavailable', 'livekit_unavailable'].includes(value.unavailable_reason)) throw new Error('Invalid voice readiness reason');
      if (value.noise_suppression !== undefined && typeof value.noise_suppression !== 'boolean') throw new Error('Invalid NS setting');
      if(value.speech_profile!=null&&(typeof value.speech_profile!=='string'||value.speech_profile.length>6000))throw Error('Invalid speech profile');
      speechProfile=value.speech_profile||undefined;
      if (value.engine != null && !['tina','livekit'].includes(value.engine)) throw new Error('Invalid voice runtime');
      agent = undefined;
      if (value.engine === 'livekit') {
        const target = new URL(value.agent_url);
        if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error('Invalid agent endpoint');
        agent = {baseUrl:target.href.replace(/\/$/,''),token,revision:value.revision};
      }
      return value;
    },
    answer: (question, requestId, revision, signal, speakerKey) => {
      currentId=requestId;
      return call('/answer','POST',{question,request_id:requestId,revision},signal,speakerKey,agent?.baseUrl);
    },
    state: async (state, requestId, diagnostic, audio, kws) => {
      if(requestId && ['CAPTURING','THINKING','SPEAKING'].includes(state)) currentId=requestId;
      if(agent && requestId && ['QUIET','OFF'].includes(state)) {
        void cancelTurn(requestId).catch(()=>{});
      }
      await call('/state','POST',{state,request_id:requestId,
        ...(diagnostic?{diagnostic}:{}),...(audio?{audio}:{}),...(kws?{kws}:{})});
    },
    // A fixed acknowledgment must not queue behind the Agents session's in-flight LLM task.
    speechService: text => !isFixedVoiceNotice(text) && agent && currentId ? {...agent,requestId:currentId} : undefined,
    cancelTurn,
    speechProfile:()=>speechProfile,
  };
}

/** PCM is a tee: every error disarms voice without throwing into the transcript pipeline. */
export class MeetingVoice {
  private vadShadow?:VadShadow;
  private ns:NoiseSuppressor;
  processAudio(frame:NoiseFrame,deliver:(pcm:Float32Array)=>void){this.ns.feed(frame,deliver);}
  private audio = new AudioDiagnostics();
  asrDiagnostic(event: AsrDiagnostic) { if (!this.closed) this.audio.asr(event); }
  private worker?: VoiceWorker;
  private kws?: VoiceWorker;
  private kwsSerial = 0;
  private kwsStatus: KwsStatus['status'] = 'off';
  private vadListening = false;
  private inputs = new Map<number, {participant?: string | null; endMs: number; identifiedMs?: number; nextSample?: number}>();
  private recent = new Map<number, VoiceHypothesis[]>();
  private state: VoiceState = 'OFF';
  private revision = -1;
  private requestId?: string;
  private requestSpeakerKey?: string;
  private waitingCaller?: {channel: number; participant?: string | null; expires: number; after: number; endMs?:number};
  private continuationHypotheses: VoiceHypothesis[] = [];
  private epoch = 0;
  private generation = 0;
  private closed = true;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private probeRecovery = false;
  private abort = new AbortController();
  private pendingState?: { state: VoiceState; id?: string; diagnostic?: VoiceDiagnostic };
  private diagnostic?: VoiceDiagnostic;
  private sentDiagnosticId?: string;
  private diagnosticKey = '';
  private heardWindowEnd?: number;
  private lastHeard?: Pick<VoiceDiagnostic, 'heard_prefix' | 'heard_at_ms' | 'channel' | 'source_start_ms'>;
  private sendingState = false;
  private workerSerial = 0;
  private externalSpeaking = false;
  private processing = false;
  private interrupting = false;
  private interruptCaller?: {channel:number;participant:string;after:number;guard?:VoiceInterruption};
  private interruptBuffer: VoiceHypothesis[] = [];
  private interruption?: VoiceInterruption;
  private turnCaller?: {channel:number;participant:string};
  private turnQuestion?: string;
  private refinementBase?: {question:string;channel:number;participant:string;expires:number};
  private playedText = '';
  private speakingText = '';
  private playbackStarted = false;
  private idleDiagnostic?: VoiceDiagnosticCode;
  private trigger = new VoiceTrigger();
  private activity = new Map<number, { speech: boolean; endMs?: number; stamp: number; receivedAtMs: number }>();
  private timing?: { request_id: string; channel: number; stages: Partial<Record<TimingStage, number>> };
  private turnTimer?: ReturnType<typeof setInterval>;
  private noticeCursor = {wake: 0, wait: 0, summary: 0};
  private turnShadow?: TurnShadow;

  private nextNotice(kind: keyof typeof VOICE_NOTICES): string {
    const choices = VOICE_NOTICES[kind];
    return choices[this.noticeCursor[kind]++ % choices.length];
  }

  constructor(private api: VoiceApi, private speak: SpeakController,
    private report: SpeechReporter, private factory: WorkerFactory = nativeVoiceWorker,
    private log: (state: string) => void = state => console.log(`[bot] meeting-voice: ${state}`),
    private asrReady: () => Promise<boolean> = async () => true,
    private requestEndpoint: (channel: number, endMs: number | null) => void = () => {},
    private kwsFactory?: WorkerFactory, turnFactory?: WorkerFactory, noise?:NoiseSuppressor, vadFactory?:WorkerFactory) {
    this.ns=noise??new NoiseSuppressor();
    if(vadFactory)this.vadShadow=new VadShadow(vadFactory,value=>this.log(JSON.stringify({type:'livekit_vad_shadow',...value})));
    this.trigger = new VoiceTrigger(Date.now, [], !!kwsFactory);
    if(turnFactory)this.turnShadow=new TurnShadow(turnFactory,this.log);
  }

  private kwsLog(value: object) {
    try { this.log(JSON.stringify({type: 'kws', mode: 'activation', ...value})); } catch { /* Logging cannot affect a turn. */ }
  }
  private closeKws(failed = false) {
    this.kwsSerial++;
    this.kws?.close(); this.kws = undefined;
    this.kwsStatus = failed ? 'failed' : 'off';
    if (failed && !this.closed) {
      this.kwsLog({status: 'failed'});
      void this.cancel(false, 'kws_unavailable').then(current => {
        if (current && !this.closed) { this.setState('ERROR'); this.diagnose('kws_unavailable'); }
      });
    }
  }
  private separateChannel(caller:{channel:number;participant?:string|null},channel:number) {
    const input=this.inputs.get(channel),current=this.inputs.get(caller.channel);
    return channel!==caller.channel && !!caller.participant
      && typeof input?.participant==='string' && input.participant.length>0 && input.participant.length<=512
      && input.participant!==caller.participant && Date.now()-input.endMs<1500 && input.endMs<=Date.now()+1000
      && (!current?.participant || current.participant===caller.participant);
  }
  private kwsEvent(event: Record<string, unknown>) {
    if (event.event === 'kws' && event.status === 'wake' && KWS_MODELS.includes(event.model as string)
        && Number.isInteger(event.channel) && typeof event.score === 'number' && Number.isFinite(event.score)
        && typeof event.source_frame_end_ms === 'number' && Number.isFinite(event.source_frame_end_ms)
        && typeof event.source_start_ms === 'number' && Number.isFinite(event.source_start_ms)) {
      const input = this.inputs.get(event.channel as number);
      this.kwsLog({status:'candidate',model:event.model,channel:event.channel,score:event.score,state:this.state,
        generation_match:event.generation===this.epoch,kws_ready:this.kwsStatus==='ready',
        continuation:this.trigger.hasContinuation,input_present:!!input,
        identity_conflict:!!input?.participant&&!!event.participant&&input.participant!==event.participant,
        source_age_ms:Date.now()-event.source_frame_end_ms,
        source_span_ms:event.source_frame_end_ms-event.source_start_ms,
        input_ahead_ms:input ? input.endMs-event.source_frame_end_ms : undefined,
        after_ms:event.source_frame_end_ms-this.trigger.acceptAfter});
    }
    if (event.generation !== this.epoch || event.event !== 'kws') return;
    if (event.status === 'metrics' && Number.isInteger(event.channel) && typeof event.peak_scores === 'object'
        && event.peak_scores !== null && typeof event.frames === 'number' && Number.isSafeInteger(event.frames)
        && typeof event.identity_resets === 'number' && Number.isSafeInteger(event.identity_resets)
        && typeof event.source_resets === 'number' && Number.isSafeInteger(event.source_resets)) {
      const scores=event.peak_scores as Record<string,unknown>;
      if (KWS_MODELS.every(name=>typeof scores[name]==='number' && Number.isFinite(scores[name])
          && (scores[name] as number)>=0 && (scores[name] as number)<=1)) {
        this.kwsLog({status:'metrics',channel:event.channel,frames:event.frames,identity_resets:event.identity_resets,
          source_resets:event.source_resets,peak_scores:Object.fromEntries(KWS_MODELS.map(name=>[name,scores[name]]))});
      }
      return;
    }
    if (event.status === 'ready') {
      if (!Array.isArray(event.models) || event.models.length !== KWS_MODELS.length
          || new Set(event.models).size !== KWS_MODELS.length || event.models.some(v => !KWS_MODELS.includes(v))) {
        this.closeKws(true); return;
      }
      this.kwsStatus = 'ready'; this.kwsLog({status: 'ready', models: KWS_MODELS});
      this.listen(); this.publishState(this.state); return;
    }
    if (event.status !== 'wake' || this.state !== 'LISTENING' || this.kwsStatus !== 'ready' || this.trigger.pending
        || !KWS_MODELS.includes(event.model as string)
        || !Number.isInteger(event.channel) || (event.channel as number) < 0 || (event.channel as number) >= 65536
        || typeof event.score !== 'number' || !Number.isFinite(event.score) || event.score < .5 || event.score > 1
        || typeof event.source_frame_end_ms !== 'number' || !Number.isFinite(event.source_frame_end_ms)
        || event.source_frame_end_ms > Date.now() + 1000
        || Date.now() - event.source_frame_end_ms > 5000
        || typeof event.source_start_ms !== 'number' || !Number.isFinite(event.source_start_ms)
        || event.source_start_ms < 0 || event.source_start_ms >= event.source_frame_end_ms
        || event.source_frame_end_ms - event.source_start_ms > 2001
        || event.participant != null && (typeof event.participant !== 'string' || event.participant.length > 512)
        || typeof event.processing_ms !== 'number' || !Number.isFinite(event.processing_ms) || event.processing_ms < 0) return;
    const channel = event.channel as number, input = this.inputs.get(channel);
    if (!input || input.participant && event.participant && input.participant !== event.participant
        || event.source_frame_end_ms > input.endMs + 2 || input.endMs - event.source_frame_end_ms > 2000) return;
    const participant = typeof input.participant === 'string' && input.participant === event.participant ? input.participant : undefined;
    const previous=this.trigger.continuationCaller;
    // A new known caller may claim an idle follow-up slot, never an in-progress question/answer.
    if(previous && (!previous.participant || !participant
        || previous.channel===channel && previous.participant===participant))return;
    if ([...this.activity.entries()].some(([key, row]) => key !== channel && row.speech && Date.now() - row.stamp < 1500
        && !this.separateChannel({channel,participant},key))) {
      void this.cancel(false, 'ambiguous_audio'); return;
    }
    if (!this.trigger.wake({channel, participant,
      startMs: event.source_start_ms, endMs: event.source_frame_end_ms})) return;
    this.requestId = randomUUID();
    this.requestSpeakerKey = participant ? createHash('sha256').update(`participant:${participant}`).digest('hex') : undefined;
    const activity = this.activity.get(channel);
    this.timing = {request_id: this.requestId, channel, stages: {
      ...(activity && !activity.speech ? {speech_end: activity.endMs, vad_detected: activity.receivedAtMs} : {}),
    }};
    this.markTiming('wake_confirmed'); this.setState('CAPTURING'); this.diagnose('wake_confirmed');
    this.kwsLog({status: 'wake', model: event.model, channel: event.channel, score: event.score,
      handoff:!!previous,
      source_frame_end_ms: event.source_frame_end_ms, observed_at_ms: Date.now(), processing_ms: event.processing_ms});
    try { this.requestEndpoint(channel, activity && !activity.speech ? activity.endMs ?? null : null); }
    catch { /* Regular ASR cadence remains available. */ }
    const buffered = this.recent.get(channel) ?? []; this.recent.clear();
    for (const value of buffered) this.hypothesis(value);
  }

  private listen() {
    if (!this.vadListening || this.kwsFactory && this.kwsStatus !== 'ready' || !['OFF', 'QUIET'].includes(this.state)) return;
    const caller = this.waitingCaller && Date.now() < this.waitingCaller.expires ? this.waitingCaller : undefined;
    const buffered = caller ? this.continuationHypotheses : [];
    if (caller) this.trigger.continueAfter(caller.after, caller, caller.expires);
    else { this.trigger.reset(Date.now()); this.activity.clear(); }
    this.waitingCaller = undefined; this.continuationHypotheses = []; this.recent.clear();
    this.setState('LISTENING'); this.diagnose(this.idleDiagnostic??'listening');this.idleDiagnostic=undefined;
    if(caller?.endMs!==undefined&&!this.activity.get(caller.channel)?.speech){
      const end=Math.max(caller.endMs,this.activity.get(caller.channel)?.endMs??0);
      this.activity.set(caller.channel,{speech:false,endMs:end,stamp:end,receivedAtMs:Date.now()});
      try{this.requestEndpoint(caller.channel,end);}catch{/* The buffered correction still requires confirmed ASR. */}
    }
    for (const value of buffered) this.hypothesis(value);
  }

  private markTiming(stage: TimingStage, at = Date.now(), outcome?: string) {
    const timing = this.timing;
    if (!timing || !Number.isFinite(at)) return;
    timing.stages[stage] = at;
    const s = timing.stages;
    const elapsed = (from: TimingStage, to: TimingStage) => s[from] === undefined || s[to] === undefined
      ? undefined : Math.max(0, Math.round(s[to]! - s[from]!));
    // Numbers and generated request IDs only; timing observers cannot break voice or transcript.
    try { this.log(JSON.stringify({ type: 'voice_timing', request_id: timing.request_id, channel: timing.channel,
      stage, outcome, stages_at_ms: s, durations_ms: {
        vad: elapsed('speech_end', 'vad_detected'), asr_request: elapsed('asr_started', 'asr_completed'),
        asr_available_after_end: elapsed('speech_end', 'asr_completed'),
        question_ready_after_end: elapsed('speech_end', 'question_ready'),
        answer_service: elapsed('answer_requested', 'answer_received'),
        ack_after_question: elapsed('question_ready', 'ack_playback_started'),
        answer_playback_after_end: elapsed('speech_end', 'answer_playback_started'),
        answer_playback_after_response: elapsed('answer_received', 'answer_playback_started'),
        answer_pcm_after_end: elapsed('speech_end', 'answer_pcm_received'),
        ...Object.fromEntries((['ack','notice','answer'] as const).flatMap(kind => [
          [`${kind}_first_pcm`, elapsed(`${kind}_tts_requested`, `${kind}_pcm_received`)],
          [`${kind}_prebuffer`, elapsed(`${kind}_pcm_received`, `${kind}_buffer_ready`)],
          [`${kind}_mic_start_after_buffer`, elapsed(`${kind}_buffer_ready`, `${kind}_playback_started`)],
        ])),
        notice_after_question: elapsed('question_ready', 'notice_playback_started'),
      } })); } catch { /* Best-effort timing must never affect a turn. */ }
  }
  private markSpeechTiming(kind: 'ack' | 'notice' | 'answer', timing?: Readonly<SpeechTiming>, started = false) {
    for (const [suffix, at] of [['tts_requested',timing?.requestedAtMs],['pcm_received',timing?.firstPcmAtMs],
      ['buffer_ready',timing?.readyAtMs],['playback_started',timing?.playbackAtMs ?? (started ? Date.now() : undefined)]] as const) {
      const stage: TimingStage = `${kind}_${suffix}`;
      if (at !== undefined && this.timing?.stages[stage] === undefined) this.markTiming(stage, at);
    }
  }
  private finishTiming(outcome: string) {
    this.markTiming('turn_finished', Date.now(), outcome); this.timing = undefined;
  }

  private diagnose(code: VoiceDiagnosticCode, value?: VoiceHypothesis) {
    if (code === 'worker_failed') this.finishTiming(code);
    const now = Date.now();
    if (value) {
      const prefix = value.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().split(/\s+/u).slice(0, 3).join(' ').slice(0, 64);
      this.heardWindowEnd = value.endMs;
      this.lastHeard = { heard_prefix: prefix || undefined, heard_at_ms: now,
        channel: value.channel, source_start_ms: value.startMs };
    }
    const heard = this.lastHeard && now - this.lastHeard.heard_at_ms! < 30_000 ? this.lastHeard : undefined;
    const key = JSON.stringify([code, heard?.heard_prefix, heard?.channel, heard?.source_start_ms, heard ? this.heardWindowEnd : undefined]);
    if (key === this.diagnosticKey) return;
    this.diagnosticKey = key;
    this.diagnostic = { event_id: randomUUID(), code, observed_at_ms: now, ...heard };
    // Diagnostic text is delivered only to the owner-scoped API; never to console/logs.
    this.publishState(this.state, this.requestId);
  }
  private setState(state: VoiceState) {
    this.state = state;
    this.vadShadow?.control(state,this.epoch);
    if(!['LISTENING','CAPTURING'].includes(state))this.turnShadow?.clearAudio();
    if (!['LISTENING', 'CAPTURING'].includes(state)) this.vadListening = false;
    try { if (this.kws?.send({type: 'control', state, generation: this.epoch}) === false) this.closeKws(true); }
    catch { this.closeKws(true); }
    this.log(state);
    this.publishState(state, this.requestId);
  }
  private publishState(state: VoiceState, id?: string) {
    // Cancellation cannot be coalesced away by a later LISTENING heartbeat.
    if ((state === 'QUIET' || state === 'OFF') && id) void this.api.state(state, id).catch(() => {});
    this.pendingState = { state, id, diagnostic: this.diagnostic?.event_id !== this.sentDiagnosticId ? this.diagnostic : undefined };
    if (!this.sendingState) void this.flushState();
  }
  private async flushState() {
    this.sendingState = true;
    try {
      while (this.pendingState) {
        const next = this.pendingState; this.pendingState = undefined;
        try {
          await this.api.state(next.state, next.id, next.diagnostic, {...this.audio.snapshot(),noise_suppression:this.ns.state},
            this.kwsFactory ? {engine: 'livekit-wakeword', version: '2.1.1', mode: 'activation', device: 'cpu',
              status: this.kwsStatus, models: KWS_MODELS, observed_at_ms: Date.now()} : undefined);
          if (next.diagnostic) this.sentDiagnosticId = next.diagnostic.event_id;
        } catch { /* status cannot block audio */ }
      }
    } finally { this.sendingState = false; }
  }
  private control(state: VoiceState) {
    try {
      if (this.worker?.send({ type: 'control', state, generation: this.epoch }) === false) throw new Error('Voice worker unavailable');
      return true;
    }
    catch { this.worker?.close(); this.worker = undefined; this.generation++; this.abort.abort(); this.setState('ERROR'); this.diagnose('worker_failed'); return false; }
  }
  private async cancel(dispose = false, reason: VoiceDiagnosticCode = 'stopped') {
    this.probeRecovery = false;
    const requestId=this.requestId,playedText=this.playedText,started=this.playbackStarted;
    this.finishTiming(reason);
    const generation = ++this.generation;
    this.epoch++; this.processing = false; this.externalSpeaking = false;
    this.vadShadow?.control('QUIET',this.epoch);
    this.turnShadow?.cancel();
    if(dispose){this.turnShadow?.close();this.vadShadow?.close();}
    this.trigger.reset(); this.activity.clear();
    this.interruption=undefined;this.turnCaller=undefined;
    this.turnQuestion=undefined;this.refinementBase=undefined;
    this.recent.clear(); this.inputs.clear();
    this.requestSpeakerKey = undefined;
    this.waitingCaller = undefined;
    this.continuationHypotheses = [];
    this.abort.abort(); this.abort = new AbortController();
    let stopped = true, workerReady = true;
    const stopping = (async () => {
      try { await this.speak.stop(); }
      catch { stopped = false; this.log('playback_stop_failed'); }
    })();
    let receipt=true;
    // Persist the confirmed prefix before server cancellation finalizes the receipt.
    if(requestId&&started){try{await this.report(requestId,'stopped',playedText);}catch{receipt=false;this.log('playback_receipt_failed');}}
    const released=await Promise.resolve().then(()=>requestId?this.api.cancelTurn?.(requestId):undefined).then(()=>true,()=>false);
    await stopping;
    if (generation !== this.generation) return false;
    this.playedText='';this.speakingText='';this.playbackStarted=false;
    if (dispose) { this.workerSerial++; this.worker?.close(); this.worker = undefined; this.closeKws(); }
    else workerReady = this.control(stopped && released && receipt ? 'QUIET' : 'ERROR');
    this.setState(stopped && released && receipt && workerReady ? (dispose ? 'OFF' : 'QUIET') : 'ERROR');
    this.requestId = undefined;
    this.diagnose(!stopped ? 'playback_failed' : !released || !receipt ? 'services_unavailable' : !workerReady ? 'worker_failed' : reason);
    return true;
  }
  async start() {
    if (!this.closed) return;
    this.closed = false;
    this.turnTimer = setInterval(() => this.finishQuestion(), 100);
    await this.poll();
  }
  private async poll() {
    if (this.closed) return;
    let probing = true;
    try {
      const config = await this.api.config(AbortSignal.timeout(5000));
      probing = false;
      if (this.closed) return;
      this.ns.setEnabled(config.noise_suppression===true);
      probing = true;
      const asrReady = config.enabled && config.ready ? await this.asrReady() : false;
      probing = false;
      const ready = config.enabled && config.ready && asrReady;
      if (this.closed) return;
      if (!ready) {
        if (!this.externalSpeaking && (this.worker || this.state !== 'OFF') && !await this.cancel(true)) return;
        if (config.enabled) this.diagnose(config.ready ? 'asr_unavailable' : config.unavailable_reason || 'services_unavailable');
        this.revision = config.revision;
      }
      else {
        if (config.revision !== this.revision && (this.worker || this.state === 'ERROR') && !await this.cancel(true, 'policy_changed')) return;
        this.revision = config.revision;
        if (this.closed) return;
        if (this.probeRecovery && this.state === 'ERROR' && !this.worker && !this.externalSpeaking) {
          this.probeRecovery = false; this.setState('OFF');
        }
        if (!this.worker && !this.externalSpeaking && this.state !== 'ERROR') {
          this.vadShadow?.start();
          this.turnShadow?.start();
          const serial = ++this.workerSerial;
          this.epoch = 0;
          this.trigger.reset(Date.now(), config.wake_variants || []);
          this.diagnose('starting');
          this.worker = this.factory(event => { if (!this.closed && serial === this.workerSerial) this.onEvent(event); },
            () => { if (!this.closed && serial === this.workerSerial) {
              this.worker?.close(); this.worker = undefined; this.generation++;
              this.abort.abort(); void this.speak.stop().catch(() => {}); this.setState('ERROR'); this.diagnose('worker_failed');
            } });
          if (this.kwsFactory) {
            this.closeKws();
            this.kwsStatus = 'starting';
            const kwsSerial = ++this.kwsSerial;
            try {
              this.kws = this.kwsFactory(event => {
                if (!this.closed && kwsSerial === this.kwsSerial) this.kwsEvent(event);
              }, () => { if (kwsSerial === this.kwsSerial) this.closeKws(true); });
            } catch { this.closeKws(true); }
          }
        }
      }
      this.publishState(this.state, this.requestId);
    } catch {
      const recoverable = probing && (this.state !== 'ERROR' || this.probeRecovery) && !this.externalSpeaking;
      this.ns.setEnabled(false);
      if (!this.closed && await this.cancel(true)) {
        this.probeRecovery = recoverable && this.state === 'OFF';
        this.setState('ERROR'); this.diagnose('services_unavailable');
      }
    } finally {
      if (!this.closed) this.pollTimer = setTimeout(() => { void this.poll(); }, 2000);
    }
  }
  private onEvent(event: Record<string, unknown>) {
    if (event.generation !== this.epoch) return;
    if(event.event==='activity')this.vadShadow?.activity(event);
    if (event.event === 'state' && event.state === 'LISTENING' && ['OFF', 'QUIET'].includes(this.state)) {
      this.vadListening = true; this.listen();
    } else if (event.event === 'activity' && Number.isInteger(event.channel) && typeof event.speech === 'boolean'
        && typeof event.stamp === 'number' && Number.isFinite(event.stamp)) {
      const channel = event.channel as number;
      if (!this.activity.has(channel) && this.activity.size >= 32) return;
      const wasSpeaking = this.activity.get(channel)?.speech;
      if(event.speech && !wasSpeaking)this.turnShadow?.resume(channel);
      const interruptible=['THINKING','SPEAKING'].includes(this.state)&&this.turnCaller?.channel===channel;
      if (event.speech && !wasSpeaking && this.state === 'LISTENING') this.diagnose('waiting_asr');
      if (event.speech && !wasSpeaking && (['LISTENING', 'CAPTURING'].includes(this.state)||interruptible)) {
        try { this.requestEndpoint(channel, null); } catch { /* ASR cadence remains the fallback. */ }
      }
      this.activity.set(channel, { speech: event.speech, stamp: event.stamp, receivedAtMs: Date.now(),
        endMs: typeof event.endMs === 'number' ? event.endMs : undefined });
      if (!event.speech && typeof event.endMs === 'number' && Number.isFinite(event.endMs)
          && (['LISTENING', 'CAPTURING'].includes(this.state) || interruptible || this.state === 'QUIET' && this.waitingCaller?.channel === channel)) {
        if (!interruptible&&this.timing?.channel === channel) {
          this.timing.stages.speech_end = event.endMs; this.markTiming('vad_detected');
        }
        try { this.requestEndpoint(channel, event.endMs); } catch { /* ASR cadence remains the fallback. */ }
      }
      if (event.speech && this.state==='CAPTURING' && this.trigger.active && this.trigger.channel !== channel
          && (!this.trigger.caller || !this.separateChannel(this.trigger.caller,channel))) {
        void this.cancel(false, 'ambiguous_audio'); this.log('overlapping_channels');
      }
    }
  }
  hypothesis(value: VoiceHypothesis) {
    if(this.interrupting){
      const caller=this.interruptCaller;
      if(caller&&value.channel===caller.channel&&value.participant===caller.participant
          &&Number.isFinite(value.startMs)&&Number.isFinite(value.endMs)&&value.endMs>=caller.after
          &&value.endMs<=Date.now()+1000&&Date.now()-value.endMs<20000
          &&typeof value.text==='string'&&value.text.length<=4000&&!caller.guard?.isPlaybackEcho(value.text)){
        this.interruptBuffer.push(value);this.interruptBuffer=this.interruptBuffer.slice(-8);
      }
      return;
    }
    if(!this.closed&&this.worker&&['THINKING','SPEAKING'].includes(this.state)&&!this.externalSpeaking){
      if(!this.interrupting){
        const command=this.interruption?.feed(value,this.speakingText,true,this.state==='SPEAKING');
        if(command)void this.interrupt(command);
      }
      return;
    }
    if (!this.closed && this.worker && this.state === 'QUIET' && this.waitingCaller
        && Date.now() < this.waitingCaller.expires && value.channel === this.waitingCaller.channel) {
      if (this.continuationHypotheses.length >= 8) this.continuationHypotheses.shift();
      this.continuationHypotheses.push(value);
      return;
    }
    if (this.closed || !this.worker || !['LISTENING', 'CAPTURING'].includes(this.state)) return;
    if (this.kwsFactory && this.state === 'LISTENING' && !this.trigger.pending) {
      if (Number.isInteger(value.channel) && value.channel >= 0 && value.channel < 65536
          && Number.isFinite(value.startMs) && Number.isFinite(value.endMs) && value.endMs > value.startMs
          && value.endMs <= Date.now() + 1000 && Date.now() - value.endMs < 20_000
          && typeof value.text === 'string' && value.text.length <= 4000) {
        if (this.recent.has(value.channel) || this.recent.size < 32) {
          this.recent.set(value.channel, [...(this.recent.get(value.channel) ?? []), value].slice(-4));
        }
      }
      // The fixed-ack continuation is already authorized by the preceding acoustic call.
      if (!this.trigger.hasContinuation) return;
    }
    const result = this.trigger.feed(value);
    const heard = this.trigger.heard ?? value;
    if (result === 'wake' && !this.requestId) {
      if ([...this.activity.entries()].some(([channel, state]) => channel !== value.channel && state.speech && Date.now() - state.stamp < 1500
          && !this.separateChannel({channel:value.channel,participant:heard.participant},channel))) {
        void this.cancel(false, 'ambiguous_audio'); this.log('ambiguous_wake'); return;
      }
      this.requestId = randomUUID();
      // Transport identity scopes history only; display names never identify an account/person.
      this.requestSpeakerKey = heard.participant
        ? createHash('sha256').update(`participant:${heard.participant}`).digest('hex') : undefined;
      const activity = this.activity.get(value.channel);
      if (this.kwsFactory) this.kwsLog({status: 'asr_wake', channel: value.channel,
        source_frame_end_ms: heard.endMs, observed_at_ms: Date.now()});
      this.timing = { request_id: this.requestId, channel: value.channel, stages: {
        ...(activity && !activity.speech ? { speech_end: activity.endMs, vad_detected: activity.receivedAtMs } : {}),
      } };
      this.markTiming('wake_confirmed');
      this.setState('CAPTURING'); this.diagnose('wake_confirmed', heard);
    } else if (result === 'discard' && this.state === 'CAPTURING') {
      void this.cancel(false, this.trigger.reason === 'name_not_matched' ? 'name_not_matched' : 'ambiguous_window');
    } else if (this.trigger.reason === 'name_not_matched') this.diagnose('name_not_matched', heard);
    else if (this.trigger.reason === 'name_unconfirmed') this.diagnose('name_unconfirmed', heard);
    else if (this.trigger.reason === 'stale_asr') this.diagnose('stale_asr');
    if ((result === 'wake' || result === 'update') && this.timing?.channel === value.channel) {
      this.timing.stages.asr_started = value.asrStartedAtMs;
      this.timing.stages.asr_completed = value.asrCompletedAtMs;
      this.markTiming('asr_received');
    }
    this.finishQuestion();
  }
  private async interrupt(command:{value:VoiceHypothesis;question:string;resume:boolean;refinement?:boolean}){
    const caller=this.turnCaller;if(!caller||this.interrupting)return;
    let original=command.refinement||command.resume&&!command.question?this.turnQuestion:undefined;
    if(original&&!command.question&&mergeVoiceRefinement(original,'')===null)original=undefined;
    if(original && mergeVoiceRefinement(original,command.question)===null) {this.log('refinement_requires_full_question');return;}
    this.interrupting=true;
    this.interruptCaller={...caller,after:command.value.endMs,guard:this.interruption};this.interruptBuffer=[];
    try{
      const current = await this.cancel(false,'interrupted');
      if(!current||this.closed||this.state!=='QUIET'||!command.resume)return;
      if(original)this.refinementBase={...caller,question:original,expires:Date.now()+FOLLOW_UP_MS};
      const bufferedEnd=this.interruptBuffer.reduce((end,row)=>Math.max(end,row.endMs),command.value.endMs);
      this.waitingCaller={...caller,after:command.question?command.value.startMs:command.value.endMs,expires:Date.now()+FOLLOW_UP_MS,
        ...(command.question||this.interruptBuffer.length?{endMs:bufferedEnd}:{})};
      this.continuationHypotheses=[...(command.question?[{...command.value,text:command.question,segments:undefined}]:[]),...this.interruptBuffer].slice(-8);
      this.diagnose('waiting_question');
    }finally{this.interrupting=false;this.interruptCaller=undefined;this.interruptBuffer=[];}
  }
  private finishQuestion() {
    const now = Date.now();
    if (this.lastHeard && now - this.lastHeard.heard_at_ms! >= 30_000) this.lastHeard = undefined;
    if (this.diagnostic && now - (this.diagnostic.heard_at_ms ?? this.diagnostic.observed_at_ms) >= 30_000) { this.diagnostic = undefined; this.diagnosticKey = ''; }
    if (this.state==='LISTENING' && !this.processing) {
      const expired=this.trigger.takeExpiredContinuation();
      if (expired) {
        const input=this.inputs.get(expired.channel),activity=this.activity.get(expired.channel);
        this.diagnose(!input || now-input.endMs>1500 ? 'services_unavailable'
          : activity && (activity.speech || (activity.endMs??0)>expired.after) ? 'question_timeout' : 'no_input');
      }
    }
    if (this.closed || this.state !== 'CAPTURING' || this.processing) return;
    if (this.trigger.expired()) { void this.cancel(false, 'question_timeout'); this.log('question_timeout'); return; }
    const activity = this.activity.get(this.trigger.channel!);
    if (!activity || activity.speech) { this.diagnose('waiting_speech_end'); return; }
    const observed=this.trigger.question(activity.endMs,true),observedCaller=this.trigger.caller;
    if(observed && observedCaller && activity.endMs!==undefined && this.requestId)
      this.turnShadow?.observe(observed,observedCaller,activity.endMs,this.requestId);
    const question = this.trigger.question(activity.endMs);
    if(this.requestId&&typeof activity.endMs==='number')
      this.vadShadow?.observe(this.requestId,this.trigger.channel!,activity.endMs,this.trigger.endMs,question!==null&&question!==undefined);
    if (question === '' && this.requestId) {
      const caller = this.trigger.caller;
      if (!caller) return;
      this.processing = true;
      if (!this.control('SPEAKING')) { this.processing = false; return; }
      this.setState('SPEAKING'); this.diagnose('speaking');
      void this.acknowledge({channel: caller.channel, participant: caller.participant}, ++this.generation);
      return;
    }
    if (!question || !this.requestId) {
      this.diagnose(this.trigger.endMs! < (activity.endMs ?? 0) - 2 ? 'waiting_asr_tail'
        : turnPauseMs(this.trigger.heard?.text??'')>0 ? 'waiting_turn_end' : 'waiting_question');return;
    }
    this.processing = true;
    const caller = this.trigger.caller;
    const base=this.refinementBase;
    const refining=base && now<base.expires && this.trigger.answeringContinuation && isVoiceRefinement(question)
      && caller?.channel===base.channel && caller?.participant===base.participant;
    const effectiveQuestion=refining?mergeVoiceRefinement(base.question,question):question;
    this.refinementBase=undefined;
    if(!effectiveQuestion){void this.cancel(false,'question_timeout');return;}
    this.playedText='';this.speakingText='';this.playbackStarted=false;
    this.turnCaller=caller?.participant?{channel:caller.channel,participant:caller.participant}:undefined;
    this.turnQuestion=effectiveQuestion;
    this.interruption=this.turnCaller?new VoiceInterruption(this.turnCaller,activity.endMs??this.trigger.endMs??Date.now()):undefined;
    this.markTiming('question_ready');
    if (!this.control('THINKING')) { this.processing = false; return; }
    this.setState('THINKING'); this.diagnose('thinking');
    void this.answer(effectiveQuestion, this.requestId, ++this.generation, this.requestSpeakerKey,
      this.trigger.answeringContinuation, caller);
  }
  private async acknowledge(caller: {channel: number; participant?: string | null}, generation: number) {
    const live = () => !this.closed && this.generation === generation;
    let completed = false;
    try {
      const config = await this.api.config(this.abort.signal);
      if (!live()) return;
      if (!config.enabled || !config.ready || config.revision !== this.revision) throw new Error('Voice policy changed');
      const outcome = await this.speak.speak(this.nextNotice('wake'), 'auto', timing => { if (live()) this.markSpeechTiming('ack',timing,true); }, ACK_TIMEOUT_MS);
      if (!live()) return;
      if (outcome !== 'completed') throw new Error('Acknowledgment playback failed');
      completed = true;
      this.waitingCaller = {...caller, expires: Date.now() + FOLLOW_UP_MS, after: Date.now()};
      this.diagnose('waiting_question');
    } catch {
      if (live()) { this.waitingCaller = undefined; this.continuationHypotheses = []; this.diagnose('playback_failed');this.idleDiagnostic='playback_failed'; }
    } finally {
      if (live()) {
        this.finishTiming(completed ? 'name_acknowledged' : 'playback_failed');
        this.processing = false; this.trigger.reset(); this.activity.clear();
        if (this.control('QUIET')) this.setState('QUIET');
        this.requestId = undefined;
      }
    }
  }
  feed(channel: number, pcm: Float32Array, stamp: number, participant?: string | null, startSample?: number) {
    if (this.closed) return;
    this.audio.frame(channel, pcm, stamp, startSample);
    if (this.closed || !this.worker || !['LISTENING', 'CAPTURING', 'QUIET','THINKING','SPEAKING'].includes(this.state)) return;
    // The capture channel is the decoder key; participantId is optional Meet metadata.
    if (!Number.isInteger(channel) || channel < 0 || !Number.isFinite(stamp)) return;
    if (!pcm.length || pcm.length > 16000 || !pcm.every(Number.isFinite)) return;
    for (const [key, row] of this.inputs) if (stamp - row.endMs > 20_000) { this.inputs.delete(key); this.recent.delete(key); }
    const previous = this.inputs.get(channel);
    const identified = typeof participant === 'string' && participant.length > 0 && participant.length <= 512;
    const continuous = previous && Math.abs(stamp - previous.endMs) <= 80
      && (startSample === undefined || previous.nextSample === undefined || startSample === previous.nextSample);
    // Meet glow metadata may disappear briefly; never carry identity across a decoder reset or a long gap.
    participant = identified ? participant : continuous && stamp - (previous.identifiedMs ?? -Infinity) <= 1500 ? previous.participant : undefined;
    if (previous || this.inputs.size < 32) this.inputs.set(channel, {participant, endMs: stamp + pcm.length / 16,
      identifiedMs: identified ? stamp : continuous ? previous.identifiedMs : undefined,
      nextSample: startSample === undefined ? undefined : startSample + pcm.length});
    const frame = {type: 'audio', channel, participant, stamp, start_sample: startSample,
      audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')};
    this.vadShadow?.feed(frame);
    if(['LISTENING','CAPTURING'].includes(this.state))this.turnShadow?.feed(channel,pcm,stamp,participant,startSample);
    if (this.state === 'LISTENING') {
      try { if (this.kws?.send(frame) === false) this.closeKws(true); }
      catch { this.closeKws(true); }
    }
    try {
      if (!this.worker.send(frame)) throw new Error('Voice worker unavailable');
    } catch { this.worker?.close(); this.worker = undefined; this.generation++; this.abort.abort(); this.setState('ERROR'); this.diagnose('worker_failed'); }
  }
  private async answer(question: string, id: string, generation: number, speakerKey?: string, acknowledged = false,
    caller?: {channel: number; participant?: string | null}) {
    const live = () => !this.closed && this.generation === generation;
    let ack = Promise.resolve();
    let prepared: PreparedSpeech | undefined, pending: PreparedSpeech | undefined;
    let outcome = 'failed';
    let answerReceived = false;
    const noticeAbort = new AbortController();
    // A wake acknowledgment buys a longer quiet interval, not indefinite silence during a slow tool.
    const ackTimer = setTimeout(() => {
      if (!live()) return;
      ack = (async () => {
        let config: VoiceConfig;
        try {
          config = await this.api.config(AbortSignal.any([this.abort.signal, noticeAbort.signal, AbortSignal.timeout(2500)]));
        } catch {
          if (live() && !answerReceived) this.log('ack_playback_failed');
          return;
        }
        if (!live() || answerReceived || !config.enabled || !config.ready || config.revision !== this.revision) return;
        const notice = voiceProgressNotice(config.progress, id, this.revision) ?? this.nextNotice('wait');
        this.speakingText=notice;
        return this.speak.speak(notice, 'auto', timing => {
          if (live()) {this.interruption?.observePlayback(notice);this.markSpeechTiming('notice',timing,true);}
        }, WAIT_NOTICE_TIMEOUT_MS);
      })().then(result => { if (result && result !== 'completed' && live()) this.log('ack_playback_failed'); },
        () => { if (live()) this.log('ack_playback_failed'); });
    }, acknowledged ? 4000 : 900);
    // Include a two-minute recap and bounded TTS playback inside the 360-second room reservation.
    const timeout = setTimeout(() => { if (live()) void this.cancel(false, 'answer_failed').then(current => { if (current) this.setState('ERROR'); }); }, 330_000);
    try {
      this.markTiming('answer_requested');
      const answer = await this.api.answer(question, id, this.revision, this.abort.signal, speakerKey);
      answerReceived = true;
      noticeAbort.abort();
      clearTimeout(ackTimer);
      if (live()) this.markTiming('answer_received');
      await ack;
      if (!live()) return;
      if (typeof answer.text !== 'string' || !answer.text.trim() || answer.text.length > 4000) throw new Error('Invalid voice answer');
      let started = Promise.resolve();
      let didStart = false;
      const unanswered = answer.reason ? !['answered','clarification'].includes(answer.reason) : answer.evidence_available === false;
      this.setState('SPEAKING'); this.diagnose(answer.clarification ? 'speaking' : unanswered ? 'no_evidence' : 'speaking');
      const sentences = speechSentences(answer.text);
      for (let index = 0; index < sentences.length; index++) {
        const sentence = sentences[index];
        const prefetched = !!pending;
        prepared = pending; pending = undefined;
        for (let attempt = 0; attempt < (prefetched ? 2 : 1); attempt++) {
          if (!prepared) {
            const current = await this.api.config(this.abort.signal);
            if (!live() || !current.enabled || !current.ready || current.revision !== this.revision) { if (live()) this.diagnose('policy_changed'); return; }
            prepared = this.speak.prepare?.(sentence, 'auto');
          }
          let buffered = true;
          if (prepared) {
            buffered = await prepared.ready;
            if (!live()) return;
            if (index === 0) this.markSpeechTiming('answer',prepared.timing);
            const fresh = await this.api.config(this.abort.signal);
            if (!live() || !fresh.enabled || !fresh.ready || fresh.revision !== this.revision) { if (live()) this.diagnose('policy_changed'); return; }
          }
          let sentenceStarted = false;
          const onStarted = (timing?: Readonly<SpeechTiming>) => {
            sentenceStarted = true;
            if(live())this.interruption?.observePlayback(sentence);
            if (!didStart && live()) { didStart = true; this.playbackStarted=true;this.markSpeechTiming('answer',timing,true); started = this.report(id, 'started'); void started.catch(() => {}); }
          };
          this.speakingText=sentence;
          const playback = prepared ? prepared.play(onStarted) : this.speak.speak(sentence, 'auto', onStarted);
          if (index + 1 < sentences.length) pending = this.speak.prepare?.(sentences[index + 1], 'auto');
          const result = await playback;
          if (!live()) return;
          await started;
          if (result === 'failed' && prefetched && attempt === 0 && !sentenceStarted
              && (!buffered || prepared?.failedBeforePlayback)) {
            // Cancel later lookahead before retrying so it cannot hold the shared TTS worker ahead of this sentence.
            prepared?.cancel(); pending?.cancel(); prepared = undefined; pending = undefined;
            continue;
          }
          if (result !== 'completed') { this.diagnose('playback_failed');this.idleDiagnostic='playback_failed'; await this.report(id, result ?? 'failed'); return; }
          this.interruption?.observePlayback(sentence);
          this.playedText=(this.playedText+' '+sentence).trim();this.speakingText='';
          await this.report(id,'started',this.playedText);
          if(!live())return;
          break;
        }
      }
      await this.report(id, 'completed');
      if (!live()) return;
      outcome = answer.clarification ? 'clarification' : unanswered ? 'no_evidence' : 'completed';
      if (answer.reason==='clarification_exhausted') this.idleDiagnostic='dialogue_paused';
      else if (['llm_unavailable','verification_unavailable','draft_unavailable'].includes(answer.reason??'')) this.idleDiagnostic='answer_failed';
      if (caller?.participant && speakerKey && (answer.clarification || !unanswered)) {
        this.waitingCaller = {...caller, after: Date.now(), expires: Date.now() + FOLLOW_UP_MS};
        this.continuationHypotheses = [];
      }
      if (answer.clarification || answer.evidence_available !== false) this.diagnose('completed');
    } catch {
      if (live()) {
        this.log('turn_failed');this.diagnose('answer_failed');this.idleDiagnostic='answer_failed';
        clearTimeout(ackTimer);noticeAbort.abort();await ack.catch(()=>{});
        if (!answerReceived && live()) {
          let attemptedAudio=false;
          try {
            const config=await this.api.config(AbortSignal.any([this.abort.signal,AbortSignal.timeout(2500)]));
            if (live() && config.enabled && config.ready && config.revision===this.revision) {
              this.setState('SPEAKING');this.speakingText=VOICE_SERVICE_ERROR;
              attemptedAudio=true;
              const played=await this.speak.speak(VOICE_SERVICE_ERROR,'auto',undefined,RECOVERY_TIMEOUT_MS);
              if (live() && played!=='completed') {this.diagnose('playback_failed');this.idleDiagnostic='playback_failed';}
            }
          } catch { if (live()) {this.idleDiagnostic=attemptedAudio?'playback_failed':'answer_failed';this.diagnose(this.idleDiagnostic);} }
        }
      }
    }
    finally {
      answerReceived = true;
      noticeAbort.abort();
      clearTimeout(ackTimer);
      prepared?.cancel(); pending?.cancel();
      await ack.catch(() => {});
      clearTimeout(timeout);
      if (live()) { this.interruption=undefined;this.turnCaller=undefined;this.turnQuestion=undefined;this.speakingText='';this.playbackStarted=false;
        this.finishTiming(outcome); if (this.control('QUIET')) this.setState('QUIET'); this.requestId = undefined; this.processing = false; this.trigger.reset(); this.activity.clear(); }
    }
  }
  async external(act: Act, handle: (act: Act) => Promise<void>) {
    if (['speak_stop', 'speech_stop', 'leave'].includes(act.action)) {
      if (await this.cancel()) await handle(act); return;
    }
    if (act.action === 'speak' || act.action === 'speech_speak') {
      if (!await this.cancel()) return;
      if (this.state === 'ERROR') { if (act.action === 'speech_speak') await this.report(act.command_id, 'failed'); return; }
      const generation = this.generation; this.externalSpeaking = true;
      if (!this.control('SPEAKING')) { this.externalSpeaking = false; if (act.action === 'speech_speak') await this.report(act.command_id, 'failed'); return; }
      this.setState('SPEAKING');
      try { await handle(act); }
      finally { if (generation === this.generation) { this.externalSpeaking = false; if (this.control('QUIET')) this.setState('QUIET'); } }
      return;
    }
    await handle(act);
  }
  disarm() {
    this.closed = true;
    this.vadShadow?.close();
    this.turnShadow?.close();
    this.closeKws();
    clearTimeout(this.pollTimer);
    clearInterval(this.turnTimer);
  }
  async stop() {
    this.disarm();
    await this.ns.close();
    await this.cancel(true);
  }
}
