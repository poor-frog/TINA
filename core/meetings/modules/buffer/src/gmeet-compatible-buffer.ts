import { longestCommonWordPrefix } from './local-agreement.js';

/**
 * Faithful shared reconstruction of Google Meet's transcription-window manager.
 *
 * Google Meet intentionally keeps its pipeline-local implementation intact in this release.
 * Microsoft Teams may consume this shared copy only after its continuous-audio parity proof.
 * Any later consolidation back into Google Meet is a separate release decision.
 *
 * The default runtime behavior below matches
 * core/meetings/modules/gmeet-pipeline/src/speaker-streams.ts. The only adaptations are
 * injected side effects (clock, logger, hallucination predicate), optional timer scheduling,
 * an opt-out for the GMeet-default batch-input gap guard, and a manual submission hook used by
 * deterministic replay. Those seams do not change the production defaults or confirmation/window
 * lifecycle.
 */

/**
 * Per-speaker audio buffer with offset-based sliding window.
 *
 * Two pointers track progress through a continuous audio stream:
 *   - confirmedSamples: audio before this has been confirmed and emitted
 *   - totalSamples: end of audio buffer
 *
 * Each Whisper submission sends only unconfirmed audio (confirmedSamples → totalSamples).
 * On confirmation, confirmedSamples advances — audio is trimmed from the front.
 * Buffer never fully resets during continuous speech. Full reset only on speaker
 * change or idle timeout.
 */

interface WhisperSegment {
  text: string;
  start: number;
  end: number;
}

interface SpeakerBuffer {
  speakerId: string;
  speakerName: string;
  chunks: Float32Array[];
  totalSamples: number;
  /** Samples already confirmed and emitted — next submission starts here */
  confirmedSamples: number;
  /**
   * The buffer's manual replay seam must preserve GMeet's per-stream timer semantics: the first
   * ordinary Whisper call is not due until one submit interval after the stream is created, and
   * later ordinary calls are separated by at least one interval. Forced close/finalization calls
   * deliberately bypass this deadline, matching GMeet's existing flush paths.
   */
  nextManualSubmitAtMs: number;
  lastTranscript: string;
  confirmCount: number;
  /** Word-level prefix confirmation: words from previous Whisper submission */
  lastWords: string[];
  inFlight: boolean;
  /** Wall-clock time (ms) when the current unconfirmed window started */
  windowStartMs: number;
  /** Wall-clock time (ms) when the buffer first started (for segment timing) */
  bufferStartMs: number;
  /** Monotonic sequence number for segment_id generation */
  sequenceNumber: number;
  /** Wall-clock time (ms) when audio was last fed */
  lastAudioTimestamp: number;
  /** Whether we already submitted a final idle attempt */
  idleSubmitted: boolean;
  /** Segmentation closed this buffer while a draft request was in flight:
   *  that response's text covers the pre-trim window — discard it and
   *  resubmit the owned (trimmed) audio as the final window. */
  pendingFinal: boolean;
  /** Samples inherited from a previous speaker via carry-forward */
  carryForwardSamples: number;
  /** Generation counter — incremented on full reset to detect stale responses */
  generation: number;
  /** Last confirmed text — passed as prompt to Whisper for context continuity */
  lastConfirmedText: string;
  /** The text of the OUTSTANDING (unconfirmed) live pending draft, or '' if none.
   *  Set every time onSegmentPending publishes a draft; cleared when that draft is
   *  finalized (re-emitted confirmed under the same id) or the buffer fully resets.
   *  A turn-close uses it to FINALIZE the draft so it never lingers as completed:false. */
  pendingDraftText: string;
  /** STT-detected (or invocation-forced, echoed by the service) language of the most recently
   *  accepted transcription result — stamped on every segment this buffer emits. Undefined until
   *  the first accepted result: undetected stays honest (never defaulted to 'en' here). */
  lastLanguage?: string;
  /** windowStartMs the outstanding pending draft was published under — its segment id.
   *  Finalizing re-emits the confirmed under THIS exact start so the consumer's
   *  upsert-by-id replaces the pending row (rather than appending a new id and
   *  leaving the draft dangling). */
  pendingDraftStartMs: number;
  submittedEndSample?: number;
  lastTranscriptEndSample?: number;
  capCutSample?: number;
}

export type GmeetCompatibleSubmissionTrigger =
  | 'interval'
  | 'manual'
  | 'forced'
  | 'input-gap'
  | 'deferred-final';

export interface GmeetCompatibleBufferConfig {
  /** Minimum unconfirmed audio before submission (seconds). Default: 2 */
  minAudioDuration?: number;
  /** PCM retention bound; live hosts use 30s, batch replay may retain up to 90s. */
  maxRetainedDuration?:number;
  /** Interval between submissions (seconds). Default: 2 */
  submitInterval?: number;
  /** Consecutive matches to confirm. Default: 2 */
  confirmThreshold?: number;
  /** Maximum ASR window (seconds), capped at 30 for recording refinement. Default: 30 */
  maxBufferDuration?: number;
  /** Idle timeout — emit and reset after this many seconds of no audio. Default: 15 */
  idleTimeoutSec?: number;
  /** Sample rate. Default: 16000 */
  sampleRate?: number;
  /** Energy floor before ASR, not a speech detector. Default: 0.0001 (-80 dBFS) blocks digital
   *  silence/quantization residue while retaining quiet speech below the former 0.0025 gate.
   *  Backend VAD and the phrase filter still handle non-speech above this floor. */
  silenceRmsThreshold?: number;
  /**
   * After LocalAgreement confirms leading Whisper segments, publish the remaining segment text as
   * the new pending tail. Default false preserves the copied GMeet behavior. Teams enables this
   * because its wall-clock witness proved the prefix early-return can hide available words for
   * longer than the 4–5 second live-update target.
   */
  publishTrailingDraftAfterPrefix?: boolean;
  /**
   * Flush when timestamped batch input jumps by more than two seconds. Default true preserves the
   * copied GMeet batch-feeder behavior. A caller that already owns continuous-turn boundaries may
   * disable it so feedAudio never creates a second, off-timer submission path.
   */
  flushOnInputGap?: boolean;
  /** Schedule the same wall-clock interval as Google Meet. Default: true. */
  scheduleSubmissions?: boolean;
  /** Deterministic replay clock. Default: Date.now. */
  now?: () => number;
  /** Side-effect injection only; behavior is otherwise unchanged. Default: no-op. */
  logger?: (message: string) => void;
  /** Google Meet injects its phrase/repetition filter here. Default: accept non-empty text. */
  isHallucination?: (text: string) => boolean;
}

/** Root-mean-square energy of a PCM window in [-1,1]; the near-silent oracle (#617). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export class GmeetCompatibleBuffer {
  private buffers: Map<string, SpeakerBuffer> = new Map();
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private minAudioDuration: number;
  private maxRetainedDuration:number;
  private submitInterval: number;
  private confirmThreshold: number;
  private maxBufferDuration: number;
  private idleTimeoutSec: number;
  private sampleRate: number;
  private silenceRmsThreshold: number;
  private publishTrailingDraftAfterPrefix: boolean;
  private flushOnInputGap: boolean;
  private scheduleSubmissions: boolean;
  private now: () => number;
  private log: (message: string) => void;
  private isHallucination: (text: string) => boolean;
  /** Audio carried forward from a flushed short segment — prepended to the next feedAudio call */
  private carryForward: Float32Array[] = [];
  /** Generation at time of last submission — used to detect stale responses after fullReset */
  private submitGeneration: Map<string, number> = new Map();

  onOverflow:((samples:number)=>void)|null=null;
  onLimit:((limit:number)=>void)|null=null;
  /** Called when unconfirmed audio needs transcription. */
  onSegmentReady: ((
    speakerId: string,
    speakerName: string,
    audioBuffer: Float32Array,
    trigger?: GmeetCompatibleSubmissionTrigger,
  ) => void) | null = null;

  /** Called when a segment is confirmed and should be published. */
  onSegmentConfirmed: ((speakerId: string, speakerName: string, transcript: string, bufferStartMs: number, bufferEndMs: number, segmentId: string, language?: string) => void) | null = null;

  /** Called with the UNCONFIRMED forming tail after each submission (the "pending"
   *  draft) — parity with ChunkedTranscriber's publishPending, so the multistream
   *  (gmeet per-participant) path shows a live forming tail like the mixed path,
   *  not just confirmed text. Empty string ⇒ clear the speaker's draft. */
  onSegmentPending: ((speakerId: string, speakerName: string, text: string, bufferStartMs: number, language?: string) => void) | null = null;

  constructor(config?: GmeetCompatibleBufferConfig) {
    this.minAudioDuration = config?.minAudioDuration ?? 2;
    const retained=config?.maxRetainedDuration ?? 90;
    if(!Number.isFinite(retained)||retained<1)throw new Error("Invalid PCM retention duration");
    this.maxRetainedDuration=Math.min(retained,90);
    this.submitInterval = config?.submitInterval ?? 2;
    this.confirmThreshold = config?.confirmThreshold ?? 2;
    this.maxBufferDuration = Math.min(config?.maxBufferDuration ?? 30, 30);
    this.idleTimeoutSec = config?.idleTimeoutSec ?? 15;
    this.sampleRate = config?.sampleRate ?? 16000;
    this.silenceRmsThreshold = config?.silenceRmsThreshold ?? 0.0001;
    this.publishTrailingDraftAfterPrefix = config?.publishTrailingDraftAfterPrefix ?? false;
    this.flushOnInputGap = config?.flushOnInputGap ?? true;
    this.scheduleSubmissions = config?.scheduleSubmissions ?? true;
    this.now = config?.now ?? Date.now;
    this.log = config?.logger ?? (() => undefined);
    this.isHallucination = config?.isHallucination ?? ((text) => !text?.trim());
  }

  addSpeaker(speakerId:string,speakerName:string):boolean {
    if (this.buffers.has(speakerId)) return true;
    if(this.buffers.size>=32){this.onLimit?.(32);return false;}

    const now = this.now();
    this.buffers.set(speakerId, {
      speakerId,
      speakerName,
      chunks: [],
      totalSamples: 0,
      confirmedSamples: 0,
      nextManualSubmitAtMs: now + this.submitInterval * 1000,
      lastTranscript: '',
      confirmCount: 0,
      lastWords: [],
      inFlight: false,
      windowStartMs: now,
      bufferStartMs: now,
      sequenceNumber: 0,
      lastAudioTimestamp: now,
      idleSubmitted: false,
      pendingFinal: false,
      carryForwardSamples: 0,
      generation: 0,
      lastConfirmedText: '',
      pendingDraftText: '',
      pendingDraftStartMs: now,
    });

    if (this.scheduleSubmissions) {
      const timer = setInterval(() => this.trySubmit(speakerId), this.submitInterval * 1000);
      this.timers.set(speakerId, timer);
    }

    this.log(`[SpeakerStreams] Added speaker "${speakerName}" (${speakerId})`);
    return true;
  }

  /**
   * @param atMs Optional wall-clock time the audio was actually SPOKEN
   *             (turn start). Batch feeders (MixedAudioPipeline turns arrive
   *             seconds after speech, all at once) pass it so published
   *             segment times reflect speech time, not feed time. Live
   *             streamers omit it (feed time ≈ speech time).
   */
  feedAudio(speakerId: string, audioData: Float32Array, atMs?: number): void {
    const buffer = this.buffers.get(speakerId);
    if (!buffer) return;

    const capacity=this.sampleRate*this.maxRetainedDuration;
    if(buffer.totalSamples+audioData.length>capacity) {
      const lost=Math.max(0,buffer.totalSamples-buffer.confirmedSamples)+Math.max(0,audioData.length-capacity);
      this.onOverflow?.(lost);
      const pending=buffer.inFlight;
      this.clearStaleDraft(buffer);
      this.fullReset(buffer);
      buffer.inFlight=pending; // the old request must finish before a new generation can submit
      if(audioData.length>capacity) {
        const skipped=audioData.length-capacity;
        audioData=audioData.subarray(skipped);
        if(atMs!==undefined)atMs+=skipped/this.sampleRate*1000;
      }
    }

    // Gap guard for batch feeders: turns of one speaker arrive separated by
    // other speakers' turns. Concatenating non-contiguous audio into one
    // buffer maps Whisper offsets onto a gapless timeline — the second turn's
    // words get stamped near the first turn's end instead of when they were
    // actually spoken, shuffling cross-speaker order. If the new audio is not
    // contiguous with what's buffered (>2s gap), flush the buffer first so
    // each contiguous stretch keeps a truthful time base.
    if (this.flushOnInputGap && atMs !== undefined && buffer.totalSamples > 0) {
      const bufferedEndMs = buffer.windowStartMs + (buffer.totalSamples / this.sampleRate) * 1000;
      if (atMs - bufferedEndMs > 2000) {
        // Detach the buffered stretch and finish it asynchronously on the
        // snapshot, then reset the live buffer NOW — the new turn must never
        // append to (or race with) the old stretch. fullReset() assigns fresh
        // arrays, so the snapshot keeps the old chunks untouched.
        const detached: SpeakerBuffer = { ...buffer };
        this.fullReset(buffer);
        if (detached.lastTranscript) {
          this.emitSegment(detached, detached.lastTranscript);
        } else if (detached.totalSamples - detached.confirmedSamples > 0 && !detached.inFlight) {
          void this.submitBuffer(detached, 'input-gap').then(() => {
            if (detached.lastTranscript) this.emitSegment(detached, detached.lastTranscript);
          }).catch((err: any) => {
            // P18 (ADR 0010): fail LOUD + attributed — never drop a transcription failure silently.
            // The typed STT fault carries `.kind` (unauthorized / payment_required / rate_limited / …).
            this.log(`[SpeakerStreams] [STT-FAULT] ${err?.kind ?? 'error'} on deferred close for ` +
                `"${detached.speakerName}": ${String(err?.message ?? err)} (audio dropped)`);
          });
        }
      }
    }

    // Set window start on first audio after reset — this ensures the segment's
    // start time reflects when the audio was actually spoken, not when the
    // buffer was cleared. Critical for speaker-mapper and cross-speaker order.
    if (buffer.totalSamples === 0) {
      buffer.windowStartMs = atMs ?? this.now();
      buffer.bufferStartMs = atMs ?? this.now();
    }

    buffer.chunks.push(audioData);
    buffer.totalSamples += audioData.length;
    buffer.lastAudioTimestamp = this.now();
    if (!buffer.inFlight) buffer.idleSubmitted = false;
  }

  /**
   * Handle Whisper result. Accepts individual Whisper segments for incremental
   * confirmation — stable leading segments are emitted individually rather than
   * waiting for the entire text to stabilize.
   *
   * @param segments - Whisper segments with text and timing. If empty/undefined,
   *                   falls back to full-text confirmation using transcript param.
   * @param segmentEndSec - end time (seconds) of the last segment Whisper returned,
   *                        relative to the start of the submitted audio.
   * @returns true if the result was accepted into the confirmation pipeline;
   *          false if it was discarded (stale generation, or a deferred-close
   *          finalization superseded it). Callers must NOT publish a pending
   *          draft for a rejected result — its text describes audio this
   *          buffer no longer owns.
   */
  handleTranscriptionResult(speakerId: string, transcript: string, segmentEndSec?: number, segments?: WhisperSegment[], language?: string): boolean {
    const buffer = this.buffers.get(speakerId);
    if (!buffer) return false;

    buffer.inFlight = false;

    // Discard stale responses: if the buffer was reset (generation bumped)
    // while a Whisper request was in flight, this response is for audio that
    // no longer exists. Accepting it would poison lastTranscript with text
    // from a previous segment.
    const submitGen = this.submitGeneration.get(speakerId);
    if (submitGen !== undefined && submitGen < buffer.generation) {
      return false;
    }

    // The window's language (STT-detected, or the forced code the service echoes back). Stamped
    // now — before any emit path below — so the very confirm this result triggers carries it.
    if (language) buffer.lastLanguage = language;

    if (buffer.capCutSample !== undefined) {
      this.finishCappedWindow(buffer, transcript);
      return false;
    }

    // Segmentation closed this buffer while this request was in flight: the
    // text covers the pre-trim window (may include the next segment's audio).
    // Discard it and submit the owned audio as the final window.
    if (buffer.pendingFinal) {
      buffer.pendingFinal = false;
      if (this.unconfirmedSamples(buffer) === 0) {
        this.fullReset(buffer);
        return false;
      }
      buffer.idleSubmitted = true;
      this.log(`[SpeakerStreams] Final resubmit for "${buffer.speakerName}" after deferred close (${(this.unconfirmedSamples(buffer) / this.sampleRate).toFixed(1)}s audio)`);
      void this.submitBuffer(buffer, 'deferred-final');
      return false;
    }

    if (!transcript || transcript.trim().length === 0) {
      if (buffer.idleSubmitted) {
        // The FINAL re-transcription came back empty (VAD/Whisper drift), but we
        // already showed good text as pending. Finalize THAT instead of dropping
        // the turn — the "pending then lost" loss. emitSegment self-guards.
        if (buffer.lastTranscript) this.emitSegment(buffer, buffer.lastTranscript);
        this.fullReset(buffer);
      }
      return false;
    }

    const trimmed = transcript.trim();

    // Hallucination filter — drop known junk before it enters the confirmation pipeline
    if (this.isHallucination(trimmed)) {
      this.log(`[SpeakerStreams] [FILTERED] Hallucination for "${buffer.speakerName}": "${trimmed.substring(0, 60)}"`);
      if (buffer.idleSubmitted) {
        // The FINAL submit hallucinated, but earlier pending text was clean —
        // finalize the last good text rather than losing the whole turn.
        if (buffer.lastTranscript) this.emitSegment(buffer, buffer.lastTranscript);
        this.fullReset(buffer);
      }
      return false;
    }

    // Idle/flush submit — emit immediately, this is the last chance
    if (buffer.idleSubmitted) {
      buffer.capCutSample = buffer.submittedEndSample ?? buffer.totalSamples;
      this.finishCappedWindow(buffer, trimmed);
      return true;
    }

    // Invalid model offsets cannot become final timestamps; confirm the text on its owned audio instead.
    const coveredSec = ((buffer.submittedEndSample ?? buffer.totalSamples) - buffer.confirmedSamples) / this.sampleRate;
    if (segments?.some(s => !Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end <= s.start)) segments = undefined;
    if (!Number.isFinite(segmentEndSec) || (segmentEndSec ?? 0) <= 0) segmentEndSec = undefined;

    // Word-level prefix confirmation (LocalAgreement-2, UFAL whisper_streaming).
    // Instead of comparing segment texts by position (which fails because Whisper
    // re-segments as the buffer grows), we concatenate all segments into words and
    // find the longest common prefix across consecutive submissions. This is robust
    // to segment boundary shifts — only the leading WORDS need to be stable.
    if (segments && segments.length > 0) {
      const currentWords = segments.flatMap(s => s.text.trim().split(/\s+/).filter(w => w.length > 0));
      const prevWords = buffer.lastWords;

      // Longest common word prefix across consecutive submissions (shared core).
      const prefixLen = longestCommonWordPrefix(currentWords, prevWords);

      buffer.lastWords = currentWords;

      // The live draft is published ONCE per submission, as the WHOLE forming window text, by the
      // full-text fall-through below — so a consumer that upserts by segment_id sees a single draft
      // that only grows. Emitting a second draft here (the unconfirmed tail, a shorter fragment under
      // the SAME id `key:round(windowStartMs)`) made the draft alternate full↔fragment → a visible
      // upsert flicker. The whole-window draft is the sole pending representation; confirmed prefixes
      // below are published separately as confirmed segments.

      // Confirm if prefix covers at least 1 word but NOT all current words
      // (trailing words are still forming and may change next submission).
      // With confirmThreshold=2, having a common prefix between 2 consecutive
      // submissions already satisfies the threshold.
      if (prefixLen > 0 && prefixLen < currentWords.length) {
        // Map confirmed prefix words back to full Whisper segments for timestamps.
        // Only emit segments whose words are entirely within the confirmed prefix.
        let wordsRemaining = prefixLen;
        let confirmedSegCount = 0;
        for (const seg of segments) {
          const segWordCount = seg.text.trim().split(/\s+/).filter(w => w.length > 0).length;
          if (wordsRemaining >= segWordCount) {
            wordsRemaining -= segWordCount;
            confirmedSegCount++;
          } else {
            break; // Partial segment — don't emit partial
          }
        }

        if (confirmedSegCount > 0 && segments.slice(0, confirmedSegCount).every(s => coveredSec === 0 || s.start < coveredSec)) {
          const baseWindowMs = buffer.windowStartMs;
          const previousConfirmedText = buffer.lastConfirmedText;
          for (let i = 0; i < confirmedSegCount; i++) {
            const seg = segments[i];
            buffer.windowStartMs = baseWindowMs + Math.floor(seg.start * 1000);
            const segEndMs = baseWindowMs + Math.floor((coveredSec > 0 ? Math.min(seg.end, coveredSec) : seg.end) * 1000);
            if (!seg.text.trim() || !this.onSegmentConfirmed) continue;
            if (this.isHallucination(seg.text.trim())) {
              this.log(`[SpeakerStreams] [FILTERED] Hallucination segment for "${buffer.speakerName}": "${seg.text.trim().substring(0, 60)}"`);
              continue;
            }
            // Reject a copied prior prompt, but keep repetitions inside this ASR result.
            if (seg.text.trim() === previousConfirmedText) {
              this.clearStaleDraft(buffer);
              continue;
            }
            const segmentId = `${buffer.speakerId}:${buffer.sequenceNumber}`;
            this.onSegmentConfirmed(buffer.speakerId, buffer.speakerName, seg.text.trim(), buffer.windowStartMs, segEndMs, segmentId, buffer.lastLanguage);
            this.clearStaleDraft(buffer, buffer.windowStartMs);
            buffer.sequenceNumber++;
            buffer.lastConfirmedText = seg.text.trim();
          }
          const lastConfirmedSeg = segments[confirmedSegCount - 1];
          buffer.windowStartMs = baseWindowMs;
          const confirmedEnd = coveredSec > 0 ? Math.min(lastConfirmedSeg.end, coveredSec) : lastConfirmedSeg.end;
          this.advanceOffset(buffer, confirmedEnd);
          buffer.windowStartMs = baseWindowMs + Math.floor(confirmedEnd * 1000);
          if (this.publishTrailingDraftAfterPrefix && this.onSegmentPending) {
            const trailingText = segments.slice(confirmedSegCount)
              .map((segment) => segment.text.trim())
              .filter(Boolean)
              .join(' ')
              .trim();
            if (trailingText) {
              buffer.pendingDraftText = trailingText;
              buffer.pendingDraftStartMs = buffer.windowStartMs;
              this.onSegmentPending(
                buffer.speakerId,
                buffer.speakerName,
                trailingText,
                buffer.windowStartMs,
                buffer.lastLanguage,
              );
            }
          }
          return true;
        }
      }

      // No prefix confirmed yet — fall through to full-text check
    }

    // Full string match — text must be identical across consecutive submissions.
    // Ensures Whisper has fully stabilized before we confirm and advance the offset.
    if (trimmed === buffer.lastTranscript) {
      buffer.confirmCount++;
    } else {
      buffer.lastTranscript = trimmed;
      buffer.confirmCount = 1;
    }

    buffer.lastTranscriptEndSample = buffer.submittedEndSample;
    if (buffer.confirmCount >= this.confirmThreshold) {
      // CONFIRMED — emit and advance offset to Whisper's segment boundary.
      this.emitSegment(buffer, trimmed);
      this.advanceOffset(buffer, segmentEndSec);
    } else if (this.onSegmentPending) {
      // Still forming — emit the whole draft as pending (no per-segment timing here).
      // Remember it (text + the id it went out under) so a turn-close can FINALIZE it
      // instead of leaving a dangling completed:false.
      buffer.pendingDraftText = trimmed;
      buffer.pendingDraftStartMs = buffer.windowStartMs;
      this.onSegmentPending(buffer.speakerId, buffer.speakerName, trimmed, buffer.windowStartMs, buffer.lastLanguage);
    }
    return true;
  }

  removeSpeaker(speakerId: string): void {
    const timer = this.timers.get(speakerId);
    if (timer) clearInterval(timer);
    this.timers.delete(speakerId);

    const buffer = this.buffers.get(speakerId);
    if (buffer) {
      if (this.unconfirmedSamples(buffer) > 0 && buffer.lastTranscript) {
        this.emitSegment(buffer, buffer.lastTranscript);
      }
      // Finalize any still-outstanding pending draft (emitSegment above may have cleared it; if
      // not — e.g. no unconfirmed audio remained — this confirms it so no completed:false dangles).
      this.finalizePendingDraft(buffer);
    }

    this.buffers.delete(speakerId);
  }

  hasSpeaker(speakerId: string): boolean {
    return this.buffers.has(speakerId);
  }

  updateSpeakerName(speakerId: string, newName: string): boolean {
    const buffer = this.buffers.get(speakerId);
    if (!buffer || buffer.speakerName === newName) return false;
    this.log(`[SpeakerStreams] Updated speaker name "${buffer.speakerName}" → "${newName}" (${speakerId})`);
    buffer.speakerName = newName;
    return true;
  }

  getSpeakerName(speakerId: string): string | undefined {
    return this.buffers.get(speakerId)?.speakerName;
  }

  getSegmentId(speakerId: string): string {
    const buffer = this.buffers.get(speakerId);
    const seq = buffer?.sequenceNumber ?? 0;
    return `${speakerId}:${seq}`;
  }

  getActiveSpeakers(): string[] {
    return Array.from(this.buffers.keys());
  }

  getBufferStartMs(speakerId: string): number {
    return this.buffers.get(speakerId)?.windowStartMs ?? this.now();
  }

  getLastConfirmedText(speakerId: string): string {
    return this.buffers.get(speakerId)?.lastConfirmedText ?? '';
  }

  /**
   * Deterministic replay seam: ask the manager to run the same submit path now instead of waiting
   * for its interval. The default scheduled runtime never needs this method.
   */
  async requestTranscription(speakerId: string, force: boolean = false): Promise<boolean> {
    const buffer = this.buffers.get(speakerId);
    if (!buffer || buffer.inFlight) return false;
    if (!force && this.now() < buffer.nextManualSubmitAtMs) return false;
    if (!force && this.unconfirmedSamples(buffer) / this.sampleRate < this.minAudioDuration) return false;
    const requested = await this.submitBuffer(buffer, force ? 'forced' : 'manual');
    if (requested) buffer.nextManualSubmitAtMs = this.now() + this.submitInterval * 1000;
    return requested;
  }

  removeAll(): void {
    for (const speakerId of Array.from(this.buffers.keys())) {
      this.removeSpeaker(speakerId);
    }
  }

  /**
   * Force-flush on speaker change. If enough audio, emit and full reset.
   * If too short, keep chunks for the speaker's next turn.
   */
  /**
   * @param force - if true, flush regardless of minAudioDuration (end-of-stream)
   * @param trimAtMs - segmentation boundary (audio-time ms): audio after this
   *                   belongs to the NEXT segment buffer (the pipeline re-feeds
   *                   it there) — drop it here so the same frames are never
   *                   transcribed under both segments.
   */
  async flushSpeaker(speakerId: string, force: boolean = false, trimAtMs?: number): Promise<void> {
    const buffer = this.buffers.get(speakerId);
    if (!buffer) return;

    if (trimAtMs !== undefined) this.trimTailAfter(buffer, trimAtMs);
    if (buffer.totalSamples === 0) {
      // No audio owned, but a pending draft may still be dangling (the live "stale pending"
      // case: a draft formed, the window was trimmed/confirmed to empty, then the turn closes).
      // Finalize it so it doesn't linger as completed:false.
      this.finalizePendingDraft(buffer);
      this.fullReset(buffer);
      return;
    }

    const unconfirmedSec = this.unconfirmedSamples(buffer) / this.sampleRate;

    // Short audio on speaker change: submit to Whisper directly rather than
    // carry-forward. Carry-forward shifts word timestamps relative to the next
    // speaker's buffer start, which makes the speaker-mapper unable to attribute
    // carried words correctly. Direct submission preserves correct timing.

    // Have transcript — emit and reset
    if (buffer.lastTranscript && (buffer.lastTranscriptEndSample === undefined || buffer.lastTranscriptEndSample >= buffer.totalSamples) && buffer.totalSamples / this.sampleRate <= this.maxBufferDuration) {
      this.emitSegment(buffer, buffer.lastTranscript);
      this.fullReset(buffer);
      return;
    }

    // Have audio but no transcript — final Whisper submit
    if (this.unconfirmedSamples(buffer) > 0) {
      if (buffer.inFlight) {
        // A draft request is in flight for the PRE-TRIM window. Discarding
        // the buffer here loses the whole segment's audio (multi-second
        // transcript holes). Instead: when the response lands, its text is
        // discarded and the owned audio resubmitted as the final window.
        buffer.pendingFinal = true;
        this.log(`[SpeakerStreams] Close while in-flight for "${buffer.speakerName}" — finalize deferred to response (${unconfirmedSec.toFixed(1)}s audio held)`);
        return;
      }
      buffer.idleSubmitted = true;
      this.log(`[SpeakerStreams] Flush-submit for "${buffer.speakerName}" (${unconfirmedSec.toFixed(1)}s audio, no transcript yet)`);
      await this.submitBuffer(buffer, 'forced');
      return;
    }

    this.finalizePendingDraft(buffer);
    this.fullReset(buffer);
  }

  // ── Private ──────────────────────────────────────────────────

  /**
   * TURN-CLOSE finalize: if the speaker has an OUTSTANDING unconfirmed pending draft,
   * confirm it (emit via onSegmentConfirmed) under the SAME segment id it was published
   * under, then CLEAR the draft (onSegmentPending "") so NO completed:false lingers.
   *
   * This is the source-side fix for the "stale pending" bug: the draft was published
   * under id `key:round(pendingDraftStartMs)`; if the turn closes via a path that emits
   * the final confirmed segment under a DIFFERENT id (windowStartMs advanced), or that
   * doesn't emit at all (no audio buffered, or emit deduped to a no-op), the consumer's
   * upsert-by-id never replaces the draft and it dangles forever. Finalizing under the
   * draft's own id guarantees the upsert replaces it; the explicit clear is belt-and-
   * suspenders so no completed:false survives even if the confirm is filtered/deduped.
   *
   * Idempotent: clears pendingDraftText, so a second call is a no-op. Callers invoke it
   * before fullReset on every close path.
   */
  private finalizePendingDraft(buffer: SpeakerBuffer): void {
    const text = buffer.pendingDraftText;
    if (!text) return;
    const startMs = buffer.pendingDraftStartMs;
    // Clear the tracking FIRST so emitSegment (called below) doesn't recurse/re-finalize.
    buffer.pendingDraftText = '';

    // Finalize: emit the draft text as a CONFIRMED segment under the draft's own id, so a
    // consumer upserting by id replaces the pending row in place. We bypass emitSegment's
    // dedup-vs-lastConfirmedText guard on purpose — the pending row carries this exact text
    // as completed:false and MUST be replaced by a completed:true row of the same id.
    const covered = Math.min(buffer.lastTranscriptEndSample ?? buffer.submittedEndSample ?? buffer.totalSamples, buffer.totalSamples);
    const endMs = covered > 0 ? (buffer.windowStartMs + covered / this.sampleRate * 1000) : startMs;
    if (Number.isFinite(endMs) && endMs > startMs && endMs - startMs <= this.maxBufferDuration * 1000 && text !== buffer.lastConfirmedText && this.onSegmentConfirmed && !this.isHallucination(text)) {
      this.onSegmentConfirmed(buffer.speakerId, buffer.speakerName, text, startMs, endMs, `${buffer.speakerId}:${buffer.sequenceNumber}`, buffer.lastLanguage);
      buffer.sequenceNumber++;
      buffer.lastConfirmedText = text;
    } else if (this.onSegmentPending) {
      // The text already went out confirmed (or is junk) — just CLEAR the dangling draft row
      // so no completed:false survives. Empty string ⇒ consumer drops the draft.
      this.onSegmentPending(buffer.speakerId, buffer.speakerName, '', startMs);
    }
  }

  private unconfirmedSamples(buffer: SpeakerBuffer): number {
    return buffer.totalSamples - buffer.confirmedSamples;
  }

  private async trySubmit(speakerId: string): Promise<void> {
    const buffer = this.buffers.get(speakerId);
    if (!buffer || buffer.inFlight) return;

    const unconfirmedSec = this.unconfirmedSamples(buffer) / this.sampleRate;
    const idleMs = this.now() - buffer.lastAudioTimestamp;

    // Idle timeout
    if (idleMs > this.idleTimeoutSec * 1000 && this.unconfirmedSamples(buffer) > 0) {
      if (!buffer.idleSubmitted) {
        buffer.idleSubmitted = true;
        this.log(`[SpeakerStreams] Idle submit for "${buffer.speakerName}" (${(idleMs/1000).toFixed(1)}s idle, final submission)`);
        await this.submitBuffer(buffer, 'interval');
        return;
      }
      if (!buffer.inFlight) {
        if (buffer.lastTranscript) {
          this.emitSegment(buffer, buffer.lastTranscript);
        }
        this.log(`[SpeakerStreams] Idle cleanup for "${buffer.speakerName}" (${(idleMs/1000).toFixed(1)}s idle)`);
        this.fullReset(buffer);
        return;
      }
      return;
    }

    // Submit if enough unconfirmed audio
    if (unconfirmedSec >= this.minAudioDuration) {
      await this.submitBuffer(buffer, 'interval');
    }
  }

  /**
   * Submit only the UNCONFIRMED portion of the buffer to Whisper.
   * Audio before confirmedSamples has already been transcribed and emitted.
   * Near-zero windows (RMS < silenceRmsThreshold) are not submitted; quieter speech is left to ASR VAD.
   */
  private async submitBuffer(
    buffer: SpeakerBuffer,
    trigger: GmeetCompatibleSubmissionTrigger,
  ): Promise<boolean> {
    if (!buffer.idleSubmitted && (trigger === 'interval' || trigger === 'manual')) {
      // Reserve a cadence plus the next capture frame for both scheduled and replay callers.
      const limit = Math.min(this.maxBufferDuration, this.maxRetainedDuration);
      const frameSec = (buffer.chunks.at(-1)?.length ?? 0) / this.sampleRate;
      const rolloverAt = Math.max(this.minAudioDuration, limit - Math.min(this.submitInterval + frameSec, limit / 2));
      if (this.unconfirmedSamples(buffer) / this.sampleRate >= rolloverAt) buffer.capCutSample = this.quietCutSample(buffer, 4);
    }
    let end = buffer.capCutSample ?? buffer.totalSamples;
    const limit = buffer.confirmedSamples + Math.floor(this.maxBufferDuration * this.sampleRate);
    if (end > limit) { end = this.quietCutSample(buffer, 4, limit); buffer.capCutSample = end; }
    const unconfirmed = end - buffer.confirmedSamples;
    if (unconfirmed <= 0 || !this.onSegmentReady) return false;

    // Build audio from confirmedSamples onward
    const combined = new Float32Array(unconfirmed);
    let dstOffset = 0;
    let samplesToSkip = buffer.confirmedSamples;

    for (const chunk of buffer.chunks) {
      if (dstOffset >= unconfirmed) break;
      if (samplesToSkip >= chunk.length) {
        samplesToSkip -= chunk.length;
        continue;
      }
      const start = samplesToSkip;
      samplesToSkip = 0;
      const toCopy = Math.min(chunk.length - start, unconfirmed - dstOffset);
      combined.set(chunk.subarray(start, start + toCopy), dstOffset);
      dstOffset += toCopy;
    }

    // The old 0.0025 default discarded real FLEURS speech (RMS 0.000814); energy alone is not VAD.
    if (rms(combined) < this.silenceRmsThreshold) {
      this.log(`[SpeakerStreams] [SILENT-SKIP] "${buffer.speakerName}" ${(unconfirmed / this.sampleRate).toFixed(1)}s window ` +
          `below RMS ${this.silenceRmsThreshold} — not submitting`);
      if (buffer.capCutSample !== undefined) {
        buffer.lastTranscript = '';
        this.finishCappedWindow(buffer, '');
      }
      return false;
    }

    buffer.submittedEndSample = end;
    buffer.inFlight = true;
    this.submitGeneration.set(buffer.speakerId, buffer.generation);

    try {
      this.onSegmentReady(buffer.speakerId, buffer.speakerName, combined, trigger);
      // Report that the callback was invoked, rather than inspecting `inFlight` after an await.
      // A fixture-cache hit may synchronously settle the callback's transcription promise and
      // clear `inFlight` before requestTranscription() resumes, but it was still a real Whisper
      // submission and must advance the manual seam's next-call deadline.
      return true;
    } catch (err: any) {
      buffer.inFlight = false;
      // P18: surface the transcription submit failure with its typed kind — do not swallow it.
      this.log(`[SpeakerStreams] [STT-FAULT] ${err?.kind ?? 'error'} submitting for ` +
          `"${buffer.speakerName}": ${String(err?.message ?? err)}`);
      return false;
    }
  }

  /**
   * Emit a confirmed segment. Does NOT reset the buffer — just publishes.
   */
  private emitSegment(buffer: SpeakerBuffer, text: string): void {
    if (!text || !this.onSegmentConfirmed) return;
    if (this.isHallucination(text)) {
      this.log(`[SpeakerStreams] [FILTERED] Hallucination in emit for "${buffer.speakerName}": "${text.substring(0, 60)}"`);
      return;
    }
    // Dedup: don't re-emit the same text that was just confirmed (acoustic echo / residual audio)
    if (text === buffer.lastConfirmedText) {
      this.log(`[SpeakerStreams] Dedup skip for "${buffer.speakerName}": "${text.substring(0, 50)}" (same as last confirmed)`);
      // The text is already confirmed, but a pending draft of it may still be dangling under a
      // DIFFERENT id — clear it so no completed:false lingers (the stale-pending bug's dedup case).
      this.clearStaleDraft(buffer);
      return;
    }
    // Audio-time end via the buffer's gapless timeline — NOT this.now(),
    // which is submit/commit ARRIVAL time and overstates the span by the
    // whole commit lag (segments then visually overlap their successors).
    const covered = Math.min(buffer.submittedEndSample ?? buffer.totalSamples, buffer.totalSamples);
    const endMs = buffer.windowStartMs + (covered - buffer.confirmedSamples) / this.sampleRate * 1000;
    if (!Number.isFinite(endMs) || endMs <= buffer.windowStartMs) { this.clearStaleDraft(buffer); return; }
    const segmentId = `${buffer.speakerId}:${buffer.sequenceNumber}`;
    this.onSegmentConfirmed(buffer.speakerId, buffer.speakerName, text, buffer.windowStartMs, endMs, segmentId, buffer.lastLanguage);
    buffer.sequenceNumber++;
    buffer.lastConfirmedText = text;
    // This confirmed segment supersedes the outstanding pending draft. If it went out under a
    // DIFFERENT id than the draft (windowStartMs advanced), the consumer's upsert-by-id won't
    // replace the draft — clear the stale draft row explicitly so it can't dangle as completed:false.
    this.clearStaleDraft(buffer, buffer.windowStartMs);
  }

  /**
   * Reconcile the outstanding pending draft after a confirmed emit at `confirmedStartMs`.
   * If the draft was published under a DIFFERENT id, emit an empty pending to drop that stale
   * row (the consumer keys drafts by `key:round(startMs)` and treats "" as a delete). Always
   * clears tracking; omit confirmedStartMs when no confirmed replacement will be emitted.
   */
  private clearStaleDraft(buffer: SpeakerBuffer, confirmedStartMs?: number): void {
    if (!buffer.pendingDraftText) return;
    const draftStartMs = buffer.pendingDraftStartMs;
    buffer.pendingDraftText = '';
    if ((confirmedStartMs === undefined || Math.round(draftStartMs) !== Math.round(confirmedStartMs)) && this.onSegmentPending) {
      this.onSegmentPending(buffer.speakerId, buffer.speakerName, '', draftStartMs);
    }
  }

  /**
   * Advance the offset to Whisper's segment boundary. Trim confirmed audio.
   * The buffer continues — audio after the segment boundary stays for next submission.
   *
   * @param segmentEndSec - Whisper's last segment end time (seconds relative to
   *                        submitted audio start). If undefined, trims the full
   *                        unconfirmed window (fallback, loses boundary context).
   */
  private advanceOffset(buffer: SpeakerBuffer, segmentEndSec?: number): void {
    if (segmentEndSec !== undefined) {
      // Advance to Whisper's segment boundary — preserves audio context
      // after the boundary for the next submission
      const samplesToAdvance = Math.floor(segmentEndSec * this.sampleRate);
      buffer.confirmedSamples += Math.min(samplesToAdvance, (buffer.submittedEndSample ?? buffer.totalSamples) - buffer.confirmedSamples);

      // Keep remaining unconfirmed audio — it may contain real speech that
      // Whisper transcribed but wasn't confirmed yet. It will accumulate with
      // new audio until long enough for the next submission.
    } else {
      // Fallback: trim everything (old behavior, loses boundary words)
      buffer.confirmedSamples = buffer.submittedEndSample ?? buffer.totalSamples;
    }

    const retainedStartMs = buffer.windowStartMs + buffer.confirmedSamples / this.sampleRate * 1000;
    // Trim confirmed chunks from the front to free memory
    this.trimBuffer(buffer);

    // Reset confirmation state for the next segment window
    buffer.lastTranscript = '';
    buffer.lastTranscriptEndSample = undefined;
    buffer.confirmCount = 0;
    buffer.lastWords = [];
    buffer.windowStartMs = retainedStartMs;
    this.clearStaleDraft(buffer);

    this.log(`[SpeakerStreams] Offset advanced for "${buffer.speakerName}" (confirmed=${buffer.confirmedSamples}, total=${buffer.totalSamples}, trimmed to ${buffer.chunks.length} chunks)`);
  }

  /**
   * Drop buffered audio AFTER an audio-time boundary (segmentation close).
   * The buffer's gapless timeline maps samples to windowStartMs + offset, so
   * everything past `tMs` is excess that streamed in during commit lag. Any
   * draft transcript described the untrimmed audio, so it is invalidated —
   * the flush that follows re-submits only the owned window.
   */
  private trimTailAfter(buffer: SpeakerBuffer, tMs: number): void {
    if (buffer.totalSamples === 0) return;
    const keep = Math.floor(((tMs - buffer.windowStartMs) / 1000) * this.sampleRate);
    if (keep >= buffer.totalSamples) return;
    if (keep <= 0) {
      // Boundary predates this window (offset drift or stale commit) — an
      // over-trim would discard real speech; keeping it only risks one
      // duplicated segment. Keep.
      this.log(`[SpeakerStreams] trimTailAfter skipped for "${buffer.speakerName}": boundary ${tMs} <= windowStart ${buffer.windowStartMs}`);
      return;
    }
    let excess = buffer.totalSamples - keep;
    const droppedSec = excess / this.sampleRate;
    while (excess > 0 && buffer.chunks.length > 0) {
      const last = buffer.chunks[buffer.chunks.length - 1];
      if (last.length <= excess) {
        excess -= last.length;
        buffer.chunks.pop();
      } else {
        buffer.chunks[buffer.chunks.length - 1] = last.subarray(0, last.length - excess);
        excess = 0;
      }
    }
    buffer.totalSamples = keep;
    if (buffer.confirmedSamples > keep) buffer.confirmedSamples = keep;
    buffer.lastTranscript = '';
    buffer.lastTranscriptEndSample = undefined;
    buffer.confirmCount = 0;
    buffer.lastWords = [];
    this.log(`[SpeakerStreams] Boundary trim for "${buffer.speakerName}": dropped ${droppedSec.toFixed(2)}s past segmentation boundary`);
  }

  /**
   * Trim confirmed audio chunks from the front of the buffer.
   * Keeps all unconfirmed audio intact.
   */
  private trimBuffer(buffer: SpeakerBuffer): void {
    if (buffer.confirmedSamples === 0) return;

    let samplesToTrim = buffer.confirmedSamples;
    const newChunks: Float32Array[] = [];

    for (const chunk of buffer.chunks) {
      if (samplesToTrim >= chunk.length) {
        samplesToTrim -= chunk.length;
        continue;
      }
      if (samplesToTrim > 0) {
        // Partial chunk — keep the tail
        newChunks.push(chunk.subarray(samplesToTrim));
        samplesToTrim = 0;
      } else {
        newChunks.push(chunk);
      }
    }

    buffer.chunks = newChunks;
    buffer.totalSamples -= buffer.confirmedSamples;
    if (buffer.submittedEndSample !== undefined) buffer.submittedEndSample = Math.max(0, buffer.submittedEndSample - buffer.confirmedSamples);
    if (buffer.lastTranscriptEndSample !== undefined) buffer.lastTranscriptEndSample = Math.max(0, buffer.lastTranscriptEndSample - buffer.confirmedSamples);
    buffer.confirmedSamples = 0;
  }

  private quietCutSample(buffer: SpeakerBuffer, sec: number, end = buffer.totalSamples): number {
    const from = end - sec * this.sampleRate;
    let pos = 0, cut = end, quietest = Infinity;
    for (const chunk of buffer.chunks) {
      if (pos >= from && pos > buffer.confirmedSamples && pos <= end) {
        const level = rms(chunk);
        if (level < quietest) { quietest = level; cut = pos; }
      }
      pos += chunk.length;
    }
    return cut;
  }

  /** The hard-cap request answered: publish its text as the confirmed segment for the capped window,
   *  then continue the turn from the cut with the audio fed since. An empty or junk answer falls back
   *  to the last transcript only when that transcript lies within the cut. */
  private finishCappedWindow(buffer: SpeakerBuffer, transcript: string): void {
    const closing = buffer.idleSubmitted || buffer.pendingFinal;
    buffer.pendingFinal = false;
    const cut = Math.min(buffer.capCutSample ?? buffer.totalSamples, buffer.totalSamples);
    buffer.capCutSample = undefined;
    let text = (transcript || '').trim();
    if (!text || this.isHallucination(text)) {
      const withinCut = buffer.lastTranscriptEndSample !== undefined && buffer.lastTranscriptEndSample <= cut;
      text = withinCut ? buffer.lastTranscript : '';
    }
    const startMs = buffer.windowStartMs;
    if (text && !this.isHallucination(text) && this.onSegmentConfirmed) {
      this.onSegmentConfirmed(buffer.speakerId, buffer.speakerName, text, startMs, (startMs + cut / this.sampleRate * 1000),
        `${buffer.speakerId}:${buffer.sequenceNumber}`, buffer.lastLanguage);
      buffer.sequenceNumber++;
      buffer.lastConfirmedText = text;
      this.clearStaleDraft(buffer, startMs);
    } else if (buffer.pendingDraftText && this.onSegmentPending) {
      // Nothing usable for the capped window: withdraw its draft rather than confirm stale text.
      this.onSegmentPending(buffer.speakerId, buffer.speakerName, '', buffer.pendingDraftStartMs);
    }
    this.log(`[SpeakerStreams] Hard cap finalized for "${buffer.speakerName}" (${(cut / this.sampleRate).toFixed(1)}s)`);
    buffer.confirmedSamples = cut;
    const retainedStartMs = (startMs + cut / this.sampleRate * 1000);
    this.trimBuffer(buffer);
    buffer.lastTranscript = '';
    buffer.lastTranscriptEndSample = undefined;
    buffer.confirmCount = 0;
    buffer.lastWords = [];
    buffer.windowStartMs = retainedStartMs;
    buffer.pendingDraftText = '';
    if (closing) {
      buffer.idleSubmitted = false;
      if (buffer.totalSamples > 0) void this.flushSpeaker(buffer.speakerId, true);
      else this.fullReset(buffer);
    }
  }

  /**
   * Full reset — discard everything. Used on speaker change and idle cleanup.
   */
  private fullReset(buffer: SpeakerBuffer): void {
    buffer.chunks = [];
    buffer.totalSamples = 0;
    buffer.confirmedSamples = 0;
    buffer.lastTranscript = '';
    buffer.lastTranscriptEndSample = undefined;
    buffer.confirmCount = 0;
    buffer.lastWords = [];
    buffer.inFlight = false;
    buffer.windowStartMs = this.now();
    buffer.bufferStartMs = this.now();
    buffer.lastAudioTimestamp = this.now();
    buffer.idleSubmitted = false;
    buffer.pendingFinal = false;
    buffer.carryForwardSamples = 0;
    buffer.submittedEndSample = undefined;
    buffer.capCutSample = undefined;
    buffer.generation++;
  }
}
