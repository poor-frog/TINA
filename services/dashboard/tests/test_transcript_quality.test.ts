import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TranscriptQualityEvidence } from "../src/components/transcript/transcript-quality";

describe("text and audio review evidence", () => {
  it("explains co-occurring text/quiet-frame warnings without claiming absent speech", () => {
    const html = renderToStaticMarkup(createElement(TranscriptQualityEvidence, { label: "Suggestion", quality: {
      needs_review: true, reasons: ["repetition", "mostly_quiet"], text_check: "text_and_quiet_audio",
      rms: .002, quiet_ratio: .9, clipping_ratio: 0,
    } }));
    expect(html).toContain('aria-label="Suggestion checks"');
    expect(html).toContain("Possible ASR artifact; listen to verify");
    expect(html).toContain("Quiet audio does not prove that speech is absent");
    expect(html).toContain("Original clip");
    expect(html).toContain("90.0");
  });
  it("keeps a text-only warning distinct and accepts saved legacy checks", () => {
    const html = renderToStaticMarkup(createElement(TranscriptQualityEvidence, { label: "Source", quality: {
      needs_review: true, reasons: ["non_lexical"], text_check: "text_flag",
    } }));
    expect(html).toContain("Text contains no letters or numbers");
    expect(html).toContain("Text warning without mostly quiet audio");
    expect(html).not.toContain("Possible ASR artifact");
    const legacy = renderToStaticMarkup(createElement(TranscriptQualityEvidence, { label: "Source", quality: {
      needs_review: true, reasons: ["low_volume"],
    } }));
    expect(legacy).toContain("Needs review: Low volume");
    expect(legacy).not.toContain("evidence details");
  });
});
