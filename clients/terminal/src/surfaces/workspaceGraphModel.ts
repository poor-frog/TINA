export interface WorkspaceGraphFile {
  path: string;
  content: string | null;
}

export interface WorkspaceGraphEntity {
  path: string;
  id: string;
  title: string;
  type: string;
}

export interface WorkspaceGraphEdge {
  from: string;
  to: string;
}

export interface WorkspaceGraph {
  nodes: WorkspaceGraphEntity[];
  edges: WorkspaceGraphEdge[];
}

const pathKey = (value: string) => value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "").toLocaleLowerCase();
const tokenKey = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}_-]+/gu, "");

function entityFromFile(file: WorkspaceGraphFile): { entity: WorkspaceGraphEntity; links: string[] } | null {
  if (!file.content) return null;
  const match = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim().replace(/^(?:"(.*)"|'(.*)')$/, (_, double, single) => double ?? single));
  }
  const id = fields.get("id");
  const title = fields.get("title");
  const type = fields.get("type");
  if (!id || !title || !type) return null;

  const markdown = file.content.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const links = [...markdown.matchAll(/\[\[([^\]]+)\]\]/g)]
    .map(([, raw]) => raw.split("|", 1)[0].split("#", 1)[0].trim())
    .filter(Boolean);
  return { entity: { path: file.path, id, title, type }, links };
}

export function buildWorkspaceGraph(files: WorkspaceGraphFile[]): WorkspaceGraph {
  const parsed = files.map(entityFromFile).filter((item): item is NonNullable<typeof item> => item !== null);
  const nodes = parsed.map(({ entity }) => entity).sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title) || a.path.localeCompare(b.path));
  const byPath = new Map(nodes.map((node) => [node.path, node]));
  const exactPaths = new Map<string, Set<string>>();
  const aliases = new Map<string, Set<string>>();
  const add = (index: Map<string, Set<string>>, key: string, path: string) => {
    const paths = index.get(key) ?? new Set<string>();
    paths.add(path);
    index.set(key, paths);
  };

  for (const node of nodes) {
    add(exactPaths, pathKey(node.path), node.path);
    for (const value of [node.path.split("/").at(-1)?.replace(/\.md$/i, "") ?? "", node.id, node.title]) {
      add(aliases, tokenKey(value), node.path);
    }
  }

  const edges = new Map<string, WorkspaceGraphEdge>();
  for (const { entity, links } of parsed) {
    for (const ref of links) {
      const exact = exactPaths.get(pathKey(ref));
      const candidates = exact?.size ? exact : aliases.get(tokenKey(ref));
      if (!candidates || candidates.size !== 1) continue;
      const target = [...candidates][0];
      if (!byPath.has(target)) continue;
      edges.set(`${entity.path}\n${target}`, { from: entity.path, to: target });
    }
  }

  return { nodes, edges: [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)) };
}
