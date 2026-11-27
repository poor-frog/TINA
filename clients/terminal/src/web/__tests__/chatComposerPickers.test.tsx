/** Unit and integration tests for `@` mention catalog/filtering/context grounding,
 *  `/` slash commands, composer file attachments, and inline drawer/sidepanel parity. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import {
  compileMentionContext,
  detectMentionAtCursor,
  filterMentionTargets,
  normalizeSearchText,
} from "../lucian/LucianMentionPicker";
import {
  compileSlashPrompt,
  detectSlashAtStart,
  filterSlashCommands,
} from "../lucian/LucianSlashPicker";
import { buildMentionCatalog, formatAttachmentsPrompt } from "../chatComposerUtils";
import type { MeetingMock } from "../../surfaces/meetingModel";
import type { ChatStreamCallbacks } from "../../surfaces/chatStream";

const mockStreamChatTurn = vi.fn();
const mockListWorkspaceTree = vi.fn();
const mockReadActiveSet = vi.fn();
const mockSaveWorkspaceDocument = vi.fn();
const mockListSessions = vi.fn();

vi.mock("../../surfaces/chatStream", () => ({
  streamChatTurn: (...args: unknown[]) => mockStreamChatTurn(...args),
}));

vi.mock("../../surfaces/workspaceApi", () => ({
  listWorkspaceTree: (...args: unknown[]) => mockListWorkspaceTree(...args),
  readActiveSet: (...args: unknown[]) => mockReadActiveSet(...args),
  saveWorkspaceDocument: (...args: unknown[]) => mockSaveWorkspaceDocument(...args),
}));

vi.mock("../../surfaces/sessionsApi", () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  sessionHistory: vi.fn().mockResolvedValue({ turns: [] }),
  deleteSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../surfaces/MeetingKnowledge", () => ({
  MeetingKnowledge: () => <div data-testid="meeting-knowledge-stub" />,
}));

import { AskTinaView } from "../AskTinaView";
import { KnowledgeCopilotDrawer } from "../KnowledgeCopilotDrawer";
import { MeetingSidePanel } from "../MeetingSidePanel";

const SAMPLE_MEETINGS: MeetingMock[] = [
  {
    id: "m-1",
    native_id: "abc-defg-hij",
    title: "Họp dự án Định kỳ",
    title_custom: "Họp dự án Định kỳ",
    when: "Today · 10:00",
    status: "past",
    live_status: "completed",
    platform: "Google Meet",
    participants: [
      { name: "Quang Thanh", role: "Host", initials: "QT" },
      { name: "Linh Nguyễn", role: "PM", initials: "LN" },
    ],
    attendees: [{ name: "Minh Trần", email: "minh@example.com" }],
    mentioned: [],
    actions: [],
    transcript: [],
    insights: [],
  },
];

const SAMPLE_DOCS = [
  "notes/architecture.md",
  "uploads/q3-budget.pdf",
  "kg/entities/task/fix-auth.md",
  "kg/entities/person/quang-thanh.md",
  ".git/HEAD",
];

describe("chatComposerPickers — pure @ mention & / slash logic", () => {
  it("normalizes Vietnamese diacritics and ranks kind:query filters cleanly", () => {
    expect(normalizeSearchText("Họp dự án Định kỳ")).toBe("hop du an dinh ky");

    const catalog = buildMentionCatalog({
      meetings: SAMPLE_MEETINGS,
      spaces: [{ slug: "product-ops", name: "Product Ops" }],
      workspaceDocs: SAMPLE_DOCS,
    });

    // Does not include .git internals
    expect(catalog.some((t) => t.docPath === ".git/HEAD")).toBe(false);
    // Extracts real participant/attendee names (never "[object Object]")
    expect(catalog.some((t) => t.label.includes("[object"))).toBe(false);
    expect(catalog.some((t) => t.kind === "person" && t.label === "Linh Nguyễn")).toBe(true);
    expect(catalog.some((t) => t.kind === "person" && t.personEmail === "minh@example.com")).toBe(true);
    // Includes non-markdown PDF file
    expect(catalog.some((t) => t.kind === "file" && t.docPath === "uploads/q3-budget.pdf")).toBe(true);

    // Diacritic-insensitive search
    const hopHits = filterMentionTargets(catalog, "hop du an");
    expect(hopHits[0]?.kind).toBe("meeting");
    expect(hopHits[0]?.meetingId).toBe("m-1");

    // Prefix filters
    const pageHits = filterMentionTargets(catalog, "page:arch");
    expect(pageHits.map((t) => t.docPath)).toEqual(["notes/architecture.md"]);

    const fileHits = filterMentionTargets(catalog, "file:pdf");
    expect(fileHits.map((t) => t.docPath)).toEqual(["uploads/q3-budget.pdf"]);

    const taskHits = filterMentionTargets(catalog, "task:fix");
    expect(taskHits[0]?.docPath).toBe("kg/entities/task/fix-auth.md");

    const schedHits = filterMentionTargets(catalog, "lich:");
    expect(schedHits.map((t) => t.kind)).toEqual(["schedule"]);
  });

  it("compiles @Page, @Space, @Person(KG), and @Today into real backend grounding", () => {
    const catalog = buildMentionCatalog({
      meetings: SAMPLE_MEETINGS,
      spaces: [{ slug: "product-ops", name: "Product Ops" }],
      workspaceDocs: SAMPLE_DOCS,
    });

    const page = catalog.find((t) => t.docPath === "notes/architecture.md")!;
    const space = catalog.find((t) => t.spaceSlug === "product-ops")!;
    const personKg = catalog.find((t) => t.docPath === "kg/entities/person/quang-thanh.md")!;
    const today = catalog.find((t) => t.kind === "schedule")!;

    const compiled = compileMentionContext([page, space, personKg, today]);
    expect(compiled.includeSchedule).toBe(true);
    expect(compiled.fallbackFocus).toEqual({ kind: "file", ref: "@file:notes/architecture.md" });
    expect(compiled.contextBlock).toContain("@file:notes/architecture.md");
    expect(compiled.contextBlock).toContain("slug: product-ops");
    expect(compiled.contextBlock).toContain("@file:kg/entities/person/quang-thanh.md");
    expect(compiled.contextBlock).toContain("Schedule: include today's");

    const spaceOnly = compileMentionContext([space]);
    expect(spaceOnly.fallbackFocus).toEqual({ kind: "workspace", slug: "product-ops" });

    expect(detectMentionAtCursor("Check @page:arch", 16)).toEqual({ anchor: 6, query: "page:arch" });
    expect(formatAttachmentsPrompt([{ name: "spec.pdf", path: "uploads/spec.pdf" }])).toContain(
      "- @file:uploads/spec.pdf",
    );
  });

  it("detects, filters, and compiles all / slash commands including /research and instant actions", () => {
    expect(detectSlashAtStart("/res", 4)).toEqual({ anchor: 0, query: "res" });
    expect(detectSlashAtStart("hello /res", 10)).toBeNull();

    expect(filterSlashCommands("nghien").map((c) => c.id)).toEqual(["research"]);
    expect(filterSlashCommands("export").map((c) => c.id)).toEqual(["save"]);
    expect(filterSlashCommands("luu").map((c) => c.id)).toContain("save");
    expect(filterSlashCommands("", ["recap", "save"]).map((c) => c.id)).toEqual(["recap", "save"]);

    expect(compileSlashPrompt("/research RAG benchmark", { tz: "Asia/Ho_Chi_Minh" })).toEqual({
      kind: "prompt",
      wirePrompt: "/research RAG benchmark",
      displayPrompt: "/research RAG benchmark",
      research: true,
    });
    expect(compileSlashPrompt("/research", { tz: "UTC" }).kind).toBe("error");
    expect(compileSlashPrompt("/routine", { tz: "UTC" }).kind).toBe("error");

    const routine = compileSlashPrompt("/routine Mỗi sáng 9h tổng hợp việc", { tz: "Asia/Ho_Chi_Minh" });
    expect(routine.kind).toBe("prompt");
    if (routine.kind === "prompt") {
      expect(routine.wirePrompt).toContain("Asia/Ho_Chi_Minh");
      expect(routine.research).toBe(false);
    }

    const recap = compileSlashPrompt("/recap tập trung vào quyết định", {
      tz: "UTC",
      meetingTitle: "Product Weekly",
    });
    expect(recap.kind).toBe("prompt");
    if (recap.kind === "prompt") {
      expect(recap.wirePrompt).toContain("Product Weekly");
      expect(recap.wirePrompt).toContain("tập trung vào quyết định");
    }

    expect(compileSlashPrompt("/schedule", { tz: "UTC" })).toEqual({ kind: "instant", commandId: "schedule" });
    expect(compileSlashPrompt("/save", { tz: "UTC" })).toEqual({ kind: "instant", commandId: "save" });
    expect(compileSlashPrompt("/new", { tz: "UTC" })).toEqual({ kind: "instant", commandId: "new" });
  });
});

describe("chatComposerPickers — component integration", () => {
  beforeEach(() => {
    mockStreamChatTurn.mockReset();
    mockListWorkspaceTree.mockReset().mockResolvedValue(SAMPLE_DOCS);
    mockReadActiveSet.mockReset().mockResolvedValue({
      active: [{ slug: "product-ops", name: "Product Ops" }],
    });
    mockSaveWorkspaceDocument.mockReset().mockResolvedValue({ ok: true });
    mockListSessions.mockReset().mockResolvedValue([]);
    mockStreamChatTurn.mockImplementation(
      async (_payload: unknown, callbacks: ChatStreamCallbacks) => {
        callbacks.onReply?.("Đây là phân tích chi tiết từ Tina.");
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("AskTinaView sends @Page as real @file grounding, supports /research, /schedule, /save, and file upload", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ files: [{ name: "spec.pdf", path: "uploads/spec.pdf" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(
      <AskTinaView
        meetings={SAMPLE_MEETINGS}
        initialPrompt={null}
        onConsumeInitialPrompt={() => undefined}
      />,
    );

    await waitFor(() => expect(mockListWorkspaceTree).toHaveBeenCalled());

    const textarea = screen.getByLabelText("Message Ask Tina") as HTMLTextAreaElement;

    // 1. Mention a workspace page via `@page:arch` and submit
    fireEvent.change(textarea, { target: { value: "Review @page:arch", selectionStart: 17 } });
    const popover = await screen.findByTestId("lucian-mention-popover");
    expect(popover.className).toContain("is-open");

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect((textarea as HTMLTextAreaElement).value).toContain("@Architecture ");

    // Attach a file via hidden file input
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    const pdfFile = new File(["%PDF-1.4"], "spec.pdf", { type: "application/pdf" });
    fireEvent.change(fileInput, { target: { files: [pdfFile] } });
    expect(await screen.findByText("spec.pdf")).toBeTruthy();

    fireEvent.submit(textarea.closest("form")!);

    await waitFor(() => expect(mockStreamChatTurn).toHaveBeenCalledTimes(1));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/workspace/upload",
      expect.objectContaining({ method: "POST" }),
    );
    const firstCall = mockStreamChatTurn.mock.calls[0]?.[0] as {
      prompt: string;
      context?: { focus?: { kind: string; ref?: string } };
    };
    expect(firstCall.prompt).toContain("@file:notes/architecture.md");
    expect(firstCall.prompt).toContain("- @file:uploads/spec.pdf");
    expect(firstCall.context?.focus).toEqual({ kind: "file", ref: "@file:notes/architecture.md" });

    // 2. Toggle `/schedule` instant command -> shows Schedule: today chip
    fireEvent.change(textarea, { target: { value: "/schedule", selectionStart: 9 } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.submit(textarea.closest("form")!);
    expect(await screen.findByText(/Schedule: today/i)).toBeTruthy();

    // 3. Run `/research` command -> sets `research: true` and `include: { schedule: true }`
    fireEvent.change(textarea, { target: { value: "/res", selectionStart: 4 } });
    const slashPop = await screen.findByTestId("lucian-slash-popover");
    expect(slashPop.className).toContain("is-open");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect((textarea as HTMLTextAreaElement).value).toBe("/research ");

    fireEvent.change(textarea, { target: { value: "/research So sánh mô hình AI", selectionStart: 27 } });
    fireEvent.submit(textarea.closest("form")!);

    await waitFor(() => expect(mockStreamChatTurn).toHaveBeenCalledTimes(2));
    const secondCall = mockStreamChatTurn.mock.calls[1]?.[0] as {
      research?: boolean;
      context?: { include?: { schedule?: boolean } };
    };
    expect(secondCall.research).toBe(true);
    expect(secondCall.context?.include).toEqual({ schedule: true });

    // 4. Instant `/save` persists last Tina reply into Knowledge
    fireEvent.change(textarea, { target: { value: "/save", selectionStart: 5 } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    fireEvent.submit(textarea.closest("form")!);
    await waitFor(() => expect(mockSaveWorkspaceDocument).toHaveBeenCalledTimes(1));
    expect(mockSaveWorkspaceDocument.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        commit: true,
        content: expect.stringContaining("Đây là phân tích chi tiết từ Tina."),
      }),
    );
  });

  it("KnowledgeCopilotDrawer supports @ mention and /research inside the drawer", async () => {
    const onMutated = vi.fn();
    render(
      <KnowledgeCopilotDrawer
        open
        workspaceName="Product Ops"
        slug="product-ops"
        docPath="notes/architecture.md"
        docTitle="Architecture"
        isReadOnly={false}
        onClose={() => undefined}
        onWorkspaceMutated={onMutated}
      />,
    );

    await waitFor(() => expect(mockListWorkspaceTree).toHaveBeenCalled());
    const textarea = screen.getByRole("combobox", { name: /ask tina a question/i });

    fireEvent.change(textarea, { target: { value: "/research Deep dive @file:pdf", selectionStart: 29 } });
    const pop = await screen.findByTestId("lucian-mention-popover");
    expect(pop.className).toContain("is-open");
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.submit(textarea.closest("form")!);

    await waitFor(() => expect(mockStreamChatTurn).toHaveBeenCalledTimes(1));
    const payload = mockStreamChatTurn.mock.calls[0]?.[0] as { prompt: string; research?: boolean };
    expect(payload.research).toBe(true);
    expect(payload.prompt).toContain("@file:uploads/q3-budget.pdf");
  });

  it("MeetingSidePanel supports @ mentions (including speakers/docs) and /recap", async () => {
    render(
      <MeetingSidePanel
        meetingId="m-1"
        meeting={SAMPLE_MEETINGS[0]}
        firstName="Quang"
        meetingsOnly={false}
        sideTab="ask"
        onSideTabChange={() => undefined}
        lines={[{ t: "00:01", speaker: "Huy Phạm", text: "Chào cả nhóm" }]}
        processedNotes={[]}
        voiceReplies={[]}
        isLive={false}
        language="vi"
        translationSnapshot={null}
        translationError=""
        onRetryTranslation={() => undefined}
        speakerFilter=""
        questionsOnly={false}
        trackerFilter=""
        onClearSpeaker={() => undefined}
        onClearQuestions={() => undefined}
        onClearTracker={() => undefined}
        playableSegmentIds={new Set()}
        activeSegmentId={null}
        pendingPrompt={null}
        onConsumePendingPrompt={() => undefined}
      />,
    );

    await waitFor(() => expect(mockListWorkspaceTree).toHaveBeenCalled());
    const textarea = screen.getByRole("combobox", { name: /ask tina about this meeting/i });

    // Mention a live speaker with diacritic-insensitive search
    fireEvent.change(textarea, { target: { value: "/recap cho @huy", selectionStart: 15 } });
    const pop = await screen.findByTestId("lucian-mention-popover");
    expect(pop.className).toContain("is-open");
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.submit(textarea.closest("form")!);

    await waitFor(() => expect(mockStreamChatTurn).toHaveBeenCalledTimes(1));
    const payload = mockStreamChatTurn.mock.calls[0]?.[0] as { prompt: string };
    expect(payload.prompt).toContain("Họp dự án Định kỳ");
    expect(payload.prompt).toContain("Person: Huy Phạm");
  });
});
