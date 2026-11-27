/** Authenticated PCM stream -> bounded prebuffer -> PulseAudio virtual microphone. */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import https from 'node:https';
import http from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';

const PAPLAY_ARGS = ['--raw', '--format=s16le', '--rate=24000', '--channels=1', '--device=tts_sink'];
const MAX_BYTES = 24000 * 2 * 120;
const PACTL_TIMEOUT_MS = 3000;
function runPactl(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout: PACTL_TIMEOUT_MS }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
async function setTtsMute(muted: boolean): Promise<void> {
  await runPactl(['set-sink-mute', 'tts_sink', muted ? '1' : '0']);
  // The source must stay available to Chromium; Meet UI + the dedicated TTS sink gate speech.
  await runPactl(['set-source-mute', 'virtual_mic', '0']);
}
export type PlaybackOutcome = 'completed' | 'failed' | 'stopped';
export interface SpeechTiming {
  requestedAtMs: number;
  firstPcmAtMs?: number;
  readyAtMs?: number;
  playbackAtMs?: number;
}
export interface PreparedSpeech {
  ready: Promise<boolean>;
  readonly timing?: Readonly<SpeechTiming>;
  readonly failedBeforePlayback?: boolean;
  play(onStarted?: (timing?: Readonly<SpeechTiming>) => void): Promise<PlaybackOutcome>;
  cancel(): void;
}
export interface TtsPlayback {
  speak(text: string, voice?: string, onStarted?: (timing?: Readonly<SpeechTiming>) => void, timeoutMs?: number): Promise<PlaybackOutcome | void>;
  prepare?(text: string, voice?: string, timeoutMs?: number): PreparedSpeech;
  stop(): Promise<void> | void;
}
export interface TtsPlaybackOptions {
  prebufferMs?:number;
  profile?:()=>string|undefined;
  meetingId?: number;
  setMute?: (muted: boolean) => void | Promise<void>;
  spawnProcess?: () => ChildProcess;
  requestTimeoutMs?: number;
  service?: (text:string) => {baseUrl:string;token:string;revision:number;requestId:string} | undefined;
}

export function createTtsPlayback(log: (m: string) => void = () => {}, options: TtsPlaybackOptions = {}): TtsPlayback {
  const configured=options.prebufferMs??Number(process.env.TINA_TTS_PREBUFFER_MS??150);
  const prebuffer=24000*2*(Number.isFinite(configured)&&configured>=80&&configured<=1000?configured:150)/1000;
  const highWaterMark = Math.max(24000, Math.ceil(prebuffer) + 4800);
  let muteQueue: Promise<void> = Promise.resolve();
  const mute = (value: boolean): Promise<boolean> => {
    const run = muteQueue.then(async () => {
      try { await (options.setMute ?? setTtsMute)(value); return true; }
      catch { log('[tts] microphone control failed'); return false; }
    });
    muteQueue = run.then(() => {}, () => {});
    return run;
  };
  const spawnProcess = options.spawnProcess ?? (() => spawn('paplay', PAPLAY_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] }));
  const handles = new Map<PreparedSpeech, () => Promise<void>>();
  let active: PreparedSpeech | undefined;
  function prepare(text: string, voice = 'auto', timeoutMs?: number): PreparedSpeech {
    const timing: SpeechTiming = { requestedAtMs: Date.now() };
    const buffer = new PassThrough({ highWaterMark });
    let request: ClientRequest | undefined, response: IncomingMessage | undefined, proc: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, settled = false, ended = false, bytes = 0, playing = false;
    let failedBeforePlayback = false;
    let readyResolve!: (ready: boolean) => void, doneResolve!: (outcome: PlaybackOutcome) => void;
    const ready = new Promise<boolean>(resolve => { readyResolve = resolve; });
    const done = new Promise<PlaybackOutcome>(resolve => { doneResolve = resolve; });
    const finish = (outcome: PlaybackOutcome): Promise<void> => {
      if (settled) return done.then(() => {});
      failedBeforePlayback = outcome === 'failed' && !playing;
      settled = true; clearTimeout(timer); handles.delete(handle); readyResolve(false);
      request?.destroy(); response?.destroy(); buffer.destroy();
      try { proc?.stdin?.destroy(); proc?.kill('SIGKILL'); } catch { /* Cleanup must settle cancellation. */ }
      if (active === handle || !active) {
        active = undefined;
        return mute(true).then(muted => {
          if (!muted && outcome === 'completed') outcome = 'failed';
          doneResolve(outcome);
        });
      }
      doneResolve(outcome);
      return Promise.resolve();
    };
    const handle: PreparedSpeech = {
      ready,
      get timing() { return {...timing}; },
      get failedBeforePlayback() { return failedBeforePlayback; },
      cancel: () => { void finish('stopped'); },
      async play(onStarted) {
        await ready;
        if (settled) return done;
        if (playing) return done;
        if (active && active !== handle) { await finish('failed'); return done; }
        playing = true; active = handle;
        const unmuted = await mute(false);
        if (settled) return done;
        if (!unmuted) { await finish('failed'); return done; }
        try { proc = spawnProcess(); } catch { await finish('failed'); return done; }
        const player = proc;
        player.stderr?.on('data', () => { log('[tts] player diagnostic'); });
        player.stdin?.on('error', () => { void finish('failed'); });
        let spawned = false, written = false;
        const notify = () => {
          if (settled || !spawned || !written || timing.playbackAtMs !== undefined) return;
          timing.playbackAtMs = Date.now();
          try { onStarted?.({...timing}); } catch { void finish('failed'); }
        };
        player.once('spawn', () => { spawned = true; notify(); });
        player.once('error', () => { void finish('failed'); });
        player.once('exit', code => {
          // Null the exited child before cleanup so cancellation cannot re-kill it.
          proc = undefined;
          void finish(code === 0 && ended && bytes > 0 && bytes % 2 === 0 ? 'completed' : 'failed');
        });
        buffer.removeAllListeners('readable');
        // Process spawn alone does not prove that PCM reached the virtual microphone player.
        const first = buffer.read() as Buffer | null;
        if (!first || !player.stdin) { await finish('failed'); return done; }
        player.stdin.write(first, error => {
          if (error) { void finish('failed'); return; }
          written = true; notify();
        });
        buffer.pipe(player.stdin!);
        return done;
      },
    };
    buffer.on('error', () => { void finish('failed'); });
    // Current stream + exactly one lookahead, never a private-answer cache.
    if (handles.size >= 2) { void finish('failed'); return handle; }
    handles.set(handle, () => finish('stopped'));
    const service = options.service?.(text);
    const base = service?.baseUrl ?? process.env.TTS_SERVICE_URL?.trim();
    let url: URL;
    try { if (!base) throw new Error(); url = new URL(base.replace(/\/$/, '') + '/v1/audio/speech'); }
    catch { finish('failed'); return handle; }
    const data = JSON.stringify({ model: 'tts-1', input: text, voice, response_format: 'pcm',
      ...(options.profile?.()?{profile:options.profile()}:{}),
      ...(Number.isSafeInteger(options.meetingId) && options.meetingId! > 0 ? { meeting_id: options.meetingId } : {}) });
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) };
    if (service) {
      headers.Authorization = `Bearer ${service.token}`;
      headers['X-Voice-Revision'] = String(service.revision);
      headers['X-Voice-Request-Id'] = service.requestId;
    } else if (process.env.TTS_API_TOKEN?.trim()) headers['X-API-Key'] = process.env.TTS_API_TOKEN.trim();
    try {
      request = (url.protocol === 'https:' ? https : http).request({ hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method: 'POST', headers }, res => {
        response = res;
        if (settled) { res.destroy(); return; }
        if (res.statusCode !== 200 || (res.headers['x-audio-sample-rate'] && res.headers['x-audio-sample-rate'] !== '24000')
            || (res.headers['x-audio-channels'] && res.headers['x-audio-channels'] !== '1')) {
          log(`[tts] service status ${res.statusCode}`); finish('failed'); return;
        }
        res.on('aborted', () => finish('failed')); res.on('error', () => finish('failed'));
        res.on('data', (chunk: Buffer) => {
          if (chunk.length && timing.firstPcmAtMs === undefined) timing.firstPcmAtMs = Date.now();
          bytes += chunk.length;
          if (bytes > MAX_BYTES) finish('failed');
        });
        const buffered = () => { timing.readyAtMs ??= Date.now(); readyResolve(true); };
        buffer.on('readable', () => { if (buffer.readableLength >= prebuffer) buffered(); });
        res.on('end', () => {
          ended = true;
          if (!bytes || bytes % 2) finish('failed'); else buffered();
        });
        res.pipe(buffer);
      });
      request.on('error', () => finish('failed'));
      timer = setTimeout(() => finish('failed'), Math.min(options.requestTimeoutMs ?? 150000, timeoutMs ?? 150000));
      request.end(data);
    } catch { finish('failed'); }
    return handle;
  }
  const stop = (): Promise<void> => {
    let muted = false;
    const cancellations: Promise<void>[] = [];
    for (const [handle, cancel] of [...handles]) {
      if (active === handle || !active) muted = true;
      cancellations.push(cancel());
    }
    if (!muted) cancellations.push(mute(true).then(() => {}));
    return Promise.all(cancellations).then(() => {});
  };
  return { prepare, stop, async speak(text, voice, onStarted, timeoutMs) { if (handles.size) void stop(); return prepare(text, voice, timeoutMs).play(onStarted); } };
}
