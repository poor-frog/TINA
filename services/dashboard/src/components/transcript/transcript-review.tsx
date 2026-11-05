"use client";
import { useEffect, useRef, useState } from "react";
import { transcriptDiff } from "./transcript-diff";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

interface Segment {
  segment_id: string; speaker: string; raw_text: string; text: string; revision: number;
  audio?: Array<{ kind: string }>; start_ms?: number; end_ms?: number;
  history: Array<{ revision: number; text: string; at: string }>;
}
interface ReviewDocument { status: string; segments: Segment[] }
interface Draft { segment_id: string; text: string; base_text: string; revision: number }
const draftFor = (s?: Segment): Draft | null => s ? { segment_id: s.segment_id, text: s.text, base_text: s.text, revision: s.revision } : null;
export function reconcileReviewDraft(current: Draft | null, segments: Segment[], reset = false): Draft | null {
  const next = segments.find(s => s.segment_id === current?.segment_id) ?? segments[0];
  return !reset && current && next?.segment_id === current.segment_id && current.text !== current.base_text
    ? current : draftFor(next);
}
const qualityLabels: Record<string, string> = { low_volume: "Low volume", clipping: "Audio clipping", mostly_quiet: "Mostly quiet audio", repetition: "Repeated words - listen to verify" };
interface Job {
  id: string; status: string; model: string; backend: string; error?: string;
  items: Array<{ segment_id: string; state: string; expected_revision: number; text?: string; reason?: string; quality?: { needs_review: boolean; reasons: string[] } }>;
}
interface AlignedWord { index: number; text: string; start_ms: number | null; end_ms: number | null; aligned: boolean; speaker_id?: string | null; speaker_name?: string; speaker_source?: string }
interface AlignmentItem { segment_id: string; state: string; expected_revision: number; audio_sha256?: string; words?: AlignedWord[]; phrases?: Array<{ speaker_id: string | null; speaker_name: string; text: string; start_ms: number | null; end_ms: number | null; word_indices: number[] }>; reason?: string }
interface AlignmentJob { id: string; status: string; model: string; items: AlignmentItem[]; error?: string; finished_at?: string }
interface AlignmentView { version: "transcript-alignment.v1"; available: boolean; job: AlignmentJob | null }
const activeJob = (job: Job | null) => !!job && ["running", "paused", "cancelling"].includes(job.status);
const activeAlignment = (job: AlignmentJob | null) => !!job && ["running", "paused", "cancelling"].includes(job.status);

export function TranscriptReview({ meetingId, onSaved }: { meetingId: string; onSaved: () => void }) {
  
  const [opened, setOpened] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  const playRequest = useRef(0);
  const [doc, setDoc] = useState<ReviewDocument | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [alignment, setAlignment] = useState<AlignmentView | null>(null);
  const [edit, setEdit] = useState<Draft | null>(null);
  const selected = edit?.segment_id ?? "";
  const draft = edit?.text ?? "";
  const [glossary, setGlossary] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mutating, setMutating] = useState(false);
  const busy = loading || mutating;
  const [error, setError] = useState("");
  const identity = useRef(meetingId); identity.current = meetingId;
  const loads = useRef({ meetingId, running: false, queued: false });
  const base = `/api/tina/transcripts/by-id/${encodeURIComponent(meetingId)}`;
  const segment = doc?.segments.find(s => s.segment_id === selected);
  const draftConflict = !!segment && !!edit && edit.revision !== segment.revision;
  const item = job?.items.find(i => i.segment_id === selected);
  const alignmentJob = alignment?.job ?? null;
  const alignmentItem = alignmentJob?.items.find(i => i.segment_id === selected);
  const audioUrl = alignmentItem?.state === "aligned"
    ? `${base}/alignment/${encodeURIComponent(selected)}/audio`
    : `${base}/segments/${encodeURIComponent(selected)}/audio`;
  const changed = (s: Segment) => s.text !== s.raw_text || job?.items.some(i => i.segment_id === s.segment_id && i.state === "ready" && i.text !== s.text);
  const flagged = (s: Segment) => job?.items.some(i => i.segment_id === s.segment_id && i.expected_revision === s.revision && i.quality?.needs_review);
  const visible = doc?.segments.filter(s => (!changedOnly || changed(s)) && (!flaggedOnly || flagged(s))) ?? [];
  const editable = !!doc && ["completed", "failed", "interrupted"].includes(doc.status);
  const active = activeJob(job);
  const stale = item && segment && item.state !== "applied" && item.expected_revision !== segment.revision;
  const before = item?.state === "applied" ? segment?.history.find(h => h.revision === item.expected_revision)?.text ?? segment?.raw_text ?? "" : segment?.text ?? "";
  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(base + path, { ...options, cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : data.error || "Transcript review unavailable");
    if (identity.current !== meetingId) throw new Error("Meeting changed; reopen review");
    return data;
  }
  function pick(s?: Segment) { setEdit(draftFor(s)); }
  function accept(data: ReviewDocument, resetDraft = false) {
    setDoc(data);
    setEdit(current => reconcileReviewDraft(current, data.segments, resetDraft));
  }
  async function load() {
    let state = loads.current;
    if (state.meetingId !== meetingId) loads.current = state = { meetingId, running: false, queued: false };
    if (state.running) { state.queued = true; return; }
    state.running = true;
    setLoading(true); setError("");
    try {
      let failures = 0;
      do {
        state.queued = false;
        try {
          const [data, latest, aligned] = await Promise.allSettled([
            request<ReviewDocument>("/document"), request<Job | null>("/refinement"), request<AlignmentView>("/alignment"),
          ]);
          if (identity.current !== meetingId || loads.current !== state) return;
          if (data.status === "rejected") throw data.reason;
          if (latest.status === "rejected") throw latest.reason;
          accept(data.value); setJob(latest.value); setAlignment(aligned.status === "fulfilled" ? aligned.value : null);
          failures = 0; setError("");
        } catch (e) {
          failures++;
          if (identity.current === meetingId) setError(e instanceof Error ? e.message : "Review unavailable");
        }
      } while (state.queued && failures < 2);
    } finally { state.running = false; if (identity.current === meetingId && loads.current === state) setLoading(false); }
  }
  useEffect(() => {
    const audio = audioRef.current;
    stopAt.current = null; playRequest.current++;
    return () => { stopAt.current = null; playRequest.current++; audio?.pause(); };
  }, [opened, audioUrl, alignmentItem?.audio_sha256]);
  useEffect(() => {
    if (!opened) return;
    let closed = false;
    const timer = setInterval(() => {
      if (activeJob(job)) void request<Job | null>("/refinement").then(value => { if (!closed) setJob(value); }).catch(e => { if (!closed) setError(e.message); });
      if (activeAlignment(alignmentJob)) void request<AlignmentView>("/alignment").then(value => { if (!closed) setAlignment(value); }).catch(e => { if (!closed) setError(e.message); });
    }, 1000);
    return () => { closed = true; clearInterval(timer); };
  }, [opened, job?.status, alignmentJob?.status, meetingId]);
  useEffect(() => { setDoc(null); setJob(null); setAlignment(null); setEdit(null); setChangedOnly(false); setFlaggedOnly(false); setLoading(false); setMutating(false); setError(""); }, [meetingId]);
  useEffect(() => {
    if (!opened) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ meetingId?: string }>).detail;
      if (detail?.meetingId === meetingId && timer === undefined)
        timer = setTimeout(() => { timer = undefined; void load(); }, 100);
    };
    window.addEventListener("tina:transcript-corrected", refresh);
    return () => { clearTimeout(timer); window.removeEventListener("tina:transcript-corrected", refresh); };
  }, [opened, meetingId]);
  function saved() { window.dispatchEvent(new CustomEvent("tina:transcript-corrected", { detail: { meetingId } })); onSaved(); }
  async function save(text: string | null) {
    if (!segment || !edit || draftConflict) return;
    setMutating(true); setError("");
    try { accept(await request<ReviewDocument>(`/segments/${encodeURIComponent(selected)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: edit.revision, text }) }), true); saved(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save correction"); }
    finally { setMutating(false); }
  }
  async function refine(action: "start" | "cancel" | "apply", mode: "all" | "check" | "flagged" = "all") {
    setMutating(true); setError("");
    try {
      const payload = action === "start" ? { ...(mode === "all" ? {} : { mode }), glossary: glossary.split(",").map(s => s.trim()).filter(Boolean) } : action === "apply" && segment && job ? { job_id: job.id, segment_id: selected, expected_revision: segment.revision } : undefined;
      const data = await request<ReviewDocument | Job | null>(`/refinement/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
      if (action === "apply") { accept(data as ReviewDocument, true); setJob(await request<Job | null>("/refinement")); saved(); }
      else setJob(data as Job | null);
    } catch (e) { setError(e instanceof Error ? e.message : "Refinement unavailable"); }
    finally { setMutating(false); }
  }
  async function align(action: "start" | "cancel") {
    setMutating(true); setError("");
    try { setAlignment(await request<AlignmentView>(`/alignment/${action}`, { method: "POST" })); }
    catch (e) { setError(e instanceof Error ? e.message : "Word alignment unavailable"); }
    finally { setMutating(false); }
  }
  function playWord(word: AlignedWord) {
    const audio = audioRef.current;
    if (!audio || !word.aligned || word.start_ms == null || word.end_ms == null) return;
    const start = word.start_ms / 1000;
    const ticket = ++playRequest.current;
    stopAt.current = word.end_ms / 1000;
    const play = () => {
      if (ticket !== playRequest.current || audioRef.current !== audio) return;
      audio.currentTime = start;
      void audio.play().catch(() => {
        if (ticket === playRequest.current && audioRef.current === audio) setError("Could not play saved audio. Try the audio controls.");
      });
    };
    if (audio.readyState < 1) { audio.addEventListener("loadedmetadata", play, { once: true }); audio.load(); }
    else play();
  }
  const field = { width: "100%", background: "transparent", color: "inherit", border: "1px solid currentColor", borderRadius: 6, padding: 8 } as const;
  const content = <div style={{ display: "grid", gap: 12 }}>
    {error && <p role="alert">{error} <button disabled={busy} onClick={() => void load()}>Reload</button></p>}
    {busy && <p role="status">Working…</p>}
    <details><summary>Vocabulary hints (optional)</summary><label>Vocabulary hints (comma separated)<textarea style={field} value={glossary} disabled={busy || active} maxLength={700} rows={2} placeholder="TINA, Qwen, tên người, tên dự án" onChange={e => setGlossary(e.target.value)} /></label></details>
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      <button disabled={busy || active || !editable || !doc?.segments.some(s => s.audio?.length === 1)} onClick={() => void refine("start")}>Refine after meeting</button>
      <Button disabled={busy || active || activeAlignment(alignmentJob) || !editable || !doc?.segments.some(s => s.audio?.length === 1)} onClick={() => void refine("start", "check")}>Check audio</Button>
      <Button disabled={busy || active || activeAlignment(alignmentJob) || !editable || !doc?.segments.some(s => s.audio?.length === 1)} onClick={() => void refine("start", "flagged")}>Refine flagged segments</Button>
      {active && <button disabled={busy || job?.status === "cancelling"} onClick={() => void refine("cancel")}>Cancel refinement</button>}
      <button disabled={busy || active || activeAlignment(alignmentJob) || !editable || !alignment?.available || !doc?.segments.some(s => s.audio?.length === 1)} onClick={() => void align("start")}>Align words & speakers</button>
      {activeAlignment(alignmentJob) && <button disabled={busy || alignmentJob?.status === "cancelling"} onClick={() => void align("cancel")}>Cancel alignment</button>}
    </div>
    <p role="status">{job ? `${job.status} · ${job.items.filter(i => i.state !== "pending").length}/${job.items.length} segments · ${job.backend} / ${job.model}${job.error ? " · " + job.error : ""}` : "Available after the meeting, with saved audio and capture timing."}</p>
    <p role="status">{alignmentJob ? `${alignmentJob.status} · ${alignmentJob.items.filter(i => i.state !== "pending").length}/${alignmentJob.items.length} segments · ${alignmentJob.model}${alignmentJob.error ? " · " + alignmentJob.error : ""}` : alignment?.available ? "Word timestamps are optional and use the immutable raw ASR text." : "Configure the self-hosted MFA Vietnamese alignment worker to enable word playback."}</p>
    <label><input type="checkbox" checked={changedOnly} disabled={busy} onChange={e => { setChangedOnly(e.target.checked); if (e.target.checked && segment && !changed(segment)) pick(doc?.segments.find(changed)); }} /> Only changed segments</label>
    <label><input type="checkbox" checked={flaggedOnly} disabled={busy} onChange={e => { setFlaggedOnly(e.target.checked); if (e.target.checked && segment && !flagged(segment)) pick(doc?.segments.find(s => flagged(s) && (!changedOnly || changed(s)))); }} /> Only segments needing review</label>
    <p>Audio flags are advisory. Quiet audio and repeated words may be intentional; listen before applying changes.</p>
    <p>{visible.length} / {doc?.segments.length ?? 0} segments</p>
    {doc && visible.length === 0 && <p>{flaggedOnly ? "No current segments flagged. Run Check audio to assess saved clips." : changedOnly ? "No changed segments." : "No confirmed transcript yet."}</p>}
    {visible.length > 0 && <label>Segment<select style={field} value={visible.some(s => s.segment_id === selected) ? selected : ""} disabled={busy} onChange={e => pick(doc?.segments.find(s => s.segment_id === e.target.value))}>
      <option value="" disabled>Choose a segment</option>{visible.map(s => <option key={s.segment_id} value={s.segment_id}>{flagged(s) ? "[Review] " : ""}{s.speaker || "Speaker"} · {s.text.slice(0, 90)}</option>)}
    </select></label>}
    {segment && visible.some(s => s.segment_id === selected) && <>
      <section aria-label="Refinement suggestion" style={{ padding: 14, border: "1px solid var(--line, #668d81)", borderRadius: 8 }}>
        {segment.audio?.length === 1 ? <audio ref={audioRef} key={`${meetingId}/${selected}/${alignmentItem?.audio_sha256 ?? "source"}`} controls preload="metadata" src={audioUrl} style={{ width: "100%" }} aria-label="Segment audio" onError={() => setError("Saved audio no longer matches this alignment; rerun alignment before playback.")} onTimeUpdate={e => { if (stopAt.current != null && e.currentTarget.currentTime >= stopAt.current) { e.currentTarget.pause(); stopAt.current = null; } }} /> : <p>Source audio is unavailable or ambiguous. Older recordings may lack capture timing.</p>}
        {alignmentItem?.state === "aligned" && alignmentItem.phrases?.length ? <div aria-label="Aligned words and speakers" style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <h3>Word timing · raw ASR</h3>
          {alignmentItem.phrases.map((phrase, phraseIndex) => <div key={`${phraseIndex}/${phrase.word_indices[0]}`}>
            <small>{phrase.speaker_name}</small><div>{phrase.word_indices.map(index => {
              const word = alignmentItem.words?.[index]; if (!word) return null;
              return word.aligned && word.start_ms != null && word.end_ms != null
                ? <button key={index} type="button" onClick={() => playWord(word)} aria-label={`Play ${word.text} from ${Math.round(word.start_ms)} to ${Math.round(word.end_ms)} milliseconds`} className="m-0.5 rounded border px-1.5 py-0.5">{word.text}</button>
                : <span key={index} title="No reliable word timestamp" className="m-0.5 text-muted-foreground">{word.text}</span>;
            })}</div>
          </div>)}
        </div> : alignmentItem && alignmentItem.state !== "aligned" ? <p>{alignmentItem.reason || "No reliable word alignment is available for this segment."}</p> : null}
        {item?.text && <><h3>Suggested changes</h3><p aria-label="Suggested changes">{transcriptDiff(before, item.text).map((part, i) => part.kind === "add" ? <ins key={i} style={{ background: "#245d4d", color: "#c6ffe7" }}>{part.text} </ins> : part.kind === "remove" ? <del key={i} style={{ background: "#5c3030", color: "#ffd2c8" }}>{part.text} </del> : <span key={i}>{part.text} </span>)}</p></>}
        {item?.quality && !stale && <p role="status">{item.quality.needs_review ? "Needs review: " + item.quality.reasons.map(r => qualityLabels[r] ?? r).join(" · ") : "No configured audio quality flags detected."}</p>}
        {item && <p>{stale ? "Transcript changed. Run refinement again." : item.reason || (item.text === segment.text ? "No text changes." : "Suggestions may contain mistakes. Listen before applying.")}</p>}
        {item?.state === "ready" && <button disabled={busy || active || !editable || draftConflict || stale || draft !== segment.text || item.text === segment.text} onClick={() => void refine("apply")}>Apply refinement</button>}
      </section>
      <label>Original transcript<textarea style={field} readOnly value={segment.raw_text} rows={3} /></label>
      <label>Corrected transcript · revision {edit?.revision}<textarea style={field} value={draft} disabled={busy} maxLength={10000} onChange={e => { const text = e.target.value; setEdit(current => current ? { ...current, text } : null); }} rows={4} /></label>
      {draftConflict && <div role="alert"><p>This segment changed elsewhere. Your draft is kept.</p><p>Latest transcript: {segment.text}</p><button disabled={busy} onClick={() => pick(segment)}>Discard draft and use latest</button></div>}
      <div style={{ display: "flex", gap: 10 }}>
        <button disabled={busy || !editable || draftConflict || !draft.trim()} onClick={() => void save(draft)}>Save revision</button>
        <button disabled={busy || !editable || draftConflict || segment.revision === 0} onClick={() => void save(null)}>Restore original</button>
      </div>
      {!editable && <p>Stop the meeting before making corrections.</p>}

      <details><summary>Revision history ({segment.history.length})</summary>{segment.history.map(h => <p key={h.revision}>Revision {h.revision} · {h.at}<br />{h.text}</p>)}</details>
    </>}
  </div>;
    return <Dialog open={opened} onOpenChange={open => { setOpened(open); if (open) void load(); }}>
    <DialogTrigger asChild><Button variant="outline" size="sm">Review transcript</Button></DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl [&_button]:rounded-md [&_button]:border [&_button]:px-3 [&_button]:py-2 [&_button:disabled]:opacity-50">
      <DialogHeader><DialogTitle>Review transcript</DialogTitle><DialogDescription>Compare suggestions, listen, then apply. Restore keeps the original available.</DialogDescription></DialogHeader>
      {content}
    </DialogContent>
  </Dialog>;
}
