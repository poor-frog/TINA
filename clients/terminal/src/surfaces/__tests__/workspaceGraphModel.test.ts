import { describe, expect, it } from "vitest";
import { buildWorkspaceGraph } from "../workspaceGraphModel";

describe("buildWorkspaceGraph", () => {
  it("keeps typed entity pages and resolves wikilinks, aliases, and paths", () => {
    const graph = buildWorkspaceGraph([
      {
        path: "kg/entities/person/jane-liu.md",
        content: "---\ntype: person\nid: jane-liu\ntitle: Jane Liu\n---\nWorks at [[Acme Corp|Acme]]. Also [[Acme Corp]] and `[[not an edge]]`.\n",
      },
      {
        path: "kg/entities/company/acme-corp.md",
        content: "---\ntype: company\nid: acme-corp\ntitle: Acme Corp\n---\nSee [[kg/entities/person/jane-liu.md]].\n",
      },
      { path: "kg/entities/index.md", content: "# Entity index\n[[Acme Corp]]" },
      { path: "kg/entities/person/invalid.md", content: "not entity frontmatter" },
    ]);

    expect(graph.nodes.map(({ title }) => title)).toEqual(["Acme Corp", "Jane Liu"]);
    expect(graph.edges).toEqual([
      { from: "kg/entities/company/acme-corp.md", to: "kg/entities/person/jane-liu.md" },
      { from: "kg/entities/person/jane-liu.md", to: "kg/entities/company/acme-corp.md" },
    ]);
  });

  it("skips an ambiguous wikilink instead of connecting it to an arbitrary entity", () => {
    const graph = buildWorkspaceGraph([
      { path: "kg/entities/project/a.md", content: "---\ntype: project\nid: a\ntitle: Shared\n---\n" },
      { path: "kg/entities/project/b.md", content: "---\ntype: project\nid: b\ntitle: Shared\n---\n" },
      { path: "kg/entities/person/author.md", content: "---\ntype: person\nid: author\ntitle: Author\n---\n[[Shared]]" },
    ]);

    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toEqual([]);
  });
});
