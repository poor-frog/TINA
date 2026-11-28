"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, getJson, presentError } from "../surfaces/apiClient";
import { listSharedMemberships, readAttachedWorkspaces } from "../surfaces/workspaceApi";
import type { MeetingMock } from "../surfaces/meetingModel";

export function canSetMeetingWorkspace(meeting: MeetingMock): boolean {
  return !meeting.shared && /^[1-9]\d*$/.test(meeting.id) &&
    (meeting.live_status === "completed" || meeting.live_status === "stopped");
}

export function MeetingWorkspaceDialog({ meeting, onClose, onSaved }: {
  meeting: MeetingMock;
  onClose: () => void;
  onSaved: (workspace: string | null) => void;
}) {
  const current = meeting.workspace_id ?? "";
  const modal = useRef<HTMLDialogElement>(null);
  const [selection, setSelection] = useState(current);
  const [choices, setChoices] = useState<{ id: string; label: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    const element = modal.current;
    element?.showModal();
    let active = true;
    void Promise.all([listSharedMemberships(), readAttachedWorkspaces().catch(() => null)])
      .then(([memberships, attached]) => {
        if (!active) return;
        const options = memberships
          .filter(({ role }) => role === "owner" || role === "contributor")
          .map(({ workspace_id: id }) => ({ id, label: attached?.slots[id]?.name || id }));
        setChoices(options);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(presentError(error).headline);
      });
    return () => {
      active = false;
      element?.close();
    };
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || current === selection || (selection && !choices?.some(({ id }) => id === selection))) return;
    setSaving(true);
    setSaveError("");
    try {
      const result = await getJson<{ workspace_id: string | null }>(`/api/meetings/${meeting.id}/workspace`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: selection || null, expected_workspace_id: current || null }),
      });
      onSaved(choices?.find(({ id }) => id === result.workspace_id)?.label ?? result.workspace_id);
    } catch (error) {
      setSaveError(error instanceof ApiError && error.status === 403
        ? "You need contributor or owner access to the selected workspace."
        : presentError(error).headline);
      setSaving(false);
    }
  };

  return (
    <dialog
      className="tina-web-modal tina-web-meeting-workspace-dialog"
      ref={modal}
      aria-labelledby="meeting-workspace-dialog-title"
      onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}
    >
      <form onSubmit={(event) => void save(event)}>
        <div className="tina-web-modal-head">
          <h2 id="meeting-workspace-dialog-title">{current ? "Change workspace" : "Add to workspace"}</h2>
        </div>
        <div className="tina-web-modal-body">
          <p>{meeting.title_custom ?? meeting.title}</p>
          <label className="tina-web-field">
            <span>Shared workspace</span>
            <select value={selection} onChange={(e) => setSelection(e.target.value)} disabled={saving}>
              <option value="">No workspace</option>
              {current && !choices?.some(({ id }) => id === current) && <option value={current}>{current}</option>}
              {choices?.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <p>Workspace members can view this meeting and its transcript. Recording access is managed separately.</p>
          {choices === null && !loadError && <p role="status">Loading workspaces…</p>}
          {choices?.length === 0 && <p>You need contributor or owner access to add this meeting to a shared workspace.</p>}
          {loadError && <p role="alert">{loadError}</p>}
          {saveError && <p role="alert">{saveError}</p>}
          <div className="tina-web-modal-actions">
            <button className="tina-web-btn-ghost" type="button" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="tina-web-btn-primary" type="submit" disabled={saving || current === selection}>
              {saving ? "Saving…" : selection ? "Save workspace" : "Remove from workspace"}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
