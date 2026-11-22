"use client";
/** Identity + Dev/Admin Terminal switch gating for the Production User UI. */
import { useEffect, useState } from "react";

export interface WebUser {
  name: string;
  firstName: string;
  email: string;
  image: string | null;
}

export interface WebIdentityState {
  user: WebUser;
  isAdmin: boolean;
  canOpenTerminal: boolean;
  signOut: () => void;
}

const DEFAULT_USER: WebUser = {
  name: "Account",
  firstName: "there",
  email: "",
  image: null,
};

function devFlagEnabled(): boolean {
  if (process.env.NEXT_PUBLIC_SHOW_TERMINAL_SWITCH === "1") return true;
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem("tina.dev.terminalSwitch") === "1";
  } catch {
    return false;
  }
}

export function useWebIdentity(): WebIdentityState {
  const [user, setUser] = useState<WebUser>(DEFAULT_USER);
  const [isAdmin, setIsAdmin] = useState(false);
  const [devFlag, setDevFlag] = useState(false);

  useEffect(() => {
    setDevFlag(devFlagEnabled());
    let active = true;

    void fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { user?: { email?: string | null; name?: string | null; image?: string | null } } | null) => {
        if (!active || !data?.user) return;
        const email = (data.user.email || "").trim();
        const name = (data.user.name || (email ? email.split("@")[0] : "") || "Account").trim();
        const firstName = name.split(/\s+/)[0] || "there";
        setUser({
          name,
          firstName,
          email,
          image: data.user.image ?? null,
        });
      })
      .catch(() => undefined);

    void fetch("/api/admin/me", { cache: "no-store" })
      .then((r) => {
        if (active) setIsAdmin(r.ok);
      })
      .catch(() => {
        if (active) setIsAdmin(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const signOut = () => {
    void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* ignore unavailable storage */
      }
      window.location.reload();
    });
  };

  return {
    user,
    isAdmin,
    canOpenTerminal: isAdmin || devFlag,
    signOut,
  };
}
