import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MeetingMock } from "../../surfaces/meetingModel";

/** Behavioral contract of the transcript-pane toggle (fix/terminal-processed-default-view):
 *  - COMPLETED meeting with persisted processed notes → DEFAULTS to the processed view
 *    (users read the raw default as "my notes are lost").
 *  - COMPLETED meeting without notes → defaults to raw.
 *  - LIVE meeting → unchanged: defaults to raw, and the toggle arms/disarms the copilot.
 *  - COMPLETED meeting → the toggle is a PURE view switch: it must never call /api/meeting/process. */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const durableState: { lines: unknown[]; notes: unknown[]; processingStatus?: string } = { lines: [], notes: [] };
let meetingsState: MeetingMock[] = [];

vi.mock("../../surfaces/liveMeetings", () => ({
  useLiveMeetings: () => meetingsState,
  fetchDurableTranscript: vi.fn(async () => ({ lines: durableState.lines, notes: durableState.notes, processingStatus: durableState.processingStatus })),
  mergeNotesById: (seed: { id: string }[], live: { id: string }[]) => [...seed, ...live],
}));

vi.mock("../../surfaces/meetingLive", () => ({
  useMeetingLive: () => ({
    transcript: [], notes: [], cards: [], errors: [], issues: [], note: "",
    connected: false, ended: false, reconnects: 0,
  }),
}));

import { MeetingCanvasView } from "../MeetingCanvasView";
import { defaultProcessingView } from "../processingView";
import { ServicesProvider, createContainer, reg } from "../../platform";
import { LayoutServiceId, createLayoutService } from "../../workbench/layout";

const NOTE = { id: "n1", speaker: "Jane", text: "We agreed to ship Friday.", t: 1, pass: 1 };
const LINE = { speaker: "Jane", text: "so um we agreed to ship friday", t: 1 };

function meetingRow(live: boolean): MeetingMock {
  return {
    id: "6", native_id: "abc-defg-hij",
    session_uid: live ? "6" : undefined,
    title: "Google Meet · abc-defg-hij", when: "", status: live ? "live" : "past",
    platform: "Google Meet", participants: [], mentioned: [], actions: [], transcript: [], insights: [],
  };
}

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete durableState.processingStatus;
  container = document.createElement("div");
  document.body.appendChild(container);
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => { root?.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function renderCanvas() {
  root = createRoot(container);
  const container2 = createContainer([reg(LayoutServiceId, () => createLayoutService("meetings"))]);
  const meetingRecord = meetingsState[0];
  await act(async () => {
    root.render(
      <ServicesProvider container={container2}>
        <MeetingCanvasView meetingId="6" meetingRecord={meetingRecord} />
      </ServicesProvider>,
    );
  });
  // flush the async durable hydration
  await act(async () => { await Promise.resolve(); });
  const language = container.querySelector<HTMLSelectElement>('select[aria-label="Transcript language"]')!;
  expect(language.value).toBe('bilingual');
  // These tests exercise original/processed switching after explicitly choosing Vietnamese.
  await act(async () => { language.value = 'vi'; language.dispatchEvent(new Event('change', { bubbles: true })); });
}

function toggleButton(): HTMLButtonElement {
  return container.querySelector("button[aria-pressed]") as HTMLButtonElement;
}

function processCalls(): number {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/meeting/process")).length;
}

describe("defaultProcessingView (pure)", () => {
  it("processed only for completed meetings with notes", () => {
    expect(defaultProcessingView(false, true)).toBe(true);
    expect(defaultProcessingView(false, false)).toBe(false);
    expect(defaultProcessingView(true, true)).toBe(false);
    expect(defaultProcessingView(true, false)).toBe(false);
  });
});

describe("MeetingCanvasView — default view + toggle semantics", () => {
  it("does not tell readers to wait for new speech in an empty ended meeting", async () => {
    meetingsState = [meetingRow(false)]; durableState.lines = []; durableState.notes = [];
    await renderCanvas();
    expect(container.textContent).toContain("No transcript is available for this meeting.");
    expect(container.textContent).not.toContain("Waiting for transcript…");
    expect(processCalls()).toBe(0);
  });
  it("continues waiting for speech while an empty meeting is live", async () => {
    meetingsState = [meetingRow(true)]; durableState.lines = []; durableState.notes = [];
    await renderCanvas();
    expect(container.textContent).toContain("Waiting for transcript…");
  });
  it("keeps recap tools collapsed until requested, without starting processing", async () => {
    meetingsState = [meetingRow(false)]; durableState.lines = [LINE]; durableState.notes = [];
    await renderCanvas();
    const tools = container.querySelector<HTMLButtonElement>('button[aria-label="Meeting tools"]')!;
    const group = document.getElementById(tools.getAttribute("aria-controls")!)!;
    expect(tools.getAttribute("aria-expanded")).toBe("false");
    expect(group.hidden).toBe(true);
    await act(async () => { tools.click(); });
    expect(group.hidden).toBe(false);
    expect(tools.getAttribute("aria-expanded")).toBe("true");
    expect([...group.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Discussion review", "Meeting memory", "Speaker identities", "Review transcript"]);
    await act(async () => { tools.click(); });
    expect(group.hidden).toBe(true);
    expect(container.textContent).toContain(LINE.text);
    expect(processCalls()).toBe(0);
  });
  it("opens discussion review from recap tools with the dialog outside the collapsible group", async () => {
    meetingsState = [meetingRow(false)]; durableState.lines = [LINE]; durableState.notes = [];
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
    try {
      await renderCanvas();
      const tools = container.querySelector<HTMLButtonElement>('button[aria-label="Meeting tools"]')!;
      const group = document.getElementById(tools.getAttribute("aria-controls")!)!;
      await act(async () => { tools.click(); });
      const review = [...group.querySelectorAll("button")].find(button => button.textContent === "Discussion review")!;
      await act(async () => { review.click(); });
      const dialog = container.querySelector<HTMLDialogElement>('dialog[aria-label="Đánh giá thảo luận"]')!;
      expect(dialog.open).toBe(true);
      expect(group.contains(dialog)).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => url === "/api/discussion-reviews/6")).toBe(true);
      expect(processCalls()).toBe(0);
    } finally { HTMLDialogElement.prototype.showModal = showModal; }
  });
  it('generates AI notes for an existing completed transcript only after the explicit action', async () => {
    meetingsState = [meetingRow(false)]; durableState.lines = [LINE]; durableState.notes = [];
    await renderCanvas();
    expect(processCalls()).toBe(0);
    await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Meeting info')!.click(); });
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Generate AI notes')!;
    await act(async () => { button.click(); });
    const request = fetchMock.mock.calls.find(([url]) => url === '/api/meeting/process');
    expect(JSON.parse(String(request?.[1]?.body)).on).toBe(true);
    expect(toggleButton().getAttribute('aria-pressed')).toBe('true');
  });
  it('allows disabling automatic AI updates for a completed meeting', async () => {
    meetingsState = [meetingRow(false)]; durableState.lines = [LINE]; durableState.notes = [NOTE]; durableState.processingStatus = 'current';
    await renderCanvas();
    await act(async () => { [...container.querySelectorAll('button')].find(b => b.textContent === 'Meeting info')!.click(); });
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Disable AI updates')!;
    await act(async () => { button.click(); });
    const request = fetchMock.mock.calls.find(([url]) => url === '/api/meeting/process');
    expect(JSON.parse(String(request?.[1]?.body)).on).toBe(false);
  });
  it("COMPLETED meeting with persisted notes defaults to the PROCESSED view", async () => {
    meetingsState = [meetingRow(false)];
    durableState.lines = [LINE];
    durableState.notes = [NOTE];
    await renderCanvas();
    const btn = toggleButton();
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.textContent).toContain("Processed");
    expect(btn.textContent).toContain("Processed view");
    expect(container.textContent).toContain("We agreed to ship Friday.");
  });

  it("COMPLETED meeting without notes defaults to the RAW view", async () => {
    meetingsState = [meetingRow(false)];
    durableState.lines = [LINE];
    durableState.notes = [];
    await renderCanvas();
    const btn = toggleButton();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toContain("Original ASR");
    expect(container.textContent).toContain(LINE.text);
  });

  it("LIVE meeting keeps the current default (raw / processing off) even when notes exist", async () => {
    meetingsState = [meetingRow(true)];
    durableState.lines = [LINE];
    durableState.notes = [NOTE];
    await renderCanvas();
    const btn = toggleButton();
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.textContent).toContain("Original ASR");
  });

  it("COMPLETED meeting toggle is a pure view switch — never calls the arm endpoint", async () => {
    meetingsState = [meetingRow(false)];
    durableState.lines = [LINE];
    durableState.notes = [NOTE];
    await renderCanvas();
    const btn = toggleButton();
    await act(async () => { btn.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false"); // flipped to raw
    await act(async () => { toggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true"); // back to processed
    expect(processCalls()).toBe(0);
  });

  it("LIVE meeting toggle still arms the copilot via /api/meeting/process", async () => {
    meetingsState = [meetingRow(true)];
    durableState.lines = [];
    durableState.notes = [];
    await renderCanvas();
    await act(async () => { toggleButton().dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(toggleButton().textContent).toContain("Processed view");
    expect(processCalls()).toBe(1);
  });
});
