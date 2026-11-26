"use client";
// Lucian UX/UI Prompt #214 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#214
import { useEffect, useRef, useState } from "react";
import "./lucian-214.css";

const BAR_HEIGHTS = [0.45, 0.7, 0.55, 0.9, 0.75, 1];
const PLATFORMS: ReadonlyArray<readonly [string, string]> = [
  ["G", "#0F9D58"],
  ["Z", "#2D8CFF"],
  ["T", "#6264A7"],
  ["J", "#176B5B"],
  ["D", "#5865F2"],
  ["C", "#EA4335"],
];

function bentoCopy(lang: "vi" | "en") {
  if (lang === "vi") {
    return {
      kicker: "Hệ sinh thái tích hợp",
      title: "Mọi công cụ cuộc họp trong một không gian sống",
      aTitle: "Phiên âm song ngữ",
      aSub: "3 người đang trao đổi trực tiếp",
      aIdle: "Chốt lộ trình triển khai Q3…",
      aTyped: "Chốt lộ trình triển khai Q3 với đội kỹ thuật",
      bTitle: "Hỏi Tina tức thì",
      bIdle: "Kế hoạch Q3",
      bTyped: "Quyết định cuộc họp Q3",
      cTitle: "Thống kê nói",
      dTitle: "Hạ tầng riêng",
      dSub: "Mã hóa & cách ly theo tổ chức",
      eTitle: "Đa nền tảng",
      eSub: "Meet, Zoom, Teams, Jitsi, Discord",
    };
  }
  return {
    kicker: "Interactive workspace",
    title: "Everything your meeting workflow needs, built in",
    aTitle: "Live bilingual capture",
    aSub: "3 speakers transcribed in sync",
    aIdle: "Finalizing Q3 pilot rollout…",
    aTyped: "Finalizing Q3 pilot rollout with engineering",
    bTitle: "Ask Tina",
    bIdle: "Q3 notes",
    bTyped: "Q3 launch decisions",
    cTitle: "Talk-time",
    dTitle: "Private infra",
    dSub: "Tenant-isolated & encrypted",
    eTitle: "All platforms",
    eSub: "Meet, Zoom, Teams, Jitsi, Discord",
  };
}

export function LucianBentoGrid({ lang = "vi" }: { lang?: "vi" | "en" }) {
  const copy = bentoCopy(lang);
  const [activeTile, setActiveTile] = useState<number | null>(null);
  const [typedA, setTypedA] = useState(copy.aIdle);
  const [typedB, setTypedB] = useState(copy.bIdle);
  const timerARef = useRef<number | null>(null);
  const timerBRef = useRef<number | null>(null);

  useEffect(() => {
    setTypedA(copy.aIdle);
    setTypedB(copy.bIdle);
  }, [copy.aIdle, copy.bIdle]);

  useEffect(
    () => () => {
      if (timerARef.current !== null) window.clearTimeout(timerARef.current);
      if (timerBRef.current !== null) window.clearTimeout(timerBRef.current);
    },
    [],
  );

  const runType = (
    full: string,
    setter: (v: string) => void,
    ref: React.MutableRefObject<number | null>,
  ) => {
    if (ref.current !== null) window.clearTimeout(ref.current);
    const rm =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (rm) {
      setter(full);
      return;
    }
    const chars = Array.from(full);
    let k = 0;
    const tick = () => {
      k += 1;
      setter(chars.slice(0, k).join(""));
      if (k < chars.length) {
        ref.current = window.setTimeout(tick, 42);
      }
    };
    tick();
  };

  const enterTile = (idx: number) => {
    setActiveTile(idx);
    if (idx === 0) runType(copy.aTyped, setTypedA, timerARef);
    if (idx === 1) runType(copy.bTyped, setTypedB, timerBRef);
  };

  const leaveTile = (idx: number) => {
    setActiveTile((cur) => (cur === idx ? null : cur));
  };

  return (
    <div className="tina-landing-ux">
      <div className="ux u214" data-testid="lucian-bento-grid">
        <div className="u214-hd">
          <small>{copy.kicker}</small>
          <h3>{copy.title}</h3>
        </div>
        <div className="u214-gd">
          <div
            className={`u214-t u214-a ${activeTile === 0 ? "is-on" : ""}`}
            tabIndex={0}
            onPointerEnter={() => enterTile(0)}
            onPointerLeave={() => leaveTile(0)}
            onFocus={() => enterTile(0)}
            onBlur={() => leaveTile(0)}
          >
            <b>{copy.aTitle}</b>
            <small>{copy.aSub}</small>
            <span className="u214-av" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div className="u214-ty" aria-hidden="true">
              {typedA}
            </div>
          </div>

          <div
            className={`u214-t u214-b ${activeTile === 1 ? "is-on" : ""}`}
            tabIndex={0}
            onPointerEnter={() => enterTile(1)}
            onPointerLeave={() => leaveTile(1)}
            onFocus={() => enterTile(1)}
            onBlur={() => leaveTile(1)}
          >
            <b>{copy.bTitle}</b>
            <div className="u214-sb" aria-hidden="true">
              <svg viewBox="0 0 12 12">
                <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path d="M7.6 7.6 10.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <span>{typedB}</span>
            </div>
            <div className="u214-rs" aria-hidden="true">
              <i style={{ "--w": 0.92 } as React.CSSProperties} />
              <i style={{ "--w": 0.7 } as React.CSSProperties} />
              <i style={{ "--w": 0.82 } as React.CSSProperties} />
              <i style={{ "--w": 0.55 } as React.CSSProperties} />
            </div>
          </div>

          <div
            className={`u214-t u214-c ${activeTile === 2 ? "is-on" : ""}`}
            tabIndex={0}
            onPointerEnter={() => enterTile(2)}
            onPointerLeave={() => leaveTile(2)}
            onFocus={() => enterTile(2)}
            onBlur={() => leaveTile(2)}
          >
            <b>{copy.cTitle}</b>
            <div className="u214-br" aria-hidden="true">
              {BAR_HEIGHTS.map((h, i) => (
                <i key={i} style={{ "--h": h, "--i": i } as React.CSSProperties} />
              ))}
            </div>
          </div>

          <div
            className={`u214-t u214-d ${activeTile === 3 ? "is-on" : ""}`}
            tabIndex={0}
            onPointerEnter={() => enterTile(3)}
            onPointerLeave={() => leaveTile(3)}
            onFocus={() => enterTile(3)}
            onBlur={() => leaveTile(3)}
          >
            <b>{copy.dTitle}</b>
            <small>{copy.dSub}</small>
            <span className="u214-sh" aria-hidden="true">
              <svg viewBox="0 0 30 34">
                <path d="M15 2l11 4.5v8.5c0 8-5 13.5-11 16.5C9 28.5 4 23 4 15V6.5z" fill="currentColor" opacity=".18" />
                <path d="M15 2l11 4.5v8.5c0 8-5 13.5-11 16.5C9 28.5 4 23 4 15V6.5z" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M10.5 16.5l3 3 6-6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </div>

          <div
            className={`u214-t u214-e ${activeTile === 4 ? "is-on" : ""}`}
            tabIndex={0}
            onPointerEnter={() => enterTile(4)}
            onPointerLeave={() => leaveTile(4)}
            onFocus={() => enterTile(4)}
            onBlur={() => leaveTile(4)}
          >
            <b>{copy.eTitle}</b>
            <small>{copy.eSub}</small>
            <div className="u214-lg" aria-hidden="true">
              <div className="u214-lt">
                {PLATFORMS.concat(PLATFORMS).map(([letter, color], idx) => (
                  <i key={idx} style={{ color }}>
                    {letter}
                  </i>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
