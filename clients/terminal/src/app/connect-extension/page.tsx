"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { ArrowRight } from "lucide-react";
import { GoogleMark } from "../AuthGate";
import styles from "./ConnectExtension.module.css";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export default function ConnectExtension() {
  const [request, setRequest] = useState<{ id: string; challenge: string; state: string; tab: boolean }>();
  const [complete, setComplete] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState<"google" | "connect" | null>(null);

  useEffect(() => {
    const complete = new URLSearchParams(location.hash.slice(1)).has("code");
    setComplete(complete);
    if (complete) { setChecking(false); return; }
    const query = new URLSearchParams(location.search);
    const id = query.get("extension") || "";
    const challenge = query.get("challenge") || "";
    const state = query.get("state") || "";
    if (!/^[a-p]{32}$/.test(id) || !TOKEN.test(challenge) || !TOKEN.test(state)) {
      setChecking(false);
      return;
    }
    setRequest({ id, challenge, state, tab: query.get("mode") === "tab" });
    void fetch("/api/auth/session", { cache: "no-store" }).then(async response => {
      const session = await response.json();
      if (typeof session?.user?.email === "string") setEmail(session.user.email);
    }).catch(() => {}).finally(() => setChecking(false));
  }, []);

  async function signInWithGoogle() {
    setBusy("google");
    setError("");
    try {
      await signIn("google", { callbackUrl: location.href });
    } catch {
      setError("Could not open Google sign-in. Please try again.");
      setBusy(null);
    }
  }

  async function connect() {
    if (!request) return;
    setBusy("connect");
    setError("");
    try {
      const response = await fetch("/api/auth/extension/authorize", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extension_id: request.id, challenge: request.challenge }),
      });
      const result = await response.json();
      if (!response.ok || typeof result.code !== "string" || !TOKEN.test(result.code)) {
        throw new Error(response.status === 401 || response.status === 403
          ? "Sign in with a Gmail account and try again."
          : "Could not connect the extension to this TINA instance.");
      }
      const target = request.tab ? "/connect-extension" : `https://${request.id}.chromiumapp.org/tina`;
      location.replace(`${target}#${new URLSearchParams({ code: result.code, state: request.state })}`);
      setComplete(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not connect to TINA.");
      setBusy(null);
    }
  }

  const canConnect = email.toLowerCase().endsWith("@gmail.com");

  return (
    <main className={styles.stage} lang="en">
      <section className={styles.card} aria-labelledby="connect-title">
        <div className={styles.brand}>
          <img src="/tina-logo.svg" alt="" width={32} height={34} />
          <span>TINA Terminal</span>
        </div>
        <h1 id="connect-title" className={styles.title}>
          {complete ? "Return to the TINA extension" : "Connect the TINA extension"}
        </h1>
        {complete ? (
          <p className={styles.description}>Reopen the extension to check your connection.</p>
        ) : !checking && !request ? (
          <p className={styles.description}>Open the TINA extension and select Sign in with Google to get started.</p>
        ) : (
          <>
            <p className={styles.description}>
              {canConnect
                ? "Confirm the account you want to use with the extension."
                : "Use the same Gmail account as in TINA Terminal to see your meetings in the extension."}
            </p>
            {checking ? <p className={styles.account} role="status">Checking sign-in status…</p> : (
              <div className={styles.actions}>
                {canConnect && <>
                  <div className={styles.account}>
                    <span>Signed in as</span>
                    <strong>{email}</strong>
                  </div>
                  <button type="button" className={styles.primary} disabled={!!busy} onClick={() => void connect()}>
                    {busy === "connect" ? "Connecting…" : "Connect extension"}
                    {busy !== "connect" && <ArrowRight size={18} aria-hidden="true" />}
                  </button>
                </>}
                <button type="button" className={canConnect ? styles.secondary : styles.primary}
                  disabled={!!busy} onClick={() => void signInWithGoogle()}>
                  {!canConnect && <span className={styles.providerMark}><GoogleMark /></span>}
                  {busy === "google" ? "Opening Google…" : canConnect ? "Use another account" : "Sign in with Google"}
                </button>
              </div>
            )}
          </>
        )}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    </main>
  );
}
