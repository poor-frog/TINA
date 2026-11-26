"use client";
// Lucian UX/UI Prompt #439 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#439
import "./lucian-439.css";

export function LucianSkeletonList({
  count = 4,
  variant = "row",
  label = "Loading…",
}: {
  count?: number;
  variant?: "row" | "chat";
  label?: string;
}) {
  return (
    <div
      className="ux u439-stack u439-sk"
      role="status"
      aria-busy="true"
      aria-label={label}
      data-testid="lucian-skeleton-list"
    >
      {Array.from({ length: count }, (_, idx) => (
        <article
          key={idx}
          className={`u439-c ${variant === "chat" ? "is-chat" : ""}`}
          aria-hidden="true"
          style={{ "--d": `${(idx * 0.1).toFixed(2)}s` } as React.CSSProperties}
        >
          {variant === "row" ? (
            <>
              <i className="u439-av-sk" />
              <div className="u439-lines">
                <i className="a" style={{ width: `${52 + ((idx * 17) % 30)}%` }} />
                <i className="b" style={{ width: `${32 + ((idx * 13) % 24)}%` }} />
              </div>
              <i className="u439-pill-sk" />
            </>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <i className="u439-av-sk" style={{ width: 24, height: 24 }} />
                <i style={{ width: 76, height: 11 }} />
              </div>
              <div className="u439-lines">
                <i className="c" style={{ width: `${74 + ((idx * 11) % 22)}%` }} />
                <i className="a" style={{ width: `${46 + ((idx * 19) % 32)}%` }} />
              </div>
            </>
          )}
        </article>
      ))}
      <span className="u439-sr">{label}</span>
    </div>
  );
}
