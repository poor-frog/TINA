"use client";
import styles from "./MeetingTranscript.module.css";
import { useEffect, useRef, useState } from "react";
import type { TranslationGroup } from "./translationGroups";

export type TranscriptLanguage = "vi" | "en" | "bilingual";
export interface TranslationSnapshot {
  version: "meeting-translation.v2";
  meeting_id: number; status: "pending" | "running" | "paused" | "complete";
  total: number; completed: number; retry_after: number; groups: TranslationGroup[];
  can_advance?: boolean;
  service_error?: string;
}

/** Poll independently of capture. POST advances one ready, server-grouped phrase. */
export function useMeetingTranslation(meetingId: string, language: TranscriptLanguage, segmentIds: string[] = []) {
  const [snapshot, setSnapshot] = useState<TranslationSnapshot | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const retryRequested = useRef(false);
  const priority = useRef(segmentIds);
  priority.current = segmentIds;
  const valid = /^[1-9]\d*$/.test(meetingId);
  useEffect(() => {
    setSnapshot(null); setError(""); retryRequested.current = false;
  }, [meetingId]);
  useEffect(() => {
    if (!valid || language === "vi") return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let advancing = false;
    const url = `/api/meeting-translations/${meetingId}`;
    const read = async (method = "GET", force = false): Promise<TranslationSnapshot> => {
      const response = await fetch(url, { method, cache: "no-store", signal: abort.signal,
        ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ retry: force, segment_ids: priority.current.slice(0, 128) }) } : {}) });
      if (!response.ok) throw new Error("Translation unavailable. Vietnamese transcript is still available.");
      const state = await response.json() as TranslationSnapshot;
      if (state.version !== "meeting-translation.v2" || state.meeting_id !== Number(meetingId) || !Array.isArray(state.groups)) throw new Error("Translation unavailable.");
      if (!abort.signal.aborted) { setSnapshot(state); setError(""); }
      return state;
    };
    const poll = async () => {
      let delay = 3000;
      try {
        const state = await read();
        const force = retryRequested.current;
        if (!advancing && state.status !== "complete" && (state.can_advance !== false || force) && (state.retry_after === 0 || force)) {
          retryRequested.current = false;
          advancing = true;
          // Do not block GET polling while another client is waiting for the provider.
          void read("POST", force).catch(() => {
            if (!abort.signal.aborted) setError("Translation unavailable. Vietnamese transcript is still available.");
          }).finally(() => { advancing = false; });
        }
      } catch {
        if (!abort.signal.aborted) setError("Translation unavailable. Vietnamese transcript is still available.");
        delay = 15000;
      }
      if (!abort.signal.aborted) timer = setTimeout(poll, delay);
    };
    void poll();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [meetingId, language, valid, retry]);
  return { snapshot: snapshot?.meeting_id === Number(meetingId) ? snapshot : null, error,
    retry: () => { retryRequested.current = true; setRetry(n => n + 1); }, valid };
}

export function TranslationControls({ language, onChange, snapshot, error, onRetry, disabled }: {
  language: TranscriptLanguage; onChange: (mode: TranscriptLanguage) => void;
  snapshot: TranslationSnapshot | null; error: string; onRetry: () => void; disabled?: boolean;
}) {
  const paused = snapshot?.status === "paused";
  const retrying = snapshot?.groups.filter(g => g.status === "retrying").length ?? 0;
  const failed = snapshot?.groups.filter(g => g.status === "failed").length ?? 0;
  const serviceMessages: Record<string, string> = {
    auth: "API từ chối quyền truy cập · kiểm tra khóa trong Settings → Models rồi thử lại",
    configuration: "Kiểm tra provider và model trong Settings → Models rồi thử lại",
    rate_limit: "API đang giới hạn lượt gọi · sẽ tự thử lại",
    unavailable: "Dịch vụ dịch chưa khả dụng · sẽ tự thử lại",
  };
  const message = snapshot?.service_error ? serviceMessages[snapshot.service_error] : undefined;
  const progress = snapshot ? [
    `VI → EN · ${snapshot.completed}/${snapshot.total} cụm`,
    retrying ? `${retrying} cụm chờ thử lại` : "",
    failed ? `${failed} cụm cần thử lại` : "",
    snapshot.groups.some(g => !g.ready) ? "Đang gom câu…" : "",
  ].filter(Boolean).join(" · ") : "Đang tải bản dịch…";
  return <>
    <select className={styles.select} aria-label="Transcript language" title="Transcript language" value={language} disabled={disabled}
      onChange={event => onChange(event.currentTarget.value as TranscriptLanguage)}>
      {([["vi", "Tiếng Việt"], ["en", "English"], ["bilingual", "Song ngữ"]] as const).map(([mode, label]) =>
        <option key={mode} value={mode}>{label}</option>)}
    </select>
    {language !== "vi" && <div className={styles.translationStatus} data-state={paused || error ? "attention" : "normal"}>
      <span role="status">{error || message || (paused && !retrying && !failed ? "Dịch tạm dừng · sẽ tự thử lại" : progress)}</span>
      {(paused || error || retrying > 0 || failed > 0) && <button className={styles.retry} type="button" onClick={onRetry}>Thử lại</button>}
    </div>}
  </>;
}
