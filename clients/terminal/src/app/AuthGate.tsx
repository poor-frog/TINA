"use client";
/** Login gate — upgraded split-screen TINA login experience wrapping the real NextAuth OAuth
 *  (Google / Microsoft), first-run admin claim screen (`/api/auth/instance`), and development
 *  `@example.test` direct sign-in path. Uses scoped `.tina-login-*` classes from `src/web/tina-web.css`
 *  with zero hardcoded hex colors inside this component. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import "../web/tina-web.css";

type Status = "checking" | "out" | "in";
type Providers = { google: boolean; microsoft: boolean };

const SAMPLE_PROMPTS = [
  "Summarize decisions and action items from today's sync.",
  "What blockers did the engineering team raise this week?",
  "Draft a concise follow-up note with assigned owners.",
];

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [providers, setProviders] = useState<Providers>({ google: false, microsoft: false });
  const [adminExists, setAdminExists] = useState(true);
  const [showDebug, setShowDebug] = useState(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptIdx, setPromptIdx] = useState(0);
  const [previewBusy, setPreviewBusy] = useState(false);
  const notesRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (active ? setStatus(r.ok ? "in" : "out") : undefined))
      .catch(() => active && setStatus("out"));
    fetch("/api/auth/providers", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .then((p: Record<string, unknown>) =>
        active && setProviders({ google: !!p.google, microsoft: !!p.microsoft }),
      )
      .catch(() => undefined);
    fetch("/api/auth/instance", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { admin_exists: true }))
      .then((d: { admin_exists?: boolean }) => active && setAdminExists(d.admin_exists !== false))
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    if (notesRef.current) notesRef.current.style.transform = `translate(${10 * x}px, ${10 * y}px)`;
    if (inputRef.current) inputRef.current.style.transform = `translate(${20 * x}px, ${16 * y}px)`;
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (notesRef.current) notesRef.current.style.transform = "";
    if (inputRef.current) inputRef.current.style.transform = "";
  }, []);

  const cyclePreviewPrompt = () => {
    setPreviewBusy(true);
    window.setTimeout(() => {
      setPromptIdx((cur) => (cur + 1) % SAMPLE_PROMPTS.length);
      setPreviewBusy(false);
    }, 850);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim();
    if (!value || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      if (r.ok) { window.location.reload(); return; }
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setError(body.error || `Login failed (${r.status})`);
    } catch (err) {
      setError((err as Error).message || "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "in") return <>{children}</>;
  if (status === "checking") return <div className="tina-login-checking" />;

  const hasOAuth = providers.google || providers.microsoft;
  const claiming = !adminExists;
  const directLoginAvailable = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  const callbackUrl = typeof window !== "undefined"
    ? window.location.pathname + window.location.search + window.location.hash
    : "/";

  return (
    <div className="tina-login-shell">
      <div className="tina-login-modal">
        <div className="tina-login-form-panel">
          <div className="tina-login-inner">
            <div className="tina-login-center">
              <div className="tina-login-top">
                <div className="tina-login-logo">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/tina-logo.svg" alt="TINA" width={36} height={36} />
                </div>
                <h1 className="tina-login-heading">
                  {claiming ? "Set up your instance" : "Listen clearly.\nAct together."}
                </h1>
                <p className="tina-login-sub">
                  {claiming
                    ? "This TINA instance has no administrator yet. The first sign-in becomes the admin and can configure models, transcription, and teammates."
                    : "Sign in to your self-hosted TINA workspace for live meeting notes, bilingual transcripts, and grounded answers."}
                </p>
                {claiming && (
                  <div className="tina-login-claim-pill">
                    <span className="tina-login-claim-dot" aria-hidden="true" />
                    First sign-in = administrator
                  </div>
                )}
              </div>

              <div className="tina-login-actions">
                {claiming && !hasOAuth && directLoginAvailable && (
                  <div className="tina-login-notice">
                    Development test mode — sign-in is limited to @example.test addresses. Add GOOGLE_CLIENT_ID/SECRET or MICROSOFT_CLIENT_ID/SECRET for OAuth.
                  </div>
                )}
                {claiming && !hasOAuth && !directLoginAvailable && (
                  <div className="tina-login-notice">
                    Configure Google or Microsoft OAuth to sign in. Passwordless test login is disabled outside development.
                  </div>
                )}

                {hasOAuth && (
                  <div className="tina-login-oauth-list">
                    {providers.google && (
                      <button
                        type="button"
                        className="tina-login-oauth-btn"
                        onClick={() => void signIn("google", { callbackUrl })}
                      >
                        <span className="tina-login-oauth-leading">
                          <GoogleMark />
                          <span>Continue with Google</span>
                        </span>
                        <ArrowRightMark />
                      </button>
                    )}
                    {providers.microsoft && (
                      <button
                        type="button"
                        className="tina-login-oauth-btn"
                        onClick={() => void signIn("microsoft", { callbackUrl })}
                      >
                        <span className="tina-login-oauth-leading">
                          <MicrosoftMark />
                          <span>Continue with Microsoft</span>
                        </span>
                        <ArrowRightMark />
                      </button>
                    )}
                  </div>
                )}

                {hasOAuth && directLoginAvailable && (
                  <button
                    type="button"
                    className="tina-login-debug-toggle"
                    onClick={() => setShowDebug((v) => !v)}
                  >
                    {showDebug ? "Hide debug sign-in" : "Debug sign-in"}
                  </button>
                )}

                {directLoginAvailable && (!hasOAuth || showDebug) && (
                  <form className="tina-login-direct-form" onSubmit={submit}>
                    <div className="tina-login-direct-hint">
                      {claiming && !hasOAuth
                        ? "Email — use an @example.test address (development only)."
                        : "Debug login — use an @example.test address."}
                    </div>
                    <input
                      type="email"
                      required
                      className="tina-login-input"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="you@example.test"
                    />
                    {error && <div role="alert" className="tina-login-error">{error}</div>}
                    <button
                      type="submit"
                      className="tina-login-submit"
                      disabled={!email.trim() || submitting}
                    >
                      {submitting ? "Signing in…" : claiming ? "Sign in as admin" : "Sign in"}
                    </button>
                  </form>
                )}

                {claiming && (
                  <p className="tina-login-claim-foot">
                    This claim screen disappears once an admin exists.
                  </p>
                )}
              </div>
            </div>

            <div className="tina-login-bottom">
              <div className="tina-login-security">
                <LockMark />
                <span>SELF-HOSTED · PRIVATE WORKSPACE · CREDENTIALS STAY SERVER-SIDE</span>
              </div>
            </div>
          </div>
        </div>

        <div
          className="tina-login-showcase"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          aria-hidden="true"
        >
          <div className="tina-login-glow" />
          <div className="tina-login-grid" />

          <div className="tina-login-float-notes">
            <div className="tina-login-parallax" ref={notesRef}>
              <div className="tina-login-card">
                <div className="tina-login-card-head">
                  <span className="tina-login-card-title">Product Weekly Sync</span>
                  <span className="tina-login-card-badge">Song ngữ · Live</span>
                </div>
                <div className="tina-login-card-body">
                  <div className="tina-login-note-row">
                    <span className="tina-login-note-dot" />
                    <span>Chốt mốc phát hành giao diện người dùng và kiểm thử thực tế trên môi trường self-hosted.</span>
                  </div>
                  <div className="tina-login-note-row muted">
                    <span className="tina-login-note-dot" />
                    <span>Finalize production user UI rollout and live bilingual transcript verification.</span>
                  </div>
                  <div className="tina-login-note-bars">
                    <span className="tina-login-bar wide" />
                    <span className="tina-login-bar narrow" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="tina-login-float-input">
            <div className="tina-login-parallax" ref={inputRef}>
              <div className="tina-login-prompt-card">
                <div className="tina-login-prompt-row">
                  <span className="tina-login-prompt-text">{SAMPLE_PROMPTS[promptIdx]}</span>
                  <button
                    type="button"
                    tabIndex={-1}
                    className="tina-login-prompt-send"
                    onClick={cyclePreviewPrompt}
                  >
                    ↑
                  </button>
                </div>
                {previewBusy && (
                  <div className="tina-login-prompt-pill">TINA is grounding answer in meeting transcript…</div>
                )}
              </div>
            </div>
          </div>

          <div className="tina-login-quote">
            <div className="tina-login-quote-tag">TINA · ATTENTIVE MEETING COMPANION</div>
            <h2>&ldquo;TINA keeps everyone present in the room, and the bilingual draft is ready the moment we wrap.&rdquo;</h2>
            <p>Self-hosted transcription, workspace memory, and grounded follow-ups under your control.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Google's multicolor "G" brand mark. */
export function GoogleMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 48 48" style={{ flex: "none" }} aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

function MicrosoftMark() {
  return (
    <svg width={16} height={16} viewBox="0 0 23 23" style={{ flex: "none" }} aria-hidden="true">
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M12 1h10v10H12z" />
      <path fill="#00A4EF" d="M1 12h10v10H1z" />
      <path fill="#FFB900" d="M12 12h10v10H12z" />
    </svg>
  );
}

function ArrowRightMark() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

function LockMark() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="7.2" width="11" height="7" rx="1.6" />
      <path d="M4.8 7.2V4.8a3.2 3.2 0 0 1 6.4 0v2.4" />
    </svg>
  );
}
