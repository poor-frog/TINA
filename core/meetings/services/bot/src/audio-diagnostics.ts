import type { AsrDiagnostic } from '@tina/gmeet-pipeline';

export interface AudioChannel {
  channel: number; frames: number; samples: number; last_frame_ms: number; rms: number;
  capture_lag_ms?: number; sample_clock: boolean; gap_samples: number; overlap_samples: number; clock_resets: number;
  asr_inflight: number; asr_errors: number; asr_at_ms?: number; capture_age_ms?: number; roundtrip_ms?: number; queue_ms?: number;
}
export interface AudioSnapshot { observed_at_ms: number; channels: AudioChannel[]; noise_suppression?:'off'|'starting'|'low'|'failed' }
type Row = AudioChannel & { nextSample?: number; lastStart?: number; latestRequest: number };
const duration = (n: number | undefined) => n !== undefined && Number.isFinite(n) && n >= 0 && n <= 3_600_000 ? n : undefined;

/** Bounded, content-free counters; no audio, participant identity or transcript is retained. */
export class AudioDiagnostics {
  private rows = new Map<number, Row>();
  private pending = new Map<number, number>();
  constructor(private now = Date.now) {}
  private row(channel: number) {
    if (!Number.isInteger(channel) || channel < 0 || channel >= 65536) return;
    let row = this.rows.get(channel);
    if (!row && this.rows.size < 16) {
      row = {channel, frames:0, samples:0, last_frame_ms:0, rms:0, sample_clock:false,
        gap_samples:0, overlap_samples:0, clock_resets:0, asr_inflight:0, asr_errors:0, latestRequest:0};
      this.rows.set(channel, row);
    }
    return row;
  }
  frame(channel: number, pcm: Float32Array, stamp: number, startSample?: number) {
    if (!pcm.length || pcm.length > 16000 || !Number.isFinite(stamp)) return;
    let energy = 0;
    for (const value of pcm) { if (!Number.isFinite(value)) return; energy += value * value; }
    const row = this.row(channel); if (!row) return;
    row.frames++; row.samples += pcm.length; row.last_frame_ms = this.now(); row.rms = Math.min(1, Math.sqrt(energy / pcm.length));
    row.capture_lag_ms = duration(this.now() - stamp - pcm.length / 16);
    row.sample_clock = Number.isSafeInteger(startSample) && startSample! >= 0;
    if (row.sample_clock) {
      if (row.nextSample !== undefined) {
        if (startSample === 0 && row.lastStart !== 0) row.clock_resets++;
        else if (startSample! > row.nextSample) row.gap_samples += startSample! - row.nextSample;
        else row.overlap_samples += Math.min(pcm.length, row.nextSample - startSample!);
      }
      row.nextSample = startSample === 0 && row.lastStart !== 0 ? pcm.length : Math.max(row.nextSample ?? 0, startSample! + pcm.length);
      row.lastStart = startSample;
    } else { row.nextSample = undefined; row.lastStart = undefined; }
  }
  asr(event: AsrDiagnostic) {
    const row = this.row(event.channel); if (!row) return;
    if (event.stage === 'started') {
      if (!this.pending.has(event.request) && this.pending.size < 64) {
        this.pending.set(event.request, event.channel); row.asr_inflight++;
      }
      row.latestRequest = event.request; row.capture_age_ms = duration(event.capture_age_ms);
    } else {
      if (this.pending.get(event.request) === event.channel) { this.pending.delete(event.request); row.asr_inflight = Math.max(0, row.asr_inflight - 1); }
      if (event.stage === 'failed') row.asr_errors++;
      if (event.request === row.latestRequest) {
        row.roundtrip_ms = duration(event.roundtrip_ms); row.queue_ms = duration(event.queue_ms); row.asr_at_ms = event.at_ms;
      }
    }
  }
  snapshot(): AudioSnapshot {
    const now = this.now();
    for (const [channel, row] of this.rows) if (now - row.last_frame_ms > 30000 && !row.asr_inflight) this.rows.delete(channel);
    return {observed_at_ms:now, channels:[...this.rows.values()].map(({nextSample, lastStart, latestRequest, ...row}) => ({...row})).sort((a,b)=>a.channel-b.channel)};
  }
}
