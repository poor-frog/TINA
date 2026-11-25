"use client";
/** KnowledgeGraphCanvas — Interactive Constellation Knowledge Graph (default) + Columns mode.
 *  - Constellation view: 60fps HTML5 Canvas force-directed star-map with glowing degree-scaled nodes,
 *    luminous filament rays, hover/selection 1-hop star-burst spotlight, draggable spring nodes,
 *    cursor-anchored wheel zoom, drag pan, non-overlapping adaptive labels, and floating legend.
 *  - Data scope: Supports entities, regular pages/notes, Markdown & [[wikilinks]], `#tags`, and All Spaces.
 *  - Display popover (closed by default): Toggle labels, glow, pages, tags, all spaces, gentle motion,
 *    plus Repulsion & Link Length sliders — plus a quick pill toggle to switch to structured Columns view. */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type WheelEvent,
} from "react";
import { WebIcon } from "./Icons";
import { friendlyEntityLaneLabel, friendlyEntityType } from "./knowledgeFriendly";
import {
  buildConstellationGraph,
  computeFitCamera,
  createInitialSimulation,
  hitTestSimNode,
  prewarmSimulation,
  stepForceSimulation,
  type CameraTransform,
  type ConstellationGraph,
  type ConstellationNode,
  type ConstellationNodeType,
  type GraphSourceFile,
  type SimNode,
} from "./constellationGraph";
import { listWorkspaceTree, readWorkspaceFile } from "../surfaces/workspaceApi";
import { presentError } from "../surfaces/apiClient";
import styles from "./knowledgeView.module.css";

export interface GraphSpaceOption {
  id: string;
  slug?: string;
  name: string;
}

type GraphViewMode = "constellation" | "columns";

const BATCH_SIZE = 10;
const MAX_FILES_PER_SPACE = 160;
const NODE_WIDTH = 192;
const NODE_HEIGHT = 48;
const LANE_STEP = 252;
const ROW_STEP = 74;

/** Luminous starlight palette harmonized with Obsidian/Cosmic Constellation reference (Dark & Light). */
const STAR_COLORS_DARK: Record<ConstellationNodeType, string> = {
  person: "#67e8f9",
  meeting: "#5eead4",
  project: "#7dd3fc",
  organization: "#a5b4fc",
  task: "#86efac",
  topic: "#c4b5fd",
  page: "#bae6fd",
  tag: "#818cf8",
};

const STAR_COLORS_LIGHT: Record<ConstellationNodeType, string> = {
  person: "#0284c7",
  meeting: "#0f766e",
  project: "#0369a1",
  organization: "#4f46e5",
  task: "#15803d",
  topic: "#7c3aed",
  page: "#334155",
  tag: "#6366f1",
};

interface Position {
  x: number;
  y: number;
}

function edgePath(from: Position, to: Position): string {
  const fromY = from.y + NODE_HEIGHT / 2;
  const toY = to.y + NODE_HEIGHT / 2;
  if (from.x === to.x) {
    const bend = from.x - 46;
    return `M ${from.x} ${fromY} C ${bend} ${fromY}, ${bend} ${toY}, ${from.x} ${toY}`;
  }
  if (from.x < to.x) {
    const gap = to.x - (from.x + NODE_WIDTH);
    const bend = Math.max(30, gap / 2);
    return `M ${from.x + NODE_WIDTH} ${fromY} C ${from.x + NODE_WIDTH + bend} ${fromY}, ${to.x - bend} ${toY}, ${to.x} ${toY}`;
  }
  const gap = from.x - (to.x + NODE_WIDTH);
  const bend = Math.max(30, gap / 2);
  return `M ${from.x} ${fromY} C ${from.x - bend} ${fromY}, ${to.x + NODE_WIDTH + bend} ${toY}, ${to.x + NODE_WIDTH} ${toY}`;
}

function nodeMatches(node: ConstellationNode, needle: string): boolean {
  if (!needle) return true;
  return `${node.title} ${node.type} ${friendlyEntityType(node.type)} ${node.path} ${node.wsName}`
    .toLocaleLowerCase()
    .includes(needle);
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Deterministic micro-starfield dust specks for atmospheric cosmic canvas depth. */
const AMBIENT_DUST = Array.from({ length: 68 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 24634.6345;
  const c = Math.sin(i * 39.425) * 18392.1923;
  return {
    nx: a - Math.floor(a),
    ny: b - Math.floor(b),
    r: 0.55 + (c - Math.floor(c)) * 1.15,
    alpha: 0.08 + (c - Math.floor(c)) * 0.22,
  };
});

export function KnowledgeGraphCanvas({
  activeSpaceId = "personal",
  slug,
  workspaceName,
  availableSpaces,
  isReadOnly,
  devView = false,
  externalRefreshKey = 0,
  onOpenDocument,
  onAskTina,
  onCreateEntity,
}: {
  activeSpaceId?: string;
  slug?: string;
  workspaceName: string;
  availableSpaces?: GraphSpaceOption[];
  isReadOnly: boolean;
  devView?: boolean;
  externalRefreshKey?: number;
  onOpenDocument: (path: string, wsId?: string) => void;
  onAskTina: (prompt: string) => void;
  onCreateEntity?: () => void;
}) {
  const markerBase = `wkg-${useId().replace(/:/g, "")}`;
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const columnsWrapRef = useRef<HTMLDivElement>(null);

  // ── Display & layout settings ────────────────────────────────────────
  const [viewMode, setViewMode] = useState<GraphViewMode>("constellation");
  const [displayOpen, setDisplayOpen] = useState(false);
  const [includePages, setIncludePages] = useState(true);
  const [includeTags, setIncludeTags] = useState(true);
  const [allSpaces, setAllSpaces] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [glowEnabled, setGlowEnabled] = useState(true);
  const [ambientMotion, setAmbientMotion] = useState(true);
  const [repulsion, setRepulsion] = useState(2200);
  const [linkDistance, setLinkDistance] = useState(98);

  // ── Data & filters state ─────────────────────────────────────────────
  const [rawFiles, setRawFiles] = useState<GraphSourceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState("");
  const [activeType, setActiveType] = useState<string>("all");
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [focusSelected, setFocusSelected] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [columnsZoom, setColumnsZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [isLightTheme, setIsLightTheme] = useState(() =>
    typeof document !== "undefined" && document.documentElement.dataset.theme === "light",
  );

  // ── Live simulation & camera refs (kept in refs for 60fps canvas loop) ─
  const simRef = useRef<Map<string, SimNode>>(new Map());
  const cameraRef = useRef<CameraTransform>({ tx: 360, ty: 240, scale: 1 });
  const alphaRef = useRef<number>(0);
  const dragNodeRef = useRef<{ id: string; moved: boolean } | null>(null);
  const panCanvasRef = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const columnsPanRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const lastClickRef = useRef<{ id: string; time: number } | null>(null);
  const viewportRef = useRef<{ w: number; h: number }>({ w: 720, h: 480 });

  // Track light/dark theme dynamically
  useEffect(() => {
    if (typeof document === "undefined") return;
    const syncTheme = () => setIsLightTheme(document.documentElement.dataset.theme === "light");
    syncTheme();
    const obs = new MutationObserver(syncTheme);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // Close Display popover on Escape or outside click
  useEffect(() => {
    if (!displayOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDisplayOpen(false);
    };
    const onClick = () => setDisplayOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [displayOpen]);

  // ── Load Markdown files from active space OR all spaces ──────────────
  const spacesToLoad = useMemo<GraphSpaceOption[]>(() => {
    if (allSpaces && availableSpaces && availableSpaces.length > 0) {
      return availableSpaces;
    }
    return [{ id: activeSpaceId, slug, name: workspaceName }];
  }, [allSpaces, availableSpaces, activeSpaceId, slug, workspaceName]);

  const spacesKey = useMemo(
    () => spacesToLoad.map((s) => `${s.id}:${s.slug ?? ""}`).join("|"),
    [spacesToLoad],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setActiveType("all");
    setUnlinkedOnly(false);
    setFocusSelected(false);

    void (async () => {
      const collected: GraphSourceFile[] = [];
      for (const space of spacesToLoad) {
        const opts = space.slug ? { slug: space.slug } : undefined;
        let tree: string[] = [];
        try {
          tree = await listWorkspaceTree(opts);
        } catch {
          if (!allSpaces) throw new Error(`Could not list files in ${space.name}.`);
          continue;
        }
        const mdPaths = tree.filter((p) => p.toLowerCase().endsWith(".md")).slice(0, MAX_FILES_PER_SPACE);
        for (let offset = 0; offset < mdPaths.length; offset += BATCH_SIZE) {
          const batch = await Promise.all(
            mdPaths.slice(offset, offset + BATCH_SIZE).map(async (path) => ({
              wsId: space.id,
              wsSlug: space.slug,
              wsName: space.name,
              path,
              content: await readWorkspaceFile(path, opts).catch(() => null),
            })),
          );
          if (!alive) return;
          collected.push(...batch);
        }
      }
      if (alive) setRawFiles(collected);
    })()
      .catch((err: unknown) => {
        if (alive) setError(presentError(err).headline);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [spacesKey, allSpaces, refreshKey, externalRefreshKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Build Constellation Graph reactively from loaded files ───────────
  const graph = useMemo<ConstellationGraph>(
    () =>
      buildConstellationGraph(rawFiles, {
        includePages,
        includeTags,
        includeSystem: devView,
      }),
    [rawFiles, includePages, includeTags, devView],
  );

  const unlinkedCount = useMemo(
    () => graph.nodes.filter((n) => n.degree === 0).length,
    [graph],
  );

  const neighborSet = useMemo(() => {
    if (!focusSelected || !selectedId) return null;
    const set = new Set<string>([selectedId]);
    for (const edge of graph.edges) {
      if (edge.from === selectedId) set.add(edge.to);
      if (edge.to === selectedId) set.add(edge.from);
    }
    return set;
  }, [focusSelected, selectedId, graph]);

  const allTypes = useMemo(() => {
    const counts = new Map<ConstellationNodeType, number>();
    for (const node of graph.nodes) {
      counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [graph]);

  const visibleNodes = useMemo(() => {
    let nodes = graph.nodes;
    if (activeType !== "all") nodes = nodes.filter((n) => n.type === activeType);
    if (unlinkedOnly) nodes = nodes.filter((n) => n.degree === 0);
    if (neighborSet) nodes = nodes.filter((n) => neighborSet.has(n.id));
    return nodes;
  }, [graph, activeType, unlinkedOnly, neighborSet]);

  const needle = query.trim().toLocaleLowerCase();
  const matchingIds = useMemo(
    () => new Set(visibleNodes.filter((n) => nodeMatches(n, needle)).map((n) => n.id)),
    [visibleNodes, needle],
  );

  useEffect(() => {
    if (!visibleNodes.length) {
      if (!focusSelected) setSelectedId(null);
      return;
    }
    if (!selectedId || !visibleNodes.some((n) => n.id === selectedId)) {
      setSelectedId([...matchingIds][0] ?? visibleNodes[0]?.id ?? null);
    }
  }, [visibleNodes, matchingIds, selectedId, focusSelected]);

  const visibleIdSet = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => graph.edges.filter((e) => visibleIdSet.has(e.from) && visibleIdSet.has(e.to)),
    [graph, visibleIdSet],
  );

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const selected = (selectedId ? byId.get(selectedId) : null) ?? null;

  const linksTo = useMemo(
    () =>
      graph.edges
        .filter((e) => e.from === selectedId)
        .map((e) => byId.get(e.to))
        .filter((n): n is ConstellationNode => Boolean(n)),
    [graph, selectedId, byId],
  );
  const linkedFrom = useMemo(
    () =>
      graph.edges
        .filter((e) => e.to === selectedId)
        .map((e) => byId.get(e.from))
        .filter((n): n is ConstellationNode => Boolean(n)),
    [graph, selectedId, byId],
  );

  // ── Fit to View helper ───────────────────────────────────────────────
  const fitConstellation = useCallback(() => {
    const wrap = canvasWrapRef.current;
    const w = wrap?.clientWidth || viewportRef.current.w || 720;
    const h = wrap?.clientHeight || viewportRef.current.h || 480;
    viewportRef.current = { w, h };
    const cam = computeFitCamera(simRef.current, w, h);
    cameraRef.current = cam;
    setZoomPercent(Math.round(cam.scale * 100));
  }, []);

  // Re-initialize & pre-warm physics whenever visible graph topology changes
  const topologySig = useMemo(
    () => visibleNodes.map((n) => `${n.id}:${n.degree}`).join(","),
    [visibleNodes],
  );

  useEffect(() => {
    const sim = createInitialSimulation(visibleNodes);
    prewarmSimulation(sim, visibleEdges, { repulsion, linkDistance }, 95);
    simRef.current = sim;
    alphaRef.current = 0.28;
    fitConstellation();
  }, [topologySig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reheat physics smoothly when Repulsion / Link Length sliders move
  useEffect(() => {
    if (simRef.current.size > 0) {
      alphaRef.current = Math.max(alphaRef.current, 0.45);
    }
  }, [repulsion, linkDistance]);

  // ── Columns mode layout (optional structured lane view) ──────────────
  const lanes = useMemo(() => {
    const byType = new Map<ConstellationNodeType, ConstellationNode[]>();
    for (const node of visibleNodes) {
      byType.set(node.type, [...(byType.get(node.type) ?? []), node]);
    }
    return [...byType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, nodes]) => ({
        type,
        nodes: [...nodes].sort(
          (a, b) =>
            Number(matchingIds.has(b.id)) - Number(matchingIds.has(a.id)) ||
            a.title.localeCompare(b.title),
        ),
      }));
  }, [visibleNodes, matchingIds]);

  const columnPositions = useMemo(() => {
    const pos = new Map<string, Position>();
    lanes.forEach((lane, laneIdx) => {
      lane.nodes.forEach((node, rowIdx) => {
        pos.set(node.id, { x: 36 + laneIdx * LANE_STEP, y: 60 + rowIdx * ROW_STEP });
      });
    });
    return pos;
  }, [lanes]);

  const rawWidth = Math.max(620, 36 + Math.max(0, lanes.length - 1) * LANE_STEP + NODE_WIDTH + 40);
  const rawHeight = Math.max(380, 108 + Math.max(0, ...lanes.map((l) => l.nodes.length)) * ROW_STEP);

  const handleFitToView = useCallback(() => {
    if (viewMode === "constellation") {
      fitConstellation();
      return;
    }
    const el = columnsWrapRef.current;
    if (!el) return;
    const availW = Math.max(320, el.clientWidth - 24);
    const availH = Math.max(260, el.clientHeight - 24);
    const next = Math.min(availW / rawWidth, availH / rawHeight, 1.15);
    setColumnsZoom(Math.max(0.45, Number(next.toFixed(2))));
    el.scrollTo?.({ left: 0, top: 0, behavior: "smooth" });
  }, [viewMode, fitConstellation, rawWidth, rawHeight]);

  const stepZoom = useCallback(
    (factor: number) => {
      if (viewMode === "columns") {
        setColumnsZoom((z) => Math.max(0.45, Math.min(1.45, Number((z * factor).toFixed(2)))));
        return;
      }
      const { w, h } = viewportRef.current;
      const cam = cameraRef.current;
      const nextScale = Math.max(0.25, Math.min(3.2, cam.scale * factor));
      const cx = w / 2;
      const cy = h / 2;
      const wx = (cx - cam.tx) / cam.scale;
      const wy = (cy - cam.ty) / cam.scale;
      cameraRef.current = {
        scale: nextScale,
        tx: cx - wx * nextScale,
        ty: cy - wy * nextScale,
      };
      setZoomPercent(Math.round(nextScale * 100));
    },
    [viewMode],
  );

  // ── 60fps Constellation HTML5 Canvas Animation & Paint Loop ──────────
  const renderStateRef = useRef({
    visibleNodes,
    visibleEdges,
    selectedId,
    hoveredId,
    matchingIds,
    needle,
    showLabels,
    glowEnabled,
    ambientMotion,
    repulsion,
    linkDistance,
    isLightTheme,
  });
  renderStateRef.current = {
    visibleNodes,
    visibleEdges,
    selectedId,
    hoveredId,
    matchingIds,
    needle,
    showLabels,
    glowEnabled,
    ambientMotion,
    repulsion,
    linkDistance,
    isLightTheme,
  };

  useEffect(() => {
    if (viewMode !== "constellation" || loading || error || visibleNodes.length === 0) return;
    const wrap = canvasWrapRef.current;
    const canvas = canvasElRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;

    const syncCanvasSize = () => {
      const w = Math.max(300, wrap.clientWidth || 720);
      const h = Math.max(280, wrap.clientHeight || 480);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      viewportRef.current = { w, h };
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      return { w, h, dpr };
    };

    syncCanvasSize();
    const ro = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => {
          syncCanvasSize();
        })
      : null;
    ro?.observe(wrap);

    let rafId = 0;
    const startMs = performance.now();

    const frame = (now: number) => {
      const { w, h, dpr } = syncCanvasSize();
      const st = renderStateRef.current;
      const sim = simRef.current;
      const cam = cameraRef.current;

      // Advance force simulation while warm or dragging
      if (alphaRef.current > 0.004 || dragNodeRef.current) {
        const activeAlpha = dragNodeRef.current ? Math.max(alphaRef.current, 0.22) : alphaRef.current;
        stepForceSimulation(sim, st.visibleEdges, { repulsion: st.repulsion, linkDistance: st.linkDistance }, activeAlpha);
        if (!dragNodeRef.current) {
          alphaRef.current *= 0.965;
          if (alphaRef.current < 0.004) alphaRef.current = 0;
        }
      }

      const t = (now - startMs) * 0.001;
      const palette = st.isLightTheme ? STAR_COLORS_LIGHT : STAR_COLORS_DARK;
      const focusId = st.hoveredId ?? st.selectedId;

      // Determine highlighted 1-hop neighborhood around hovered/selected star
      const focusNeighbors = new Set<string>();
      if (focusId) {
        focusNeighbors.add(focusId);
        for (const e of st.visibleEdges) {
          if (e.from === focusId) focusNeighbors.add(e.to);
          if (e.to === focusId) focusNeighbors.add(e.from);
        }
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 1. Deep Cosmic Obsidian / Crisp Light Background
      if (st.isLightTheme) {
        ctx.fillStyle = "#f4f7fb";
        ctx.fillRect(0, 0, w, h);
        const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.45, 20, w * 0.5, h * 0.5, Math.max(w, h) * 0.65);
        bgGrad.addColorStop(0, "rgba(14, 116, 144, 0.07)");
        bgGrad.addColorStop(1, "rgba(244, 247, 251, 0)");
        ctx.fillStyle = bgGrad;
        ctx.fillRect(0, 0, w, h);
      } else {
        ctx.fillStyle = "#04070c";
        ctx.fillRect(0, 0, w, h);
        const nebula = ctx.createRadialGradient(w * 0.5, h * 0.48, 12, w * 0.5, h * 0.5, Math.max(w, h) * 0.62);
        nebula.addColorStop(0, "rgba(26, 94, 118, 0.22)");
        nebula.addColorStop(0.45, "rgba(13, 36, 56, 0.14)");
        nebula.addColorStop(1, "rgba(4, 7, 12, 0)");
        ctx.fillStyle = nebula;
        ctx.fillRect(0, 0, w, h);

        // Subtle distant background star dust
        for (const speck of AMBIENT_DUST) {
          const sx = speck.nx * w;
          const sy = speck.ny * h;
          const twinkle = st.ambientMotion ? 0.72 + 0.28 * Math.sin(t * 0.9 + speck.nx * 14) : 1;
          ctx.fillStyle = `rgba(186, 230, 253, ${(speck.alpha * twinkle).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx, sy, speck.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Compute rendered screen coordinates (with optional gentle orbital breathing)
      const screenPos = new Map<string, { x: number; y: number; r: number }>();
      for (const node of st.visibleNodes) {
        const sn = sim.get(node.id);
        if (!sn) continue;
        const driftX = st.ambientMotion && !sn.pinned ? Math.cos(t * 0.65 + sn.phase) * 1.1 : 0;
        const driftY = st.ambientMotion && !sn.pinned ? Math.sin(t * 0.55 + sn.phase * 1.3) * 1.1 : 0;
        screenPos.set(node.id, {
          x: (sn.x + driftX) * cam.scale + cam.tx,
          y: (sn.y + driftY) * cam.scale + cam.ty,
          r: Math.max(2.8, sn.radius * Math.pow(cam.scale, 0.68)),
        });
      }

      // 2. Draw Luminous Connecting Filaments
      ctx.lineCap = "round";
      for (const edge of st.visibleEdges) {
        const a = screenPos.get(edge.from);
        const b = screenPos.get(edge.to);
        if (!a || !b) continue;
        const touchesFocus = Boolean(focusId && (edge.from === focusId || edge.to === focusId));
        const isDimmed = Boolean(
          (focusId && !touchesFocus) ||
            (st.needle && !st.matchingIds.has(edge.from) && !st.matchingIds.has(edge.to)),
        );

        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);

        if (touchesFocus) {
          ctx.strokeStyle = st.isLightTheme
            ? "rgba(14, 116, 144, 0.85)"
            : edge.kind === "tag"
              ? "rgba(196, 181, 253, 0.82)"
              : "rgba(165, 243, 252, 0.88)";
          ctx.lineWidth = 1.65;
          if (st.glowEnabled && !st.isLightTheme) {
            ctx.shadowColor = "rgba(103, 232, 249, 0.85)";
            ctx.shadowBlur = 10;
          }
        } else if (isDimmed) {
          ctx.strokeStyle = st.isLightTheme ? "rgba(100, 116, 139, 0.1)" : "rgba(125, 211, 252, 0.06)";
          ctx.lineWidth = 0.7;
          ctx.shadowBlur = 0;
        } else {
          ctx.strokeStyle = st.isLightTheme
            ? edge.kind === "tag"
              ? "rgba(99, 102, 241, 0.24)"
              : "rgba(14, 116, 144, 0.26)"
            : edge.kind === "tag"
              ? "rgba(165, 180, 252, 0.22)"
              : "rgba(125, 211, 252, 0.28)";
          ctx.lineWidth = 0.95;
          ctx.shadowBlur = 0;
        }
        ctx.stroke();
        ctx.shadowBlur = 0;
      }

      // 3. Draw Glowing Star Nodes (outer radial bloom + star body + bright incandescent core)
      for (const node of st.visibleNodes) {
        const pos = screenPos.get(node.id);
        if (!pos) continue;
        const isSel = node.id === st.selectedId;
        const isHov = node.id === st.hoveredId;
        const isNeighbor = Boolean(focusId && focusNeighbors.has(node.id));
        const isDimmed = Boolean(
          (focusId && !isNeighbor) || (st.needle && !st.matchingIds.has(node.id)),
        );
        const baseColor = palette[node.type] ?? palette.page;
        const alpha = isDimmed ? 0.16 : 1;

        // Wide radial constellation halo
        if (st.glowEnabled && !isDimmed) {
          const haloMult = isSel || isHov ? 4.4 : node.degree >= 3 ? 3.5 : 2.8;
          const haloR = pos.r * haloMult;
          const grad = ctx.createRadialGradient(pos.x, pos.y, pos.r * 0.2, pos.x, pos.y, haloR);
          const haloAlpha = st.isLightTheme
            ? isSel || isHov
              ? 0.28
              : 0.14
            : isSel || isHov
              ? 0.62
              : node.degree >= 3
                ? 0.42
                : 0.26;
          grad.addColorStop(0, hexToRgba(baseColor, haloAlpha));
          grad.addColorStop(0.5, hexToRgba(baseColor, haloAlpha * 0.3));
          grad.addColorStop(1, hexToRgba(baseColor, 0));
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, haloR, 0, Math.PI * 2);
          ctx.fill();
        }

        // Main star body
        ctx.fillStyle = hexToRgba(baseColor, alpha);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, pos.r, 0, Math.PI * 2);
        ctx.fill();

        // Bright white hot core (gives the crisp sparkling star-map look from the reference image)
        if (!st.isLightTheme && !isDimmed) {
          ctx.fillStyle = isSel || isHov ? "#ffffff" : "rgba(255, 255, 255, 0.84)";
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, Math.max(1.4, pos.r * (isSel || isHov ? 0.56 : 0.44)), 0, Math.PI * 2);
          ctx.fill();
        }

        // Subtle ring on selected or hovered star
        if (isSel || isHov) {
          ctx.strokeStyle = st.isLightTheme ? baseColor : "#e0f2fe";
          ctx.lineWidth = isSel ? 1.8 : 1.2;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, pos.r + 4.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // 4. Adaptive Non-Overlapping Floating Labels
      if (st.showLabels) {
        const placedBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
        const showAllAtZoom = st.visibleNodes.length <= 36 || cam.scale >= 1.1;

        // Sort so hovered, selected, search hits, and high-degree hubs claim label space first
        const labelOrder = [...st.visibleNodes].sort((a, b) => {
          const score = (n: ConstellationNode) =>
            (n.id === st.hoveredId ? 1000 : 0) +
            (n.id === st.selectedId ? 900 : 0) +
            (focusNeighbors.has(n.id) ? 300 : 0) +
            (st.needle && st.matchingIds.has(n.id) ? 250 : 0) +
            n.degree * 10;
          return score(b) - score(a);
        });

        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        for (const node of labelOrder) {
          const pos = screenPos.get(node.id);
          if (!pos) continue;
          const isImportant =
            node.id === st.hoveredId ||
            node.id === st.selectedId ||
            (focusId && focusNeighbors.has(node.id)) ||
            (st.needle && st.matchingIds.has(node.id));
          if (!isImportant && !showAllAtZoom && node.degree < 2) continue;

          const isDimmed = Boolean(
            (focusId && !focusNeighbors.has(node.id)) || (st.needle && !st.matchingIds.has(node.id)),
          );
          if (isDimmed && !showAllAtZoom) continue;

          const text = node.title.length > 26 ? `${node.title.slice(0, 25)}…` : node.title;
          const fontSize = isImportant ? 12 : node.degree >= 4 ? 11.5 : 10.5;
          ctx.font = `${isImportant || node.degree >= 4 ? 600 : 500} ${fontSize}px -apple-system, BlinkMacSystemFont, "Inter", sans-serif`;
          const textW = ctx.measureText(text).width;
          const lx = pos.x;
          const ly = pos.y + pos.r + 6;
          const box = { x1: lx - textW / 2 - 4, y1: ly - 1, x2: lx + textW / 2 + 4, y2: ly + fontSize + 4 };

          // Skip overlapping labels unless this is the actively hovered/selected star
          if (!isImportant) {
            const overlaps = placedBoxes.some(
              (b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2),
            );
            if (overlaps) continue;
          }
          placedBoxes.push(box);

          if (!st.isLightTheme) {
            ctx.fillStyle = isDimmed ? "rgba(4, 7, 12, 0.25)" : "rgba(4, 7, 12, 0.68)";
            ctx.fillRect(box.x1, box.y1, box.x2 - box.x1, box.y2 - box.y1);
          }

          ctx.fillStyle = st.isLightTheme
            ? isDimmed
              ? "rgba(51, 65, 85, 0.25)"
              : isImportant
                ? "#0f172a"
                : "#334155"
            : isDimmed
              ? "rgba(226, 232, 240, 0.24)"
              : isImportant
                ? "#f8fafc"
                : "rgba(224, 242, 254, 0.86)";
          ctx.fillText(text, lx, ly);
        }
      }

      ctx.restore();
      rafId = window.requestAnimationFrame(frame);
    };

    rafId = window.requestAnimationFrame(frame);
    return () => {
      window.cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, [viewMode, loading, error, visibleNodes.length]);

  // ── Canvas Pointer & Wheel Interaction Handlers ──────────────────────
  const localPoint = (e: PointerEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleCanvasPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);
    const hitId = hitTestSimNode(simRef.current, cameraRef.current, x, y);
    e.currentTarget.setPointerCapture?.(e.pointerId);

    if (hitId) {
      const sn = simRef.current.get(hitId);
      if (sn) sn.pinned = true;
      dragNodeRef.current = { id: hitId, moved: false };
      setSelectedId(hitId);
      alphaRef.current = Math.max(alphaRef.current, 0.35);
      return;
    }

    panCanvasRef.current = {
      x: e.clientX,
      y: e.clientY,
      tx: cameraRef.current.tx,
      ty: cameraRef.current.ty,
    };
    setPanning(true);
  };

  const handleCanvasPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);

    if (dragNodeRef.current) {
      const sn = simRef.current.get(dragNodeRef.current.id);
      if (sn) {
        const cam = cameraRef.current;
        const wx = (x - cam.tx) / cam.scale;
        const wy = (y - cam.ty) / cam.scale;
        if (Math.hypot(wx - sn.x, wy - sn.y) > 3) dragNodeRef.current.moved = true;
        sn.x = wx;
        sn.y = wy;
        sn.vx = 0;
        sn.vy = 0;
      }
      return;
    }

    if (panCanvasRef.current) {
      cameraRef.current = {
        ...cameraRef.current,
        tx: panCanvasRef.current.tx + (e.clientX - panCanvasRef.current.x),
        ty: panCanvasRef.current.ty + (e.clientY - panCanvasRef.current.y),
      };
      return;
    }

    const hitId = hitTestSimNode(simRef.current, cameraRef.current, x, y);
    if (hitId !== hoveredId) setHoveredId(hitId);
  };

  const handleCanvasPointerUp = () => {
    if (dragNodeRef.current) {
      const { id, moved } = dragNodeRef.current;
      const sn = simRef.current.get(id);
      if (sn) sn.pinned = false;
      dragNodeRef.current = null;

      if (!moved) {
        const now = Date.now();
        if (lastClickRef.current && lastClickRef.current.id === id && now - lastClickRef.current.time < 340) {
          const node = byId.get(id);
          if (node && !node.isTag && node.path) {
            onOpenDocument(node.path, node.wsId);
          } else if (node?.isTag) {
            setFocusSelected((v) => !v);
          }
          lastClickRef.current = null;
        } else {
          lastClickRef.current = { id, time: now };
        }
      }
      return;
    }
    panCanvasRef.current = null;
    setPanning(false);
  };

  const handleCanvasWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = localPoint(e);
    const cam = cameraRef.current;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const nextScale = Math.max(0.25, Math.min(3.2, cam.scale * factor));
    const wx = (x - cam.tx) / cam.scale;
    const wy = (y - cam.ty) / cam.scale;
    cameraRef.current = {
      scale: nextScale,
      tx: x - wx * nextScale,
      ty: y - wy * nextScale,
    };
    setZoomPercent(Math.round(nextScale * 100));
  };

  // Columns view pan handlers
  const handleColumnsPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-graph-node]")) return;
    const el = columnsWrapRef.current;
    if (!el) return;
    columnsPanRef.current = {
      x: e.clientX,
      y: e.clientY,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
    };
    setPanning(true);
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const handleColumnsPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const pan = columnsPanRef.current;
    const el = columnsWrapRef.current;
    if (!pan || !el) return;
    el.scrollLeft = pan.scrollLeft - (e.clientX - pan.x);
    el.scrollTop = pan.scrollTop - (e.clientY - pan.y);
  };

  const handleColumnsPointerUp = () => {
    columnsPanRef.current = null;
    setPanning(false);
  };

  const activePalette = isLightTheme ? STAR_COLORS_LIGHT : STAR_COLORS_DARK;
  const displayZoomLabel = viewMode === "constellation" ? `${zoomPercent}%` : `${Math.round(columnsZoom * 100)}%`;

  return (
    <section className={styles.graphShell} aria-label="Connections map">
      <div className={styles.graphToolbar}>
        <div className={styles.searchBox} style={{ width: 200 }}>
          <WebIcon name="search" size={14} />
          <input
            type="search"
            aria-label="Filter connections map"
            placeholder="Find a page, person, tag…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className={styles.chipRow} style={{ marginTop: 0 }}>
          <button
            type="button"
            className={`${styles.chip} ${activeType === "all" && !unlinkedOnly ? styles.chipActive : ""}`}
            onClick={() => {
              setActiveType("all");
              setUnlinkedOnly(false);
            }}
          >
            All ({graph.nodes.length})
          </button>
          {allTypes.map(([type, count]) => (
            <button
              key={type}
              type="button"
              className={`${styles.chip} ${activeType === type ? styles.chipActive : ""}`}
              onClick={() => {
                setActiveType(type);
                setUnlinkedOnly(false);
              }}
            >
              {friendlyEntityLaneLabel(type)} ({count})
            </button>
          ))}
          <button
            type="button"
            className={`${styles.chip} ${unlinkedOnly ? styles.chipActive : ""}`}
            onClick={() => {
              setUnlinkedOnly((v) => !v);
              setFocusSelected(false);
            }}
            title="Show pages that aren't linked to anything yet"
          >
            Unlinked ({unlinkedCount})
          </button>
          <button
            type="button"
            className={`${styles.chip} ${focusSelected ? styles.chipActive : ""}`}
            disabled={!selectedId}
            onClick={() => {
              setFocusSelected((v) => !v);
              setUnlinkedOnly(false);
            }}
            title="Focus on the selected item and its direct connections"
          >
            Focus selected
          </button>
        </div>

        <div className={styles.graphZoom}>
          {/* Constellation / Columns View Switcher */}
          <div className={styles.tabs} style={{ padding: 2 }} role="group" aria-label="Graph layout">
            <button
              type="button"
              aria-pressed={viewMode === "constellation"}
              className={`${styles.tabBtn} ${viewMode === "constellation" ? styles.tabBtnActive : ""}`}
              style={{ height: 24, padding: "0 9px", fontSize: 11.5 }}
              onClick={() => setViewMode("constellation")}
            >
              <WebIcon name="sparkleSmall" size={12} />
              <span>Constellation</span>
            </button>
            <button
              type="button"
              aria-pressed={viewMode === "columns"}
              className={`${styles.tabBtn} ${viewMode === "columns" ? styles.tabBtnActive : ""}`}
              style={{ height: 24, padding: "0 9px", fontSize: 11.5 }}
              onClick={() => setViewMode("columns")}
            >
              <WebIcon name="layers" size={12} />
              <span>Columns</span>
            </button>
          </div>

          {/* Collapsible Obsidian-Style Display Popover */}
          <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={`${styles.tinyBtn} ${displayOpen ? styles.chipActive : ""}`}
              aria-haspopup="dialog"
              aria-expanded={displayOpen}
              onClick={() => setDisplayOpen((v) => !v)}
            >
              <WebIcon name="sliders" size={12} />
              <span>Display</span>
            </button>

            {displayOpen && (
              <div className={styles.graphDisplayPopover} role="dialog" aria-label="Graph display settings">
                <div className={styles.displayGroupTitle}>Data</div>
                <label className={styles.displayToggle}>
                  <input
                    type="checkbox"
                    checked={includePages}
                    onChange={(e) => setIncludePages(e.target.checked)}
                  />
                  <span>Include pages &amp; notes</span>
                </label>
                <label className={styles.displayToggle}>
                  <input
                    type="checkbox"
                    checked={includeTags}
                    onChange={(e) => setIncludeTags(e.target.checked)}
                  />
                  <span>Show #tags</span>
                </label>
                {availableSpaces && availableSpaces.length > 1 && (
                  <label className={styles.displayToggle}>
                    <input
                      type="checkbox"
                      checked={allSpaces}
                      onChange={(e) => setAllSpaces(e.target.checked)}
                    />
                    <span>Show all spaces ({availableSpaces.length})</span>
                  </label>
                )}

                <div className={styles.wsDropdownDivider} />
                <div className={styles.displayGroupTitle}>Appearance</div>
                <label className={styles.displayToggle}>
                  <input
                    type="checkbox"
                    checked={showLabels}
                    onChange={(e) => setShowLabels(e.target.checked)}
                  />
                  <span>Show labels</span>
                </label>
                <label className={styles.displayToggle}>
                  <input
                    type="checkbox"
                    checked={glowEnabled}
                    onChange={(e) => setGlowEnabled(e.target.checked)}
                  />
                  <span>Star glow effect</span>
                </label>
                <label className={styles.displayToggle}>
                  <input
                    type="checkbox"
                    checked={ambientMotion}
                    onChange={(e) => setAmbientMotion(e.target.checked)}
                  />
                  <span>Gentle motion</span>
                </label>

                {viewMode === "constellation" && (
                  <>
                    <div className={styles.wsDropdownDivider} />
                    <div className={styles.displayGroupTitle}>Physics</div>
                    <label className={styles.displaySlider}>
                      <span>Spacing</span>
                      <input
                        type="range"
                        aria-label="Node spacing"
                        min={900}
                        max={4800}
                        step={100}
                        value={repulsion}
                        onChange={(e) => setRepulsion(Number(e.target.value))}
                      />
                    </label>
                    <label className={styles.displaySlider}>
                      <span>Link length</span>
                      <input
                        type="range"
                        aria-label="Link length"
                        min={55}
                        max={180}
                        step={5}
                        value={linkDistance}
                        onChange={(e) => setLinkDistance(Number(e.target.value))}
                      />
                    </label>
                  </>
                )}
              </div>
            )}
          </div>

          <span className={styles.graphStats}>
            {visibleNodes.length} stars · {visibleEdges.length} links
          </span>
          <button
            type="button"
            className={styles.tinyBtn}
            aria-label="Zoom out"
            onClick={() => stepZoom(0.84)}
          >
            −
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            aria-label="Fit to view"
            onClick={handleFitToView}
          >
            {displayZoomLabel} · Fit
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            aria-label="Zoom in"
            onClick={() => stepZoom(1.18)}
          >
            +
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading}
          >
            <WebIcon name="refresh" size={12} />
            <span>{loading ? "Loading" : "Refresh"}</span>
          </button>
        </div>
      </div>

      {!loading && !error && graph.nodes.length > 0 && (
        <div className={styles.graphHintBar}>
          {viewMode === "constellation"
            ? "Drag any glowing star to explore clusters · Scroll to zoom · Double-click a star to open its page."
            : "Click any card to highlight its connections · Double-click to open the page · Drag the background to pan."}
        </div>
      )}

      {loading ? (
        <div className={styles.emptyState} role="status">
          <WebIcon name="network" size={26} />
          <h3>Mapping constellation…</h3>
          <p>
            Scanning pages, people, projects, and links in {allSpaces ? "all your spaces" : workspaceName}.
          </p>
        </div>
      ) : error ? (
        <div className={styles.emptyState} role="alert">
          <WebIcon name="alertTriangle" size={26} />
          <h3>Could not load connections map</h3>
          <p>{error}</p>
          <button type="button" className={styles.btn} onClick={() => setRefreshKey((k) => k + 1)}>
            Try again
          </button>
        </div>
      ) : !graph.nodes.length ? (
        <div className={styles.emptyState}>
          <WebIcon name="network" size={28} />
          <h3>No pages to map yet in {workspaceName}</h3>
          <p>
            {devView
              ? "Markdown pages and entity files linked via [[wikilinks]], Markdown links, or #tags appear here automatically."
              : "As you add pages, people, projects, or meeting notes and link them together, Tina maps their constellation here automatically."}
          </p>
          {!isReadOnly && onCreateEntity && (
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onCreateEntity}>
              <WebIcon name="plus" size={14} />
              <span>Create a project page</span>
            </button>
          )}
        </div>
      ) : (
        <div className={styles.graphWorkarea}>
          {viewMode === "constellation" ? (
            <div ref={canvasWrapRef} className={styles.constellationWrap}>
              <canvas
                ref={canvasElRef}
                className={`${styles.constellationCanvas} ${
                  hoveredId ? styles.constellationPointer : panning ? styles.graphCanvasPanning : ""
                }`}
                role="img"
                aria-label={`${allSpaces ? "All spaces" : workspaceName} constellation graph with ${visibleNodes.length} items`}
                onPointerDown={handleCanvasPointerDown}
                onPointerMove={handleCanvasPointerMove}
                onPointerUp={handleCanvasPointerUp}
                onPointerCancel={handleCanvasPointerUp}
                onPointerLeave={() => {
                  if (!dragNodeRef.current) setHoveredId(null);
                }}
                onWheel={handleCanvasWheel}
              />

              {/* Floating Constellation Color Legend */}
              {allTypes.length > 0 && (
                <div className={styles.constellationLegend} aria-label="Node categories legend">
                  {allTypes.map(([type]) => (
                    <button
                      key={type}
                      type="button"
                      className={`${styles.legendItem} ${activeType === type ? styles.legendItemActive : ""}`}
                      onClick={() => {
                        setActiveType((cur) => (cur === type ? "all" : type));
                        setUnlinkedOnly(false);
                      }}
                    >
                      <span
                        className={styles.legendDot}
                        style={{ background: activePalette[type] ?? activePalette.page }}
                      />
                      <span>{friendlyEntityLaneLabel(type)}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Keyboard & Screen-Reader Accessible Node Controls */}
              <div className={styles.srOnly} aria-label="Constellation items">
                {visibleNodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    aria-label={`${node.title} (${friendlyEntityType(node.type)})`}
                    onClick={() => setSelectedId(node.id)}
                    onDoubleClick={() => {
                      if (!node.isTag && node.path) onOpenDocument(node.path, node.wsId);
                    }}
                  >
                    {node.title}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div
              ref={columnsWrapRef}
              className={`${styles.graphCanvas} ${panning ? styles.graphCanvasPanning : ""}`}
              onPointerDown={handleColumnsPointerDown}
              onPointerMove={handleColumnsPointerMove}
              onPointerUp={handleColumnsPointerUp}
              onPointerCancel={handleColumnsPointerUp}
            >
              <div style={{ width: rawWidth * columnsZoom, height: rawHeight * columnsZoom }}>
                <svg
                  className={styles.graphSvg}
                  width={rawWidth}
                  height={rawHeight}
                  viewBox={`0 0 ${rawWidth} ${rawHeight}`}
                  style={{ transform: `scale(${columnsZoom})` }}
                  role="img"
                  aria-label={`${workspaceName} columns connections map with ${visibleNodes.length} items`}
                >
                  <defs>
                    <marker
                      id={`${markerBase}-arrow`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--tw-line-strong)" />
                    </marker>
                    <marker
                      id={`${markerBase}-arrow-active`}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--tw-mint)" />
                    </marker>
                  </defs>

                  {lanes.map((lane, laneIdx) => {
                    const accent = activePalette[lane.type] ?? "#91d7be";
                    return (
                      <g key={lane.type}>
                        <circle cx={42 + laneIdx * LANE_STEP} cy={28} r={4} fill={accent} />
                        <text x={52 + laneIdx * LANE_STEP} y={32} className={styles.laneHeader}>
                          {friendlyEntityLaneLabel(lane.type)} ({lane.nodes.length})
                        </text>
                      </g>
                    );
                  })}

                  {visibleEdges.map((edge) => {
                    const from = columnPositions.get(edge.from);
                    const to = columnPositions.get(edge.to);
                    if (!from || !to) return null;
                    const touchesSelected = selectedId === edge.from || selectedId === edge.to;
                    const cls = selectedId
                      ? touchesSelected
                        ? `${styles.edge} ${styles.edgeActive}`
                        : `${styles.edge} ${styles.edgeDim}`
                      : styles.edge;
                    return (
                      <path
                        key={`${edge.from}->${edge.to}`}
                        d={edgePath(from, to)}
                        className={cls}
                        markerEnd={`url(#${markerBase}-${touchesSelected ? "arrow-active" : "arrow"})`}
                      />
                    );
                  })}

                  {visibleNodes.map((node) => {
                    const pos = columnPositions.get(node.id);
                    if (!pos) return null;
                    const isSel = node.id === selectedId;
                    const dimmed = Boolean(needle && !matchingIds.has(node.id));
                    const accent = activePalette[node.type] ?? "#91d7be";
                    const label = node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title;
                    const typeLabel = friendlyEntityType(node.type);
                    return (
                      <g
                        key={node.id}
                        data-graph-node="1"
                        transform={`translate(${pos.x}, ${pos.y})`}
                        className={`${styles.nodeGroup} ${isSel ? styles.nodeSelected : ""} ${dimmed ? styles.nodeDim : ""}`}
                        onClick={() => setSelectedId(node.id)}
                        onDoubleClick={() => {
                          if (!node.isTag && node.path) onOpenDocument(node.path, node.wsId);
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label={`${node.title} (${typeLabel})`}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(node.id);
                          }
                        }}
                      >
                        <rect className={styles.nodeRect} width={NODE_WIDTH} height={NODE_HEIGHT} rx={10} />
                        <rect x={0} y={10} width={3.5} height={NODE_HEIGHT - 20} rx={2} fill={accent} />
                        <text x={14} y={22} className={styles.nodeTitle}>
                          {label}
                        </text>
                        <text x={14} y={37} className={styles.nodeMeta}>
                          {typeLabel} · {node.degree} {node.degree === 1 ? "connection" : "connections"}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </div>
            </div>
          )}

          {/* Right Inspector Panel */}
          <aside className={styles.graphInspector} aria-label="Selected item details">
            {selected ? (
              <>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                    <span className={styles.wsTag}>{friendlyEntityType(selected.type)}</span>
                    {allSpaces && !selected.isTag && (
                      <span className={`${styles.wsTag} ${styles.wsTagShared}`}>{selected.wsName}</span>
                    )}
                  </div>
                  <h3 className={styles.inspectorTitle}>{selected.title}</h3>
                  {devView && selected.path && <div className={styles.inspectorPath}>{selected.path}</div>}
                </div>

                <div className={styles.inlineForm}>
                  {!selected.isTag && selected.path ? (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={() => onOpenDocument(selected.path, selected.wsId)}
                    >
                      <WebIcon name="fileText" size={14} />
                      <span>Open page</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnPrimary}`}
                      onClick={() => setFocusSelected((v) => !v)}
                    >
                      <WebIcon name="filter" size={14} />
                      <span>{focusSelected ? "Show all stars" : "Focus this tag"}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() =>
                      onAskTina(
                        selected.isTag
                          ? `Summarize all pages tagged with "${selected.title}" and highlight common themes.`
                          : `Summarize what we know about "${selected.title}" and its related meetings, people, or tasks.`,
                      )
                    }
                  >
                    <WebIcon name="tinaAsk" size={14} />
                    <span>Ask Tina</span>
                  </button>
                </div>

                <div className={styles.inspectorGroup}>
                  <div className={styles.inspectorGroupTitle}>References ({linksTo.length})</div>
                  {linksTo.length === 0 ? (
                    <span className={styles.cardSub}>Does not reference other items yet.</span>
                  ) : (
                    linksTo.map((target) => (
                      <button
                        key={target.id}
                        type="button"
                        className={styles.inspectorLinkRow}
                        onClick={() => {
                          setActiveType("all");
                          setUnlinkedOnly(false);
                          setSelectedId(target.id);
                        }}
                      >
                        <WebIcon name="link" size={12} />
                        <span className={styles.treeLabel}>{target.title}</span>
                        <span className={styles.wsTag}>{friendlyEntityType(target.type)}</span>
                      </button>
                    ))
                  )}
                </div>

                <div className={styles.inspectorGroup}>
                  <div className={styles.inspectorGroupTitle}>Mentioned in ({linkedFrom.length})</div>
                  {linkedFrom.length === 0 ? (
                    <span className={styles.cardSub}>Not mentioned by other pages yet.</span>
                  ) : (
                    linkedFrom.map((source) => (
                      <button
                        key={source.id}
                        type="button"
                        className={styles.inspectorLinkRow}
                        onClick={() => {
                          setActiveType("all");
                          setUnlinkedOnly(false);
                          setSelectedId(source.id);
                        }}
                      >
                        <WebIcon name="link" size={12} />
                        <span className={styles.treeLabel}>{source.title}</span>
                        <span className={styles.wsTag}>{friendlyEntityType(source.type)}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <p className={styles.cardSub}>Select a star on the map to explore its connections or open the page.</p>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
