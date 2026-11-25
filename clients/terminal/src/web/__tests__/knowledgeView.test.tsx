import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { KnowledgeView } from "../KnowledgeView";
import {
  friendlyPageTitle,
  parseDocumentClean,
  slugifyTitle,
  stripUploadHash,
  updateCleanDocumentBody,
  updateCleanDocumentTitle,
} from "../knowledgeFriendly";
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
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: /Page link suggestions/i })).toBeTruthy();
    });

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

    // Regression guard: denied/uncommitted write tool-call must NOT fabricate a green "Updated space" badge
    mockStreamChatTurn.mockImplementationOnce(async (_req: unknown, cbs: ChatStreamCallbacks) => {
      cbs.onTool?.("create_wiki");
      cbs.onDelta("Write was denied in this space.");
      return { sawVisibleOutput: true, terminal: true, aborted: false };
    });
    fireEvent.click(screen.getByRole("button", { name: /Summarize space/i }));
    await waitFor(() => {
      expect(screen.getByText(/Write was denied in this space\./i)).toBeTruthy();
    });
    expect(screen.queryByText(/Updated space · refreshed/i)).toBeNull();
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
});
