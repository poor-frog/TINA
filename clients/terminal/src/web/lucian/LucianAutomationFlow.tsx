"use client";
// Lucian UX/UI Prompt #201 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#201
import { useEffect, useRef, useState } from "react";
import "./lucian-201.css";

interface FlowNodeSpec {
  title: string;
  idleSub: string;
  doneSub: string;
  color: string;
  left: number;
  top: number;
}

const POS: ReadonlyArray<readonly [number, number, string]> = [
  [94, 68, "#176B5B"],
  [94, 142, "#0EA5E9"],
  [14, 236, "#10B981"],
  [174, 236, "#F59E0B"],
];

function getFlowCopy(lang: "vi" | "en") {
  if (lang === "vi") {
    return {
      heading: "Luồng tự động sau mỗi cuộc họp",
      sub: "Đang bật · Bot + Extension + Wiki",
      run: "Chạy thử",
      running: "Đang chạy",
      runAgain: "Chạy lại",
      finished: (sec: string) => `Hoàn tất quy trình · ${sec} s`,
      nodes: [
        { title: "Vào Google Meet", idleSub: "TINA Bot · Extension", doneSub: "Đã ghi âm & phiên âm" },
        { title: "Hỏi đáp & Tóm tắt AI", idleSub: "Song ngữ · “Tina ơi”", doneSub: "Trích dẫn nguồn · 98%" },
        { title: "Cập nhật Wiki", idleSub: "My Space · Team", doneSub: "Đã liên kết [[Entity]]" },
        { title: "Tạo Action Items", idleSub: "kg/entities/task/", doneSub: "Đã nháp 3 đầu việc" },
      ],
    };
  }
  return {
    heading: "Autonomous meeting pipeline",
    sub: "Live · Bot + Extension + Wiki",
    run: "Run",
    running: "Running",
    runAgain: "Run again",
    finished: (sec: string) => `Run finished · ${sec} s`,
    nodes: [
      { title: "Join Google Meet", idleSub: "TINA Bot · Extension", doneSub: "Captured & transcribed" },
      { title: "Bilingual AI + Voice", idleSub: "VI + EN · “Hey Tina”", doneSub: "Cited brief · 98%" },
      { title: "Update Knowledge", idleSub: "My Space · Team", doneSub: "Linked [[Entities]]" },
      { title: "Draft Action Items", idleSub: "kg/entities/task/", doneSub: "3 tasks drafted" },
    ],
  };
}

export function LucianAutomationFlow({ lang = "vi" }: { lang?: "vi" | "en" }) {
  const copy = getFlowCopy(lang);
  const rootRef = useRef<HTMLDivElement>(null);
  const pathRefs = useRef<Array<SVGPathElement | null>>([]);
  const dotRefs = useRef<Array<SVGCircleElement | null>>([]);
  const genRef = useRef(0);
  const timersRef = useRef<number[]>([]);
  const rafsRef = useRef<number[]>([]);

  const [nodeStates, setNodeStates] = useState<Array<"idle" | "run" | "done">>(["idle", "idle", "idle", "idle"]);
  const [nodeMs, setNodeMs] = useState<string[]>(["", "", "", ""]);
  const [activePaths, setActivePaths] = useState<boolean[]>([false, false, false]);
  const [running, setRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [footerText, setFooterText] = useState("");

  useEffect(
    () => () => {
      genRef.current += 1;
      timersRef.current.forEach((t) => window.clearTimeout(t));
      rafsRef.current.forEach((r) => window.cancelAnimationFrame(r));
    },
    [],
  );

  const runFlow = () => {
    const rm =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const g = ++genRef.current;
    timersRef.current.forEach((t) => window.clearTimeout(t));
    rafsRef.current.forEach((r) => window.cancelAnimationFrame(r));
    timersRef.current = [];
    rafsRef.current = [];

    const t0 = performance.now();
    setRunning(true);
    setHasRun(true);
    setFooterText("");
    setNodeStates(["idle", "idle", "idle", "idle"]);
    setNodeMs(["", "", "", ""]);
    setActivePaths([false, false, false]);
    dotRefs.current.forEach((c) => {
      if (c) c.style.opacity = "0";
    });

    const later = (ms: number, fn: () => void) => {
      const id = window.setTimeout(() => {
        if (g === genRef.current && rootRef.current?.isConnected) fn();
      }, rm ? Math.min(ms, 40) : ms);
      timersRef.current.push(id);
    };

    const flow = (k: number, ms: number, done: () => void) => {
      setActivePaths((prev) => prev.map((v, idx) => (idx === k ? true : v)));
      const p = pathRefs.current[k];
      const c = dotRefs.current[k];
      if (rm || !p || !c || typeof p.getTotalLength !== "function") {
        later(20, done);
        return;
      }
      const L = p.getTotalLength();
      const start = performance.now();
      c.style.opacity = "1";
      const frame = (now: number) => {
        if (g !== genRef.current) return;
        const q = Math.min(1, (now - start) / ms);
        const eased = q < 0.5 ? 2 * q * q : 1 - Math.pow(-2 * q + 2, 2) / 2;
        const pt = p.getPointAtLength(L * eased);
        c.setAttribute("cx", String(pt.x));
        c.setAttribute("cy", String(pt.y));
        if (q < 1) {
          const rid = window.requestAnimationFrame(frame);
          rafsRef.current.push(rid);
        } else {
          c.style.opacity = "0";
          done();
        }
      };
      const rid = window.requestAnimationFrame(frame);
      rafsRef.current.push(rid);
    };

    const step = (idx: number, ms: number, after: () => void) => {
      setNodeStates((prev) => prev.map((s, i) => (i === idx ? "run" : s)));
      later(ms, () => {
        setNodeStates((prev) => prev.map((s, i) => (i === idx ? "done" : s)));
        setNodeMs((prev) => prev.map((v, i) => (i === idx ? `${(ms / 1000).toFixed(1)} s` : v)));
        after();
      });
    };

    step(0, 300, () => {
      flow(0, 520, () => {
        step(1, 900, () => {
          let left = 2;
          const finishBranch = () => {
            left -= 1;
            if (left > 0) return;
            setRunning(false);
            const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
            setFooterText(copy.finished(elapsed));
          };
          flow(1, 600, () => step(2, 480, finishBranch));
          flow(2, 600, () => step(3, 680, finishBranch));
        });
      });
    });
  };

  const nodes: FlowNodeSpec[] = copy.nodes.map((n, i) => ({
    ...n,
    left: POS[i][0],
    top: POS[i][1],
    color: POS[i][2],
  }));

  return (
    <div className="u201-shell tina-landing-ux">
      <div ref={rootRef} className="ux u201" data-testid="lucian-automation-flow">
        <div className="u201-hd">
          <div>
            <b>{copy.heading}</b>
            <small>{copy.sub}</small>
          </div>
          <button type="button" className="u201-run" disabled={running} onClick={runFlow}>
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2.5 1.5l6 3.5-6 3.5z" fill="currentColor" />
            </svg>
            <span>{running ? copy.running : hasRun ? copy.runAgain : copy.run}</span>
          </button>
        </div>

        <div className="u201-stage">
          <svg className="u201-cv" viewBox="0 0 340 340" aria-hidden="true">
            <path
              ref={(el) => {
                pathRefs.current[0] = el;
              }}
              className={activePaths[0] ? "is-on" : ""}
              d="M170 112 V142"
            />
            <path
              ref={(el) => {
                pathRefs.current[1] = el;
              }}
              className={activePaths[1] ? "is-on" : ""}
              d="M170 186 C170 214 90 206 90 236"
            />
            <path
              ref={(el) => {
                pathRefs.current[2] = el;
              }}
              className={activePaths[2] ? "is-on" : ""}
              d="M170 186 C170 214 250 206 250 236"
            />
            {[0, 1, 2].map((k) => (
              <circle
                key={k}
                ref={(el) => {
                  dotRefs.current[k] = el;
                }}
                r="4"
              />
            ))}
          </svg>

          <div role="list">
            {nodes.map((node, i) => {
              const st = nodeStates[i];
              return (
                <div
                  key={node.title}
                  className={`u201-nd ${st === "run" ? "is-run" : ""} ${st === "done" ? "is-done" : ""}`}
                  role="listitem"
                  style={{ left: node.left, top: node.top }}
                >
                  <span className="u201-ic" style={{ background: node.color }} aria-hidden="true">
                    {i === 0 && (
                      <svg viewBox="0 0 14 14">
                        <rect x="2" y="3.5" width="7" height="7" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                        <path d="M9 6l3-1.8v5.6L9 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                      </svg>
                    )}
                    {i === 1 && (
                      <svg viewBox="0 0 14 14">
                        <path d="M7 1.5l1.3 3.2 3.2 1.3-3.2 1.3L7 10.5 5.7 7.3 2.5 6l3.2-1.3z" fill="currentColor" />
                        <circle cx="11" cy="11" r="1.3" fill="currentColor" />
                      </svg>
                    )}
                    {i === 2 && (
                      <svg viewBox="0 0 14 14">
                        <path d="M2.5 3h4a1.5 1.5 0 0 1 1.5 1.5V11a1.2 1.2 0 0 0-1.2-1.2H2.5zM11.5 3h-4A1.5 1.5 0 0 0 6 4.5V11a1.2 1.2 0 0 1 1.2-1.2h4.3z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                      </svg>
                    )}
                    {i === 3 && (
                      <svg viewBox="0 0 14 14">
                        <path d="M3 7.2l2.4 2.4L11 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </span>
                  <span className="u201-tx">
                    <b>{node.title}</b>
                    <span>{st === "done" ? node.doneSub : node.idleSub}</span>
                  </span>
                  <span className="u201-s" aria-hidden="true" />
                  <em className="u201-ms">{nodeMs[i]}</em>
                </div>
              );
            })}
          </div>
        </div>

        <div className={`u201-ft ${footerText ? "is-on" : ""}`} role="status">
          {footerText}
        </div>
      </div>
    </div>
  );
}
