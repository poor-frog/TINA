import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { mergeMeetingTranscriptLines } from "../MeetingDetailView";
import { MeetingSidePanel } from "../MeetingSidePanel";
import type { TranscriptLine } from "../../surfaces/meetingModel";
import type { LiveSegment } from "../../surfaces/meetingLive";

describe("mergeMeetingTranscriptLines — live merge & draft -> final", () => {
  it("preserves older durable lines beyond SSE replay window while overlaying live draft -> final", () => {
    const durable: TranscriptLine[] = [
      { id: "ch-0:1:1000", t: "15:56:39", speaker: "Unknown speaker", text: "chúc", tsMs: 1_795_683_399_000, completed: true },
      { id: "ch-0:2:2000", t: "15:56:48", speaker: "JKY LEE", text: "mất sớm", tsMs: 1_795_683_408_000, completed: true },
    ];
    const live: LiveSegment[] = [
      { id: "ch-0:2:2000", t: 1_795_683_408, tsMs: 1_795_683_408_000, speaker: "JKY LEE", text: "mất sớm", completed: true },
      { id: "ch-0:3:3000", t: 1_795_683_415, tsMs: 1_795_683_415_000, speaker: "JKY LEE", text: "đang nói dở", completed: false },
    ];

    const merged = mergeMeetingTranscriptLines(durable, live, {
      isLive: true,
      liveConnected: true,
      liveEnded: false,
    });

    expect(merged.map((l) => l.id)).toEqual(["ch-0:1:1000", "ch-0:2:2000", "ch-0:3:3000"]);
    expect(merged[0].text).toBe("chúc");
    expect(merged[2].completed).toBe(false);
    expect(merged[2].t).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(merged[2].t).not.toBe("00:00");
  });

  it("does not resurrect a retracted draft from stale durable poll", () => {
    const durable: TranscriptLine[] = [
      { id: "s1", t: "15:56:48", speaker: "JKY LEE", text: "mất sớm", tsMs: 1_795_683_408_000, completed: true },
      { id: "draft-retracted", t: "15:56:52", speaker: "JKY LEE", text: "stale draft", tsMs: 1_795_683_412_000, completed: false },
    ];
    const live: LiveSegment[] = [
      { id: "s1", t: 1_795_683_408, tsMs: 1_795_683_408_000, speaker: "JKY LEE", text: "mất sớm", completed: true },
    ];

    const merged = mergeMeetingTranscriptLines(durable, live, {
      isLive: true,
      liveConnected: true,
      liveEnded: false,
      retractedIds: ["draft-retracted"],
    });

    expect(merged.map((l) => l.id)).toEqual(["s1"]);
  });

  it("keeps recent finalized live lines when meeting transitions live -> post before durable catches up", () => {
    const durable: TranscriptLine[] = [
      { id: "s1", t: "15:56:48", speaker: "JKY LEE", text: "mất sớm", tsMs: 1_795_683_408_000, completed: true },
    ];
    const live: LiveSegment[] = [
      { id: "s1", t: 1_795_683_408, tsMs: 1_795_683_408_000, speaker: "JKY LEE", text: "mất sớm", completed: true },
      { id: "s2", t: 1_795_683_420, tsMs: 1_795_683_420_000, speaker: "JKY LEE", text: "câu cuối cùng", completed: true },
    ];

    const merged = mergeMeetingTranscriptLines(durable, live, {
      isLive: false,
      liveConnected: false,
      liveEnded: true,
    });

    expect(merged.map((l) => l.id)).toEqual(["s1", "s2"]);
    expect(merged[1].text).toBe("câu cuối cùng");
    expect(merged[1].completed).toBe(true);
  });
});

describe("MeetingSidePanel — draft -> final visual progression", () => {
  afterEach(() => cleanup());

  it("renders draft indicator & waiting hint for completed:false and clears them when finalized", () => {
    const baseProps = {
      meetingId: "26",
      firstName: "Quang",
      meetingsOnly: false,
      sideTab: "transcript" as const,
      onSideTabChange: () => {},
      processedNotes: [],
      voiceReplies: [],
      isLive: true,
      language: "bilingual" as const,
      translationSnapshot: null,
      translationError: "",
      onRetryTranslation: () => {},
      speakerFilter: "",
      questionsOnly: false,
      trackerFilter: "",
      onClearSpeaker: () => {},
      onClearQuestions: () => {},
      onClearTracker: () => {},
      playableSegmentIds: new Set<string>(),
      activeSegmentId: null,
      pendingPrompt: null,
      onConsumePendingPrompt: () => {},
    };

    const draftLines: TranscriptLine[] = [
      { id: "seg-1", t: "15:56:48", speaker: "JKY LEE", text: "mất sớm", tsMs: 1_795_683_408_000, completed: true },
      { id: "seg-2", t: "15:56:56", speaker: "JKY LEE", text: "thắc mắc tại sao phụ nữ", tsMs: 1_795_683_416_000, completed: false },
    ];

    const { container, rerender } = render(<MeetingSidePanel {...baseProps} lines={draftLines} />);

    const draftRow = container.querySelector('[data-segment-id="seg-2"]');
    const finalRow = container.querySelector('[data-segment-id="seg-1"]');
    expect(draftRow?.getAttribute("data-draft")).toBe("true");
    expect(finalRow?.getAttribute("data-draft")).toBe("false");
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("thắc mắc tại sao phụ nữ…")).toBeTruthy();
    expect(screen.getByText("Chờ đoạn nói hoàn tất…")).toBeTruthy();

    // Finalize seg-2 in place (same id, completed: true)
    const finalizedLines: TranscriptLine[] = [
      draftLines[0],
      { id: "seg-2", t: "15:56:56", speaker: "JKY LEE", text: "thắc mắc tại sao phụ nữ ở đây ít người biết chạy xe", tsMs: 1_795_683_416_000, completed: true },
    ];
    rerender(<MeetingSidePanel {...baseProps} lines={finalizedLines} />);

    expect(container.querySelector('[data-segment-id="seg-2"]')?.getAttribute("data-draft")).toBe("false");
    expect(screen.queryByText("Draft")).toBeNull();
    expect(screen.queryByText("Chờ đoạn nói hoàn tất…")).toBeNull();
    expect(screen.getByText("thắc mắc tại sao phụ nữ ở đây ít người biết chạy xe")).toBeTruthy();
  });
});
