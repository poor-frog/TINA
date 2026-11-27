/**
 * @tina/record-chunker — the shared browser MediaRecorder driver.
 *
 * Runs in browser context. Wraps a MediaRecorder over a combined audio
 * MediaStream, encodes each timeslice to base64, and hands it to an injected
 * `onChunk` callback (the recording.v1 chunk shape). On stop it emits one final
 * chunk with `isFinal: true`. NO master assembly here — the master is built
 * server-side (meeting-api `recording_finalizer.py`) from the chunk_seq sequence.
 *
 * Both lane recording taps use this once: `@tina/gmeet-capture` (gmeet) and
 * `@tina/mixed-capture-core` (mixed/teams). The combine-the-audio step differs
 * per lane (gmeet builds a combined stream from its media elements; mixed
 * already has one mixed stream) — that lives in each lane; the MediaRecorder
 * loop is identical and lives here.
 *
 * No fallbacks: if `onChunk` throws or returns false we splice the chunk anyway
 * and log (the server-side reconciler re-fetches via the chunk_seq contract);
 * if no supported mimeType exists we log and refuse to start.
 */

/** One recording chunk, ready for upload. Mirrors the recording.v1 wire shape. */
export interface RecordingChunk {
  base64: string;
  chunkSeq: number;
  isFinal: boolean;
  mimeType: string;
}

/** A lane recording tap — what `createGmeetRecordingTap` / `createMixedRecordingTap` return. */
export interface RecordingTap {
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
}

/** Options a host passes to a lane recording tap. */
export interface RecordingTapOptions {
  /** MediaRecorder timeslice in ms (default 15000 — matches the WAV chunk size). */
  timesliceMs?: number;
  /** Receives each chunk. Return false / throw → the chunk is spliced anyway (reconciler re-fetches). */
  onChunk: (chunk: RecordingChunk) => Promise<boolean> | boolean;
  /** Fired ONCE on MediaRecorder.onstart — t=0 of the master (segment↔audio alignment). */
  onStarted?: () => void;
}

export interface MediaRecorderChunkerOptions extends RecordingTapOptions {
  /** Combined audio stream to record (lane-built). */
  stream: MediaStream;
}

const BUFFER_CAP = 10;

/** The 4-byte EBML magic every valid webm/Matroska stream starts with (`1a 45 df a3`). */
const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/** True when `bytes` begins with the EBML header (i.e. it is a self-describing webm init segment,
 *  not a cluster-only continuation chunk). */
function isWebmHeader(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && EBML_MAGIC.every((b, i) => bytes[i] === b);
}

const blog = (msg: string) => { try { (window as any).logBot?.(msg); } catch { /* */ } };

/**
 * Drives a MediaRecorder over `stream`, emitting base64 chunks via `onChunk`.
 * Lifecycle: start() → chunks per timeslice → stop() resolves AFTER the final
 * chunk callback completes.
 */
export class MediaRecorderChunker implements RecordingTap {
  private opts: MediaRecorderChunkerOptions;
  private recorder: MediaRecorder | null = null;
  private chunkSeq = 0;
  private delivery: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | null = null;
  private pending: Blob[] = [];
  private resolveFinalChunk: ((error?: Error) => void) | null = null;
  private completion: Promise<Error | undefined> | null = null;
  private mimeType = "audio/webm";
  /**
   * The webm EBML init segment retained from the FIRST self-describing blob (chunk 0:
   * `1a 45 df a3` EBML + Segment + Tracks + first Cluster). Held so it can be re-attached to a
   * later surviving chunk when chunk 0's own delivery fails over the page→Node base64 bridge;
   * without it the assembler would build a headerless (mid-Matroska `43 b6 75 …`) master from the
   * cluster-only survivors, which no player accepts. */
  private initSegment: Uint8Array | null = null;
  /** False until a chunk carrying the EBML header has been ACK'd by `onChunk` (returned truthy). */
  private initSegmentDelivered = false;

  constructor(opts: MediaRecorderChunkerOptions) {
    this.opts = opts;
  }

  /** The underlying MediaRecorder (null until start()). */
  getMediaRecorder(): MediaRecorder | null {
    return this.recorder;
  }

  async start(): Promise<void> {
    if (this.recorder) {
      blog("[record-chunker] start() called twice — ignoring");
      return;
    }

    // Pick the best supported mimeType. No fallback beyond the candidate list.
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    let chosen = "";
    for (const mime of candidates) {
      try {
        if ((window as any).MediaRecorder?.isTypeSupported?.(mime)) { chosen = mime; break; }
      } catch { /* */ }
    }

    let recorder: MediaRecorder;
    try {
      recorder = chosen
        ? new MediaRecorder(this.opts.stream, { mimeType: chosen })
        : new MediaRecorder(this.opts.stream);
    } catch (err: any) {
      blog(`[record-chunker] Failed to construct MediaRecorder: ${err?.message || err}`);
      return;
    }

    this.recorder = recorder;
    this.completion = new Promise(resolve => { this.resolveFinalChunk = resolve; });
    this.mimeType = recorder.mimeType || chosen || "audio/webm";

    // t=0 of the master — listeners align segment timestamps to audio origin.
    recorder.onstart = () => { try { this.opts.onStarted?.(); } catch { /* */ } };

    const deliver = async (event: BlobEvent) => {
      if (!(event.data && event.data.size > 0)) {
        blog("[record-chunker] dataavailable fired with empty data (skipping)");
        return;
      }

      // Defensive buffer + cap — successful callbacks splice; the cap should
      // never trip in normal operation (the reconciler re-fetches if it does).
      this.pending.push(event.data);
      if (this.pending.length > BUFFER_CAP) {
        const dropped = this.pending.shift();
        blog(`[record-chunker] WARN buffer exceeded cap ${BUFFER_CAP}, dropped oldest (${dropped?.size ?? 0} bytes); reconciler will re-fetch`);
      }

      const seq = this.chunkSeq;
      this.chunkSeq = seq + 1;

      try {
        const arrBuffer = await event.data.arrayBuffer();
        let bytes = new Uint8Array(arrBuffer);

        // Retain the EBML init segment from the FIRST self-describing blob. webm/Matroska always
        // starts with `1a 45 df a3`; MediaRecorder puts EBML + Segment + Tracks in chunk 0.
        if (!this.initSegment && isWebmHeader(bytes)) this.initSegment = bytes;

        // If the init segment has NOT yet been delivered (chunk 0's own send failed over the
        // bridge) and THIS chunk is cluster-only, PREPEND the retained header so the master is
        // never assembled headerless. The byte-concat codec keeps this valid: a chunk that is
        // [EBML init][cluster] is exactly what a self-describing chunk 0 looks like.
        if (this.initSegment && !this.initSegmentDelivered && !isWebmHeader(bytes)) {
          const merged = new Uint8Array(this.initSegment.length + bytes.length);
          merged.set(this.initSegment, 0);
          merged.set(bytes, this.initSegment.length);
          bytes = merged;
          blog(`[record-chunker] chunk ${seq} re-attached EBML init segment (${this.initSegment.length}B) — chunk 0 delivery was lost`);
        }

        const carriesHeader = isWebmHeader(bytes);
        // OPTIMISTICALLY mark the init segment delivered the moment a header-bearing chunk is
        // DISPATCHED (not after its await resolves), so a chunk emitted while chunk 0 is still
        // in flight does not redundantly re-attach the header. On a confirmed failure below we
        // clear the flag again so the NEXT surviving chunk carries the retained init segment.
        if (carriesHeader) this.initSegmentDelivered = true;

        let binary = "";
        const encodeChunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += encodeChunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, i + encodeChunkSize));
        }
        const base64 = btoa(binary);
        blog(`[record-chunker] chunk ${seq} (${bytes.length} bytes)`);
        try {
          const ok = await this.opts.onChunk({ base64, chunkSeq: seq, isFinal: false, mimeType: this.mimeType });
          // A header-bearing chunk that the sink REJECTED is not delivered — clear the flag so the
          // retained init segment is re-attached to the next surviving (cluster-only) chunk.
          if (!ok && carriesHeader) this.initSegmentDelivered = false;
          if (!ok) blog(`[record-chunker] chunk ${seq} callback returned false — sink rejected; reconciler will re-fetch`);
        } catch (cbErr: any) {
          if (carriesHeader) this.initSegmentDelivered = false;
          blog(`[record-chunker] chunk ${seq} callback threw: ${cbErr?.message || cbErr}; reconciler will re-fetch`);
        } finally {
          const idx = this.pending.indexOf(event.data);
          if (idx >= 0) this.pending.splice(idx, 1);
        }
      } catch (err: any) {
        const idx = this.pending.indexOf(event.data);
        if (idx >= 0) this.pending.splice(idx, 1);
        blog(`[record-chunker] chunk ${seq} encode FAILED: ${err?.message || err}; spliced`);
      }
    };

    recorder.ondataavailable = (event: BlobEvent) => {
      this.delivery = this.delivery.then(() => deliver(event));
    };

    recorder.onstop = async () => {
      let failure: Error | undefined;
      // Final chunk (empty body OK — server treats isFinal=true as the COMPLETED signal).
      try {
        await this.delivery;
        const finalSeq = this.chunkSeq;
        this.chunkSeq = finalSeq + 1;
        const accepted = await this.opts.onChunk({ base64: "", chunkSeq: finalSeq, isFinal: true, mimeType: this.mimeType });
        if (!accepted) throw new Error("Recording final chunk was rejected");
        blog(`[record-chunker] final chunk emitted (seq=${finalSeq})`);
      } catch (err: any) {
        failure = err instanceof Error ? err : new Error(String(err));
        blog(`[record-chunker] final chunk callback failed: ${err?.message || err}`);
      } finally {
        if (this.resolveFinalChunk) { this.resolveFinalChunk(failure); this.resolveFinalChunk = null; }
      }
    };

    recorder.start(this.opts.timesliceMs ?? 15000);
    blog(`[record-chunker] MediaRecorder started (${this.mimeType}, timeslice=${this.opts.timesliceMs ?? 15000}ms)`);
  }

  async pause(): Promise<void> { await this.setPaused(true); }
  async resume(): Promise<void> { await this.setPaused(false); }
  private async setPaused(paused: boolean): Promise<void> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive' || recorder.state === (paused ? 'paused' : 'recording')) return;
    await new Promise<void>((resolve, reject) => {
      const event = paused ? 'pause' : 'resume';
      const done = () => { clearTimeout(timer); recorder.removeEventListener(event, done); resolve(); };
      const timer = setTimeout(() => { recorder.removeEventListener(event, done); reject(new Error('Recording pause/resume timed out')); }, 3000);
      recorder.addEventListener(event, done, { once: true });
      try { if (paused) recorder.pause(); else recorder.resume(); }
      catch (error) { clearTimeout(timer); recorder.removeEventListener(event, done); reject(error); }
    });
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.recorder) return;
    this.stopping = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (this.recorder!.state !== 'inactive') this.recorder!.stop();
        const error = await Promise.race([
          this.completion!,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Recording flush timed out')), 10000); }),
        ]);
        if (error) throw error;
      } finally { if (timer) clearTimeout(timer); }
    })();
    return this.stopping;
  }
}

// ───────────────────────────────────────────────────────────────────────
// createRecordingTap — the full browser recording tap (generic, all platforms)
// ───────────────────────────────────────────────────────────────────────

/** Extract a playable audio MediaStream from a media element (srcObject or captureStream fallback). */
function streamFromElement(element: any): MediaStream | null {
  try {
    const direct = element?.srcObject;
    if (direct instanceof MediaStream && direct.getAudioTracks().length > 0) return direct;
    if (typeof element?.captureStream === "function") {
      const cap = element.captureStream();
      if (cap instanceof MediaStream && cap.getAudioTracks().length > 0) return cap;
    }
    if (typeof element?.mozCaptureStream === "function") {
      const cap = element.mozCaptureStream();
      if (cap instanceof MediaStream && cap.getAudioTracks().length > 0) return cap;
    }
  } catch { /* not probeable; skip */ }
  return null;
}

/** Snapshot current audio-bearing media elements on the page (strict unpaused first, else relaxed). */
function scanMediaElements(): HTMLMediaElement[] {
  const all = Array.from(document.querySelectorAll("audio, video"));
  const strict = all.filter((el: any) =>
    !el.paused && el.srcObject instanceof MediaStream && el.srcObject.getAudioTracks().length > 0
  ) as HTMLMediaElement[];
  if (strict.length > 0) return strict;
  return all.filter((el: any) => streamFromElement(el) !== null) as HTMLMediaElement[];
}

/**
 * Find active media elements that expose audio. Two-pass (strict → relaxed):
 * tiles can be paused or expose audio via captureStream() rather than a direct
 * srcObject, so the relaxed pass mirrors buildCombinedStream's fallbacks. This
 * is platform-agnostic — a recording grabs every audio element on the page.
 */
async function findMediaElements(retries = 5, delay = 2000): Promise<HTMLMediaElement[]> {
  for (let i = 0; i < retries; i++) {
    const all = Array.from(document.querySelectorAll("audio, video"));
    let els = all.filter((el: any) =>
      !el.paused && el.srcObject instanceof MediaStream && el.srcObject.getAudioTracks().length > 0
    ) as HTMLMediaElement[];
    if (els.length > 0) { blog(`[record-chunker] ${els.length} media elements (strict)`); return els; }

    els = all.filter((el: any) => streamFromElement(el) !== null) as HTMLMediaElement[];
    if (els.length > 0) { blog(`[record-chunker] ${els.length} media elements (relaxed)`); return els; }

    await new Promise((r) => setTimeout(r, delay));
  }
  return [];
}

/** Mix every media element's audio into one MediaStream via a destination node,
 *  and periodically rescan so late-arriving / rotated Meet streams join the live mix. */
async function buildCombinedStream(
  mediaElements: HTMLMediaElement[],
  rescanMs = 5000,
): Promise<{ stream: MediaStream; close: () => Promise<void> }> {
  if (mediaElements.length === 0) throw new Error("[record-chunker] no media elements to combine");
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const connectedStreamIds = new Set<string>();
  const connectedSources: MediaStreamAudioSourceNode[] = [];
  let connected = 0;

  const attachElement = (element: any, label: string, dynamic: boolean): boolean => {
    try {
      const s = streamFromElement(element);
      if (!s) return false;
      const streamId = s.id || `anon-${connected}`;
      if (connectedStreamIds.has(streamId)) return false;
      const src = ctx.createMediaStreamSource(s);
      src.connect(dest);
      connectedStreamIds.add(streamId);
      connectedSources.push(src);
      connected++;
      const track = s.getAudioTracks()[0];
      if (track && typeof track.addEventListener === "function") {
        track.addEventListener("ended", () => { connectedStreamIds.delete(streamId); }, { once: true });
      }
      if (dynamic) {
        blog(`[record-chunker] dynamically attached late stream ${streamId.slice(0, 12)} (total=${connected})`);
      } else {
        blog(`[record-chunker] connected element ${label}`);
      }
      return true;
    } catch (e: any) {
      blog(`[record-chunker] could not connect element ${label}: ${e?.message || e}`);
      return false;
    }
  };

  mediaElements.forEach((element, index) => {
    attachElement(element, `${index + 1}/${mediaElements.length}`, false);
  });
  if (connected === 0) { await ctx.close(); throw new Error("[record-chunker] could not connect any audio streams"); }
  blog(`[record-chunker] combined ${connected} streams`);

  let closed = false;
  const rescanTimer = rescanMs > 0 ? setInterval(() => {
    if (closed) return;
    try {
      for (const el of scanMediaElements()) {
        attachElement(el, "dynamic", true);
      }
    } catch { /* rescan is best-effort */ }
  }, rescanMs) : null;

  return {
    stream: dest.stream,
    close: async () => {
      closed = true;
      if (rescanTimer !== null) clearInterval(rescanTimer);
      for (const src of connectedSources) { try { src.disconnect(); } catch { /* */ } }
      connectedSources.length = 0;
      connectedStreamIds.clear();
      dest.stream.getTracks().forEach(t => t.stop());
      await ctx.close();
    },
  };
}

/** Options for createRecordingTap — combine all audio elements then optionally override. */
export interface CreateRecordingTapOptions extends RecordingTapOptions {
  /** Provide a ready stream to record (e.g. the mixed-lane tab stream); else all audio elements are combined. */
  stream?: MediaStream;
  /** Interval (ms) to rescan for newly created/rotated media elements when combining page audio. Default 5000. */
  rescanMs?: number;
}

/**
 * The browser recording tap, used by BOTH lanes (gmeet, teams) and both hosts
 * (bot, extension): find every audio element → combine → `MediaRecorderChunker`
 * → recording.v1 chunks via `onChunk`. Recording is platform-agnostic — it
 * records the whole meeting mix — so this is ONE generic tap, not per-lane.
 * (Zoom records via node PulseAudio in @tina/recording, no browser tap.)
 *
 * Pass `opts.stream` to record a ready stream directly (skips the element
 * combine); otherwise it finds + combines the page's audio elements.
 */
export function createRecordingTap(opts: CreateRecordingTapOptions): RecordingTap {
  let chunker: MediaRecorderChunker | null = null;
  let cancelled = false;
  let starting: Promise<void> | null = null;
  let closeCombined: (() => Promise<void>) | undefined;
  return {
    async start(): Promise<void> {
      if (starting) return starting;
      starting = (async () => {
        let stream = opts.stream;
        if (!stream) {
          const els = await findMediaElements();
          if (els.length === 0) { blog("[record-chunker] no media elements — cannot record"); return; }
          if (cancelled) return;
          const combined = await buildCombinedStream(els, opts.rescanMs ?? 5000); stream = combined.stream; closeCombined = combined.close;
        }
        if (cancelled) return;
        chunker = new MediaRecorderChunker({
          stream,
          timesliceMs: opts.timesliceMs ?? 15000,
          onChunk: opts.onChunk,
          onStarted: opts.onStarted,
        });
        await chunker.start();
      })();
      return starting;
    },
    async pause(): Promise<void> { await starting; await chunker?.pause(); },
    async resume(): Promise<void> { await starting; await chunker?.resume(); },
    async stop(): Promise<void> {
      cancelled = true;
      try { await starting; await chunker?.stop(); }
      finally { chunker = null; await closeCombined?.(); closeCombined = undefined; }
    },
  };
}
