"use client";
/** Login gate — editorial pre-login TINA landing & OAuth gate wrapping real NextAuth OAuth
 *  (Google / Microsoft), first-run admin claim (`/api/auth/instance`), and development
 *  `@example.test` direct sign-in path. Presentation lives in `src/web/TinaLanding.tsx`
 *  with strictly scoped CSS Modules so zero styles leak into `/terminal` or `.tina-web`. */
import { useEffect, useState, type FormEvent } from "react";
import { signIn } from "next-auth/react";
import { TinaLanding } from "../web/TinaLanding";
import { CalendarWelcome } from "../web/CalendarWelcome";
import landingStyles from "../web/tinaLanding.module.css";

type Status = "checking" | "out" | "in";
type Providers = { google: boolean; microsoft: boolean };
const CALENDAR_DISMISSED_KEY = "tina.calendar-welcome-dismissed";

function shouldOfferCalendar(key: string): boolean {
  const url = new URL(window.location.href);
  if (url.pathname !== "/" || [...url.searchParams.keys()].some((name) => name !== "error")) return false;
  try {
    return localStorage.getItem(CALENDAR_DISMISSED_KEY) !== key;
  } catch {
    return true;
  }
}

export function AuthGate({ children, calendarWelcome = false }: { children: React.ReactNode; calendarWelcome?: boolean }) {
  const [status, setStatus] = useState<Status>("checking");
  const [welcomeKey, setWelcomeKey] = useState<string | null>(null);
  const [providers, setProviders] = useState<Providers>({ google: false, microsoft: false });
  const [adminExists, setAdminExists] = useState(true);
  const [showDebug, setShowDebug] = useState(false);
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (r) => {
        const profile = r.ok && calendarWelcome
          ? await r.json().catch(() => null) as { calendarWelcome?: unknown } | null
          : null;
        if (!active) return;
        const key = profile?.calendarWelcome;
        if (typeof key === "string" && key && shouldOfferCalendar(key)) setWelcomeKey(key);
        setStatus(r.ok ? "in" : "out");
      })
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
    return () => {
      active = false;
    };
  }, [calendarWelcome]);

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
      if (r.ok) {
        window.location.reload();
        return;
      }
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      setError(body.error || `Login failed (${r.status})`);
    } catch (err) {
      setError((err as Error).message || "Login failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (status === "in" && welcomeKey) {
    return (
      <CalendarWelcome
        googleIcon={<GoogleMark />}
        initialError={new URLSearchParams(window.location.search).has("error")}
        onSkip={() => {
          try {
            localStorage.setItem(CALENDAR_DISMISSED_KEY, welcomeKey);
          } catch { /* still dismiss this screen when storage is unavailable */ }
          const url = new URL(window.location.href);
          if (url.searchParams.has("error")) {
            url.searchParams.delete("error");
            window.history.replaceState(window.history.state, "", url);
          }
          setWelcomeKey(null);
        }}
      />
    );
  }
  if (status === "in") return <>{children}</>;
  if (status === "checking") return <div className={`tina-landing ${landingStyles.checking}`} />;

  const claiming = !adminExists;
  const directLoginAvailable = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  const callbackUrl =
    typeof window !== "undefined"
      ? window.location.pathname + window.location.search + window.location.hash
      : "/";

  return (
    <TinaLanding
      claiming={claiming}
      providers={providers}
      directLoginAvailable={directLoginAvailable}
      showDebug={showDebug}
      onToggleDebug={() => setShowDebug((v) => !v)}
      email={email}
      onEmailChange={setEmail}
      submitting={submitting}
      error={error}
      onDirectSubmit={submit}
      onOAuthSignIn={(provider) => void signIn(provider, { callbackUrl })}
      googleIcon={<GoogleMark />}
      microsoftIcon={<MicrosoftMark />}
    />
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
