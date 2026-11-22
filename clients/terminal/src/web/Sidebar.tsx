"use client";
import { WebAvatar } from "./Avatar";
import { WebIcon, type WebIconName } from "./Icons";
import type { WebUser } from "./useWebIdentity";

export type WebNavView = "home" | "ask" | "meetings" | "meeting" | "tasks" | "routines" | "settings";

export function WebSidebar({
  active,
  user,
  collapsed,
  mobileOpen,
  liveCount,
  meetingsOnly,
  canOpenTerminal,
  terminalHref,
  onToggleCollapse,
  onNavigate,
  onUserMenuToggle,
  onCloseMobile,
}: {
  active: WebNavView;
  user: WebUser;
  collapsed: boolean;
  mobileOpen: boolean;
  liveCount: number;
  meetingsOnly: boolean;
  canOpenTerminal: boolean;
  terminalHref: string;
  onToggleCollapse: () => void;
  onNavigate: (view: Exclude<WebNavView, "meeting">) => void;
  onUserMenuToggle: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onCloseMobile: () => void;
}) {
  const navBtn = (
    id: Exclude<WebNavView, "meeting">,
    icon: WebIconName,
    label: string,
    opts?: { ask?: boolean; badge?: number },
  ) => {
    const isActive = active === id || (id === "meetings" && active === "meeting");
    return (
      <button
        key={id}
        type="button"
        className={`tina-web-nav-item ${isActive ? "active" : ""} ${opts?.ask ? "ask" : ""}`}
        aria-label={label}
        aria-current={isActive ? "page" : undefined}
        title={collapsed ? label : undefined}
        onClick={() => {
          onNavigate(id);
          onCloseMobile();
        }}
      >
        <WebIcon name={icon} size={16} />
        <span className="tina-web-nav-label">{label}</span>
        {opts?.badge ? <span className="tina-web-nav-badge">{opts.badge}</span> : null}
      </button>
    );
  };

  return (
    <aside className={`tina-web-sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}`}>
      <div className="tina-web-sidebar-head">
        <button
          type="button"
          className="tina-web-user-btn"
          aria-label={collapsed ? "Expand sidebar" : "Workspace account"}
          title={collapsed ? "Expand sidebar" : user.email || user.name}
          onClick={collapsed ? onToggleCollapse : onUserMenuToggle}
        >
          <WebAvatar name={user.name} image={user.image} size={20} />
          <span className="tina-web-user-name">{user.firstName}</span>
          <WebIcon name="chevronDown" size={14} className="tina-web-user-chevron" />
        </button>

        <button
          type="button"
          className="tina-web-collapse-btn"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={onToggleCollapse}
        >
          <WebIcon name="sidebar" size={16} strokeWidth={1.5} />
        </button>
      </div>

      <nav className="tina-web-nav" aria-label="Primary navigation">
        {navBtn("home", "home", "Home")}
        {!meetingsOnly && navBtn("ask", "tinaAsk", "Ask Tina", { ask: true })}

        <span className="tina-web-nav-gap" />

        {navBtn("meetings", "video", "Meetings", { badge: liveCount > 0 ? liveCount : undefined })}
        {!meetingsOnly && navBtn("tasks", "tasks", "Tasks")}
        {!meetingsOnly && navBtn("routines", "skills", "Routines")}
      </nav>

      <div className="tina-web-spacer" />

      <div className="tina-web-nav tina-web-nav-bottom">
        {canOpenTerminal && (
          <a
            href={terminalHref}
            className="tina-web-dev-link"
            title="Switch to TINA Terminal (Dev Workbench)"
            aria-label="Open TINA Terminal"
          >
            <WebIcon name="terminal" size={15} />
            <span className="tina-web-nav-label">TINA Terminal</span>
          </a>
        )}
        {navBtn("settings", "settings", "Settings")}
      </div>
    </aside>
  );
}
