"use client";
import { useEffect, useState } from "react";
import { LiveMeetingState } from "./LiveMeetingState";
import dialogStyles from "./meetingToolDialogs.module.css";
import type { LiveMeetingItem, LiveMeetingStateSnapshot, PlannedLiveAssistDraft } from "./liveMeetingStateApi";

const agendaStatuses = ["pending", "in_progress", "completed", "deferred", "uncertain"];
const itemStatuses: Record<string, string[]> = {
  question: ["open", "answered", "deferred", "withdrawn"],
  task: ["proposed", "accepted", "in_progress", "blocked", "completed", "cancelled", "uncertain"],
  conclusion: ["proposed", "tentative", "agreed", "contested", "unresolved", "deferred", "superseded"],
};

const actionButton: React.CSSProperties = {
  border: "1px solid var(--line)", borderRadius: 6, background: "transparent", color: "var(--t2)",
  padding: "5px 9px", fontSize: 11.5, cursor: "pointer",
};

export function linkedAgendaIds(item: LiveMeetingItem, byId: Map<string, LiveMeetingItem>, seen = new Set<string>()): string[] {
  if (seen.has(item.id)) return [];
  seen.add(item.id);
  if (Array.isArray(item.details?.agenda_ids)) {
    return [...new Set(item.details.agenda_ids)].filter((id) => byId.get(id)?.type === "agenda");
  }
  const raw = item.details?.agenda_ids ?? item.details?.agenda_id;
  const ids = new Set(Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []);
  for (const ref of [item.details?.topic_id, item.details?.question_id]) {
    if (typeof ref !== "string") continue;
    const related = byId.get(ref);
    if (related) linkedAgendaIds(related, byId, seen).forEach((id) => ids.add(id));
  }
  return [...ids];
}

function topicFor(item: LiveMeetingItem, byId: Map<string, LiveMeetingItem>): string | null {
  if (typeof item.details?.topic_id === "string") return item.details.topic_id;
  const questionId = item.details?.question_id;
  const question = typeof questionId === "string" ? byId.get(questionId) : undefined;
  return typeof question?.details?.topic_id === "string" ? question.details.topic_id : null;
}

function itemMatchesText(item: LiveMeetingItem, query: string): boolean {
  if (!query) return true;
  const details = Object.values(item.details || {}).flatMap((value) => Array.isArray(value) ? value : [value]).join(" ");
  const evidence = (item.evidence || []).map((source) => [source.quote, source.path, source.speaker_name].join(" ")).join(" ");
  return [item.type, item.text, item.status, details, evidence].join(" ").toLocaleLowerCase().includes(query);
}

function needsReview(item: LiveMeetingItem, state: LiveMeetingStateSnapshot): boolean {
  return item.stale || item.details?.source_status === "stale" || (state.proposals || []).some((proposal) => proposal.item_id === item.id);
}

function isOpenItem(item: LiveMeetingItem): boolean {
  return ["open", "proposed", "in_progress", "blocked", "uncertain", "tentative"].includes(item.status);
}

function relativeSyncTime(timestamp: number | null, now: number): string {
  if (!timestamp) return "Waiting for first sync";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) return "Synced just now";
  if (seconds < 60) return `Synced ${seconds}s ago`;
  return `Synced ${Math.floor(seconds / 60)}m ago`;
}

function EvidencePreview({ item }: { item: LiveMeetingItem }) {
  if (!item.evidence?.length) return null;
  return (
    <details style={{ marginTop: 7, color: "var(--t3)", fontSize: 11.5 }}>
      <summary style={{ cursor: "pointer" }}>{item.evidence.length} evidence {item.evidence.length === 1 ? "source" : "sources"}</summary>
      {item.evidence.map((evidence, index) => (
        <div key={`${evidence.document_id || evidence.segment_id || "source"}-${index}`} style={{ margin: "8px 0 0 10px", paddingLeft: 10, borderLeft: "2px solid var(--line)" }}>
          <div style={{ marginBottom: 4 }}>
            {evidence.document_id
              ? <a href={`/api/workspace/file?path=${encodeURIComponent(evidence.path || "")}&slug=${encodeURIComponent(evidence.workspace_id || "")}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{evidence.path || "Open source document"}</a>
              : <span>{evidence.speaker_name || "Transcript source"}{typeof evidence.start_ms === "number" ? ` · ${evidence.start_ms > 1e12 ? new Date(evidence.start_ms).toLocaleTimeString() : `${Math.floor(evidence.start_ms / 1000)}s`}` : ""}</span>}
          </div>
          <blockquote style={{ margin: 0, color: "var(--t2)", lineHeight: 1.5 }}>{evidence.quote}</blockquote>
        </div>
      ))}
    </details>
  );
}

function StateItem({
  item, busy, onAction,
}: {
  item: LiveMeetingItem;
  busy: boolean;
  onAction: (action: string, payload: unknown) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  useEffect(() => { if (!editing) setText(item.text); }, [item.text, editing]);
  const statuses = itemStatuses[item.type];
  const save = async () => {
    if (!text.trim() || text === item.text) { setEditing(false); return; }
    if (await onAction("edit", { id: item.id, expected_revision: item.revision, patch: { text: text.trim() } })) setEditing(false);
  };
  return (
    <article style={{ padding: "9px 0 10px", borderBottom: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span aria-hidden="true" style={{ color: "var(--t3)", width: 18, flex: "none", paddingTop: 2 }}>◇</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 7 }}>
            <span style={{ color: "var(--t3)", fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".05em" }}>{item.type.replaceAll("_", " ")}</span>
            <strong style={{ fontSize: 12.5, fontWeight: 650, color: "var(--t1)" }}>{item.status.replaceAll("_", " ")}</strong>
            {item.stale && <span style={{ color: "var(--warn)", fontSize: 10.5 }}>stale source</span>}
            {!item.provisional && !item.stale && <span style={{ color: "var(--accent)", fontSize: 10.5 }}>grounded</span>}
          </div>
          {editing ? (
            <input autoFocus value={text} maxLength={2000} onChange={(event) => setText(event.target.value)}
              onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setText(item.text); setEditing(false); } }}
              style={{ width: "100%", marginTop: 5, boxSizing: "border-box", border: "1px solid var(--line)", borderRadius: 5, padding: "6px 8px", background: "var(--panel)", color: "var(--t1)", font: "inherit" }} />
          ) : <p style={{ margin: "4px 0 0", color: "var(--t1)", fontSize: 12.5, lineHeight: 1.5 }}>{item.text}</p>}
          {item.details && Object.entries(item.details).filter(([key]) => key !== "agenda_ids" && key !== "topic_id").map(([key, value]) => (
            <div key={key} style={{ marginTop: 4, color: "var(--t3)", fontSize: 11.5 }}>{key.replaceAll("_", " ")}: {Array.isArray(value) ? value.join(", ") : value}</div>
          ))}
          <EvidencePreview item={item} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flex: "none" }}>
          {statuses && <select aria-label={`${item.type} status`} value={item.status} disabled={busy || item.stale}
            onChange={(event) => void onAction("edit", { id: item.id, expected_revision: item.revision, patch: { status: event.target.value } })}
            style={{ maxWidth: 112, border: "1px solid var(--line)", borderRadius: 5, background: "var(--panel)", color: "var(--t2)", padding: "4px 5px", fontSize: 10.5 }}>
            {statuses.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
          </select>}
          {!editing && !item.stale && <button type="button" aria-label={`Edit ${item.type}`} title="Edit" disabled={busy} onClick={() => setEditing(true)} style={{ ...actionButton, padding: "4px 7px" }}>✎</button>}
        </div>
      </div>
    </article>
  );
}

export function LiveAssistRunningView({
  meetingId, meetingTitle, state, busy, error, syncedAt, pendingDraft, onAction, onRetryDraft,
}: {
  meetingId: string;
  meetingTitle: string;
  state: LiveMeetingStateSnapshot;
  busy: boolean;
  error: string;
  syncedAt: number | null;
  pendingDraft: PlannedLiveAssistDraft;
  onAction: (action: string, payload: unknown) => Promise<boolean>;
  onRetryDraft: () => void;
}) {
  const [goalEditing, setGoalEditing] = useState(false);
  const [goal, setGoal] = useState(state.goal?.text || "");
  const [addingAgenda, setAddingAgenda] = useState(false);
  const [agendaText, setAgendaText] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [now, setNow] = useState(Date.now());
  const pendingAgendaEdits = new Map(pendingDraft.agendaEdits.map((item) => [item.id, item.text]));
  const items = (state.items || []).map((item) => pendingAgendaEdits.has(item.id) ? { ...item, text: pendingAgendaEdits.get(item.id)! } : item);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const agendas = items.filter((item) => item.type === "agenda");
  const activeAgenda = agendas.find((item) => item.status === "in_progress");
  const openQuestion = items.find((item) => item.type === "question" && item.status === "open");
  const reviewCount = items.filter((item) => needsReview(item, state)).length;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleAgendas = agendas.filter((agenda) => {
    const linked = items.filter((item) => item.type !== "agenda" && linkedAgendaIds(item, itemById).includes(agenda.id));
    const hasReview = [agenda, ...linked].some((item) => needsReview(item, state));
    const hasOpen = linked.some(isOpenItem) || !["completed", "deferred"].includes(agenda.status);
    const matchesFilter = filter === "all" || filter === "review" && hasReview || filter === "open" && hasOpen;
    return matchesFilter && (!normalizedQuery || itemMatchesText(agenda, normalizedQuery) || linked.some((item) => itemMatchesText(item, normalizedQuery)));
  });
  const unlinkedItems = items.filter((item) => item.type !== "agenda" && !linkedAgendaIds(item, itemById).length
    && (item.type !== "topic" || Array.isArray(item.details?.agenda_ids)))
    .filter((item) => (filter === "all" || filter === "review" && needsReview(item, state) || filter === "open" && isOpenItem(item)) && itemMatchesText(item, normalizedQuery));

  useEffect(() => { if (!goalEditing) setGoal(pendingDraft.goal ?? state.goal?.text ?? ""); }, [pendingDraft.goal, state.goal?.text, goalEditing]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const saveGoal = async () => {
    if (goal === (state.goal?.text || "")) { setGoalEditing(false); return; }
    if (await onAction("edit", { id: "goal", expected_revision: state.goal?.revision || 0, patch: { text: goal.trim() } })) setGoalEditing(false);
  };
  const addAgenda = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!agendaText.trim()) return;
    if (await onAction("add", { type: "agenda", text: agendaText.trim(), details: {} })) {
      setAgendaText("");
      setAddingAgenda(false);
    }
  };
  const pendingCount = (pendingDraft.goal !== null ? 1 : 0) + pendingDraft.agendaItems.length + pendingDraft.agendaEdits.length;

  return (
    <main aria-label={`Live Assist for ${meetingTitle}`} style={{ height: "100%", minHeight: 0, overflow: "auto", padding: "20px 28px 32px", boxSizing: "border-box", color: "var(--t1)" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 12, color: "var(--t2)", fontSize: 12.5 }}>
          <strong style={{ color: "var(--t1)" }}>Meeting goal</strong>
          {goalEditing ? (
            <input autoFocus value={goal} maxLength={2000} onChange={(event) => setGoal(event.target.value)} onBlur={saveGoal}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setGoal(state.goal?.text || ""); setGoalEditing(false); } }}
              style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 6, background: "var(--panel)", color: "var(--t1)", padding: "7px 9px", font: "inherit" }} />
          ) : <span style={{ flex: 1, color: goal ? "var(--t2)" : "var(--t3)" }}>{goal || "No goal set"}</span>}
          {!goalEditing && !state.readonly && <button type="button" aria-label="Edit meeting goal" title="Edit goal" disabled={busy} onClick={() => setGoalEditing(true)} style={actionButton}>✎</button>}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 12, alignItems: "center", border: "1px solid var(--line)", borderRadius: 7, background: "var(--subtle)", padding: "9px 12px", marginBottom: 15, fontSize: 12 }}>
          <div><span style={{ color: "var(--accent)", fontWeight: 650 }}>Current: </span><span>{activeAgenda?.text || "No agenda item in progress"}</span></div>
          <div><span style={{ color: "var(--warn)", fontWeight: 650 }}>Quick check: </span><span>{openQuestion?.text || "No open questions"}</span></div>
          <span style={{ color: "var(--t3)", fontSize: 10.5, textAlign: "right", whiteSpace: "nowrap" }}>{relativeSyncTime(syncedAt, now)}</span>
        </div>

        {error && <div role="alert" style={{ marginBottom: 12, padding: "8px 10px", border: "1px solid var(--danger)", borderRadius: 6, color: "var(--danger)", fontSize: 12 }}>{error}</div>}
        {pendingCount > 0 && <div role="status" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12, color: "var(--warn)", fontSize: 12 }}>
          <span>{pendingCount} planned {pendingCount === 1 ? "edit is" : "edits are"} still saved in this browser.
            {pendingDraft.goal !== null && <> Goal: {pendingDraft.goal || "(cleared)"}.</>}
            {pendingDraft.agendaItems.map((item) => <span key={item.id}> Agenda draft: {item.text}.</span>)}
            {pendingDraft.agendaEdits.map((item) => <span key={item.id}> Updated agenda: {item.text}.</span>)}
          </span>
          <button type="button" disabled={busy} onClick={onRetryDraft} style={actionButton}>Retry sync</button>
        </div>}

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 9, margin: "0 0 5px" }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Agenda</h2>
          <span style={{ color: "var(--t3)", fontSize: 11 }}>{agendas.length} {agendas.length === 1 ? "item" : "items"}</span>
          <span style={{ color: reviewCount ? "var(--warn)" : "var(--t3)", fontSize: 11 }}>{reviewCount ? `${reviewCount} needs review` : "Agenda items grouped by topic"}</span>
          <div style={{ flex: 1 }} />
          {!state.readonly && <button type="button" className={dialogStyles.trigger} disabled={busy} onClick={() => setAddingAgenda((value) => !value)}>+ Add agenda item</button>}
          <LiveMeetingState meetingId={meetingId} meetingTitle={meetingTitle} advanced />
        </div>

        <div style={{ display: "flex", gap: 8, margin: "8px 0 10px" }}>
          <input type="search" aria-label="Search agenda and notes" placeholder="Search agenda and notes" value={query} onChange={(event) => setQuery(event.target.value)}
            style={{ flex: 1, minWidth: 80, border: "1px solid var(--line)", borderRadius: 6, background: "var(--panel)", color: "var(--t1)", padding: "6px 9px", font: "inherit", fontSize: 11.5 }} />
          <select aria-label="Filter meeting items" value={filter} onChange={(event) => setFilter(event.target.value)}
            style={{ border: "1px solid var(--line)", borderRadius: 6, background: "var(--panel)", color: "var(--t2)", padding: "5px 8px", fontSize: 11.5 }}>
            <option value="all">All items</option>
            <option value="review">Needs review{reviewCount ? ` (${reviewCount})` : ""}</option>
            <option value="open">Open items</option>
          </select>
        </div>

        {addingAgenda && <form onSubmit={(event) => void addAgenda(event)} style={{ display: "flex", gap: 7, margin: "8px 0 12px" }}>
          <input autoFocus value={agendaText} maxLength={3000} onChange={(event) => setAgendaText(event.target.value)} placeholder="Add an agenda item" aria-label="New agenda item"
            style={{ flex: 1, border: "1px solid var(--line)", borderRadius: 6, background: "var(--panel)", color: "var(--t1)", padding: "7px 9px", font: "inherit" }} />
          <button type="submit" disabled={busy || !agendaText.trim()} style={actionButton}>Add</button>
          <button type="button" onClick={() => { setAddingAgenda(false); setAgendaText(""); }} style={actionButton}>Cancel</button>
        </form>}

        {visibleAgendas.length === 0 && unlinkedItems.length === 0 && <p style={{ margin: "14px 0", color: "var(--t3)", fontSize: 12.5 }}>{agendas.length || normalizedQuery || filter !== "all" ? "No meeting items match these filters." : "Agenda items will appear here as the meeting progresses."}</p>}
        {visibleAgendas.map((agenda, index) => {
          const linked = items.filter((item) => item.type !== "agenda" && linkedAgendaIds(item, itemById).includes(agenda.id));
          const topics = linked.filter((item) => item.type === "topic");
          const directItems = linked.filter((item) => item.type !== "topic" && !topics.some((topic) => topicFor(item, itemById) === topic.id));
          return (
            <details key={agenda.id} open={agenda.id === activeAgenda?.id || undefined} style={{ borderBottom: "1px solid var(--line)" }}>
              <summary style={{ display: "flex", alignItems: "center", gap: 9, minHeight: 38, cursor: "pointer", listStyle: "none" }}>
                <span aria-hidden="true" style={{ color: agenda.id === activeAgenda?.id ? "var(--accent)" : "var(--t3)", width: 14 }}>{agenda.id === activeAgenda?.id ? "⌄" : "›"}</span>
                <span style={{ flex: 1, fontSize: 13.5 }}>{index + 1}. {agenda.text}</span>
                <span style={{ border: "1px solid var(--line)", borderRadius: 999, padding: "3px 9px", color: agenda.status === "in_progress" ? "var(--accent)" : "var(--t2)", background: "var(--subtle)", fontSize: 10.5 }}>{agenda.status.replaceAll("_", " ")}</span>
                <select aria-label="Agenda status" value={agenda.status} disabled={busy || state.readonly} onClick={(event) => event.stopPropagation()}
                  onChange={(event) => void onAction("edit", { id: agenda.id, expected_revision: agenda.revision, patch: { status: event.target.value } })}
                  style={{ border: "1px solid var(--line)", borderRadius: 5, background: "var(--panel)", color: "var(--t2)", padding: "3px 5px", fontSize: 10.5 }}>
                  {agendaStatuses.map((status) => <option key={status} value={status}>{status.replaceAll("_", " ")}</option>)}
                </select>
              </summary>
              <div style={{ margin: "0 0 6px 20px", padding: "0 0 6px 12px", borderLeft: "2px solid var(--line)" }}>
                {topics.map((topic) => {
                  const topicItems = linked.filter((item) => item.type !== "topic" && topicFor(item, itemById) === topic.id);
                  return <div key={topic.id} style={{ padding: "5px 0 7px", borderBottom: "1px solid var(--line)" }}>
                    <div style={{ color: "var(--t2)", fontSize: 12.5, marginBottom: 3 }}>{topic.text}</div>
                    {topicItems.map((item) => <StateItem key={item.id} item={item} busy={busy} onAction={onAction} />)}
                  </div>;
                })}
                {directItems.map((item) => <StateItem key={item.id} item={item} busy={busy} onAction={onAction} />)}
                {linked.length === 0 && <p style={{ margin: "4px 0", color: "var(--t3)", fontSize: 11.5 }}>No discussion items yet.</p>}
              </div>
            </details>
          );
        })}

        {unlinkedItems.length > 0 && <section style={{ marginTop: 18 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 13, fontWeight: 600 }}>Other meeting items ({unlinkedItems.length})</h3>
          {unlinkedItems.map((item) => <StateItem key={item.id} item={item} busy={busy} onAction={onAction} />)}
        </section>}
      </div>
    </main>
  );
}
