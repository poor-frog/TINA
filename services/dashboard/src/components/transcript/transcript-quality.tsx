/** Presentation of meetings-owned diagnostics; no client-side speech classification. */
import React from "react";

export interface TranscriptQuality {
  needs_review: boolean;
  reasons: string[];
  rms?: number;
  quiet_ratio?: number;
  clipping_ratio?: number;
  text_check?: "no_text_flags" | "text_flag" | "text_and_quiet_audio";
}

const labels: Record<string, string> = {
  low_volume: "Low volume", clipping: "Audio clipping", mostly_quiet: "Mostly quiet audio",
  repetition: "Repeated words - listen to verify", non_lexical: "Text contains no letters or numbers",
};

export function TranscriptQualityEvidence({ quality, label }: { quality: TranscriptQuality; label: "Source" | "Suggestion" }) {
  return <section aria-label={`${label} checks`}>
    <h4>{label} checks</h4>
    <p role="status">{quality.needs_review ? "Needs review: " + quality.reasons.map(r => labels[r] ?? r).join(" · ") : "No configured text or audio review flags detected."}</p>
    {quality.text_check === "text_and_quiet_audio" && <p>Text warning coincides with mostly quiet audio. Possible ASR artifact; listen to verify. Quiet audio does not prove that speech is absent.</p>}
    {quality.text_check === "text_flag" && <p>Text warning without mostly quiet audio. Listen to verify; a text cue alone cannot establish an ASR artifact.</p>}
    {typeof quality.rms === "number" && typeof quality.quiet_ratio === "number" && typeof quality.clipping_ratio === "number" && <details>
      <summary>{label} evidence details</summary>
      <p>Original clip · RMS {quality.rms.toFixed(5)} · Quiet frames {(quality.quiet_ratio * 100).toFixed(1)}% · Clipped samples {(quality.clipping_ratio * 100).toFixed(1)}%</p>
    </details>}
  </section>;
}
