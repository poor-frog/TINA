"use client";
// Lucian UX/UI Prompt #458 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#458
import { useEffect, useId, useRef } from "react";
import "./lucian-458.css";

export type VoiceOrbState = "idle" | "listen" | "think" | "speak";

const ORB_PARAMS: Record<
  VoiceOrbState,
  { sp: number; br: number; pu: number; base: number; gl: number; rr: number }
> = {
  idle: { sp: 0.35, br: 0.03, pu: 0, base: 1, gl: 0.62, rr: 9 },
  listen: { sp: 0.8, br: 0.012, pu: 0.03, base: 1.05, gl: 0.9, rr: 10 },
  think: { sp: 3.4, br: 0.008, pu: 0, base: 0.9, gl: 0.5, rr: 12 },
  speak: { sp: 1.1, br: 0, pu: 0.11, base: 1, gl: 0.95, rr: 10 },
};

const STATE_LABELS: Record<VoiceOrbState, string> = {
  idle: "Voice Agent ready",
  listen: "Listening for “Tina ơi”",
  think: "Preparing spoken reply…",
  speak: "Speaking in meeting…",
};

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function LucianVoiceOrb({
  state,
  label,
  sublabel,
  size = 36,
  onClick,
}: {
  state: VoiceOrbState;
  label?: string;
  sublabel?: string;
  size?: number;
  onClick?: () => void;
}) {
  const statusId = useId();
  const stateRef = useRef<VoiceOrbState>(state);
  stateRef.current = state;

  const orbRef = useRef<HTMLSpanElement>(null);
  const glowRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const orb = orbRef.current;
    const gw = glowRef.current;
    if (!orb || !gw) return;

    const blobs = Array.from(orb.querySelectorAll("i"));
    const cur = { ...ORB_PARAMS[stateRef.current] };
    let ang = 0;
    let last = 0;
    let raf = 0;
    const reduced = prefersReducedMotion();

    const draw = (t: number, dt: number) => {
      const st = stateRef.current;
      const tg = ORB_PARAMS[st];
      const f = reduced ? 1 : 1 - Math.exp(-dt * 3);
      cur.sp += (tg.sp - cur.sp) * f;
      cur.br += (tg.br - cur.br) * f;
      cur.pu += (tg.pu - cur.pu) * f;
      cur.base += (tg.base - cur.base) * f;
      cur.gl += (tg.gl - cur.gl) * f;
      cur.rr += (tg.rr - cur.rr) * f;

      ang += cur.sp * dt;
      const breathe = Math.sin(t * 1.7) * cur.br;
      const env = Math.max(0, Math.sin(t * 9.4)) * (0.55 + 0.45 * Math.sin(t * 2.3 + 0.7));
      const hum = Math.max(0, Math.sin(t * 6.1) * Math.sin(t * 1.9));
      const pulse = cur.pu * (st === "listen" ? hum : env);
      const s = cur.base + breathe + pulse;

      orb.style.transform = `scale(${s.toFixed(4)})`;
      gw.style.opacity = Math.min(1, cur.gl + pulse * 2.4).toFixed(3);
      gw.style.transform = `scale(${(s + pulse * 1.6 + breathe).toFixed(4)})`;

      blobs.forEach((el, i) => {
        const a = ang * (1 + i * 0.22) + (i * Math.PI) / 2;
        const r = cur.rr + Math.sin(t * 0.9 + i * 1.4) * 2.2;
        const sc = 1 + 0.16 * Math.sin(t * 1.3 + i * 1.7);
        el.style.transform = `translate(${(Math.cos(a) * r).toFixed(2)}px,${(Math.sin(a) * r).toFixed(2)}px) scale(${sc.toFixed(3)})`;
      });
    };

    if (reduced || typeof window.requestAnimationFrame !== "function") {
      draw(0, 1);
      return;
    }

    const frame = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016;
      last = now;
      draw(now / 1000, dt);
      raf = window.requestAnimationFrame(frame);
    };
    raf = window.requestAnimationFrame(frame);
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => {
    const orb = orbRef.current;
    if (!orb || prefersReducedMotion() || typeof orb.animate !== "function") return;
    orb.animate([{ filter: "brightness(1.22)" }, { filter: "brightness(1)" }], {
      duration: 420,
      easing: "ease-out",
    });
  }, [state]);

  const statusText = label ?? STATE_LABELS[state];

  return (
    <div
      className="ux u458"
      data-s={state}
      data-testid="lucian-voice-orb"
      style={{ "--u458-size": `${size}px` } as React.CSSProperties}
    >
      <button
        type="button"
        className="u458-b"
        aria-label="Voice assistant status"
        aria-describedby={statusId}
        onClick={onClick}
      >
        <span ref={glowRef} className="u458-gw" aria-hidden="true" />
        <span className="u458-rp" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span ref={orbRef} className="u458-o" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <b />
        </span>
      </button>
      <div className="u458-copy">
        <p id={statusId} className="u458-st" role="status">
          {statusText}
        </p>
        {sublabel && <span className="u458-sub">{sublabel}</span>}
      </div>
    </div>
  );
}
