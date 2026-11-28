"use client";
/** WebApp — TINA Production User UI Shell served at `/` and `/meetings/[meetingId]`.
 *  Reuses AppGates (AuthGate → InviteGate → SetupGate → OnboardingGate), live `/ws` meetings store,
 *  MeetingCanvasView (LiveTranscriptEngine + bilingual translation + audio), MeetingKnowledge,
 *  Ask Tina SSE streaming, workspace tasks, RoutinesBoard, and SettingsBody.
 *  Exposes a link to `/terminal` (the dev Dockview workbench) only for admins or when the dev flag is set. */
import { useCallback, useEffect, useMemo, useState } from "react";
import "./tina-web.css";
import "./lucian/lucianTokens.css";
import { LucianToastStack } from "./lucian/LucianToastStack";
import { AppGates } from "../app/AppGates";
import { meetingsOnly, workspacePilotMode } from "../app/mode";
import { meetingIdFromPath, meetingPath, TERMINAL_ROUTE_PREFIX, terminalMeetingPath } from "../app/meetingRoute";
import {
  createContainer,
  reg,
  ServicesProvider,
  CommandServiceId,
  createCommandService,
  ContextKeyServiceId,
  createContextKeyService,
  KeybindingServiceId,
  createKeybindingService,
} from "../platform";
import { LayoutServiceId, createLayoutService } from "../workbench/layout";
import { PaletteServiceId, createPaletteService } from "../workbench/palette";
import { useLiveMeetings, useLiveMeetingsConnection, useLiveMeetingsLoaded } from "../surfaces/liveMeetings";
import { meetingPhase } from "../surfaces/meetingModel";
import { ASK_CHAT_EVENT, OPEN_ENTITY_EVENT, type AskChatDetail } from "../canvas/actions";
import { invalidateDocLinkCaches, resolveDocRef } from "../ui-kit/docLinks";
import { useWebIdentity } from "./useWebIdentity";
import { WebSidebar, type WebNavView } from "./Sidebar";
import { WebTopBar, type CaptureModalMode } from "./TopBar";
import { WebGlobalSearch } from "./GlobalSearch";
import { ExtensionDownloadModal, triggerExtensionDownload } from "./ExtensionDownloadModal";
import { WebAvatar } from "./Avatar";
import { WebIcon } from "./Icons";
import { HomeView } from "./HomeView";
import { MeetingsView } from "./MeetingsView";
import { MeetingDetailView } from "./MeetingDetailView";
import { AskTinaView, type AskActivityStatus, type AskTinaPrompt } from "./AskTinaView";
import { KnowledgeView, type KnowledgeDeepLink } from "./KnowledgeView";
import { TasksView } from "./TasksView";
import { RoutinesView } from "./RoutinesView";
import { SettingsView } from "./SettingsView";

const webContainer = createContainer([
  reg(ContextKeyServiceId, () => createContextKeyService()),
  reg(CommandServiceId, (c) => createCommandService(c)),
  reg(LayoutServiceId, () => createLayoutService("meetings")),
  reg(PaletteServiceId, () => createPaletteService()),
  reg(KeybindingServiceId, (c) => createKeybindingService(c)),
]);

const NAV_VIEWS: ReadonlyArray<Exclude<WebNavView, "meeting">> = [
  "home",
  "ask",
  "meetings",
  "knowledge",
  "tasks",
  "routines",
  "settings",
];

const AUTO_COLLAPSE_SIDEBAR_VIEWS: ReadonlySet<WebNavView> = new Set([
  "ask",
  "meetings",
  "meeting",
  "knowledge",
  "settings",
]);

const VIEW_TITLES: Record<WebNavView, string> = {
  home: "Home",
  ask: "Ask Tina",
  meetings: "Meetings",
  meeting: "Meeting",
  knowledge: "Knowledge",
  tasks: "Tasks",
  routines: "Routines",
  settings: "Settings",
};

function readInitialRoute(initialMeetingId?: string): { view: WebNavView; meetingId: string | null } {
  if (initialMeetingId) return { view: "meeting", meetingId: initialMeetingId };
  if (typeof window === "undefined") return { view: "home", meetingId: null };
  const fromPath = meetingIdFromPath(window.location.pathname);
  if (fromPath) return { view: "meeting", meetingId: fromPath };
  try {
    const sharedMeeting = localStorage.getItem("tina.openMeeting");
    if (sharedMeeting) {
      localStorage.removeItem("tina.openMeeting");
      return { view: "meeting", meetingId: sharedMeeting };
    }
  } catch {
    /* ignore storage errors */
  }
  const nav = new URLSearchParams(window.location.search).get("nav");
  if (nav && (NAV_VIEWS as readonly string[]).includes(nav)) {
    return { view: nav as Exclude<WebNavView, "meeting">, meetingId: null };
  }
  return { view: "home", meetingId: null };
}

export function WebShell({ initialMeetingId }: { initialMeetingId?: string }) {
  const {
    user,
    isAdmin,
    workspacePilot,
    canOpenTerminal,
    hideModelSettings,
    extensionStoreUrl,
    signOut,
  } = useWebIdentity();
  const meetOnly = meetingsOnly() || (workspacePilotMode() && !workspacePilot);
  const meetings = useLiveMeetings();
  const listLoaded = useLiveMeetingsLoaded();
  const wsConnected = useLiveMeetingsConnection();

  const initial = useMemo(() => readInitialRoute(initialMeetingId), [initialMeetingId]);
  const [view, setView] = useState<WebNavView>(initial.view);
  const [activeMeetingId, setActiveMeetingId] = useState<string | null>(initial.meetingId);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => AUTO_COLLAPSE_SIDEBAR_VIEWS.has(initial.view));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [extensionModalOpen, setExtensionModalOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureMode, setCaptureMode] = useState<CaptureModalMode>("live");
  const [pendingPrompt, setPendingPrompt] = useState<AskTinaPrompt | null>(null);
  const [pendingKnowledge, setPendingKnowledge] = useState<KnowledgeDeepLink | null>(null);
  const [autoStartBriefId, setAutoStartBriefId] = useState<string | null>(null);
  const [hasVisitedAsk, setHasVisitedAsk] = useState<boolean>(() => initial.view === "ask");
  const [askStatus, setAskStatus] = useState<AskActivityStatus>("idle");

  useEffect(() => {
    if (view === "ask") setHasVisitedAsk(true);
  }, [view]);

  const openCapture = useCallback((mode: CaptureModalMode = "live") => {
    setCaptureMode(mode);
    setCaptureOpen(true);
  }, []);

  const openCalendarSettings = useCallback(() => {
    setView("settings");
    setActiveMeetingId(null);
    setSidebarCollapsed(true);
    setUserMenuOpen(false);
    if (typeof window !== "undefined") {
      const target = "/?nav=settings&settingsWorkspace=personal&settingsSection=calendar";
      try { window.history.pushState({}, "", target); } catch { /* noop */ }
    }
  }, []);

  const openGitHubSettings = useCallback(() => {
    setView("settings");
    setActiveMeetingId(null);
    setSidebarCollapsed(true);
    setUserMenuOpen(false);
    if (typeof window !== "undefined") {
      const target = "/?nav=settings&settingsWorkspace=personal&settingsSection=github";
      try { window.history.pushState({}, "", target); } catch { /* noop */ }
    }
  }, []);

  const openKnowledgeDoc = useCallback((docPath: string, wsSlug?: string) => {
    setPendingKnowledge({ doc: docPath, ws: wsSlug, tab: "documents" });
    setView("knowledge");
    setActiveMeetingId(null);
    setSidebarCollapsed(true);
    setUserMenuOpen(false);
    if (typeof window !== "undefined") {
      const sp = new URLSearchParams({ nav: "knowledge", doc: docPath, tab: "documents" });
      if (wsSlug) sp.set("ws", wsSlug);
      try { window.history.pushState({}, "", `/?${sp.toString()}`); } catch { /* noop */ }
    }
  }, []);

  const liveMeetings = useMemo(() => meetings.filter((m) => meetingPhase(m) === "live"), [meetings]);

  const navigate = useCallback((next: Exclude<WebNavView, "meeting">) => {
    setView(next);
    setActiveMeetingId(null);
    setSidebarCollapsed(AUTO_COLLAPSE_SIDEBAR_VIEWS.has(next));
    setUserMenuOpen(false);
    if (typeof window !== "undefined") {
      if (
        (next === "settings" || next === "ask") &&
        window.location.pathname === "/" &&
        new URLSearchParams(window.location.search).get("nav") === next
      ) {
        return;
      }
      const target = next === "home" ? "/" : `/?nav=${encodeURIComponent(next)}`;
      if (`${window.location.pathname}${window.location.search}` !== target) {
        try { window.history.pushState({}, "", target); } catch { /* noop */ }
      }
    }
  }, []);

  const openMeeting = useCallback((meetingId: string, opts?: { startBrief?: boolean }) => {
    setActiveMeetingId(meetingId);
    setAutoStartBriefId(opts?.startBrief ? meetingId : null);
    setView("meeting");
    setSidebarCollapsed(true);
    setUserMenuOpen(false);
    if (typeof window !== "undefined") {
      const target = meetingPath(meetingId);
      if (window.location.pathname !== target) {
        try { window.history.pushState({}, "", target); } catch { /* noop */ }
      }
    }
  }, []);

  const askTina = useCallback(
    (prompt?: string, mode: AskTinaPrompt["mode"] = "send") => {
      if (meetOnly) return;
      if (prompt) setPendingPrompt({ text: prompt, mode });
      navigate("ask");
    },
    [meetOnly, navigate],
  );

  useEffect(() => {
    const onPopState = () => {
      const route = readInitialRoute();
      setView(route.view);
      setActiveMeetingId(route.meetingId);
      setSidebarCollapsed(AUTO_COLLAPSE_SIDEBAR_VIEWS.has(route.view));
      setUserMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((cur) => !cur);
      }
      if (e.key === "Escape") {
        setUserMenuOpen(false);
        setMobileNavOpen(false);
      }
    };
    const onAskChat = (e: Event) => {
      const detail = (e as CustomEvent<AskChatDetail>).detail;
      if (!detail?.prompt) return;
      if (meetOnly) {
        detail.onRejected?.("Workspace chat is unavailable.");
        return;
      }
      detail.onAccepted?.();
      setPendingPrompt({
        text: detail.prompt,
        mode: detail.composeOnly ? "draft" : "send",
        meetingId: detail.focus?.meeting_id,
        focus: detail.focus,
      });
      navigate("ask");
    };
    const onOpenEntity = (e: Event) => {
      if (meetOnly) return;
      const detail = (e as CustomEvent<{ path?: string; wikilink?: string; slug?: string; docPath?: string }>).detail;
      if (!detail?.path && !detail?.wikilink) return;
      invalidateDocLinkCaches();
      void resolveDocRef(
        { path: detail.path, wikilink: detail.wikilink },
        { path: detail.docPath, slug: detail.slug },
      )
        .then((resolved) => {
          if (resolved?.path) {
            openKnowledgeDoc(resolved.path, resolved.slug);
          } else if (detail.path) {
            openKnowledgeDoc(detail.path.replace(/^\/+/, ""), detail.slug);
          }
        })
        .catch(() => {
          if (detail.path) openKnowledgeDoc(detail.path.replace(/^\/+/, ""), detail.slug);
        });
    };
    const onWindowClick = () => setUserMenuOpen(false);

    window.addEventListener("popstate", onPopState);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(ASK_CHAT_EVENT, onAskChat);
    window.addEventListener(OPEN_ENTITY_EVENT, onOpenEntity);
    window.addEventListener("click", onWindowClick);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(ASK_CHAT_EVENT, onAskChat);
      window.removeEventListener(OPEN_ENTITY_EVENT, onOpenEntity);
      window.removeEventListener("click", onWindowClick);
    };
  }, [meetOnly, navigate, openKnowledgeDoc]);

  const terminalHref = view === "meeting" && activeMeetingId
    ? terminalMeetingPath(activeMeetingId)
    : TERMINAL_ROUTE_PREFIX;

  return (
    <ServicesProvider container={webContainer}>
      <div className="tina-web">
        <div className="tina-web-shell">
          <WebSidebar
            active={view}
            user={user}
            collapsed={sidebarCollapsed}
            mobileOpen={mobileNavOpen}
            liveCount={liveMeetings.length}
            askStatus={askStatus}
            meetingsOnly={meetOnly}
            canOpenTerminal={canOpenTerminal}
            terminalHref={terminalHref}
            onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
            onNavigate={navigate}
            onUserMenuToggle={(event) => {
              event.stopPropagation();
              setUserMenuOpen((cur) => !cur);
            }}
            onCloseMobile={() => setMobileNavOpen(false)}
          />

          <main className="tina-web-main">
            <WebTopBar
              title={VIEW_TITLES[view]}
              liveMeeting={liveMeetings[0]}
              liveMeetings={liveMeetings}
              wsConnected={wsConnected}
              meetingsOnly={meetOnly}
              hideBar={view === "meeting"}
              onOpenMobileNav={() => setMobileNavOpen((v) => !v)}
              onOpenSearch={() => setSearchOpen(true)}
              onOpenMeeting={openMeeting}
              onOpenCalendarSettings={openCalendarSettings}
              captureOpen={captureOpen}
              captureMode={captureMode}
              onOpenCapture={openCapture}
              onCloseCapture={() => setCaptureOpen(false)}
            />

            {view === "home" && (
              <HomeView
                firstName={user.firstName}
                userName={user.name}
                meetings={meetings}
                listLoaded={listLoaded}
                meetingsOnly={meetOnly}
                onOpenMeeting={openMeeting}
                onAskTina={askTina}
                onNavigate={navigate}
                onOpenCapture={() => openCapture("live")}
              />
            )}

            {view === "meetings" && (
              <MeetingsView
                meetings={meetings}
                listLoaded={listLoaded}
                userName={user.name}
                wsConnected={wsConnected}
                meetingsOnly={meetOnly}
                onOpenMeeting={openMeeting}
                onAskMeeting={(meeting) => {
                  setPendingPrompt({ text: "", mode: "draft", meetingId: meeting.id });
                  navigate("ask");
                }}
                onOpenCapture={openCapture}
              />
            )}

            {view === "meeting" && activeMeetingId && (
              <MeetingDetailView
                key={activeMeetingId}
                meetingId={activeMeetingId}
                meetings={meetings}
                listLoaded={listLoaded}
                wsConnected={wsConnected}
                meetingsOnly={meetOnly}
                canOpenTerminal={canOpenTerminal}
                user={user}
                autoStartBrief={autoStartBriefId === activeMeetingId}
                onConsumeAutoStartBrief={() => setAutoStartBriefId(null)}
                onOpenKnowledgeDoc={openKnowledgeDoc}
                onBack={() => navigate("meetings")}
                onOpenMeeting={openMeeting}
                onOpenMobileNav={() => setMobileNavOpen((v) => !v)}
                onOpenCapture={openCapture}
                onUserMenuToggle={(event) => {
                  event.stopPropagation();
                  setUserMenuOpen((cur) => !cur);
                }}
              />
            )}

            {hasVisitedAsk && !meetOnly && (
              <div
                className="tina-web-keepalive"
                style={view === "ask" ? undefined : { display: "none" }}
                aria-hidden={view !== "ask" || undefined}
              >
                <AskTinaView
                  meetings={meetings}
                  initialPrompt={pendingPrompt}
                  onConsumeInitialPrompt={() => setPendingPrompt(null)}
                  isActive={view === "ask"}
                  onActivityChange={setAskStatus}
                />
              </div>
            )}

            {view === "knowledge" && !meetOnly && (
              <KnowledgeView
                onAskTina={askTina}
                onOpenGitHubSettings={openGitHubSettings}
                onOpenMeeting={openMeeting}
                initialTarget={pendingKnowledge}
                onConsumeInitialTarget={() => setPendingKnowledge(null)}
              />
            )}

            {view === "tasks" && !meetOnly && <TasksView onAskTina={askTina} />}

            {view === "routines" && !meetOnly && <RoutinesView />}

            {view === "settings" && (
              <SettingsView
                user={user}
                isAdmin={isAdmin}
                canOpenTerminal={canOpenTerminal}
                hideModelSettings={hideModelSettings}
                terminalHref={terminalHref}
                onSignOut={signOut}
              />
            )}
          </main>
        </div>

        {mobileNavOpen && (
          <div
            style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(0, 0, 0, 0.52)" }}
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
        )}

        {userMenuOpen && (
          <div
            className="tina-web-usermenu"
            role="menu"
            aria-label="Account menu"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tina-web-usermenu-head">
              <WebAvatar name={user.name} image={user.image} size={32} />
              <div className="tina-web-usermenu-meta">
                <strong>{user.name}</strong>
                {user.email && <span>{user.email}</span>}
              </div>
            </div>
            <div className="tina-web-usermenu-divider" />
            <button
              type="button"
              role="menuitem"
              className="tina-web-usermenu-item"
              onClick={() => navigate("settings")}
            >
              <WebIcon name="settings" size={15} />
              <span>Settings</span>
            </button>
            {extensionStoreUrl ? (
              <a
                href={extensionStoreUrl}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                className="tina-web-usermenu-item"
                onClick={() => setUserMenuOpen(false)}
              >
                <WebIcon name="puzzle" size={15} />
                <span>MeetTINA Extension</span>
                <WebIcon name="externalLink" size={13} className="tina-web-usermenu-trailing" />
              </a>
            ) : (
              <button
                type="button"
                role="menuitem"
                className="tina-web-usermenu-item"
                onClick={() => {
                  setUserMenuOpen(false);
                  triggerExtensionDownload();
                  setExtensionModalOpen(true);
                }}
              >
                <WebIcon name="puzzle" size={15} />
                <span>MeetTINA Extension</span>
                <WebIcon name="download" size={13} className="tina-web-usermenu-trailing" />
              </button>
            )}
            {canOpenTerminal && (
              <a
                href={terminalHref}
                role="menuitem"
                className="tina-web-usermenu-item"
              >
                <WebIcon name="terminal" size={15} />
                <span>Open TINA Terminal</span>
              </a>
            )}
            <div className="tina-web-usermenu-divider" />
            <button
              type="button"
              role="menuitem"
              className="tina-web-usermenu-item danger"
              onClick={signOut}
            >
              <WebIcon name="logout" size={15} />
              <span>Log out</span>
            </button>
          </div>
        )}

        <WebGlobalSearch
          open={searchOpen}
          meetings={meetings}
          meetingsOnly={meetOnly}
          canOpenTerminal={canOpenTerminal}
          terminalHref={terminalHref}
          onClose={() => setSearchOpen(false)}
          onOpenMeeting={openMeeting}
          onOpenKnowledgeDoc={openKnowledgeDoc}
          onNavigate={navigate}
          onOpenCapture={() => openCapture("live")}
        />

        <ExtensionDownloadModal
          open={extensionModalOpen}
          onClose={() => setExtensionModalOpen(false)}
        />

        <LucianToastStack />
      </div>
    </ServicesProvider>
  );
}

export function WebApp({ initialMeetingId }: { initialMeetingId?: string }) {
  return (
    <AppGates calendarWelcome={!initialMeetingId}>
      <WebShell initialMeetingId={initialMeetingId} />
    </AppGates>
  );
}
