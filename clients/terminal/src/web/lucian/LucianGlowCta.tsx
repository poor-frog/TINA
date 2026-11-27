"use client";
// Lucian UX/UI Prompt #211 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#211
import "./lucian-211.css";

export function LucianGlowCta({
  titleLine1,
  titleSerif,
  sub,
  primaryLabel,
  secondaryLabel,
  secondaryHref = "#home-hero",
  onPrimaryClick,
}: {
  titleLine1: string;
  titleSerif: string;
  sub: string;
  primaryLabel: string;
  secondaryLabel: string;
  secondaryHref?: string;
  onPrimaryClick: () => void;
}) {
  return (
    <div className="tina-landing-ux-dark">
      <div className="ux u211" data-testid="lucian-glow-cta">
        <span className="u211-bm" aria-hidden="true" />
        <h2 className="u211-h">
          {titleLine1}
          {" "}{titleSerif}
        </h2>
        <p className="u211-p">{sub}</p>
        <div className="u211-row">
          <button type="button" className="u211-bt" onClick={onPrimaryClick}>
            <span className="u211-in">
              <span>{primaryLabel}</span>
              <svg className="u211-ar" viewBox="0 0 14 14" aria-hidden="true">
                <path
                  d="M3 7h8M7.5 3.5 11 7l-3.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </button>
          <a className="u211-gh" href={secondaryHref}>
            {secondaryLabel}
          </a>
        </div>
      </div>
    </div>
  );
}
