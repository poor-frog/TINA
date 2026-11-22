"use client";
/** Shared authentication, invite, setup, and onboarding gates used by both the
 *  Production User UI (`/`, `/meetings/[meetingId]`) and TINA Terminal (`/terminal`). */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { AuthGate } from "./AuthGate";
import { OnboardingGate } from "./OnboardingGate";
import { SetupGate } from "./SetupGate";
import { acceptInvite, acceptTranscriptShare, previewInvite, type InvitePreview } from "../surfaces/workspaceApi";

const roleLabel = (role: string) => (role === "viewer" ? "read-only" : "read & write");

function InviteGate({ children }: { children: ReactNode }) {
  const [redeeming, setRedeeming] = useState(false);
  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const invite = params.get("invite");
  const tshare = params.get("tshare");

  useEffect(() => {
    if (!tshare) return;
    acceptTranscriptShare(tshare)
      .then((r) => {
        if (r?.meeting_id != null) localStorage.setItem("tina.openMeeting", String(r.meeting_id));
      })
      .catch((e) => console.error("transcript share redeem failed:", e))
      .finally(() => {
        if (!invite) window.location.replace(window.location.pathname + window.location.hash);
      });
  }, [tshare, invite]);

  if (!invite) return <>{children}</>;

  const proceed = async () => {
    setRedeeming(true);
    try {
      const r = await acceptInvite(invite);
      if (r?.workspace_id) localStorage.setItem("tina.openWorkspace", String(r.workspace_id));
    } catch (e) {
      console.error("workspace invite redeem failed:", e);
    }
    window.location.replace(window.location.pathname);
  };
  const decline = () => window.location.replace(window.location.pathname);

  return <InviteConsent token={invite} onProceed={proceed} onDecline={decline} busy={redeeming} />;
}

function InviteConsent({
  token,
  onProceed,
  onDecline,
  busy = false,
}: {
  token: string;
  onProceed: () => void;
  onDecline: () => void;
  busy?: boolean;
}) {
  const [pv, setPv] = useState<InvitePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    previewInvite(token)
      .then((p) => {
        if (live) setPv(p);
      })
      .catch(() => {
        if (live) setErr("This invite link is invalid or has expired.");
      });
    return () => {
      live = false;
    };
  }, [token]);

  const invalid = Boolean(err) || Boolean(pv && !pv.valid);
  const wrap: CSSProperties = { height: "100vh", background: "var(--bg)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 };
  const card: CSSProperties = { width: "100%", maxWidth: 440, background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14, padding: "26px 26px 24px" };
  const termRow: CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13 };
  const termK: CSSProperties = { color: "var(--t3)" };
  const termV: CSSProperties = { color: "var(--t1)", fontWeight: 500, maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  const btnBase: CSSProperties = { padding: "9px 16px", borderRadius: 8, fontSize: 13, cursor: "pointer", border: "1px solid var(--line)" };
  const btnPrimary: CSSProperties = { ...btnBase, background: "var(--accent)", color: "var(--on-accent)", border: "1px solid var(--accent)", fontWeight: 600 };
  const btnGhost: CSSProperties = { ...btnBase, background: "transparent", color: "var(--t2)" };

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--t3)", marginBottom: 12 }}>You&apos;ve been invited to a workspace</div>
        {!pv && !err && <div style={{ color: "var(--t3)", fontSize: 13 }}>Loading invite…</div>}
        {invalid && (
          <>
            <div style={{ fontSize: 16, color: "var(--t1)", marginBottom: 6 }}>Invite unavailable</div>
            <div style={{ fontSize: 13, color: "var(--t3)", marginBottom: 20 }}>{err || "This invite is no longer valid — it may have been revoked, expired, or already used."}</div>
            <button onClick={onDecline} style={btnGhost}>Continue to TINA</button>
          </>
        )}
        {pv && pv.valid && (
          <>
            <div style={{ fontSize: 21, fontWeight: 600, color: "var(--t1)", marginBottom: 5, wordBreak: "break-word" }}>{pv.name}</div>
            <div style={{ fontSize: 13.5, color: "var(--t2)", lineHeight: 1.5, marginBottom: 18 }}>
              {pv.purpose || <span style={{ color: "var(--t3)" }}>A shared knowledge workspace.</span>}
            </div>
            <div style={termRow}><span style={termK}>Your access</span><span style={termV}>{roleLabel(pv.role)}</span></div>
            {pv.shared_by && <div style={termRow}><span style={termK}>Shared by</span><span style={termV}>{pv.shared_by}</span></div>}
            <div style={{ fontSize: 12, color: "var(--t3)", lineHeight: 1.5, margin: "16px 0 20px", paddingTop: 14, borderTop: "1px solid var(--line)" }}>
              Joining adds this workspace to your set and mounts it into the agent. You can switch it off or leave any time.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={onProceed} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}>{busy ? "Joining…" : "Continue to join"}</button>
              <button onClick={onDecline} disabled={busy} style={btnGhost}>Not now</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function AppGates({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div style={{ height: "100vh", background: "var(--bg)" }} />;

  return (
    <AuthGate>
      <InviteGate>
        <SetupGate>
          <OnboardingGate>{children}</OnboardingGate>
        </SetupGate>
      </InviteGate>
    </AuthGate>
  );
}
