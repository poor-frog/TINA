"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
import styles from "./meetingDetail.module.css";

type Source = {
  id: string;
  kind: "transcript" | "document";
  quote: string;
  path?: string;
  speaker_name?: string | null;
  paragraph?: number;
};
type Answer = { claims: { text: string; source_ids: string[] }[]; sources: Source[] };
type Job = {
  id: string;
  status: "running" | "completed" | "failed";
  workspace?: string;
  path?: string;
  answer?: Answer;
};
type Workspace = { slug: string; name: string | null };

export function PostMeetingDraft({ meetingId }: { meetingId: string }) {
  const url = `/api/post-meeting-draft/${encodeURIComponent(meetingId)}`;
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [documents, setDocuments] = useState<string[] | null>(null);
  const [path, setPath] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [source, setSource] = useState<Source | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const response = await fetch(url, { signal, cache: "no-store" });
      if ([401, 403, 404, 409].includes(response.status)) {
        setWorkspaces(null);
        setJob(null);
        setSource(null);
        return;
      }
      if (!response.ok) throw new Error();
      const result: { workspaces: Workspace[]; job: Job | null } = await response.json();
      if (signal.aborted || !Array.isArray(result.workspaces)) return;
      setWorkspaces(result.workspaces);
      setJob(result.job);
      setWorkspace((value) => value || result.job?.workspace || result.workspaces[0]?.slug || "");
    } catch {
      if (!signal.aborted) setError("Chưa tải được trạng thái bản nháp.");
    }
  }, [url]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (job?.status !== "running") return;
    const controller = new AbortController();
    const interval = window.setInterval(() => void refresh(controller.signal), 2500);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [job?.status, refresh]);

  useEffect(() => {
    if (!workspace) return;
    const controller = new AbortController();
    setDocuments(null);
    setPath("");
    fetch(`${url}?workspace=${encodeURIComponent(workspace)}`, { signal: controller.signal, cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<{ documents: string[] }>;
      })
      .then((result) => {
        if (!controller.signal.aborted) setDocuments(result.documents);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDocuments([]);
          setError("Chưa tải được tài liệu trong workspace này.");
        }
      });
    return () => controller.abort();
  }, [workspace, url]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting || job?.status === "running" || !path) return;
    setSubmitting(true);
    setError("");
    setSource(null);
    setCopied(false);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace, path }),
      });
      if (!response.ok) throw new Error();
      const result: { job: Job } = await response.json();
      setJob(result.job);
    } catch {
      setError("Chưa tạo được bản nháp. Hãy kiểm tra quyền đọc tài liệu rồi thử lại.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copy() {
    const answer = job?.answer;
    if (!answer) return;
    try {
      await navigator.clipboard.writeText(answer.claims.map((claim) =>
        `- ${claim.text} ${claim.source_ids.map((id) => `[${answer.sources.findIndex((item) => item.id === id) + 1}]`).join(" ")}`,
      ).join("\n"));
      setCopied(true);
    } catch {
      setError("Chưa sao chép được. Bạn có thể chọn văn bản bản nháp để sao chép.");
    }
  }

  if (workspaces === null) return null;
  const busy = submitting || job?.status === "running";
  const answer = job?.answer;
  return (
    <section className={styles.summaryCard} aria-label="Bản nháp sau họp">
      <div className={styles.summaryHead}>
        <h3 className={styles.summaryLabel}><WebIcon name="sparkleSmall" size={15} /> Bản nháp sau họp</h3>
        {!!answer?.claims.length && (
          <button type="button" className={styles.ghostBtn} onClick={() => void copy()}>
            <WebIcon name={copied ? "check" : "copy"} size={13} /> {copied ? "Đã sao chép" : "Sao chép"}
          </button>
        )}
      </div>
      {workspaces.length ? (
        <form className={styles.draftForm} onSubmit={(event) => void submit(event)}>
          <label>
            Workspace
            <select value={workspace} onChange={(event) => setWorkspace(event.currentTarget.value)} disabled={busy}>
              {workspaces.map((item) => <option key={item.slug} value={item.slug}>{item.name || item.slug}</option>)}
            </select>
          </label>
          <label>
            Tài liệu đối chiếu
            <select value={path} onChange={(event) => setPath(event.currentTarget.value)} disabled={busy || !documents?.length}>
              <option value="">{documents === null ? "Đang tải tài liệu…" : documents.length ? "Chọn tài liệu" : "Chưa có tài liệu Markdown"}</option>
              {documents?.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <button type="submit" className={styles.primaryBtn} disabled={busy || !path}>Tạo bản nháp</button>
        </form>
      ) : <p className={styles.summaryText}>Cần một workspace có tài liệu Markdown mà bạn có quyền đọc.</p>}
      {busy && <p role="status" className={styles.summaryText}>Đang tạo bản nháp. Bạn có thể mở lại trang để xem kết quả.</p>}
      {job?.status === "failed" && <p role="status" className={styles.summaryText}>Bản nháp chưa sẵn sàng. Chọn lại tài liệu rồi thử lại.</p>}
      {error && <p role="alert" className={styles.summaryText}>{error}</p>}
      {answer && (
        <>
          {job?.path && <p className={styles.summaryText}>Tài liệu đã dùng · {job.path}</p>}
          {!answer.claims.length && <p className={styles.summaryText}>Chưa đủ căn cứ để soạn bản nháp.</p>}
          <ul className={styles.draftClaims}>
            {answer.claims.map((claim, index) => (
              <li key={index}>
                {claim.text}{" "}
                {claim.source_ids.map((id) => {
                  const sourceIndex = answer.sources.findIndex((item) => item.id === id);
                  const item = answer.sources[sourceIndex];
                  if (!item) return null;
                  return (
                    <button key={id} type="button" className={styles.ghostBtn} aria-expanded={source?.id === id}
                      onClick={() => setSource((current) => current?.id === id ? null : item)}>
                      {item.kind === "transcript" ? "Transcript" : "Tài liệu"} {sourceIndex + 1}
                    </button>
                  );
                })}
              </li>
            ))}
          </ul>
          {source && (
            <blockquote className={styles.draftSource}>
              <strong>{source.kind === "document" ? source.path : source.speaker_name || "Transcript cuộc họp"}</strong>
              <p>{source.quote}</p>
            </blockquote>
          )}
        </>
      )}
    </section>
  );
}
