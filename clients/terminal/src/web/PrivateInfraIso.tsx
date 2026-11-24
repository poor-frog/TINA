"use client";
/** PrivateInfraIso — Interactive 30° isometric private-infrastructure topology diagram
 *  built specifically for TINA's Privacy & Data Sovereignty section (Editorial Obsidian +
 *  TINA Brand Mint #6EE7B7 & Teal #176B5B, 100% bilingual VI / EN). */
import { useId, useState } from "react";
import type { LandingLang } from "./landingCopy";
import styles from "./privateInfraIso.module.css";

type IsoNodeId = "meetings" | "core" | "ai" | "vault" | "wiki";

interface NodeCopy {
  id: IsoNodeId;
  short: string;
  title: string;
  desc: string;
}

interface IsoCopy {
  ariaLabel: string;
  topTag: string;
  zoneLabel: string;
  outsideBadge: string;
  insideBadge: string;
  hint: string;
  nodes: Record<IsoNodeId, NodeCopy>;
}

const ISO_COPY: Record<LandingLang, IsoCopy> = {
  vi: {
    ariaLabel: "Sơ đồ kiến trúc hạ tầng riêng của TINA",
    topTag: "KIẾN TRÚC HẠ TẦNG RIÊNG · LIVE",
    zoneLabel: "VPC / DOCKER / AWS CỦA BẠN",
    outsideBadge: "PHÒNG HỌP BÊN NGOÀI",
    insideBadge: "TRONG HẠ TẦNG RIÊNG",
    hint: "Rê chuột hoặc bấm vào từng khối để xem luồng dữ liệu",
    nodes: {
      meetings: {
        id: "meetings",
        short: "Cuộc họp",
        title: "Google Meet · Zoom · Microsoft Teams",
        desc: "TINA Bot tham gia phòng họp minh bạch và truyền trực tiếp luồng âm thanh mã hóa về máy chủ riêng của tổ chức.",
      },
      core: {
        id: "core",
        short: "TINA Core",
        title: "Gateway, Quản trị & Phân quyền chủ sở hữu",
        desc: "Toàn bộ phiên OAuth, khóa API mô hình AI và kiểm soát truy cập theo chủ cuộc họp được xử lý 100% ở máy chủ.",
      },
      ai: {
        id: "ai",
        short: "AI & Giọng nói",
        title: "Dịch song ngữ VI+EN · Trợ lý “Tina ơi” · BYO LLM",
        desc: "Nhận dạng giọng nói song ngữ, trả lời thành tiếng có trích dẫn và kết nối ChatGPT Plan, Claude, Gemini hoặc AWS Bedrock.",
      },
      vault: {
        id: "vault",
        short: "Kho dữ liệu",
        title: "PostgreSQL · Valkey · S3 Ghi âm riêng",
        desc: "Bản ghi âm, transcript và nhật ký xử lý nằm hoàn toàn trong cơ sở dữ liệu và bucket S3 nội bộ — không train AI bên ngoài.",
      },
      wiki: {
        id: "wiki",
        short: "Wiki & Ghi chú",
        title: "Biên bản có trích dẫn & Bộ nhớ nhóm",
        desc: "Tự động chuẩn hóa tóm tắt điều hành, việc cần làm, kiểm chứng nguồn thoại và đồng bộ tức thì vào không gian Wiki nhóm.",
      },
    },
  },
  en: {
    ariaLabel: "TINA private infrastructure isometric architecture diagram",
    topTag: "PRIVATE INFRASTRUCTURE · LIVE",
    zoneLabel: "YOUR VPC / DOCKER / AWS",
    outsideBadge: "EXTERNAL CALLS",
    insideBadge: "INSIDE YOUR BOUNDARY",
    hint: "Hover or click any block to inspect the data path",
    nodes: {
      meetings: {
        id: "meetings",
        short: "Meetings",
        title: "Google Meet · Zoom · Microsoft Teams",
        desc: "TINA joins calls visibly and streams encrypted audio directly back into your organization’s own runtime perimeter.",
      },
      core: {
        id: "core",
        short: "TINA Core",
        title: "Private Gateway, Auth & Owner-Scoped ACLs",
        desc: "OAuth sessions, provider API keys, and meeting-owner permissions stay strictly server-side — never exposed to browsers.",
      },
      ai: {
        id: "ai",
        short: "AI & Voice",
        title: "Bilingual VI+EN ASR · “Tina ơi” TTS · BYO LLM",
        desc: "Real-time bilingual transcription, grounded voice replies, and pluggable ChatGPT Plan, Claude, Gemini, or AWS Bedrock.",
      },
      vault: {
        id: "vault",
        short: "Private Vault",
        title: "PostgreSQL · Valkey · Encrypted S3 Storage",
        desc: "Audio recordings, durable transcripts, and metadata live exclusively in your database and private object storage — never used for training.",
      },
      wiki: {
        id: "wiki",
        short: "Wiki & Notes",
        title: "Source-Cited Notes & Team Memory",
        desc: "Executive summaries, action items, and clickable speaker citations sync straight into your searchable workspace Wiki.",
      },
    },
  },
};

const NODE_ORDER: IsoNodeId[] = ["meetings", "core", "ai", "vault", "wiki"];

/* True 30° isometric projection into SVG viewBox 0 0 560 332 */
const COS30 = Math.cos(Math.PI / 6);
const SIN30 = 0.5;
const UNIT = 20.5;
const OX = 282;
const OY = 152;

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
  stroke = "#0a0c0a",
  strokeWidth = 0.9,
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

/** Mini isometric laptop (Google Meet / Microsoft Teams) */
function IsoLaptop({
  cx,
  cy,
  screenColor,
  active,
}: {
  cx: number;
  cy: number;
  screenColor: string;
  active: boolean;
}) {
  return (
    <g>
      {/* Keyboard base */}
      <IsoBox
        x0={cx - 0.65}
        y0={cy - 0.55}
        x1={cx + 0.55}
        y1={cy + 0.55}
        z0={0}
        z1={0.14}
        topFill="#2c312e"
        leftFill="#1d211f"
        rightFill="#141715"
      />
      {/* Angled lid at back-left edge (x = cx - 0.62) */}
      <polygon
        points={poly([
          [cx - 0.62, cy - 0.55, 0.14],
          [cx - 0.62, cy + 0.55, 0.14],
          [cx - 0.85, cy + 0.55, 1.02],
          [cx - 0.85, cy - 0.55, 1.02],
        ])}
        fill="#232825"
        stroke="#0a0c0a"
        strokeWidth="0.9"
        strokeLinejoin="round"
      />
      {/* Glowing call screen */}
      <polygon
        points={poly([
          [cx - 0.6, cy - 0.44, 0.24],
          [cx - 0.6, cy + 0.44, 0.24],
          [cx - 0.8, cy + 0.44, 0.92],
          [cx - 0.8, cy - 0.44, 0.92],
        ])}
        fill={screenColor}
        opacity={active ? 0.95 : 0.72}
      />
    </g>
  );
}

/** Mini isometric phone / tablet on stand (Zoom) */
function IsoTablet({ cx, cy, active }: { cx: number; cy: number; active: boolean }) {
  return (
    <g>
      <IsoBox
        x0={cx - 0.36}
        y0={cy - 0.36}
        x1={cx + 0.36}
        y1={cy + 0.36}
        z0={0}
        z1={0.12}
        topFill="#2a2f2c"
        leftFill="#1b1f1d"
        rightFill="#131614"
      />
      <IsoBox
        x0={cx - 0.16}
        y0={cy - 0.32}
        x1={cx + 0.08}
        y1={cy + 0.32}
        z0={0.12}
        z1={1.2}
        topFill="#303633"
        leftFill="#1f2421"
        rightFill="#252b28"
      />
      <polygon
        points={poly([
          [cx + 0.09, cy - 0.24, 0.25],
          [cx + 0.09, cy + 0.24, 0.25],
          [cx + 0.09, cy + 0.24, 1.08],
          [cx + 0.09, cy - 0.24, 1.08],
        ])}
        fill="#6ee7b7"
        opacity={active ? 0.95 : 0.7}
      />
    </g>
  );
}

export function PrivateInfraIso({ lang = "vi" }: { lang?: LandingLang }) {
  const uid = useId().replace(/:/g, "");
  const [activeNode, setActiveNode] = useState<IsoNodeId>("ai");
  const copy = ISO_COPY[lang];
  const activeCopy = copy.nodes[activeNode];

  // Floor grid lines inside the private zone
  const gridX = [-2, -1, 0, 1, 2, 3, 4, 5];
  const gridY = [-3, -2, -1, 0, 1, 2, 3];

  // Precomputed isometric centers for glow pools & rings
  const [aiCx, aiCy] = pt(2.65, 2.0, 0.05);
  const [aiTopX, aiTopY] = pt(2.65, 2.0, 0.56);
  const [coreTopX, coreTopY] = pt(0.45, -0.25, 3.45);
  const [vaultTopX, vaultTopY] = pt(3.35, -1.75, 2.0);
  const [vaultBaseX, vaultBaseY] = pt(3.35, -1.75, 0);
  const [wikiCx, wikiCy] = pt(4.95, 1.0, 0.08);

  // Flow paths
  const meetFlow = tracePath([
    [-4.35, -2.4, 0.04],
    [-2.75, -2.4, 0.04],
    [-1.25, -2.4, 0.04],
    [-1.25, -0.55, 0.04],
    [-0.4, -0.55, 0.04],
  ]);
  const zoomFlow = tracePath([
    [-4.55, 0, 0.04],
    [-0.4, 0, 0.04],
  ]);
  const teamsFlow = tracePath([
    [-4.35, 2.4, 0.04],
    [-2.75, 2.4, 0.04],
    [-1.25, 2.4, 0.04],
    [-1.25, 0.35, 0.04],
    [-0.4, 0.35, 0.04],
  ]);
  const coreToAi = tracePath([
    [0.45, 0.6, 0.04],
    [0.45, 2.0, 0.04],
    [1.8, 2.0, 0.04],
  ]);
  const coreToVault = tracePath([
    [1.3, -0.45, 0.04],
    [2.15, -0.45, 0.04],
    [2.15, -1.75, 0.04],
    [2.65, -1.75, 0.04],
  ]);
  const aiToWiki = tracePath([
    [3.5, 2.0, 0.04],
    [4.95, 2.0, 0.04],
    [4.95, 1.72, 0.04],
  ]);
  const vaultToWiki = tracePath([
    [3.35, -1.0, 0.04],
    [3.35, 0.85, 0.04],
    [4.15, 0.85, 0.04],
  ]);

  const meetingsHot = activeNode === "meetings" || activeNode === "core";
  const aiHot = activeNode === "ai" || activeNode === "core";
  const vaultHot = activeNode === "vault" || activeNode === "core";
  const wikiHot = activeNode === "wiki" || activeNode === "ai" || activeNode === "vault";

  return (
    <div className={styles.shell} aria-label={copy.ariaLabel}>
      <div className={styles.topBar}>
        <span className={styles.topLive}>
          <i aria-hidden="true" />
          {copy.topTag}
        </span>
        <span className={styles.topZone}>{copy.zoneLabel}</span>
      </div>

      <div className={styles.stageWrap}>
        <svg viewBox="10 28 478 252" className={styles.svg} role="img" aria-label={copy.ariaLabel}>
          <defs>
            <linearGradient id={`${uid}-baseTop`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#1b1e1c" />
              <stop offset="100%" stopColor="#111311" />
            </linearGradient>
            <linearGradient id={`${uid}-ownFloor`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#112a22" />
              <stop offset="100%" stopColor="#0c1c17" />
            </linearGradient>
            <linearGradient id={`${uid}-glassL`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`${uid}-glassR`} x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#176b5b" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0.03" />
            </linearGradient>
            <linearGradient id={`${uid}-cyl`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#48524c" />
              <stop offset="48%" stopColor="#2c332f" />
              <stop offset="100%" stopColor="#171c19" />
            </linearGradient>
            <radialGradient id={`${uid}-mintPool`} cx="0.5" cy="0.5" r="0.5">
              <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* 1. Outer dark architectural plinth */}
          <IsoBox
            x0={-6.3}
            y0={-4.0}
            x1={6.3}
            y1={4.0}
            z0={-0.46}
            z1={0}
            topFill={`url(#${uid}-baseTop)`}
            leftFill="#141715"
            rightFill="#0d0f0e"
            stroke="#2a2f2b"
            strokeWidth={0.8}
          />

          {/* 2. Private infrastructure glowing pad + grid */}
          <polygon
            points={poly([
              [-2.75, -3.7, 0.01],
              [6.0, -3.7, 0.01],
              [6.0, 3.7, 0.01],
              [-2.75, 3.7, 0.01],
            ])}
            fill={`url(#${uid}-ownFloor)`}
          />
          <g stroke="rgba(110, 231, 183, 0.12)" strokeWidth="0.7">
            {gridX.map((gx) => (
              <polyline key={`gx-${gx}`} points={poly([[gx, -3.7, 0.01], [gx, 3.7, 0.01]])} fill="none" />
            ))}
            {gridY.map((gy) => (
              <polyline key={`gy-${gy}`} points={poly([[-2.75, gy, 0.01], [6.0, gy, 0.01]])} fill="none" />
            ))}
          </g>

          {/* Back translucent perimeter glass walls (left-back x=-2.75 and right-back y=-3.7) */}
          <g pointerEvents="none">
            <polygon
              points={poly([
                [-2.75, -3.7, 0.01],
                [6.0, -3.7, 0.01],
                [6.0, -3.7, 2.3],
                [-2.75, -3.7, 2.3],
              ])}
              fill={`url(#${uid}-glassR)`}
              stroke="rgba(110, 231, 183, 0.24)"
              strokeWidth="0.8"
            />
            {[-1, 1, 3, 5].map((gx) => (
              <polyline
                key={`wall-mullion-${gx}`}
                points={poly([
                  [gx, -3.7, 0.01],
                  [gx, -3.7, 2.3],
                ])}
                stroke="rgba(110, 231, 183, 0.14)"
                strokeWidth="0.7"
              />
            ))}
            <polygon
              points={poly([
                [-2.75, -3.7, 0.01],
                [-2.75, 3.7, 0.01],
                [-2.75, 3.7, 2.3],
                [-2.75, -3.7, 2.3],
              ])}
              fill={`url(#${uid}-glassL)`}
              stroke="rgba(110, 231, 183, 0.22)"
              strokeWidth="0.8"
            />
          </g>

          {/* Dashed Mint security boundary outline on floor */}
          <polygon
            points={poly([
              [-2.75, -3.7, 0.02],
              [6.0, -3.7, 0.02],
              [6.0, 3.7, 0.02],
              [-2.75, 3.7, 0.02],
            ])}
            fill="none"
            stroke="#6ee7b7"
            strokeOpacity="0.65"
            strokeWidth="1.25"
            strokeDasharray="5 4"
          />

          {/* Subtle ambient Mint pools under AI chip, vault & Wiki */}
          <ellipse cx={aiCx} cy={aiCy} rx="52" ry="28" fill={`url(#${uid}-mintPool)`} opacity={aiHot ? 0.9 : 0.48} />
          <ellipse cx={vaultBaseX} cy={vaultBaseY} rx="40" ry="21" fill={`url(#${uid}-mintPool)`} opacity={vaultHot ? 0.72 : 0.3} />
          <ellipse cx={wikiCx} cy={wikiCy} rx="42" ry="22" fill={`url(#${uid}-mintPool)`} opacity={wikiHot ? 0.85 : 0.4} />

          {/* 3. Static circuit tracks + Animated isometric data flows */}
          <g fill="none" strokeLinecap="round" strokeLinejoin="round">
            {/* Inbound tracks from Meet / Zoom / Teams */}
            <path d={meetFlow} stroke="rgba(140, 171, 255, 0.35)" strokeWidth="2.1" />
            <path d={zoomFlow} stroke="rgba(110, 231, 183, 0.35)" strokeWidth="2.1" />
            <path d={teamsFlow} stroke="rgba(140, 171, 255, 0.35)" strokeWidth="2.1" />

            <path
              d={meetFlow}
              stroke="#8cabff"
              strokeWidth="2.8"
              className={`${styles.flow} ${meetingsHot ? styles.flowFast : ""}`}
            />
            <path
              d={zoomFlow}
              stroke="#6ee7b7"
              strokeWidth="2.8"
              className={`${styles.flow} ${meetingsHot ? styles.flowFast : ""}`}
            />
            <path
              d={teamsFlow}
              stroke="#8cabff"
              strokeWidth="2.8"
              className={`${styles.flow} ${meetingsHot ? styles.flowFast : ""}`}
            />

            {/* Internal Mint tracks inside the private fence */}
            <path d={coreToAi} stroke="rgba(110, 231, 183, 0.32)" strokeWidth="2.2" />
            <path d={coreToVault} stroke="rgba(110, 231, 183, 0.32)" strokeWidth="2.2" />
            <path d={aiToWiki} stroke="rgba(110, 231, 183, 0.32)" strokeWidth="2.2" />
            <path d={vaultToWiki} stroke="rgba(110, 231, 183, 0.32)" strokeWidth="2.2" />

            <path
              d={coreToAi}
              stroke="#6ee7b7"
              strokeWidth="3"
              className={`${styles.flow} ${aiHot ? styles.flowFast : ""}`}
            />
            <path
              d={coreToVault}
              stroke="#6ee7b7"
              strokeWidth="3"
              className={`${styles.flow} ${vaultHot ? styles.flowFast : ""}`}
            />
            <path
              d={aiToWiki}
              stroke="#6ee7b7"
              strokeWidth="3"
              className={`${styles.flow} ${wikiHot ? styles.flowFast : ""}`}
            />
            <path
              d={vaultToWiki}
              stroke="#b5e8d1"
              strokeWidth="2.6"
              className={`${styles.flow} ${wikiHot ? styles.flowFast : ""}`}
            />
          </g>

          {/* 4. External Meeting Devices (Meet, Zoom, Teams) */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("meetings")}
            onClick={() => setActiveNode("meetings")}
          >
            <IsoLaptop cx={-5.0} cy={-2.4} screenColor="#34d399" active={activeNode === "meetings"} />
            <IsoTablet cx={-5.0} cy={0} active={activeNode === "meetings"} />
            <IsoLaptop cx={-5.0} cy={2.4} screenColor="#8cabff" active={activeNode === "meetings"} />
          </g>

          {/* 5. Private Database / Encrypted S3 Vault Cylinder */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("vault")}
            onClick={() => setActiveNode("vault")}
          >
            {activeNode === "vault" && (
              <ellipse
                cx={vaultBaseX}
                cy={vaultBaseY}
                rx="28"
                ry="16"
                fill="none"
                stroke="#6ee7b7"
                strokeWidth="1.5"
                className={styles.ring}
              />
            )}
            {/* Cylinder body */}
            <path
              d={`M ${vaultBaseX - 22} ${vaultTopY} L ${vaultBaseX - 22} ${vaultBaseY} A 22 12 0 0 0 ${vaultBaseX + 22} ${vaultBaseY} L ${vaultBaseX + 22} ${vaultTopY} Z`}
              fill={`url(#${uid}-cyl)`}
              stroke="#0a0c0a"
              strokeWidth="1"
            />
            {/* Glowing Mint tier rings */}
            {[0.65, 1.32].map((rz) => {
              const [, ry] = pt(3.35, -1.75, rz);
              return (
                <path
                  key={`ring-${rz}`}
                  d={`M ${vaultBaseX - 22} ${ry} A 22 12 0 0 0 ${vaultBaseX + 22} ${ry}`}
                  fill="none"
                  stroke="#6ee7b7"
                  strokeOpacity={activeNode === "vault" ? "0.95" : "0.68"}
                  strokeWidth="1.3"
                />
              );
            })}
            {/* Top cap */}
            <ellipse
              cx={vaultTopX}
              cy={vaultTopY}
              rx="22"
              ry="12"
              fill="#2e3531"
              stroke={activeNode === "vault" ? "#6ee7b7" : "#444d48"}
              strokeWidth="1.1"
            />
            <ellipse
              cx={vaultTopX}
              cy={vaultTopY}
              rx="10"
              ry="5.5"
              fill="none"
              stroke="#6ee7b7"
              strokeOpacity="0.55"
              strokeWidth="1"
            />
          </g>

          {/* 6. Central TINA Core Server Tower */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("core")}
            onClick={() => setActiveNode("core")}
          >
            {/* Base glow border when active */}
            {activeNode === "core" && (
              <polygon
                points={poly([
                  [-0.58, -1.28, 0.03],
                  [1.48, -1.28, 0.03],
                  [1.48, 0.78, 0.03],
                  [-0.58, 0.78, 0.03],
                ])}
                fill="none"
                stroke="#6ee7b7"
                strokeWidth="1.5"
                className={styles.ring}
              />
            )}
            <IsoBox
              x0={-0.4}
              y0={-1.1}
              x1={1.3}
              y1={0.6}
              z0={0}
              z1={3.45}
              topFill="#303633"
              leftFill="#202522"
              rightFill="#151917"
              stroke={activeNode === "core" ? "#6ee7b7" : "#0a0c0a"}
              strokeWidth={activeNode === "core" ? 1.2 : 1}
            />
            {/* Rack horizontal blade dividers */}
            {[0.7, 1.35, 2.0, 2.65].map((rz) => (
              <g key={`blade-${rz}`} stroke="#0e110f" strokeWidth="1.1">
                <polyline points={poly([[-0.38, 0.6, rz], [1.28, 0.6, rz]])} />
                <polyline points={poly([[1.3, -1.08, rz], [1.3, 0.58, rz]])} />
              </g>
            ))}
            {/* Blinking TINA Mint status LEDs along front-left face */}
            {[0.4, 1.05, 1.7, 2.35, 3.0].map((rz, idx) => {
              const [lx, ly] = pt(-0.1, 0.61, rz);
              const [lx2, ly2] = pt(0.22, 0.61, rz);
              return (
                <g key={`led-${rz}`}>
                  <circle
                    cx={lx}
                    cy={ly}
                    r="2"
                    fill="#6ee7b7"
                    className={styles.blink}
                    style={{ animationDelay: `${idx * 0.45}s` }}
                  />
                  <circle
                    cx={lx2}
                    cy={ly2}
                    r="1.6"
                    fill={idx % 2 === 0 ? "#b5e8d1" : "#176b5b"}
                    className={styles.blink}
                    style={{ animationDelay: `${idx * 0.35 + 0.2}s` }}
                  />
                </g>
              );
            })}
            {/* Isometric TINA Brand Teal Emblem on Server Top */}
            <polygon
              points={poly([
                [-0.08, -0.78, 3.47],
                [0.98, -0.78, 3.47],
                [0.98, 0.28, 3.47],
                [-0.08, 0.28, 3.47],
              ])}
              fill="#176b5b"
              stroke="#6ee7b7"
              strokeWidth="1"
            />
            <text
              x={0}
              y={0}
              textAnchor="middle"
              dominantBaseline="central"
              fill="#ffffff"
              fontSize="12"
              fontWeight="800"
              fontFamily="Inter, system-ui, sans-serif"
              transform={`matrix(0.866,0.5,-0.866,0.5,${coreTopX},${coreTopY})`}
            >
              T
            </text>
          </g>

          {/* 7. AI & Voice Silicon Chip ("AI") */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("ai")}
            onClick={() => setActiveNode("ai")}
          >
            {activeNode === "ai" && (
              <polygon
                points={poly([
                  [1.55, 0.9, 0.03],
                  [3.75, 0.9, 0.03],
                  [3.75, 3.1, 0.03],
                  [1.55, 3.1, 0.03],
                ])}
                fill="none"
                stroke="#6ee7b7"
                strokeWidth="1.5"
                className={styles.ring}
              />
            )}
            {/* Metallic IC pins along all 4 sides */}
            <g stroke="#7b8781" strokeWidth="1.6" strokeLinecap="round">
              {[1.35, 1.68, 2.0, 2.32, 2.65].map((py) => (
                <g key={`pin-y-${py}`}>
                  <polyline points={poly([[1.58, py, 0.08], [1.82, py, 0.08]])} />
                  <polyline points={poly([[3.48, py, 0.08], [3.72, py, 0.08]])} />
                </g>
              ))}
              {[2.0, 2.32, 2.65, 2.98, 3.3].map((px) => (
                <g key={`pin-x-${px}`}>
                  <polyline points={poly([[px, 0.93, 0.08], [px, 1.17, 0.08]])} />
                  <polyline points={poly([[px, 2.83, 0.08], [px, 3.07, 0.08]])} />
                </g>
              ))}
            </g>
            {/* Chip substrate */}
            <IsoBox
              x0={1.8}
              y0={1.15}
              x1={3.5}
              y1={2.85}
              z0={0.05}
              z1={0.5}
              topFill="#242926"
              leftFill="#191d1a"
              rightFill="#121513"
              stroke={activeNode === "ai" ? "#6ee7b7" : "#3a423e"}
              strokeWidth={1.1}
            />
            {/* Glowing Mint / Teal AI Die */}
            <polygon
              points={poly([
                [2.1, 1.45, 0.52],
                [3.2, 1.45, 0.52],
                [3.2, 2.55, 0.52],
                [2.1, 2.55, 0.52],
              ])}
              fill={activeNode === "ai" ? "#6ee7b7" : "#176b5b"}
              stroke="#6ee7b7"
              strokeWidth="1.1"
            />
            <text
              x={0}
              y={0}
              textAnchor="middle"
              dominantBaseline="central"
              fill={activeNode === "ai" ? "#0a0b07" : "#f3f0e8"}
              fontSize="11.5"
              fontWeight="800"
              fontFamily="JetBrains Mono, monospace"
              transform={`matrix(0.866,0.5,-0.866,0.5,${aiTopX},${aiTopY})`}
            >
              AI
            </text>
          </g>

          {/* 8. Grounded Wiki & Notes Warm-Paper Stack */}
          <g
            className={styles.nodeHit}
            onMouseEnter={() => setActiveNode("wiki")}
            onClick={() => setActiveNode("wiki")}
          >
            <ellipse
              cx={wikiCx}
              cy={wikiCy}
              rx="28"
              ry="15"
              fill="none"
              stroke="#6ee7b7"
              strokeWidth="1.4"
              className={styles.ring}
            />
            {[0, 0.16, 0.32, 0.48].map((sz, idx) => (
              <IsoBox
                key={`sheet-${sz}`}
                x0={4.15}
                y0={0.28}
                x1={5.75}
                y1={1.72}
                z0={sz}
                z1={sz + 0.14}
                topFill={idx === 3 ? "#f3f0e8" : "#dcd7c8"}
                leftFill="#c4bfb0"
                rightFill="#a6a193"
                stroke="#0c0d0a"
                strokeWidth={0.75}
              />
            ))}
            {/* Mint highlight header strip + ink note lines on top sheet */}
            <polygon
              points={poly([
                [4.35, 0.48, 0.64],
                [5.48, 0.48, 0.64],
                [5.48, 0.7, 0.64],
                [4.35, 0.7, 0.64],
              ])}
              fill="#6ee7b7"
            />
            {[0.92, 1.15, 1.38].map((ly, idx) => (
              <polyline
                key={`line-${ly}`}
                points={poly([
                  [4.35, ly, 0.64],
                  [idx === 2 ? 5.18 : 5.52, ly, 0.64],
                ])}
                stroke="#1a1c19"
                strokeOpacity="0.65"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            ))}
          </g>

          {/* 9. Boundary legend — external calls vs inside the perimeter */}
          <g fontFamily="JetBrains Mono, monospace" fontSize="8.5" fontWeight="600" letterSpacing="1.2">
            <circle cx={30} cy={190} r="2.6" fill="#8cabff" />
            <text x={41} y={193} fill="rgba(243, 240, 232, 0.56)">
              {copy.outsideBadge}
            </text>
            <circle cx={30} cy={210} r="2.6" fill="#6ee7b7" />
            <text x={41} y={213} fill="#6ee7b7">
              {copy.insideBadge}
            </text>
          </g>
        </svg>
      </div>

      {/* Interactive subsystem selector pills */}
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

      {/* Live bilingual architectural detail readout */}
      <div className={styles.readout} role="status" aria-live="polite">
        <div className={styles.readoutHead}>
          <strong>{activeCopy.title}</strong>
          <span className={styles.readoutHint}>{copy.hint}</span>
        </div>
        <p>{activeCopy.desc}</p>
      </div>
    </div>
  );
}
