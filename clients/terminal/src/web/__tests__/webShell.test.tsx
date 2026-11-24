/** Behavioral tests for the Dual-Shell Production User UI (`src/web/`), `/terminal` route helpers,
 *  upgraded `AuthGate`, Personal/Team `SettingsView`, `SpeakerTalkTime`, Live Assist in
 *  `MeetingDetailView`, Meetings Notebook (`meetingsFilter`, date grouping, multi-filter, rename/•••,
 *  split-button Capture ▾), Ask Tina (MCP Tool Approval, Copy/Share, chat search), and Dev/Admin gating. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import {
  isTerminalOwnedPath,
  terminalMeetingIdFromPath,
  terminalMeetingPath,
} from "../../app/meetingRoute";
import { signIn } from "next-auth/react";
import { AuthGate } from "../../app/AuthGate";
import { WebShell } from "../WebApp";
import { computeSpeakerStats } from "../SpeakerTalkTime";
import {
  EMPTY_MEETING_FILTERS,
  groupMeetingsByDate,
  matchesMeetingFilters,
  meetingDurationMins,
} from "../meetingsFilter";
import type { ChatStreamCallbacks } from "../../surfaces/chatStream";
import type { MeetingMock } from "../../surfaces/meetingModel";

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
  liveMeetingsNow: () => [],
  getLiveMeeting: () => undefined,
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

vi.mock("../../surfaces/workspaceApi", async () => {
  const actual = await vi.importActual<typeof import("../../surfaces/workspaceApi")>("../../surfaces/workspaceApi");
  return {
    ...actual,
    listWorkspaceTree: vi.fn().mockResolvedValue(["kg/entities/task/follow-up.md"]),
    readWorkspaceFile: vi.fn().mockResolvedValue("---\ntitle: Ship User UI\nstatus: draft\n---\nReview rollout plan."),
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

    // Switch header language toggle to EN
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
    expect(await screen.findByText("01 · TRẢI NGHIỆM TRONG PHÒNG HỌP")).toBeTruthy();
    expect(screen.getByText("02 · TINA CHROME EXTENSION")).toBeTruthy();
    expect(screen.getAllByText("TINA Agent").length).toBeGreaterThan(0);

    // Interactive Hero scene responds to "Gọi “Tina ơi”"
    fireEvent.click(screen.getByRole("button", { name: /Gọi “Tina ơi”/i }));
    expect(screen.getByText(/Tuần trước nhóm chốt 2 mục/i)).toBeTruthy();

    // Interactive Chrome Extension preview tabs work
    fireEvent.click(screen.getByRole("tab", { name: /Bắt kịp 60s/i }));
    expect(screen.getByText(/Cửa sổ 09:40:02/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: /Ask TINA/i }));
    fireEvent.click(screen.getByRole("button", { name: /Lưu vào Wiki/i }));
    expect(screen.getByText(/Đã lưu vào Wiki/i)).toBeTruthy();

    // Google OAuth sign-in triggers NextAuth
    fireEvent.click(screen.getByRole("button", { name: /Tiếp tục với Google/i }));
    expect(signIn).toHaveBeenCalledWith("google", expect.objectContaining({ callbackUrl: expect.any(String) }));
  });
});

describe("WebShell production UI (Option A & Option B)", () => {
  const origFetch = globalThis.fetch;

  function mockEnvironment({
    admin,
    liveAssistState = { configured: false, enabled: false, can_configure: true, readonly: false, revision: 0, items: [] },
  }: {
    admin: boolean;
    liveAssistState?: Record<string, unknown>;
  }) {
    let currentState = { ...liveAssistState };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) {
        return new Response(JSON.stringify({ user: { name: "Sarup Banskota", email: "sarup@tina.local" } }), { status: 200 });
      }
      if (url.includes("/api/admin/me")) {
        return new Response(admin ? JSON.stringify({ ok: true }) : "{}", { status: admin ? 200 : 404 });
      }
      if (url.includes("/api/sessions")) {
        return new Response(
          JSON.stringify({
            sessions: [
              { session: "sess-alpha", title: "Q4 Rollout Checklist", last_active: TODAY_ISO },
              { session: "sess-beta", title: "Pricing Review", last_active: YESTERDAY_START },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/chat/approval") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/api/meetings/") && url.includes("/annotate") && init?.method === "POST") {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
    expect((await screen.findAllByText("Live now")).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Yesterday")).toBeTruthy();

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

    // Send a prompt -> renders Tool Approval card + Copy/Share buttons
    const composer = screen.getByLabelText("Message Ask Tina");
    fireEvent.change(composer, { target: { value: "Schedule follow-up review" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

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
    expect(await screen.findByText("Linh")).toBeTruthy();
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
    expect(await screen.findByTestId("real-models-section-global")).toBeTruthy();
  });
});
