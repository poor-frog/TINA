/** Behavioral tests for the Dual-Shell Production User UI (`src/web/`), `/terminal` route helpers,
 *  upgraded `AuthGate`, Personal/Team `SettingsView`, `SpeakerTalkTime`, Live Assist in
 *  `MeetingDetailView`, Meetings Notebook (`meetingsFilter`, date grouping, multi-filter, rename/•••,
 *  split-button Capture ▾), Ask Tina (MCP Tool Approval, Copy/Share, chat search), and Dev/Admin gating. */
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import {
  isTerminalOwnedPath,
  terminalMeetingIdFromPath,
  terminalMeetingPath,
} from "../../app/meetingRoute";
import { signIn } from "next-auth/react";
import { AuthGate } from "../../app/AuthGate";
import { WebShell } from "../WebApp";
import { WebModelsPanel } from "../WebModelsPanel";
import { computeSpeakerStats } from "../SpeakerTalkTime";
import {
  EMPTY_MEETING_FILTERS,
  groupMeetingsByDate,
  matchesMeetingFilters,
  meetingDurationMins,
} from "../meetingsFilter";
import type { ChatStreamCallbacks } from "../../surfaces/chatStream";
import type { MeetingMock } from "../../surfaces/meetingModel";

function mockNativeDialog() {
  // jsdom has a dialog element but does not implement the native modal methods.
  const proto = HTMLDialogElement.prototype;
  const showModal = Object.getOwnPropertyDescriptor(proto, "showModal");
  const close = Object.getOwnPropertyDescriptor(proto, "close");
  Object.defineProperty(proto, "showModal", {
    configurable: true, value(this: HTMLDialogElement) { this.setAttribute("open", ""); },
  });
  Object.defineProperty(proto, "close", {
    configurable: true, value(this: HTMLDialogElement) { this.removeAttribute("open"); },
  });
  onTestFinished(() => {
    cleanup();
    if (showModal) Object.defineProperty(proto, "showModal", showModal);
    else Reflect.deleteProperty(proto, "showModal");
    if (close) Object.defineProperty(proto, "close", close);
    else Reflect.deleteProperty(proto, "close");
  });
}

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

const mockFetchDurableTranscript = vi.fn().mockResolvedValue({
  lines: [
    { t: "00:00", speaker: "Sarup", text: "Welcome everyone to the weekly product sync today.", tsMs: 1_000, endTsMs: 11_000 },
    { t: "00:12", speaker: "Linh", text: "Thanks Sarup, here is the rollout update for production.", tsMs: 12_000, endTsMs: 32_000 },
  ],
  notes: [],
});

const mockFetchMeetingById = vi.fn().mockResolvedValue(null);

const TODAY_ISO = new Date().toISOString();
const YESTERDAY_START = new Date(Date.now() - 86_400_000).toISOString();
const YESTERDAY_END = new Date(Date.now() - 86_400_000 + 45 * 60_000).toISOString();

vi.mock("../../surfaces/liveMeetings", () => ({
  useLiveMeetings: () => [
    {
      id: "101",
      native_id: "abc-defg-hij",
      title: "Product Weekly Sync",
      title_custom: "Product Weekly Sync",
      when: "Now · live",
      status: "live",
      live_status: "active",
      start_time: TODAY_ISO,
      platform: "Google Meet",
      participants: [
        { name: "Sarup Banskota", role: "", initials: "SB" },
        { name: "Linh Nguyen", role: "", initials: "LN" },
      ],
      mentioned: [],
      actions: [],
      transcript: [],
      insights: [],
    },
    {
      id: "102",
      native_id: "kuz-wvic-dfc",
      title: "Design Review",
      title_custom: "Design Review",
      when: "Yesterday · 8:40 PM",
      status: "past",
      live_status: "completed",
      start_time: YESTERDAY_START,
      end_time: YESTERDAY_END,
      platform: "Zoom",
      has_recording: true,
      participants: [{ name: "Sarup Banskota", role: "", initials: "SB" }],
      mentioned: [],
      actions: [],
      transcript: [],
      insights: [],
    },
  ],
  useLiveMeetingsLoaded: () => true,
  useLiveMeetingsConnection: () => true,
  refreshMeetings: vi.fn(),
  seedLiveMeetingFromResponse: (raw: unknown) => {
    if (!raw || typeof raw !== "object") return undefined;
    const obj = raw as { id?: number | string; meeting_id?: number | string };
    const id = obj.meeting_id ?? obj.id;
    return id != null ? String(id) : undefined;
  },
  liveMeetingsNow: () => [],
  getLiveMeeting: () => undefined,
  fetchMeetingById: (...args: unknown[]) => mockFetchMeetingById(...args),
  fetchDurableTranscript: (...args: unknown[]) => mockFetchDurableTranscript(...args),
}));

vi.mock("../../canvas/MeetingCanvasView", () => ({
  MEETING_CANVAS_CONTENT_INSET: 18,
  MeetingCanvasView: ({ meetingId }: { meetingId: string }) => (
    <div data-testid="real-meeting-canvas">LiveTranscriptEngine Canvas for {meetingId}</div>
  ),
}));

vi.mock("../../surfaces/MeetingKnowledge", () => ({
  MeetingKnowledge: ({ meetingId }: { meetingId: string }) => (
    <div data-testid="real-meeting-knowledge">Ask TINA Knowledge for {meetingId}</div>
  ),
  MeetingWikiSourceStatus: () => null,
}));

vi.mock("../../surfaces/LiveAssistRunningView", () => ({
  LiveAssistRunningView: ({ meetingId, meetingTitle }: { meetingId: string; meetingTitle: string }) => (
    <div data-testid="real-live-assist-view">Live Assist Running for {meetingTitle} ({meetingId})</div>
  ),
}));

vi.mock("../../surfaces/settings", () => ({
  SettingsBody: () => <div data-testid="real-settings-body">TINA Real Settings</div>,
  ModelsSection: ({ initialScope = "agent" }: { initialScope?: string } = {}) => (
    <div data-testid={`real-models-section-${initialScope}`}>TINA Models ({initialScope})</div>
  ),
}));

vi.mock("../../surfaces/calendarConnections", () => ({
  CalendarConnectionsPanel: () => <div data-testid="real-calendar-panel">TINA Calendar Connections</div>,
}));

vi.mock("../../surfaces/voiceSettings", () => ({
  VoiceSettings: () => <div data-testid="real-voice-panel">TINA Voice Settings</div>,
}));

vi.mock("../../surfaces/tokens", () => ({
  TokensPanel: () => <div data-testid="real-tokens-panel">TINA API Tokens</div>,
  GitHubTokenCard: () => <div data-testid="real-github-panel">TINA GitHub Token</div>,
}));

vi.mock("../../surfaces/asrStatus", () => ({
  AsrStatusPanel: () => <div data-testid="real-asr-panel">TINA ASR Workers Status</div>,
}));

vi.mock("../../surfaces/routines", () => ({
  RoutinesBoard: () => <div data-testid="real-routines-board">TINA Real Routines</div>,
}));

let capturedChatCallbacks: ChatStreamCallbacks | null = null;
const mockStreamChatTurn = vi.fn(
  async (_req: unknown, cb: ChatStreamCallbacks) => {
    capturedChatCallbacks = cb;
    cb.onStarting();
    cb.onApprovalRequest?.({
      type: "tool-approval-request",
      approval_id: "appr-1",
      turn_id: "turn-9",
      server: "calendar",
      tool: "create_event",
      title: "Create follow-up calendar invite",
      description: "Adds a 30-minute review to your calendar",
      message: "Confirm scheduling with Linh Nguyen?",
      parameters: [{ name: "title", display_name: "Event", value: "Production Sign-off" }],
      expires_at: Math.floor(Date.now() / 1000) + 120,
    });
    cb.onReply?.("Drafted follow-up summary for **Product Weekly Sync**.");
    return { sawVisibleOutput: true, terminal: true, aborted: false };
  },
);

vi.mock("../../surfaces/chatStream", () => ({
  streamChatTurn: (...args: unknown[]) => mockStreamChatTurn(...(args as [unknown, ChatStreamCallbacks])),
}));

const mockListSharedMemberships = vi.fn().mockResolvedValue([
  { workspace_id: "eng-syncs", role: "owner" },
]);
const mockCreateSharedWorkspace = vi.fn().mockResolvedValue({
  workspace_id: "product-ops",
  role: "owner",
  name: "Product Ops",
});
const mockMintInvite = vi.fn().mockResolvedValue({
  id: "inv-1",
  token: "tok_abc123",
  role: "contributor",
  workspace_id: "eng-syncs",
  expires_at: "2026-12-01T00:00:00Z",
  max_uses: 25,
  mode: "open",
});
const mockMintTranscriptShare = vi.fn().mockResolvedValue({
  id: "sh-1",
  token: "tshare_xyz789",
  mode: "open",
  expires_at: "2026-12-01T00:00:00Z",
});

const mockSaveWorkspaceDocument = vi.fn().mockResolvedValue({ sha256: "abc123", commit: null, commit_error: null });

vi.mock("../../surfaces/workspaceApi", async () => {
  const actual = await vi.importActual<typeof import("../../surfaces/workspaceApi")>("../../surfaces/workspaceApi");
  return {
    ...actual,
    listWorkspaceTree: vi.fn().mockResolvedValue(["kg/entities/task/follow-up.md"]),
    readWorkspaceFile: vi.fn().mockResolvedValue("---\ntitle: Ship User UI\nstatus: draft\n---\nReview rollout plan."),
    readWorkspaceDocument: vi.fn().mockResolvedValue({
      content: "---\ntitle: Ship User UI\nstatus: draft\n---\nReview rollout plan.",
      sha256: "sha-task-1",
      writable: true,
    }),
    saveWorkspaceDocument: (...args: unknown[]) => mockSaveWorkspaceDocument(...args),
    listSharedMemberships: (...args: unknown[]) => mockListSharedMemberships(...args),
    readAttachedWorkspaces: vi.fn().mockResolvedValue({ active: "seed", slots: { seed: { repo: null, ref: null, name: "Personal" } } }),
    readActiveSet: vi.fn().mockResolvedValue({ subject: "u_sarup", active: [{ slug: "eng-syncs", role: "shared", repo: null, ref: null, path: "/eng-syncs", write: true, primary: false }] }),
    listWorkspaceMembers: vi.fn().mockResolvedValue([{ subject: "u_sarup", email: "sarup@tina.local", role: "owner" }]),
    listWorkspaceInvites: vi.fn().mockResolvedValue([]),
    createSharedWorkspace: (...args: unknown[]) => mockCreateSharedWorkspace(...args),
    mintInvite: (...args: unknown[]) => mockMintInvite(...args),
    mintTranscriptShare: (...args: unknown[]) => mockMintTranscriptShare(...args),
  };
});

describe("terminal dual-shell route helpers", () => {
  it("formats and parses /terminal/meetings/<id>", () => {
    expect(terminalMeetingPath("482")).toBe("/terminal/meetings/482");
    expect(terminalMeetingIdFromPath("/terminal/meetings/482")).toBe("482");
    expect(terminalMeetingPath("")).toBe("/terminal");
    expect(isTerminalOwnedPath("/terminal")).toBe(true);
    expect(isTerminalOwnedPath("/terminal/meetings/482")).toBe(true);
    expect(isTerminalOwnedPath("/meetings/482")).toBe(false);
    expect(isTerminalOwnedPath("/")).toBe(false);
  });
});

describe("meetingsFilter pure grouping & multi-dimensional filtering", () => {
  const now = new Date("2026-11-22T15:00:00Z");
  const sampleMeetings: MeetingMock[] = [
    {
      id: "1", title: "Live Standup", when: "Now", status: "live", live_status: "active",
      start_time: "2026-11-22T14:50:00Z", platform: "Google Meet",
      participants: [{ name: "Linh", role: "", initials: "LN" }], mentioned: [], actions: [], transcript: [], insights: [],
    },
    {
      id: "2", title: "Yesterday Design", when: "Yesterday", status: "past", live_status: "completed",
      start_time: "2026-11-21T10:00:00Z", end_time: "2026-11-21T10:45:00Z", platform: "Zoom", has_recording: true,
      participants: [{ name: "Sarup", role: "", initials: "SB" }], mentioned: [], actions: [], transcript: [], insights: [],
    },
    {
      id: "3", title: "Tomorrow Planning", when: "Tomorrow", status: "past", live_status: "scheduled",
      scheduled_at: "2026-11-23T09:00:00Z", platform: "Google Meet",
      participants: [{ name: "Linh", role: "", initials: "LN" }], mentioned: [], actions: [], transcript: [], insights: [],
    },
  ];

  it("groups Live Now first, Upcoming by day, and Recorded by calendar day", () => {
    const groups = groupMeetingsByDate(sampleMeetings, now);
    expect(groups.map((g) => g.label)).toEqual(["Live now", "Upcoming · Tomorrow", "Yesterday"]);
    expect(meetingDurationMins(sampleMeetings[1])).toBe(45);
  });

  it("filters by platform, participant, duration, and recording availability", () => {
    expect(matchesMeetingFilters(sampleMeetings[1], { ...EMPTY_MEETING_FILTERS, platforms: ["Zoom"] }, now)).toBe(true);
    expect(matchesMeetingFilters(sampleMeetings[0], { ...EMPTY_MEETING_FILTERS, platforms: ["Zoom"] }, now)).toBe(false);
    expect(matchesMeetingFilters(sampleMeetings[1], { ...EMPTY_MEETING_FILTERS, duration: "30to60" }, now)).toBe(true);
    expect(matchesMeetingFilters(sampleMeetings[1], { ...EMPTY_MEETING_FILTERS, duration: "under15" }, now)).toBe(false);
    expect(matchesMeetingFilters(sampleMeetings[1], { ...EMPTY_MEETING_FILTERS, hasRecordingOnly: true }, now)).toBe(true);
    expect(matchesMeetingFilters(sampleMeetings[0], { ...EMPTY_MEETING_FILTERS, hasRecordingOnly: true }, now)).toBe(false);
  });
});

describe("computeSpeakerStats talk-time analytics", () => {
  it("computes duration, share percentages, turns, and WPM from real transcript lines", () => {
    const summary = computeSpeakerStats([
      { t: "00:00", speaker: "Linh", text: "One two three four five six seven eight nine ten", tsMs: 0, endTsMs: 20_000 },
      { t: "00:20", speaker: "Sarup", text: "Hello world from TINA meeting assistant", tsMs: 20_000, endTsMs: 30_000 },
      { t: "00:30", speaker: "Linh", text: "Let us finalize the release checklist now", tsMs: 30_000, endTsMs: 40_000 },
    ]);

    expect(summary.totalDurationMs).toBe(40_000);
    expect(summary.totalSegments).toBe(3);
    expect(summary.speakers).toHaveLength(2);
    expect(summary.speakers[0].speaker).toBe("Linh");
    expect(summary.speakers[0].sharePct).toBe(75);
    expect(summary.speakers[0].turns).toBe(2);
    expect(summary.speakers[1].speaker).toBe("Sarup");
    expect(summary.speakers[1].sharePct).toBe(25);
    expect(summary.avgWpm).toBeGreaterThan(0);
  });

  it("falls back gracefully to word-based duration when timestamps are missing", () => {
    const summary = computeSpeakerStats([
      { t: "00:00", speaker: "Alex", text: "Testing fallback talk time calculation without timestamps" },
    ]);
    expect(summary.speakers).toHaveLength(1);
    expect(summary.speakers[0].sharePct).toBe(100);
    expect(summary.totalDurationMs).toBeGreaterThanOrEqual(1200);
  });
});

describe("Calendar welcome after sign-in", () => {
  beforeEach(() => {
    localStorage.removeItem("tina.calendar-welcome-dismissed");
    vi.mocked(signIn).mockClear();
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("Chrome/130.0.0.0");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
    localStorage.removeItem("tina.calendar-welcome-dismissed");
  });

  function mockProfile(profile: { calendarWelcome?: string; extensionWelcome?: string; extensionStoreUrl?: string }) {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(String(input) === "/api/auth/me" ? profile : {}),
    );
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  }

  it("opens the existing Google Calendar OAuth flow and returns to Calendar settings", async () => {
    const fetcher = mockProfile({ calendarWelcome: "new-account" });
    render(<AuthGate calendarWelcome><div>App</div></AuthGate>);
    expect(await screen.findByText("Sample week")).toBeTruthy();
    expect(screen.getByText("Project review").closest("li")?.textContent).toBe("Wed14:00Project review");
    expect(screen.queryByText("Bot auto-join is off by default.")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("google-calendar", {
      callbackUrl: `${window.location.origin}/?nav=settings&settingsWorkspace=personal&settingsSection=calendar`,
    }, expect.objectContaining({ access_type: "offline" })));
    expect(fetcher).toHaveBeenCalledWith("/api/auth/google-calendar-link", expect.objectContaining({ method: "POST" }));
  });

  it("advances to ZIP install after Skip and remembers completion across reloads", async () => {
    mockProfile({ calendarWelcome: "new-account" });
    const first = render(<AuthGate calendarWelcome><div>App</div></AuthGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByRole("link", { name: "Download extension ZIP" })).toHaveProperty("download", "meettina-extension.zip");
    first.unmount();

    const later = render(<AuthGate calendarWelcome><div>App</div></AuthGate>);
    fireEvent.click(await screen.findByRole("button", { name: "Continue to TINA" }));
    expect(await screen.findByText("App")).toBeTruthy();
    later.unmount();
    render(<AuthGate calendarWelcome><div>App</div></AuthGate>);
    expect(await screen.findByText("App")).toBeTruthy();
  });

  it("confirms the Chrome extensions address only after a successful clipboard write", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn().mockRejectedValueOnce(new Error("Permission denied")).mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      mockProfile({ extensionWelcome: "linked-account" });
      render(<AuthGate calendarWelcome><div>App</div></AuthGate>);
      const button = await screen.findByRole("button", { name: "Copy Chrome extensions address" });
      button.focus();
      fireEvent.click(button);
      expect(await screen.findByText(/Couldn’t copy/)).toBeTruthy();
      expect(screen.queryByText("Copied")).toBeNull();
      expect(document.activeElement).toBe(button);
      expect(document.querySelector("textarea[readonly]")).toBeNull();

      fireEvent.click(button);
      expect(await screen.findByText("Copied")).toBeTruthy();
      expect(screen.getByText("Address copied.")).toBeTruthy();
      expect(writeText).toHaveBeenLastCalledWith("chrome://extensions");
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("opens the configured Web Store after the Calendar OAuth return and preserves the Settings URL", async () => {
    const target = "/?nav=settings&settingsWorkspace=personal&settingsSection=calendar";
    const storeUrl = "https://chromewebstore.google.com/detail/meettina/fcogeajjhhcadbnamadikkefdfmaaiil";
    mockProfile({ extensionWelcome: "linked-account", extensionStoreUrl: storeUrl });
    window.history.replaceState({}, "", target);
    render(<AuthGate calendarWelcome><div>App</div></AuthGate>);
    const link = await screen.findByRole("link", { name: "Open Chrome Web Store" });
    expect(link.getAttribute("href")).toBe(storeUrl);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.queryByRole("button", { name: "Copy Chrome extensions address" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue to TINA" }));
    expect(await screen.findByText("App")).toBeTruthy();
    expect(window.location.pathname + window.location.search).toBe(target);
  });

  it("keeps explicit links to other views and offers desktop instructions on mobile", async () => {
    mockProfile({ calendarWelcome: "another-new-account" });
    window.history.replaceState({}, "", "/?nav=settings&settingsSection=calendar");
    const deepLink = render(<AuthGate calendarWelcome><div>App</div></AuthGate>);
    expect(await screen.findByText("App")).toBeTruthy();
    expect(window.location.search).toContain("settingsSection=calendar");
    deepLink.unmount();

    window.history.replaceState({}, "", "/");
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("iPhone Mobile");
    mockProfile({ extensionWelcome: "mobile-account" });
    render(<AuthGate calendarWelcome><div>App</div></AuthGate>);
    expect(await screen.findByText(/Open TINA in Chrome on a computer/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Download extension ZIP" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy Chrome extensions address" })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue to TINA" })).toBeTruthy();
  });
});

describe("AuthGate pre-login TINA landing", () => {
  const origFetch = globalThis.fetch;

  beforeEach(() => {
    window.localStorage.removeItem("tina.landing.lang");
    vi.mocked(signIn).mockClear();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response("{}", { status: 401 });
      if (url.includes("/api/auth/providers")) {
        return new Response(JSON.stringify({ google: { id: "google" }, microsoft: { id: "microsoft" } }), { status: 200 });
      }
      if (url.includes("/api/auth/instance")) {
        return new Response(JSON.stringify({ admin_exists: false }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = origFetch;
  });

  it("renders OAuth providers and first-run admin claim messaging in VI default and EN toggle", async () => {
    render(<AuthGate><div>App</div></AuthGate>);
    expect(await screen.findByText("Thiết lập không gian TINA")).toBeTruthy();
    expect(screen.getByText("Lần đăng nhập đầu tiên = Quản trị viên")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tiếp tục với Google/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Tiếp tục với Microsoft/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByText("Set up your instance")).toBeTruthy();
    expect(screen.getByText("First sign-in = administrator")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue with Google/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue with Microsoft/i })).toBeTruthy();
  });

  it("renders bilingual TINA landing, Chrome Extension tabs, interactive Hero scene, and Google OAuth", async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response("{}", { status: 401 });
      if (url.includes("/api/auth/providers")) {
        return new Response(JSON.stringify({ google: { id: "google" } }), { status: 200 });
      }
      if (url.includes("/api/auth/instance")) {
        return new Response(JSON.stringify({ admin_exists: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    render(<AuthGate><div>App</div></AuthGate>);
    expect(await screen.findByRole("heading", { level: 1, name: "Đồng đội AI biết nghe, dịch và trả lời ngay trong họp." })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Điểm nổi bật của TINA" })).toBeTruthy();
    const playPause = screen.getByRole("button", { name: "Tạm dừng thanh chữ chạy" });
    fireEvent.click(playPause);
    expect(playPause.getAttribute("aria-label")).toBe("Tiếp tục thanh chữ chạy");
    fireEvent.click(playPause);
    expect(playPause.getAttribute("aria-label")).toBe("Tạm dừng thanh chữ chạy");

    expect(await screen.findByText("Trong cuộc họp")).toBeTruthy();
    expect(screen.getByText("TINA Chrome Extension")).toBeTruthy();
    expect(screen.getAllByText("TINA Agent").length).toBeGreaterThan(0);

    const transcriptPause = screen.getByRole("button", { name: "Tạm dừng hội thoại mẫu" });
    fireEvent.click(transcriptPause);
    expect(transcriptPause.getAttribute("aria-label")).toBe("Tiếp tục hội thoại mẫu");
    expect(screen.getByText("Nguồn (2): Đoạn 09:40:12 và biên bản 18/11")).toBeTruthy();

    // Calling TINA switches the hero scene to its spoken answer.
    fireEvent.click(screen.getByRole("button", { name: /Gọi “Tina ơi”/i }));
    expect(screen.getByText(/Tuần trước nhóm chốt 2 mục/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /^Bắt kịp$/i }));
    expect(screen.getByText(/Cửa sổ 09:40:02/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Ask TINA/i }));
    fireEvent.click(screen.getByRole("button", { name: /Lưu vào Wiki/i }));
    expect(screen.getByText(/Đã mô phỏng lưu vào Wiki/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Tiếp tục với Google/i }));
    expect(signIn).toHaveBeenCalledWith("google", expect.objectContaining({ callbackUrl: expect.any(String) }));
  });
});

describe("WebShell production UI (Option A & Option B)", () => {
  const origFetch = globalThis.fetch;

  function mockEnvironment({
    admin,
    workspacePilot,
    hideModelSettings,
    extensionStoreUrl,
    chatGptStatus,
    liveAssistState = { configured: false, enabled: false, can_configure: true, readonly: false, revision: 0, items: [] },
  }: {
    admin: boolean;
    workspacePilot?: boolean;
    hideModelSettings?: boolean;
    extensionStoreUrl?: string;
    chatGptStatus?: { status: number; body: Record<string, unknown> };
    liveAssistState?: Record<string, unknown>;
  }) {
    let currentState = { ...liveAssistState };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) {
        return new Response(JSON.stringify({
          user: { name: "Sarup Banskota", email: "sarup@tina.local" },
          ...(typeof workspacePilot === "boolean" ? { workspacePilot } : {}),
          ...(typeof hideModelSettings === "boolean" ? { hideModelSettings } : {}),
          ...(extensionStoreUrl ? { extensionStoreUrl } : {}),
        }), { status: 200 });
      }
      if (url.includes("/api/admin/me")) {
        return new Response(admin ? JSON.stringify({ ok: true }) : "{}", { status: admin ? 200 : 404 });
      }
      if (url.includes("/api/sessions/") && url.includes("/history")) {
        return new Response(
          JSON.stringify({
            turns: [
              { role: "user", text: "Earlier checklist question" },
              { role: "agent", text: "Earlier checklist answer" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [
              { session: "sess-alpha", title: "Q4 Rollout Checklist", last_active: TODAY_ISO },
              { session: "sess-beta", title: '[Context: Space "Sales"] Pricing Review', last_active: YESTERDAY_START },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/chat/reset") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/chat/approval") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/meetings/") && url.includes("/voice-assistant/audio/")) {
        return new Response(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]), {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        });
      }
      if (url.includes("/api/meetings/") && url.includes("/voice-assistant")) {
        return new Response(
          JSON.stringify({
            available: true,
            policy: { enabled: true },
            runtime: { state: "LISTENING" },
            replies: [
              {
                request_id: "11111111-1111-4111-8111-111111111111",
                text: "TINA đã tổng hợp 2 điểm chính từ cuộc họp vừa rồi.",
                state: "completed",
                created_at_ms: 15_000,
                source_count: 1,
                answer_kind: "meeting",
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/meetings/") && url.includes("/annotate") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === "/api/meetings/102/workspace" && init?.method === "PUT") {
        return Response.json({ workspace_id: "eng-syncs" });
      }
      if (url.includes("/api/user/models")) {
        if (init?.method === "PUT") {
          const patch = JSON.parse(String(init.body || "{}")) as Record<string, string>;
          return new Response(JSON.stringify({ mode: "openai-subscription", model: "gpt-6-luna", ...patch }), { status: 200 });
        }
        return new Response(JSON.stringify({ mode: "openai-subscription", model: "gpt-6-luna" }), { status: 200 });
      }
      if (url.includes("/api/user/transcription")) {
        return new Response(
          JSON.stringify({
            available_backends: ["default", "viegem", "custom"],
            effective: { backend: "viegem", label: "VieGem + LM", model: null, source: "platform" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/models/openai/status")) {
        if (chatGptStatus) {
          return new Response(JSON.stringify(chatGptStatus.body), { status: chatGptStatus.status });
        }
        return new Response(JSON.stringify({ connected: true, email: "nghixa021@gmail.com" }), { status: 200 });
      }
      if (url.includes("/api/models/openai/logout") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/models/openai/catalog")) {
        return new Response(JSON.stringify({ models: [{ id: "gpt-6-luna", name: "GPT-6 Luna" }] }), { status: 200 });
      }
      if (url.includes("/api/models/catalog")) {
        return new Response(JSON.stringify({ models: [{ id: "gpt-5", name: "GPT-5" }] }), { status: 200 });
      }
      if (url.includes("/api/models/test")) {
        return new Response(
          JSON.stringify({ ok: true, mode: "openai-subscription", source: "settings", summary: "Connected as nghixa021@gmail.com" }),
          { status: 200 },
        );
      }
      if (url.includes("/api/admin/settings/models")) {
        return new Response(JSON.stringify({ value: { mode: "deepseek", model: "deepseek-flash" } }), { status: 200 });
      }
      if (url.includes("/api/admin/settings/transcription")) {
        return new Response(JSON.stringify({ value: { default_backend: "viegem" } }), { status: 200 });
      }
      if (url.includes("/api/meeting/jitsi-hosts")) {
        return new Response(JSON.stringify({ hosts: [] }), { status: 200 });
      }
      if (url.includes("/state/configure") && init?.method === "POST") {
        currentState = { ...currentState, configured: true, enabled: true, revision: 1 };
        return new Response(JSON.stringify(currentState), { status: 200 });
      }
      if (url.includes("/api/transcripts/by-id/") && url.includes("/state")) {
        return new Response(JSON.stringify(currentState), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    });
    globalThis.fetch = fetchMock as typeof fetch;
    return fetchMock;
  }

  afterEach(() => {
    cleanup();
    globalThis.fetch = origFetch;
    capturedChatCallbacks = null;
    window.history.replaceState({}, "", "/");
    document.documentElement.removeAttribute("data-theme");
    localStorage.clear();
  });

  it("commits the selected time before posting a meeting plan", async () => {
    vi.setSystemTime(new Date(2027, 0, 27, 12));
    try {
      const fetchMock = mockEnvironment({ admin: false });
      render(<WebShell />);
      fireEvent.click(screen.getByRole("button", { name: "More capture options" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: /Plan \/ Schedule meeting/i }));
      fireEvent.change(screen.getByPlaceholderText("Weekly Product Review"), { target: { value: "Planning" } });
      fireEvent.click(screen.getByRole("button", { name: "Scheduled time" }));
      const save = screen.getByRole<HTMLButtonElement>("button", { name: "Save meeting plan" });
      expect(save.disabled).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: /28.*2027/ }));
      const time = screen.getByRole("textbox", { name: "Time" });
      fireEvent.change(time, { target: { value: "09:07" } });
      fireEvent.keyDown(time, { key: "Enter" });
      expect(fetchMock).not.toHaveBeenCalledWith("/api/meetings", expect.objectContaining({ method: "POST" }));
      expect(save.disabled).toBe(false);
      fireEvent.click(save);

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith("/api/meetings", expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            title: "Planning", meeting_url: null,
            scheduled_at: new Date(2027, 0, 28, 9, 7).toISOString(), auto_join: true,
          }),
        }));
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports split-button Capture ▾, Meetings Notebook multi-filter, date grouping, rename & ••• menu", async () => {
    const fetchMock = mockEnvironment({ admin: false });
    render(<WebShell />);

    expect(await screen.findByRole("heading", { name: /Sarup/ })).toBeTruthy();

    // Split-button Capture ▾ -> Schedule opens modal directly on Schedule tab
    fireEvent.click(screen.getByRole("button", { name: "More capture options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Plan \/ Schedule meeting/i }));
    expect(await screen.findByPlaceholderText("Weekly Product Review")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    // Navigate to Meetings Notebook -> verify date grouping & multi-dimensional Filter popover
    fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
    expect(screen.queryByRole("button", { name: "Live now" })).toBeNull();
    expect(await screen.findByText("Live now")).toBeTruthy();
    expect(screen.getByText("Yesterday")).toBeTruthy();
    expect(screen.queryByText("Live sync")).toBeNull();
    expect(screen.queryByRole("button", { name: "Capture menu" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Filters/i }));
    fireEvent.click(screen.getByRole("tab", { name: "Platform" }));
    fireEvent.click(screen.getByLabelText("Zoom"));
    fireEvent.click(screen.getByRole("button", { name: /Done \(1\)/i }));

    expect(screen.getByText("Design Review")).toBeTruthy();
    expect(screen.queryByText("Product Weekly Sync")).toBeNull();

    // Open ••• menu on Design Review -> Rename calls POST /api/meetings/102/annotate
    fireEvent.click(screen.getByRole("button", { name: "More actions for Design Review" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const renameInput = screen.getByLabelText("Meeting title");
    fireEvent.change(renameInput, { target: { value: "Design Review · Final" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/meetings/102/annotate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ title: "Design Review · Final" }),
        }),
      );
    });

    // Open ••• menu -> Share session link mints real tshare link
    fireEvent.click(screen.getByRole("button", { name: "More actions for Design Review" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Share session link/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create share link" }));
    const shareLinkInput = (await screen.findByLabelText("Session share link")) as HTMLInputElement;
    expect(shareLinkInput.value).toContain("tshare=tshare_xyz789");
  });

  it("adds a recorded meeting to a writable workspace using its row ID", async () => {
    mockNativeDialog();
    onTestFinished(() => {
      mockListSharedMemberships.mockResolvedValue([{ workspace_id: "eng-syncs", role: "owner" }]);
    });
    const fetchMock = mockEnvironment({ admin: false });
    mockListSharedMemberships.mockResolvedValue([
      { workspace_id: "eng-syncs", role: "owner" },
      { workspace_id: "read-only", role: "viewer" },
    ]);
    render(<WebShell />);
    fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
    fireEvent.click(await screen.findByRole("button", { name: "More actions for Design Review" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Add to workspace" }));
    expect(await screen.findByRole("option", { name: "eng-syncs" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "read-only" })).toBeNull();
    expect(screen.getByText(/Recording access is managed separately/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Shared workspace"), { target: { value: "eng-syncs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save workspace" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/meetings/102/workspace", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ workspace_id: "eng-syncs", expected_workspace_id: null }),
    })));
    expect(await screen.findByText(/Meeting added to/)).toBeTruthy();
  });

  it("saves a confirmed routine through the scheduler API and still offers the latest recording", async () => {
    mockNativeDialog();
    const fetchMock = mockEnvironment({ admin: false });
    const fetchDefault = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/routines" && init?.method === "POST") {
        return Response.json({ id: "rt_test", path: "routines/rt_test.md", scheduled: true });
      }
      return fetchDefault(input, init);
    });
    render(<WebShell />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Tina" }));

    const composer = await screen.findByLabelText<HTMLTextAreaElement>("Message Ask Tina");
    fireEvent.change(composer, { target: { value: "/routine Báo cáo các task đang mở" } });
    const options = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValueOnce({ ...options, timeZone: "Asia/Saigon" });
    onTestFinished(() => { resolvedOptions.mockRestore(); });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const dialog = screen.getByRole("dialog", { name: "Create routine" });
    const fields = within(dialog);
    expect(fields.getByLabelText<HTMLTextAreaElement>("Task instructions").value).toBe("Báo cáo các task đang mở");
    const timeZone = fields.getByLabelText<HTMLInputElement>("IANA time zone");
    expect(timeZone.value).toBe("Asia/Ho_Chi_Minh");
    expect(capturedChatCallbacks).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/routines")).toBe(false);
    fireEvent.change(fields.getByLabelText("Routine name"), { target: { value: "Báo cáo task mở" } });
    const schedule = fields.getByLabelText("Schedule", { exact: true });
    expect(fields.queryByLabelText("Cron schedule")).toBeNull();
    fireEvent.change(schedule, { target: { value: "custom" } });
    expect(fields.getByLabelText("Cron schedule")).toBeTruthy();
    fireEvent.change(schedule, { target: { value: "daily" } });
    expect(fields.getByLabelText("Time of day")).toBeTruthy();
    fireEvent.change(schedule, { target: { value: "*/5 * * * *" } });
    expect(fields.queryByLabelText("Cron schedule")).toBeNull();
    fireEvent.change(timeZone, { target: { value: "Asia/Saigon" } });
    fireEvent.click(fields.getByRole("button", { name: "Save and enable" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create routine" })).toBeNull());
    expect(fetchMock).toHaveBeenCalledWith("/api/routines", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "Báo cáo task mở", cron: "*/5 * * * *", timezone: "Asia/Ho_Chi_Minh",
        prompt: "Báo cáo các task đang mở", workspace_file: true, run_now: false,
      }),
    }));
    expect(composer.value).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Summarize Design Review" }));
    await waitFor(() => {
      expect(mockStreamChatTurn).toHaveBeenLastCalledWith(
        expect.objectContaining({ active: expect.objectContaining({ meeting_id: "102" }) }),
        expect.anything(),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it("keeps the composer usable when chat history is unavailable and retries history separately", async () => {
    const fetchMock = mockEnvironment({ admin: false });
    const fetchDefault = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === "/api/sessions") {
        return new Response(JSON.stringify({
          error: "not_found",
          detail: "agent endpoints are disabled in meetings mode",
        }), { status: 404 });
      }
      return fetchDefault(input, init);
    });
    render(<WebShell />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Tina" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Chat history is unavailable for this account.");
    expect(screen.queryByText("Conversations appear here after your first question.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Find follow-up actions" }));
    const composer = screen.getByLabelText<HTMLTextAreaElement>("Message Ask Tina");
    expect(composer.value).toBe("What follow-up actions were agreed on, and who owns them?");
    expect(document.activeElement).toBe(composer);

    fetchMock.mockImplementation(fetchDefault);
    fireEvent.click(screen.getByRole("button", { name: "Retry history" }));
    expect(await screen.findByText("Q4 Rollout Checklist")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(composer.value).toContain("follow-up actions");
  });

  it("supports Ask Tina chat search, MCP Tool Approval decisions, and Copy/Share response actions", async () => {
    const fetchMock = mockEnvironment({ admin: false });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<WebShell />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Tina" }));

    // Search chats in sidebar filters /api/sessions
    expect(await screen.findByText("Q4 Rollout Checklist")).toBeTruthy();
    expect(screen.getByText("Pricing Review")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search conversations"), { target: { value: "pricing" } });
    expect(screen.getByText("Pricing Review")).toBeTruthy();
    expect(screen.queryByText("Q4 Rollout Checklist")).toBeNull();

    // Send a prompt with leading [Context: ...] -> renders clean context pill + Tool Approval card + Copy/Share buttons
    const composer = screen.getByLabelText("Message Ask Tina");
    fireEvent.change(composer, {
      target: { value: '[Context: Space "My Space"]\n\nSchedule follow-up review' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Space · My Space")).toBeTruthy();
    expect(screen.getByText("Schedule follow-up review")).toBeTruthy();
    expect(screen.queryByText(/\[Context:/)).toBeNull();
    expect(await screen.findByText("Create follow-up calendar invite")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Approve once/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chat/approval",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"approval_id":"appr-1"'),
        }),
      );
    });

    // Resolve approval via SSE callback -> status updates
    capturedChatCallbacks?.onApprovalResolved?.({
      type: "tool-approval-resolved",
      approval_id: "appr-1",
      turn_id: "turn-9",
      outcome: "approved",
    });
    expect(await screen.findByText("Approved for this call")).toBeTruthy();

    // Copy response action writes markdown text to clipboard
    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Drafted follow-up summary for **Product Weekly Sync**.");
    });
  });

  it("lets users delete individual old conversations and clear all conversations in Ask Tina", async () => {
    const fetchMock = mockEnvironment({ admin: false });
    render(<WebShell />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Tina" }));

    // Open an existing conversation so we also verify deleting the active chat resets the pane
    fireEvent.click(await screen.findByText("Q4 Rollout Checklist"));
    expect(await screen.findByText("Earlier checklist answer")).toBeTruthy();

    // Click trash button -> shows inline confirmation -> confirm Delete calls POST /api/chat/reset
    fireEvent.click(screen.getByRole("button", { name: "Delete conversation Q4 Rollout Checklist" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chat/reset",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ session: "sess-alpha" }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("Q4 Rollout Checklist")).toBeNull();
    });
    expect(await screen.findByRole("heading", { name: "Ask Tina" })).toBeTruthy();
    expect(screen.getByText("Pricing Review")).toBeTruthy();

    // Clear all remaining conversations with inline confirmation
    fireEvent.click(screen.getByRole("button", { name: "Clear all conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete all" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/chat/reset",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ session: "sess-beta" }),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("Pricing Review")).toBeNull();
    });
    expect(await screen.findByText("Conversations appear here after your first question.")).toBeTruthy();
  });

  it("opens Knowledge Hub directly when clicking a kg/*.md path inside an Ask Tina reply", async () => {
    mockEnvironment({ admin: false });
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/sessions/sess-alpha/history")) {
        return new Response(
          JSON.stringify({
            turns: [
              { role: "user", text: "tạo trang hướng dẫn knowledge" },
              { role: "agent", text: "Bạn có thể xem trang mới tại `kg/knowledge_guide.md` nhé." },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/workspace/tree")) {
        return new Response(JSON.stringify({ files: ["kg/knowledge_guide.md"] }), { status: 200 });
      }
      if (url.includes("/api/workspace/document") && url.includes("knowledge_guide.md")) {
        return new Response(
          JSON.stringify({
            path: "kg/knowledge_guide.md",
            content: "# Hướng dẫn sử dụng Knowledge\n\nNội dung chi tiết.\n",
            sha256: "abc",
            writable: true,
          }),
          { status: 200 },
        );
      }
      return origFetch(input, init);
    }) as typeof fetch;

    render(<WebShell />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Tina" }));
    fireEvent.click(await screen.findByText("Q4 Rollout Checklist"));

    const docChip = await screen.findByText("kg/knowledge_guide.md");
    fireEvent.click(docChip);

    await waitFor(() => {
      expect(window.location.search).toContain("nav=knowledge");
      expect(window.location.search).toContain("doc=kg%2Fknowledge_guide.md");
    });
  });

  it("enables Live Assist on live meetings, shows Speaker Talk Time, and honors Personal/Team Settings", async () => {
    mockEnvironment({ admin: true });
    render(<WebShell initialMeetingId="101" />);

    const enableBtn = await screen.findByRole("button", { name: /Enable live assist/i });
    fireEvent.click(enableBtn);

    expect(await screen.findByTestId("real-live-assist-view")).toBeTruthy();
    const transcriptTab = screen.getByRole("tab", { name: /Transcript/i });
    const liveAssistTab = screen.getByRole("tab", { name: /Live Assist/i });
    expect(liveAssistTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(transcriptTab);
    expect(transcriptTab.getAttribute("aria-selected")).toBe("true");

    // Talk time insights panel renders computed speaker stats
    const talkTimeBtn = screen.getByRole("button", { name: /Talk time/i });
    if (talkTimeBtn.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(talkTimeBtn);
    }
    expect(await screen.findByText("Talk time & metrics")).toBeTruthy();
    expect((await screen.findAllByText("Linh")).length).toBeGreaterThanOrEqual(1);
  });

  it("starts Smart Search closed on desktop and keeps both controls in sync", async () => {
    mockEnvironment({ admin: false });
    vi.stubGlobal("innerWidth", 1440);
    try {
      render(<WebShell initialMeetingId="102" />);
    } finally {
      vi.unstubAllGlobals();
    }

    await screen.findByRole("heading", { name: "Design Review" });
    const smartSearchToggle = screen.getByRole("button", { name: "Show Smart Search" });
    const talkTimeBtn = screen.getByRole("button", { name: "Talk time" });
    const sidebarName = "Smart Search and Talk time & metrics";
    expect(smartSearchToggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("complementary", { name: sidebarName })).toBeNull();

    fireEvent.click(smartSearchToggle);
    const sidebar = screen.getByRole("complementary", { name: sidebarName });
    expect(smartSearchToggle.getAttribute("aria-expanded")).toBe("true");
    expect(smartSearchToggle.getAttribute("aria-controls")).toBe(sidebar.id);
    expect(talkTimeBtn.getAttribute("aria-expanded")).toBe("true");
    const refreshButton = screen.getByRole("button", { name: "Refresh speaker metrics" });
    expect(refreshButton.textContent).toBe("Refresh");
    expect(refreshButton.querySelector("svg")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Hide Smart Search" }));
    expect(screen.queryByRole("complementary", { name: sidebarName })).toBeNull();
    expect(talkTimeBtn.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(talkTimeBtn);
    expect(screen.getByRole("heading", { name: "Smart Search" })).toBeTruthy();
  });

  it("renders the 3-column Fireflies-style Meeting Workspace (Smart Search, Notes/Skills/Action Items, Ask Tina/Transcript, Bottom Player)", async () => {
    const fetchMock = mockEnvironment({ admin: false });
    render(<WebShell initialMeetingId="102" />);

    // Center Notes document renders title, code badge, summary card, and action item creator
    expect(await screen.findByRole("heading", { name: "Design Review" })).toBeTruthy();
    expect(screen.getByText("#kuz-wvic-dfc")).toBeTruthy();
    expect(screen.getByText("AI Executive Summary")).toBeTruthy();

    // Add a new action item in Notes & verify Action Items tab badge increments
    fireEvent.change(screen.getByLabelText("Add new action item"), {
      target: { value: "Ship updated meeting detail layout" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("Ship updated meeting detail layout")).toBeTruthy();

    // Switch to AI Skills tab & run a real grounded skill via streamChatTurn
    fireEvent.click(screen.getByRole("tab", { name: /AI Skills/i }));
    expect(screen.getByText("Executive Brief and Decisions")).toBeTruthy();

    // Right panel Ask Tina starter streams through streamChatTurn
    fireEvent.click(screen.getByRole("tab", { name: /Ask Tina/i }));
    fireEvent.click(screen.getByRole("button", { name: "What were the main topics?" }));
    expect(await screen.findByText(/Drafted follow-up summary/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Talk time" }));
    expect(screen.getByRole("heading", { name: "Smart Search" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Linh/i }));
    expect(screen.getByRole("tab", { name: /Transcript/i }).getAttribute("aria-selected")).toBe("true");

    // Clear speaker filter -> Voice Agent TTS ("TINA Agent") reply appears inline in Transcript
    fireEvent.click(screen.getAllByRole("button", { name: /Linh/i })[0]);
    expect(await screen.findByText("TINA Agent")).toBeTruthy();
    expect(screen.getByText("TINA đã tổng hợp 2 điểm chính từ cuộc họp vừa rồi.")).toBeTruthy();
    expect(screen.getByText("Nguồn (1)")).toBeTruthy();

    // TINA Agent filter toggle isolates Voice Agent TTS replies cleanly
    fireEvent.click(screen.getByRole("button", { name: /TINA Agent/i }));
    expect(screen.getByText("TINA đã tổng hợp 2 điểm chính từ cuộc họp vừa rồi.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /TINA Agent/i }));

    // Rename via detail top bar ••• menu calls POST /api/meetings/102/annotate
    fireEvent.click(screen.getByRole("button", { name: "Meeting options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename meeting" }));
    fireEvent.change(screen.getByLabelText("Meeting title"), { target: { value: "Design Review Q4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save title" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/meetings/102/annotate",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ title: "Design Review Q4" }),
        }),
      );
    });
  });

  it("exposes Terminal link + Team admin sections (Global Defaults, ASR Workers) for admins and honors URL params", async () => {
    window.history.replaceState({}, "", "/?nav=settings&settingsWorkspace=team&settingsSection=asr-status");
    mockEnvironment({ admin: true });
    render(<WebShell />);

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Open TINA Terminal" }).getAttribute("href")).toBe("/terminal");
    });

    expect(await screen.findByTestId("real-asr-panel")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Global Defaults/i }));
    expect(await screen.findByText(/Deployment-wide defaults/i)).toBeTruthy();
    expect(screen.getByText("Global Transcription Backend")).toBeTruthy();
  });

  it.each([
    [200, true, "ChatGPT plan connected for Workspace"],
    [200, false, "Workspace ChatGPT setup is unavailable for this TINA account."],
    [503, true, "Could not check the Workspace ChatGPT connection."],
  ] as const)("fetches Workspace ChatGPT status once and respects HTTP %s and availability %s", async (status, available, message) => {
    vi.stubEnv("NEXT_PUBLIC_TERMINAL_MODE", "workspace-pilot");
    try {
      const fetchMock = mockEnvironment({ admin: false, workspacePilot: true, chatGptStatus: { status, body: { available, connected: true } } });
      render(<WebModelsPanel />);
      expect(await screen.findByText(message)).toBeTruthy();
      expect(fetchMock.mock.calls.filter(([url]) => url === "/api/models/openai/status")).toHaveLength(1);
      expect(Boolean(screen.queryByText(/staging operators only/i))).toBe(status === 200 && available);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("renders streamlined 4-provider matrix (Amazon Bedrock, OpenAI, Gemini, Groq), legacy ChatGPT OAuth disconnect, API key reveal, and Bedrock meeting toggle", async () => {
    window.history.replaceState({}, "", "/?nav=settings&settingsWorkspace=personal&settingsSection=models");
    const fetchMock = mockEnvironment({ admin: false });
    render(<WebShell />);

    // Legacy ChatGPT Plan OAuth card still works if already configured; Step 1 shows the 4 approved providers
    expect(await screen.findByText("ChatGPT Plan Connected")).toBeTruthy();
    expect(screen.getByText("nghixa021@gmail.com")).toBeTruthy();
    const logoSrcs = Array.from(document.querySelectorAll("img.tina-web-provider-logo")).map((el) =>
      el.getAttribute("src"),
    );
    expect(logoSrcs).toContain("/provider-logos/aws.svg");
    expect(logoSrcs).toContain("/provider-logos/openai.svg");
    expect(logoSrcs).toContain("/provider-logos/gemini.svg");
    expect(logoSrcs).toContain("/provider-logos/groq.svg");
    expect(logoSrcs).not.toContain("/provider-logos/claude.svg");
    expect(logoSrcs).not.toContain("/provider-logos/deepseek.svg");
    expect(logoSrcs).not.toContain("/provider-logos/antigravity.svg");

    fireEvent.click(screen.getByRole("button", { name: /Test connection/i }));
    expect(await screen.findByText("Connection verified")).toBeTruthy();
    expect(screen.getByText(/Connected as nghixa021@gmail\.com/)).toBeTruthy();

    // Disconnect ChatGPT calls real logout endpoint and flips card to Not linked
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/models/openai/logout",
        expect.objectContaining({ method: "POST" }),
      );
    });
    expect(await screen.findByText("Connect your ChatGPT Plan")).toBeTruthy();

    // Switch provider card to OpenAI API -> shows secret reveal toggle, meeting toggle, & saves via PUT /api/user/models
    fireEvent.click(screen.getByRole("radio", { name: /OpenAI API/i }));
    const keyInput = screen.getByLabelText("Credential") as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show API key" }));
    expect(keyInput.type).toBe("text");
    fireEvent.change(keyInput, { target: { value: "sk-test-12345" } });

    const bedrockMeetingToggle = screen.getByRole("checkbox", {
      name: /Use Amazon Bedrock \(Default\) for Voice & Meeting/i,
    }) as HTMLInputElement;
    expect(bedrockMeetingToggle.checked).toBe(false);
    fireEvent.click(bedrockMeetingToggle);
    expect(bedrockMeetingToggle.checked).toBe(true);
    const meetingModelInput = screen.getByLabelText("Meeting model") as HTMLInputElement;
    expect(meetingModelInput.disabled).toBe(true);
    expect(meetingModelInput.value).toBe("Amazon Bedrock (Default)");

    const saveBtn = screen.getByRole("button", { name: /Save changes/i });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveBtn);
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        ([url, init]) => String(url) === "/api/user/models" && init?.method === "PUT",
      );
      expect(putCall).toBeTruthy();
      expect(JSON.parse(String(putCall![1]!.body))).toMatchObject({
        mode: "openai-api",
        api_key: "sk-test-12345",
        meeting_use_default: "true",
      });
    });

    // Switch back to Amazon Bedrock (Default) -> hides API key input and explains built-in Bedrock default
    fireEvent.click(screen.getByRole("radio", { name: /Amazon Bedrock/i }));
    expect(screen.queryByLabelText("Credential")).toBeNull();
    expect(screen.getByText(/No personal API key required/i)).toBeTruthy();
  });

  it("unlocks Ask Tina in WebShell for authorized workspace-pilot users while keeping /terminal restricted to admins", async () => {
    vi.stubEnv("NEXT_PUBLIC_TERMINAL_MODE", "workspace-pilot");
    try {
      mockEnvironment({ admin: false, workspacePilot: true });
      const { unmount } = render(<WebShell />);
      expect(await screen.findByRole("button", { name: "Ask Tina" })).toBeTruthy();
      expect(screen.queryByRole("link", { name: "Open TINA Terminal" })).toBeNull();
      unmount();

      mockEnvironment({ admin: false, workspacePilot: false });
      render(<WebShell />);
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Ask Tina" })).toBeNull();
      });
      expect(screen.queryByRole("link", { name: "Open TINA Terminal" })).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("opens Settings on Account and keeps explicit Calendar links", async () => {
    mockEnvironment({ admin: false });
    const { unmount } = render(<WebShell />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(await screen.findByRole("heading", { name: "Account", level: 1 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account" }).getAttribute("aria-current")).toBe("page");
    expect(new URLSearchParams(window.location.search).get("settingsSection")).toBe("account");
    expect(screen.getByRole("heading", { name: "Access and session" })).toBeTruthy();

    unmount();
    window.history.replaceState({}, "", "/?nav=settings&settingsWorkspace=personal&settingsSection=calendar");
    render(<WebShell />);
    expect(await screen.findByRole("heading", { name: "Calendar & Auto-join" })).toBeTruthy();
  });

  it("hides AI Models & Transcription and Team Global Defaults in Web Settings when NEXT_PUBLIC_HIDE_MODEL_SETTINGS=1 (or via /api/auth/me runtime flag)", async () => {
    vi.stubEnv("NEXT_PUBLIC_HIDE_MODEL_SETTINGS", "1");
    try {
      window.history.replaceState({}, "", "/?nav=settings&settingsWorkspace=personal&settingsSection=models");
      mockEnvironment({ admin: true });
      const { unmount } = render(<WebShell />);

      await waitFor(() => {
        const account = screen.getByRole("region", { name: "Account" });
        expect(within(account).getByRole("link", { name: "Open TINA Terminal" }).getAttribute("href")).toBe("/terminal");
      });
      // Falls back from ?settingsSection=models to Account and omits the Personal Models item
      expect(screen.queryByRole("button", { name: /AI Models & Transcription/i })).toBeNull();
      expect(screen.getByRole("heading", { name: "Account" })).toBeTruthy();

      // Team Settings keeps Workspaces & Members + ASR Workers for admins, but hides Global Defaults
      fireEvent.click(screen.getByRole("tab", { name: "Team" }));
      expect(screen.getByRole("button", { name: /Workspaces & Members/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /ASR Workers/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Global Defaults/i })).toBeNull();

      // Settings search does not surface hidden model panels
      fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "openai" } });
      expect(screen.queryByRole("button", { name: /AI Models & Transcription/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /Global Defaults/i })).toBeNull();
      unmount();
    } finally {
      vi.unstubAllEnvs();
    }

    // Runtime toggle via /api/auth/me also hides model settings without rebuilding the client bundle
    window.history.replaceState({}, "", "/?nav=settings&settingsWorkspace=team&settingsSection=global-models");
    mockEnvironment({ admin: true, hideModelSettings: true });
    render(<WebShell />);
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Global Defaults/i })).toBeNull();
    });
    expect(screen.getByRole("heading", { name: "Workspaces & Members" })).toBeTruthy();
  });

  it("auto-collapses the sidebar on Ask Tina, Meetings, Knowledge, Settings and auto-expands on Home, Tasks, Routines while preserving manual toggle", async () => {
    mockEnvironment({ admin: false });
    render(<WebShell />);

    const sidebar = () => document.querySelector("aside.tina-web-sidebar") as HTMLElement;
    const toggleBtn = () => document.querySelector("button.tina-web-collapse-btn") as HTMLButtonElement;

    // Starts expanded on Home
    expect(await screen.findByRole("heading", { name: /Sarup/ })).toBeTruthy();
    expect(sidebar().classList.contains("collapsed")).toBe(false);
    expect(toggleBtn().getAttribute("aria-expanded")).toBe("true");

    // Clicking each two-pane nav destination auto-collapses the sidebar, and manual expand still works
    for (const label of ["Ask Tina", "Meetings", "Knowledge", "Settings"] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(sidebar().classList.contains("collapsed")).toBe(true);
      expect(toggleBtn().getAttribute("aria-expanded")).toBe("false");

      // Manual expand works normally
      fireEvent.click(toggleBtn());
      expect(sidebar().classList.contains("collapsed")).toBe(false);
      expect(toggleBtn().getAttribute("aria-expanded")).toBe("true");
    }

    // Clicking Home, Tasks, or Routines while collapsed auto-expands the sidebar, and manual collapse still works
    for (const label of ["Home", "Tasks", "Routines"] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(sidebar().classList.contains("collapsed")).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(sidebar().classList.contains("collapsed")).toBe(false);
      expect(toggleBtn().getAttribute("aria-expanded")).toBe("true");

      // Manual collapse and expand work normally
      fireEvent.click(toggleBtn());
      expect(sidebar().classList.contains("collapsed")).toBe(true);
      expect(toggleBtn().getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggleBtn());
      expect(sidebar().classList.contains("collapsed")).toBe(false);
    }
  });

  it("navigates to the newly created meeting page when clicking 'Send bot again' on a failed meeting", async () => {
    const origEventSource = globalThis.EventSource;
    const sseUrls: string[] = [];
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(url: string) {
        sseUrls.push(url);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;

    try {
      window.history.replaceState({}, "", "/meetings/109");
      mockFetchMeetingById.mockImplementation(async (id: string) => {
        if (id === "109") {
          return {
            id: "109",
            native_id: "cfr-uyfy-enb",
            title: "Google Meet · cfr-uyfy-enb",
            when: "Just now",
            status: "past",
            live_status: "failed",
            join_failure_summary: "Google Meet timed out waiting for admission.",
            platform: "Google Meet",
            participants: [],
            mentioned: [],
            actions: [],
            transcript: [],
            insights: [],
          } as MeetingMock;
        }
        if (id === "110") {
          return {
            id: "110",
            native_id: "cfr-uyfy-enb",
            title: "Google Meet · cfr-uyfy-enb",
            when: "Now · live",
            status: "live",
            live_status: "requested",
            session_uid: "110",
            platform: "Google Meet",
            participants: [],
            mentioned: [],
            actions: [],
            transcript: [],
            insights: [],
          } as MeetingMock;
        }
        return null;
      });

      const baseFetch = mockEnvironment({ admin: false });
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/bots" && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              id: 110,
              platform: "google_meet",
              native_meeting_id: "cfr-uyfy-enb",
              status: "requested",
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        return baseFetch(input, init);
      }) as typeof fetch;

      render(<WebShell initialMeetingId="109" />);

      const sendAgainBtn = await screen.findByRole("button", { name: "Send bot again" });
      fireEvent.click(sendAgainBtn);

      await waitFor(() => {
        expect(window.location.pathname).toBe("/meetings/110");
      });
      expect(await screen.findByRole("button", { name: "Stop bot" })).toBeTruthy();
      expect(sseUrls.some((url) => url.includes("meeting_id=110"))).toBe(true);
    } finally {
      mockFetchMeetingById.mockResolvedValue(null);
      globalThis.EventSource = origEventSource;
    }
  });

  it("expands and collapses the Ask Tina & Transcript panel in focus mode like Fireflies", async () => {
    window.history.replaceState({}, "", "/meetings/102");
    mockEnvironment({ admin: false });

    render(<WebShell initialMeetingId="102" />);

    const sidePanel = await screen.findByLabelText("Ask Tina and Transcript");
    expect(sidePanel.getAttribute("data-expanded")).toBe("false");
    expect(screen.getByLabelText("Meeting notes workspace")).toBeTruthy();

    // Expand from Ask Tina tab -> hides center notes workspace and marks panel expanded
    const expandBtn = screen.getByRole("button", { name: "Expand Ask Tina and Transcript" });
    expect(expandBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(expandBtn);

    expect(sidePanel.getAttribute("data-expanded")).toBe("true");
    expect(screen.queryByLabelText("Meeting notes workspace")).toBeNull();
    const collapseBtn = screen.getByRole("button", { name: "Collapse Ask Tina and Transcript" });
    expect(collapseBtn.getAttribute("aria-pressed")).toBe("true");

    // Switching to Transcript tab preserves expanded focus mode and keeps the toggle button visible
    fireEvent.click(screen.getByRole("tab", { name: /Transcript/i }));
    expect(sidePanel.getAttribute("data-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Collapse Ask Tina and Transcript" })).toBeTruthy();

    // Escape exits focus mode and restores the split layout
    fireEvent.keyDown(window, { key: "Escape" });
    expect(sidePanel.getAttribute("data-expanded")).toBe("false");
    expect(screen.getByLabelText("Meeting notes workspace")).toBeTruthy();

    // Clicking expand then collapse button also restores split layout
    fireEvent.click(screen.getByRole("button", { name: "Expand Ask Tina and Transcript" }));
    expect(screen.queryByLabelText("Meeting notes workspace")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Ask Tina and Transcript" }));
    expect(screen.getByLabelText("Meeting notes workspace")).toBeTruthy();
  });

  it("renders collapsible AgentActivitySteps, sidebar toggle, custom meeting scope popover, edit and retry in Ask Tina", async () => {
    mockEnvironment({ admin: false });
    render(<WebShell />);
    fireEvent.click(screen.getByRole("button", { name: "Ask Tina" }));
    expect(await screen.findByText("Q4 Rollout Checklist")).toBeTruthy();

    // Toggle chat history sidebar via topbar button
    const toggleBtn = screen.getByRole("button", { name: "Toggle chat history" });
    expect(toggleBtn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggleBtn);
    expect(toggleBtn.getAttribute("aria-pressed")).toBe("true");

    // Custom meeting scope popover grounds conversation and shows removable topbar chip
    fireEvent.click(screen.getByRole("button", { name: "Ground on meeting" }));
    expect(screen.getByRole("option", { name: /Design Review/i }).querySelector("small")?.textContent).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Product Weekly Sync/i }));
    expect(screen.getByRole("button", { name: "Clear meeting focus" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear meeting focus" }));
    expect(screen.queryByRole("button", { name: "Clear meeting focus" })).toBeNull();

    // Send a prompt -> emit tool calls -> renders friendly collapsible activity summary instead of raw tool pills
    const composer = screen.getByLabelText("Message Ask Tina") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "Delete sample docs" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(capturedChatCallbacks?.onTool).toBeTruthy();
    });
    capturedChatCallbacks?.onTool?.("list_wiki");
    capturedChatCallbacks?.onTool?.("delete_wiki");
    capturedChatCallbacks?.onTool?.("delete_wiki");

    const activitySummary = await screen.findByText(/3 steps · Browsed Knowledge library, Deleted 2 pages/i);
    expect(activitySummary).toBeTruthy();
    fireEvent.click(activitySummary.closest("button")!);
    expect(await screen.findByLabelText("Agent tool activity")).toBeTruthy();
    expect(screen.getByText("Browsed Knowledge library")).toBeTruthy();
    expect(screen.getByText("Deleted 2 pages")).toBeTruthy();

    // Edit user message puts clean text back into composer
    fireEvent.click(screen.getByRole("button", { name: "Edit message" }));
    expect(composer.value).toBe("Delete sample docs");

    // Retry response button re-runs the turn
    fireEvent.click(screen.getByRole("button", { name: "Retry response" }));
    await waitFor(() => {
      expect(screen.getAllByText("Delete sample docs").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("supports Lucian #451 @-mention picker, #453 thinking text, #435 toast notifications, and #219 circular theme toggle", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    mockEnvironment({ admin: false });
    render(<WebShell />);

    // #219 Circular-reveal dark mode toggle in TopBar switches html[data-theme] and aria-label
    const themeBtn = await screen.findByRole("button", { name: /Switch to light mode/i });
    fireEvent.click(themeBtn);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(screen.getByRole("button", { name: /Switch to dark mode/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Switch to dark mode/i }));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

    // Open Ask Tina and verify #451 @-mention picker (meetings + knowledge pages + spaces)
    fireEvent.click(screen.getByRole("button", { name: "Ask Tina" }));
    expect(await screen.findByText("Q4 Rollout Checklist")).toBeTruthy();

    const composer = screen.getByLabelText("Message Ask Tina") as HTMLTextAreaElement;
    // Trigger @ via toolbar button -> popover opens with real meeting & workspace suggestions
    const mentionBtn = screen.getByRole("button", { name: "Mention meeting or knowledge" });
    fireEvent.click(mentionBtn);
    const listbox = await screen.findByRole("listbox", { name: "Mention meetings or knowledge" });
    expect(listbox).toBeTruthy();
    expect(mentionBtn.getAttribute("aria-expanded")).toBe("true");
    // Blurring textarea toward the @ trigger or popover keeps the mention picker open
    fireEvent.blur(composer, { relatedTarget: mentionBtn });
    expect(mentionBtn.getAttribute("aria-expanded")).toBe("true");
    // Clicking @ again toggles closed without duplicating "@ @", then re-opens cleanly
    fireEvent.click(mentionBtn);
    expect(mentionBtn.getAttribute("aria-expanded")).toBe("false");
    expect(composer.value).toBe("@");
    fireEvent.click(mentionBtn);
    expect(mentionBtn.getAttribute("aria-expanded")).toBe("true");
    expect(composer.value).toBe("@");
    const firstOption = screen.getByRole("option", { name: /Product Weekly Sync/i });
    expect(firstOption).toBeTruthy();

    // Keyboard Enter selects active mention, inserts @Label, adds bouncing chip, and grounds meeting
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(composer.value).toContain("@Product Weekly Sync");
    expect(screen.getByRole("button", { name: "Remove mention Product Weekly Sync" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Clear meeting focus" })).toBeTruthy();

    // Atomic Backspace removes the entire @Product Weekly Sync mention token
    const trimmed = "@Product Weekly Sync";
    fireEvent.change(composer, { target: { value: trimmed, selectionStart: trimmed.length, selectionEnd: trimmed.length } });
    composer.setSelectionRange(trimmed.length, trimmed.length);
    fireEvent.keyDown(composer, { key: "Backspace" });
    expect(composer.value).toBe("");

    // #457 Voice input pill button is present in Ask Tina composer
    expect(screen.getByTestId("lucian-voice-input")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voice input" })).toBeTruthy();

    // #453 Thinking text renders while streaming before text arrives, and #435 Toast fires on Copy
    const turnGate = { resolve: () => {} };
    mockStreamChatTurn.mockImplementationOnce(async (_req: unknown, cbs: ChatStreamCallbacks) => {
      capturedChatCallbacks = cbs;
      cbs.onStarting?.();
      cbs.onStatus?.("working");
      await new Promise<void>((res) => {
        turnGate.resolve = res;
      });
      return { sawVisibleOutput: true, terminal: true, aborted: false };
    });

    fireEvent.change(composer, { target: { value: "Summarize blockers" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    const thinking = await screen.findByTestId("lucian-thinking-text");
    expect(thinking).toBeTruthy();
    expect(thinking.textContent).toContain("Reading your workspace…");
    expect(screen.queryByText(/Grounded on meeting:/)).toBeNull();
    capturedChatCallbacks?.onMeetingGrounding?.({ meetingId: "101", title: "Product Weekly Sync", source: "saved" });
    expect(await screen.findByText("Grounded on meeting: Product Weekly Sync")).toBeTruthy();
    // Expand thinking disclosure panel
    const thinkBtn = thinking.querySelector("button")!;
    fireEvent.click(thinkBtn);
    expect(thinkBtn.getAttribute("aria-expanded")).toBe("true");

    // Finish stream -> Copy triggers #435 stacked toast notification -> Dismiss closes it
    capturedChatCallbacks?.onReply?.("Blocker summary ready.");
    turnGate.resolve();
    expect(await screen.findByText("Blocker summary ready.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    expect(await screen.findByText("Copied response to clipboard")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    await waitFor(() => {
      expect(screen.queryByText("Copied response to clipboard")).toBeNull();
    });
  });

  it("supports Lucian Package 2: #459 Dynamic Island, #097 re-splitting Speaker Donut, #458 Voice Orb, #476 Read Aloud, #195 Chapter Rail, and #194 Audio Loop Region", async () => {
    mockEnvironment({ admin: false });
    render(<WebShell />);

    // #459 Dynamic Island renders on TopBar for the live meeting ("Product Weekly Sync")
    const island = await screen.findByTestId("lucian-dynamic-island");
    expect(island).toBeTruthy();
    const islandTap = screen.getByRole("button", { name: /Live meeting: Product Weekly Sync/i });
    expect(islandTap.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(islandTap);
    expect(islandTap.getAttribute("aria-expanded")).toBe("true");
    expect(island.textContent).toContain("Product Weekly Sync");
    // Clicking green open button jumps straight into that live meeting workspace
    fireEvent.click(screen.getByRole("button", { name: "Open live meeting" }));
    expect(await screen.findByRole("heading", { name: "Product Weekly Sync" })).toBeTruthy();

    // Open Smart Search -> #097 Speaker Donut renders and re-splits when excluding a speaker
    const talkTimeBtn = screen.getByRole("button", { name: /Talk time/i });
    if (talkTimeBtn.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(talkTimeBtn);
    }
    const donut = await screen.findByTestId("lucian-speaker-donut");
    expect(donut).toBeTruthy();
    const excludeSarup = screen.getByRole("checkbox", { name: /Exclude Sarup in donut chart/i });
    expect(excludeSarup.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(excludeSarup);
    expect(excludeSarup.getAttribute("aria-checked")).toBe("false");
    // Remaining speaker Linh re-splits to 100%
    expect(donut.textContent).toContain("100%");
    fireEvent.click(excludeSarup);
    expect(excludeSarup.getAttribute("aria-checked")).toBe("true");

    // #194 Audio Loop Region drawer toggles open in bottom player and updates loop range
    fireEvent.click(screen.getByRole("button", { name: "Audio loop region" }));
    const loopEditor = await screen.findByTestId("lucian-audio-loop");
    expect(loopEditor).toBeTruthy();
    const loopStart = screen.getByLabelText("Loop start") as HTMLInputElement;
    fireEvent.change(loopStart, { target: { value: "30" } });
    expect(loopStart.value).toBe("30");
    const loopToggle = loopEditor.querySelector("button.preview") as HTMLButtonElement;
    fireEvent.click(loopToggle);
    expect(loopToggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close audio drawer" }));

    // Transcript tab -> #458 Voice Orb + #476 Read Aloud on Voice Agent reply + #220 Selection Tooltip mounted
    const origPlay = HTMLMediaElement.prototype.play;
    const origPause = HTMLMediaElement.prototype.pause;
    const origCreateUrl = URL.createObjectURL;
    const origRevokeUrl = URL.revokeObjectURL;
    HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    HTMLMediaElement.prototype.pause = vi.fn();
    URL.createObjectURL = vi.fn(() => "blob:vieneu-test");
    URL.revokeObjectURL = vi.fn();
    try {
      fireEvent.click(screen.getByRole("tab", { name: /Transcript/i }));
      expect(await screen.findByTestId("lucian-voice-orb")).toBeTruthy();
      const readAloudBtn = await screen.findByRole("button", { name: "Read aloud" });
      fireEvent.click(readAloudBtn);
      const pauseBtn = await screen.findByRole("button", { name: "Pause read aloud" });
      expect(pauseBtn).toBeTruthy();
      fireEvent.click(pauseBtn);
      expect(screen.getAllByTestId("lucian-selection-tooltip").length).toBeGreaterThanOrEqual(1);
    } finally {
      HTMLMediaElement.prototype.play = origPlay;
      HTMLMediaElement.prototype.pause = origPause;
      URL.createObjectURL = origCreateUrl;
      URL.revokeObjectURL = origRevokeUrl;
    }
  });

  it("supports Lucian Package 3A: #471 Command K button, #046 Command Palette, #039 Sliding Pill Tabs, #014/#093 Task Checklist Celebration, and #439 Skeleton", async () => {
    mockSaveWorkspaceDocument.mockClear();
    mockEnvironment({ admin: false });
    render(<WebShell />);

    // #471 Command K button in TopBar opens #046 Command Palette
    expect(await screen.findByTestId("lucian-command-k")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search meetings and tasks" }));
    const palette = await screen.findByTestId("lucian-command-palette");
    expect(palette).toBeTruthy();

    // Filter #046 palette to "theme" and run via Enter -> toggles dark/light mode and closes
    const searchInput = screen.getByLabelText("Search query");
    fireEvent.change(searchInput, { target: { value: "light / dark" } });
    fireEvent.keyDown(searchInput, { key: "Enter" });
    await waitFor(() => {
      expect(screen.queryByTestId("lucian-command-palette")).toBeNull();
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    // Restore dark mode via TopBar toggle
    fireEvent.click(screen.getByRole("button", { name: /Switch to dark mode/i }));

    // #039 Sliding pill tabs on Home support arrow-key switching
    expect(screen.getByTestId("lucian-sliding-tabs")).toBeTruthy();
    const recentTab = screen.getByRole("tab", { name: /Recent/i });
    fireEvent.keyDown(recentTab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: /Upcoming/i }).getAttribute("aria-selected")).toBe("true");

    // Open Tasks -> #014 checklist + #093 celebration when checking off the only open task
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    const checklist = await screen.findByTestId("lucian-task-checklist");
    expect(checklist).toBeTruthy();
    const toggleBtn = await screen.findByRole("checkbox", { name: /Mark "Ship User UI" as done/i });
    fireEvent.click(toggleBtn);
    await waitFor(() => {
      expect(mockSaveWorkspaceDocument).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByTestId("lucian-task-celebration")).toBeTruthy();
  });

  it("reads and updates task entities in the selected shared workspace", async () => {
    const { listWorkspaceTree, readWorkspaceFile, readWorkspaceDocument } = await import("../../surfaces/workspaceApi");
    mockSaveWorkspaceDocument.mockClear();
    mockEnvironment({ admin: false });
    render(<WebShell />);
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    await screen.findByRole("option", { name: "eng-syncs" });
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "eng-syncs" } });

    const path = "kg/entities/task/follow-up.md";
    const toggle = await screen.findByRole("checkbox", { name: /Mark "Ship User UI" as done/i });
    expect(listWorkspaceTree).toHaveBeenCalledWith({ slug: "eng-syncs" });
    expect(readWorkspaceFile).toHaveBeenCalledWith(path, { slug: "eng-syncs" });
    fireEvent.click(toggle);
    await waitFor(() => expect(mockSaveWorkspaceDocument).toHaveBeenCalledWith(expect.objectContaining({
      path, slug: "eng-syncs", expected_sha256: "sha-task-1",
    })));
    expect(readWorkspaceDocument).toHaveBeenCalledWith(path, { slug: "eng-syncs" });
  });

  it("renders Lucian Package 3B on AuthGate pre-login Landing: #201 Automation Flow, #214 Bento Grid, #228 Cursor Glow Grid, and #211 Glow CTA", async () => {
    window.localStorage.removeItem("tina.landing.lang");
    vi.mocked(signIn).mockClear();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return new Response("{}", { status: 401 });
      if (url.includes("/api/auth/providers")) {
        return new Response(JSON.stringify({ google: { id: "google" }, microsoft: { id: "microsoft" } }), { status: 200 });
      }
      if (url.includes("/api/auth/instance")) {
        return new Response(JSON.stringify({ admin_exists: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    render(<AuthGate><div>App</div></AuthGate>);
    expect(await screen.findByTestId("lucian-automation-flow")).toBeTruthy();
    const kgCard = screen.getByTestId("landing-knowledge-graph");
    expect(kgCard).toBeTruthy();
    expect(kgCard.getAttribute("data-selected-node")).toBe("jane");
    expect(screen.getByTestId("lucian-bento-grid")).toBeTruthy();
    expect(screen.getByTestId("lucian-cursor-glow-grid")).toBeTruthy();
    expect(screen.getByTestId("lucian-glow-cta")).toBeTruthy();

    // Run #201 pipeline flow button works cleanly without throwing
    fireEvent.click(screen.getByRole("button", { name: /Chạy thử/i }));
    expect(screen.getByRole("button", { name: /Đang chạy/i })).toBeTruthy();

    // Interactive Knowledge Graph card supports focus cycling, zoom, drag/pan, and reset
    fireEvent.click(screen.getByRole("button", { name: /Đổi tiêu điểm/i }));
    expect(kgCard.getAttribute("data-selected-node")).toBe("acme");

    const zoomBefore = screen.getByTestId("landing-kg-zoom").textContent;
    fireEvent.click(screen.getByRole("button", { name: "Phóng to đồ thị" }));
    expect(screen.getByTestId("landing-kg-zoom").textContent).not.toBe(zoomBefore);

    const canvas = screen.getByRole("img", { name: /Đồ thị tri thức tương tác TINA/i });
    fireEvent.pointerDown(canvas, { clientX: 120, clientY: 120, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 170, clientY: 150, pointerId: 1 });
    fireEvent.pointerUp(canvas, { clientX: 170, clientY: 150, pointerId: 1 });

    fireEvent.click(screen.getByRole("button", { name: "Đặt lại vị trí đồ thị tri thức" }));
    expect(kgCard.getAttribute("data-selected-node")).toBe("jane");
  });

  it("shows MeetTINA Extension under Settings in Account menu: downloads zip + opens modal by default, or links to Chrome Web Store when configured", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    mockEnvironment({ admin: true });
    render(<WebShell />);

    await screen.findByText("Sarup");
    fireEvent.click(screen.getByRole("button", { name: "Workspace account" }));

    const menu = screen.getByRole("menu", { name: "Account menu" });
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent?.trim());
    expect(items).toEqual(["Settings", "MeetTINA Extension", "Open TINA Terminal", "Log out"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "MeetTINA Extension" }));
    expect(clickSpy).toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Install MeetTINA Extension" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Install MeetTINA Extension" })).toBeNull();
    clickSpy.mockRestore();

    cleanup();
    const storeUrl = "https://chromewebstore.google.com/detail/meettina/fcogeajjhhcadbnamadikkefdfmaaiil";
    mockEnvironment({ admin: false, extensionStoreUrl: storeUrl });
    render(<WebShell />);

    await screen.findByText("Sarup");
    fireEvent.click(screen.getByRole("button", { name: "Workspace account" }));
    const storeLink = await screen.findByRole("menuitem", { name: "MeetTINA Extension" });
    expect(storeLink.tagName).toBe("A");
    expect(storeLink.getAttribute("href")).toBe(storeUrl);
    expect(storeLink.getAttribute("target")).toBe("_blank");
  });
});
