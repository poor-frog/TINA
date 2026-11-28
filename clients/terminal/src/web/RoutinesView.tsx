"use client";
/** RoutinesView — Harmonized Obsidian-Teal wrapper around TINA's real `RoutinesBoard`
 *  (preserving full cron, IANA timezone, workspace, and SHA-256 revision CRUD behavior). */
import { WebIcon } from "./Icons";
import { RoutinesBoard } from "../surfaces/routines";
import { useState } from "react";
import { RoutineCreateDialog } from "./RoutineCreateDialog";

export function RoutinesView() {
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  return (
    <div className="tina-web-embedded-surface tina-web-routines">
      <div className="tina-web-routines-bar">
        <div className="tina-web-routines-intro">
          <span className="tina-web-routines-badge">
            <WebIcon name="skills" size={13} />
            <span>Workspace Automation</span>
          </span>
          <span className="tina-web-routines-sub">
            Scheduled agents &amp; skills running automatically on your TINA workspace
          </span>
        </div>
        <button
          type="button"
          className="tina-web-btn-primary"
          onClick={() => setCreating(true)}
        >
          <WebIcon name="plus" size={14} />
          <span>New routine</span>
        </button>
      </div>
      <div className="tina-web-routines-body">
        <RoutinesBoard key={revision} />
      </div>
      {creating && (
        <RoutineCreateDialog
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); setRevision((value) => value + 1); }}
        />
      )}
    </div>
  );
}
