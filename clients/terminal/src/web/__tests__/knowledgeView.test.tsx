import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { KnowledgeView } from "../KnowledgeView";

vi.mock("../../ui-kit/MdxDoc", () => ({
  MdxDoc: ({ children }: { children: string }) => <div data-testid="mdx-doc">{children}</div>,
}));

vi.mock("../../surfaces/MeetingKnowledge", () => ({
  MeetingWikiSourceStatus: () => null,
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
    if (url.includes("/api/workspace/tree")) {
      return json({
        files: ["README.md", "kg/entities/person/alice.md", "kg/entities/project/tina.md"],
      });
    }
    if (url.includes("/api/workspace/purpose")) {
      return json({ purpose: "Personal notes and meeting decisions" });
    }
    if (url.includes("/api/workspace/document") && url.includes("slug=_global")) {
      return json({
        content: "# TINA Global Knowledge\nShared platform guide.",
        sha256: "a".repeat(64),
        writable: false,
      });
    }
    if (url.includes("/api/workspace/document") && url.includes("alice.md")) {
      return json({
        content: "---\nid: person/alice\ntype: person\ntitle: Alice Nguyen\n---\n\nWorks on [[TINA]].",
        sha256: "b".repeat(64),
        writable: true,
      });
    }
    if (url.includes("/api/workspace/document")) {
      return json({
        content: "# Personal Wiki\nWelcome to TINA Knowledge Hub.",
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
    if (url.includes("/api/workspace/search")) {
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

describe("KnowledgeView (Production Web Knowledge Hub)", () => {
  beforeEach(() => {
    mockFetchRoutes();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads Personal, Shared, and read-only _global Platform Guide and blocks edit on _global", async () => {
    const onAskTina = vi.fn();
    render(<KnowledgeView onAskTina={onAskTina} />);

    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Welcome to TINA Knowledge Hub");
    });

    // Personal workspace exposes Edit button; switching to _global hides Edit and marks Read-Only
    expect(screen.getByRole("button", { name: /^Edit$/i })).toBeTruthy();
    const globalBtn = await screen.findByRole("button", { name: /Platform Guide \(_global\)/i });
    fireEvent.click(globalBtn);

    await waitFor(() => {
      expect(screen.getByText(/Platform · Read-Only/i)).toBeTruthy();
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Shared platform guide.");
    });
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
  });

  it("renders upgraded Knowledge Graph with zoom/filters and opens selected entity in Documents", async () => {
    render(<KnowledgeView onAskTina={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("tab", { name: /Knowledge Graph/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Alice Nguyen \(person\)/i })).toBeTruthy();
      expect(screen.getByRole("button", { name: /TINA \(project\)/i })).toBeTruthy();
    });

    // Zoom control updates percentage
    fireEvent.click(screen.getByRole("button", { name: /Zoom in/i }));
    expect(screen.getByRole("button", { name: /Reset zoom/i }).textContent).toBe("115%");

    // Open document switches back to Documents tab on that entity
    fireEvent.click(screen.getByRole("button", { name: /Open document/i }));
    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc").textContent).toContain("Works on [[TINA]].");
    });
  });

  it("supports Full-text search and History & Sync diff inspection", async () => {
    render(<KnowledgeView onAskTina={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("mdx-doc")).toBeTruthy();
    });

    // Full-text search
    fireEvent.click(screen.getByRole("button", { name: /Full-text/i }));
    fireEvent.change(screen.getByLabelText(/Search knowledge/i), { target: { value: "TINA" } });
    fireEvent.click(screen.getByRole("button", { name: /^Go$/i }));

    await waitFor(() => {
      expect(screen.getByText(/1 match/i)).toBeTruthy();
      expect(screen.getByText(/Works on \[\[TINA\]\]/i)).toBeTruthy();
    });

    // History & Sync tab
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
