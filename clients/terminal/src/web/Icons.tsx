"use client";
import type { ReactNode } from "react";

export type WebIconName =
  | "home"
  | "tinaAsk"
  | "video"
  | "tasks"
  | "skills"
  | "settings"
  | "search"
  | "capture"
  | "chevronDown"
  | "chevronRight"
  | "sidebar"
  | "plus"
  | "close"
  | "mic"
  | "sendUp"
  | "layers"
  | "calendar"
  | "broadcast"
  | "calendarCheck"
  | "listChecks"
  | "sparkleSmall"
  | "terminal"
  | "logout"
  | "menu"
  | "link"
  | "arrowLeft"
  | "clock"
  | "trash"
  | "play"
  | "stop"
  | "refresh"
  | "check"
  | "users"
  | "cpu"
  | "key"
  | "github"
  | "user"
  | "sun"
  | "moon"
  | "chart"
  | "shield"
  | "copy"
  | "globe"
  | "fileText"
  | "list"
  | "moreHorizontal"
  | "filter"
  | "edit"
  | "share"
  | "zap"
  | "info"
  | "eye"
  | "eyeOff"
  | "externalLink"
  | "alertTriangle"
  | "pause"
  | "rotateCcw"
  | "rotateCw"
  | "download"
  | "star"
  | "checkSquare"
  | "maximize"
  | "minimize"
  | "chevronUp"
  | "volume"
  | "volumeX"
  | "hash"
  | "sliders"
  | "bookOpen"
  | "folder"
  | "upload"
  | "gitBranch"
  | "network"
  | "puzzle";

const PATHS: Record<WebIconName, ReactNode> = {
  home: (
    <>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5.5 9.5V20a1 1 0 0 0 1 1H9.5v-5.5h5V21h3a1 1 0 0 0 1-1V9.5" />
    </>
  ),
  tinaAsk: (
    <>
      <path d="M6 3h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H9l-5 3V5a2 2 0 0 1 2-2Z" />
      <path d="M12 7.4 13.15 10.25 16 11.4 13.15 12.55 12 15.4 10.85 12.55 8 11.4 10.85 10.25Z" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="6" width="12" height="12" rx="2.5" />
      <path d="m15 11 6-3.2v8.4L15 13" />
    </>
  ),
  tasks: (
    <>
      <path d="M4 7h10M4 12h7M4 17h10" />
      <path d="m15.5 16.5 1.8 1.8 3.2-3.6" />
    </>
  ),
  skills: <path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  capture: (
    <>
      <rect x="3" y="6" width="11" height="12" rx="2" />
      <path d="m14 11 6-3v8l-6-3" />
      <path d="M7.5 2.8v2M12 2.8v2" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  sidebar: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  mic: (
    <>
      <rect x="9.2" y="3" width="5.6" height="10.8" rx="2.8" />
      <path d="M5.8 11.4a6.2 6.2 0 0 0 12.4 0M12 17.6v3.8" />
    </>
  ),
  sendUp: (
    <>
      <path d="M12 19V5.5" />
      <path d="m5 12 7-7 7 7" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3.5 12.5 8.5 6.2 8.5-6.2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
      <path d="M8 3v4M16 3v4M3.5 9.5h17" />
    </>
  ),
  broadcast: (
    <>
      <circle cx="5" cy="19" r="1.9" fill="currentColor" stroke="none" />
      <path d="M5 12a7 7 0 0 1 7 7M5 5a14 14 0 0 1 14 14" />
    </>
  ),
  calendarCheck: (
    <>
      <rect x="3.2" y="4.6" width="17.6" height="16.4" rx="2.6" />
      <path d="M8 3v3.4M16 3v3.4M3.2 9.6h17.6" />
      <path d="m8.4 14.2 2.3 2.3 4.2-4.6" />
    </>
  ),
  listChecks: (
    <>
      <path d="m3 5.8 2.2 2.2 3.6-4" />
      <path d="M12.5 6.2h8" />
      <path d="M12.5 11.6h8" />
      <path d="m3 12.2 2.2 2.2 3.6-4" />
      <path d="M12.5 16.8h8" />
    </>
  ),
  sparkleSmall: (
    <>
      <path d="M8 3.5 9 7l3.5 1L9 9l-1 3.5L7 9 3.5 8 7 7 8 3.5Z" />
      <path d="M17 12.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m7.5 9.5 3 2.5-3 2.5" />
      <path d="M12.5 14.5h4" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H14" />
      <path d="M17 8.5 20.5 12 17 15.5M10 12h10" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  link: (
    <>
      <path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.5 1.5" />
      <path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5L12.5 17" />
    </>
  ),
  arrowLeft: (
    <>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  trash: <path d="M3 6h18M8 6V4h8v2m-11 0 1 14h12l1-14M10 11v5M14 11v5" />,
  play: <path d="M7 4.5v15l13-7.5-13-7.5Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  refresh: (
    <>
      <path d="M20 11a8 8 0 1 0 2 5.3" />
      <path d="M20 4v7h-7" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  users: (
    <>
      <path d="M16 20v-1.5a4 4 0 0 0-4-4H6.5a4 4 0 0 0-4 4V20" />
      <circle cx="9.25" cy="7.5" r="3.25" />
      <path d="M21.5 20v-1.5a3.5 3.5 0 0 0-2.6-3.4" />
      <path d="M15.5 4.4a3.25 3.25 0 0 1 0 6.2" />
    </>
  ),
  cpu: (
    <>
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <rect x="9.5" y="9.5" width="5" height="5" rx="0.8" />
      <path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9h3.5M2.5 15h3.5M18 9h3.5M18 15h3.5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="14" r="4" />
      <path d="m11 11 8.5-8.5M16 6l2.5 2.5M18.5 3.5 21 6" />
    </>
  ),
  github: (
    <path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21" />
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6" />
    </>
  ),
  moon: <path d="M20 14.8A8 8 0 0 1 9.2 4a8.2 8.2 0 1 0 10.8 10.8Z" />,
  chart: (
    <>
      <path d="M4 19.5h16" />
      <rect x="6" y="11" width="3" height="8.5" rx="0.8" />
      <rect x="11" y="6.5" width="3" height="13" rx="0.8" />
      <rect x="16" y="13.5" width="3" height="6" rx="0.8" />
    </>
  ),
  shield: <path d="M12 3 5 6v6c0 4.5 3 7.8 7 9 4-1.2 7-4.5 7-9V6l-7-3Z" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 0 0 18M12 3a14 14 0 0 1 0 18" />
    </>
  ),
  fileText: (
    <>
      <path d="M14.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8L14.5 3.5Z" />
      <path d="M14 3.5V8h4.5M8.5 12.5h7M8.5 16h5" />
    </>
  ),
  list: (
    <>
      <path d="M8.5 6.5h11M8.5 12h11M8.5 17.5h11" />
      <circle cx="4.5" cy="6.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  moreHorizontal: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  filter: <path d="M3.5 5.5h17l-6.5 7.4v5.1l-4 2v-7.1L3.5 5.5Z" />,
  edit: (
    <>
      <path d="M12 20h8" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5Z" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5.5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="18.5" r="2.5" />
      <path d="m8.2 10.8 7.6-4.1M8.2 13.2l7.6 4.1" />
    </>
  ),
  zap: <path d="M13 2.5 4.5 13h6.5L10 21.5 19.5 11H13l0-8.5Z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4.5M12 8.2h.01" />
    </>
  ),
  eye: (
    <>
      <path d="M2.2 12s3.6-6.5 9.8-6.5S21.8 12 21.8 12s-3.6 6.5-9.8 6.5S2.2 12 2.2 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6a2.8 2.8 0 0 0 3.8 3.8" />
      <path d="M9.4 5.7A10 10 0 0 1 12 5.5c6.2 0 9.8 6.5 9.8 6.5a16.8 16.8 0 0 1-3.3 4.1" />
      <path d="M6.4 6.7A16.5 16.5 0 0 0 2.2 12s3.6 6.5 9.8 6.5a10 10 0 0 0 4.3-.9" />
    </>
  ),
  externalLink: (
    <>
      <path d="M14.5 4.5h5v5" />
      <path d="M10.5 13.5 19.5 4.5" />
      <path d="M18.5 13.5v4.5a1.5 1.5 0 0 1-1.5 1.5H6a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 6 5.5h4.5" />
    </>
  ),
  alertTriangle: (
    <>
      <path d="M10.3 4.2 2.4 18a1.9 1.9 0 0 0 1.7 2.8h15.8a1.9 1.9 0 0 0 1.7-2.8L13.7 4.2a1.9 1.9 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4.3M12 17h.01" />
    </>
  ),
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" />
    </>
  ),
  rotateCcw: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </>
  ),
  rotateCw: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
      <path d="M21 3v5h-5" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11.5" />
      <path d="m7.5 11.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  star: (
    <path d="m12 3.2 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3.2Z" />
  ),
  checkSquare: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="m8 12.2 2.7 2.7 5.3-5.8" />
    </>
  ),
  maximize: (
    <>
      <path d="M8 3.5H4.5A1 1 0 0 0 3.5 4.5V8" />
      <path d="M16 3.5h3.5a1 1 0 0 1 1 1V8" />
      <path d="M20.5 16v3.5a1 1 0 0 1-1 1H16" />
      <path d="M8 20.5H4.5a1 1 0 0 1-1-1V16" />
    </>
  ),
  minimize: (
    <>
      <path d="M3.5 8H7a1 1 0 0 0 1-1V3.5" />
      <path d="M20.5 8H17a1 1 0 0 1-1-1V3.5" />
      <path d="M16 20.5V17a1 1 0 0 1 1-1h3.5" />
      <path d="M8 20.5V17a1 1 0 0 0-1-1H3.5" />
    </>
  ),
  chevronUp: <path d="m18 15-6-6-6 6" />,
  volume: (
    <>
      <path d="M11 5.5 6.5 9H3.5v6h3L11 18.5v-13Z" />
      <path d="M15.2 8.8a4.5 4.5 0 0 1 0 6.4M18 6a8.5 8.5 0 0 1 0 12" />
    </>
  ),
  volumeX: (
    <>
      <path d="M11 5.5 6.5 9H3.5v6h3L11 18.5v-13Z" />
      <path d="m15.5 9.5 5 5M20.5 9.5l-5 5" />
    </>
  ),
  hash: <path d="M4 9h16M4 15h16M10 3.5 8 20.5M16 3.5l-2 17" />,
  sliders: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8M4 12h16" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  bookOpen: (
    <>
      <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3H9a3 3 0 0 1 3 3v14a2.5 2.5 0 0 0-2.5-2.5H4.5A2.5 2.5 0 0 0 2 20V5.5Z" />
      <path d="M22 5.5A2.5 2.5 0 0 0 19.5 3H15a3 3 0 0 0-3 3v14a2.5 2.5 0 0 1 2.5-2.5h5A2.5 2.5 0 0 1 22 20V5.5Z" />
    </>
  ),
  folder: (
    <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4.2l2 2.2h6.8A2.5 2.5 0 0 1 21 8.7v9.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5v-12Z" />
  ),
  upload: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </>
  ),
  gitBranch: (
    <>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  network: (
    <>
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5" cy="18" r="2.5" />
      <circle cx="19" cy="18" r="2.5" />
      <line x1="10.8" y1="7.2" x2="6.2" y2="15.8" />
      <line x1="13.2" y1="7.2" x2="17.8" y2="15.8" />
      <line x1="7.5" y1="18" x2="16.5" y2="18" />
    </>
  ),
  puzzle: (
    <path d="M14 5a2 2 0 1 0-4 0H6a2 2 0 0 0-2 2v3.5a2 2 0 1 1 0 4V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3.5a2 2 0 1 0 0-4V7a2 2 0 0 0-2-2h-2Z" />
  ),
};

export function WebIcon({
  name,
  size = 16,
  strokeWidth = 1.6,
  className = "",
}: {
  name: WebIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
