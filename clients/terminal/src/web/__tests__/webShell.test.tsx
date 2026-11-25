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

  it("renders OAuth providers and first-run admin claim messaging", async () => {
    render(<AuthGate><div>App</div></AuthGate>);
    expect(await screen.findByText("Set up your instance")).toBeTruthy();
    expect(screen.getByText("First sign-in = administrator")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue with Google/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Continue with Microsoft/i })).toBeTruthy();
  });

  it("renders editorial TINA landing sections and triggers Google OAuth when admin exists", async () => {
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
    expect(await screen.findByText("01 · HOW IT WORKS")).toBeTruthy();
    expect(screen.getByText("02 · LIVE TRANSCRIPT & VOICE")).toBeTruthy();
    expect(screen.getAllByText("TINA Agent").length).toBeGreaterThan(0);

    // Interactive hero illustration responds to clicking "Gọi “Tina ơi”"
    fireEvent.click(screen.getByRole("button", { name: /Gọi “Tina ơi”/i }));
    expect(screen.getByText(/Đã ghi 2 action items/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Continue with Google/i }));
    expect(signIn).toHaveBeenCalledWith("google", expect.objectContaining({ callbackUrl: expect.any(String) }));
  });
});

describe("WebShell production UI (Option A & Option B)", () => {
  const origFetch = globalThis.fetch;

  function mockEnvironment({
    admin,
    workspacePilot,
    liveAssistState = { configured: false, enabled: false, can_configure: true, readonly: false, revision: 0, items: [] },
  }: {
    admin: boolean;
    workspacePilot?: boolean;
    liveAssistState?: Record<string, unknown>;
  }) {
    let currentState = { ...liveAssistState };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) {
        return new Response(JSON.stringify({
          user: { name: "Sarup Banskota", email: "sarup@tina.local" },
          ...(typeof workspacePilot === "boolean" ? { workspacePilot } : {}),
        }), { status: 200 });
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
    expect((await screen.findAllByText("Linh")).length).toBeGreaterThanOrEqual(1);
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

    // Toggle Smart Search via bottom player Talk time button -> click speaker filters Transcript
    const talkTimeBtn = screen.getByRole("button", { name: /Talk time/i });
    if (talkTimeBtn.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(talkTimeBtn);
    }
    expect(await screen.findByText("Smart Search")).toBeTruthy();
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

  it("renders redesigned Agent Model Provider & Auth cards, ChatGPT OAuth disconnect, API key reveal, Antigravity guard, and connection test", async () => {
    window.history.replaceState({}, "", "/?nav=settings&settingsWorkspace=personal&settingsSection=models");
    const fetchMock = mockEnvironment({ admin: false });
    render(<WebShell />);

    // ChatGPT Plan OAuth card displays connected identity & real SVG logos render for all providers
    expect(await screen.findByText("ChatGPT Plan Connected")).toBeTruthy();
    expect(screen.getByText("nghixa021@gmail.com")).toBeTruthy();
    const logoSrcs = Array.from(document.querySelectorAll("img.tina-web-provider-logo")).map((el) =>
      el.getAttribute("src"),
    );
    expect(logoSrcs).toContain("/provider-logos/openai.svg");
    expect(logoSrcs).toContain("/provider-logos/claude.svg");
    expect(logoSrcs).toContain("/provider-logos/gemini.svg");
    expect(logoSrcs).toContain("/provider-logos/deepseek.svg");
    expect(logoSrcs).toContain("/provider-logos/groq.svg");
    expect(logoSrcs).toContain("/provider-logos/aws.svg");
    expect(logoSrcs).toContain("/provider-logos/antigravity.svg");

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

    // Switch provider card to OpenAI API -> shows secret reveal toggle & saves via PUT /api/user/models
    fireEvent.click(screen.getByRole("radio", { name: /OpenAI API/i }));
    const keyInput = screen.getByLabelText("Credential") as HTMLInputElement;
    expect(keyInput.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Show API key" }));
    expect(keyInput.type).toBe("text");
    fireEvent.change(keyInput, { target: { value: "sk-test-12345" } });

    const saveBtn = screen.getByRole("button", { name: /Save changes/i });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/user/models",
        expect.objectContaining({ method: "PUT" }),
      );
    });

    // Switch to Antigravity CLI -> Save stays disabled until risk checkbox is acknowledged
    fireEvent.click(screen.getByRole("radio", { name: /Antigravity CLI/i }));
    expect(screen.getByText(/Account suspension risk/i)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /I have read this warning/i }));
    expect((screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("unlocks Ask Tina in WebShell for authorized workspace-pilot users and hides it for non-pilot users", async () => {
    vi.stubEnv("NEXT_PUBLIC_TERMINAL_MODE", "workspace-pilot");
    try {
      mockEnvironment({ admin: false, workspacePilot: true });
      const { unmount } = render(<WebShell />);
      expect(await screen.findByRole("button", { name: "Ask Tina" })).toBeTruthy();
      unmount();

      mockEnvironment({ admin: false, workspacePilot: false });
      render(<WebShell />);
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Ask Tina" })).toBeNull();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
