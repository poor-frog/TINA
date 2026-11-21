"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  EMPTY_LIVE_ASSIST_DRAFT,
  mergeLiveMeetingState,
  readAllLiveMeetingState,
  readPlannedLiveAssistDraft,
  writePlannedLiveAssistDraft,
  postLiveMeetingStateAction,
  type LiveMeetingItem,
  type LiveMeetingStateSnapshot,
  type PlannedLiveAssistDraft,
} from "./liveMeetingStateApi";

interface PlanContextValue {
  state: LiveMeetingStateSnapshot | null;
  draft: PlannedLiveAssistDraft;
  goal: string;
  agendas: Array<LiveMeetingItem | { id: string; text: string; status: "pending"; revision: 0; local: true }>;
  error: string;
  busy: boolean;
  readOnly: boolean;
  setGoal: (text: string) => void;
  addAgenda: (text: string) => void;
  editAgenda: (id: string, text: string, revision: number) => Promise<void>;
  retryPending: () => Promise<void>;
}

const PlanContext = createContext<PlanContextValue | null>(null);
const fieldStyle: React.CSSProperties = {
  border: "1px solid var(--line)", borderRadius: 6, background: "var(--panel)", color: "var(--t1)",
  font: "inherit", padding: "7px 10px", outline: "none", boxSizing: "border-box",
};
const smallButton: React.CSSProperties = {
  border: "1px solid var(--line)", borderRadius: 6, background: "transparent", color: "var(--t2)",
  padding: "4px 8px", fontSize: 11.5, cursor: "pointer",
};

function usePlanContext(): PlanContextValue {
  const value = useContext(PlanContext);
  if (!value) throw new Error("Planned Live Assist fields must be inside PlannedLiveAssistProvider");
  return value;
}

export function PlannedLiveAssistProvider({
  meetingId, draftKey, readOnly, ensureRow, children,
}: {
  meetingId: string;
  draftKey: string;
  readOnly: boolean;
  ensureRow: () => Promise<string | null>;
  children: ReactNode;
}) {
  const [state, setState] = useState<LiveMeetingStateSnapshot | null>(null);
  const stateRef = useRef<LiveMeetingStateSnapshot | null>(null);
  const [draft, setDraftState] = useState<PlannedLiveAssistDraft>({ ...EMPTY_LIVE_ASSIST_DRAFT, agendaItems: [], agendaEdits: [] });
  const draftRef = useRef(draft);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const goalTimer = useRef<number | null>(null);
  const agendaTimers = useRef(new Map<string, number>());
  const saveQueue = useRef(Promise.resolve());
  const syncing = useRef(false);

  const replaceState = useCallback((next: LiveMeetingStateSnapshot) => {
    const published = mergeLiveMeetingState(stateRef.current, next);
    stateRef.current = published;
    setState(published);
  }, []);
  const replaceDraft = useCallback((next: PlannedLiveAssistDraft) => {
    draftRef.current = next;
    setDraftState(next);
    writePlannedLiveAssistDraft(draftKey, next);
  }, [draftKey]);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const localDraft = readPlannedLiveAssistDraft(draftKey);
    stateRef.current = null;
    setState(null);
    setError("");
    draftRef.current = localDraft;
    setDraftState(localDraft);
    if (meetingId) {
      void readAllLiveMeetingState(meetingId, controller.signal).then((next) => {
        if (alive) replaceState(next);
      }).catch((reason: unknown) => {
        if (alive && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load Live Assist state");
      });
    }
    return () => {
      alive = false;
      controller.abort();
      if (goalTimer.current !== null) window.clearTimeout(goalTimer.current);
      agendaTimers.current.forEach((timer) => window.clearTimeout(timer));
      agendaTimers.current.clear();
    };
  }, [meetingId, draftKey, replaceState]);

  const post = useCallback((action: string, payload: unknown) => {
    if (!meetingId) return Promise.reject(new Error("Save the meeting before saving Live Assist state"));
    setBusy(true);
    setError("");
    const queued = saveQueue.current.then(async () => {
      let currentPayload = payload;
      if (action === "edit" && payload && typeof payload === "object" && "id" in payload) {
        const edit = payload as { id: string; expected_revision?: number };
        const latest = edit.id === "goal" ? stateRef.current?.goal : stateRef.current?.items?.find((item) => item.id === edit.id);
        currentPayload = { ...edit, expected_revision: latest?.revision ?? edit.expected_revision ?? 0 };
      }
      const next = await postLiveMeetingStateAction(meetingId, action, currentPayload);
      replaceState(next);
      return next;
    });
    saveQueue.current = queued.then(() => undefined, () => undefined);
    return queued.catch((reason: unknown) => {
      setError(reason instanceof Error ? reason.message : "Could not save Live Assist state");
      throw reason;
    }).finally(() => setBusy(false));
  }, [meetingId, replaceState]);

  const retryPending = useCallback(async () => {
    const currentMeetingId = meetingId;
    if (!currentMeetingId || !stateRef.current?.configured || syncing.current) return;
    syncing.current = true;
    try {
      let pending = draftRef.current;
      if (pending.goal !== null) {
        const goal = pending.goal;
        await post("edit", { id: "goal", expected_revision: stateRef.current.goal?.revision || 0, patch: { text: goal } });
        if (draftRef.current.goal === goal) replaceDraft({ ...draftRef.current, goal: null });
        pending = draftRef.current;
      }
      for (const item of [...pending.agendaItems]) {
        await post("add", { type: "agenda", text: item.text, details: {} });
        replaceDraft({ ...draftRef.current, agendaItems: draftRef.current.agendaItems.filter((candidate) => candidate.id !== item.id) });
      }
      pending = draftRef.current;
      for (const item of [...pending.agendaEdits]) {
        const timer = agendaTimers.current.get(item.id);
        if (timer !== undefined) window.clearTimeout(timer);
        agendaTimers.current.delete(item.id);
        const revision = stateRef.current?.items?.find((candidate) => candidate.id === item.id)?.revision ?? item.revision;
        await post("edit", { id: item.id, expected_revision: revision, patch: { text: item.text } });
        replaceDraft({ ...draftRef.current, agendaEdits: draftRef.current.agendaEdits.filter((candidate) => candidate.id !== item.id) });
      }
    } catch { /* The draft remains saved locally and can be retried. */ }
    finally { syncing.current = false; }
  }, [meetingId, post, replaceDraft]);

  useEffect(() => {
    if (state?.configured) void retryPending();
  }, [meetingId, state?.configured, retryPending]);

  const setGoal = useCallback((text: string) => {
    const current = draftRef.current;
    replaceDraft({ ...current, goal: text });
    if (!stateRef.current?.configured) {
      void ensureRow().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not save the planned meeting"));
      return;
    }
    if (goalTimer.current !== null) window.clearTimeout(goalTimer.current);
    goalTimer.current = window.setTimeout(() => {
      goalTimer.current = null;
      const currentState = stateRef.current;
      if (!currentState?.configured) return;
      const revision = currentState.goal?.revision || 0;
      void post("edit", { id: "goal", expected_revision: revision, patch: { text } }).then(() => {
        if (draftRef.current.goal === text) replaceDraft({ ...draftRef.current, goal: null });
      }).catch(() => {});
    }, 450);
  }, [ensureRow, post, replaceDraft]);

  const addAgenda = useCallback((text: string) => {
    if (stateRef.current?.configured && meetingId) {
      const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `draft-${Date.now()}`;
      replaceDraft({ ...draftRef.current, agendaItems: [...draftRef.current.agendaItems, { id, text }] });
      void post("add", { type: "agenda", text, details: {} }).then(() => {
        replaceDraft({ ...draftRef.current, agendaItems: draftRef.current.agendaItems.filter((item) => item.id !== id) });
      }).catch(() => {});
      return;
    }
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `draft-${Date.now()}`;
    replaceDraft({ ...draftRef.current, agendaItems: [...draftRef.current.agendaItems, { id, text }] });
    void ensureRow().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not save the planned meeting"));
  }, [ensureRow, meetingId, post, replaceDraft]);

  const editAgenda = useCallback(async (id: string, text: string, revision: number) => {
    if (!stateRef.current?.configured || !meetingId || draftRef.current.agendaItems.some((item) => item.id === id)) {
      const agendaItems = draftRef.current.agendaItems.map((item) => item.id === id ? { ...item, text } : item);
      replaceDraft({ ...draftRef.current, agendaItems });
      return;
    }
    const original = stateRef.current.items?.find((item) => item.id === id)?.text;
    if (original === text) {
      const previousTimer = agendaTimers.current.get(id);
      if (previousTimer !== undefined) window.clearTimeout(previousTimer);
      agendaTimers.current.delete(id);
      replaceDraft({ ...draftRef.current, agendaEdits: draftRef.current.agendaEdits.filter((item) => item.id !== id) });
      return;
    }
    const agendaEdits = [...draftRef.current.agendaEdits.filter((item) => item.id !== id), { id, text, revision }];
    replaceDraft({ ...draftRef.current, agendaEdits });
    const previousTimer = agendaTimers.current.get(id);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      agendaTimers.current.delete(id);
      const current = draftRef.current.agendaEdits.find((item) => item.id === id);
      if (!current) return;
      const latestRevision = stateRef.current?.items?.find((item) => item.id === id)?.revision ?? current.revision;
      void post("edit", { id, expected_revision: latestRevision, patch: { text: current.text } }).then(() => {
        if (draftRef.current.agendaEdits.find((item) => item.id === id)?.text === current.text) {
          replaceDraft({ ...draftRef.current, agendaEdits: draftRef.current.agendaEdits.filter((item) => item.id !== id) });
        }
      }).catch(() => {});
    }, 450);
    agendaTimers.current.set(id, timer);
  }, [meetingId, post, replaceDraft]);

  const agendaEdits = useMemo(() => new Map(draft.agendaEdits.map((item) => [item.id, item.text])), [draft.agendaEdits]);
  const agendas = [
    ...(state?.configured ? (state.items || []).filter((item) => item.type === "agenda").map((item) => ({ ...item, text: agendaEdits.get(item.id) ?? item.text })) : []),
    ...draft.agendaItems.map((item) => ({ ...item, status: "pending" as const, revision: 0 as const, local: true as const })),
  ];
  const goal = draft.goal ?? state?.goal?.text ?? "";

  return <PlanContext.Provider value={{ state, draft, goal, agendas, error, busy, readOnly, setGoal, addAgenda, editAgenda, retryPending }}>{children}</PlanContext.Provider>;
}

export function PlannedLiveAssistGoal() {
  const value = usePlanContext();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr)", alignItems: "baseline", gap: 8, marginTop: 10, color: "var(--t2)", fontSize: 12 }}>
      <label htmlFor="planned-live-assist-goal">Meeting goal:</label>
      {value.readOnly ? <p style={{ margin: 0, color: "var(--t2)" }}>{value.goal || "No goal set"}</p> : <textarea id="planned-live-assist-goal" rows={2} maxLength={2000} value={value.goal}
        onChange={(event) => value.setGoal(event.target.value)} placeholder="What should this meeting accomplish?" style={{ ...fieldStyle, width: "100%", minHeight: 42, resize: "vertical" }} />}
    </div>
  );
}

function PlannedAgendaRow({
  item, onSave, readOnly,
}: {
  item: LiveMeetingItem | { id: string; text: string; status: "pending"; revision: 0; local: true };
  onSave: (id: string, text: string, revision: number) => Promise<void>;
  readOnly: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const [editOrigin, setEditOrigin] = useState(item.text);
  useEffect(() => { if (!editing) { setText(item.text); setEditOrigin(item.text); } }, [item.text, editing]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
      <span style={{ color: "var(--t3)", width: 18 }}>›</span>
      {editing ? <input autoFocus value={text} maxLength={"local" in item ? 3000 : 2000} onChange={(event) => { setText(event.target.value); if (!readOnly) void onSave(item.id, event.target.value, item.revision); }} onBlur={() => setEditing(false)}
        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setText(editOrigin); if (!readOnly) void onSave(item.id, editOrigin, item.revision); setEditing(false); } }}
        style={{ ...fieldStyle, flex: 1 }} /> : <span style={{ flex: 1, color: "var(--t1)", fontSize: 13 }}>{item.text}</span>}
      <span style={{ color: item.status === "in_progress" ? "var(--accent)" : "var(--t3)", fontSize: 11 }}>{"local" in item ? "Draft" : item.status.replaceAll("_", " ")}</span>
      {!readOnly && !editing && <button type="button" aria-label="Edit agenda item" title="Edit agenda item" onClick={() => setEditing(true)} style={smallButton}>✎</button>}
    </div>
  );
}

export function PlannedLiveAssistAgenda() {
  const value = usePlanContext();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!text.trim()) return;
    value.addAgenda(text.trim());
    setText("");
    setAdding(false);
  };
  return (
    <section aria-label="Draft agenda" style={{ marginTop: 18, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
        <h3 style={{ margin: 0, color: "var(--t1)", fontSize: 14, fontWeight: 600 }}>Draft agenda</h3>
        <span style={{ color: "var(--t3)", fontSize: 11 }}>{value.agendas.length} {value.agendas.length === 1 ? "item" : "items"}</span>
        <div style={{ flex: 1 }} />
        {!value.readOnly && <button type="button" style={smallButton} onClick={() => setAdding((open) => !open)}>+ Add agenda item</button>}
      </div>
      {value.error && <p role="alert" style={{ color: "var(--danger)", fontSize: 11.5 }}>{value.error}{value.state?.configured && <button type="button" onClick={() => void value.retryPending()} style={{ ...smallButton, marginLeft: 8 }}>Retry sync</button>}</p>}
      {adding && <form onSubmit={submit} style={{ display: "flex", gap: 7, margin: "8px 0" }}>
        <input autoFocus value={text} maxLength={3000} onChange={(event) => setText(event.target.value)} placeholder="Add an agenda item" aria-label="New agenda item" style={{ ...fieldStyle, flex: 1 }} />
        <button type="submit" disabled={!text.trim()} style={smallButton}>Add</button>
        <button type="button" onClick={() => { setAdding(false); setText(""); }} style={smallButton}>Cancel</button>
      </form>}
      {value.agendas.length === 0
        ? <p style={{ margin: "8px 0 0", color: "var(--t3)", fontSize: 12 }}>No agenda items yet. Add the topics you want to cover.</p>
        : value.agendas.map((item) => <PlannedAgendaRow key={item.id} item={item} onSave={value.editAgenda} readOnly={value.readOnly} />)}
      {value.draft.goal !== null && value.state?.configured && <p role="status" style={{ margin: "7px 0 0", color: "var(--t3)", fontSize: 10.5 }}>Goal changes are syncing…</p>}
    </section>
  );
}
