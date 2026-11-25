"use client";

import { useCallback, useEffect, useState } from "react";
import styles from "./agentModelSettings.module.css";

type Status = "loading" | "connected" | "disconnected" | "unavailable" | "error";

export function WorkspaceChatGPTConnection({ onConnected }: { onConnected?: (connected: boolean) => void }) {
  const [status, setStatus] = useState<Status>("loading");
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/models/openai/status", { cache: "no-store", signal });
      if (!response.ok) throw new Error();
      const result = await response.json();
      if (signal?.aborted) return;
      const connected = result.available === true && result.connected === true;
      setStatus(connected ? "connected" : result.available === true ? "disconnected" : "unavailable");
      onConnected?.(connected);
    } catch {
      if (!signal?.aborted) setStatus("error");
    }
  }, [onConnected]);

  useEffect(() => {
    const controller = new AbortController();
    const onFocus = () => { void refresh(controller.signal); };
    onFocus();
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const text: Record<Status, string> = {
    loading: "Checking Workspace ChatGPT connection…",
    connected: "ChatGPT plan connected for Workspace",
    disconnected: "ChatGPT plan not connected for Workspace",
    unavailable: "Workspace ChatGPT setup is unavailable for this TINA account.",
    error: "Could not check the Workspace ChatGPT connection.",
  };
  return (
    <div className={styles.connection}>
      <span role="status">{text[status]}</span>
      {(status === "connected" || status === "disconnected") && (
        <details className={styles.accountDetails}>
          <summary>{status === "connected" ? "Reconnect Workspace ChatGPT" : "Connect Workspace ChatGPT"}</summary>
          <p>From the TINA checkout on your computer, start the sign-in helper. Then open the link below and approve access on OpenAI.</p>
          <code>node deploy/aws/workspace-chatgpt-login.mjs</code>
          <p><a href="http://127.0.0.1:23101/" target="_blank" rel="noopener noreferrer">Open local ChatGPT sign-in</a></p>
        </details>
      )}
      <div className={styles.connectionActions}>
        <button type="button" className={styles.secondary} onClick={() => void refresh()}>Refresh connection status</button>
      </div>
    </div>
  );
}
