"use client";
/** SettingsView — Production Personal / Team Settings Hub with URL query sync
 *  (`?nav=settings&settingsWorkspace=personal|team&settingsSection=<id>`).
 *  100% wired to real TINA APIs & panels — zero mock toggles or placeholder billing controls. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { hideModelSettings as hideModelSettingsEnv } from "../app/mode";
import { applyTheme, useTheme, type Theme } from "../app/theme";
import { CalendarConnectionsPanel } from "../surfaces/calendarConnections";
import { VoiceSettings } from "../surfaces/voiceSettings";
import { AsrStatusPanel } from "../surfaces/asrStatus";
import { GitHubTokenCard, TokensPanel } from "../surfaces/tokens";
import { WebAvatar } from "./Avatar";
import { WebIcon, type WebIconName } from "./Icons";
import { SharedWorkspacesPanel } from "./SharedWorkspacesPanel";
import { EmailNotificationsCard } from "./EmailNotificationsCard";
import { WebModelsPanel } from "./WebModelsPanel";
import type { WebUser } from "./useWebIdentity";

export type SettingsWorkspace = "personal" | "team";
export type SettingsSectionId =
  | "calendar"
  | "models"
  | "voice"
  | "tokens"
  | "github"
  | "appearance"
  | "account"
  | "workspaces"
  | "global-models"
  | "asr-status";

interface SectionDef {
  id: SettingsSectionId;
  workspace: SettingsWorkspace;
  group: string;
  label: string;
  description: string;
  icon: WebIconName;
  keywords: string;
  adminOnly?: boolean;
  modelSettings?: boolean;
}

const SECTIONS: readonly SectionDef[] = [
  // Personal workspace — ordered for everyday users first, developer tools neatly at the bottom
  {
    id: "account",
    workspace: "personal",
    group: "Profile",
    label: "Account",
    description: "View your profile, email notifications, access, and sign-in options.",
    icon: "user",
    keywords: "account profile user email notifications summary minutes rsvp sign out logout terminal admin",
  },
  {
    id: "calendar",
    workspace: "personal",
    group: "Meetings",
    label: "Calendar & Auto-join",
    description: "Connect Google or Outlook to see upcoming meetings. Enable Auto-join for the calendars where you want TINA to join.",
    icon: "calendar",
    keywords: "calendar google microsoft outlook schedule auto join meeting recording",
  },
  {
    id: "models",
    workspace: "personal",
    group: "AI & Voice",
    label: "AI Models & Transcription",
    description: "Choose which AI powers your chats, meeting summaries, and speech-to-text transcription.",
    icon: "cpu",
    keywords: "models llm claude openai chatgpt gemini deepseek groq bedrock transcription stt asr viegem",
    modelSettings: true,
  },
  {
    id: "voice",
    workspace: "personal",
    group: "AI & Voice",
    label: "Voice Assistant",
    description: "Choose the voice TINA uses when speaking in your meetings and preview how it sounds.",
    icon: "mic",
    keywords: "voice assistant speaker audio speech tts preview preset",
  },
  {
    id: "appearance",
    workspace: "personal",
    group: "Preferences",
    label: "Appearance",
    description: "Switch between Obsidian Dark and Paper Light themes across your workspace.",
    icon: "sun",
    keywords: "appearance theme dark light mode color interface display",
  },
  {
    id: "github",
    workspace: "personal",
    group: "Developer & Connections",
    label: "GitHub",
    description: "Connect a GitHub token to back up and sync Knowledge spaces with your repositories.",
    icon: "github",
    keywords: "github git pat token repository sync push pull",
  },
  {
    id: "tokens",
    workspace: "personal",
    group: "Developer & Connections",
    label: "API Tokens & MCP",
    description: "Create and revoke personal access tokens for MCP clients, CLI tools, and scripts.",
    icon: "key",
    keywords: "api tokens mcp cli keys authentication secret",
  },
  // Team workspace
  {
    id: "workspaces",
    workspace: "team",
    group: "Team Workspace",
    label: "Workspaces & Members",
    description: "Create shared spaces, manage team access, and invite collaborators with a link.",
    icon: "users",
    keywords: "team shared workspace members invite link collaboration permissions role",
  },
  {
    id: "global-models",
    workspace: "team",
    group: "Deployment Admin",
    label: "Global Defaults",
    description: "Set organization-wide default AI models and speech-to-text settings.",
    icon: "globe",
    keywords: "global admin default models transcription deployment funasr sherpa viegem apple nvidia",
    adminOnly: true,
    modelSettings: true,
  },
  {
    id: "asr-status",
    workspace: "team",
    group: "Deployment Admin",
    label: "ASR Workers",
    description: "Inspect live speech-recognition worker health, queue depth, and latency telemetry.",
    icon: "shield",
    keywords: "asr status workers diagnostics latency queue telemetry health speech recognition",
    adminOnly: true,
  },
];

const DEFAULT_USER: WebUser = {
  name: "Account",
  firstName: "Account",
  email: "",
  image: null,
};

function defaultSectionFor(workspace: SettingsWorkspace): SettingsSectionId {
  return workspace === "team" ? "workspaces" : "account";
}

function isSectionAvailable(s: SectionDef, isAdmin: boolean, hideModels: boolean): boolean {
  if (s.adminOnly && !isAdmin) return false;
  if (s.modelSettings && hideModels) return false;
  return true;
}

function readSettingsRouteFromUrl(
  isAdmin: boolean,
  hideModels: boolean,
): { workspace: SettingsWorkspace; section: SettingsSectionId } {
  if (typeof window === "undefined") {
    return { workspace: "personal", section: defaultSectionFor("personal") };
  }
  const params = new URLSearchParams(window.location.search);
  const rawWs = params.get("settingsWorkspace");
  const rawSec = params.get("settingsSection");

  const matchedSec = SECTIONS.find((s) => s.id === rawSec && isSectionAvailable(s, isAdmin, hideModels));
  if (matchedSec) {
    return { workspace: matchedSec.workspace, section: matchedSec.id };
  }
  const workspace: SettingsWorkspace = rawWs === "team" ? "team" : "personal";
  return { workspace, section: defaultSectionFor(workspace) };
}

function syncSettingsUrl(workspace: SettingsWorkspace, section: SettingsSectionId) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.pathname !== "/") return;
  url.searchParams.set("nav", "settings");
  url.searchParams.set("settingsWorkspace", workspace);
  url.searchParams.set("settingsSection", section);
  const next = `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
    try {
      window.history.replaceState(window.history.state, "", next);
    } catch {
      /* ignore sandboxed history */
    }
  }
}

export function SettingsView({
  user = DEFAULT_USER,
  isAdmin = false,
  canOpenTerminal = false,
  hideModelSettings = hideModelSettingsEnv(),
  terminalHref = "/terminal",
  onSignOut,
}: {
  user?: WebUser;
  isAdmin?: boolean;
  canOpenTerminal?: boolean;
  hideModelSettings?: boolean;
  terminalHref?: string;
  onSignOut?: () => void;
} = {}) {
  const pendingAdminSectionRef = useRef<SettingsSectionId | null>(
    typeof window !== "undefined" && !isAdmin
      ? (SECTIONS.find(
          (s) =>
            s.id === new URLSearchParams(window.location.search).get("settingsSection") &&
            s.adminOnly &&
            !(hideModelSettings && s.modelSettings),
        )?.id ?? null)
      : null,
  );
  const initial = useMemo(() => readSettingsRouteFromUrl(isAdmin, hideModelSettings), [isAdmin, hideModelSettings]);
  const [workspace, setWorkspace] = useState<SettingsWorkspace>(initial.workspace);
  const [section, setSection] = useState<SettingsSectionId>(initial.section);
  const [search, setSearch] = useState("");
  const [theme, toggleTheme] = useTheme();

  // If the URL requested an admin section before `isAdmin` resolved, honor it once `isAdmin` flips true.
  useEffect(() => {
    if (!isAdmin || !pendingAdminSectionRef.current) return;
    const pendingId = pendingAdminSectionRef.current;
    pendingAdminSectionRef.current = null;
    const adminMatch = SECTIONS.find(
      (s) => s.id === pendingId && s.adminOnly && !(hideModelSettings && s.modelSettings),
    );
    if (adminMatch) {
      setWorkspace(adminMatch.workspace);
      setSection(adminMatch.id);
    }
  }, [isAdmin, hideModelSettings]);

  // If a runtime feature flag hides model settings after initial render, move away cleanly.
  useEffect(() => {
    if (!hideModelSettings) return;
    const currentDef = SECTIONS.find((s) => s.id === section);
    if (currentDef?.modelSettings) {
      setSection(defaultSectionFor(workspace));
    }
  }, [hideModelSettings, section, workspace]);

  useEffect(() => {
    if (pendingAdminSectionRef.current) return;
    syncSettingsUrl(workspace, section);
  }, [workspace, section]);

  useEffect(() => {
    const onPopState = () => {
      pendingAdminSectionRef.current = null;
      const next = readSettingsRouteFromUrl(isAdmin, hideModelSettings);
      setWorkspace(next.workspace);
      setSection(next.section);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isAdmin, hideModelSettings]);

  const availableSections = useMemo(
    () => SECTIONS.filter((item) => isSectionAvailable(item, isAdmin, hideModelSettings)),
    [isAdmin, hideModelSettings],
  );

  const selectWorkspace = useCallback(
    (nextWs: SettingsWorkspace) => {
      pendingAdminSectionRef.current = null;
      setWorkspace(nextWs);
      setSearch("");
      setSection((cur) => {
        const curDef = availableSections.find((s) => s.id === cur);
        if (curDef && curDef.workspace === nextWs) return cur;
        return defaultSectionFor(nextWs);
      });
    },
    [availableSections],
  );

  const selectSection = useCallback((next: SectionDef) => {
    pendingAdminSectionRef.current = null;
    setWorkspace(next.workspace);
    setSection(next.id);
    setSearch("");
  }, []);

  const query = search.trim().toLowerCase();

  const visibleSections = useMemo(() => {
    if (query) {
      return availableSections.filter((item) =>
        `${item.label} ${item.group} ${item.description} ${item.keywords} ${item.workspace}`
          .toLowerCase()
          .includes(query),
      );
    }
    return availableSections.filter((item) => item.workspace === workspace);
  }, [availableSections, query, workspace]);

  const groupedSections = useMemo(() => {
    const groups: Array<{ label: string; items: SectionDef[] }> = [];
    for (const item of visibleSections) {
      const existing = groups.find((g) => g.label === item.group);
      if (existing) existing.items.push(item);
      else groups.push({ label: item.group, items: [item] });
    }
    return groups;
  }, [visibleSections]);

  const activeDef =
    availableSections.find((s) => s.id === section) ??
    availableSections.find((s) => s.workspace === workspace) ??
    availableSections[0];

  const handleSearchChange = (value: string) => {
    setSearch(value);
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return;
    const match = availableSections.find((item) =>
      `${item.label} ${item.group} ${item.description} ${item.keywords} ${item.workspace}`
        .toLowerCase()
        .includes(trimmed),
    );
    if (match) {
      setWorkspace(match.workspace);
      setSection(match.id);
    }
  };

  const setThemeDirect = (nextTheme: Theme) => {
    if (theme !== nextTheme) {
      toggleTheme();
    } else {
      applyTheme(nextTheme);
    }
  };

  const renderSectionBody = (id: SettingsSectionId): ReactNode => {
    switch (id) {
      case "calendar":
        return (
          <div className="tina-web-settings-card tina-web-settings-embed">
            <CalendarConnectionsPanel />
          </div>
        );
      case "models":
        return <WebModelsPanel key="personal-models" scopeMode="personal" />;
      case "voice":
        return (
          <div className="tina-web-settings-stack">
            <VoiceSettings voiceOnly hideModelHint={hideModelSettings} />
          </div>
        );
      case "tokens":
        return (
          <div className="tina-web-settings-card tina-web-settings-embed">
            <TokensPanel />
          </div>
        );
      case "github":
        return (
          <div className="tina-web-settings-card tina-web-settings-embed">
            <GitHubTokenCard />
          </div>
        );
      case "appearance":
        return (
          <div className="tina-web-settings-stack">
            <section className="tina-web-settings-card">
              <div className="tina-web-settings-card-head">
                <div>
                  <h3>Color theme</h3>
                  <p>Applies immediately across the TINA Production app and TINA Terminal.</p>
                </div>
              </div>
              <div className="tina-web-theme-grid" role="radiogroup" aria-label="Color theme">
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === "dark"}
                  className={`tina-web-theme-option ${theme === "dark" ? "selected" : ""}`}
                  onClick={() => setThemeDirect("dark")}
                >
                  <span className="tina-web-theme-preview dark" aria-hidden="true">
                    <span className="tina-web-theme-bar" />
                    <span className="tina-web-theme-dot" />
                  </span>
                  <span className="tina-web-theme-copy">
                    <strong>
                      <WebIcon name="moon" size={14} /> Obsidian Dark
                    </strong>
                    <span>Low-glare charcoal surfaces with Tina Teal &amp; Quiet Mint accents.</span>
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={theme === "light"}
                  className={`tina-web-theme-option ${theme === "light" ? "selected" : ""}`}
                  onClick={() => setThemeDirect("light")}
                >
                  <span className="tina-web-theme-preview light" aria-hidden="true">
                    <span className="tina-web-theme-bar" />
                    <span className="tina-web-theme-dot" />
                  </span>
                  <span className="tina-web-theme-copy">
                    <strong>
                      <WebIcon name="sun" size={14} /> Paper Light
                    </strong>
                    <span>Crisp daylight canvas with high-contrast charcoal ink and deep teal highlights.</span>
                  </span>
                </button>
              </div>
            </section>
          </div>
        );
      case "account":
        return (
          <div className="tina-web-settings-stack">
            <section className="tina-web-settings-card tina-web-account-profile" aria-label="Profile">
              <div className="tina-web-account-identity">
                <WebAvatar name={user.name} image={user.image} size={64} />
                <h2>{user.name}</h2>
              </div>
              <dl className="tina-web-account-details">
                <div>
                  <dt>Email address</dt>
                  <dd>{user.email || "Unavailable"}</dd>
                </div>
                <div>
                  <dt>Workspace role</dt>
                  <dd>
                    <span className={`tina-web-status-pill ${isAdmin ? "live" : "completed"}`}>
                      {isAdmin ? "Administrator" : "Member"}
                    </span>
                  </dd>
                </div>
              </dl>
            </section>
            <EmailNotificationsCard email={user.email} />
            {(canOpenTerminal || onSignOut) && (
              <section className="tina-web-settings-card tina-web-account-session" aria-labelledby="account-session-heading">
                <h2 id="account-session-heading">Access and session</h2>
                {canOpenTerminal && (
                  <div className="tina-web-account-action">
                    <div>
                      <h3>TINA Terminal</h3>
                      <p>Open the workbench to manage your meetings and workspace.</p>
                    </div>
                    <a href={terminalHref} className="tina-web-btn-ghost">
                      <WebIcon name="terminal" size={14} />
                      <span>Open TINA Terminal</span>
                    </a>
                  </div>
                )}
                {onSignOut && (
                  <div className="tina-web-account-action">
                    <div>
                      <h3>Browser session</h3>
                      <p>Sign out of TINA in this browser.</p>
                    </div>
                    <button
                      type="button"
                      className="tina-web-btn-ghost tina-web-account-logout"
                      onClick={onSignOut}
                    >
                      <WebIcon name="logout" size={14} />
                      <span>Log out</span>
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>
        );
      case "workspaces":
        return <SharedWorkspacesPanel />;
      case "global-models":
        return <WebModelsPanel key="global-defaults" scopeMode="global" />;
      case "asr-status":
        return (
          <div className="tina-web-settings-card tina-web-settings-embed">
            <AsrStatusPanel />
          </div>
        );
    }
  };

  return (
    <div className="tina-web-settings-shell tina-web-embedded-surface">
      <aside className="tina-web-settings-rail" aria-label="Settings navigation">
        <div className="tina-web-settings-rail-head">
          <h2>Settings</h2>
          <div className="tina-web-ws-switcher" role="tablist" aria-label="Settings workspace scope">
            <button
              type="button"
              role="tab"
              aria-selected={workspace === "personal"}
              className={`tina-web-ws-tab ${workspace === "personal" ? "active" : ""}`}
              onClick={() => selectWorkspace("personal")}
            >
              <WebIcon name="user" size={13} />
              <span>Personal</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={workspace === "team"}
              className={`tina-web-ws-tab ${workspace === "team" ? "active" : ""}`}
              onClick={() => selectWorkspace("team")}
            >
              <WebIcon name="users" size={13} />
              <span>Team</span>
            </button>
          </div>
          <label className="tina-web-settings-search">
            <WebIcon name="search" size={14} />
            <input
              type="search"
              aria-label="Search settings"
              placeholder="Search settings…"
              value={search}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </label>
        </div>

        <nav className="tina-web-settings-nav" aria-label="Settings sections">
          {groupedSections.map((group) => (
            <div key={group.label} className="tina-web-settings-group">
              <div className="tina-web-settings-group-title">{group.label}</div>
              {group.items.map((item) => {
                const active = activeDef.id === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={active ? "page" : undefined}
                    className={`tina-web-settings-item ${active ? "active" : ""}`}
                    onClick={() => selectSection(item)}
                  >
                    <WebIcon name={item.icon} size={15} />
                    <span>{item.label}</span>
                    {item.adminOnly && <span className="tina-web-admin-chip">Admin</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {groupedSections.length === 0 && (
            <div role="status" className="tina-web-muted-note" style={{ padding: "8px 10px" }}>
              No matching settings
            </div>
          )}
        </nav>
      </aside>

      <section className="tina-web-settings-main" aria-label={activeDef.label}>
        <div className="tina-web-settings-content">
          <header className="tina-web-settings-header">
            <div className="tina-web-settings-crumb">
              <span>{activeDef.workspace === "team" ? "Team Settings" : "Personal Settings"}</span>
              <span>/</span>
              <span>{activeDef.group}</span>
            </div>
            <h1>{activeDef.label}</h1>
            <p>{activeDef.description}</p>
          </header>
          {renderSectionBody(activeDef.id)}
        </div>
      </section>
    </div>
  );
}
