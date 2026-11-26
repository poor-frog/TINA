/** Regression tests for `MeetingDetailView` live voice-assistant polling.
 *
 *  Guards against the timer-fork bug where `window focus` and WebSocket `tina:transcript-corrected`
 *  bursts spawned independent parallel 3s polling loops (1,000+ req/min -> Gateway/WAF 429). */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { MeetingDetailView } from "../MeetingDetailView";
import type { MeetingMock } from "../../surfaces/meetingModel";

vi.mock("../../surfaces/liveMeetings", () => ({
  fetchDurableTranscript: vi.fn().mockResolvedValue({ lines: [], notes: [] }),
  fetchMeetingById: vi.fn().mockResolvedValue(null),
  refreshMeetings: vi.fn(),
  seedLiveMeetingFromResponse: () => undefined,
}));

vi.mock("../../surfaces/meetingLive", () => ({
  useMeetingLive: () => ({
    transcript: [],
    notes: [],
    retractedIds: [],
    connected: true,
    ended: false,
  }),
}));

vi.mock("../../canvas/MeetingTranslation", () => ({
  useMeetingTranslation: () => ({
    snapshot: null,
    error: "",
    retry: vi.fn(),
    valid: true,
  }),
}));

vi.mock("../../surfaces/liveMeetingStateApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../surfaces/liveMeetingStateApi")>();
  return {
    ...actual,
    readAllLiveMeetingState: vi.fn().mockResolvedValue({
      configured: false,
      enabled: false,
      can_configure: false,
      readonly: false,
      revision: 0,
      items: [],
    }),
    readLiveMeetingState: vi.fn().mockResolvedValue({
      configured: false,
      enabled: false,
      can_configure: false,
      readonly: false,
      revision: 0,
      items: [],
    }),
  };
});

const LIVE_MEETING: MeetingMock = {
  id: "101",
  native_id: "cfr-uyfy-enb",
  title: "Live Product Sync",
  title_custom: "Live Product Sync",
  when: "Now · live",
  status: "live",
  live_status: "active",
  platform: "Google Meet",
  participants: [],
  mentioned: [],
  actions: [],
  transcript: [],
  insights: [],
};

describe("MeetingDetailView voice-assistant polling hygiene", () => {
  const origFetch = globalThis.fetch;
  let hiddenValue = false;

  beforeEach(() => {
    vi.useFakeTimers();
    hiddenValue = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hiddenValue,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    globalThis.fetch = origFetch;
  });

  it("never forks multiple 3s timers across bursts of transcript-corrected and window focus events", async () => {
    let voiceCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/voice-assistant")) {
        voiceCalls += 1;
        return new Response(JSON.stringify({ replies: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    render(
      <MeetingDetailView
        meetingId="101"
        meetings={[LIVE_MEETING]}
        listLoaded={true}
        wsConnected={true}
        meetingsOnly={false}
        canOpenTerminal={false}
        onBack={vi.fn()}
      />,
    );

    // Let initial mount fetch settle
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(voiceCalls).toBe(1);

    // Fire 50 live transcript revision events + 20 rapid focus events
    await act(async () => {
      for (let i = 0; i < 50; i++) {
        window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId: "101", revision: i + 1 } }));
      }
      for (let i = 0; i < 20; i++) {
        window.dispatchEvent(new Event("focus"));
      }
      await Promise.resolve();
      await Promise.resolve();
    });

    // Reset counter after burst settles, then advance 30 seconds (10 intervals of 3s)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    const baseline = voiceCalls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // Strictly one 3s loop: 30s / 3s = 10 calls (never 200-700 calls from forked timers)
    expect(voiceCalls - baseline).toBeGreaterThanOrEqual(9);
    expect(voiceCalls - baseline).toBeLessThanOrEqual(11);
  });

  it("pauses voice-assistant polling while the tab is hidden and resumes on visibilitychange", async () => {
    let voiceCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/voice-assistant")) {
        voiceCalls += 1;
        return new Response(JSON.stringify({ replies: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;

    render(
      <MeetingDetailView
        meetingId="101"
        meetings={[LIVE_MEETING]}
        listLoaded={true}
        wsConnected={true}
        meetingsOnly={false}
        canOpenTerminal={false}
        onBack={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(voiceCalls).toBe(1);

    // Hide tab -> timer cancels, zero requests during 30s hidden
    await act(async () => {
      hiddenValue = true;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(voiceCalls).toBe(1);

    // Return to tab -> immediate wake fetch + single 3s loop resumes
    await act(async () => {
      hiddenValue = false;
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(voiceCalls).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(voiceCalls).toBeGreaterThanOrEqual(4);
    expect(voiceCalls).toBeLessThanOrEqual(6);
  });
});
