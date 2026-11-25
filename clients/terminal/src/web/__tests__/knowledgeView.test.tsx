import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { KnowledgeView } from "../KnowledgeView";
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

function mockFetchRoutes() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
          "kg/entities/person/alice.md",
          "kg/entities/project/tina.md",
          "kg/entities/topic/orphan-topic.md",
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
        content: "---\nid: person/alice\ntype: person\ntitle: Alice Nguyen\n---\n\n## Role\nWorks on [[TINA]].",
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
        content: "---\nid: person/alice\ntype: person\ntitle: Alice Nguyen\n---\n\nWorks on [[TINA]].",
      });
    }
    if (url.includes("/api/workspace/file") && url.includes("tina.md")) {
      return json({
        content: "---\nid: project/tina\ntype: project\ntitle: TINA\n---\n\nLed by [[Alice Nguyen]].",
      });
    }
    if (url.includes("/api/workspace/file") && url.includes("orphan-topic.md")) {
      return json({
        content: "---\nid: topic/orphan\ntype: topic\ntitle: Standalone Topic\n---\n\nNo links yet.",
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
        has_home: true, remote: "origin", url: "https://github.com/org/tina-wiki.git",
        branch: "main", tracked: true, ahead: 1, behind: 0,
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

describe("KnowledgeView v2 (Production Web Knowledge Hub)", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?nav=knowledge");
    mockStreamChatTurn.mockReset();
    mockFetchRoutes();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads Personal, editable Shared owner workspace, and read-only _global Platform Guide with TOC outline", async () => {
    render(<KnowledgeView onAskTina={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Welcome to TINA Knowledge Hub");
    });

    // Reading Outline (TOC) renders H2/H3 headings
    expect(screen.getByText("On this page")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Architecture" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next Steps" })).toBeTruthy();

    // Shared owner workspace enables Edit & New Doc
    const sharedBtn = await screen.findByRole("button", { name: /team-alpha/i });
    fireEvent.click(sharedBtn);
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Shared notes editable");
    });
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeTruthy();

    // Switching to _global hides Edit and marks Read-Only
    const globalBtn = await screen.findByRole("button", { name: /Platform Guide \(_global\)/i });
    fireEvent.click(globalBtn);
    await waitFor(() => {
      expect(screen.getByText(/Platform · Read-Only/i)).toBeTruthy();
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Shared platform guide.");
    });
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
  });

  it("supports inline Ask Tina Copilot drawer with 1-click Summarize and workspace refresh on commit", async () => {
    mockStreamChatTurn.mockImplementation(async (_req: unknown, cbs: ChatStreamCallbacks) => {
      cbs.onDelta("Executive summary of README.md");
      cbs.onCommit("deadbeef1234");
      return { sawVisibleOutput: true, terminal: true, aborted: false };
    });

    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Ask Tina$/i }));
    expect(screen.getByLabelText(/Ask Tina Knowledge Copilot/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Summarize$/i }));
    await waitFor(() => {
      expect(screen.getByText(/Executive summary of README\.md/i)).toBeTruthy();
      expect(screen.getByText(/Updated workspace \(deadbee\)/i)).toBeTruthy();
    });
  });

  it("provides Split-Preview Markdown editor with [[ wikilink autocomplete and Unsaved badge", async () => {
    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Edit$/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /^Edit$/i }));
    const textarea = screen.getByLabelText(/Markdown editor/i) as HTMLTextAreaElement;
    // Split preview renders MdxDoc alongside editor by default
    expect(screen.getByTestId("mdx-doc")).toBeTruthy();

    const nextText = `${textarea.value}\nSee [[ali`;
    fireEvent.change(textarea, { target: { value: nextText, selectionStart: nextText.length } });
    // Trigger cursor update + check Unsaved badge & autocomplete suggestion
    expect(screen.getByText(/● Unsaved/i)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: /Wikilink suggestions/i })).toBeTruthy();
      expect(screen.getByRole("option", { name: /alice/i })).toBeTruthy();
    });
  });

  it("upgrades Knowledge Graph with Orphans filter, Focus 1-hop, Fit to View, and Back/Forward history", async () => {
    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("tab", { name: /Knowledge Graph/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Alice Nguyen \(person\)/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /Standalone Topic \(topic\)/i })).toBeTruthy();
    });

    // Orphan filter isolates unlinked nodes
    fireEvent.click(screen.getByRole("button", { name: /Orphans \(1\)/i }));
    expect(screen.getByRole("button", { name: /Standalone Topic \(topic\)/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Alice Nguyen \(person\)/i })).toBeNull();

    // Reset to All, select Alice, test Focus 1-hop & Fit button
    fireEvent.click(screen.getByRole("button", { name: /^All \(3\)$/i }));
    fireEvent.click(screen.getByRole("button", { name: /Alice Nguyen \(person\)/i }));
    fireEvent.click(screen.getByRole("button", { name: /Focus 1-hop/i }));
    expect(screen.getByRole("button", { name: /TINA \(project\)/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Standalone Topic \(topic\)/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Fit to view/i }));
    fireEvent.click(screen.getByRole("button", { name: /Open document/i }));
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Works on [[TINA]].");
    });

    // Back button returns to README.md
    const backBtn = screen.getByRole("button", { name: /Back in reading history/i });
    expect((backBtn as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(backBtn);
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Welcome to TINA Knowledge Hub");
    });
  });

  it("supports cross-workspace Full-text search and History & Sync diff inspection", async () => {
    render(<KnowledgeView onAskTina={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Full-text/i }));
    fireEvent.click(screen.getByLabelText(/Search all workspaces/i));
    fireEvent.change(screen.getByLabelText(/Search knowledge/i), { target: { value: "TINA" } });
    fireEvent.click(screen.getByRole("button", { name: /^Go$/i }));

    await waitFor(() => {
      expect(screen.getByText(/across 3 workspaces/i)).toBeTruthy();
      expect(screen.getByText(/TINA platform handbook/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("tab", { name: /History & Sync/i }));
    await waitFor(() => {
      expect(screen.getByText(/Token saved \(••••9f2a\)/i)).toBeTruthy();
      expect(screen.getByText(/Add Alice entity/i)).toBeTruthy();
    });

    fireEvent.click(screen.getByText(/Add Alice entity/i));
    await waitFor(() => {
      expect(screen.getByText(/\+new/)).toBeTruthy();
    });
  });
});
