"use client";
/** term-workbench — the structured 3-pane shell.
 *  LEFT (resizable/collapsible): capture-first actions + grouped navigation + the active list.
 *  CENTER: dockview TABS — a "tab" host resolves each panel by params.kind via the tab registry.
 *  RIGHT (resizable/collapsible): the persistent workspace chat, grounded by the active center tab.
 *  Reuses the Phase-C ⌘K palette + keybindings; the kernel's services do the rest. */
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Allotment, LayoutPriority } from "allotment";
import "allotment/dist/style.css";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanelProps, type IDockviewPanelHeaderProps, themeAbyss } from "dockview-react";
import "dockview/dist/styles/dockview.css";

const PANES_KEY = "tina.terminal.panes.v2";
const savedSizes = (): number[] | undefined => {
  try {
    const s = localStorage.getItem(PANES_KEY);
    const a = s ? JSON.parse(s) : null;
    if (!Array.isArray(a) || a.length !== 3) return undefined;
    let left = Number(a[0]) || 282;
    // Promote the former default width to the selected Direction C sidebar width.
    if (left === 240 || left > 360 || left < 180) left = 282;
    let right = Number(a[2]) || 320;
    if (right > 480 || right < 240) right = 320;
    const center = Math.max(Number(a[1]) || 700, 300);
    return [left, center, right];
  } catch {
    return undefined;
  }
};
const persistSizes = (s: number[]) => { try { localStorage.setItem(PANES_KEY, JSON.stringify(s)); } catch { /* noop */ } };

// ── agent-first shell (v2) pane sizes: [center(thread/record), right(context)] ─────────────────────
// Separate key from v1's 3-pane sizes so flipping the shell flag never corrupts the other layout.
const SHELL_PANES_KEY = "tina.terminal.panes.shellv2";
const savedShellSizes = (): number[] | undefined => {
  try {
    const a = JSON.parse(localStorage.getItem(SHELL_PANES_KEY) ?? "null");
    if (!Array.isArray(a) || a.length !== 2) return undefined;
    const center = Math.max(Number(a[0]) || 800, 360);
    const right = Math.min(Math.max(Number(a[1]) || 340, 260), 420);
    return [center, right];
  } catch { return undefined; }
};
const persistShellSizes = (s: number[]) => { try { localStorage.setItem(SHELL_PANES_KEY, JSON.stringify(s)); } catch { /* noop */ } };
import { useService, useStore, KeybindingServiceId } from "../platform";
import { LayoutServiceId } from "./layout";
import { PaletteServiceId } from "./palette";
import { CommandPalette } from "./CommandPalette";
import { OpsNotice } from "./OpsNotice";
import { registry } from "../contributions";
import { Icon } from "../ui-kit";
import { updatesBadge, markUpdatesSeen, updatesSeenTs } from "../surfaces/updatesBadge";
import { readActiveSet, readWorkspaceGit } from "../surfaces/workspaceApi";
import { FilesList } from "../surfaces/workspace";
import { ContextMenu, copyText } from "../ui-kit/ContextMenu";
import { Chat } from "../surfaces/chat";
import { SidebarMeetingCapture } from "../surfaces/meeting";
import { SettingsDialog } from "../surfaces/settings";
import { resolveDocRef } from "../ui-kit/docLinks";
import { liveMeetingsNow } from "../surfaces/liveMeetings";
import { ContextRail } from "../surfaces/context";
import { shellStore, THREAD_TAB_KIND } from "./shell";
import { firstViewPlan } from "./firstView";
import { isOwnedPath, meetingIdFromPath, meetingPath } from "../app/meetingRoute";
import { OPEN_ENTITY_EVENT } from "../canvas/actions";
import { useTheme } from "../app/theme";
import { meetingsOnly } from "../app/mode";

// ── theme toggle: dark ⇄ day mode, icon button in the profile row ──
function ThemeToggle() {
  const [theme, toggle] = useTheme();
  const day = theme === "light";
  return (
    <button type="button" className="panel-toggle-btn" onClick={toggle} title={day ? "Switch to dark mode" : "Switch to day mode"}>
      <Icon name={day ? "moon" : "sun"} size={14} />
    </button>
  );
}

// ── the dockview panel host: render a tab by its kind, tracking active state ─────
function TabHost(props: IDockviewPanelProps) {
  const layout = useService(LayoutServiceId);
  // dockview reuses ONE panel for the shared preview slot and swaps its params via updateParameters
  // WITHOUT re-rendering the React content — subscribe to the param-change event so single-clicking a
  // different meeting/file in the preview slot actually re-binds the content to the new params.
  const [params, setParams] = useState(props.params as { kind?: string; p?: Record<string, unknown> });
  useEffect(() => {
    const d = props.api.onDidParametersChange((next) => { if (next && Object.keys(next).length) setParams(next as { kind?: string; p?: Record<string, unknown> }); });
    return () => d.dispose();
  }, [props.api]);
  const kind = params.kind ?? "";
  const Comp = registry.tabComponent(kind);
  const [active, setActive] = useState<boolean>(props.api.isActive);
  useEffect(() => {
    const d = props.api.onDidActiveChange((e: { isActive: boolean }) => setActive(e.isActive));
    return () => d.dispose();
  }, [props.api]);
  useEffect(() => { if (active) layout.setActiveTab(kind ? { kind, params: params.p ?? {} } : null); }, [active, kind, layout, params.p]);
  if (!Comp) return <div style={{ padding: 24, color: "var(--t3)", fontSize: 13 }}>Unknown tab kind: {kind}</div>;
  return <Comp id={props.api.id} params={params.p ?? {}} active={active} />;
}
const dvComponents = { tab: TabHost };

// ── custom tab header: VS Code-style — PREVIEW tabs render their title in italic ──
function TabHeader(props: IDockviewPanelHeaderProps) {
  const layout = useService(LayoutServiceId);
  // params change in place (preview swaps, in-pane navigation, pin/unpin) — subscribe like TabHost does
  const [params, setParams] = useState(props.params as { kind?: string; p?: { path?: unknown; meetingId?: unknown }; preview?: boolean; pinned?: boolean });
  useEffect(() => {
    const d = props.api.onDidParametersChange((next) => { if (next && Object.keys(next).length) setParams(next as typeof params); });
    return () => d.dispose();
  }, [props.api]);
  const preview = Boolean(params.preview);
  const pinned = Boolean(params.pinned);
  const [title, setTitle] = useState<string>(props.api.title ?? "");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const tabRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const d = props.api.onDidTitleChange((e: { title: string }) => setTitle(e.title));
    return () => d.dispose();
  }, [props.api]);
  useEffect(() => {
    const reveal = () => window.requestAnimationFrame(() => {
      if (props.api.isActive) tabRef.current?.closest(".dv-tab")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    reveal();
    const d = props.api.onDidActiveChange((e) => { if (e.isActive) reveal(); });
    return () => d.dispose();
  }, [props.api]);
  const path = typeof params.p?.path === "string" ? params.p.path : null;
  const meetingId = typeof params.p?.meetingId === "string" ? params.p.meetingId : null;
  const pinItem = pinned
    ? { id: "unpin-tab", label: "Unpin tab", onSelect: () => layout.unpinTab(props.api.id) }
    : { id: "pin-tab", label: "Pin tab", detail: "keep open until unpinned", onSelect: () => layout.pinTab(props.api.id) };
  const copyItems = params.kind === "doc" && path
    ? [
      { id: "copy-reference", label: "Copy reference", detail: `@file:${path}`, onSelect: () => copyText(`@file:${path}`) },
      { id: "copy-path", label: "Copy path", detail: path, onSelect: () => copyText(path) },
    ]
    : params.kind === "meeting" && meetingId
      ? [{ id: "copy-reference", label: "Copy reference", detail: `@meeting:${meetingId}`, onSelect: () => copyText(`@meeting:${meetingId}`) }]
      : [];
  return (
    <div
      ref={tabRef}
      className="dv-default-tab"
      onMouseDown={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        if (!pinned) props.api.close();
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
      style={{ display: "flex", alignItems: "center", height: "100%" }}
    >
      {/* left-click pin toggle: always visible so pinning is one click (pinned = solid accent) */}
      <button type="button" aria-label={pinned ? "Unpin tab" : "Pin tab"}
        title={pinned ? "Pinned — click to unpin" : "Pin tab (keeps it open until unpinned)"}
        className="tab-action-btn"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); if (pinned) layout.unpinTab(props.api.id); else layout.pinTab(props.api.id); }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = pinned ? "1" : "0.45"; }}
        style={{ display: "flex", alignItems: "center", marginRight: 5, cursor: "pointer",
          background: "none", border: "none", padding: 0,
          color: pinned ? "var(--blue)" : "var(--t3)", opacity: pinned ? 1 : 0.45 }}>
        <Icon name="pin" size={11} />
      </button>
      <span className="dv-default-tab-content" style={{ fontStyle: preview ? "italic" : "normal" }}>{title}</span>
      {/* Chrome semantics: a pinned tab has no close affordance until unpinned */}
      {!pinned && (
        <button
          type="button"
          className="dv-default-tab-action tab-action-btn"
          aria-label="Close tab"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); props.api.close(); }}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", padding: 0, cursor: "pointer", color: "inherit" }}
        >
          <Icon name="x" size={10} />
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[pinItem, ...copyItems]} />}
    </div>
  );
}
const dvTabComponents = { default: TabHeader };

// ── LEFT pane (Direction C): capture action, grouped navigation, active list, profile ──
function LeftPane({ onSelect }: { onSelect?: (listId?: string) => void }) {
  const layout = useService(LayoutServiceId);
  const { activeList, leftCollapsed } = useStore(layout.store);
  // re-render on LATE registrations (e.g. the admin surface appears after its async gate check)
  useSyncExternalStore(registry.subscribe, registry.version, registry.version);
  const lists = registry.lists();
  const active = registry.list(activeList) ?? lists[0];
  const Comp = active?.component;
  // "new updates" badge on Knowledge — the shared poll also powers the v2 icon rail.
  const badge = useUpdatesBadge(activeList);
  const workspaceLists = lists.filter((list) => list.id === "meetings" || list.id === "files");
  const toolLists = lists.filter((list) => list.id !== "meetings" && list.id !== "files");
  const renderList = (list: typeof lists[number]) => {
    const selected = list.id === active?.id;
    return (
      <button key={list.id} type="button" aria-current={selected ? "page" : undefined} style={{
        display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 36,
        padding: "0 9px", border: 0, borderRadius: 6, textAlign: "left", cursor: "pointer",
        color: selected ? "var(--t1)" : "var(--t2)", background: selected ? "color-mix(in srgb, var(--t1) 5.5%, transparent)" : "transparent",
        fontSize: "var(--ui-type-label)", fontWeight: selected ? 600 : 400, transition: "background .12s ease, color .12s ease",
      }} onClick={() => {
        layout.setActiveList(list.id);
        if (list.centerTab) layout.openTab(list.centerTab);
        onSelect?.(list.id);
      }} title={list.label}>
        <Icon name={list.icon} size={17} style={{ color: selected ? "var(--accent)" : "var(--t3)" }} />
        <span style={{ flex: 1, minWidth: 0 }}>{list.label}</span>
        {list.id === "files" && badge > 0 && <span title={`${badge} new updates from other members`} style={{
          minWidth: 17, height: 17, display: "inline-grid", placeItems: "center", padding: "0 4px",
          borderRadius: 9, background: "var(--accent)", color: "var(--on-accent)", fontSize: 10, fontWeight: 700,
        }}>{badge}</span>}
      </button>
    );
  };
  const groupLabel: CSSProperties = { padding: "var(--space-2) var(--space-2) var(--space-1)", color: "var(--t3)", fontSize: "var(--ui-type-meta)", fontWeight: 600, letterSpacing: "normal", textTransform: "none" };
  return (
    <div aria-hidden={leftCollapsed || undefined} inert={leftCollapsed}
      style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--sidebar)", borderRight: "1px solid var(--line)", minHeight: 0 }}>
      <div style={{ height: 60, display: "flex", alignItems: "center", gap: 10, padding: "0 18px", flex: "none", borderBottom: "1px solid var(--line)" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/tina-logo.svg" alt="TINA" width={25} height={27} style={{ borderRadius: 7, display: "block", flex: "none" }} />
        <span style={{ fontSize: "var(--ui-type-label)", fontWeight: 600, color: "var(--t1)", letterSpacing: "-0.01em" }}>TINA <span style={{ fontWeight: 400, color: "var(--t3)" }}>terminal</span></span>
      </div>
      <nav aria-label="Workspace sections" style={{ flex: "none", padding: "5px 9px 8px" }}>
        {workspaceLists.length > 0 && <div style={groupLabel}>Workspace</div>}
        <div style={{ display: "grid", gap: 2 }}>{workspaceLists.map(renderList)}</div>
        {toolLists.length > 0 && <div style={{ ...groupLabel, paddingTop: "var(--space-3)" }}>Tools</div>}
        <div style={{ display: "grid", gap: 2 }}>{toolLists.map(renderList)}</div>
      </nav>
      {!leftCollapsed && activeList === "meetings" && <SidebarMeetingCapture />}
      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }} onClickCapture={() => onSelect?.()}>{!leftCollapsed && Comp && <Comp />}</div>
      {!leftCollapsed && <UserProfile />}
    </div>
  );
}

function ProfileAvatar({ image, initials, size = 26 }: { image?: string | null; initials: string; size?: number }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const avatarSource = image && image !== failedSource ? image : null;
  const frame: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    border: "1px solid var(--line)",
    flex: "none",
    overflow: "hidden",
  };

  if (avatarSource) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarSource}
        alt=""
        aria-hidden="true"
        referrerPolicy="no-referrer"
        onError={() => setFailedSource(avatarSource)}
        style={{ ...frame, display: "block", objectFit: "cover" }}
      />
    );
  }

  return (
    <div aria-hidden="true" style={{
      ...frame,
      background: "var(--panel2)",
      color: "var(--t1)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontWeight: 600,
      fontSize: 11,
    }}>
      {initials}
    </div>
  );
}

// ── LEFT pane footer: the signed-in user's profile (replaces the old "Self-hosted · air-gapped" label).
//    Identity comes from /api/auth/me (the tina-user-info cookie). Google accounts show their profile
//    photo when available; initials remain the fallback. Sign-out stays here so it is always reachable.
//    Wiping client state on logout keeps the next user from inheriting this one's tabs/docs/focus.
function UserProfile({ compact = false }: { compact?: boolean }) {
  const layout = useService(LayoutServiceId);
  const palette = useService(PaletteServiceId);
  const [theme, toggleTheme] = useTheme();
  const [user, setUser] = useState<{ email?: string | null; name?: string | null; image?: string | null } | null>(null);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => active && setUser((d?.user as { email?: string; name?: string; image?: string | null } | undefined) ?? null))
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleDown);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleDown);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const email = user?.email ?? "";
  const name = (user?.name || (email ? email.split("@")[0] : "") || "Account").trim();
  const initials = (name.match(/\b[a-z0-9]/gi) || []).slice(0, 2).join("").toUpperCase() || "?";

  const signOut = () => {
    void fetch("/api/auth/logout", { method: "POST" }).finally(() => {
      try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage unavailable */ }
      window.location.reload();
    });
  };

  return (
    <div ref={menuRef} style={{ position: "relative", borderTop: "1px solid var(--line)", flex: "none" }}>
      {open && (
        <div
          role="menu"
          aria-label="User account menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            // compact = the 56px icon rail: the menu has to open BESIDE it, not inside it
            ...(compact ? { left: "calc(100% + 6px)", right: "auto", width: 224 } : { left: 8, right: 8 }),
            background: "var(--panel)",
            border: "1px solid var(--line)",
            borderRadius: 10,
            boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
            padding: 6,
            zIndex: 100,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {/* User info summary */}
          <div style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 9 }}>
            <ProfileAvatar image={user?.image} initials={initials} size={28} />
            <div style={{ minWidth: 0, flex: 1, lineHeight: 1.25 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</div>
              {email && <div style={{ fontSize: 11, color: "var(--t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{email}</div>}
            </div>
          </div>
          <div style={{ height: 1, background: "var(--line)", margin: "4px 0" }} />
          {/* Settings */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              layout.openSettings();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "7px 10px",
              background: "transparent",
              border: "none",
              borderRadius: 6,
              color: "var(--t1)",
              fontSize: 12.5,
              cursor: "pointer",
              textAlign: "left",
              transition: "background .1s ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="gear" size={14} style={{ color: "var(--t2)" }} />
              <span>Settings</span>
            </span>
            <kbd style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--t3)", background: "var(--panel2)", padding: "1px 5px", borderRadius: 4, border: "1px solid var(--line)" }}>⌘,</kbd>
          </button>
          {/* Command palette */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              palette.open();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "7px 10px",
              background: "transparent",
              border: "none",
              borderRadius: 6,
              color: "var(--t1)",
              fontSize: 12.5,
              cursor: "pointer",
              textAlign: "left",
              transition: "background .1s ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name="search" size={14} style={{ color: "var(--t2)" }} />
              <span>Command palette</span>
            </span>
            <kbd style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--t3)", background: "var(--panel2)", padding: "1px 5px", borderRadius: 4, border: "1px solid var(--line)" }}>⌘K</kbd>
          </button>
          {/* Theme toggle */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              toggleTheme();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "7px 10px",
              background: "transparent",
              border: "none",
              borderRadius: 6,
              color: "var(--t1)",
              fontSize: 12.5,
              cursor: "pointer",
              textAlign: "left",
              transition: "background .1s ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Icon name={theme === "light" ? "sun" : "moon"} size={14} style={{ color: "var(--t2)" }} />
              <span>Appearance</span>
            </span>
            <span style={{ fontSize: 11, color: "var(--t3)", textTransform: "capitalize" }}>{theme === "light" ? "Day" : "Dark"}</span>
          </button>
          <div style={{ height: 1, background: "var(--line)", margin: "4px 0" }} />
          {/* Sign out */}
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 10px",
              background: "transparent",
              border: "none",
              borderRadius: 6,
              color: "var(--danger)",
              fontSize: 12.5,
              cursor: "pointer",
              textAlign: "left",
              transition: "background .1s ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "var(--panel2)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
          >
            <Icon name="logout" size={14} style={{ color: "inherit" }} />
            <span>Sign out</span>
          </button>
        </div>
      )}

      {/* Footer trigger button */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        aria-label={compact ? `${name} — account menu` : undefined}
        title={compact ? `${name} — account menu` : undefined}
        style={{
          width: "100%",
          padding: compact ? "8px 0" : "8px 12px",
          background: open ? "var(--panel2)" : "transparent",
          border: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: compact ? "center" : "flex-start",
          gap: compact ? 0 : 9,
          cursor: "pointer",
          textAlign: "left",
          transition: "background .12s ease",
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = "var(--panel2)"; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = "transparent"; }}
      >
        <ProfileAvatar image={user?.image} initials={initials} />
        {!compact && (
          <div style={{ minWidth: 0, flex: 1, lineHeight: 1.25 }}>
            <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--t1)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {name}
            </div>
            {email && (
              <div style={{ fontSize: 11, color: "var(--t3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {email}
              </div>
            )}
          </div>
        )}
        {!compact && (
          <div style={{ color: "var(--t3)", display: "flex", alignItems: "center", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s ease" }}>
            <Icon name="chevD" size={13} />
          </div>
        )}
      </button>
    </div>
  );
}

// ── RIGHT pane: persistent chat singleton ────────────────────────────────────────
function RightPane() {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--rail)", borderLeft: "1px solid var(--line)", minHeight: 0 }}>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Chat />
      </div>
    </div>
  );
}

// ── "new updates" badge (shared by the v1 sidebar and the v2 icon rail) ─────────────────────────────
/** OTHER members' commits across the caller's active workspaces since Knowledge was last opened.
 *  Polled wherever the nav lives so it updates even when the user is elsewhere; opening Knowledge
 *  clears it. A poll failure is additive — it just leaves the badge as-is. */
function useUpdatesBadge(activeList: string): number {
  const badge = useSyncExternalStore(updatesBadge.subscribe, updatesBadge.count, () => 0);
  const newestRef = useRef(0);
  useEffect(() => {
    const poll = async () => {
      if (document.hidden) return;
      try {
        const mounts = (await readActiveSet()).active;
        const gits = await Promise.all(mounts.map((m) => readWorkspaceGit(m.primary ? undefined : { slug: m.slug }).catch(() => null)));
        const member = gits.flatMap((g) => (g ? g.commits : [])).filter((c) => c.kind === "member" && (c.ts ?? 0) > 0);
        newestRef.current = member.reduce((mx, c) => Math.max(mx, c.ts ?? 0), 0);
        updatesBadge.set(member.filter((c) => (c.ts ?? 0) > updatesSeenTs()).length);
      } catch { /* additive — a poll failure just leaves the badge as-is */ }
    };
    void poll();
    const iv = setInterval(() => void poll(), 6000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(iv); window.removeEventListener("focus", onFocus); };
  }, []);
  useEffect(() => { if (activeList === "files") markUpdatesSeen(newestRef.current || Math.floor(Date.now() / 1000)); }, [activeList]);
  return badge;
}

// ── agent-first shell (v2): ICON RAIL · library drawer · CENTER THREAD · right CONTEXT ──────────────

/** The compact icon rail (56px in shell v2, 64px for a collapsed v1 sidebar). It renders the SAME `ListContribution` registry the v1 sidebar did
 *  (contributions/index.ts), so no surface has to change to appear here — the label moves to a
 *  tooltip and the active marker becomes a left pill. Settings (a modal, not a list) and the account
 *  menu sit at the rail foot. */
function IconRail({ width = 56, knowledgeOpen = false, onSectionSelect }: {
  width?: number; knowledgeOpen?: boolean; onSectionSelect?: (listId: string) => void;
}) {
  const layout = useService(LayoutServiceId);
  const { activeList, leftCollapsed } = useStore(layout.store);
  // re-render on LATE registrations (the admin surface appears only after its async gate check)
  useSyncExternalStore(registry.subscribe, registry.version, registry.version);
  const lists = registry.lists();
  const active = registry.list(activeList) ?? lists[0];
  const drawerOpen = !leftCollapsed;
  const badge = useUpdatesBadge(activeList);
  const btn = (on: boolean): CSSProperties => ({
    position: "relative", width: 40, height: 36, display: "flex", alignItems: "center", justifyContent: "center",
    border: "none", borderRadius: 8, background: on ? "var(--panel)" : "transparent",
    color: on ? "var(--t1)" : "var(--t3)", cursor: "pointer", flex: "none",
    transition: "background .12s ease, color .12s ease",
  });
  return (
    <nav aria-label="Sections" style={{ width, flex: "none", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "10px 0 8px", background: "var(--sidebar)", borderRight: "1px solid var(--line)", minHeight: 0 }}>
      <div title="TINA terminal" style={{ height: 30, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/tina-logo.svg" alt="TINA" width={22} height={24} style={{ borderRadius: 7, display: "block" }} />
      </div>
      <div style={{ height: 1, width: 28, background: "var(--line)", margin: "4px 0 6px", flex: "none" }} />
      {lists.map((l) => {
        const on = l.id === active?.id;
        const knowledgeButton = l.id === "files" && !!onSectionSelect;
        const label = knowledgeButton ? (knowledgeOpen ? "Close Knowledge sidebar" : "Open Knowledge sidebar") : l.label;
        return (
          <button key={l.id} type="button" style={btn(on)} title={label} aria-label={label} aria-current={on ? "page" : undefined}
            aria-expanded={knowledgeButton ? knowledgeOpen : undefined}
            onClick={() => {
              layout.setActiveList(l.id);
              if (l.centerTab) layout.openTab(l.centerTab);
              onSectionSelect?.(l.id);
              // A closed icon rail stays compact while changing sections. When the drawer is
              // already open, clicking its active section closes it; other selections keep it open.
              if (!onSectionSelect && on && drawerOpen) layout.toggleLeft();
            }}>
            {on && <span aria-hidden="true" style={{ position: "absolute", left: -8, top: 8, bottom: 8, width: 2, borderRadius: 2, background: "var(--accent)" }} />}
            <Icon name={l.icon} size={17} />
            {l.id === "files" && badge > 0 && (
              <span title={`${badge} new update${badge > 1 ? "s" : ""} from other members`}
                style={{ position: "absolute", top: 3, right: 3, background: "var(--accent)", color: "var(--bg)", fontSize: 9, fontWeight: 700, borderRadius: 8, minWidth: 14, textAlign: "center", padding: "0 4px", lineHeight: "14px", flex: "none" }}>
                {badge}
              </span>
            )}
          </button>
        );
      })}
      <div style={{ flex: 1, minHeight: 0 }} />
      <button type="button" style={btn(false)} title="Settings (⌘,)" aria-label="Settings" onClick={() => layout.openSettings()}>
        <Icon name="gear" size={17} />
      </button>
      <UserProfile compact />
    </nav>
  );
}

/** The library drawer (240px) — the list body the v1 sidebar used to show, nothing more: the section
 *  switcher and the account menu have moved to the rail. It closes with ⌘B / the rail icon / this ✕.
 *  It deliberately does NOT auto-close on row click: several lists own inline ⋯ menus, and a
 *  capture-phase close would unmount them mid-open. */
function ListDrawer({ width = 240, onClose, knowledgeOnly = false }: { width?: number; onClose?: () => void; knowledgeOnly?: boolean } = {}) {
  const layout = useService(LayoutServiceId);
  const { activeList } = useStore(layout.store);
  useSyncExternalStore(registry.subscribe, registry.version, registry.version);
  const active = registry.list(activeList) ?? registry.lists()[0];
  const Comp = active?.component;
  const isKnowledge = knowledgeOnly && activeList === "files";
  return (
    <aside aria-label={isKnowledge ? "Knowledge" : active?.label ?? "Library"} style={{ width, flex: "none", height: "100%", display: "flex", flexDirection: "column", background: "var(--sidebar)", borderRight: "1px solid var(--line)", minHeight: 0 }}>
      {isKnowledge ? <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}><FilesList /></div> : <>
        <div style={{ height: 40, flex: "none", display: "flex", alignItems: "center", gap: 8, padding: "0 6px 0 14px", borderBottom: "1px solid var(--line)" }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--t1)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{active?.label}</span>
          <button type="button" className="panel-toggle-btn" style={{ marginLeft: "auto" }} aria-label={`Close ${active?.label ?? "library"}`} title={`Close ${active?.label ?? "library"} (⌘B)`} onClick={() => onClose ? onClose() : layout.toggleLeft()}>
            <Icon name="x" size={11} />
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>{Comp && <Comp />}</div>
      </>}
    </aside>
  );
}

// ── Panel toggle icons (Direction 4: Meeting Intelligence Waveform) ─────────────
function SidebarLeftIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }} aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
      {open && <rect x="3" y="3" width="6" height="18" rx="1" fill="currentColor" opacity={0.22} stroke="none" />}
    </svg>
  );
}

function AgentRailIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flex: "none" }}
      aria-hidden="true"
    >
      {/* Meeting Intelligence audio wave bars (ılıll) */}
      <line x1="4" y1="10" x2="4" y2="14" opacity={open ? 1 : 0.5} />
      <line x1="8" y1="6" x2="8" y2="18" opacity={open ? 1 : 0.75} />
      <line x1="12" y1="3" x2="12" y2="21" opacity={1} />
      <line x1="16" y1="6" x2="16" y2="18" opacity={open ? 1 : 0.75} />
      <line x1="20" y1="10" x2="20" y2="14" opacity={open ? 1 : 0.5} />
    </svg>
  );
}

// ── the shell ───────────────────────────────────────────────────────────────────
export function Workbench() {
  const layout = useService(LayoutServiceId);
  const keybindings = useService(KeybindingServiceId);
  const { leftCollapsed, rightCollapsed, activeList, activeTab, settingsOpen } = useStore(layout.store);
  // ── responsive tiers — derived from window width, never mutating the user's saved
  //    collapse state (widening the window restores exactly what was there).
  //    full ≥900: three panes · narrow <900: left sidebar hides · single <560 (≈¼ screen):
  //    ONE pane — the center when something is open there (meeting/doc), otherwise chat.
  const [winW, setWinW] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  useEffect(() => {
    const on = () => setWinW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const tier = winW < 560 ? "single" : winW < 900 ? "narrow" : "full";

  // Single-pane state machine on mobile (<560px): exactly one pane visible at a time.
  const [mobileTab, setMobileTab] = useState<"left" | "center" | "right">("center");
  // Narrow tier (560px-899px): left sidebar defaults to collapsed, but user can toggle with ⌘B / button.
  const [narrowLeftOpen, setNarrowLeftOpen] = useState(false);
  const [knowledgePaneOpen, setKnowledgePaneOpen] = useState(false);
  const initialKnowledgeRoute = useRef(activeList === "files");
  const initialKnowledgeRouteHandled = useRef(false);
  const knowledgePaneWidth = Math.max(216, Math.min(300, Math.round(winW * 0.22 - 4)));
  useEffect(() => {
    if (tier !== "full" || !leftCollapsed || activeList !== "files") setKnowledgePaneOpen(false);
  }, [tier, leftCollapsed, activeList]);
  useEffect(() => {
    if (!initialKnowledgeRoute.current || initialKnowledgeRouteHandled.current || tier !== "full" || activeList !== "files") return;
    initialKnowledgeRouteHandled.current = true;
    setKnowledgePaneOpen(true);
    if (!leftCollapsed) layout.toggleLeft();
  }, [tier, activeList, leftCollapsed, layout]);
  const activeMeetingId = activeTab?.kind === "meeting" ? String(activeTab.params.meetingId ?? "") : "";
  const meetingDossierActive = activeMeetingId.length > 0;
  // Agent visibility is global across meeting, README, and other Dockview tabs. Only rightCollapsed
  // (the header toggle / shortcut) controls whether the assistant rail is mounted on desktop.

  // Synchronize ⌘B / ⌘L keyboard shortcuts across responsive tiers
  const prevLeft = useRef(leftCollapsed);
  const prevRight = useRef(rightCollapsed);
  useEffect(() => {
    if (prevLeft.current !== leftCollapsed) {
      if (tier === "single") {
        setMobileTab((cur) => (cur === "left" ? "center" : "left"));
      } else if (tier === "narrow") {
        setNarrowLeftOpen((o) => !o);
      }
    }
    prevLeft.current = leftCollapsed;
  }, [leftCollapsed, tier]);

  useEffect(() => {
    if (prevRight.current !== rightCollapsed) {
      if (tier === "single") {
        setMobileTab((cur) => (cur === "right" ? "center" : "right"));
      }
    }
    prevRight.current = rightCollapsed;
  }, [rightCollapsed, tier]);

  // When active tab changes on mobile, auto-switch to center so newly opened item is visible
  const prevActiveTab = useRef(activeTab);
  useEffect(() => {
    if (tier === "single" && activeTab && activeTab !== prevActiveTab.current) {
      setMobileTab("center");
    }
    prevActiveTab.current = activeTab;
  }, [activeTab, tier]);
  // Meetings-only mode: no agent chat rail at all — 2-pane shell.
  // NOTE: `chatOnly` is now INERT — the Sessions list was retired (createLayoutService migrates any
  // persisted "sessions" → the default), so `activeList` is never "sessions" and the chat-only branch
  // never renders. Kept (rather than ripping out its render sites) to avoid a risky pane refactor the
  // owner didn't ask for; the `=== "sessions"` guards below are dead but harmless.
  const meetOnly = meetingsOnly();
  // ── agent-first shell gate (direction A). The flag is read at RUNTIME from localStorage (workbench/
  //    shell.ts) so it can be flipped on a running build; v2 is a wide-screen layout, so narrow/single
  //    tiers keep the v1 responsive stack, and the meetings-only build never gets a conversation plane.
  const shellV2 = useStore(shellStore) === "v2";
  const v2 = shellV2 && tier === "full" && !meetOnly;
  const chatOnly = !meetOnly && activeList === "sessions";
  useEffect(() => { const d = keybindings.attach(window); return () => d.dispose(); }, [keybindings]);

  // A pending SHARED landing — an accepted invite (`tina.openWorkspace`) or a shared meeting
  // (`tina.openMeeting`), stashed by InviteGate before the reload — must place a tab in the DOCKVIEW. But
  // the default Sessions view is CHAT-ONLY: the dockview isn't mounted, so its onReady (→ resolveFirstView)
  // would never fire and the share would silently land on the session chat instead. Flip OFF chat-only
  // EARLY here (peek only — resolveFirstView consumes the stash) so the grid mounts and the resolver runs.
  useEffect(() => {
    if (meetOnly || layout.store.getState().activeList !== "sessions") return;
    try {
      if (localStorage.getItem("tina.openWorkspace")) layout.setActiveList("files");
      else if (localStorage.getItem("tina.openMeeting")) layout.setActiveList("meetings");
    } catch { /* noop — a locked-down localStorage just means no early reveal */ }
    // once, on mount (a fresh page load after the redeem reload) — deps intentionally empty
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clicking an entity link in chat or a doc opens its doc tab. Reveal the center (leave chat-only →
  // Knowledge view), resolve [[wikilinks]]/relative paths via the shared resolver (slug-aware: the
  // source doc's workspace first, then home, then the rest of the mounted set).
  useEffect(() => {
    const onOpenEntity = async (e: Event) => {
      const detail = (e as CustomEvent<{ path?: string; wikilink?: string; slug?: string; docPath?: string; beside?: boolean }>).detail || {};
      const r = await resolveDocRef(detail, { path: detail.docPath, slug: detail.slug });
      if (!r) return;
      if (layout.store.getState().activeList === "sessions") layout.setActiveList("files");  // reveal the center
      const d = { id: r.slug ? `doc:${r.slug}:${r.path}` : `doc:${r.path}`, title: r.path.split("/").pop() ?? r.path, kind: "doc", params: { path: r.path, slug: r.slug } };
      // beside = clicked inside a doc → split, keep the source visible; otherwise plain tab.
      if (detail.beside) layout.openTabBeside(d); else layout.openTab(d);
    };
    window.addEventListener(OPEN_ENTITY_EVENT, onOpenEntity);
    return () => window.removeEventListener(OPEN_ENTITY_EVENT, onOpenEntity);
  }, [layout]);

  // detach the dockview api on unmount (navigation/HMR dispose it) so the layout
  // service never operates on a disposed grid.
  const apiRef = useRef<DockviewApi | null>(null);
  useEffect(() => () => { if (apiRef.current) layout.detach(apiRef.current); }, [layout]);

  // ── FIRST-VIEW RESOLVER — on landing, pick ONE arrangement by what's SHARED with the user, replacing
  // the scattered self-firing auto-opens (the old tshare effect + the empty-dock live-open + the shared-
  // README pin that only fired once Knowledge was opened). Priority (the product spec):
  //   shared meeting + shared workspace → pin the workspace README, open the meeting (its live badge shows)
  //   shared meeting only               → open the meeting
  //   shared workspace only             → pin the shared workspace README
  //   nothing shared (fresh dock)       → the user's own README-onboarding (or a known live meeting)
  // `fresh` = the dock restored no tabs (a genuine first landing). A returning user with a saved layout
  // gets ONLY the explicit shared-meeting arm (they clicked a share link) — never a surprise re-pin.
  const firstViewDone = useRef(false);
  // The meeting id carried by the URL (`/meetings/<id>`), captured at FIRST RENDER — before any effect
  // (including the URL-sync effect below) can rewrite the address bar. This is the durable reference:
  // a hard reload, a pasted link, or a brand-new session all arrive here.
  const routeMeetingId = useRef<string | null>(
    typeof window === "undefined" ? null : meetingIdFromPath(window.location.pathname),
  );

  // ── URL SYNC — the open meeting is reflected in the address bar, so what's on screen is always
  // referenceable. `replaceState` (not push): in-app navigation keeps its own history (Escape /
  // Alt+Left via layout.goBack), and we never want a stack of dockview states in the browser's.
  // Only the two shapes we own (`/`, `/meetings/<id>`) are ever rewritten; query + hash are preserved
  // so an in-flight ?invite= / ?tshare= round-trip is untouched.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mid = activeTab?.kind === "meeting" ? String((activeTab.params as { meetingId?: unknown })?.meetingId ?? "") : "";
    const cur = window.location.pathname;
    if (!isOwnedPath(cur)) return;
    const next = mid ? meetingPath(mid) : "/";
    if (next === cur) return;
    try { window.history.replaceState(window.history.state, "", next + window.location.search + window.location.hash); }
    catch { /* history unavailable (sandboxed frame) — the in-app path still works */ }
  }, [activeTab]);

  const resolveFirstView = async (fresh: boolean) => {
    // an explicit shared meeting from a ?tshare= link (InviteRedeemer stashed it before the reload)
    let sharedMeetingId: string | null = null;
    try { sharedMeetingId = localStorage.getItem("tina.openMeeting"); if (sharedMeetingId) localStorage.removeItem("tina.openMeeting"); } catch { /* noop */ }
    // a workspace whose invite the user just accepted (InviteRedeemer stashed its id before the reload) —
    // pin its README regardless of a saved dock, so an accepted share always lands on the shared workspace.
    let acceptedSlug: string | null = null;
    try { acceptedSlug = localStorage.getItem("tina.openWorkspace"); if (acceptedSlug) localStorage.removeItem("tina.openWorkspace"); } catch { /* noop */ }
    // a shared workspace connected to this user (a non-primary 'shared' mount in the active set)
    let sharedSlug: string | null = null;
    try {
      const set = await readActiveSet();
      sharedSlug = set.active.find((m) => !m.primary && m.role === "shared")?.slug ?? null;
    } catch { /* active-set read failed — treat as no shared workspace */ }
    if (!apiRef.current) return;  // grid torn down while we awaited — nothing to arrange

    const revealCenter = () => { if (!meetOnly && layout.store.getState().activeList === "sessions") layout.setActiveList("files"); };
    // plain fresh landing → the Meetings day: the Meetings list + the Today tab (its onboarding cards
    // are the first-run hand-off). Replaces the old own-README chat-only onboarding.
    const showDay = () => {
      layout.setActiveList("meetings");
      layout.openTab({ id: "today", title: "Today", kind: "today", params: {} });
    };
    const openMeeting = (mid: string, reveal: boolean) => {
      if (reveal && !meetOnly) layout.setActiveList("meetings");
      // A meeting reached by URL is just "Meeting" until the row resolves; one reached by a share link
      // is labelled as such. Either way the tab id is the same, so it de-dupes with a restored tab.
      const title = mid === routeMeetingId.current && !sharedMeetingId ? "Meeting" : "Shared meeting";
      layout.openTab({ id: `meeting:${mid}`, title, kind: "meeting", params: { meetingId: mid } });
    };
    // `forceKnowledge` = land ON the Knowledge section unconditionally (an accepted invite is explicit —
    // the shared workspace's tree must show, even for a returning user whose saved rail was Meetings/etc).
    // Otherwise just reveal the center out of chat-only (sessions → files).
    const pinReadme = (slug?: string, forceKnowledge = false) => {
      if (forceKnowledge && !meetOnly) layout.setActiveList("files"); else revealCenter();
      // coordinate with MountSection's once-per-session pin (workspace.tsx) so it doesn't double-pin later
      if (slug) { try { sessionStorage.setItem(`tina.readme.pinned.${slug}`, "1"); } catch { /* noop */ } }
      layout.openTab({ id: slug ? `doc:${slug}:README.md` : "doc:README.md", title: "README.md", kind: "doc", params: { path: "README.md", slug } });
    };

    const plan = firstViewPlan({ sharedMeetingId, routeMeetingId: routeMeetingId.current, acceptedSlug, sharedSlug, liveMeetingId: liveMeetingsNow()[0]?.id ?? null, fresh });
    switch (plan.kind) {
      case "meeting-and-workspace": openMeeting(plan.meetingId, false); pinReadme(plan.slug, !!acceptedSlug); break;  // README pinned last → focused
      case "meeting":               openMeeting(plan.meetingId, true); break;
      case "workspace-readme":      pinReadme(plan.slug, !!acceptedSlug); break;  // accepted invite → force Knowledge open
      case "live-meeting":          openMeeting(plan.meetingId, true); break;
      case "own-day":               showDay(); break;
      case "noop":                  break;
    }
    // Direction A (agent chat first): the conversation is the PRIMARY plane, so v2 lands on the THREAD
    // with the record tabs the plan just opened sitting beside it in the tab strip (opened last →
    // focused last). `openTab` de-dupes by id, so a restored dock that already has the thread just
    // focuses it. `v2` already excludes meetings-only.
    if (v2) layout.openTab({ id: "thread", title: "Conversation", kind: THREAD_TAB_KIND, params: {} });
  };

  const onReady = (e: DockviewReadyEvent) => {
    apiRef.current = e.api;
    layout.attach(e.api);
    // Older saved layouts may still contain the former persistent Settings tab.
    for (const panel of [...e.api.panels]) {
      if (panel.id === "settings" || (panel.params as { kind?: string } | undefined)?.kind === "settings") panel.api.close();
    }
    if (firstViewDone.current) return;             // once per app load (guards remounts / HMR)
    firstViewDone.current = true;
    void resolveFirstView(e.api.panels.length === 0);
  };
  const resetLayout = () => {
    try { localStorage.removeItem(PANES_KEY); localStorage.removeItem(SHELL_PANES_KEY); } catch {}
    layout.resetLayout();
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--t1)" }}>
      {(() => {
        const isLeftActive = tier === "single" ? mobileTab === "left" : (tier === "narrow" ? narrowLeftOpen : (!leftCollapsed || knowledgePaneOpen));
        const isRightActive = tier === "single" ? mobileTab === "right" : !rightCollapsed;
        const leftLabel = tier === "single"
          ? (mobileTab === "left" ? "Back to content (⌘B)" : "Open navigation (⌘B)")
          : v2
            ? (isLeftActive ? "Close library (⌘B)" : "Open library (⌘B)")
          : tier === "narrow"
            ? (narrowLeftOpen ? "Close navigation (⌘B)" : "Open navigation (⌘B)")
            : knowledgePaneOpen
              ? "Close Knowledge sidebar (⌘B)"
              : (leftCollapsed ? "Expand sidebar (⌘B)" : "Collapse sidebar (⌘B)");
        return (
          <div style={{ height: 38, display: "flex", alignItems: "center", gap: 12, padding: "0 12px", borderBottom: "1px solid var(--line)", background: "var(--sidebar)", flex: "none" }}>
            <button
              type="button"
              className="panel-toggle-btn shell-topbar-toggle"
              aria-pressed={isLeftActive}
              aria-label={leftLabel}
              title={leftLabel}
              onClick={() => {
                if (tier === "single") {
                  setMobileTab((cur) => (cur === "left" ? "center" : "left"));
                } else if (tier === "narrow") {
                  setNarrowLeftOpen((o) => !o);
                } else if (knowledgePaneOpen) {
                  setKnowledgePaneOpen(false);
                } else if (tier === "full" && activeList === "files") {
                  setKnowledgePaneOpen(true);
                  if (!leftCollapsed) layout.toggleLeft();
                } else {
                  layout.toggleLeft();
                }
              }}
            >
              <SidebarLeftIcon open={isLeftActive} />
            </button>
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, minWidth: 0 }}>
              {tier === "single" && mobileTab === "left" ? (
                <span className="shell-context-label">Navigation</span>
              ) : tier === "single" && mobileTab === "right" ? (
                <span className="shell-context-label">TINA Agent</span>
              ) : (
                <span className="shell-context-label">
                  TINA Terminal <span className="shell-context-separator">/</span> Workspace
                </span>
              )}
              <OpsNotice />
            </div>
            {!meetOnly && (
              <button
                type="button"
                className="panel-toggle-btn shell-topbar-toggle"
                aria-pressed={isRightActive}
                aria-label={
                  tier === "single"
                    ? (mobileTab === "right" ? "Back to content (⌘J / ⌘L)" : "Open TINA Agent (⌘J / ⌘L)")
                    : (isRightActive ? "Collapse TINA Agent (⌘J / ⌘L)" : "Open TINA Agent (⌘J / ⌘L)")
                }
                title={
                  tier === "single"
                    ? (mobileTab === "right" ? "Back to content (⌘J / ⌘L)" : "Open TINA Agent (⌘J / ⌘L)")
                    : (isRightActive ? "Collapse TINA Agent (⌘J / ⌘L)" : "Open TINA Agent (⌘J / ⌘L)")
                }
                onClick={() => {
                  if (tier === "single") {
                    setMobileTab((cur) => (cur === "right" ? "center" : "right"));
                  } else {
                    layout.toggleRight();
                  }
                }}
              >
                <AgentRailIcon open={isRightActive} />
              </button>
            )}
            <button type="button" className="panel-toggle-btn shell-topbar-toggle"
              aria-label="Reset layout" title="Reset layout" onClick={resetLayout}>
              <Icon name="rotateCcw" size={16} />
            </button>
          </div>
        );
      })()}

      <div style={{ flex: 1, minHeight: 0 }}>
        {v2 ? (
          /* ── agent-first shell (v2): ICON RAIL · library drawer · CENTER THREAD · right CONTEXT ──
             Only the CHROME around the dockview changes: the same onReady/resolveFirstView/dvComponents
             run, and the rail + drawer render the same ListContribution registry the v1 sidebar did. */
          <div style={{ height: "100%", display: "flex", minHeight: 0 }}>
            <IconRail knowledgeOpen={knowledgePaneOpen} onSectionSelect={(id) => {
              if (id === "files") {
                setKnowledgePaneOpen((open) => !open);
                if (!knowledgePaneOpen && !leftCollapsed) layout.toggleLeft();
              } else {
                setKnowledgePaneOpen(false);
                if (!leftCollapsed && id === activeList) layout.toggleLeft();
              }
            }} />
            {knowledgePaneOpen && activeList === "files" ? (
              <ListDrawer width={knowledgePaneWidth} knowledgeOnly onClose={() => setKnowledgePaneOpen(false)} />
            ) : !leftCollapsed && <ListDrawer />}
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
              <Allotment
                proportionalLayout={false}
                key="shell-v2"
                onChange={(s) => { if (!rightCollapsed && !meetingDossierActive && s.length === 2) persistShellSizes(s); }}
                defaultSizes={savedShellSizes() ?? [800, 340]}
              >
                <Allotment.Pane priority={LayoutPriority.High} minSize={360}>
                  <div style={{ height: "100%", position: "relative" }}>
                    <div style={{ position: "absolute", inset: 0 }}>
                      <DockviewReact onReady={onReady} components={dvComponents} tabComponents={dvTabComponents} defaultTabComponent={TabHeader} theme={themeAbyss} />
                    </div>
                  </div>
                </Allotment.Pane>
                {!rightCollapsed && (
                  <Allotment.Pane priority={LayoutPriority.Low} minSize={260} maxSize={420} preferredSize={340}>
                    <ContextRail />
                  </Allotment.Pane>
                )}
              </Allotment>
            </div>
          </div>
        ) : (
        <>
        {/* chat-only (Sessions) gets its own sizes — the freed center space goes to the CHAT (right), with a
            narrow left sidebar; full mode keeps the user's saved 3-pane sizes. The `key` re-lays-out on switch. */}
        {(() => {
          // single-pane resolution: mobileTab dictates which pane is visible on mobile (<560px)
          const showLeft = tier === "single"
            ? mobileTab === "left"
            : (tier === "narrow" ? narrowLeftOpen : !leftCollapsed);
          const showCenter = tier === "single"
            ? mobileTab === "center"
            : !chatOnly;
          const showRight = !meetOnly && (tier === "single"
            ? mobileTab === "right"
            : (chatOnly || !rightCollapsed));
          return (
            <div style={{ height: "100%", display: "flex", minWidth: 0, minHeight: 0 }}>
              {tier === "full" && leftCollapsed && <IconRail width={64}
                knowledgeOpen={knowledgePaneOpen}
                onSectionSelect={(id) => setKnowledgePaneOpen(id === "files" ? (isOpen) => !isOpen : false)} />}
              {tier === "full" && leftCollapsed && knowledgePaneOpen && activeList === "files" && (
                <ListDrawer width={knowledgePaneWidth} knowledgeOnly onClose={() => setKnowledgePaneOpen(false)} />
              )}
              <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                <Allotment
                  proportionalLayout={false}
                  key={`${chatOnly ? "chat-only" : "full"}-${tier}`}
                  onChange={(s) => {
                    // Only save user-dragged widths when all 3 panes are open, avoiding saving distorted 2-pane states
                    if (!chatOnly && !meetingDossierActive && tier === "full" && showLeft && showRight && s.length === 3) {
                      persistSizes(s);
                    }
                  }}
                  defaultSizes={chatOnly ? [282, 800] : (savedSizes() ?? [282, 800, 320])}
                >
              <Allotment.Pane
                visible={showLeft}
                priority={LayoutPriority.Low}
                minSize={tier === "single" ? 100 : 180}
                maxSize={tier === "single" ? undefined : 360}
                preferredSize={282}
              >
                <LeftPane onSelect={(listId) => {
                  if (tier === "single") setMobileTab("center");
                  if (tier === "full" && listId === "files") {
                    setKnowledgePaneOpen(true);
                    layout.toggleLeft();
                  } else if (listId) setKnowledgePaneOpen(false);
                }} />
              </Allotment.Pane>
              {!chatOnly && (
                <Allotment.Pane
                  visible={showCenter}
                  priority={LayoutPriority.High}
                  minSize={tier === "full" ? 360 : (tier === "single" ? 100 : 200)}
                >
                  <div style={{ height: "100%", position: "relative" }}>
                    <div style={{ position: "absolute", inset: 0 }}>
                      <DockviewReact onReady={onReady} components={dvComponents} tabComponents={dvTabComponents} defaultTabComponent={TabHeader} theme={themeAbyss} />
                    </div>
                  </div>
                </Allotment.Pane>
              )}
              {/* meetings-only: the chat rail never MOUNTS (not merely hidden) — no agent fetches fire */}
              {!meetOnly && (
                <Allotment.Pane
                  visible={showRight}
                  priority={LayoutPriority.Low}
                  minSize={tier === "full" ? 260 : (tier === "single" ? 100 : 200)}
                  maxSize={tier === "full" ? 480 : undefined}
                  preferredSize={320}
                >
                  <RightPane />
                </Allotment.Pane>
              )}
                </Allotment>
              </div>
            </div>
          );
        })()}
        </>
        )}
      </div>

      <CommandPalette />
      {settingsOpen && <SettingsDialog onClose={layout.closeSettings} />}
    </div>
  );
}
