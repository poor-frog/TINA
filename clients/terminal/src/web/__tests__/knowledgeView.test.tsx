import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, within } from "@testing-library/react";
import { KnowledgeView } from "../KnowledgeView";
import {
  buildNewPageTemplate,
  categorizePath,
  ensureEntityFrontmatterForPath,
  formatYamlScalar,
  friendlyPageTitle,
  parseDocumentClean,
  slugifyTitle,
  stripUploadHash,
  updateCleanDocumentBody,
  updateCleanDocumentTitle,
  visibleHumanMetadata,
} from "../knowledgeFriendly";
import { describeAgentTool, normalizeAgentToolName } from "../AgentActivitySteps";
import {
  buildConstellationGraph,
  computeFitCamera,
  createInitialSimulation,
  hitTestSimNode,
  prewarmSimulation,
} from "../constellationGraph";
import type { ChatStreamCallbacks } from "../../surfaces/chatStream";

const mockStreamChatTurn = vi.fn();

vi.mock("../../ui-kit/MdxDoc", () => ({
  MdxDoc: ({ children }: { children: string }) => <div data-testid="mdx-doc">{children}</div>,
}));

vi.mock("../../surfaces/MeetingKnowledge", () => ({
  MeetingWikiSourceStatus: () => null,
}));

vi.mock("../../surfaces/chatStream", () => ({
  streamChatTurn: (...args: unknown[]) => mockStreamChatTurn(...args),
}));

function mockFetchRoutes(onSaveDocument?: (payload: Record<string, unknown>) => void) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method || "GET").toUpperCase();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/api/workspace/document") && (method === "PUT" || method === "POST")) {
      const payload = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      onSaveDocument?.(payload);
      return json({ path: payload.path, sha256: "f".repeat(64), commit: "1234567890" });
    }
    if (url.includes("/api/workspace/attached")) {
      return json({ active: "seed", slots: { seed: { repo: null, ref: null, name: "Personal" } } });
    }
    if (url.includes("/api/workspace/active")) {
      return json({
        subject: "42",
        active: [{ slug: "seed", repo: null, ref: null, role: "private", path: "/workspaces/42", write: true, primary: true, name: "Personal" }],
      });
    }
    if (url.includes("/api/workspace/shared")) {
      return json({ memberships: [{ workspace_id: "team-alpha", role: "owner" }] });
    }
    if (url.includes("/api/workspace/tree?slug=_global")) {
      return json({ files: ["README.md", "CLAUDE.md", "docs/tina-handbook.md", "mail/follow-up.md"] });
    }
    if (url.includes("/api/workspace/tree?slug=team-alpha")) {
      return json({ files: ["README.md", "wiki/team-notes.md"] });
    }
    if (url.includes("/api/workspace/tree")) {
      return json({
        files: [
          "README.md",
          "CLAUDE.md",
          "kg/entities/person/alice.md",
          "kg/entities/project/tina.md",
          "kg/entities/topic/orphan-topic.md",
          "uploads/0123456789abcdef-Q4-Report.pdf",
        ],
      });
    }
    if (url.includes("/api/workspace/purpose")) {
      return json({ purpose: "Personal notes and meeting decisions" });
    }
    if (url.includes("/api/workspace/document") && url.includes("slug=_global")) {
      return json({
        content: "# TINA Global Knowledge\n\n## Overview\nShared platform guide.\n\n### Architecture\nThree-tier mounts.",
        sha256: "a".repeat(64),
        writable: false,
      });
    }
    if (url.includes("/api/workspace/document") && url.includes("slug=team-alpha")) {
      return json({
        content: "# Team Alpha\n\nShared notes editable by owners and contributors.",
        sha256: "e".repeat(64),
        writable: true,
      });
    }
    if (url.includes("/api/workspace/document") && url.includes("alice.md")) {
      return json({
        content: "---\nid: person/alice\ntype: person\ntitle: Alice Nguyen\ntags:\n  - design\n  - q4\n---\n\n## Role\nWorks on [[TINA]].",
        sha256: "b".repeat(64),
        writable: true,
      });
    }
    if (url.includes("/api/workspace/document")) {
      return json({
        content: "# Personal Wiki\n\n## Architecture\nWelcome to TINA Knowledge Hub.\n\n### Next Steps\nReview [[Alice Nguyen]].",
        sha256: "c".repeat(64),
        writable: true,
      });
    }
    if (url.includes("/api/workspace/file") && url.includes("alice.md")) {
      return json({
        content: "---\nid: person/alice\ntype: person\ntitle: Alice Nguyen\ntags:\n  - design\n---\n\nWorks on [[TINA]].",
      });
    }
    if (url.includes("/api/workspace/file") && url.includes("tina.md")) {
      return json({
        content: "---\nid: project/tina\ntype: project\ntitle: TINA\ntags:\n  - design\n---\n\nLed by [[Alice Nguyen]].",
      });
    }
    if (url.includes("/api/workspace/file") && url.includes("orphan-topic.md")) {
      return json({
        content: "---\nid: topic/orphan\ntype: topic\ntitle: Standalone Topic\n---\n\nNo links yet.",
      });
    }
    if (url.includes("/api/workspace/file") && url.includes("tina-handbook.md")) {
      return json({
        content: "# TINA Handbook\n\nOfficial guide referencing [[TINA]].",
      });
    }
    if (url.includes("/api/workspace/file") && url.includes("team-notes.md")) {
      return json({
        content: "# Team Notes\n\nWeekly sync with [[Alice Nguyen]].",
      });
    }
    if (url.includes("/api/workspace/file")) {
      return json({
        content: "# Personal Wiki\n\nWelcome to TINA Knowledge Hub. Review [[Alice Nguyen]].",
      });
    }
    if (url.includes("/api/workspace/search")) {
      if (url.includes("slug=_global")) {
        return json({
          hits: [{ path: "docs/tina-handbook.md", line: 3, text: "TINA platform handbook" }],
          bounded: false,
        });
      }
      return json({
        hits: [{ path: "kg/entities/person/alice.md", line: 7, text: "Works on [[TINA]]." }],
        bounded: false,
      });
    }
    if (url.includes("/api/workspace/git-remote-status")) {
      return json({
        has_home: true,
        remote: "origin",
        url: "https://github.com/org/tina-wiki.git",
        branch: "main",
        tracked: true,
        ahead: 1,
        behind: 0,
      });
    }
    if (url.includes("/api/workspace/git-token")) {
      return json({ set: true, masked: "••••9f2a" });
    }
    if (url.includes("/api/workspace/git/show")) {
      return json({ sha: "abc1234", diff: "@@ -1 +1 @@\n-old\n+new" });
    }
    if (url.includes("/api/workspace/git")) {
      return json({
        branch: "main",
        changes: [],
        commits: [{ sha: "abc1234567", msg: "Add Alice entity", when: "2m ago", kind: "you", files: ["kg/entities/person/alice.md"] }],
      });
    }
    return json({});
  });
}

describe("knowledgeFriendly helpers", () => {
  it("normalizes Vietnamese diacritics into clean slugs and strips upload hashes", () => {
    expect(slugifyTitle("Kế hoạch Quý 4 & Đánh giá")).toBe("ke-hoach-quy-4-danh-gia");
    expect(stripUploadHash("0123456789abcdef-Q4-Report.pdf")).toBe("Q4-Report.pdf");
    expect(friendlyPageTitle("uploads/0123456789abcdef-Q4-Report.pdf")).toBe("Q4-Report.pdf");
    expect(friendlyPageTitle("kg/entities/person/alice-nguyen.md")).toBe("Alice Nguyen");
  });

  it("hides entity index/log files and agents/views seed scaffolding as system while keeping user pages visible", () => {
    expect(categorizePath("kg/entities/person/index.md")).toBe("system");
    expect(categorizePath("kg/entities/meeting/index.md")).toBe("system");
    expect(categorizePath("kg/entities/project/log.md")).toBe("system");
    expect(categorizePath("kg/entities/task/index.md")).toBe("system");
    expect(categorizePath("agents/meeting.md")).toBe("system");
    expect(categorizePath("agents/README.md")).toBe("system");
    expect(categorizePath("views/README.md")).toBe("system");

    expect(categorizePath("kg/entities/person/jane-liu.md")).toBe("people");
    expect(categorizePath("kg/entities/meeting/2026-06-12-acme-intro.md")).toBe("meetings");
    expect(categorizePath("onboarding.md")).toBe("pages");
    expect(categorizePath("README.md")).toBe("pages");
  });

  it("normalizes prefixed tina-workspace and tina-reach MCP tool names to human-friendly activity labels", () => {
    expect(normalizeAgentToolName("mcp__tina-workspace__search_wiki")).toBe("search_wiki");
    expect(normalizeAgentToolName("mcp__tina_workspace__create_wiki")).toBe("create_wiki");
    expect(normalizeAgentToolName("mcp__tina-reach__reach_web_search")).toBe("reach_web_search");
    expect(describeAgentTool("mcp__tina-workspace__search_wiki").done).toBe("Searched Knowledge");
    expect(describeAgentTool("mcp__tina-workspace__read_wiki").done).toBe("Read page");
    expect(describeAgentTool("mcp__tina-workspace__update_wiki").kind).toBe("write");
    expect(describeAgentTool("FileChange").kind).toBe("write");
    expect(describeAgentTool("FileChange").done).toBe("Updated page");
    expect(describeAgentTool("mcp__tina-reach__reach_web_read").done).toBe("Read web page");
  });

  it("edits title and body cleanly while preserving multi-line YAML frontmatter", () => {
    const raw = "---\nid: person/alice\ntype: person\ntitle: Alice Nguyen\ntags:\n  - design\n  - q4\n---\n\n## Role\nOriginal body.";
    const parsed = parseDocumentClean(raw, "kg/entities/person/alice.md");
    expect(parsed.displayTitle).toBe("Alice Nguyen");
    expect(parsed.bodyWithoutLeadingH1).toBe("## Role\nOriginal body.");

    const withNewTitle = updateCleanDocumentTitle(raw, "kg/entities/person/alice.md", "Alice T. Nguyen");
    const withNewBody = updateCleanDocumentBody(withNewTitle, "kg/entities/person/alice.md", "## Role\nUpdated body.");
    expect(withNewBody).toContain("id: person/alice");
    expect(withNewBody).toContain("type: person");
    expect(withNewBody).toContain("title: Alice T. Nguyen");
    expect(withNewBody).toContain("tags:\n  - design\n  - q4");
    expect(withNewBody).toContain("Updated body.");
  });

  it("quotes YAML dates, numbers, and YAML 1.1 scalars in entity templates, title edits, and moves", () => {
    expect(formatYamlScalar("2026")).toBe('"2026"');
    expect(formatYamlScalar("3.14")).toBe('"3.14"');
    expect(formatYamlScalar("2026-11-28")).toBe('"2026-11-28"');
    expect(formatYamlScalar("2026-11-28T05:07:03.000Z")).toBe('"2026-11-28T05:07:03.000Z"');
    expect(formatYamlScalar("y")).toBe('"y"');
    expect(formatYamlScalar("~")).toBe('"~"');
    expect(formatYamlScalar("TQuang")).toBe("TQuang");

    // Person, Project, and Task templates emit quoted ISO date-time for `updated`
    for (const kind of ["person", "project", "task"] as const) {
      const tpl = buildNewPageTemplate(kind, "TQuang");
      expect(tpl.path).toBe(`kg/entities/${kind}/tquang.md`);
      expect(tpl.content).toMatch(/^updated: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/m);
    }

    // Numeric page title is quoted so PyYAML keeps it as a string
    const numericPerson = buildNewPageTemplate("person", "2026");
    expect(numericPerson.content).toContain('title: "2026"');

    // Editing title keeps `updated` quoted as ISO date-time
    const edited = updateCleanDocumentTitle(numericPerson.content, numericPerson.path, "2027");
    expect(edited).toContain('title: "2027"');
    expect(edited).toMatch(/^updated: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/m);

    // visibleHumanMetadata displays clean YYYY-MM-DD even when `updated` is a full ISO timestamp
    expect(visibleHumanMetadata({ updated: "2026-11-28T05:07:03.000Z" })).toEqual([
      { label: "Updated", value: "2026-11-28" },
    ]);

    // Moving a plain wiki page without frontmatter into kg/entities/person/ synthesizes valid frontmatter
    const upgraded = ensureEntityFrontmatterForPath("# TQuang\n\nProfile notes.", "kg/entities/person/tquang.md", "TQuang");
    expect(upgraded).toContain("id: person/tquang");
    expect(upgraded).toContain("type: person");
    expect(upgraded).toContain("title: TQuang");
    expect(upgraded).toMatch(/^updated: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/m);
    expect(upgraded).toContain("Profile notes.");

    // Moving a plain page to another non-entity folder leaves content untouched
    expect(ensureEntityFrontmatterForPath("# Plain", "notes/plain.md")).toBe("# Plain");
  });

  it("builds Constellation graph with pages, markdown links, #tags (ignoring hex colors), and deterministic physics", () => {
    const graph = buildConstellationGraph(
      [
        {
          wsId: "personal",
          wsName: "My Space",
          path: "wiki/launch.md",
          content: "# Launch Plan\n\nSee [Alice](../kg/entities/person/alice.md) #launch #fff\n```css\n#notatag\n```",
        },
        {
          wsId: "personal",
          wsName: "My Space",
          path: "kg/entities/person/alice.md",
          content: "---\nid: person/alice\ntype: person\ntitle: Alice Nguyen\ntags: [launch]\n---\n\nOwner of [[Launch Plan]].",
        },
      ],
      { includePages: true, includeTags: true },
    );

    expect(graph.nodes.map((n) => n.title)).toContain("Launch Plan");
    expect(graph.nodes.map((n) => n.title)).toContain("Alice Nguyen");
    expect(graph.nodes.map((n) => n.title)).toContain("#launch");
    expect(graph.nodes.map((n) => n.title)).not.toContain("#fff");
    expect(graph.nodes.map((n) => n.title)).not.toContain("#notatag");
    expect(graph.edges.some((e) => e.kind === "markdown")).toBe(true);
    expect(graph.edges.some((e) => e.kind === "tag")).toBe(true);

    const sim = createInitialSimulation(graph.nodes);
    prewarmSimulation(sim, graph.edges, { repulsion: 2200, linkDistance: 96 }, 40);
    const cam = computeFitCamera(sim, 800, 500);
    const hub = sim.get(graph.nodes[0].id)!;
    const hit = hitTestSimNode(sim, cam, hub.x * cam.scale + cam.tx, hub.y * cam.scale + cam.ty);
    expect(hit).toBe(hub.id);
  });
});

describe("KnowledgeView v3 (Notion-Style Non-Tech Knowledge Hub)", () => {
  beforeEach(() => {
    window.localStorage.removeItem("tina.knowledge.devView");
    window.history.replaceState({}, "", "/?nav=knowledge");
    mockStreamChatTurn.mockReset();
    mockFetchRoutes();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("opens on the clean Library Overview hiding technical paths, and switches spaces via the Space Picker", async () => {
    render(<KnowledgeView onAskTina={vi.fn()} />);

    // Friendly Library Overview home screen loads with clean titles & stripped upload hash
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "My Space" })).toBeTruthy();
      expect(screen.getByText("Create a page")).toBeTruthy();
      expect(screen.getAllByText("Q4-Report.pdf").length).toBeGreaterThan(0);
    });

    // Technical plumbing files & raw extensions are hidden by default
    expect(screen.queryByText("CLAUDE.md")).toBeNull();
    expect(screen.queryByText("kg/entities/person/alice.md")).toBeNull();

    // Open Space Picker dropdown & switch to Team Alpha (editable)
    fireEvent.click(screen.getByRole("button", { name: /Switch space/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Team Alpha/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Team Alpha" })).toBeTruthy();
    });
    // Open a page in Team Alpha and verify Edit is enabled for Owner
    fireEvent.click(screen.getAllByRole("button", { name: /Team Notes/i })[0]);
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Shared notes editable");
      expect(screen.getByRole("button", { name: /^Edit$/i })).toBeTruthy();
    });

    // Switch to Templates & Guides (_global) — view-only with no Edit button
    fireEvent.click(screen.getByRole("button", { name: /Switch space/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Templates & Guides/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Templates & Guides" })).toBeTruthy();
    });
    fireEvent.click(screen.getAllByRole("button", { name: /TINA Handbook/i })[0]);
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Shared platform guide.");
    });
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
  });

  it("hides YAML frontmatter in Clean Editor while preserving entity metadata transparently on save", async () => {
    const savedPayloads: Array<Record<string, unknown>> = [];
    vi.restoreAllMocks();
    mockFetchRoutes((p) => savedPayloads.push(p));

    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Alice/i }).length).toBeGreaterThan(0);
    });

    // Open Alice page from sidebar
    fireEvent.click(screen.getAllByRole("button", { name: /Alice/i })[0]);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Alice Nguyen" })).toBeTruthy();
      expect(screen.getByText("On this page")).toBeTruthy();
    });
    // Raw YAML developer metadata bar is hidden when Developer view is OFF
    expect(screen.queryByLabelText("Developer metadata")).toBeNull();

    // Enter Clean Editor
    fireEvent.click(screen.getByRole("button", { name: /^Edit$/i }));
    const bodyEditor = screen.getByLabelText(/Page content editor/i) as HTMLTextAreaElement;
    expect(bodyEditor.value).not.toContain("---");
    expect(bodyEditor.value).not.toContain("id: person/alice");

    // Edit title + body with [[ autocomplete & save
    fireEvent.change(screen.getByLabelText(/^Page title$/i), { target: { value: "Alice T. Nguyen" } });
    const nextBody = `${bodyEditor.value}\nSee [[ti`;
    fireEvent.change(bodyEditor, { target: { value: nextBody, selectionStart: nextBody.length } });
    expect(screen.getByText(/● Unsaved/i)).toBeTruthy();
    // #250 Unsaved changes bar slides open with accurate count
    const unsavedBar = screen.getByTestId("lucian-unsaved-bar");
    expect(unsavedBar.className).toContain("is-open");
    expect(unsavedBar.textContent).toContain("Unsaved changes: 2");
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: /Page link suggestions/i })).toBeTruthy();
    });

    // #140 Selection formatting bar activates when text is selected, survives blur into its buttons, and hides on outside blur
    bodyEditor.setSelectionRange(0, 5);
    fireEvent.select(bodyEditor);
    const fmtBar = screen.getByTestId("lucian-selection-formatting");
    expect(fmtBar.className).toContain("is-on");
    const boldBtn = screen.getByRole("button", { name: "Bold selected text" });
    fireEvent.blur(bodyEditor, { relatedTarget: boldBtn });
    expect(fmtBar.className).toContain("is-on");
    fireEvent.click(boldBtn);
    expect(bodyEditor.value).toContain("**");
    fireEvent.blur(bodyEditor, { relatedTarget: screen.getByLabelText(/^Page title$/i) });
    expect(fmtBar.className).not.toContain("is-on");

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => {
      expect(savedPayloads.length).toBe(1);
    });
    const content = String(savedPayloads[0].content);
    expect(content).toContain("id: person/alice");
    expect(content).toContain("type: person");
    expect(content).toContain("title: Alice T. Nguyen");
    expect(content).toContain("tags:\n  - design\n  - q4");
  });

  it("supports inline Ask Tina drawer with friendly wording and auto-refresh on update", async () => {
    mockStreamChatTurn.mockImplementation(async (_req: unknown, cbs: ChatStreamCallbacks) => {
      cbs.onDelta("Clear executive summary.");
      cbs.onCommit("deadbeef1234");
      return { sawVisibleOutput: true, terminal: true, aborted: false };
    });

    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "My Space" })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Ask Tina$/i }));
    expect(screen.getByLabelText(/Ask Tina assistant/i)).toBeTruthy();

    // Empty state renders tactile starter cards, then collapses to compact follow-up pills once active
    expect(screen.getByRole("group", { name: /Suggested prompts/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Summarize space/i }));
    await waitFor(() => {
      expect(screen.getByText(/Clear executive summary/i)).toBeTruthy();
      expect(screen.getByText(/Updated space · refreshed/i)).toBeTruthy();
    });
    expect(screen.getByRole("group", { name: /Quick follow-up prompts/i })).toBeTruthy();

    // Copy response action writes markdown text to clipboard
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    fireEvent.click(screen.getByRole("button", { name: /Copy response/i }));
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("Clear executive summary.");
    });

    // Start a new chat returns to the clean starter state
    fireEvent.click(screen.getByRole("button", { name: /Start a new chat/i }));
    expect(screen.getByRole("group", { name: /Suggested prompts/i })).toBeTruthy();

    // Regression guard: agent-api ChatContextBody requires context.surface to be an object dict, never a string
    const chatReq = mockStreamChatTurn.mock.calls[0]?.[0] as { context?: { surface?: unknown } };
    expect(typeof chatReq?.context?.surface).toBe("object");
    expect(chatReq?.context?.surface).not.toBeNull();

    // Regression guard: denied/uncommitted write tool-call must NOT fabricate a green "Updated space" badge,
    // and prefixed mcp__tina-workspace__ tools render human-friendly labels rather than raw MCP strings.
    mockStreamChatTurn.mockImplementationOnce(async (_req: unknown, cbs: ChatStreamCallbacks) => {
      cbs.onTool?.("mcp__tina-workspace__create_wiki");
      cbs.onDelta("Write was denied in this space.");
      return { sawVisibleOutput: true, terminal: true, aborted: false };
    });
    fireEvent.click(screen.getByRole("button", { name: /Summarize space/i }));
    await waitFor(() => {
      expect(screen.getByText(/Write was denied in this space\./i)).toBeTruthy();
    });
    expect(screen.queryByText(/Updated space · refreshed/i)).toBeNull();

    // delete_wiki / move_wiki also trigger workspace refresh when finished without explicit commit event
    const countTreeFetches = () =>
      (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((call) =>
        String(call[0]).includes("/api/workspace/tree"),
      ).length;
    const treeCallsBeforeDelete = countTreeFetches();
    mockStreamChatTurn.mockImplementationOnce(async (_req: unknown, cbs: ChatStreamCallbacks) => {
      cbs.onTool?.("delete_wiki");
      cbs.onDelta("Đã xóa hồ sơ mẫu.");
      return { sawVisibleOutput: true, terminal: true, aborted: false };
    });
    fireEvent.click(screen.getByRole("button", { name: /Summarize space/i }));
    await waitFor(() => {
      expect(screen.getByText(/Đã xóa hồ sơ mẫu\./i)).toBeTruthy();
      expect(countTreeFetches()).toBeGreaterThan(treeCallsBeforeDelete);
    });
  });

  it("renders Constellation Graph with Display popover, All Spaces, Columns toggle, and Back/Forward reading history", async () => {
    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /Space Home/i }).length).toBeGreaterThan(0);
    });

    // Open Space Home first so history has a first page
    fireEvent.click(screen.getAllByRole("button", { name: /Space Home/i })[0]);
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Welcome to TINA Knowledge Hub");
    });

    // Open Connections Map — defaults to Constellation mode including Pages & #tags
    fireEvent.click(screen.getByRole("button", { name: /Connections Map/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Constellation/i }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("button", { name: /Alice Nguyen \(Person\)/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /Personal Wiki \(Page\)/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /#design \(Tag\)/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /Standalone Topic \(Topic\)/i })).toBeTruthy();
    });

    // Display popover controls tags, pages, and All Spaces
    fireEvent.click(screen.getByRole("button", { name: /^Display$/i }));
    expect(screen.getByRole("dialog", { name: /Graph display settings/i })).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Show all spaces/i));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /TINA Handbook \(Page\)/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /Team Notes \(Page\)/i })).toBeTruthy();
    });

    // Toggle back to current space and test Columns layout switch
    fireEvent.click(screen.getByLabelText(/Show all spaces/i));
    fireEvent.click(screen.getByRole("button", { name: /^Columns$/i }));
    expect(await screen.findByRole("img", { name: /columns connections map/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Constellation$/i }));

    // Unlinked filter isolates standalone items
    fireEvent.click(screen.getByRole("button", { name: /Unlinked \(1\)/i }));
    expect(screen.getByRole("button", { name: /Standalone Topic \(Topic\)/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Alice Nguyen \(Person\)/i })).toBeNull();

    // Focus selected isolates Alice + connected items
    fireEvent.click(screen.getByRole("button", { name: /^All \(5\)$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Alice Nguyen \(Person\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /Focus selected/i }));
    expect(screen.getByRole("button", { name: /TINA \(Project\)/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Standalone Topic \(Topic\)/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Fit to view/i }));
    fireEvent.click(screen.getByRole("button", { name: /Open page/i }));
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Works on [[TINA]].");
    });

    // Back returns to Space Home
    const backBtn = screen.getByRole("button", { name: /Back in reading history/i });
    expect((backBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(backBtn);
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Welcome to TINA Knowledge Hub");
    });
  });

  it("provides Unified Smart Search, collapses GitHub Sync by default, and reveals raw paths/diffs in Developer view", async () => {
    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "My Space" })).toBeTruthy();
    });

    // Unified smart search searches titles + content across all spaces without mode toggles
    const searchInput = screen.getByLabelText(/Search knowledge/i);
    fireEvent.change(searchInput, { target: { value: "TINA" } });
    fireEvent.click(screen.getByLabelText(/Search all spaces/i));
    fireEvent.submit(searchInput.closest("form")!);

    await waitFor(() => {
      expect(screen.getByText(/TINA platform handbook/i)).toBeTruthy();
    });

    // Clear search & open Activity & Settings
    fireEvent.click(screen.getByRole("button", { name: /Clear search/i }));
    fireEvent.click(screen.getByRole("button", { name: /Activity & Settings/i }));
    await waitFor(() => {
      expect(screen.getByText(/Add Alice entity/i)).toBeTruthy();
    });

    // Advanced GitHub Sync is collapsed by default for non-tech users
    expect(screen.queryByText(/GitHub connected/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Advanced · GitHub Sync/i }));
    expect(screen.getByText(/GitHub connected \(••••9f2a\)/i)).toBeTruthy();

    // Turning ON Developer view reveals raw file tree (CLAUDE.md), commit SHA, and unified diff
    fireEvent.click(screen.getByRole("switch", { name: /Developer view/i }));
    await waitFor(() => {
      expect(screen.getByText("CLAUDE.md")).toBeTruthy();
      expect(screen.getByText("abc1234")).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Add Alice entity/i));
    await waitFor(() => {
      expect(screen.getByText(/\+new/)).toBeTruthy();
    });
  });

  it("creates a Person page with valid quoted ISO frontmatter and shows duplicate errors inside the Create Page modal", async () => {
    const savedPayloads: Array<Record<string, unknown>> = [];
    vi.restoreAllMocks();
    mockFetchRoutes((p) => savedPayloads.push(p));

    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "My Space" })).toBeTruthy();
    });

    // Open "Create a new page" modal
    fireEvent.click(screen.getByRole("button", { name: /^New page$/i }));
    const dialog = await screen.findByRole("dialog", { name: /Create new page/i });

    // Select Person template and try an already-existing person ("Alice") -> inline error INSIDE dialog
    fireEvent.click(within(dialog).getByRole("button", { name: /Person/i }));
    const titleInput = within(dialog).getByLabelText("Page title");
    fireEvent.change(titleInput, { target: { value: "Alice" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create page/i }));

    expect(await within(dialog).findByRole("alert")).toBeTruthy();
    expect(within(dialog).getByRole("alert").textContent).toContain("already exists");

    // Change title to "TQuang" -> clears inline error and submits valid workspace.v1 frontmatter
    fireEvent.change(titleInput, { target: { value: "TQuang" } });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: /Create page/i }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Create new page/i })).toBeNull();
    });
    const payload = savedPayloads.find((p) => p.path === "kg/entities/person/tquang.md");
    expect(payload).toBeTruthy();
    expect(String(payload?.content)).toContain("id: person/tquang");
    expect(String(payload?.content)).toContain("type: person");
    expect(String(payload?.content)).toContain("title: TQuang");
    expect(String(payload?.content)).toMatch(/^updated: "\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"$/m);
  });

  it("manages full space lifecycle: protected My Space, Archive/Restore/Delete for Extra Space, Unshare/Leave/Delete for Team Spaces, and partial-failure recovery", async () => {
    vi.restoreAllMocks();

    type MockSlot = { repo: string | null; ref: string | null; name?: string; archived?: boolean };
    const state: {
      slots: Record<string, MockSlot>;
      active: Array<{ slug: string; repo: null; ref: null; role: string; path: string; write: boolean; primary: boolean; name?: string }>;
      memberships: Array<{ workspace_id: string; role: string }>;
      membersByWs: Record<string, Array<{ subject: string; role: string; email?: string }>>;
      failNextDeleteSlug: string | null;
      calls: Array<{ method: string; url: string; body?: unknown }>;
    } = {
      slots: {
        seed: { repo: null, ref: null, name: "Personal" },
        "project-notes": { repo: null, ref: null, name: "Project Notes", archived: false },
        "old-archive": { repo: null, ref: null, name: "Old Archive", archived: true },
      },
      active: [
        { slug: "seed", repo: null, ref: null, role: "private", path: "/workspaces/42", write: true, primary: true, name: "Personal" },
        { slug: "project-notes", repo: null, ref: null, role: "private", path: "/workspaces/.attached/42/project-notes", write: true, primary: false, name: "Project Notes" },
      ],
      memberships: [
        { workspace_id: "team-alpha", role: "owner" },
        { workspace_id: "team-beta", role: "owner" },
        { workspace_id: "team-gamma", role: "contributor" },
      ],
      membersByWs: {
        "team-alpha": [{ subject: "42", role: "owner", email: "me@acme.test" }],
        "team-beta": [
          { subject: "42", role: "owner", email: "me@acme.test" },
          { subject: "99", role: "owner", email: "coowner@acme.test" },
        ],
        "team-gamma": [
          { subject: "99", role: "owner", email: "owner@acme.test" },
          { subject: "42", role: "contributor", email: "me@acme.test" },
        ],
      },
      failNextDeleteSlug: null,
      calls: [],
    };
    let nextUnshareIdx = 1;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method || "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      state.calls.push({ method, url, body });
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

      if (url.includes("/api/workspace/attached")) {
        return json({ active: "seed", slots: state.slots });
      }
      if (url.includes("/api/workspace/active")) {
        return json({ subject: "42", active: state.active });
      }
      if (url.includes("/api/workspace/shared")) {
        return json({ memberships: state.memberships });
      }
      if (url.includes("/api/workspace/members")) {
        const wsId = new URL(url, "https://meettina.test").searchParams.get("workspace_id") || "";
        return json({ members: state.membersByWs[wsId] ?? [] });
      }
      const archiveMatch = url.match(/\/api\/workspace\/([^/?]+)\/archive$/);
      if (archiveMatch && method === "POST") {
        const slug = decodeURIComponent(archiveMatch[1]);
        const archived = Boolean((body as { archived?: boolean })?.archived);
        if (state.slots[slug]) state.slots[slug] = { ...state.slots[slug], archived };
        return json({ slug, archived });
      }
      const unshareMatch = url.match(/\/api\/workspace\/([^/?]+)\/unshare$/);
      if (unshareMatch && method === "POST") {
        const wsId = decodeURIComponent(unshareMatch[1]);
        const newSlug = `workspace-${nextUnshareIdx++}`;
        state.memberships = state.memberships.filter((m) => m.workspace_id !== wsId);
        state.slots[newSlug] = { repo: null, ref: null, name: wsId, archived: false };
        return json({ slug: newSlug });
      }
      const leaveMatch = url.match(/\/api\/workspace\/([^/?]+)\/leave$/);
      if (leaveMatch && method === "POST") {
        const wsId = decodeURIComponent(leaveMatch[1]);
        state.memberships = state.memberships.filter((m) => m.workspace_id !== wsId);
        return json({ ok: true, left: wsId });
      }
      const deleteMatch = url.match(/\/api\/workspace\/([^/?]+)$/);
      if (deleteMatch && method === "DELETE") {
        const slug = decodeURIComponent(deleteMatch[1]);
        if (state.failNextDeleteSlug === slug) {
          state.failNextDeleteSlug = null;
          return json({ detail: "Temporary storage error" }, 500);
        }
        delete state.slots[slug];
        state.active = state.active.filter((a) => a.slug !== slug);
        return json({ slug, deleted: true });
      }
      if (url.includes("/api/workspace/tree")) {
        return json({ files: ["README.md"] });
      }
      if (url.includes("/api/workspace/purpose")) {
        return json({ purpose: "Notes" });
      }
      if (url.includes("/api/workspace/git-remote-status")) {
        return json({ has_home: false, remote: "origin", url: null, branch: "main", tracked: false, ahead: 0, behind: 0 });
      }
      if (url.includes("/api/workspace/git-token")) {
        return json({ set: false, masked: null });
      }
      if (url.includes("/api/workspace/git")) {
        return json({ branch: "main", changes: [], commits: [] });
      }
      return json({});
    });

    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "My Space" })).toBeTruthy();
    });

    // 1. My Space: Space settings quick button on Overview opens Activity & Settings; My Space is clearly protected
    fireEvent.click(screen.getByRole("button", { name: /Space settings/i }));
    await waitFor(() => {
      expect(screen.getByText(/Default personal space cannot be deleted/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /^Delete space$/i })).toBeNull();
    // Pre-existing archived space is visible and deletable from Archived Spaces card
    const archivedCard = screen.getByLabelText("Archived spaces");
    expect(within(archivedCard).getByText("Old Archive")).toBeTruthy();
    fireEvent.click(within(archivedCard).getByRole("button", { name: /^Delete$/i }));
    const deleteArchivedDialog = await screen.findByRole("dialog", { name: /Delete Old Archive/i });
    const confirmArchivedBtn = within(deleteArchivedDialog).getByRole("button", { name: /Permanently delete/i }) as HTMLButtonElement;
    expect(confirmArchivedBtn.disabled).toBe(true);
    fireEvent.change(within(deleteArchivedDialog).getByLabelText("Confirm space name"), { target: { value: "Old Archive" } });
    expect(confirmArchivedBtn.disabled).toBe(false);
    fireEvent.click(confirmArchivedBtn);
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Delete Old Archive/i })).toBeNull();
      expect(screen.queryByLabelText("Archived spaces")).toBeNull();
    });
    expect(state.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/workspace/old-archive"))).toBe(true);

    // 2. Extra Private Space: Archive -> appears in Archived Spaces -> Restore -> Delete via Space Picker quick action
    fireEvent.click(screen.getByRole("button", { name: /Switch space/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Project Notes/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Project Notes" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Activity & Settings/i }));
    const extraDanger = await screen.findByLabelText("Danger Zone");
    fireEvent.click(within(extraDanger).getByRole("button", { name: /Archive space/i }));
    await waitFor(() => {
      expect(screen.getByLabelText("Archived spaces")).toBeTruthy();
      expect(within(screen.getByLabelText("Archived spaces")).getByText("Project Notes")).toBeTruthy();
    });
    // Space Picker shows Archived spaces count
    fireEvent.click(screen.getByRole("button", { name: /Switch space/i }));
    expect(await screen.findByRole("menuitem", { name: /Archived spaces/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Switch space/i }));
    // Restore brings Project Notes back
    fireEvent.click(within(screen.getByLabelText("Archived spaces")).getByRole("button", { name: /Restore/i }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Archived spaces")).toBeNull();
    });
    expect(state.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/workspace/project-notes/archive") && (c.body as { archived?: boolean })?.archived === false)).toBe(true);
    // Delete Project Notes directly from Space Picker quick action
    fireEvent.click(screen.getByRole("button", { name: /Switch space/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete this space/i }));
    const deleteExtraDialog = await screen.findByRole("dialog", { name: /Delete Project Notes/i });
    fireEvent.change(within(deleteExtraDialog).getByLabelText("Confirm space name"), { target: { value: "project notes" } });
    fireEvent.click(within(deleteExtraDialog).getByRole("button", { name: /Permanently delete/i }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Delete Project Notes/i })).toBeNull();
    });
    expect(state.calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api/workspace/project-notes"))).toBe(true);

    // 3. Team Space (Sole Owner — Team Alpha): Leave is disabled, Delete runs unshare -> delete with partial-failure retry
    fireEvent.click(screen.getByRole("button", { name: /Switch space/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Team Alpha/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Team Alpha" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Activity & Settings/i }));
    const alphaDanger = await screen.findByLabelText("Danger Zone");
    expect((within(alphaDanger).getByRole("button", { name: /Leave space/i }) as HTMLButtonElement).disabled).toBe(true);
    // Trigger Delete with simulated failure on step 2 (DELETE /api/workspace/workspace-1)
    state.failNextDeleteSlug = "workspace-1";
    fireEvent.click(within(alphaDanger).getByRole("button", { name: /Delete space/i }));
    const deleteAlphaDialog = await screen.findByRole("dialog", { name: /Delete Team Alpha/i });
    expect(deleteAlphaDialog.textContent).toContain("All teammates will immediately lose access");
    fireEvent.change(within(deleteAlphaDialog).getByLabelText("Confirm space name"), { target: { value: "Team Alpha" } });
    fireEvent.click(within(deleteAlphaDialog).getByRole("button", { name: /Permanently delete/i }));
    // Modal remains open with recovery message and retries DELETE without re-unsharing
    const retryAlert = await within(deleteAlphaDialog).findByRole("alert");
    expect(retryAlert.textContent).toContain("Stopped sharing");
    expect(retryAlert.textContent).toContain("retry");
    fireEvent.click(within(deleteAlphaDialog).getByRole("button", { name: /Permanently delete/i }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Delete Team Alpha/i })).toBeNull();
    });
    expect(state.calls.filter((c) => c.method === "POST" && c.url.endsWith("/api/workspace/team-alpha/unshare")).length).toBe(1);
    expect(state.calls.filter((c) => c.method === "DELETE" && c.url.endsWith("/api/workspace/workspace-1")).length).toBe(2);

    // 4. Team Space (Co-Owner — Team Beta): Leave is enabled, and Stop sharing converts to private space
    fireEvent.click(screen.getByRole("button", { name: /Switch space/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Team Beta/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Team Beta" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Activity & Settings/i }));
    const betaDanger = await screen.findByLabelText("Danger Zone");
    await waitFor(() => {
      expect((within(betaDanger).getByRole("button", { name: /Leave space/i }) as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(within(betaDanger).getByRole("button", { name: /Stop sharing/i }));
    const unshareDialog = await screen.findByRole("dialog", { name: /Stop sharing Team Beta/i });
    fireEvent.click(within(unshareDialog).getByRole("button", { name: /Stop sharing/i }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Stop sharing Team Beta/i })).toBeNull();
    });
    expect(state.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/workspace/team-beta/unshare"))).toBe(true);

    // 5. Team Space (Contributor — Team Gamma): no Delete/Stop sharing; Leave works via confirmation modal
    fireEvent.click(screen.getByRole("button", { name: /Switch space/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Team Gamma/i }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Team Gamma" })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /Activity & Settings/i }));
    const gammaDanger = await screen.findByLabelText("Danger Zone");
    expect(within(gammaDanger).queryByRole("button", { name: /Delete space/i })).toBeNull();
    expect(within(gammaDanger).queryByRole("button", { name: /Stop sharing/i })).toBeNull();
    expect(within(gammaDanger).getByText(/Only a space owner/i)).toBeTruthy();
    fireEvent.click(within(gammaDanger).getByRole("button", { name: /Leave space/i }));
    const leaveDialog = await screen.findByRole("dialog", { name: /Leave Team Gamma/i });
    fireEvent.click(within(leaveDialog).getByRole("button", { name: /Leave space/i }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: /Leave Team Gamma/i })).toBeNull();
    });
    expect(state.calls.some((c) => c.method === "POST" && c.url.endsWith("/api/workspace/team-gamma/leave"))).toBe(true);
  });
});
