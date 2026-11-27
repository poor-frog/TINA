/** Behavioral tests for MeetingPrepWorkspace (Pre-meeting Brief Studio) and
 *  HomeView/MeetingsView "No brief yet" / "Brief ready" indicators. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MeetingPrepWorkspace } from "../MeetingPrepWorkspace";
import { HomeView } from "../HomeView";
import { MeetingsView } from "../MeetingsView";
import type { ChatStreamCallbacks } from "../../surfaces/chatStream";
import type { MeetingMock } from "../../surfaces/meetingModel";

const mockReadActiveSet = vi.fn();
const mockListWorkspaceTree = vi.fn();
const mockReadWorkspaceFile = vi.fn();
const mockListSharedMemberships = vi.fn();
const mockCreateSharedWorkspace = vi.fn();
const mockMintInvite = vi.fn();
const mockReadAttachedWorkspaces = vi.fn();

vi.mock("../../surfaces/workspaceApi", async () => {
  const actual = await vi.importActual<typeof import("../../surfaces/workspaceApi")>("../../surfaces/workspaceApi");
  return {
    ...actual,
    readActiveSet: (...args: unknown[]) => mockReadActiveSet(...args),
    listWorkspaceTree: (...args: unknown[]) => mockListWorkspaceTree(...args),
    readWorkspaceFile: (...args: unknown[]) => mockReadWorkspaceFile(...args),
    listSharedMemberships: (...args: unknown[]) => mockListSharedMemberships(...args),
    createSharedWorkspace: (...args: unknown[]) => mockCreateSharedWorkspace(...args),
    mintInvite: (...args: unknown[]) => mockMintInvite(...args),
    readAttachedWorkspaces: (...args: unknown[]) => mockReadAttachedWorkspaces(...args),
  };
});

const mockUpdatePlannedMeeting = vi.fn();
const mockDeletePlannedMeeting = vi.fn();
vi.mock("../../surfaces/plannedApi", () => ({
  updatePlannedMeeting: (...args: unknown[]) => mockUpdatePlannedMeeting(...args),
  deletePlannedMeeting: (...args: unknown[]) => mockDeletePlannedMeeting(...args),
}));

const mockSessionHistory = vi.fn();
vi.mock("../../surfaces/sessionsApi", () => ({
  sessionHistory: (...args: unknown[]) => mockSessionHistory(...args),
}));

const mockStreamChatTurn = vi.fn();
vi.mock("../../surfaces/chatStream", () => ({
  streamChatTurn: (...args: unknown[]) => mockStreamChatTurn(...args),
}));

vi.mock("../../surfaces/liveMeetings", () => ({
  refreshMeetings: vi.fn(),
  seedLiveMeetingFromResponse: () => undefined,
}));

vi.mock("../../surfaces/liveMeetingStateApi", () => ({
  EMPTY_LIVE_ASSIST_DRAFT: { goal: null, agendaItems: [], agendaEdits: [] },
  mergeLiveMeetingState: (_prev: unknown, next: unknown) => next,
  readAllLiveMeetingState: vi.fn().mockResolvedValue({ configured: false, goal: null, items: [] }),
  readPlannedLiveAssistDraft: () => ({ goal: null, agendaItems: [], agendaEdits: [] }),
  writePlannedLiveAssistDraft: vi.fn(),
  postLiveMeetingStateAction: vi.fn().mockResolvedValue({ configured: true, goal: null, items: [] }),
}));

const UPCOMING_MEETING: MeetingMock = {
  id: "501",
  native_id: "abc-defg-hij",
  title: "Q4 Architecture Review",
  title_custom: "Q4 Architecture Review",
  when: "Tomorrow · 10:00 AM",
  status: "past",
  live_status: "scheduled",
  scheduled_at: "2026-11-28T03:00:00Z",
  meeting_url: "https://meet.google.com/abc-defg-hij",
  auto_join: true,
  platform: "Google Meet",
  attendees: [
    { email: "quang@tina.ai", name: "Quang Nguyen", partstat: "accepted" },
    { email: "jane@acme.io", name: "Jane Liu", partstat: "tentative" },
  ],
  participants: [],
  mentioned: [],
  actions: [],
  transcript: [],
  insights: [],
};

describe("MeetingPrepWorkspace & Brief status badges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadActiveSet.mockResolvedValue({
      subject: "1",
      active: [
        { slug: "my-space", role: "private", repo: null, ref: null, path: "/workspaces/1", write: true, primary: true },
      ],
    });
    mockListWorkspaceTree.mockResolvedValue([]);
    mockReadWorkspaceFile.mockResolvedValue("");
    mockListSharedMemberships.mockResolvedValue([{ workspace_id: "eng-syncs-a1b2", role: "owner" }]);
    mockCreateSharedWorkspace.mockResolvedValue({ workspace_id: "q4-arch-f9e0", role: "owner", name: "Q4 Architecture Review" });
    mockMintInvite.mockResolvedValue({
      id: "inv-1",
      token: "tok_brief_99",
      role: "contributor",
      workspace_id: "eng-syncs-a1b2",
      expires_at: "2026-12-05T00:00:00Z",
      max_uses: 50,
      mode: "open",
    });
    mockReadAttachedWorkspaces.mockResolvedValue({ active: "seed", slots: {} });
    mockUpdatePlannedMeeting.mockResolvedValue({});
    mockDeletePlannedMeeting.mockResolvedValue({});
    mockSessionHistory.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders private No brief yet state, starts canonical meetingPrep brief chat, and renders live brief after commit", async () => {
    const onOpenKnowledgeDoc = vi.fn();
    let briefWritten = false;
    mockListWorkspaceTree.mockImplementation(async () =>
      briefWritten ? ["kg/entities/meeting/brief-abc-defg-hij.md"] : [],
    );
    mockReadWorkspaceFile.mockImplementation(async (path: string) =>
      briefWritten && path === "kg/entities/meeting/brief-abc-defg-hij.md"
        ? "# Q4 Architecture Review Brief\n\n## Attendees\n- **Jane Liu** — VP Engineering at Acme"
        : "",
    );

    mockStreamChatTurn.mockImplementation(async (req: unknown, cb: ChatStreamCallbacks) => {
      cb.onStarting();
      cb.onTool?.("Write");
      briefWritten = true;
      cb.onCommit?.("abc1234");
      cb.onReply?.("I drafted your private brief with Jane Liu's background and a 3-point agenda.");
      return { sawVisibleOutput: true, terminal: true, aborted: false, req };
    });

    render(
      <MeetingPrepWorkspace
        meeting={UPCOMING_MEETING}
        meetingsOnly={false}
        firstName="Quang"
        onBack={vi.fn()}
        onOpenKnowledgeDoc={onOpenKnowledgeDoc}
        onUpdated={vi.fn()}
      />,
    );

    expect(await screen.findByText("No brief yet")).toBeTruthy();
    expect(screen.getByText("Quang Nguyen")).toBeTruthy();
    expect(screen.getByText("Jane Liu")).toBeTruthy();
    expect(screen.getByLabelText("Bind an existing workspace")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Start brief chat/i }));

    await waitFor(() => {
      expect(mockStreamChatTurn).toHaveBeenCalledTimes(1);
    });

    const [sentReq] = mockStreamChatTurn.mock.calls[0] as [
      {
        prompt: string;
        session: string;
        context: { surface: { tab: { kind: string } }; focus: Record<string, unknown> };
      },
    ];
    expect(sentReq.session).toBe("brief-501");
    expect(sentReq.context.surface.tab.kind).toBe("meetingPrep");
    expect(sentReq.context.focus).toMatchObject({
      kind: "meeting",
      meeting_id: "501",
      native_id: "abc-defg-hij",
      scheduled_at: "2026-11-28T03:00:00Z",
    });
    expect(sentReq.prompt).toContain("kg/entities/meeting/brief-abc-defg-hij.md");

    // Live brief renders immediately on commit
    expect(await screen.findByText("Your brief for this meeting")).toBeTruthy();
    expect(screen.getByText(/VP Engineering at Acme/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Open in Knowledge/i }));
    expect(onOpenKnowledgeDoc).toHaveBeenCalledWith("kg/entities/meeting/brief-abc-defg-hij.md", "my-space");
  });

  it("ignores seeded README stub on a bound workspace, supports team brief & invite link sharing", async () => {
    const boundMeeting: MeetingMock = { ...UPCOMING_MEETING, workspace_id: "eng-syncs-a1b2" };
    mockReadWorkspaceFile.mockResolvedValueOnce("This is your **Personal workspace** — seeded stub.");

    const { rerender } = render(
      <MeetingPrepWorkspace
        meeting={boundMeeting}
        meetingsOnly={false}
        firstName="Quang"
        onBack={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    expect(await screen.findByText("No brief yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Draft the brief/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Share with attendees/i }));
    const inviteInput = (await screen.findByLabelText("Workspace invite link")) as HTMLInputElement;
    expect(inviteInput.value).toContain("/?invite=tok_brief_99");

    // When README is populated with a real team brief, clicking Check again loads and renders it
    mockReadWorkspaceFile.mockResolvedValue("# Team Brief\n\nAligned on launch timeline.");
    fireEvent.click(screen.getByRole("button", { name: /Check again/i }));
    expect(await screen.findByText("Team brief")).toBeTruthy();
    expect(screen.getByText(/Aligned on launch timeline/i)).toBeTruthy();
  });

  it("hides Brief stage and Brief Assistant chat when meetingsOnly is enabled", () => {
    render(
      <MeetingPrepWorkspace
        meeting={UPCOMING_MEETING}
        meetingsOnly={true}
        firstName="Quang"
        onBack={vi.fn()}
        onUpdated={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("meeting-brief-stage")).toBeNull();
    expect(screen.queryByLabelText("Brief Assistant chat")).toBeNull();
    expect(screen.getByRole("button", { name: /Send bot now/i })).toBeTruthy();
  });

  it("shows 'No brief yet' and 'Brief ready' badges on upcoming rows in HomeView and MeetingsView", async () => {
    const briefedMeeting: MeetingMock = {
      ...UPCOMING_MEETING,
      id: "502",
      native_id: "xyz-ready-123",
      title: "Customer Kickoff",
      title_custom: "Customer Kickoff",
    };
    mockListWorkspaceTree.mockResolvedValue(["kg/entities/meeting/brief-xyz-ready-123.md"]);

    const { unmount } = render(
      <HomeView
        firstName="Quang"
        userName="Quang Nguyen"
        meetings={[UPCOMING_MEETING, briefedMeeting]}
        meetingsOnly={false}
        onOpenMeeting={vi.fn()}
        onAskTina={vi.fn()}
        onNavigate={vi.fn()}
        onOpenCapture={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: /Upcoming/i }));
    expect(await screen.findByText("No brief yet")).toBeTruthy();
    expect(await screen.findByText("Brief ready")).toBeTruthy();
    expect(screen.getByText(/1 needs brief/i)).toBeTruthy();

    unmount();

    render(
      <MeetingsView
        meetings={[UPCOMING_MEETING, briefedMeeting]}
        userName="Quang Nguyen"
        wsConnected={true}
        meetingsOnly={false}
        onOpenMeeting={vi.fn()}
        onOpenCapture={vi.fn()}
      />,
    );

    expect(await screen.findByText("No brief yet")).toBeTruthy();
    expect(await screen.findByText("Brief ready")).toBeTruthy();
  });
});
