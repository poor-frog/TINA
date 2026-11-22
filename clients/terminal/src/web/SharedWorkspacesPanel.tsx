"use client";
/** SharedWorkspacesPanel — real Team workspace & invite management backed by `workspaceApi.ts`.
 *  Supports listing shared memberships, toggling active mounts, promoting private workspaces to
 *  shared, creating new shared workspaces, managing member roles, and minting/revoking invite links. */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
import { presentError } from "../surfaces/apiClient";
import {
  createSharedWorkspace,
  leaveWorkspace,
  listSharedMemberships,
  listWorkspaceInvites,
  listWorkspaceMembers,
  mintInvite,
  readActiveSet,
  readAttachedWorkspaces,
  removeWorkspaceMember,
  revokeWorkspaceInvite,
  setSharedActive,
  setWorkspaceMemberRole,
  shareEnableWorkspace,
  type ActiveMount,
  type AttachedWorkspaces,
  type Membership,
  type WorkspaceInvite,
  type WorkspaceMember,
} from "../surfaces/workspaceApi";

function shortSubject(subject: string): string {
  return subject.replace(/@.*$/, "").replace(/^u_/, "");
}

export function SharedWorkspacesPanel() {
  const [attached, setAttached] = useState<AttachedWorkspaces>({ active: null, slots: {} });
  const [activeSet, setActiveSet] = useState<ActiveMount[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [selectedWs, setSelectedWs] = useState<string | null>(null);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [detailsLoading, setDetailsLoading] = useState(false);

  const [inviteRole, setInviteRole] = useState<"contributor" | "owner">("contributor");
  const [inviteMode, setInviteMode] = useState<"open" | "restricted">("open");
  const [inviteEmails, setInviteEmails] = useState("");
  const [mintedLink, setMintedLink] = useState<string | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [att, act, mem] = await Promise.all([
        readAttachedWorkspaces().catch(() => ({ active: null, slots: {} })),
        readActiveSet().catch(() => ({ subject: "", active: [] })),
        listSharedMemberships(),
      ]);
      setAttached(att);
      setActiveSet(act.active);
      setMemberships(mem);
      setSelectedWs((prev) => {
        if (prev && mem.some((m) => m.workspace_id === prev)) return prev;
        return mem[0]?.workspace_id ?? null;
      });
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const loadWorkspaceDetails = useCallback(async (wsId: string) => {
    setDetailsLoading(true);
    try {
      const [mList, iList] = await Promise.all([
        listWorkspaceMembers(wsId),
        listWorkspaceInvites(wsId).catch(() => []),
      ]);
      setMembers(mList);
      setInvites(iList.filter((inv) => !inv.revoked));
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  useEffect(() => {
    setMintedLink(null);
    setCopiedLink(false);
    if (!selectedWs) {
      setMembers([]);
      setInvites([]);
      return;
    }
    void loadWorkspaceDetails(selectedWs);
  }, [selectedWs, loadWorkspaceDetails]);

  const runAction = async (fn: () => Promise<void>, okMessage?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (okMessage) setNotice(okMessage);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateShared = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    void runAction(async () => {
      const created = await createSharedWorkspace(trimmed);
      setNewName("");
      await loadAll();
      setSelectedWs(created.workspace_id);
    }, `Created shared workspace “${trimmed}”.`);
  };

  const handleToggleMount = (wsId: string, currentlyMounted: boolean) => {
    void runAction(async () => {
      await setSharedActive(wsId, !currentlyMounted);
      await loadAll();
    }, !currentlyMounted ? "Mounted workspace into your agent context." : "Unmounted workspace from your active set.");
  };

  const handlePromotePrivate = (slug: string) => {
    void runAction(async () => {
      const promoted = await shareEnableWorkspace(slug);
      await loadAll();
      setSelectedWs(promoted.workspace_id);
    }, `Enabled team sharing for “${slug}”.`);
  };

  const handleMintInvite = (e: FormEvent) => {
    e.preventDefault();
    if (!selectedWs) return;
    const allowedEmails = inviteMode === "restricted"
      ? inviteEmails.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      : undefined;
    if (inviteMode === "restricted" && (!allowedEmails || allowedEmails.length === 0)) {
      setError("Enter at least one email address for a restricted invite.");
      return;
    }
    void runAction(async () => {
      const minted = await mintInvite({
        workspace_id: selectedWs,
        role: inviteRole,
        mode: inviteMode,
        expires_in_sec: 7 * 86400,
        max_uses: inviteMode === "restricted" ? allowedEmails!.length : 25,
        allowed_emails: allowedEmails,
      });
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      setMintedLink(`${origin}/?invite=${encodeURIComponent(minted.token)}`);
      setCopiedLink(false);
      setInviteEmails("");
      await loadWorkspaceDetails(selectedWs);
    }, "Invite link created (expires in 7 days).");
  };

  const handleCopyLink = async () => {
    if (!mintedLink || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(mintedLink);
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      /* ignore clipboard denial */
    }
  };

  const handleRevokeInvite = (inviteId: string) => {
    if (!selectedWs) return;
    void runAction(async () => {
      await revokeWorkspaceInvite(selectedWs, inviteId);
      await loadWorkspaceDetails(selectedWs);
    }, "Invite link revoked.");
  };

  const handleRoleChange = (member: WorkspaceMember, role: string) => {
    if (!selectedWs || member.role === role) return;
    void runAction(async () => {
      await setWorkspaceMemberRole(selectedWs, member.subject, role);
      await loadWorkspaceDetails(selectedWs);
    }, `Updated ${member.email || shortSubject(member.subject)} to ${role}.`);
  };

  const handleRemoveMember = (member: WorkspaceMember) => {
    if (!selectedWs) return;
    void runAction(async () => {
      await removeWorkspaceMember(selectedWs, member.subject);
      await loadWorkspaceDetails(selectedWs);
    }, `Removed ${member.email || shortSubject(member.subject)} from workspace.`);
  };

  const handleLeave = (wsId: string) => {
    void runAction(async () => {
      await leaveWorkspace(wsId);
      setSelectedWs(null);
      await loadAll();
    }, "Left shared workspace.");
  };

  const selectedMembership = memberships.find((m) => m.workspace_id === selectedWs) ?? null;
  const isSelectedOwner = selectedMembership?.role === "owner";

  const privateSlots = Object.entries(attached.slots).filter(
    ([slug, slot]) => !slot.archived && !memberships.some((m) => m.workspace_id === slug),
  );

  return (
    <div className="tina-web-settings-stack">
      {error && (
        <div role="alert" className="tina-web-alert danger">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="tina-web-alert success">
          {notice}
        </div>
      )}

      <section className="tina-web-settings-card">
        <div className="tina-web-settings-card-head">
          <div>
            <h3>Create a shared team workspace</h3>
            <p>
              Shared workspaces let teammates collaborate on the same meeting knowledge graph, tasks, and routines.
            </p>
          </div>
        </div>
        <form onSubmit={handleCreateShared} className="tina-web-inline-form">
          <input
            type="text"
            aria-label="New shared workspace name"
            placeholder="e.g. Engineering Syncs, Customer Success"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={busy}
            className="tina-web-input"
          />
          <button type="submit" className="tina-web-btn-primary" disabled={busy || !newName.trim()}>
            <WebIcon name="plus" size={14} />
            <span>Create workspace</span>
          </button>
        </form>
      </section>

      <section className="tina-web-settings-card">
        <div className="tina-web-settings-card-head">
          <div>
            <h3>Shared workspaces ({memberships.length})</h3>
            <p>Toggle whether a shared workspace is mounted into your agent sessions, or select one to manage members.</p>
          </div>
          <button type="button" className="tina-web-btn-ghost" onClick={() => void loadAll()} disabled={busy}>
            <WebIcon name="refresh" size={13} />
            <span>Refresh</span>
          </button>
        </div>

        {loading ? (
          <p className="tina-web-muted-note">Loading shared workspaces…</p>
        ) : memberships.length === 0 ? (
          <p className="tina-web-muted-note">
            No shared workspaces yet. Create one above or promote one of your private workspaces below.
          </p>
        ) : (
          <div className="tina-web-ws-list">
            {memberships.map((mem) => {
              const mounted = activeSet.some((a) => a.role === "shared" && a.slug === mem.workspace_id);
              const active = selectedWs === mem.workspace_id;
              return (
                <div
                  key={mem.workspace_id}
                  className={`tina-web-ws-row ${active ? "selected" : ""}`}
                >
                  <button
                    type="button"
                    className="tina-web-ws-select"
                    onClick={() => setSelectedWs(mem.workspace_id)}
                  >
                    <span className="tina-web-ws-icon">
                      <WebIcon name="users" size={15} />
                    </span>
                    <span className="tina-web-ws-copy">
                      <strong>{mem.workspace_id}</strong>
                      <span>Role: {mem.role}</span>
                    </span>
                  </button>
                  <div className="tina-web-ws-actions">
                    <span className={`tina-web-status-pill ${mounted ? "completed" : "scheduled"}`}>
                      {mounted ? "Mounted" : "Unmounted"}
                    </span>
                    <button
                      type="button"
                      className="tina-web-btn-ghost"
                      disabled={busy}
                      onClick={() => handleToggleMount(mem.workspace_id, mounted)}
                    >
                      {mounted ? "Unmount" : "Mount"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {selectedWs && selectedMembership && (
        <section className="tina-web-settings-card" aria-label={`Manage ${selectedWs}`}>
          <div className="tina-web-settings-card-head">
            <div>
              <h3>Members &amp; invites · {selectedWs}</h3>
              <p>
                You are a <strong>{selectedMembership.role}</strong> in this workspace.
              </p>
            </div>
            {!isSelectedOwner && (
              <button
                type="button"
                className="tina-web-btn-ghost"
                disabled={busy}
                onClick={() => handleLeave(selectedWs)}
                style={{ color: "var(--tw-danger)" }}
              >
                Leave workspace
              </button>
            )}
          </div>

          {detailsLoading ? (
            <p className="tina-web-muted-note">Loading roster and active invites…</p>
          ) : (
            <>
              <div className="tina-web-subblock">
                <div className="tina-web-subblock-label">Members ({members.length})</div>
                {members.length === 0 ? (
                  <p className="tina-web-muted-note">No members reported for this workspace.</p>
                ) : (
                  <div className="tina-web-roster">
                    {members.map((member) => (
                      <div key={member.subject} className="tina-web-roster-row">
                        <div className="tina-web-roster-id">
                          <strong>{member.email || shortSubject(member.subject)}</strong>
                          {member.email && <span>{shortSubject(member.subject)}</span>}
                        </div>
                        <div className="tina-web-ws-actions">
                          {isSelectedOwner ? (
                            <select
                              aria-label={`Role for ${member.email || member.subject}`}
                              value={member.role}
                              disabled={busy}
                              onChange={(e) => handleRoleChange(member, e.target.value)}
                              className="tina-web-select-compact"
                            >
                              <option value="contributor">Contributor</option>
                              <option value="owner">Owner</option>
                            </select>
                          ) : (
                            <span className="tina-web-role-pill">{member.role}</span>
                          )}
                          {isSelectedOwner && member.role !== "owner" && (
                            <button
                              type="button"
                              className="tina-web-btn-ghost"
                              disabled={busy}
                              onClick={() => handleRemoveMember(member)}
                              style={{ color: "var(--tw-danger)" }}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="tina-web-subblock">
                <div className="tina-web-subblock-label">Mint an invite link</div>
                <form onSubmit={handleMintInvite} className="tina-web-invite-form">
                  <div className="tina-web-invite-controls">
                    <select
                      aria-label="Invite role"
                      value={inviteRole}
                      onChange={(e) => setInviteRole(e.target.value as "contributor" | "owner")}
                      disabled={busy}
                      className="tina-web-select-compact"
                    >
                      <option value="contributor">Contributor</option>
                      <option value="owner">Owner</option>
                    </select>
                    <select
                      aria-label="Invite access mode"
                      value={inviteMode}
                      onChange={(e) => setInviteMode(e.target.value as "open" | "restricted")}
                      disabled={busy}
                      className="tina-web-select-compact"
                    >
                      <option value="open">Anyone with link (up to 25 uses)</option>
                      <option value="restricted">Specific emails only</option>
                    </select>
                    <button type="submit" className="tina-web-btn-primary" disabled={busy}>
                      <WebIcon name="link" size={14} />
                      <span>Generate invite link</span>
                    </button>
                  </div>
                  {inviteMode === "restricted" && (
                    <input
                      type="text"
                      aria-label="Allowed invite emails"
                      placeholder="alice@company.com, bob@company.com"
                      value={inviteEmails}
                      onChange={(e) => setInviteEmails(e.target.value)}
                      disabled={busy}
                      className="tina-web-input"
                    />
                  )}
                </form>

                {mintedLink && (
                  <div className="tina-web-minted-box">
                    <input
                      type="text"
                      readOnly
                      aria-label="Generated invite link"
                      value={mintedLink}
                      className="tina-web-input"
                    />
                    <button type="button" className="tina-web-btn-ghost" onClick={() => void handleCopyLink()}>
                      <WebIcon name={copiedLink ? "check" : "copy"} size={14} />
                      <span>{copiedLink ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                )}

                {invites.length > 0 && (
                  <div className="tina-web-roster" style={{ marginTop: 10 }}>
                    {invites.map((inv) => (
                      <div key={inv.id} className="tina-web-roster-row">
                        <div className="tina-web-roster-id">
                          <strong>{inv.mode === "restricted" ? "Restricted email invite" : "Open invite link"} · {inv.role}</strong>
                          <span>
                            {inv.uses ?? 0}/{inv.max_uses ?? 1} used
                            {inv.allowed_emails?.length ? ` · ${inv.allowed_emails.join(", ")}` : ""}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="tina-web-btn-ghost"
                          disabled={busy}
                          onClick={() => handleRevokeInvite(inv.id)}
                          style={{ color: "var(--tw-danger)" }}
                        >
                          Revoke
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {privateSlots.length > 0 && (
        <section className="tina-web-settings-card">
          <div className="tina-web-settings-card-head">
            <div>
              <h3>Promote a private workspace</h3>
              <p>Convert an existing personal workspace into a shared team workspace so you can invite teammates.</p>
            </div>
          </div>
          <div className="tina-web-ws-list">
            {privateSlots.map(([slug, slot]) => (
              <div key={slug} className="tina-web-ws-row">
                <div className="tina-web-ws-select" style={{ cursor: "default" }}>
                  <span className="tina-web-ws-icon">
                    <WebIcon name="layers" size={15} />
                  </span>
                  <span className="tina-web-ws-copy">
                    <strong>{slot.name || (slug === "seed" ? "Personal" : slug)}</strong>
                    <span>{slot.repo || slug}</span>
                  </span>
                </div>
                <button
                  type="button"
                  className="tina-web-btn-ghost"
                  disabled={busy}
                  onClick={() => handlePromotePrivate(slug)}
                >
                  Enable sharing
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
