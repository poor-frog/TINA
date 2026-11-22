"use client";
/** RoutinesView — Harmonized Obsidian-Teal wrapper around TINA's real `RoutinesBoard`
 *  (preserving full cron, IANA timezone, workspace, and SHA-256 revision CRUD behavior). */
import { WebIcon } from "./Icons";
import { RoutinesBoard } from "../surfaces/routines";

export function RoutinesView({ onAskTina }: { onAskTina: (prompt: string) => void }) {
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
          onClick={() => onAskTina("/routine ")}
        >
          <WebIcon name="plus" size={14} />
          <span>New routine in Ask Tina</span>
        </button>
      </div>
      <div className="tina-web-routines-body">
        <RoutinesBoard />
      </div>
    </div>
  );
}
