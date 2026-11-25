/** constellationGraph — Zero-dependency multi-space Knowledge Graph builder and 60fps Force-Directed
 *  Constellation physics engine. Supports entities, regular pages/notes, Markdown & [[wikilinks]],
 *  YAML/inline `#tags`, hub-centered gravity, spring drag elasticity, and cursor-anchored zoom/pan. */
import { categorizePath, friendlyPageTitle, parseDocumentClean } from "./knowledgeFriendly";

export interface GraphSourceFile {
  wsId: string;
  wsSlug?: string;
  wsName: string;
  path: string;
  content: string | null;
}

export type ConstellationNodeType =
  | "person"
  | "meeting"
  | "project"
  | "organization"
  | "task"
  | "topic"
  | "page"
  | "tag";

export interface ConstellationNode {
  id: string;
  path: string;
  wsId: string;
  wsSlug?: string;
  wsName: string;
  title: string;
  type: ConstellationNodeType;
  isTag?: boolean;
  degree: number;
}

export interface ConstellationEdge {
  from: string;
  to: string;
  kind: "wikilink" | "markdown" | "tag";
}

export interface ConstellationGraph {
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
}

export interface BuildConstellationOptions {
  includePages: boolean;
  includeTags: boolean;
  includeSystem?: boolean;
}

export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  degree: number;
  phase: number;
  pinned: boolean;
}

export interface ForceSettings {
  repulsion: number;
  linkDistance: number;
}

const ENTITY_PATH_RE = /^kg\/entities\/([^/]+)\/[^/]+\.md$/i;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const pathKey = (value: string) =>
  value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\.md$/i, "").toLocaleLowerCase();

const tokenKey = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}_-]+/gu, "");

function normalizeEntityType(raw: string): ConstellationNodeType {
  const lower = raw.trim().toLowerCase();
  if (lower === "person") return "person";
  if (lower === "meeting") return "meeting";
  if (lower === "project") return "project";
  if (lower === "company" || lower === "organization" || lower === "org") return "organization";
  if (lower === "task") return "task";
  if (lower === "topic") return "topic";
  return "page";
}

function inferNodeType(path: string, fmType?: string): ConstellationNodeType {
  if (fmType) return normalizeEntityType(fmType);
  const entityMatch = ENTITY_PATH_RE.exec(path);
  if (entityMatch) return normalizeEntityType(entityMatch[1]);
  const cat = categorizePath(path);
  if (cat === "meetings") return "meeting";
  if (cat === "people") return "person";
  if (cat === "projects") return "project";
  if (cat === "tasks") return "task";
  if (cat === "topics") return "topic";
  return "page";
}

function resolveRelativePath(fromPath: string, href: string): string {
  const cleanHref = href.split("#")[0].split("?")[0].trim();
  if (!cleanHref || /^(https?:|mailto:|tel:|data:)/i.test(cleanHref)) return "";
  if (cleanHref.startsWith("/")) return cleanHref.replace(/^\/+/, "");
  const parts = fromPath.split("/").slice(0, -1);
  for (const seg of cleanHref.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function extractTagsFromContent(content: string): string[] {
  const tags = new Set<string>();
  const fmMatch = content.match(FRONTMATTER_RE);
  if (fmMatch) {
    const lines = fmMatch[1].split(/\r?\n/);
    let inTagsBlock = false;
    for (const line of lines) {
      if (/^tags\s*:/i.test(line)) {
        const inline = line.slice(line.indexOf(":") + 1).trim();
        if (inline) {
          const stripped = inline.replace(/^\[|\]$/g, "");
          for (const part of stripped.split(",")) {
            const clean = part.trim().replace(/^['"#]+|['"]+$/g, "").toLowerCase();
            if (clean && clean.length >= 2 && clean.length <= 32) tags.add(clean);
          }
          inTagsBlock = false;
        } else {
          inTagsBlock = true;
        }
        continue;
      }
      if (inTagsBlock) {
        const item = line.match(/^\s*-\s+(.+)$/);
        if (item) {
          const clean = item[1].trim().replace(/^['"#]+|['"]+$/g, "").toLowerCase();
          if (clean && clean.length >= 2 && clean.length <= 32) tags.add(clean);
        } else if (line.trim() && !/^\s/.test(line)) {
          inTagsBlock = false;
        }
      }
    }
  }

  // Strip frontmatter and fenced/inline code before scanning inline #tags
  const body = (fmMatch ? content.slice(fmMatch[0].length) : content)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  for (const m of body.matchAll(/(?:^|[\s(])#([a-zA-Z][a-zA-Z0-9_-]{1,28})\b/g)) {
    const tag = m[1].toLowerCase();
    // Skip hex color codes and generic numbers
    if (/^[0-9a-f]{3,6}$/i.test(tag)) continue;
    tags.add(tag);
  }
  return [...tags].slice(0, 10);
}

/** Build a rich multi-space Constellation graph from Markdown files. */
export function buildConstellationGraph(
  files: GraphSourceFile[],
  options: BuildConstellationOptions,
): ConstellationGraph {
  interface ParsedFile {
    node: ConstellationNode;
    fmId?: string;
    wikilinks: string[];
    mdLinks: string[];
    tags: string[];
  }

  const parsed: ParsedFile[] = [];

  for (const file of files) {
    if (!file.path.toLowerCase().endsWith(".md")) continue;
    const isEntityFile = ENTITY_PATH_RE.test(file.path);
    const cat = categorizePath(file.path);
    if (!options.includeSystem && cat === "system") continue;
    if (!options.includePages && !isEntityFile) continue;

    const raw = file.content ?? "";
    const clean = parseDocumentClean(raw, file.path);
    const fmId = clean.fieldMap.id;
    const fmType = clean.fieldMap.type;

    // When only entities are requested, match strict entity frontmatter contract
    if (!options.includePages && (!fmId || !clean.fieldMap.title || !fmType)) continue;

    const type = inferNodeType(file.path, fmType);
    const title = clean.explicitTitle || friendlyPageTitle(file.path);
    const id = `${file.wsId}:${file.path}`;

    const stripped = raw.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    const wikilinks = [...stripped.matchAll(/\[\[([^\]]+)\]\]/g)]
      .map(([, ref]) => ref.split("|", 1)[0].split("#", 1)[0].trim())
      .filter(Boolean);

    const mdLinks = [...stripped.matchAll(/(?<!!)\[[^\]]+\]\(([^)]+)\)/g)]
      .map(([, href]) => resolveRelativePath(file.path, href))
      .filter(Boolean);

    const tags = options.includeTags ? extractTagsFromContent(raw) : [];

    parsed.push({
      node: {
        id,
        path: file.path,
        wsId: file.wsId,
        wsSlug: file.wsSlug,
        wsName: file.wsName,
        title,
        type,
        degree: 0,
      },
      fmId,
      wikilinks,
      mdLinks,
      tags,
    });
  }

  const nodesById = new Map<string, ConstellationNode>();
  const exactByWs = new Map<string, Set<string>>();
  const exactGlobal = new Map<string, Set<string>>();
  const aliasByWs = new Map<string, Set<string>>();
  const aliasGlobal = new Map<string, Set<string>>();

  const addIndex = (map: Map<string, Set<string>>, key: string, nodeId: string) => {
    if (!key) return;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = new Set();
      map.set(key, bucket);
    }
    bucket.add(nodeId);
  };

  for (const item of parsed) {
    const { node, fmId } = item;
    nodesById.set(node.id, node);
    const pKey = pathKey(node.path);
    addIndex(exactByWs, `${node.wsId}::${pKey}`, node.id);
    addIndex(exactGlobal, pKey, node.id);

    const stem = node.path.split("/").at(-1)?.replace(/\.md$/i, "") ?? "";
    const aliasTerms = [stem, node.title, fmId ?? ""].filter(Boolean);
    for (const term of aliasTerms) {
      const tKey = tokenKey(term);
      addIndex(aliasByWs, `${node.wsId}::${tKey}`, node.id);
      addIndex(aliasGlobal, tKey, node.id);
    }
  }

  const resolveRef = (wsId: string, ref: string): string | null => {
    const pKey = pathKey(ref);
    const sameExact = exactByWs.get(`${wsId}::${pKey}`);
    if (sameExact && sameExact.size === 1) return [...sameExact][0];
    const globExact = exactGlobal.get(pKey);
    if (globExact && globExact.size === 1) return [...globExact][0];

    const tKey = tokenKey(ref);
    const sameAlias = aliasByWs.get(`${wsId}::${tKey}`);
    if (sameAlias && sameAlias.size === 1) return [...sameAlias][0];
    const globAlias = aliasGlobal.get(tKey);
    if (globAlias && globAlias.size === 1) return [...globAlias][0];
    return null;
  };

  const edgeMap = new Map<string, ConstellationEdge>();
  const addEdge = (from: string, to: string, kind: ConstellationEdge["kind"]) => {
    if (from === to) return;
    const key = `${from}\n${to}`;
    if (!edgeMap.has(key)) {
      edgeMap.set(key, { from, to, kind });
    }
  };

  // Track which tags are referenced so we create clean #tag hub nodes
  const tagCounts = new Map<string, Set<string>>();

  for (const item of parsed) {
    for (const ref of item.wikilinks) {
      const target = resolveRef(item.node.wsId, ref);
      if (target) addEdge(item.node.id, target, "wikilink");
    }
    for (const href of item.mdLinks) {
      const target = resolveRef(item.node.wsId, href);
      if (target) addEdge(item.node.id, target, "markdown");
    }
    if (options.includeTags) {
      for (const tag of item.tags) {
        let owners = tagCounts.get(tag);
        if (!owners) {
          owners = new Set();
          tagCounts.set(tag, owners);
        }
        owners.add(item.node.id);
      }
    }
  }

  if (options.includeTags) {
    for (const [tag, owners] of tagCounts.entries()) {
      const tagId = `tag:${tag}`;
      nodesById.set(tagId, {
        id: tagId,
        path: "",
        wsId: "tags",
        wsName: "Tags",
        title: `#${tag}`,
        type: "tag",
        isTag: true,
        degree: 0,
      });
      for (const ownerId of owners) {
        addEdge(ownerId, tagId, "tag");
      }
    }
  }

  const edges = [...edgeMap.values()].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );

  // Compute degree (unique neighbors + edges count)
  const degreeMap = new Map<string, number>();
  for (const id of nodesById.keys()) degreeMap.set(id, 0);
  for (const edge of edges) {
    degreeMap.set(edge.from, (degreeMap.get(edge.from) ?? 0) + 1);
    degreeMap.set(edge.to, (degreeMap.get(edge.to) ?? 0) + 1);
  }

  const nodes = [...nodesById.values()]
    .map((n) => ({ ...n, degree: degreeMap.get(n.id) ?? 0 }))
    .sort((a, b) => b.degree - a.degree || a.type.localeCompare(b.type) || a.title.localeCompare(b.title));

  return { nodes, edges };
}

// ── Deterministic Force-Directed Constellation Physics Engine ─────────────────

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export function starRadiusForDegree(degree: number, isTag = false): number {
  if (isTag) return Math.min(9.5, 3.6 + Math.sqrt(degree) * 1.6);
  return Math.min(18, 4.6 + Math.sqrt(degree) * 3.1);
}

/** Create deterministic seeded initial positions (high-degree hubs near center, leaves on spiral arms). */
export function createInitialSimulation(nodes: ConstellationNode[]): Map<string, SimNode> {
  const sim = new Map<string, SimNode>();
  const goldenAngle = 2.399963229728653;
  const count = Math.max(1, nodes.length);

  nodes.forEach((node, idx) => {
    // Highest-degree nodes start closest to center
    const normRank = idx / count;
    const baseRadius = count <= 6 ? 78 + idx * 24 : 34 + Math.sqrt(idx + 0.5) * 44;
    const angle = idx * goldenAngle + hashString(node.id) * 0.45;
    const r = starRadiusForDegree(node.degree, node.isTag);
    sim.set(node.id, {
      id: node.id,
      x: idx === 0 && node.degree > 0 ? 0 : Math.cos(angle) * baseRadius * (0.85 + normRank * 0.3),
      y: idx === 0 && node.degree > 0 ? 0 : Math.sin(angle) * baseRadius * (0.85 + normRank * 0.3),
      vx: 0,
      vy: 0,
      radius: r,
      degree: node.degree,
      phase: hashString(node.id) * Math.PI * 2,
      pinned: false,
    });
  });

  return sim;
}

/** Advance the force-directed constellation simulation by one tick (returns total kinetic energy). */
export function stepForceSimulation(
  sim: Map<string, SimNode>,
  edges: ConstellationEdge[],
  settings: ForceSettings,
  alpha: number,
): number {
  const list = [...sim.values()];
  const n = list.length;
  if (n === 0) return 0;

  // Deduplicate undirected pairs for balanced spring forces
  const seenUndirected = new Set<string>();
  const springEdges: ConstellationEdge[] = [];
  for (const e of edges) {
    if (!sim.has(e.from) || !sim.has(e.to)) continue;
    const key = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`;
    if (!seenUndirected.has(key)) {
      seenUndirected.add(key);
      springEdges.push(e);
    }
  }

  // 1. Pairwise repulsion + soft collision spacing
  const rep = settings.repulsion;
  for (let i = 0; i < n; i++) {
    const a = list[i];
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let distSq = dx * dx + dy * dy;
      if (distSq < 1) {
        dx = 0.5 + (i % 3) * 0.2;
        dy = -0.5 + (j % 3) * 0.2;
        distSq = dx * dx + dy * dy;
      }
      const dist = Math.sqrt(distSq);
      const hubBoost = 1 + (Math.sqrt(a.degree) + Math.sqrt(b.degree)) * 0.18;
      let force = (rep * hubBoost) / distSq;

      const minDist = a.radius + b.radius + 26;
      if (dist < minDist) {
        force += (minDist - dist) * 0.55;
      }

      const fx = (dx / dist) * force * alpha;
      const fy = (dy / dist) * force * alpha;
      if (!a.pinned) {
        a.vx -= fx;
        a.vy -= fy;
      }
      if (!b.pinned) {
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  // 2. Hooke spring attraction along connections
  for (const edge of springEdges) {
    const a = sim.get(edge.from);
    const b = sim.get(edge.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const targetDist = settings.linkDistance * (edge.kind === "tag" ? 1.18 : 1) + (a.radius + b.radius) * 0.9;
    const stiffness = edge.kind === "tag" ? 0.042 : 0.068;
    const disp = (dist - targetDist) * stiffness * alpha;
    const fx = (dx / dist) * disp;
    const fy = (dy / dist) * disp;
    if (!a.pinned) {
      a.vx += fx;
      a.vy += fy;
    }
    if (!b.pinned) {
      b.vx -= fx;
      b.vy -= fy;
    }
  }

  // 3. Central gravity (pulls connected hubs into the luminous center, lets orphans orbit softly)
  let energy = 0;
  for (const node of list) {
    if (node.pinned) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
    const grav = (node.degree > 0 ? 0.022 + Math.min(0.055, node.degree * 0.006) : 0.009) * alpha;
    node.vx -= node.x * grav;
    node.vy -= node.y * grav;

    // Velocity damping + speed cap to avoid jitter
    node.vx *= 0.82;
    node.vy *= 0.82;
    const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (speed > 26) {
      node.vx = (node.vx / speed) * 26;
      node.vy = (node.vy / speed) * 26;
    }
    node.x += node.vx;
    node.y += node.vy;
    energy += node.vx * node.vx + node.vy * node.vy;
  }

  return energy;
}

/** Warm up the constellation synchronously so the first painted frame is already balanced & majestic. */
export function prewarmSimulation(
  sim: Map<string, SimNode>,
  edges: ConstellationEdge[],
  settings: ForceSettings,
  ticks = 90,
): void {
  let alpha = 1;
  for (let i = 0; i < ticks; i++) {
    stepForceSimulation(sim, edges, settings, alpha);
    alpha *= 0.965;
  }
}

export interface CameraTransform {
  tx: number;
  ty: number;
  scale: number;
}

/** Compute a centered camera transform fitting all visible constellation stars cleanly inside viewport. */
export function computeFitCamera(
  sim: Map<string, SimNode>,
  viewportW: number,
  viewportH: number,
): CameraTransform {
  const list = [...sim.values()];
  if (!list.length || viewportW <= 0 || viewportH <= 0) {
    return { tx: viewportW / 2, ty: viewportH / 2, scale: 1 };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of list) {
    minX = Math.min(minX, n.x - n.radius - 48);
    maxX = Math.max(maxX, n.x + n.radius + 48);
    minY = Math.min(minY, n.y - n.radius - 36);
    maxY = Math.max(maxY, n.y + n.radius + 36);
  }
  const spanW = Math.max(180, maxX - minX);
  const spanH = Math.max(160, maxY - minY);
  const padW = Math.max(120, viewportW - 64);
  const padH = Math.max(120, viewportH - 64);
  const scale = Math.max(0.32, Math.min(1.45, Math.min(padW / spanW, padH / spanH)));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    tx: viewportW / 2 - cx * scale,
    ty: viewportH / 2 - cy * scale,
    scale,
  };
}

/** Hit-test a canvas screen point against simulation nodes (returns closest node id or null). */
export function hitTestSimNode(
  sim: Map<string, SimNode>,
  camera: CameraTransform,
  screenX: number,
  screenY: number,
): string | null {
  const wx = (screenX - camera.tx) / camera.scale;
  const wy = (screenY - camera.ty) / camera.scale;
  let bestId: string | null = null;
  let bestDist = Infinity;
  const minHitWorld = 16 / Math.max(0.35, camera.scale);

  for (const node of sim.values()) {
    const dx = wx - node.x;
    const dy = wy - node.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const hitRadius = Math.max(node.radius + 7, minHitWorld);
    if (dist <= hitRadius && dist < bestDist) {
      bestDist = dist;
      bestId = node.id;
    }
  }
  return bestId;
}
