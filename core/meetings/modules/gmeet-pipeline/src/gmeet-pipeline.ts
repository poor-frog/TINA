/**
 * gmeet-pipeline — Google Meet CHANNEL-routed strategy (overlap-safe).
 *
 *   capture.v1 (audio frames: CHANNEL index + glow NAME bound at the source)
 *        ──►  transcript.v1 (named segments + live drafts)
 *
 * The combination of main's overlap engine + glow naming. Google Meet delivers
 * each active speaker on a SEPARATE channel, so audio is routed by CHANNEL: two
 * speakers talking at once land on separate per-channel streams and are
 * transcribed INDEPENDENTLY — no muddling, onsets intact. The glow names each
 * channel-TURN, bound at the turn's ONSET (a single tile lit, before any overlap)
 * and HELD through the overlap (where per-frame glow would be ambiguous → UNKNOWN).
 *
 * Each (channel, turn) is its OWN SpeakerStreamManager stream with a name FIXED at
 * onset (`ch-<n>:<turn>`). A turn ends on a silence gap OR a confident glow-name
 * CHANGE (overlap rotates a channel mid-stream with no gap), opening a fresh turn —
 * so a stream's name never relabels mid-flight — no async flush/relabel race.
 *
 * CONTRACT BOUNDARY: identity is CARRIED (the glow bound it at capture), never
 * derived. No diarizer, no post-hoc window-match.
 */
import {AudioTimelinePool,type TimedAudio,type AudioTimelineEvent} from '@tina/transcribe-buffer';
import { SpeakerStreamManager, type SpeakerStreamManagerConfig, type SpeakerStreamDiagnostic } from './speaker-streams.js';
import { continuityPrompt, type TranscriptionResult, type TranscriptionTiming } from '@tina/transcribe-whisper';
import type { TranscriptSegment, TranscriptSink } from './contracts/transcript-v1.js';

let nextTimelineSession=0;
export interface VoiceHypothesis {
  channel: number; speakerKey: string; participant?: string | null;
  startMs: number; endMs: number; text: string; final: boolean;
  segments?: Array<{ text: string; startMs: number; endMs: number }>;
  asrStartedAtMs?: number; asrCompletedAtMs?: number;
  speechStartMs?: number;
}

export interface GmeetPipelineOptions {
  /** Continuous STT input; window policy and canonical confirmation remain in this lane. */
  onStreamAudio?:(turn:string,pcm:Float32Array,captureMs:number)=>void;
  onStreamClosed?:(turn:string)=>void;
  onAsrDiagnostic?: (event: AsrDiagnostic) => void;
  onHypothesis?: (value: VoiceHypothesis) => void;
  /** Optional content-free decision trace for latency diagnosis; never changes confirmation policy. */
  onDiagnostic?: (event: SpeakerStreamDiagnostic) => void;
  timeline?:AudioTimelinePool;
  sessionId?:string;
  onAudioFrame?:(frame:TimedAudio)=>void;
  onTimelineEvent?:(event:AudioTimelineEvent)=>void;
  /** One Whisper round-trip (stt.v1). language is baked into the closure by the host. */
  transcribe?: (pcm: Float32Array, prompt?: string, timing?: TranscriptionTiming) => Promise<TranscriptionResult>;
  /** Where transcript.v1 segments + drafts land (consumer = collector/rendering). */
  sink: TranscriptSink;
  /** Label for a turn whose onset had no single confident glow. Default 'Speaker'. */
  unknownLabel?: string;
  /** SpeakerStreamManager tuning (turn gating / confirmation). */
  config?: SpeakerStreamManagerConfig;
  /** Silence gap (ms) on a channel that ends its turn (→ re-bind on the next onset). Default 1000. */
  onsetGapMs?: number;
  /** Surface a transcribe FAILURE (P18: fail loud + attributable). The pipeline still
   *  degrades gracefully (empty turn) so it doesn't wedge, but it reports the fault here
   *  so the host can make it observable (a /ws health frame, telemetry, lifecycle) instead
   *  of a silent "no transcript". Receives the thrown value (e.g. a TranscriptionError). */
  onError?: (fault: unknown) => void;
}

export interface AsrDiagnostic {
  channel: number; request: number; stage: 'started' | 'completed' | 'failed'; at_ms: number;
  capture_age_ms?: number; roundtrip_ms?: number; queue_ms?: number;
}

export interface GmeetPipeline {
  /** One capture.v1 frame: CHANNEL index + glow NAME (undefined ⇒ no single glow now). */
  feedAudio(channel: number, glowName: string | undefined, pcm: Float32Array, tsMs: number, participantId?:string|null,startSample?:number):void;
  /** null cancels a pending endpoint when VAD reports resumed speech. */
  requestEndpoint(channel: number, endMs: number | null): void;
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

export function createGmeetPipeline(opts: GmeetPipelineOptions): GmeetPipeline {
  const UNKNOWN = opts.unknownLabel ?? 'Speaker';
  const ONSET_GAP = opts.onsetGapMs ?? 1000;
  const timeline=opts.timeline ?? new AudioTimelinePool(16,(opts.config?.sampleRate ?? 16000)*30,opts.config?.sampleRate ?? 16000);
  const session=opts.sessionId ?? `gmeet-${++nextTimelineSession}`;
  const mgr = new SpeakerStreamManager({maxRetainedDuration:30,...opts.config,callbackStampedFrames:opts.config?.callbackStampedFrames ?? true});
  mgr.onDiagnostic=opts.onDiagnostic ?? null;
  mgr.onLimit=(limit)=>opts.onError?.({source:'buffer',kind:'source-limit',detail:`ASR active turn limit ${limit} reached`});
  mgr.onOverflow=(samples)=>opts.onError?.({source:'buffer',kind:'overflow',detail:`${samples} samples left the live ASR window; use archived audio for recovery`});
  const inflight = new Map<Promise<void>, string>();
  const closing=new Set<string>();
  const sourceChannels = new Map<string, number>();
  const endpoints = new Map<string, number>();
  const lastHypotheses = new Map<string, VoiceHypothesis>();
  let disposed = false;
  let asrRequest = 0;
  const asrDiagnostic = (event: AsrDiagnostic) => {
    try { opts.onAsrDiagnostic?.(event); } catch { /* Diagnostics never control transcript processing. */ }
  };
  // Per channel: the CURRENT turn's stream key, bound name, last-audio time, turn counter.
  const participants = new Map<string, string | null>();
  const chan = new Map<number, { key: string; name: string; onsetMs: number; lastMs:number;lastSpeechMs:number;turn:number; endpointMs?: number }>();

  const coversEndpoint = (value: VoiceHypothesis, endMs: number) => value.startMs <= endMs && value.endMs >= endMs - 2;
  const observe = (value: VoiceHypothesis) => {
    try { opts.onHypothesis?.(value); } catch { /* voice observers cannot interrupt transcript confirmation */ }
  };

  // Emit the SEALED transcript.v1 shape (snake_case, segment_id + completed, source
  // in the contract's enum) — the pipeline IS the transcript.v1 producer, so its
  // output conforms to meetings/contracts/transcript.v1 (pinned by the replay golden).
  const segOf = (speakerName: string, key: string, text: string, startMs: number, endMs: number, completed: boolean, lang?: string): TranscriptSegment => {
    const named = speakerName !== UNKNOWN;
    return {
      segment_id: `${key}:${Math.round(startMs)}`,
      speaker: speakerName, speaker_key: key, ...(typeof participants.get(key) === "string" ? {participant_id: participants.get(key) as string} : {}), text,
      start: startMs / 1000, end: endMs / 1000, completed, words: [],
      language: lang ?? null,
      source: named ? 'glow-bound' : 'provisional-cluster-id',
      confidence: named ? 1 : 0,
    };
  };

  // The window's language off the stt.v1 result: the per-call detection in auto mode, or the
  // invocation-forced code (baked into the transcribe closure, echoed back by the service).
  // 'unknown' is the client's no-detection sentinel, not an ISO code — NULL stays honest.
  const langOf = (l: string | undefined): string | undefined =>
    l && l !== 'unknown' ? l : undefined;

  mgr.onSegmentReady = (speakerId, _name, audio) => {
    const channel = sourceChannels.get(speakerId), request = ++asrRequest, started = Date.now();
    const p = (async () => {
      try {
        const audioStartMs = mgr.getBufferStartMs(speakerId);
        const finalSubmission = mgr.isFinalSubmission(speakerId);
        const audioEndMs = mgr.getSubmittedAudioEndMs(speakerId, audio.length);
        const speechStartMs = channel === undefined ? undefined : chan.get(channel)?.onsetMs;
        if(!opts.transcribe)return;
        if (channel !== undefined) asrDiagnostic({channel, request, stage:'started', at_ms:started,
          capture_age_ms: audioEndMs === undefined ? undefined : Math.max(0, started - audioEndMs)});
        const asrStartedAtMs = Date.now();
        const timing:TranscriptionTiming={
          ...(audioEndMs==null?{}:{capture_ms:Math.max(0,Date.now()-audioEndMs)}),
          ...(opts.onStreamAudio?{stream:{id:speakerId,start_ms:audioStartMs}}:{}),
        };
        const r = await opts.transcribe(audio, continuityPrompt(mgr.getLastConfirmedText(speakerId), audio, opts.config?.sampleRate ?? 16000),
          Object.keys(timing).length?timing:undefined);
        const asrCompletedAtMs = Date.now();
        if (channel !== undefined) asrDiagnostic({channel, request, stage:'completed', at_ms:asrCompletedAtMs,
          roundtrip_ms: asrCompletedAtMs - started, queue_ms:r?.queue_ms});
        const segs = r?.segments;
        if (channel !== undefined && audioEndMs !== undefined && mgr.isCurrentSubmission(speakerId)) {
          const value: VoiceHypothesis = { channel, speakerKey: speakerId, participant: participants.get(speakerId),
            startMs: audioStartMs, endMs: audioEndMs, text: r?.text || '', final: finalSubmission,
            asrStartedAtMs, asrCompletedAtMs, speechStartMs,
            segments: segs?.map(seg => ({ text: seg.text, startMs: audioStartMs + seg.start * 1000, endMs: audioStartMs + seg.end * 1000 })) };
          const endpoint = endpoints.get(speakerId);
          const current = chan.get(channel);
          if (endpoint !== undefined && current?.key !== speakerId) endpoints.delete(speakerId);
          else if (endpoint !== undefined && coversEndpoint(value, endpoint)) { value.final = true; endpoints.delete(speakerId); }
          lastHypotheses.set(speakerId, value);
          observe(value);
        } else {
          endpoints.delete(speakerId); lastHypotheses.delete(speakerId);
        }
        mgr.handleTranscriptionResult(speakerId, (r?.text || '').trim(), segs?.[segs.length - 1]?.end, segs, langOf(r?.language));
        // A request already in flight may have missed the tail. Reuse its result first, then submit once.
        if (endpoints.has(speakerId)) mgr.requestEarlySubmit(speakerId);
      } catch (e) {
        if (channel !== undefined) asrDiagnostic({channel, request, stage:'failed', at_ms:Date.now(), roundtrip_ms:Date.now()-started});
        endpoints.delete(speakerId);
        opts.onError?.(e);                          // P18: report the fault, don't swallow it…
        mgr.handleTranscriptionResult(speakerId, '');   // …but still free the turn (graceful degrade)
      }
    })();
    inflight.set(p, speakerId);
    void p.finally(() => inflight.delete(p));
  };

  mgr.onSegmentConfirmed = (speakerId, speakerName, text, startMs, endMs, _segmentId, lang) => {
    if (!text.trim()) return;
    opts.sink.segment(segOf(speakerName, speakerId, text, startMs, endMs, true, lang));
  };
  mgr.onSegmentPending = (speakerId, speakerName, text, startMs, lang) => {
    opts.sink.draft?.({ ...segOf(speakerName, speakerId, text, startMs, startMs, false, lang), confidence: 0 });
  };

  const settle = async (key?: string) => {
    let pending: Promise<void>[];
    while ((pending = [...inflight].filter(([, id]) => key === undefined || id === key).map(([p]) => p)).length) await Promise.all(pending);
  };
  // Close a finished turn: final-submit + emit (name is fixed on the key, so the late
  // transcribe can't be mislabeled), then free the stream after it has long settled.
  const closeTurn = (key: string) => {
    if(closing.has(key))return;
    closing.add(key);
    void (async () => {
      await mgr.flushSpeaker(key, true);
      // Bounded windows may need several ASR calls; cleanup must wait for this turn's tail.
      await settle(key);
      mgr.removeSpeaker(key);
      opts.onStreamClosed?.(key);
      participants.delete(key);
      sourceChannels.delete(key);
      endpoints.delete(key); lastHypotheses.delete(key);
    })().catch(e => opts.onError?.(e)).finally(()=>closing.delete(key));
  };

  return {
    requestEndpoint(channel, endMs) {
      const st = chan.get(channel);
      if (st && endMs === null) { endpoints.delete(st.key); return; }
      if (disposed || !st || endMs === null || closing.has(st.key) || !Number.isFinite(endMs) || endMs > Date.now() + 1000
          || endMs < st.onsetMs || endMs < mgr.getBufferStartMs(st.key)
          || (st.endpointMs !== undefined && endMs <= st.endpointMs)) return;
      st.endpointMs = endMs;
      const previous = lastHypotheses.get(st.key);
      if (previous && coversEndpoint(previous, endMs)) { observe({ ...previous, final: true }); return; }
      endpoints.set(st.key, endMs);
      mgr.requestEarlySubmit(st.key);
    },
    feedAudio: (channel,glowName,pcm,tsMs,participantId,startSample) => {
      let accepted;
      try { accepted=timeline.append({session,source:String(channel),samples:pcm,captureMs:tsMs,startSample}); }
      catch(error) {opts.onError?.({source:'capture',kind:'invalid-frame',detail:String(error)});return;}
      for(const event of accepted.events) {try{opts.onTimelineEvent?.(event);}catch(error){opts.onError?.({source:"archive",kind:"timeline-write-failed",detail:String(error)});}if(event.kind==='source-limit')opts.onError?.({source:'buffer',kind:'source-limit',detail:'Audio source limit reached'});}
      if(!accepted.frame)return;
      try{opts.onAudioFrame?.(accepted.frame);}catch(error){opts.onError?.({source:"archive",kind:"write-failed",detail:String(error)});}
      if(!opts.transcribe)return;
      const frame=accepted.frame;
      const existing=chan.get(channel);
      let energy=0;for(const value of frame.samples)energy+=value*value;
      const voiced=Math.sqrt(energy/frame.samples.length)>=(opts.config?.silenceRmsThreshold ?? .0001);
      if(!voiced && (!existing || frame.captureMs-existing.lastSpeechMs>300))return;
      const onset=!existing || frame.captureMs-existing.lastSpeechMs>ONSET_GAP;
      let readStart=Math.max(0,frame.startSample-(onset?Math.round(timeline.sampleRate*.2):0),frame.endSample-timeline.capacity);
      if(!timeline.read(session,String(channel),readStart,frame.endSample).samples)readStart=frame.startSample;
      const read=timeline.read(session,String(channel),readStart,frame.endSample);
      if(!read.samples||read.captureMs===null)return;
      pcm=read.samples;tsMs=read.captureMs;
      let st = chan.get(channel);
      // A channel-turn ends on EITHER a silence gap OR a confident glow-name CHANGE.
      // The glow-change case is the one overlap breaks: a channel rotates to a new
      // speaker mid-stream with NO silence gap, so the gap alone would hold the stale
      // name (the Галина→Зоя mislabel). A different single glow IS the rotation signal.
      const gapOnset=!!st && frame.captureMs-st.lastSpeechMs>ONSET_GAP;
      const identityRotation = voiced && !!st && participantId !== undefined && participants.has(st.key) && participants.get(st.key) !== participantId;
      const glowRotation = voiced && !!st && !!glowName && st.name !== UNKNOWN && glowName !== st.name;
      if (!st || gapOnset || glowRotation || identityRotation) {
        // TURN ONSET / rotation: close the previous turn and open a fresh stream named
        // from the glow lit RIGHT NOW (fixed for the turn — held through overlap below).
        if (st) closeTurn(st.key);
        const turn = (st ? st.turn : 0) + 1;
        const key = `ch-${channel}:${turn}`;
        if(!mgr.addSpeaker(key,glowName || UNKNOWN))return;
        sourceChannels.set(key, channel);
        st = { key, name: glowName || UNKNOWN, onsetMs: frame.captureMs, lastMs:tsMs,lastSpeechMs:frame.captureMs,turn };
        chan.set(channel, st);

      } else if (voiced && st.name === UNKNOWN && glowName) {
        // Onset was during overlap (no single glow) → opened UNKNOWN; a confident single
        // glow has now appeared early in the turn → adopt it (upgrade unknown→name only).
        st.name = glowName;
        mgr.updateSpeakerName(st.key, glowName);
      }
      if (voiced && (participantId === null || (participantId && participantId.length <= 512))) participants.set(st.key, participantId);
      st.lastMs = tsMs;
      if(voiced)st.lastSpeechMs=frame.captureMs+frame.samples.length/timeline.sampleRate*1000;
      opts.onStreamAudio?.(st.key,pcm,tsMs);
      mgr.feedAudio(st.key, pcm, tsMs);
    },
    flush: async () => { for (const st of chan.values()) await mgr.flushSpeaker(st.key, true); await settle(); },
    dispose: async () => {
      disposed = true; endpoints.clear();
      for (const st of chan.values()) await mgr.flushSpeaker(st.key, true);
      await settle();
      mgr.removeAll();
      lastHypotheses.clear();
      timeline.release(session);
      await opts.sink.finalize();
    },
  };
}
