"use client";
/** PrivateInfraIso — Interactive 30° isometric private-infrastructure studio diorama
 *  for TINA's Privacy & Data Sovereignty section (Warm Paper / Studio Light + TINA Brand
 *  Teal #176B5B & Mint #6EE7B7, minimal bilingual VI / EN chrome). */
import { useId, useState } from "react";
import type { LandingLang } from "./landingCopy";
import styles from "./privateInfraIso.module.css";

type IsoNodeId = "meetings" | "core" | "ai" | "vault" | "wiki";

interface NodeCopy {
  short: string;
  caption: string;
}

interface IsoCopy {
  ariaLabel: string;
  nodes: Record<IsoNodeId, NodeCopy>;
}

const ISO_COPY: Record<LandingLang, IsoCopy> = {
  vi: {
    ariaLabel: "Sơ đồ kiến trúc hạ tầng riêng của TINA",
    nodes: {
      meetings: {
        short: "Cuộc họp",
        caption: "Google Meet · Zoom · Teams → luồng mã hóa",
      },
      core: {
        short: "TINA Core",
        caption: "Gateway · OAuth · Phân quyền chủ sở hữu",
      },
      ai: {
        short: "AI",
        caption: "Song ngữ VI+EN · “Tina ơi” · BYO LLM",
      },
      vault: {
        short: "Lưu trữ",
        caption: "PostgreSQL · Valkey · S3 ghi âm riêng",
      },
      wiki: {
        short: "Wiki",
        caption: "Biên bản trích dẫn · Bộ nhớ nhóm",
      },
    },
  },
  en: {
    ariaLabel: "TINA private infrastructure isometric architecture diagram",
    nodes: {
      meetings: {
        short: "Calls",
        caption: "Google Meet · Zoom · Teams → encrypted stream",
      },
      core: {
        short: "TINA Core",
        caption: "Private gateway · OAuth · Owner-scoped ACLs",
      },
      ai: {
        short: "AI",
        caption: "Bilingual VI+EN · “Tina ơi” · BYO LLM",
      },
      vault: {
        short: "Vault",
        caption: "PostgreSQL · Valkey · Private S3 audio",
      },
      wiki: {
        short: "Wiki",
        caption: "Source-cited notes · Team memory",
      },
    },
  },
};

const NODE_ORDER: IsoNodeId[] = ["meetings", "core", "ai", "vault", "wiki"];

/* True 30° isometric projection into SVG viewBox 48 22 450 280 */
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;
const UNIT = 22.5;
const OX = 276;
const OY = 158;

function pt(x: number, y: number, z = 0): [number, number] {
  const sx = OX + (x - y) * COS30 * UNIT;
  const sy = OY + (x + y) * SIN30 * UNIT - z * UNIT;
  return [Number(sx.toFixed(2)), Number(sy.toFixed(2))];
}

function poly(coords: Array<[number, number, number?]>): string {
  return coords.map(([x, y, z = 0]) => pt(x, y, z).join(",")).join(" ");
}

function tracePath(coords: Array<[number, number, number?]>): string {
  return coords
    .map(([x, y, z = 0], i) => {
      const [sx, sy] = pt(x, y, z);
      return `${i === 0 ? "M" : "L"}${sx},${sy}`;
    })
    .join(" ");
}

function IsoBox({
  x0,
  y0,
  x1,
  y1,
  z0 = 0,
  z1,
  topFill,
  leftFill,
  rightFill,
  stroke = "#c5bfb0",
  strokeWidth = 0.85,
}: {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  z0?: number;
  z1: number;
  topFill: string;
  leftFill: string;
  rightFill: string;
  stroke?: string;
  strokeWidth?: number;
}) {
  return (
    <g stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round">
      {/* Front-left face (y = y1) */}
      <polygon
        points={poly([
          [x0, y1, z0],
          [x1, y1, z0],
          [x1, y1, z1],
          [x0, y1, z1],
        ])}
        fill={leftFill}
      />
      {/* Front-right face (x = x1) */}
      <polygon
        points={poly([
          [x1, y0, z0],
          [x1, y1, z0],
          [x1, y1, z1],
          [x1, y0, z1],
        ])}
        fill={rightFill}
      />
      {/* Top face (z = z1) */}
      <polygon
        points={poly([
          [x0, y0, z1],
          [x1, y0, z1],
          [x1, y1, z1],
          [x0, y1, z1],
        ])}
        fill={topFill}
      />
    </g>
  );
}

/** Studio-light isometric laptop with angled display & official platform logo */
function IsoLaptop({
  cx,
  cy,
  accentColor,
  logoHref,
  active,
}: {
  cx: number;
  cy: number;
  accentColor: string;
  logoHref: string;
  active: boolean;
}) {
  const [scx, scy] = pt(cx - 0.72, cy, 0.56);
  return (
    <g>
      {/* Soft cast shadow on plinth */}
      <polygon
        points={poly([
          [cx - 0.74, cy - 0.62, 0.01],
          [cx + 0.74, cy - 0.62, 0.01],
          [cx + 0.74, cy + 0.68, 0.01],
          [cx - 0.74, cy + 0.68, 0.01],
        ])}
        fill="rgba(18, 22, 18, 0.085)"
      />
      {/* Anodized aluminum keyboard deck */}
      <IsoBox
        x0={cx - 0.62}
        y0={cy - 0.54}
        x1={cx + 0.56}
        y1={cy + 0.54}
        z0={0}
        z1={0.12}
        topFill="#f8f6f0"
        leftFill="#e0dbd0"
        rightFill="#cdc7b8"
        stroke={active ? accentColor : "#bdb6a6"}
        strokeWidth={active ? 1.05 : 0.8}
      />
      {/* Subtle keyboard recess */}
      <polygon
        points={poly([
          [cx - 0.42, cy - 0.38, 0.13],
          [cx + 0.16, cy - 0.38, 0.13],
          [cx + 0.16, cy + 0.38, 0.13],
          [cx - 0.42, cy + 0.38, 0.13],
        ])}
        fill="#e5e0d5"
      />
      {/* Lid aluminum side & top thickness */}
      <polygon
        points={poly([
          [cx - 0.67, cy - 0.54, 0.12],
          [cx - 0.61, cy - 0.54, 0.12],
          [cx - 0.82, cy - 0.54, 1.02],
          [cx - 0.88, cy - 0.54, 1.02],
        ])}
        fill="#cdc7b8"
        stroke="#b5afa0"
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
      <polygon
        points={poly([
          [cx - 0.88, cy - 0.54, 1.02],
          [cx - 0.82, cy - 0.54, 1.02],
          [cx - 0.82, cy + 0.54, 1.02],
          [cx - 0.88, cy + 0.54, 1.02],
        ])}
        fill="#f8f6f0"
        stroke="#b5afa0"
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
      {/* Dark display bezel facing viewer (+x) */}
      <polygon
        points={poly([
          [cx - 0.61, cy - 0.54, 0.12],
          [cx - 0.61, cy + 0.54, 0.12],
          [cx - 0.82, cy + 0.54, 1.02],
          [cx - 0.82, cy - 0.54, 1.02],
        ])}
        fill="#1e2220"
        stroke={active ? accentColor : "#121413"}
        strokeWidth={active ? 1.1 : 0.85}
        strokeLinejoin="round"
      />
      {/* Active call display */}
      <polygon
        points={poly([
          [cx - 0.63, cy - 0.46, 0.19],
          [cx - 0.63, cy + 0.46, 0.19],
          [cx - 0.8, cy + 0.46, 0.95],
          [cx - 0.8, cy - 0.46, 0.95],
        ])}
        fill="#121615"
      />
      {/* Top platform status accent bar */}
      <polygon
        points={poly([
          [cx - 0.78, cy - 0.46, 0.86],
          [cx - 0.78, cy + 0.46, 0.86],
          [cx - 0.8, cy + 0.46, 0.95],
          [cx - 0.8, cy - 0.46, 0.95],
        ])}
        fill={accentColor}
        opacity={active ? 0.95 : 0.78}
      />
      {/* Official platform icon + miniature UI chrome projected onto angled screen */}
      <g transform={`translate(${scx} ${scy}) matrix(0.866,-0.5,0.19,1.02,0,0)`}>
        <rect x={-5.8} y={-6.4} width={11.6} height={11.6} rx={3.1} fill="#ffffff" fillOpacity="0.96" />
        <image
          href={logoHref}
          x={-4.3}
          y={-4.9}
          width={8.6}
          height={8.6}
          preserveAspectRatio="xMidYMid meet"
        />
        <rect x={-5.6} y={6.6} width={7.2} height={1.3} rx={0.65} fill="#ffffff" fillOpacity="0.32" />
        <circle cx={4.2} cy={7.25} r={0.95} fill={accentColor} />
      </g>
    </g>
  );
}

/** Studio-light isometric tablet on dock with Zoom icon */
function IsoTablet({
  cx,
  cy,
  accentColor,
  logoHref,
  active,
}: {
  cx: number;
  cy: number;
  accentColor: string;
  logoHref: string;
  active: boolean;
}) {
  const [scx, scy] = pt(cx + 0.08, cy, 0.64);
  return (
    <g>
      {/* Cast shadow */}
      <polygon
        points={poly([
          [cx - 0.46, cy - 0.46, 0.01],
          [cx + 0.54, cy - 0.46, 0.01],
          [cx + 0.54, cy + 0.5, 0.01],
          [cx - 0.46, cy + 0.5, 0.01],
        ])}
        fill="rgba(18, 22, 18, 0.085)"
      />
      {/* Dock base */}
      <IsoBox
        x0={cx - 0.36}
        y0={cy - 0.38}
        x1={cx + 0.42}
        y1={cy + 0.38}
        z0={0}
        z1={0.11}
        topFill="#f8f6f0"
        leftFill="#e0dbd0"
        rightFill="#cdc7b8"
        stroke={active ? accentColor : "#bdb6a6"}
        strokeWidth={active ? 1.05 : 0.8}
      />
      {/* Upright tablet chassis */}
      <IsoBox
        x0={cx - 0.14}
        y0={cy - 0.36}
        x1={cx + 0.07}
        y1={cy + 0.36}
        z0={0.11}
        z1={1.18}
        topFill="#f8f6f0"
        leftFill="#e0dbd0"
        rightFill="#1d2124"
        stroke={active ? accentColor : "#b5afa0"}
        strokeWidth={active ? 1.05 : 0.8}
      />
      {/* Tablet glass face */}
      <polygon
        points={poly([
          [cx + 0.08, cy - 0.29, 0.2],
          [cx + 0.08, cy + 0.29, 0.2],
          [cx + 0.08, cy + 0.29, 1.09],
          [cx + 0.08, cy - 0.29, 1.09],
        ])}
        fill="#101722"
      />
      {/* Accent bar */}
      <polygon
        points={poly([
          [cx + 0.08, cy - 0.29, 1.0],
          [cx + 0.08, cy + 0.29, 1.0],
          [cx + 0.08, cy + 0.29, 1.09],
          [cx + 0.08, cy - 0.29, 1.09],
        ])}
        fill={accentColor}
        opacity={active ? 0.95 : 0.78}
      />
      {/* Zoom logo projected flush onto front-right vertical plane */}
      <g transform={`translate(${scx} ${scy}) matrix(0.866,-0.5,0,1,0,0)`}>
        <rect x={-5.6} y={-6.0} width={11.2} height={11.2} rx={3.0} fill="#ffffff" fillOpacity="0.96" />
        <image
          href={logoHref}
          x={-4.1}
          y={-4.5}
          width={8.2}
          height={8.2}
          preserveAspectRatio="xMidYMid meet"
        />
        <rect x={-4.8} y={6.6} width={6.4} height={1.25} rx={0.6} fill="#ffffff" fillOpacity="0.34" />
        <circle cx={3.6} cy={7.2} r={0.9} fill={accentColor} />
      </g>
    </g>
  );
}

export function PrivateInfraIso({ lang = "vi" }: { lang?: LandingLang }) {
  const uid = useId().replace(/:/g, "");
  const [activeNode, setActiveNode] = useState<IsoNodeId>("core");
  const copy = ISO_COPY[lang];
  const activeCopy = copy.nodes[activeNode];

  // Subtle architectural tile grids
  const outerGridX = [-6, -5, -4, -3];
  const outerGridY = [-3, -2, -1, 0, 1, 2, 3];
  const innerGridX = [-1, 0, 1, 2, 3, 4, 5];
  const innerGridY = [-3, -2, -1, 0, 1, 2, 3];

  // Key isometric anchor coordinates
  const [aiCx, aiCy] = pt(2.55, 1.95, 0.18);
  const [aiTopX, aiTopY] = pt(2.55, 1.95, 0.66);
  const [coreTopX, coreTopY] = pt(0.75, -0.2, 2.87);
  const [vaultTopX, vaultTopY] = pt(3.65, -1.85, 2.02);
  const [vaultBaseX, vaultBaseY] = pt(3.65, -1.85, 0.16);
  const [wikiCx, wikiCy] = pt(4.9, 0.95, 0.18);

  // Glass boundary entry portal points (x = -2.1)
  const [portalTeamsX, portalTeamsY] = pt(-2.1, -2.95, 0.18);
  const [portalMeetX, portalMeetY] = pt(-2.1, 0.0, 0.18);
  const [portalZoomX, portalZoomY] = pt(-2.1, 2.45, 0.18);

  // External inbound segments (devices -> glass security divider at x = -2.1)
  const teamsExt = tracePath([
    [-4.34, -2.95, 0.04],
    [-2.1, -2.95, 0.04],
  ]);
  const meetExt = tracePath([
    [-4.34, 0.0, 0.04],
    [-2.1, 0.0, 0.04],
  ]);
  const zoomExt = tracePath([
    [-4.48, 2.45, 0.04],
    [-2.1, 2.45, 0.04],
  ]);

  // Inside-boundary inbound segments (x = -2.1 -> TINA Core at x = 0.05)
  const teamsIn = tracePath([
    [-2.1, -2.95, 0.18],
    [-1.0, -2.95, 0.18],
    [-1.0, -0.58, 0.18],
    [0.05, -0.58, 0.18],
  ]);
  const meetIn = tracePath([
    [-2.1, 0.0, 0.18],
    [0.05, 0.0, 0.18],
  ]);
  const zoomIn = tracePath([
    [-2.1, 2.45, 0.18],
    [-1.0, 2.45, 0.18],
    [-1.0, 0.35, 0.18],
    [0.05, 0.35, 0.18],
  ]);

  // Internal private infrastructure flows (strictly inside glass perimeter)
  const coreToAi = tracePath([
    [0.75, 0.5, 0.18],
    [0.75, 1.95, 0.18],
    [1.72, 1.95, 0.18],
  ]);
  const coreToVault = tracePath([
    [1.45, -0.4, 0.18],
    [2.3, -0.4, 0.18],
    [2.3, -1.85, 0.18],
    [2.75, -1.85, 0.18],
  ]);
  const aiToWiki = tracePath([
    [3.38, 1.95, 0.18],
    [4.9, 1.95, 0.18],
    [4.9, 1.65, 0.18],
  ]);
  const vaultToWiki = tracePath([
    [3.65, -0.95, 0.18],
    [3.65, 0.88, 0.18],
    [4.15, 0.88, 0.18],
  ]);

  const meetingsHot = activeNode === "meetings" || activeNode === "core";
  const aiHot = activeNode === "ai" || activeNode === "core";
  const vaultHot = activeNode === "vault" || activeNode === "core";
  const wikiHot = activeNode === "wiki" || activeNode === "ai" || activeNode === "vault";

  return (
    <div className={styles.shell} aria-label={copy.ariaLabel}>
      <div className={styles.stageWrap}>
        <svg viewBox="48 22 450 280" className={styles.svg} role="img" aria-label={copy.ariaLabel}>
          <defs>
            <linearGradient id={`${uid}-baseTop`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#faf8f3" />
              <stop offset="100%" stopColor="#ede9de" />
            </linearGradient>
            <linearGradient id={`${uid}-ownFloor`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#eff9f4" />
              <stop offset="100%" stopColor="#dcf2e7" />
            </linearGradient>
            <linearGradient id={`${uid}-glassR`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#176b5b" stopOpacity="0.16" />
              <stop offset="55%" stopColor="#ffffff" stopOpacity="0.48" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0.14" />
            </linearGradient>
            <linearGradient id={`${uid}-glassL`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.16" />
              <stop offset="58%" stopColor="#ffffff" stopOpacity="0.42" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0.1" />
            </linearGradient>
            <linearGradient id={`${uid}-glassFront`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#176b5b" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0.24" />
            </linearGradient>
            <linearGradient id={`${uid}-cyl`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="28%" stopColor="#f1eee6" />
              <stop offset="68%" stopColor="#d9d4c7" />
              <stop offset="100%" stopColor="#bfb9ac" />
            </linearGradient>
            <radialGradient id={`${uid}-mintPool`} cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.44" />
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* 1. Outer Warm-Paper architectural plinth */}
          <IsoBox
            x0={-6.5}
            y0={-4.0}
            x1={6.2}
            y1={4.0}
            z0={-0.46}
            z1={0}
            topFill={`url(#${uid}-baseTop)`}
            leftFill="#dfd9ca"
            rightFill="#cfc9b9"
            stroke="#c2bba9"
            strokeWidth={0.85}
          />
          {/* Subtle architectural tile grid on external side */}
          <g stroke="rgba(12, 13, 10, 0.055)" strokeWidth="0.65">
            {outerGridX.map((gx) => (
              <polyline key={`ox-${gx}`} points={poly([[gx, -4.0, 0.01], [gx, 4.0, 0.01]])} fill="none" />
            ))}
            {outerGridY.map((gy) => (
              <polyline key={`oy-${gy}`} points={poly([[-6.5, gy, 0.01], [-2.1, gy, 0.01]])} fill="none" />
            ))}
          </g>

          {/* 2. Raised Private Infrastructure Cleanroom Pad (Your VPC / On-Prem) */}
          <IsoBox
            x0={-2.1}
            y0={-3.7}
            x1={5.95}
            y1={3.7}
            z0={0}
            z1={0.16}
            topFill={`url(#${uid}-ownFloor)`}
            leftFill="#cde8db"
            rightFill="#b4dcc9"
            stroke="#94cbb3"
            strokeWidth={0.85}
          />
          <g stroke="rgba(23, 107, 91, 0.095)" strokeWidth="0.65">
            {innerGridX.map((gx) => (
              <polyline key={`ix-${gx}`} points={poly([[gx, -3.7, 0.17], [gx, 3.7, 0.17]])} fill="none" />
            ))}
            {innerGridY.map((gy) => (
              <polyline key={`iy-${gy}`} points={poly([[-2.1, gy, 0.17], [5.95, gy, 0.17]])} fill="none" />
            ))}
          </g>

          {/* Crisp Teal floor security perimeter trim */}
          <polygon
            points={poly([
              [-2.1, -3.7, 0.17],
              [5.95, -3.7, 0.17],
              [5.95, 3.7, 0.17],
              [-2.1, 3.7, 0.17],
            ])}
            fill="none"
            stroke="#176b5b"
            strokeOpacity="0.45"
            strokeWidth="1.05"
            strokeDasharray="4.5 3.5"
          />

          {/* 3. Back-right frosted glass perimeter wall (y = -3.7) — seamless height match with left divider */}
          <g pointerEvents="none">
            <polygon
              points={poly([
                [-2.1, -3.7, 0.16],
                [5.95, -3.7, 0.16],
                [5.95, -3.7, 1.12],
                [-2.1, -3.7, 1.12],
              ])}
              fill={`url(#${uid}-glassR)`}
              stroke="rgba(23, 107, 91, 0.28)"
              strokeWidth="0.85"
            />
            {[-0.1, 1.9, 3.9].map((gx) => (
              <polyline
                key={`bm-${gx}`}
                points={poly([
                  [gx, -3.7, 0.16],
                  [gx, -3.7, 1.12],
                ])}
                stroke="rgba(23, 107, 91, 0.16)"
                strokeWidth="0.7"
              />
            ))}
            <polyline
              points={poly([
                [-2.1, -3.7, 1.12],
                [5.95, -3.7, 1.12],
              ])}
              stroke="rgba(255, 255, 255, 0.9)"
              strokeWidth="1.15"
            />
          </g>

          {/* 4. External inbound cables (devices -> glass boundary) */}
          <g fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d={teamsExt} stroke="rgba(91, 95, 199, 0.24)" strokeWidth="2.4" />
            <path d={meetExt} stroke="rgba(31, 157, 99, 0.26)" strokeWidth="2.4" />
            <path d={zoomExt} stroke="rgba(45, 140, 255, 0.24)" strokeWidth="2.4" />

            <path
              d={teamsExt}
              stroke="#5b5fc7"
              strokeWidth="2.8"
              className={`${styles.flow} ${meetingsHot ? styles.flowFast : ""}`}
            />
            <path
              d={meetExt}
              stroke="#1f9d63"
              strokeWidth="2.8"
              className={`${styles.flow} ${meetingsHot ? styles.flowFast : ""}`}
            />
            <path
              d={zoomExt}
              stroke="#2d8cff"
              strokeWidth="2.8"
              className={`${styles.flow} ${meetingsHot ? styles.flowFast : ""}`}
            />
          </g>

          {/* 5. External Meeting Devices (Teams, Google Meet, Zoom) — clean separation from glass fence */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("meetings")}
            onClick={() => setActiveNode("meetings")}
          >
            <IsoLaptop
              cx={-4.9}
              cy={-2.95}
              accentColor="#5b5fc7"
              logoHref="/platform-logos/microsoft-teams.png"
              active={activeNode === "meetings"}
            />
            <IsoLaptop
              cx={-4.9}
              cy={0.0}
              accentColor="#1f9d63"
              logoHref="/platform-logos/google-meet.svg"
              active={activeNode === "meetings"}
            />
            <IsoTablet
              cx={-4.9}
              cy={2.45}
              accentColor="#2d8cff"
              logoHref="/platform-logos/zoom.png"
              active={activeNode === "meetings"}
            />
          </g>

          {/* 6. Left-front frosted glass security divider (x = -2.1) */}
          <g pointerEvents="none">
            <polygon
              points={poly([
                [-2.1, -3.7, 0.16],
                [-2.1, 3.7, 0.16],
                [-2.1, 3.7, 1.12],
                [-2.1, -3.7, 1.12],
              ])}
              fill={`url(#${uid}-glassL)`}
              stroke="rgba(23, 107, 91, 0.32)"
              strokeWidth="0.9"
            />
            {[-1.2, 1.2].map((gy) => (
              <polyline
                key={`lm-${gy}`}
                points={poly([
                  [-2.1, gy, 0.16],
                  [-2.1, gy, 1.12],
                ])}
                stroke="rgba(23, 107, 91, 0.18)"
                strokeWidth="0.7"
              />
            ))}
            <polyline
              points={poly([
                [-2.1, -3.7, 1.12],
                [-2.1, 3.7, 1.12],
              ])}
              stroke="rgba(255, 255, 255, 0.9)"
              strokeWidth="1.15"
            />
          </g>

          {/* Soft ambient Mint floor glow pools inside the private cleanroom */}
          <ellipse cx={aiCx} cy={aiCy} rx="46" ry="25" fill={`url(#${uid}-mintPool)`} opacity={aiHot ? 0.9 : 0.45} />
          <ellipse cx={wikiCx} cy={wikiCy} rx="38" ry="20" fill={`url(#${uid}-mintPool)`} opacity={wikiHot ? 0.85 : 0.35} />

          {/* 7. Internal data flows (strictly inside the private glass perimeter) */}
          <g fill="none" strokeLinecap="round" strokeLinejoin="round">
            <path d={teamsIn} stroke="rgba(91, 95, 199, 0.26)" strokeWidth="2.3" />
            <path d={meetIn} stroke="rgba(31, 157, 99, 0.28)" strokeWidth="2.3" />
            <path d={zoomIn} stroke="rgba(45, 140, 255, 0.26)" strokeWidth="2.3" />

            <path
              d={teamsIn}
              stroke="#5b5fc7"
              strokeWidth="2.8"
              className={`${styles.flow} ${meetingsHot ? styles.flowFast : ""}`}
            />
            <path
              d={meetIn}
              stroke="#1f9d63"
              strokeWidth="2.8"
              className={`${styles.flow} ${meetingsHot ? styles.flowFast : ""}`}
            />
            <path
              d={zoomIn}
              stroke="#2d8cff"
              strokeWidth="2.8"
              className={`${styles.flow} ${meetingsHot ? styles.flowFast : ""}`}
            />

            <path d={coreToAi} stroke="rgba(23, 107, 91, 0.24)" strokeWidth="2.3" />
            <path d={coreToVault} stroke="rgba(23, 107, 91, 0.24)" strokeWidth="2.3" />
            <path d={aiToWiki} stroke="rgba(23, 107, 91, 0.24)" strokeWidth="2.3" />
            <path d={vaultToWiki} stroke="rgba(23, 107, 91, 0.22)" strokeWidth="2.3" />

            <path
              d={coreToAi}
              stroke="#0f8a66"
              strokeWidth="2.9"
              className={`${styles.flow} ${aiHot ? styles.flowFast : ""}`}
            />
            <path
              d={coreToVault}
              stroke="#0f8a66"
              strokeWidth="2.9"
              className={`${styles.flow} ${vaultHot ? styles.flowFast : ""}`}
            />
            <path
              d={aiToWiki}
              stroke="#0f8a66"
              strokeWidth="2.9"
              className={`${styles.flow} ${wikiHot ? styles.flowFast : ""}`}
            />
            <path
              d={vaultToWiki}
              stroke="#176b5b"
              strokeWidth="2.6"
              className={`${styles.flow} ${wikiHot ? styles.flowFast : ""}`}
            />
          </g>

          {/* Encrypted ingress grommets cleanly seated on the glass boundary */}
          <g pointerEvents="none">
            <circle cx={portalTeamsX} cy={portalTeamsY} r="3.4" fill="#ffffff" stroke="#5b5fc7" strokeWidth="1.5" />
            <circle cx={portalTeamsX} cy={portalTeamsY} r="1.3" fill="#5b5fc7" />
            <circle cx={portalMeetX} cy={portalMeetY} r="3.4" fill="#ffffff" stroke="#1f9d63" strokeWidth="1.5" />
            <circle cx={portalMeetX} cy={portalMeetY} r="1.3" fill="#1f9d63" />
            <circle cx={portalZoomX} cy={portalZoomY} r="3.4" fill="#ffffff" stroke="#2d8cff" strokeWidth="1.5" />
            <circle cx={portalZoomX} cy={portalZoomY} r="1.3" fill="#2d8cff" />
          </g>

          {/* 8. Central TINA Core Server Tower */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("core")}
            onClick={() => setActiveNode("core")}
          >
            {/* Floor shadow */}
            <polygon
              points={poly([
                [0.05, -0.9, 0.17],
                [1.68, -0.9, 0.17],
                [1.68, 0.72, 0.17],
                [0.05, 0.72, 0.17],
              ])}
              fill="rgba(16, 40, 32, 0.11)"
            />
            {activeNode === "core" && (
              <polygon
                points={poly([
                  [-0.12, -1.07, 0.18],
                  [1.62, -1.07, 0.18],
                  [1.62, 0.67, 0.18],
                  [-0.12, 0.67, 0.18],
                ])}
                fill="none"
                stroke="#176b5b"
                strokeWidth="1.5"
                className={styles.ring}
              />
            )}
            <IsoBox
              x0={0.05}
              y0={-0.9}
              x1={1.45}
              y1={0.5}
              z0={0.16}
              z1={2.86}
              topFill="#ffffff"
              leftFill="#eeeae0"
              rightFill="#dbd5c7"
              stroke={activeNode === "core" ? "#176b5b" : "#b8b2a3"}
              strokeWidth={activeNode === "core" ? 1.25 : 0.9}
            />
            {/* Refined machined blade grooves + subtle blinking emerald LEDs */}
            {[0.58, 1.08, 1.58, 2.08, 2.54].map((rz, idx) => {
              const [lx, ly] = pt(0.24, 0.51, rz);
              const [lx2, ly2] = pt(0.48, 0.51, rz);
              return (
                <g key={`blade-${rz}`}>
                  <polygon
                    points={poly([
                      [0.14, 0.51, rz - 0.08],
                      [1.36, 0.51, rz - 0.08],
                      [1.36, 0.51, rz + 0.07],
                      [0.14, 0.51, rz + 0.07],
                    ])}
                    fill="#383f3c"
                  />
                  <polygon
                    points={poly([
                      [1.46, -0.81, rz - 0.08],
                      [1.46, 0.41, rz - 0.08],
                      [1.46, 0.41, rz + 0.07],
                      [1.46, -0.81, rz + 0.07],
                    ])}
                    fill="#2b312e"
                  />
                  <circle
                    cx={lx}
                    cy={ly}
                    r="1.75"
                    fill="#34d399"
                    className={styles.blink}
                    style={{ animationDelay: `${idx * 0.42}s` }}
                  />
                  <circle
                    cx={lx2}
                    cy={ly2}
                    r="1.35"
                    fill={idx % 2 === 0 ? "#6ee7b7" : "#77827d"}
                    className={styles.blink}
                    style={{ animationDelay: `${idx * 0.35 + 0.2}s` }}
                  />
                </g>
              );
            })}
            {/* Official TINA emblem inlaid on ceramic-white tower top */}
            <polygon
              points={poly([
                [0.24, -0.71, 2.87],
                [1.26, -0.71, 2.87],
                [1.26, 0.31, 2.87],
                [0.24, 0.31, 2.87],
              ])}
              fill="#f3faf6"
              stroke="#b6dfd0"
              strokeWidth="0.9"
            />
            <g transform={`translate(${coreTopX} ${coreTopY}) matrix(0.866,0.5,-0.866,0.5,0,0)`}>
              <image
                href="/tina-logo.svg"
                x={-10.5}
                y={-10.8}
                width={21}
                height={21.6}
                preserveAspectRatio="xMidYMid meet"
              />
            </g>
          </g>

          {/* 9. Encrypted Database / S3 Vault Cylinder */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("vault")}
            onClick={() => setActiveNode("vault")}
          >
            {/* Floor shadow */}
            <ellipse cx={vaultBaseX + 5} cy={vaultBaseY + 3} rx="25" ry="13.5" fill="rgba(16, 40, 32, 0.11)" />
            {activeNode === "vault" && (
              <ellipse
                cx={vaultBaseX}
                cy={vaultBaseY}
                rx="28"
                ry="15.5"
                fill="none"
                stroke="#176b5b"
                strokeWidth="1.5"
                className={styles.ring}
              />
            )}
            {/* Cylinder body */}
            <path
              d={`M ${vaultBaseX - 22.5} ${vaultTopY} L ${vaultBaseX - 22.5} ${vaultBaseY} A 22.5 12.2 0 0 0 ${vaultBaseX + 22.5} ${vaultBaseY} L ${vaultBaseX + 22.5} ${vaultTopY} Z`}
              fill={`url(#${uid}-cyl)`}
              stroke={activeNode === "vault" ? "#176b5b" : "#b5afa0"}
              strokeWidth={activeNode === "vault" ? 1.15 : 0.9}
            />
            {/* Tier bands + live storage status dots */}
            {[0.76, 1.38].map((rz, idx) => {
              const [, ry] = pt(3.65, -1.85, rz);
              return (
                <g key={`ring-${rz}`}>
                  <path
                    d={`M ${vaultBaseX - 22.5} ${ry} A 22.5 12.2 0 0 0 ${vaultBaseX + 22.5} ${ry}`}
                    fill="none"
                    stroke="#176b5b"
                    strokeOpacity={activeNode === "vault" ? "0.78" : "0.42"}
                    strokeWidth="1.25"
                  />
                  <circle
                    cx={vaultBaseX - 11}
                    cy={ry + 5.6}
                    r="1.6"
                    fill="#10b981"
                    className={styles.blink}
                    style={{ animationDelay: `${idx * 0.65 + 0.3}s` }}
                  />
                </g>
              );
            })}
            {/* Ceramic top cap */}
            <ellipse
              cx={vaultTopX}
              cy={vaultTopY}
              rx="22.5"
              ry="12.2"
              fill="#ffffff"
              stroke={activeNode === "vault" ? "#176b5b" : "#bdb7ab"}
              strokeWidth="1"
            />
            <ellipse
              cx={vaultTopX}
              cy={vaultTopY}
              rx="10.5"
              ry="5.7"
              fill="#ebf7f1"
              stroke="#176b5b"
              strokeOpacity="0.48"
              strokeWidth="0.95"
            />
          </g>

          {/* 10. AI & Voice Silicon Compute Chip ("AI") */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("ai")}
            onClick={() => setActiveNode("ai")}
          >
            {/* Floor shadow */}
            <polygon
              points={poly([
                [1.68, 1.08, 0.17],
                [3.58, 1.08, 0.17],
                [3.58, 2.98, 0.17],
                [1.68, 2.98, 0.17],
              ])}
              fill="rgba(16, 40, 32, 0.12)"
            />
            {activeNode === "ai" && (
              <polygon
                points={poly([
                  [1.5, 0.9, 0.18],
                  [3.6, 0.9, 0.18],
                  [3.6, 3.0, 0.18],
                  [1.5, 3.0, 0.18],
                ])}
                fill="none"
                stroke="#176b5b"
                strokeWidth="1.5"
                className={styles.ring}
              />
            )}
            {/* Brushed metallic IC pins on all 4 sides */}
            <g stroke="#8e948f" strokeWidth="1.6" strokeLinecap="round">
              {[1.38, 1.66, 1.95, 2.24, 2.52].map((py) => (
                <g key={`pin-y-${py}`}>
                  <polyline points={poly([[1.52, py, 0.22], [1.76, py, 0.22]])} />
                  <polyline points={poly([[3.34, py, 0.22], [3.58, py, 0.22]])} />
                </g>
              ))}
              {[1.98, 2.26, 2.55, 2.84, 3.12].map((px) => (
                <g key={`pin-x-${px}`}>
                  <polyline points={poly([[px, 0.92, 0.22], [px, 1.16, 0.22]])} />
                  <polyline points={poly([[px, 2.74, 0.22], [px, 2.98, 0.22]])} />
                </g>
              ))}
            </g>
            {/* Dark obsidian silicon package for crisp studio focal contrast */}
            <IsoBox
              x0={1.75}
              y0={1.15}
              x1={3.35}
              y1={2.75}
              z0={0.18}
              z1={0.62}
              topFill="#272c2a"
              leftFill="#1b1f1d"
              rightFill="#121514"
              stroke={activeNode === "ai" ? "#6ee7b7" : "#3a423e"}
              strokeWidth={1.1}
            />
            {/* Glowing Teal / Mint silicon die */}
            <polygon
              points={poly([
                [2.04, 1.44, 0.64],
                [3.06, 1.44, 0.64],
                [3.06, 2.46, 0.64],
                [2.04, 2.46, 0.64],
              ])}
              fill={activeNode === "ai" ? "#6ee7b7" : "#176b5b"}
              stroke="#6ee7b7"
              strokeWidth="1.05"
            />
            <text
              x={0}
              y={0}
              textAnchor="middle"
              dominantBaseline="central"
              fill={activeNode === "ai" ? "#0a0b07" : "#ffffff"}
              fontSize="12"
              fontWeight="800"
              fontFamily="JetBrains Mono, ui-monospace, monospace"
              transform={`matrix(0.866,0.5,-0.866,0.5,${aiTopX},${aiTopY})`}
            >
              AI
            </text>
          </g>

          {/* 11. Grounded Wiki & Notes Warm-Paper Stack */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("wiki")}
            onClick={() => setActiveNode("wiki")}
          >
            {/* Floor shadow */}
            <polygon
              points={poly([
                [4.15, 0.28, 0.17],
                [5.8, 0.28, 0.17],
                [5.8, 1.82, 0.17],
                [4.15, 1.82, 0.17],
              ])}
              fill="rgba(16, 40, 32, 0.1)"
            />
            {activeNode === "wiki" && (
              <ellipse
                cx={wikiCx}
                cy={wikiCy}
                rx="27"
                ry="14.5"
                fill="none"
                stroke="#176b5b"
                strokeWidth="1.4"
                className={styles.ring}
              />
            )}
            {[0.16, 0.31, 0.46, 0.61].map((sz, idx) => (
              <IsoBox
                key={`sheet-${sz}`}
                x0={4.15}
                y0={0.26}
                x1={5.65}
                y1={1.64}
                z0={sz}
                z1={sz + 0.13}
                topFill={idx === 3 ? "#ffffff" : "#f0ede4"}
                leftFill="#e0dcd0"
                rightFill="#ccc7b8"
                stroke={activeNode === "wiki" && idx === 3 ? "#176b5b" : "#b5afa0"}
                strokeWidth={0.8}
              />
            ))}
            {/* Mint header strip + note lines on top page */}
            <polygon
              points={poly([
                [4.34, 0.46, 0.76],
                [5.38, 0.46, 0.76],
                [5.38, 0.68, 0.76],
                [4.34, 0.68, 0.76],
              ])}
              fill={activeNode === "wiki" ? "#176b5b" : "#6ee7b7"}
            />
            {[0.9, 1.12, 1.34].map((ly, idx) => (
              <polyline
                key={`line-${ly}`}
                points={poly([
                  [4.34, ly, 0.76],
                  [idx === 2 ? 5.12 : 5.44, ly, 0.76],
                ])}
                stroke="#323834"
                strokeOpacity="0.42"
                strokeWidth="1.35"
                strokeLinecap="round"
              />
            ))}
          </g>

          {/* 12. Low translucent front glass security curb enclosing the private boundary */}
          <g pointerEvents="none">
            <polygon
              points={poly([
                [-2.1, 3.7, 0.16],
                [5.95, 3.7, 0.16],
                [5.95, 3.7, 0.52],
                [-2.1, 3.7, 0.52],
              ])}
              fill={`url(#${uid}-glassFront)`}
              stroke="rgba(23, 107, 91, 0.24)"
              strokeWidth="0.75"
            />
            <polygon
              points={poly([
                [5.95, -3.7, 0.16],
                [5.95, 3.7, 0.16],
                [5.95, 3.7, 0.52],
                [5.95, -3.7, 0.52],
              ])}
              fill={`url(#${uid}-glassFront)`}
              stroke="rgba(23, 107, 91, 0.22)"
              strokeWidth="0.75"
            />
          </g>
        </svg>
      </div>

      {/* Minimal single-strip interactive footer */}
      <div className={styles.footer}>
        <div className={styles.controls} role="tablist" aria-label={copy.ariaLabel}>
          {NODE_ORDER.map((id) => {
            const item = copy.nodes[id];
            const selected = activeNode === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={selected}
                className={`${styles.pill} ${selected ? styles.pillActive : ""}`}
                onClick={() => setActiveNode(id)}
                onMouseEnter={() => setActiveNode(id)}
              >
                {item.short}
              </button>
            );
          })}
        </div>

        <div className={styles.metaRow} role="status" aria-live="polite">
          <span className={styles.caption}>{activeCopy.caption}</span>
        </div>
      </div>
    </div>
  );
}
