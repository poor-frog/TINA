import { log } from './log.js';
import { isLowConfidenceSegment } from './confidence.js';
import { randomUUID } from 'node:crypto';

/** Short audio cannot reliably outweigh a preceding sentence in the decoder's context. */
export function continuityPrompt(text: string | undefined, audio: Float32Array, sampleRate = 16000): string | undefined {
  return audio.length >= sampleRate * 2 ? text || undefined : undefined;
}

function outsideVietnameseEnglish(result: TranscriptionResult): boolean {
  const text = [result.text, ...result.segments.map(s => s.text)].join(' ');
  if (!text.trim()) return false;
  const lang = result.language.trim().toLowerCase();
  // FunASR concatenates its sentence-level labels (for example, "EnglishEnglish").
  const supportedLanguage = ['en', 'english', 'vi', 'vietnamese', 'unknown', 'auto', ''].includes(lang)
    || /^(?:english|vietnamese|en|vi)+$/.test(lang);
  return [...text].some(c => /\p{Letter}/u.test(c) && !/\p{Script=Latin}/u.test(c))
    || !supportedLanguage;
}

export interface TranscriptionTiming { capture_ms?: number; stream?: {id:string;start_ms:number} }

export type TranscriptionWindowRequest = (request: {
  wav:Buffer; fields:Record<string,string>; timing?:TranscriptionTiming;
  headers:Record<string,string>; signal:AbortSignal;
}) => Promise<Response|undefined>;

export function encodePcm16(samples:Float32Array):Buffer {
  const buffer=Buffer.alloc(samples.length*2);
  for(let i=0;i<samples.length;i++){
    const value=Math.max(-1,Math.min(1,samples[i]));
    buffer.writeInt16LE(Math.round(value<0?value*0x8000:value*0x7FFF),i*2);
  }
  return buffer;
}

export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  words?: TranscriptionWord[];
}

export interface TranscriptionResult {
  queue_ms?: number;
  text: string;
  language: string;
  language_probability?: number;
  duration: number;
  segments: TranscriptionSegment[];
  language_review?: { status: 'pending'; policy: 'vi-en'; original: TranscriptionResult; retry?: TranscriptionResult; retry_error?: string };
}

export interface TranscriptionClientConfig {
  /** Optional continuous-audio transport; undefined response uses the ordinary HTTP window. */
  windowRequest?:TranscriptionWindowRequest;
  /** Content-free diagnostics source; no participant or meeting identifiers. */
  source?: 'meeting-bot' | 'extension';
  /** Base URL of transcription-service, e.g. "http://localhost:8083" */
  serviceUrl: string;
  /** Optional bearer token for authentication */
  apiToken?: string;
  /** Max retry attempts for transient failures. Default: 3 */
  maxRetries?: number;
  /** Base delay between retries in ms. Default: 1000 */
  retryDelayMs?: number;
  /** Per-request timeout in ms. Default: 30000 */
  requestTimeoutMs?: number;
  /** Sample rate of input audio. Default: 16000 */
  sampleRate?: number;
  /** Max speech segment duration in seconds. Whisper forces a segment split at this length.
   *  Lower values = more frequent confirmations = faster output. Default: server default (15s) */
  maxSpeechDurationSec?: number;
  /** Minimum silence duration (ms) for VAD to split segments. Lower = more splits at natural pauses.
   *  Default: server default (160ms). Use ~100ms for more granular segments. */
  minSilenceDurationMs?: number;
  /** STT model id sent as the OpenAI-compatible `model` form part. Backends that validate it
   *  (Groq, vLLM, gateways) need their served name; the bundled unit ignores it (its model is
   *  the unit's own MODEL_SIZE). Default: "whisper-1". */
  model?: string;
}

/** The STT boundary's FAILURE vocabulary (P5 + P18: an adapter must translate the
 *  dependency's failures, not just its successes). A consumer reads `.kind` to surface
 *  an attributable health event instead of silently degrading to "no transcript". */
export type TranscriptionFaultKind =
  | 'payment_required'   // 402 — out of balance / credits exhausted
  | 'unauthorized'       // 401 / 403 — bad or expired token
  | 'rate_limited'       // 429
  | 'unavailable'        // 5xx or network error
  | 'timeout'            // request aborted (no response in time)
  | 'bad_request'        // other 4xx
  | 'unknown';

/** A typed STT failure. `source` lets a consumer attribute it; `retryable` drives backoff. */
export class TranscriptionError extends Error {
  readonly source = 'stt' as const;
  constructor(
    readonly kind: TranscriptionFaultKind,
    readonly status: number | undefined,
    readonly detail: string | undefined,
    readonly retryable: boolean,
  ) {
    super(`stt ${kind}${status ? ` (HTTP ${status})` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'TranscriptionError';
  }
}

/** Map an HTTP status to a typed fault (the anti-corruption translation, P5). */
function classifyHttp(status: number, detail?: string): TranscriptionError {
  if (status === 402) return new TranscriptionError('payment_required', status, detail, false);
  if (status === 401 || status === 403) return new TranscriptionError('unauthorized', status, detail, false);
  if (status === 429) return new TranscriptionError('rate_limited', status, detail, true);
  if (status >= 500) return new TranscriptionError('unavailable', status, detail, true);
  if (status >= 400) return new TranscriptionError('bad_request', status, detail, false);
  return new TranscriptionError('unknown', status, detail, false);
}

/**
 * HTTP client for the transcription-service.
 * Converts Float32Array audio to WAV, sends as multipart form,
 * and returns transcription results.
 */
export class TranscriptionClient {
  private windowRequest?:TranscriptionWindowRequest;
  private serviceUrl: string;
  private apiToken: string | undefined;
  private maxRetries: number;
  private retryDelayMs: number;
  private requestTimeoutMs: number;
  private sampleRate: number;
  private maxSpeechDurationSec: number | undefined;
  private minSilenceDurationMs: number | undefined;
  private model: string;
  private responseFormat: 'verbose_json' | 'json' = 'verbose_json';
  private source: string;
  constructor(config: TranscriptionClientConfig) {
    this.windowRequest=config.windowRequest;
    this.source = config.source ?? 'unknown';
    // Ensure serviceUrl ends with the transcriptions endpoint
    this.serviceUrl = config.serviceUrl.replace(/\/+$/, '');
    if (!this.serviceUrl.endsWith('/v1/audio/transcriptions')) {
      this.serviceUrl += '/v1/audio/transcriptions';
    }
    this.apiToken = config.apiToken;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelayMs = config.retryDelayMs ?? 1000;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 30000;
    this.sampleRate = config.sampleRate ?? 16000;
    this.maxSpeechDurationSec = config.maxSpeechDurationSec;
    this.minSilenceDurationMs = config.minSilenceDurationMs;
    this.model = config.model ?? 'whisper-1';
  }

  /**
   * Transcribe a Float32Array audio buffer.
   * Converts to WAV, POSTs to transcription-service, returns parsed result.
   * Retries on transient failures (503, network errors).
   */
  async transcribe(audioData: Float32Array, language?: string, prompt?: string, timing?: TranscriptionTiming): Promise<TranscriptionResult> {
    if (language === 'vi-en') {
      // A forced-language retry is a suggestion, not evidence that the audio said it.
      const original = await this.transcribe(audioData, undefined, prompt, timing);
      if (!outsideVietnameseEnglish(original)) return original;
      const review: NonNullable<TranscriptionResult['language_review']> = { status: 'pending', policy: 'vi-en', original };
      try {
        review.retry = await this.transcribe(audioData, /[ăâđêôơưạ-ỹ]/iu.test(prompt ?? '') ? 'vi' : 'en', undefined, timing);
      } catch (error) {
        review.retry_error = error instanceof TranscriptionError ? error.kind : 'unavailable';
      }
      return { text: '', segments: [], duration: original.duration, language: 'unknown', language_review: review };
    }
    const wavBuffer = this.float32ToWav(audioData);

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.sendRequest(wavBuffer, language, prompt, timing);
        return result;
      } catch (err: any) {
        // Normalize anything non-HTTP (abort/network) into a typed fault too, so the
        // thrown value is ALWAYS a TranscriptionError the consumer can attribute (P18).
        const fault: TranscriptionError = err instanceof TranscriptionError
          ? err
          : new TranscriptionError(err?.name === 'AbortError' ? 'timeout' : 'unavailable', undefined, err?.message, true);
        if (fault.kind === 'bad_request' && this.responseFormat === 'verbose_json' && /verbose_json/i.test(fault.detail ?? '')) {
          log('[TranscriptionClient] backend rejected verbose_json; falling back to json for this and later requests');
          this.responseFormat = 'json';
          attempt--; // Capability negotiation does not consume a configured retry.
          continue;
        }
        const isLastAttempt = attempt === this.maxRetries;

        if (fault.retryable && !isLastAttempt) {
          const delay = this.retryDelayMs * Math.pow(2, attempt);
          log(`[TranscriptionClient] ${fault.kind} (attempt ${attempt + 1}/${this.maxRetries + 1}): ${fault.message}. Retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Non-retryable (402/401/4xx) or retries exhausted → surface the typed fault.
        log(`[TranscriptionClient] transcription failed after ${attempt + 1} attempt(s): ${fault.message}`);
        throw fault;
      }
    }

    // Should never reach here, but TypeScript needs it
    throw new Error('Transcription failed: exhausted retries');
  }

  /**
   * Send the WAV buffer to the transcription-service as multipart form data.
   */
  private async sendRequest(wavBuffer: Buffer, language?: string, prompt?: string, timing?: TranscriptionTiming): Promise<TranscriptionResult> {
    // Build multipart form data manually (no external dependency needed)
    const boundary = `----FormBoundary${Date.now().toString(36)}`;

    const parts: Buffer[] = [];

    // File part
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`
    ));
    parts.push(wavBuffer);
    parts.push(Buffer.from('\r\n'));

    // Model part (required by OpenAI-compatible API; validating backends reject unknown ids)
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `${this.model}\r\n`
    ));

    // Response format part
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `${this.responseFormat}\r\n`
    ));

    // Language part (if specified)
    if (language) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="language"\r\n\r\n` +
        `${language}\r\n`
      ));
    }

    // Request word-level timestamps
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="timestamp_granularities"\r\n\r\n` +
      `word\r\n`
    ));

    // Max speech segment duration (controls how often Whisper splits segments)
    if (this.maxSpeechDurationSec !== undefined) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="max_speech_duration_s"\r\n\r\n` +
        `${this.maxSpeechDurationSec}\r\n`
      ));
    }

    // Min silence duration for VAD segment splitting (lower = more splits at natural pauses)
    if (this.minSilenceDurationMs !== undefined) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="min_silence_duration_ms"\r\n\r\n` +
        `${this.minSilenceDurationMs}\r\n`
      ));
    }

    // Prompt: previous confirmed text as context for streaming continuity
    if (prompt) {
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
        `${prompt}\r\n`
      ));
    }

    // End boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const headers: Record<string, string> = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-ASR-Request-ID': randomUUID(),
      'X-ASR-Source': this.source,
    };
    if (timing?.capture_ms != null && Number.isFinite(timing.capture_ms) && timing.capture_ms >= 0 && timing.capture_ms <= 3_600_000) {
      headers['X-ASR-Capture-Ms'] = String(timing.capture_ms);
    }
    if (this.apiToken) {
      headers['Authorization'] = `Bearer ${this.apiToken}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const fields:Record<string,string>={model:this.model,response_format:this.responseFormat,timestamp_granularities:'word'};
      if(language)fields.language=language;
      if(prompt)fields.prompt=prompt;
      if(this.maxSpeechDurationSec!==undefined)fields.max_speech_duration_s=String(this.maxSpeechDurationSec);
      if(this.minSilenceDurationMs!==undefined)fields.min_silence_duration_ms=String(this.minSilenceDurationMs);
      const response = await this.windowRequest?.({wav:wavBuffer,fields,timing,headers,signal:controller.signal}) ?? await fetch(this.serviceUrl, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unable to read error response');
        throw classifyHttp(response.status, errorText);   // typed fault (P5/P18), not a bare Error
      }

      const data = await response.json() as any;
      const queue = /(?:^|,)\s*asr_queue\s*;\s*dur=([\d.]+)(?=\s*(?:,|$))/.exec(response.headers.get('server-timing') || '');
      const queueMs = queue ? Number(queue[1]) : NaN;

      const allSegments = (data.segments || []).map((s: any) => ({
        start: s.start || 0,
        end: s.end || 0,
        text: s.text || '',
        avg_logprob: s.avg_logprob,
        no_speech_prob: s.no_speech_prob,
        compression_ratio: s.compression_ratio,
        words: s.words,
      }));
      // Drop low-confidence (hallucinated / faint-bleed) segments at the source and
      // rebuild the text from what survives, so phantoms never reach the pipeline.
      // If the model returned no segments we can't score, so keep its text as-is.
      const segments = allSegments.filter((s: any) => !isLowConfidenceSegment(s));
      const text = allSegments.length
        ? segments.map((s: any) => (s.text || '').trim()).filter(Boolean).join(' ')
        : (data.text || '');
      if (allSegments.length && segments.length < allSegments.length) {
        log(`[STT] dropped ${allSegments.length - segments.length}/${allSegments.length} low-confidence segment(s)`);
      }
      return {
        ...(Number.isFinite(queueMs) && queueMs >= 0 && queueMs <= 3_600_000 ? {queue_ms: queueMs} : {}),
        text,
        language: data.language || language || 'unknown',
        language_probability: data.language_probability ?? 0,
        duration: data.duration || 0,
        segments,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Convert Float32Array audio samples to a WAV file buffer.
   * Output: 16-bit PCM, mono, at this.sampleRate (default 16kHz).
   */
  private float32ToWav(samples: Float32Array): Buffer {
    const numChannels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const dataSize = samples.length * bytesPerSample;
    const headerSize = 44;
    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF header
    buffer.write('RIFF', 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write('WAVE', 8);

    // fmt sub-chunk
    buffer.write('fmt ', 12);
    buffer.writeUInt32LE(16, 16);              // Sub-chunk size
    buffer.writeUInt16LE(1, 20);               // PCM format
    buffer.writeUInt16LE(numChannels, 22);     // Mono
    buffer.writeUInt32LE(this.sampleRate, 24);  // Sample rate
    buffer.writeUInt32LE(this.sampleRate * numChannels * bytesPerSample, 28); // Byte rate
    buffer.writeUInt16LE(numChannels * bytesPerSample, 32); // Block align
    buffer.writeUInt16LE(bitsPerSample, 34);   // Bits per sample

    // data sub-chunk
    buffer.write('data', 36);
    buffer.writeUInt32LE(dataSize, 40);

    encodePcm16(samples).copy(buffer,headerSize);

    return buffer;
  }
}
