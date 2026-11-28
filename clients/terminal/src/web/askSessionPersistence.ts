/** askSessionPersistence — URL + sessionStorage persistence for Ask Tina's active conversation
 *  and in-flight resumable SSE turn across tab navigation and full page reloads (F5). */
import type { ChatContext } from "../surfaces/chatContext";

export const ACTIVE_ASK_SESSION_KEY = "tina.ask.activeSession.v1";
export const INFLIGHT_ASK_TURN_KEY = "tina.ask.inflightTurn.v1";

/** Stay well inside agent-api's 900s CHAT_TURN_HEAD_TTL_SEC so stale records never re-dispatch. */
export const INFLIGHT_TURN_MAX_AGE_MS = 10 * 60_000;

export interface InflightAskTurn {
  session: string;
  turnId: string;
  lastEventId: string | null;
  prompt: string;
  displayPrompt: string;
  active?: unknown;
  context?: ChatContext;
  research?: boolean;
  priorTurnCount: number;
  partialText: string;
  ops: string[];
  startedAt: number;
}

export function readAskSessionFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("nav") !== "ask") return null;
    const raw = (sp.get("session") || "").trim();
    return raw ? raw.slice(0, 128) : null;
  } catch {
    return null;
  }
}

export function readStoredAskSession(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = (window.sessionStorage.getItem(ACTIVE_ASK_SESSION_KEY) || "").trim();
    return raw ? raw.slice(0, 128) : null;
  } catch {
    return null;
  }
}

export function writeStoredAskSession(sessionId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (sessionId && sessionId.trim()) {
      window.sessionStorage.setItem(ACTIVE_ASK_SESSION_KEY, sessionId.trim().slice(0, 128));
    } else {
      window.sessionStorage.removeItem(ACTIVE_ASK_SESSION_KEY);
    }
  } catch {
    /* ignore storage errors */
  }
}

export function syncAskSessionUrl(sessionId: string | null): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (url.pathname !== "/" || url.searchParams.get("nav") !== "ask") return;
    if (sessionId && sessionId.trim()) {
      url.searchParams.set("session", sessionId.trim().slice(0, 128));
    } else {
      url.searchParams.delete("session");
    }
    const next = `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (current !== next) {
      window.history.replaceState(window.history.state, "", next);
    }
  } catch {
    /* ignore sandboxed history */
  }
}

export function readInflightAskTurn(nowMs: number = Date.now()): InflightAskTurn | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(INFLIGHT_ASK_TURN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<InflightAskTurn> | null;
    if (
      !parsed ||
      typeof parsed.session !== "string" ||
      !parsed.session.trim() ||
      typeof parsed.turnId !== "string" ||
      !parsed.turnId.trim() ||
      typeof parsed.prompt !== "string" ||
      !parsed.prompt.trim() ||
      typeof parsed.startedAt !== "number" ||
      !Number.isFinite(parsed.startedAt) ||
      nowMs - parsed.startedAt > INFLIGHT_TURN_MAX_AGE_MS ||
      nowMs - parsed.startedAt < -60_000
    ) {
      window.sessionStorage.removeItem(INFLIGHT_ASK_TURN_KEY);
      return null;
    }
    return {
      session: parsed.session,
      turnId: parsed.turnId,
      lastEventId: typeof parsed.lastEventId === "string" && parsed.lastEventId ? parsed.lastEventId : null,
      prompt: parsed.prompt,
      displayPrompt: typeof parsed.displayPrompt === "string" && parsed.displayPrompt ? parsed.displayPrompt : parsed.prompt,
      active: parsed.active,
      context: parsed.context,
      research: Boolean(parsed.research),
      priorTurnCount: typeof parsed.priorTurnCount === "number" && parsed.priorTurnCount >= 0 ? parsed.priorTurnCount : 0,
      partialText: typeof parsed.partialText === "string" ? parsed.partialText : "",
      ops: Array.isArray(parsed.ops) ? parsed.ops.filter((v): v is string => typeof v === "string") : [],
      startedAt: parsed.startedAt,
    };
  } catch {
    try {
      window.sessionStorage.removeItem(INFLIGHT_ASK_TURN_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function writeInflightAskTurn(turn: InflightAskTurn | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!turn) {
      window.sessionStorage.removeItem(INFLIGHT_ASK_TURN_KEY);
    } else {
      window.sessionStorage.setItem(INFLIGHT_ASK_TURN_KEY, JSON.stringify(turn));
    }
  } catch {
    /* ignore storage errors */
  }
}
