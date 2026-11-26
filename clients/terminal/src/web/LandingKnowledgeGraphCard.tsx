"use client";
/** LandingKnowledgeGraphCard — Interactive cosmic Knowledge Graph card paired beside
 *  LucianAutomationFlow in section#how of TinaLanding.
 *  Features:
 *  - 60fps HTML5 Canvas constellation with dual volumetric nebulae, 2-layer parallax starfield,
 *    faint orbital coordinate rings, curved gradient Bézier filaments, animated energy photons,
 *    layered jewel star nodes with double rotating focus rings, and frosted-glass pill labels.
 *  - Full pointer interactivity: drag any individual node (elastic damped spring physics gently
 *    pulls neighbors), drag background to pan the entire constellation, click any node to focus
 *    its 1-hop neighborhood, zoom via HUD buttons or Ctrl/Cmd+Wheel, and reset view cleanly. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import "./landingKnowledgeGraph.css";

export type LandingGraphNodeType = "person" | "meeting" | "organization" | "task" | "wiki" | "tag";

interface GraphNodeDef {
  id: string;
  type: LandingGraphNodeType;
  labelVi: string;
  labelEn: string;
  metaVi: string;
  metaEn: string;
  /** Curated world coordinates centered around (0, 0) for an immediately balanced composition. */
  x: number;
  y: number;
  /** Base star visual radius before degree scaling. */
  size: number;
}

interface GraphEdgeDef {
  from: string;
  to: string;
  kind: "link" | "tag";
  curve: number;
}

interface SimNodeState {
  id: string;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  vx: number;
  vy: number;
  radius: number;
  phase: number;
  pinned: boolean;
}

interface CameraState {
  tx: number;
  ty: number;
  scale: number;
}

const NODE_COLORS: Record<LandingGraphNodeType, string> = {
  person: "#4be8ff",
  meeting: "#5ef2c2",
  organization: "#9ba8ff",
  task: "#fbbf24",
  wiki: "#7dd3fc",
  tag: "#a78bfa",
};

const TYPE_LABELS: Record<"vi" | "en", Record<LandingGraphNodeType, string>> = {
  vi: {
    person: "Con người",
    meeting: "Cuộc họp",
    organization: "Tổ chức",
    task: "Action item",
    wiki: "Trang Wiki",
    tag: "Thẻ chủ đề",
  },
  en: {
    person: "Person",
    meeting: "Meeting",
    organization: "Organization",
    task: "Action item",
    wiki: "Wiki page",
    tag: "Topic tag",
  },
};

const GRAPH_NODES: readonly GraphNodeDef[] = [
  // Primary spotlight cluster (inspired by real TINA workspace constellation, elevated)
  {
    id: "jane",
    type: "person",
    labelVi: "Jane Liu",
    labelEn: "Jane Liu",
    metaVi: "VP Engineering · Acme Corp · Chốt triển khai Q4",
    metaEn: "VP Engineering · Acme Corp · Q4 rollout sponsor",
    x: 42,
    y: 4,
    size: 13.5,
  },
  {
    id: "acme",
    type: "organization",
    labelVi: "Acme Corp",
    labelEn: "Acme Corp",
    metaVi: "Đối tác Enterprise Q4 · Singapore",
    metaEn: "Enterprise Q4 Partner · Singapore",
    x: -18,
    y: -86,
    size: 12,
  },
  {
    id: "intro-call",
    type: "meeting",
    labelVi: "Acme Intro Call",
    labelEn: "Acme Intro Call",
    metaVi: "Cuộc họp 18/11 · Song ngữ VI + EN · Đã trích dẫn",
    metaEn: "Nov 18 call · Bilingual VI + EN · Cited",
    x: -94,
    y: 36,
    size: 12.2,
  },
  {
    id: "minh",
    type: "person",
    labelVi: "Minh Nguyễn",
    labelEn: "Minh Nguyen",
    metaVi: "Product Lead · Chủ trì kế hoạch Q4",
    metaEn: "Product Lead · Q4 rollout owner",
    x: -102,
    y: -44,
    size: 9.2,
  },
  {
    id: "tag-dm",
    type: "tag",
    labelVi: "#decision-maker",
    labelEn: "#decision-maker",
    metaVi: "Thẻ nhận diện người ra quyết định",
    metaEn: "Stakeholder decision-maker tag",
    x: -46,
    y: 88,
    size: 6.8,
  },
  {
    id: "tag-eng",
    type: "tag",
    labelVi: "#engineering",
    labelEn: "#engineering",
    metaVi: "Nhóm kỹ thuật & kiến trúc tích hợp",
    metaEn: "Engineering & integration cluster",
    x: 152,
    y: 66,
    size: 6.8,
  },
  {
    id: "task-sec",
    type: "task",
    labelVi: "Đánh giá bảo mật",
    labelEn: "Security Review",
    metaVi: "kg/entities/task/ · Hạn Thứ 4 · Linh phụ trách",
    metaEn: "kg/entities/task/ · Due Wed · Owned by Linh",
    x: 148,
    y: -36,
    size: 9.4,
  },
  // Rich 2nd-hop TINA Knowledge Ecosystem
  {
    id: "q4-sync",
    type: "meeting",
    labelVi: "Họp chốt Q4",
    labelEn: "Q4 Launch Sync",
    metaVi: "Trực tiếp · Đã gọi “Tina ơi” · 3 Action Items",
    metaEn: "Live call · “Tina ơi” voice Q&A · 3 tasks",
    x: 64,
    y: -112,
    size: 10.2,
  },
  {
    id: "linh",
    type: "person",
    labelVi: "Linh Hoàng",
    labelEn: "Linh Hoang",
    metaVi: "Operations · Phụ trách bảo mật & vận hành",
    metaEn: "Operations · Security & pilot lead",
    x: 236,
    y: 22,
    size: 8.6,
  },
  {
    id: "tina-agent",
    type: "wiki",
    labelVi: "TINA Agent",
    labelEn: "TINA Agent",
    metaVi: "Trợ lý giọng nói có nguồn trích dẫn xác thực",
    metaEn: "Voice agent with verbatim source citations",
    x: -186,
    y: -14,
    size: 9.8,
  },
  {
    id: "wiki-brief",
    type: "wiki",
    labelVi: "Tóm tắt điều hành",
    labelEn: "Executive Brief",
    metaVi: "My Space · Tự động tổng hợp sau họp",
    metaEn: "My Space · Auto-compiled post-meeting brief",
    x: -180,
    y: 58,
    size: 8.4,
  },
  {
    id: "task-pilot",
    type: "task",
    labelVi: "Chạy thử 20 nhân sự",
    labelEn: "20-Seat Pilot",
    metaVi: "kg/entities/task/ · Khởi động tuần tới",
    metaEn: "kg/entities/task/ · Launches next week",
    x: 214,
    y: -96,
    size: 8.2,
  },
  {
    id: "wiki-playbook",
    type: "wiki",
    labelVi: "Cẩm nang Wiki",
    labelEn: "Team Playbook",
    metaVi: "Team Space · Quy trình triển khai Enterprise",
    metaEn: "Team Space · Enterprise rollout handbook",
    x: -192,
    y: -92,
    size: 8.2,
  },
  {
    id: "roadmap",
    type: "wiki",
    labelVi: "Lộ trình Q4",
    labelEn: "Q4 Roadmap",
    metaVi: "Team Wiki · Đã đồng bộ [[Acme Corp]]",
    metaEn: "Team Wiki · Linked to [[Acme Corp]]",
    x: 56,
    y: 88,
    size: 8.4,
  },
  {
    id: "tag-discovery",
    type: "tag",
    labelVi: "#discovery",
    labelEn: "#discovery",
    metaVi: "Giai đoạn khảo sát nhu cầu khách hàng",
    metaEn: "Customer discovery stage tag",
    x: -98,
    y: -112,
    size: 6,
  },
  {
    id: "tag-prospect",
    type: "tag",
    labelVi: "#enterprise",
    labelEn: "#enterprise",
    metaVi: "Tài khoản khách hàng doanh nghiệp",
    metaEn: "Enterprise customer segment tag",
    x: 112,
    y: -86,
    size: 5.8,
  },
  {
    id: "tag-bilingual",
    type: "tag",
    labelVi: "#song-ngu",
    labelEn: "#bilingual-ai",
    metaVi: "Phiên âm & dịch song ngữ VI + EN",
    metaEn: "Live VI + EN transcription tag",
    x: -252,
    y: -48,
    size: 5.8,
  },
  {
    id: "tag-voice",
    type: "tag",
    labelVi: "#tina-voice",
    labelEn: "#tina-voice",
    metaVi: "Phản hồi bằng giọng nói ngay trong họp",
    metaEn: "In-call spoken voice response tag",
    x: -248,
    y: 26,
    size: 5.8,
  },
];

const GRAPH_EDGES: readonly GraphEdgeDef[] = [
  // Core spotlight cluster around Jane Liu
  { from: "jane", to: "acme", kind: "link", curve: 14 },
  { from: "jane", to: "minh", kind: "link", curve: -12 },
  { from: "jane", to: "intro-call", kind: "link", curve: 10 },
  { from: "jane", to: "tag-dm", kind: "tag", curve: -14 },
  { from: "jane", to: "tag-eng", kind: "tag", curve: 12 },
  { from: "jane", to: "task-sec", kind: "link", curve: -10 },

  // Cross-links across meetings, people, orgs, tasks, and wiki
  { from: "acme", to: "minh", kind: "link", curve: 10 },
  { from: "acme", to: "intro-call", kind: "link", curve: -16 },
  { from: "acme", to: "q4-sync", kind: "link", curve: 12 },
  { from: "acme", to: "tag-discovery", kind: "tag", curve: -10 },
  { from: "acme", to: "tag-prospect", kind: "tag", curve: 10 },

  { from: "intro-call", to: "minh", kind: "link", curve: -10 },
  { from: "intro-call", to: "tina-agent", kind: "link", curve: 12 },
  { from: "intro-call", to: "wiki-brief", kind: "link", curve: -10 },
  { from: "intro-call", to: "roadmap", kind: "link", curve: 14 },

  { from: "q4-sync", to: "task-sec", kind: "link", curve: 12 },
  { from: "q4-sync", to: "task-pilot", kind: "link", curve: -12 },
  { from: "q4-sync", to: "tag-prospect", kind: "tag", curve: 8 },
  { from: "q4-sync", to: "minh", kind: "link", curve: -14 },

  { from: "task-sec", to: "linh", kind: "link", curve: 12 },
  { from: "task-sec", to: "tag-eng", kind: "tag", curve: -10 },
  { from: "task-pilot", to: "linh", kind: "link", curve: 14 },

  { from: "tina-agent", to: "wiki-playbook", kind: "link", curve: -12 },
  { from: "tina-agent", to: "wiki-brief", kind: "link", curve: 10 },
  { from: "tina-agent", to: "tag-bilingual", kind: "tag", curve: -8 },
  { from: "tina-agent", to: "tag-voice", kind: "tag", curve: 10 },

  { from: "minh", to: "wiki-playbook", kind: "link", curve: 10 },
  { from: "roadmap", to: "tag-eng", kind: "tag", curve: 12 },
  { from: "roadmap", to: "tag-dm", kind: "tag", curve: -10 },
  { from: "wiki-brief", to: "tag-dm", kind: "tag", curve: 10 },
  { from: "linh", to: "tag-eng", kind: "tag", curve: 10 },
];

const SPOTLIGHT_TOUR = ["jane", "acme", "intro-call", "q4-sync", "task-sec", "tina-agent"] as const;

const STAR_DUST = Array.from({ length: 84 }, (_, i) => {
  const a = Math.sin(i * 12.9898) * 43758.5453;
  const b = Math.sin(i * 78.233) * 24634.6345;
  const c = Math.sin(i * 39.425) * 18392.1923;
  const d = Math.sin(i * 53.719) * 12937.3141;
  return {
    nx: a - Math.floor(a),
    ny: b - Math.floor(b),
    r: 0.45 + (c - Math.floor(c)) * 1.15,
    alpha: 0.12 + (c - Math.floor(c)) * 0.34,
    depth: i % 3 === 0 ? 0.34 : 0.14,
    phase: (d - Math.floor(d)) * Math.PI * 2,
    tint: i % 5 === 0 ? "196, 181, 253" : i % 3 === 0 ? "110, 231, 183" : "186, 230, 253",
  };
});

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function createInitialSim(): Map<string, SimNodeState> {
  const map = new Map<string, SimNodeState>();
  GRAPH_NODES.forEach((n, idx) => {
    map.set(n.id, {
      id: n.id,
      x: n.x,
      y: n.y,
      homeX: n.x,
      homeY: n.y,
      vx: 0,
      vy: 0,
      radius: n.size,
      phase: idx * 1.17,
      pinned: false,
    });
  });
  return map;
}

function computeFitCamera(w: number, h: number): CameraState {
  const spanW = 540;
  const spanH = 264;
  const availW = Math.max(240, w - 52);
  const availH = Math.max(180, h - 122);
  const scale = Math.max(0.58, Math.min(1.16, Math.min(availW / spanW, availH / spanH)));
  return {
    tx: w * 0.5 + 10 * scale,
    ty: h * 0.47,
    scale,
  };
}

function getCardCopy(lang: "vi" | "en") {
  if (lang === "vi") {
    return {
      heading: "Đồ thị tri thức TINA",
      sub: "18 thực thể · Kéo node hoặc di chuyển bản đồ",
      explore: "Đổi tiêu điểm",
      reset: "Đặt lại",
      dragHint: "Kéo node · Kéo nền để di chuyển",
      linksCount: (n: number) => `${n} liên kết`,
      zoomIn: "Phóng to đồ thị",
      zoomOut: "Thu nhỏ đồ thị",
      resetAria: "Đặt lại vị trí đồ thị tri thức",
      canvasAria: "Đồ thị tri thức tương tác TINA — kéo từng nút hoặc kéo nền để di chuyển bản đồ",
      legend: [
        { type: "person" as const, label: "Người" },
        { type: "meeting" as const, label: "Cuộc họp" },
        { type: "organization" as const, label: "Tổ chức" },
        { type: "task" as const, label: "Đầu việc" },
        { type: "wiki" as const, label: "Wiki" },
      ],
    };
  }
  return {
    heading: "TINA Knowledge Graph",
    sub: "18 entities · Drag nodes or pan constellation",
    explore: "Next focus",
    reset: "Reset",
    dragHint: "Drag nodes · Pan canvas",
    linksCount: (n: number) => `${n} links`,
    zoomIn: "Zoom in graph",
    zoomOut: "Zoom out graph",
    resetAria: "Reset knowledge graph layout",
    canvasAria: "Interactive TINA Knowledge Graph — drag individual nodes or pan the canvas",
    legend: [
      { type: "person" as const, label: "People" },
      { type: "meeting" as const, label: "Meetings" },
      { type: "organization" as const, label: "Orgs" },
      { type: "task" as const, label: "Tasks" },
      { type: "wiki" as const, label: "Wiki" },
    ],
  };
}

export function LandingKnowledgeGraphCard({
  lang = "vi",
  pulseKey = 0,
}: {
  lang?: "vi" | "en";
  pulseKey?: number;
}) {
  const copy = getCardCopy(lang);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [selectedId, setSelectedId] = useState<string>("jane");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [panning, setPanning] = useState<boolean>(false);
  const [draggingNode, setDraggingNode] = useState<boolean>(false);
  const [hasInteracted, setHasInteracted] = useState<boolean>(false);

  const simRef = useRef<Map<string, SimNodeState>>(createInitialSim());
  const cameraRef = useRef<CameraState>({ tx: 340, ty: 194, scale: 1 });
  const viewportRef = useRef<{ w: number; h: number }>({ w: 680, h: 388 });
  const alphaRef = useRef<number>(0);
  const nebulaRef = useRef<{ x: number; y: number }>({ x: 360, y: 196 });
  const rippleRef = useRef<{ startedAt: number } | null>(null);

  const dragNodeRef = useRef<{ id: string; startX: number; startY: number; moved: boolean } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; tx: number; ty: number; moved: boolean } | null>(null);

  const nodeMap = useMemo(() => new Map(GRAPH_NODES.map((n) => [n.id, n])), []);

  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const n of GRAPH_NODES) map.set(n.id, new Set());
    for (const e of GRAPH_EDGES) {
      map.get(e.from)?.add(e.to);
      map.get(e.to)?.add(e.from);
    }
    return map;
  }, []);

  // Trigger a celebratory shockwave ripple when sibling Automation Flow finishes a run
  useEffect(() => {
    if (pulseKey > 0) {
      rippleRef.current = { startedAt: performance.now() };
      alphaRef.current = Math.max(alphaRef.current, 0.25);
    }
  }, [pulseKey]);

  const selectedNode = nodeMap.get(selectedId) ?? GRAPH_NODES[0];
  const selectedLinkCount = adjacency.get(selectedNode.id)?.size ?? 0;

  const fitView = useCallback((resetNodes = false) => {
    if (resetNodes) {
      simRef.current = createInitialSim();
      alphaRef.current = 0;
    }
    const el = stageRef.current;
    const w = Math.max(300, el?.clientWidth || viewportRef.current.w || 680);
    const h = Math.max(280, el?.clientHeight || viewportRef.current.h || 388);
    viewportRef.current = { w, h };
    const cam = computeFitCamera(w, h);
    cameraRef.current = cam;
    setZoomPct(Math.round(cam.scale * 100));
  }, []);

  const stepZoom = useCallback((factor: number) => {
    const { w, h } = viewportRef.current;
    const cam = cameraRef.current;
    const nextScale = Math.max(0.45, Math.min(2.2, cam.scale * factor));
    const cx = w / 2;
    const cy = h / 2;
    const wx = (cx - cam.tx) / cam.scale;
    const wy = (cy - cam.ty) / cam.scale;
    cameraRef.current = {
      scale: nextScale,
      tx: cx - wx * nextScale,
      ty: cy - wy * nextScale,
    };
    setZoomPct(Math.round(nextScale * 100));
    setHasInteracted(true);
  }, []);

  const cycleFocus = useCallback(() => {
    setSelectedId((prev) => {
      const idx = SPOTLIGHT_TOUR.indexOf(prev as (typeof SPOTLIGHT_TOUR)[number]);
      return SPOTLIGHT_TOUR[(idx + 1) % SPOTLIGHT_TOUR.length];
    });
    rippleRef.current = { startedAt: performance.now() };
    setHasInteracted(true);
  }, []);

  const renderStateRef = useRef({
    lang,
    selectedId,
    hoveredId,
  });
  renderStateRef.current = { lang, selectedId, hoveredId };

  // Main 60fps Canvas Render & Elastic Spring Simulation Loop
  useEffect(() => {
    const wrap = stageRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = canvas.getContext("2d");
    } catch {
      ctx = null;
    }
    if (!ctx) return;

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let initializedCamera = false;

    const syncSize = () => {
      const w = Math.max(300, wrap.clientWidth || 680);
      const h = Math.max(280, wrap.clientHeight || 388);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const changed = viewportRef.current.w !== w || viewportRef.current.h !== h;
      viewportRef.current = { w, h };
      if (!initializedCamera) {
        initializedCamera = true;
        const cam = computeFitCamera(w, h);
        cameraRef.current = cam;
        nebulaRef.current = { x: w * 0.54, y: h * 0.5 };
        setZoomPct(Math.round(cam.scale * 100));
      } else if (changed && !dragNodeRef.current && !panRef.current) {
        const cam = computeFitCamera(w, h);
        cameraRef.current = cam;
        setZoomPct(Math.round(cam.scale * 100));
      }
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      return { w, h, dpr };
    };

    syncSize();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => syncSize()) : null;
    ro?.observe(wrap);

    const startMs = performance.now();
    let rafId = 0;

    const stepElasticPhysics = (activeAlpha: number) => {
      const sim = simRef.current;
      const list = [...sim.values()];

      // 1. Soft home anchor + spring edge pull when dragging or settling
      for (const edge of GRAPH_EDGES) {
        const a = sim.get(edge.from);
        const b = sim.get(edge.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(1, Math.hypot(dx, dy));
        const homeDist = Math.max(54, Math.hypot(b.homeX - a.homeX, b.homeY - a.homeY));
        const stiffness = edge.kind === "tag" ? 0.04 : 0.062;
        const force = (dist - homeDist) * stiffness * activeAlpha;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!a.pinned) {
          a.vx += fx;
          a.vy += fy;
        }
        if (!b.pinned) {
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      // 2. Gentle collision cushion so dragged nodes never pile up tightly
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(0.5, Math.hypot(dx, dy));
          const minDist = a.radius + b.radius + 32;
          if (dist < minDist) {
            const push = (minDist - dist) * 0.14 * activeAlpha;
            const fx = (dx / dist) * push;
            const fy = (dy / dist) * push;
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
      }

      // 3. Soft home tether keeps the graph gracefully composed after dragging
      for (const node of list) {
        if (node.pinned) {
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        node.vx += (node.homeX - node.x) * 0.012 * activeAlpha;
        node.vy += (node.homeY - node.y) * 0.012 * activeAlpha;
        node.vx *= 0.84;
        node.vy *= 0.84;
        node.x += node.vx;
        node.y += node.vy;
      }
    };

    const drawFrame = (now: number) => {
      const { w, h, dpr } = syncSize();
      const st = renderStateRef.current;
      const sim = simRef.current;
      const cam = cameraRef.current;

      if (alphaRef.current > 0.005 || dragNodeRef.current) {
        const a = dragNodeRef.current ? Math.max(alphaRef.current, 0.36) : alphaRef.current;
        stepElasticPhysics(a);
        if (!dragNodeRef.current) {
          alphaRef.current *= 0.955;
          if (alphaRef.current < 0.005) alphaRef.current = 0;
        }
      }

      const t = reducedMotion ? 0 : (now - startMs) * 0.001;
      const focusId = st.hoveredId ?? st.selectedId;
      const focusNeighbors = new Set<string>([focusId]);
      for (const neighbor of adjacency.get(focusId) ?? []) {
        focusNeighbors.add(neighbor);
      }

      // Compute screen positions with subtle organic orbital breathing
      const screenPos = new Map<string, { x: number; y: number; r: number }>();
      for (const def of GRAPH_NODES) {
        const sn = sim.get(def.id);
        if (!sn) continue;
        const driftX = !reducedMotion && !sn.pinned ? Math.cos(t * 0.62 + sn.phase) * 1.4 : 0;
        const driftY = !reducedMotion && !sn.pinned ? Math.sin(t * 0.54 + sn.phase * 1.25) * 1.4 : 0;
        screenPos.set(def.id, {
          x: (sn.x + driftX) * cam.scale + cam.tx,
          y: (sn.y + driftY) * cam.scale + cam.ty,
          r: Math.max(3.6, sn.radius * Math.pow(cam.scale, 0.62)),
        });
      }

      const focusPos = screenPos.get(focusId);
      if (focusPos) {
        nebulaRef.current.x += (focusPos.x - nebulaRef.current.x) * 0.08;
        nebulaRef.current.y += (focusPos.y - nebulaRef.current.y) * 0.08;
      }

      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // 1. Deep Obsidian Cosmic Canvas + Multi-Layer Nebulae
      const baseBg = ctx.createLinearGradient(0, 0, w, h);
      baseBg.addColorStop(0, "#050812");
      baseBg.addColorStop(0.52, "#070d1a");
      baseBg.addColorStop(1, "#04070f");
      ctx.fillStyle = baseBg;
      ctx.fillRect(0, 0, w, h);

      // Ambient corner indigo-violet mist
      const cornerMist = ctx.createRadialGradient(w * 0.14, h * 0.16, 10, w * 0.14, h * 0.16, w * 0.55);
      cornerMist.addColorStop(0, "rgba(99, 102, 241, 0.13)");
      cornerMist.addColorStop(0.55, "rgba(30, 41, 90, 0.06)");
      cornerMist.addColorStop(1, "rgba(5, 8, 18, 0)");
      ctx.fillStyle = cornerMist;
      ctx.fillRect(0, 0, w, h);

      // Dynamic volumetric cyan-emerald spotlight following the focused star
      const focusDef = nodeMap.get(focusId);
      const spotlightHex = focusDef ? NODE_COLORS[focusDef.type] : "#4be8ff";
      const spotR = Math.max(w, h) * 0.44;
      const spotGrad = ctx.createRadialGradient(
        nebulaRef.current.x,
        nebulaRef.current.y,
        6,
        nebulaRef.current.x,
        nebulaRef.current.y,
        spotR,
      );
      spotGrad.addColorStop(0, hexToRgba(spotlightHex, 0.24));
      spotGrad.addColorStop(0.36, "rgba(22, 118, 134, 0.14)");
      spotGrad.addColorStop(0.7, "rgba(11, 35, 58, 0.06)");
      spotGrad.addColorStop(1, "rgba(5, 8, 18, 0)");
      ctx.fillStyle = spotGrad;
      ctx.fillRect(0, 0, w, h);

      // 2. Parallax 2-Layer Cosmic Starfield Dust
      const panDx = cam.tx - w * 0.5;
      const panDy = cam.ty - h * 0.5;
      for (const s of STAR_DUST) {
        const sx = (((s.nx * w + panDx * s.depth) % w) + w) % w;
        const sy = (((s.ny * h + panDy * s.depth) % h) + h) % h;
        const twinkle = reducedMotion ? 0.85 : 0.62 + 0.38 * Math.sin(t * 1.15 + s.phase);
        ctx.fillStyle = `rgba(${s.tint}, ${(s.alpha * twinkle).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // 3. Subtle Astronomical Orbital Coordinate Rings anchored to graph center
      ctx.save();
      ctx.strokeStyle = "rgba(148, 197, 255, 0.048)";
      ctx.lineWidth = 1;
      for (const ringR of [92, 168, 248]) {
        ctx.beginPath();
        ctx.arc(cam.tx, cam.ty, ringR * cam.scale, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();

      // Optional shockwave ripple expanding from focused star
      if (rippleRef.current && focusPos && !reducedMotion) {
        const elapsed = (now - rippleRef.current.startedAt) / 1000;
        if (elapsed < 1.35) {
          const p = elapsed / 1.35;
          const eased = 1 - Math.pow(1 - p, 3);
          const rr = focusPos.r + eased * 185;
          ctx.save();
          ctx.strokeStyle = hexToRgba(spotlightHex, (1 - p) * 0.55);
          ctx.lineWidth = 2 * (1 - p) + 0.6;
          ctx.beginPath();
          ctx.arc(focusPos.x, focusPos.y, rr, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        } else {
          rippleRef.current = null;
        }
      }

      // 4. Curved Luminous Silk Filaments + Traveling Energy Photons
      ctx.lineCap = "round";
      GRAPH_EDGES.forEach((edge, edgeIdx) => {
        const a = screenPos.get(edge.from);
        const b = screenPos.get(edge.to);
        if (!a || !b) return;
        const touchesFocus = edge.from === focusId || edge.to === focusId;

        // Compute gentle perpendicular Bézier control point
        const mx = (a.x + b.x) * 0.5;
        const my = (a.y + b.y) * 0.5;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        const cpx = mx + (-dy / len) * edge.curve * cam.scale * 0.55;
        const cpy = my + (dx / len) * edge.curve * cam.scale * 0.55;

        if (touchesFocus) {
          const fromDef = nodeMap.get(edge.from);
          const toDef = nodeMap.get(edge.to);
          const cA = fromDef ? NODE_COLORS[fromDef.type] : "#4be8ff";
          const cB = toDef ? NODE_COLORS[toDef.type] : "#9ba8ff";

          // Soft outer luminous bloom pass
          const bloomGrad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          bloomGrad.addColorStop(0, hexToRgba(cA, 0.32));
          bloomGrad.addColorStop(1, hexToRgba(cB, 0.32));
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
          ctx.strokeStyle = bloomGrad;
          ctx.lineWidth = 5.5;
          ctx.stroke();

          // Crisp incandescent core filament pass
          const coreGrad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          coreGrad.addColorStop(0, hexToRgba(cA, 0.96));
          coreGrad.addColorStop(0.5, "rgba(235, 250, 255, 0.94)");
          coreGrad.addColorStop(1, hexToRgba(cB, 0.96));
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
          ctx.strokeStyle = coreGrad;
          ctx.lineWidth = 1.85;
          ctx.stroke();

          // Animated photon pulse travelling along active filament
          if (!reducedMotion) {
            const u = (t * 0.42 + edgeIdx * 0.19) % 1;
            const inv = 1 - u;
            const px = inv * inv * a.x + 2 * inv * u * cpx + u * u * b.x;
            const py = inv * inv * a.y + 2 * inv * u * cpy + u * u * b.y;
            const photonGlow = ctx.createRadialGradient(px, py, 0.5, px, py, 7.5);
            photonGlow.addColorStop(0, "rgba(255, 255, 255, 0.98)");
            photonGlow.addColorStop(0.45, hexToRgba(cA, 0.65));
            photonGlow.addColorStop(1, hexToRgba(cA, 0));
            ctx.fillStyle = photonGlow;
            ctx.beginPath();
            ctx.arc(px, py, 7.5, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          // Delicate background web so full network remains graceful and readable
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(cpx, cpy, b.x, b.y);
          ctx.strokeStyle =
            edge.kind === "tag" ? "rgba(167, 139, 250, 0.095)" : "rgba(125, 211, 252, 0.11)";
          ctx.lineWidth = 0.85;
          ctx.stroke();
        }
      });

      // 5. Layered Jewel Star Nodes (inactive first, then active 1-hop cluster on top)
      const orderedNodes = [...GRAPH_NODES].sort((a, b) => {
        const rank = (id: string) => (id === focusId ? 3 : focusNeighbors.has(id) ? 2 : 1);
        return rank(a.id) - rank(b.id);
      });

      for (const def of orderedNodes) {
        const pos = screenPos.get(def.id);
        if (!pos) continue;
        const isFocus = def.id === focusId;
        const isNeighbor = focusNeighbors.has(def.id);
        const color = NODE_COLORS[def.type];

        if (isNeighbor) {
          // Volumetric multi-stop bloom aura
          const haloMult = isFocus ? 4.4 : 3.25;
          const haloR = pos.r * haloMult;
          const halo = ctx.createRadialGradient(pos.x, pos.y, pos.r * 0.25, pos.x, pos.y, haloR);
          halo.addColorStop(0, hexToRgba(color, isFocus ? 0.62 : 0.44));
          halo.addColorStop(0.42, hexToRgba(color, isFocus ? 0.22 : 0.14));
          halo.addColorStop(1, hexToRgba(color, 0));
          ctx.fillStyle = halo;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, haloR, 0, Math.PI * 2);
          ctx.fill();

          // 3D specular jewel star sphere
          const bodyGrad = ctx.createRadialGradient(
            pos.x - pos.r * 0.28,
            pos.y - pos.r * 0.28,
            pos.r * 0.1,
            pos.x,
            pos.y,
            pos.r,
          );
          bodyGrad.addColorStop(0, "#ffffff");
          bodyGrad.addColorStop(0.48, color);
          bodyGrad.addColorStop(1, hexToRgba(color, 0.78));
          ctx.fillStyle = bodyGrad;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, pos.r, 0, Math.PI * 2);
          ctx.fill();

          // Incandescent crisp star core
          ctx.fillStyle = isFocus ? "#ffffff" : "rgba(255, 255, 255, 0.92)";
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, Math.max(2.1, pos.r * (isFocus ? 0.48 : 0.38)), 0, Math.PI * 2);
          ctx.fill();

          // Double telemetry ring on the focused star
          if (isFocus) {
            const pulse = reducedMotion ? 0 : Math.sin(t * 2.4) * 1.1;
            ctx.strokeStyle = "rgba(224, 249, 255, 0.92)";
            ctx.lineWidth = 1.65;
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, pos.r + 4.8 + pulse * 0.45, 0, Math.PI * 2);
            ctx.stroke();

            ctx.save();
            ctx.translate(pos.x, pos.y);
            ctx.rotate(t * 0.35);
            ctx.setLineDash([4, 5]);
            ctx.strokeStyle = hexToRgba(color, 0.56);
            ctx.lineWidth = 1.15;
            ctx.beginPath();
            ctx.arc(0, 0, pos.r + 10.5 + pulse * 0.6, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
          }
        } else {
          // Distant star (soft subtle presence, still immediately clickable/draggable)
          const faintHalo = ctx.createRadialGradient(pos.x, pos.y, 1, pos.x, pos.y, pos.r * 2.1);
          faintHalo.addColorStop(0, hexToRgba(color, 0.2));
          faintHalo.addColorStop(1, hexToRgba(color, 0));
          ctx.fillStyle = faintHalo;
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, pos.r * 2.1, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = hexToRgba(color, 0.34);
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, Math.max(3.4, pos.r * 0.72), 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = "rgba(226, 242, 255, 0.38)";
          ctx.beginPath();
          ctx.arc(pos.x, pos.y, Math.max(1.1, pos.r * 0.24), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 6. Frosted Glass Pill Labels (collision-checked, high-priority active labels always sharp)
      const placedBoxes: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
      const labelOrder = [...GRAPH_NODES].sort((a, b) => {
        const score = (n: GraphNodeDef) =>
          (n.id === focusId ? 1000 : 0) + (focusNeighbors.has(n.id) ? 400 : 0) + n.size * 8;
        return score(b) - score(a);
      });

      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      for (const def of labelOrder) {
        const pos = screenPos.get(def.id);
        if (!pos) continue;
        const isFocus = def.id === focusId;
        const isNeighbor = focusNeighbors.has(def.id);
        // Keep labels strictly inside safe HUD bounds so none ever collide with bottom inspector/legend
        const bottomSafe = isNeighbor ? h - 62 : h - 78;
        if (pos.x < 16 || pos.x > w - 16 || pos.y < 54 || pos.y > bottomSafe) continue;
        const label = st.lang === "vi" ? def.labelVi : def.labelEn;
        const fontSize = isFocus ? 12 : isNeighbor ? 11 : 10;
        ctx.font = `${isFocus ? 700 : isNeighbor ? 600 : 500} ${fontSize}px "Inter", system-ui, -apple-system, sans-serif`;

        const textW = ctx.measureText(label).width;
        const dotSpace = isFocus ? 11 : 0;
        const padX = isNeighbor ? 8 : 6;
        const pillW = textW + padX * 2 + dotSpace;
        const pillH = isFocus ? 22 : isNeighbor ? 20 : 17;
        const lx = pos.x - pillW / 2;
        const ly = pos.y + pos.r + (isFocus ? 13 : 7);

        const box = { x1: lx - 2, y1: ly - 2, x2: lx + pillW + 2, y2: ly + pillH + 2 };
        if (!isFocus) {
          const overlaps = placedBoxes.some(
            (b) => !(box.x2 < b.x1 || box.x1 > b.x2 || box.y2 < b.y1 || box.y1 > b.y2),
          );
          if (overlaps) continue;
        }
        placedBoxes.push(box);

        if (isNeighbor) {
          drawRoundedRect(ctx, lx, ly, pillW, pillH, 999);
          ctx.fillStyle = isFocus ? "rgba(7, 15, 29, 0.9)" : "rgba(7, 13, 25, 0.78)";
          ctx.fill();
          ctx.strokeStyle = isFocus
            ? hexToRgba(NODE_COLORS[def.type], 0.65)
            : "rgba(186, 230, 253, 0.16)";
          ctx.lineWidth = isFocus ? 1.15 : 0.85;
          ctx.stroke();

          if (isFocus) {
            ctx.fillStyle = NODE_COLORS[def.type];
            ctx.beginPath();
            ctx.arc(lx + padX + 3, ly + pillH / 2, 3, 0, Math.PI * 2);
            ctx.fill();
          }

          ctx.fillStyle = isFocus ? "#f8fafc" : "rgba(235, 245, 255, 0.94)";
          ctx.fillText(label, lx + padX + dotSpace, ly + pillH / 2 + 0.5);
        } else {
          ctx.fillStyle = "rgba(186, 210, 236, 0.34)";
          ctx.fillText(label, lx + padX, ly + pillH / 2 + 0.5);
        }
      }

      ctx.restore();
      rafId = window.requestAnimationFrame(drawFrame);
    };

    rafId = window.requestAnimationFrame(drawFrame);
    return () => {
      window.cancelAnimationFrame(rafId);
      ro?.disconnect();
    };
  }, [adjacency, nodeMap]);

  // Hit-testing helper in canvas screen coordinates
  const hitTest = useCallback((screenX: number, screenY: number): string | null => {
    const cam = cameraRef.current;
    const wx = (screenX - cam.tx) / cam.scale;
    const wy = (screenY - cam.ty) / cam.scale;
    let bestId: string | null = null;
    let bestDist = Infinity;
    const minHit = 18 / Math.max(0.45, cam.scale);

    for (const node of simRef.current.values()) {
      const dist = Math.hypot(wx - node.x, wy - node.y);
      const hitR = Math.max(node.radius + 9, minHit);
      if (dist <= hitR && dist < bestDist) {
        bestDist = dist;
        bestId = node.id;
      }
    }
    return bestId;
  }, []);

  const localPoint = (e: ReactPointerEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);
    const hitId = hitTest(x, y);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setHasInteracted(true);

    if (hitId) {
      const sn = simRef.current.get(hitId);
      if (sn) sn.pinned = true;
      dragNodeRef.current = { id: hitId, startX: e.clientX, startY: e.clientY, moved: false };
      setSelectedId(hitId);
      setDraggingNode(true);
      alphaRef.current = Math.max(alphaRef.current, 0.45);
      return;
    }

    panRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      tx: cameraRef.current.tx,
      ty: cameraRef.current.ty,
      moved: false,
    };
    setPanning(true);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localPoint(e);

    if (dragNodeRef.current) {
      const sn = simRef.current.get(dragNodeRef.current.id);
      if (sn) {
        const cam = cameraRef.current;
        const wx = (x - cam.tx) / cam.scale;
        const wy = (y - cam.ty) / cam.scale;
        if (Math.hypot(e.clientX - dragNodeRef.current.startX, e.clientY - dragNodeRef.current.startY) > 3) {
          dragNodeRef.current.moved = true;
        }
        sn.x = wx;
        sn.y = wy;
        sn.homeX = wx;
        sn.homeY = wy;
        sn.vx = 0;
        sn.vy = 0;
        alphaRef.current = Math.max(alphaRef.current, 0.42);
      }
      return;
    }

    if (panRef.current) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      if (Math.hypot(dx, dy) > 3) panRef.current.moved = true;
      cameraRef.current = {
        ...cameraRef.current,
        tx: panRef.current.tx + dx,
        ty: panRef.current.ty + dy,
      };
      return;
    }

    const hitId = hitTest(x, y);
    if (hitId !== hoveredId) setHoveredId(hitId);
  };

  const handlePointerUp = () => {
    if (dragNodeRef.current) {
      const sn = simRef.current.get(dragNodeRef.current.id);
      if (sn) sn.pinned = false;
      if (!dragNodeRef.current.moved) {
        rippleRef.current = { startedAt: performance.now() };
      }
      dragNodeRef.current = null;
      setDraggingNode(false);
      return;
    }
    panRef.current = null;
    setPanning(false);
  };

  const handlePointerLeave = () => {
    if (!dragNodeRef.current) setHoveredId(null);
  };

  // Only zoom on Ctrl/Cmd+Wheel (pinch zoom) so regular landing page scrolling is never hijacked
  const handleWheel = (e: ReactWheelEvent<HTMLCanvasElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const { x, y } = localPoint(e);
    const cam = cameraRef.current;
    const factor = e.deltaY < 0 ? 1.1 : 0.91;
    const nextScale = Math.max(0.45, Math.min(2.2, cam.scale * factor));
    const wx = (x - cam.tx) / cam.scale;
    const wy = (y - cam.ty) / cam.scale;
    cameraRef.current = {
      scale: nextScale,
      tx: x - wx * nextScale,
      ty: y - wy * nextScale,
    };
    setZoomPct(Math.round(nextScale * 100));
    setHasInteracted(true);
  };

  const selectedLabel = lang === "vi" ? selectedNode.labelVi : selectedNode.labelEn;
  const selectedMeta = lang === "vi" ? selectedNode.metaVi : selectedNode.metaEn;
  const selectedTypeLabel = TYPE_LABELS[lang][selectedNode.type];
  const selectedColor = NODE_COLORS[selectedNode.type];

  return (
    <div
      className="tina-kg-card"
      data-testid="landing-knowledge-graph"
      data-selected-node={selectedNode.id}
    >
      <div className="tina-kg-hd">
        <div className="tina-kg-title">
          <b>{copy.heading}</b>
          <small>{copy.sub}</small>
        </div>

        <div className="tina-kg-actions">
          <button type="button" className="tina-kg-btn tina-kg-btn-accent" onClick={cycleFocus}>
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="2.2" fill="currentColor" />
              <circle cx="7" cy="7" r="5.3" fill="none" stroke="currentColor" strokeWidth="1.35" strokeDasharray="2.5 2.2" />
            </svg>
            <span>{copy.explore}</span>
          </button>
          <button
            type="button"
            className="tina-kg-btn"
            aria-label={copy.resetAria}
            onClick={() => {
              setSelectedId("jane");
              fitView(true);
            }}
          >
            <svg viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M11.3 7a4.3 4.3 0 1 1-1.2-3M11.3 2.7v2.6H8.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span>{copy.reset}</span>
          </button>
        </div>
      </div>

      <div ref={stageRef} className="tina-kg-stage">
        <canvas
          ref={canvasRef}
          className={`tina-kg-canvas ${draggingNode || panning ? "is-grabbing" : hoveredId ? "is-pointer" : ""}`}
          role="img"
          aria-label={copy.canvasAria}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onWheel={handleWheel}
        />
      </div>

      <div className="tina-kg-hud-bottom">
        <div className="tina-kg-inspector" role="status" aria-live="polite">
          <span
            className="tina-kg-orb"
            style={{ background: selectedColor, boxShadow: `0 0 10px ${selectedColor}` }}
            aria-hidden="true"
          />
          <div className="tina-kg-inspector-body">
            <div className="tina-kg-inspector-top">
              <strong>{selectedLabel}</strong>
              <span className="tina-kg-badge" style={{ color: selectedColor, borderColor: hexToRgba(selectedColor, 0.36) }}>
                {selectedTypeLabel}
              </span>
              <span className="tina-kg-links">{copy.linksCount(selectedLinkCount)}</span>
            </div>
            <p className="tina-kg-meta">{selectedMeta}</p>
          </div>
        </div>

        <div className="tina-kg-controls">
          <div className="tina-kg-legend" aria-hidden="true">
            {copy.legend.map((item) => (
              <span key={item.type} className="tina-kg-legend-item">
                <i style={{ background: NODE_COLORS[item.type] }} />
                {item.label}
              </span>
            ))}
          </div>

          <div className="tina-kg-zoom" role="group" aria-label="Zoom controls">
            <button
              type="button"
              className="tina-kg-zbtn"
              aria-label={copy.zoomOut}
              onClick={() => stepZoom(0.84)}
            >
              −
            </button>
            <span className="tina-kg-zval" data-testid="landing-kg-zoom">
              {zoomPct}%
            </span>
            <button
              type="button"
              className="tina-kg-zbtn"
              aria-label={copy.zoomIn}
              onClick={() => stepZoom(1.18)}
            >
              +
            </button>
          </div>
        </div>
      </div>

      {!hasInteracted && (
        <div className="tina-kg-hint" aria-hidden="true">
          <svg viewBox="0 0 14 14">
            <path
              d="M7 1.5v11M1.5 7h11M7 1.5L5.2 3.3M7 1.5l1.8 1.8M7 12.5l-1.8-1.8M7 12.5l1.8-1.8M1.5 7l1.8-1.8M1.5 7l1.8 1.8M12.5 7l-1.8-1.8M12.5 7l-1.8 1.8"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span>{copy.dragHint}</span>
        </div>
      )}
    </div>
  );
}
