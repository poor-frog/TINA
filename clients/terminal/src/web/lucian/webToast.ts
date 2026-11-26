/** Lightweight event bus for MeetTina's global Lucian #435 stacked toast deck. */

export type WebToastTone = "success" | "info" | "error";

export interface WebToastPayload {
  message: string;
  tone?: WebToastTone;
  durationMs?: number;
  undoLabel?: string;
  undoneMessage?: string;
  onUndo?: () => void;
}

export const WEB_TOAST_EVENT = "tina:web-toast";

export function emitWebToast(input: string | WebToastPayload): void {
  if (typeof window === "undefined") return;
  const detail: WebToastPayload =
    typeof input === "string" ? { message: input, tone: "success" } : input;
  if (!detail.message.trim()) return;
  window.dispatchEvent(new CustomEvent<WebToastPayload>(WEB_TOAST_EVENT, { detail }));
}
