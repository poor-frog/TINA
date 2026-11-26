"use client";
// Lucian UX/UI Prompt #211 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#211
import "./lucian-211.css";

export function LucianGlowCta({
  lang = "vi",
  titleLine1,
  titleSerif,
  sub,
  primaryLabel,
  secondaryLabel,
  secondaryHref = "#home-hero",
  serifClassName,
  onPrimaryClick,
}: {
  lang?: "vi" | "en";
  titleLine1: string;
  titleSerif: string;
  sub: string;
  primaryLabel: string;
  secondaryLabel: string;
  secondaryHref?: string;
  serifClassName?: string;
  onPrimaryClick: () => void;
}) {
  const badge =
    lang === "vi" ? "Hạ tầng riêng · Phiên âm song ngữ VI + EN" : "Private infrastructure · VI + EN real-time";
  const notes =
    lang === "vi"
      ? ["Đăng nhập Google / Microsoft", "Cách ly dữ liệu theo tổ chức", "Sẵn sàng sau 1 phút"]
      : ["Google & Microsoft SSO", "Tenant-isolated workspace", "Ready in 60 seconds"];

  return (
    <div className="tina-landing-ux-dark">
      <div className="ux u211" data-testid="lucian-glow-cta">
        <span className="u211-bm" aria-hidden="true" />
        <span className="u211-tg">
          <em aria-hidden="true">✦</em>
          <span>{badge}</span>
        </span>
        <h2 className="u211-h">
          {titleLine1}
          <br />
          <span className={`${serifClassName ?? ""} u211-gr`}>{titleSerif}</span>
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
        <div className="u211-ns">
          {notes.map((text) => (
            <span key={text}>
              <svg viewBox="0 0 11 11" aria-hidden="true">
                <path
                  d="M2.2 5.8l2 2L8.8 3.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              {text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
