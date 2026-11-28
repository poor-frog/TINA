"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { presentError } from "../surfaces/apiClient";
import { createWorkspaceRoutine } from "../surfaces/routinesApi";
import { emitWebToast } from "./lucian/webToast";

export function RoutineCreateDialog({ request = "", onClose, onSaved }: {
  request?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [prompt, setPrompt] = useState(request);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !name.trim() || !cron.trim() || !timezone.trim() || !prompt.trim()) return;
    setSaving(true);
    setError("");
    try {
      const result = await createWorkspaceRoutine({
        name: name.trim(), cron: cron.trim(), timezone: timezone.trim(), prompt: prompt.trim(),
      });
      if (!result.id || !result.path) throw new Error("This server does not support saving workspace routines.");
      emitWebToast(result.scheduled
        ? "Routine saved and scheduled."
        : { message: "Routine saved. Check Next run in Routines to confirm scheduling.", tone: "info" });
      onSaved();
    } catch (err) {
      setError(presentError(err).headline);
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialog} className="tina-web-modal tina-web-meeting-workspace-dialog"
      aria-labelledby="create-routine-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="tina-web-modal-head"><h2 id="create-routine-title">Create routine</h2></div>
        <div className="tina-web-modal-body">
          <p>The routine runs in your active private workspace. Review the schedule and task instructions before saving.</p>
          <label className="tina-web-field">Routine name
            <input required maxLength={120} value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
          </label>
          <label className="tina-web-field">Cron schedule
            <input required placeholder="*/5 * * * *" value={cron} disabled={saving} onChange={(event) => setCron(event.target.value)} />
          </label>
          <label className="tina-web-field">IANA time zone
            <input required value={timezone} disabled={saving} onChange={(event) => setTimezone(event.target.value)} />
          </label>
          <label className="tina-web-field">Task instructions
            <textarea required rows={4} maxLength={50000} value={prompt} disabled={saving}
              onChange={(event) => setPrompt(event.target.value)} />
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="tina-web-modal-actions">
            <button className="tina-web-btn-ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="tina-web-btn-primary" type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save and enable"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
