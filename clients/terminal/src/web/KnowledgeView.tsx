"use client";
/** KnowledgeView — Notion-style Non-Tech Knowledge Hub (v3) for TINA's Production Web UI (`/?nav=knowledge`).
 *  - Compact Workspace Picker dropdown (`My Space`, Team Spaces, `Templates & Guides`, `+ Create new space`)
 *  - Single Unified Smart Search (filters titles immediately + searches content seamlessly)
 *  - Clean Topic-Based Sidebar (`Overview`, `Connections Map`, `Pages & Notes`, `Meeting Notes`,
 *    `Projects`, `People`, `Tasks`, `Uploaded Files`) with zero developer jargon by default
 *  - Friendly Library Overview home screen + clean single-bar Page Reader + YAML-free Page Editor
 *  - Inline Ask Tina Copilot drawer, Connections Map, Drag-and-Drop file uploads, Activity & Settings
 *    (with collapsible `Advanced · GitHub Sync`), and a subtle `Developer view` switch (OFF by default). */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { WebIcon } from "./Icons";
import { KnowledgeGraphCanvas } from "./KnowledgeGraphCanvas";
import { KnowledgeCopilotDrawer } from "./KnowledgeCopilotDrawer";
import { KnowledgeDocEditor } from "./KnowledgeDocEditor";
import {
  CATEGORY_BY_ID,
  LIBRARY_CATEGORIES,
  buildFriendlyMovePath,
  buildNewPageTemplate,
  categorizePath,
  ensureEntityFrontmatterForPath,
  fileExtensionBadge,
  friendlyPageTitle,
  friendlyRoleLabel,
  friendlyWorkspaceLabel,
  isUploadedOrNonMarkdown,
  parseDocumentClean,
  sectionFromPath,
  visibleHumanMetadata,
  type LibraryCategory,
  type NewPageKind,
} from "./knowledgeFriendly";
import { MdxDoc } from "../ui-kit/MdxDoc";
import {
  DocMetaContext,
  DocNavContext,
  invalidateDocLinkCaches,
  resolveDocRef,
  type DocNavigate,
} from "../ui-kit/docLinks";
import { MeetingWikiSourceStatus } from "../surfaces/MeetingKnowledge";
import { ApiError, presentError } from "../surfaces/apiClient";
import {
  activateWorkspace,
  archiveWorkspace,
  createSharedWorkspace,
  createWorkspace,
  deactivateWorkspace,
  deleteWorkspace,
  deleteWorkspaceDocument,
  getGitToken,
  gitRemoteStatus,
  leaveWorkspace,
  listSharedMemberships,
  listWorkspaceMembers,
  listWorkspaceTree,
  mintInvite,
  moveWorkspaceDocument,
  previewMoveWorkspaceDocument,
  publishWorkspace,
  pullWorkspace,
  pushWorkspace,
  readActiveSet,
  readAttachedWorkspaces,
  readWorkspaceDocument,
  readWorkspaceFile,
  readWorkspaceGit,
  readWorkspaceGitDiff,
  readWorkspacePurpose,
  renameWorkspace,
  saveWorkspaceDocument,
  searchWorkspaceContent,
  setSharedActive,
  shareEnableWorkspace,
  unshareWorkspace,
  uploadWorkspaceFiles,
  writeWorkspacePurpose,
  type ActiveMount,
  type AttachedWorkspaces,
  type DocumentMovePreview,
  type GitRemoteStatus,
  type GitState,
  type Membership,
  type SavedGitToken,
  type WorkspaceDocument,
  type WorkspaceMember,
  type WorkspaceSearchHit,
} from "../surfaces/workspaceApi";
import styles from "./knowledgeView.module.css";

type KnowledgeTab = "documents" | "graph" | "sync";

interface WorkspaceEntry {
  id: string;
  slug?: string;
  slotSlug?: string;
  rawName: string;
  name: string;
  kind: "personal" | "extra" | "shared" | "global";
  role?: string;
  roleLabel: string;
  mounted: boolean;
  readOnly: boolean;
}

interface ArchivedSpaceEntry {
  slotSlug: string;
  rawName: string;
  name: string;
}

type SpaceLifecycleModal =
  | {
      action: "delete";
      kind: "extra" | "shared" | "archived";
      slug: string;
      name: string;
      rawName: string;
    }
  | {
      action: "unshare";
      workspaceId: string;
      name: string;
      rawName: string;
    }
  | {
      action: "leave";
      workspaceId: string;
      name: string;
    };

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

interface CrossSearchHit extends WorkspaceSearchHit {
  wsId: string;
  wsName: string;
}

interface HistoryEntry {
  wsId: string;
  path: string;
}

interface OutlineHeading {
  level: 2 | 3;
  text: string;
}

export interface KnowledgeDeepLink {
  ws?: string;
  doc?: string;
  tab?: KnowledgeTab;
}

const DEV_VIEW_STORAGE_KEY = "tina.knowledge.devView";

function readInitialDevView(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DEV_VIEW_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function buildTree(paths: string[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
  for (const raw of [...paths].sort()) {
    const parts = raw.split("/").filter(Boolean);
    let cur = root;
    parts.forEach((part, idx) => {
      const isLeaf = idx === parts.length - 1;
      const curPath = parts.slice(0, idx + 1).join("/");
      let next = cur.children.find((c) => c.name === part && c.isDir === !isLeaf);
      if (!next) {
        next = { name: part, path: curPath, isDir: !isLeaf, children: [] };
        cur.children.push(next);
      }
      cur = next;
    });
  }
  const sortNodes = (nodes: TreeNode[]): TreeNode[] =>
    nodes
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
      .map((n) => (n.isDir ? { ...n, children: sortNodes(n.children) } : n));
  return sortNodes(root.children);
}

function extractHeadings(markdown: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    if (raw.trim().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = raw.match(/^(#{2,3})\s+(.+?)\s*#*\s*$/);
    if (m) {
      headings.push({ level: m[1].length as 2 | 3, text: m[2].replace(/[*_`[\]]/g, "").trim() });
    }
  }
  return headings;
}

function renderDiffLines(diff: string): ReactNode {
  return diff.split("\n").map((line, i) => {
    const isMeta =
      line.startsWith("@@") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ");
    const cls = isMeta
      ? styles.diffMeta
      : line.startsWith("+")
        ? styles.diffAdd
        : line.startsWith("-")
          ? styles.diffDel
          : "";
    return (
      <div key={i} className={cls}>
        {line || " "}
      </div>
    );
  });
}

function readUrlDeepLink(): KnowledgeDeepLink {
  if (typeof window === "undefined") return {};
  const sp = new URLSearchParams(window.location.search);
  const tabRaw = sp.get("tab");
  const tab: KnowledgeTab | undefined =
    tabRaw === "documents" || tabRaw === "graph" || tabRaw === "sync" ? tabRaw : undefined;
  return {
    ws: sp.get("ws") || undefined,
    doc: sp.get("doc") || undefined,
    tab,
  };
}

function syncKnowledgeUrl(wsSlug: string | undefined, docPath: string | null, tab: KnowledgeTab) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.pathname !== "/") return;
  url.searchParams.set("nav", "knowledge");
  if (wsSlug) url.searchParams.set("ws", wsSlug);
  else url.searchParams.delete("ws");
  if (docPath) url.searchParams.set("doc", docPath);
  else url.searchParams.delete("doc");
  if (tab !== "documents" || docPath) url.searchParams.set("tab", tab);
  else url.searchParams.delete("tab");
  const next = `${url.pathname}?${url.searchParams.toString()}${url.hash}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== next) {
    try {
      window.history.replaceState(window.history.state, "", next);
    } catch {
      /* ignore sandboxed history */
    }
  }
}

function resolveWorkspaceIdBySlug(workspaces: WorkspaceEntry[], wsParam?: string): string | null {
  if (!wsParam || wsParam === "personal") return "personal";
  if (wsParam === "_global" || wsParam === "global") return "global";
  const match = workspaces.find((w) => w.slug === wsParam || w.slotSlug === wsParam || w.id === wsParam);
  return match?.id ?? null;
}

const NEW_PAGE_CARDS: ReadonlyArray<{
  kind: NewPageKind;
  title: string;
  desc: string;
  icon: "fileText" | "edit" | "layers" | "user";
}> = [
  { kind: "wiki", title: "Page", desc: "Guide, spec, or shared doc", icon: "fileText" },
  { kind: "notes", title: "Quick Note", desc: "Scratchpad, ideas, or draft", icon: "edit" },
  { kind: "project", title: "Project", desc: "Goals, milestones & decisions", icon: "layers" },
  { kind: "person", title: "Person", desc: "Profile, role & meeting links", icon: "user" },
];

export function KnowledgeView({
  onAskTina,
  onOpenGitHubSettings,
  onOpenMeeting,
  initialTarget,
  onConsumeInitialTarget,
}: {
  onAskTina: (prompt: string, mode?: "send" | "draft") => void;
  onOpenGitHubSettings?: () => void;
  onOpenMeeting?: (meetingId: string) => void;
  initialTarget?: KnowledgeDeepLink | null;
  onConsumeInitialTarget?: () => void;
}) {
  const bootLink = useMemo(() => initialTarget ?? readUrlDeepLink(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const pendingDeepLinkRef = useRef<KnowledgeDeepLink | null>(
    bootLink.ws || bootLink.doc || bootLink.tab ? bootLink : null,
  );

  // ── Developer view preference (OFF by default) ───────────────────────
  const [devView, setDevView] = useState<boolean>(readInitialDevView);
  const toggleDevView = useCallback(() => {
    setDevView((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(DEV_VIEW_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  }, []);

  // ── Workspaces & Picker state ────────────────────────────────────────
  const [attached, setAttached] = useState<AttachedWorkspaces>({ active: null, slots: {} });
  const [activeSet, setActiveSet] = useState<ActiveMount[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [hasGlobal, setHasGlobal] = useState(false);
  const [selectedWsId, setSelectedWsId] = useState<string>("personal");
  const [wsLoading, setWsLoading] = useState(true);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [pageMenuOpen, setPageMenuOpen] = useState(false);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);

  // Create space & lifecycle confirmation modals
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsShared, setNewWsShared] = useState(false);
  const [createWsError, setCreateWsError] = useState<string | null>(null);
  const [lifecycleModal, setLifecycleModal] = useState<SpaceLifecycleModal | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [spaceMembers, setSpaceMembers] = useState<WorkspaceMember[]>([]);
  const archivedSectionRef = useRef<HTMLElement>(null);

  // ── Library & Unified Search state ───────────────────────────────────
  const [files, setFiles] = useState<string[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set(["kg", "kg/entities", "docs", "wiki"]));
  const [collapsedCats, setCollapsedCats] = useState<Set<LibraryCategory>>(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  const [searchAllSpaces, setSearchAllSpaces] = useState(false);
  const [contentHits, setContentHits] = useState<CrossSearchHit[]>([]);
  const [searchingContent, setSearchingContent] = useState(false);

  // ── Main pane navigation, Document, Copilot & History state ──────────
  const [activeTab, setActiveTab] = useState<KnowledgeTab>(bootLink.tab ?? "documents");
  const [selectedPath, setSelectedPath] = useState<string | null>(bootLink.doc ?? null);
  const [doc, setDoc] = useState<WorkspaceDocument | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [commitOnSave, setCommitOnSave] = useState(true);
  const [commitMsg, setCommitMsg] = useState("");
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [copilotSeedPrompt, setCopilotSeedPrompt] = useState<string | null>(null);
  const [graphRefreshKey, setGraphRefreshKey] = useState(0);
  const [backlinks, setBacklinks] = useState<WorkspaceSearchHit[]>([]);
  const [backlinksLoading, setBacklinksLoading] = useState(false);

  // Reading history stack (Back / Forward)
  const [navHistory, setNavHistory] = useState<HistoryEntry[]>([]);
  const [navIndex, setNavIndex] = useState<number>(-1);
  const navigatingHistoryRef = useRef(false);

  // Drag & drop upload state
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  // ── Modals: Create Page & Rename/Move Page ───────────────────────────
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [newDocKind, setNewDocKind] = useState<NewPageKind>("wiki");
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocCustomPath, setNewDocCustomPath] = useState("");
  const [newDocError, setNewDocError] = useState<string | null>(null);

  const [moveOpen, setMoveOpen] = useState(false);
  const [moveName, setMoveName] = useState("");
  const [moveSection, setMoveSection] = useState<"wiki" | "notes" | "project" | "person" | "task">("wiki");
  const [moveDest, setMoveDest] = useState("");
  const [moveUpdateLinks, setMoveUpdateLinks] = useState(true);
  const [movePreview, setMovePreview] = useState<DocumentMovePreview | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  // ── Activity, Settings & Advanced GitHub Sync state ──────────────────
  const [gitState, setGitState] = useState<GitState | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [gitToken, setGitToken] = useState<SavedGitToken>({ set: false, masked: null });
  const [advancedSyncOpen, setAdvancedSyncOpen] = useState(false);
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const [showDiffSha, setShowDiffSha] = useState<string | null>(null);
  const [diffsBySha, setDiffsBySha] = useState<Record<string, string>>({});
  const [purpose, setPurpose] = useState("");
  const [purposeDraft, setPurposeDraft] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [publishRepoName, setPublishRepoName] = useState("");
  const [publishPrivate, setPublishPrivate] = useState(true);
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  // ── Global status banners ────────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docProseRef = useRef<HTMLDivElement>(null);

  // Automatically expand Advanced GitHub Sync when Developer view is enabled
  useEffect(() => {
    if (devView) setAdvancedSyncOpen(true);
  }, [devView]);

  // Reset modal-local errors whenever a modal opens or closes
  useEffect(() => {
    setNewDocError(null);
  }, [newDocOpen]);
  useEffect(() => {
    setMoveError(null);
  }, [moveOpen]);
  useEffect(() => {
    setCreateWsError(null);
  }, [createWsOpen]);

  const openLifecycleModal = useCallback((next: SpaceLifecycleModal) => {
    setLifecycleModal(next);
    setDeleteConfirmInput("");
    setLifecycleError(null);
  }, []);

  const closeLifecycleModal = useCallback(() => {
    if (busy) return;
    setLifecycleModal(null);
    setDeleteConfirmInput("");
    setLifecycleError(null);
  }, [busy]);

  // Close Space Lifecycle confirmation modal on Escape when idle
  useEffect(() => {
    if (!lifecycleModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setLifecycleModal(null);
        setDeleteConfirmInput("");
        setLifecycleError(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lifecycleModal, busy]);

  // Close popovers on Escape or outside click
  useEffect(() => {
    if (!wsMenuOpen && !pageMenuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setWsMenuOpen(false);
        setPageMenuOpen(false);
      }
    };
    const onClick = () => {
      setWsMenuOpen(false);
      setPageMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
    };
  }, [wsMenuOpen, pageMenuOpen]);

  const workspaces = useMemo<WorkspaceEntry[]>(() => {
    const entries: WorkspaceEntry[] = [];
    const primaryMount = activeSet.find((m) => m.primary);
    const seedSlug = attached.active ?? "seed";
    const seedMeta = attached.slots[seedSlug];
    const personalRaw = seedMeta?.name || primaryMount?.name || "Personal";
    entries.push({
      id: "personal",
      slug: undefined,
      slotSlug: seedSlug,
      rawName: personalRaw,
      name: friendlyWorkspaceLabel(personalRaw, "personal"),
      kind: "personal",
      roleLabel: friendlyRoleLabel(undefined, "personal"),
      mounted: Boolean(primaryMount) || activeSet.length === 0,
      readOnly: false,
    });

    const sharedIds = new Set(memberships.map((m) => m.workspace_id));
    for (const [slotSlug, meta] of Object.entries(attached.slots)) {
      if (meta.archived || slotSlug === seedSlug || slotSlug === "seed-prev" || sharedIds.has(slotSlug)) continue;
      const isMounted = activeSet.some((m) => m.slug === slotSlug && m.role !== "shared");
      const raw = meta.name || meta.repo || slotSlug;
      entries.push({
        id: `extra:${slotSlug}`,
        slug: slotSlug,
        slotSlug,
        rawName: raw,
        name: friendlyWorkspaceLabel(raw, "extra"),
        kind: "extra",
        roleLabel: friendlyRoleLabel(undefined, "extra"),
        mounted: isMounted,
        readOnly: false,
      });
    }

    for (const mem of memberships) {
      const isMounted = activeSet.some((m) => m.role === "shared" && m.slug === mem.workspace_id);
      entries.push({
        id: `shared:${mem.workspace_id}`,
        slug: mem.workspace_id,
        slotSlug: mem.workspace_id,
        rawName: mem.workspace_id,
        name: friendlyWorkspaceLabel(mem.workspace_id, "shared"),
        kind: "shared",
        role: mem.role,
        roleLabel: friendlyRoleLabel(mem.role, "shared"),
        mounted: isMounted,
        readOnly: mem.role !== "owner" && mem.role !== "contributor",
      });
    }

    if (hasGlobal) {
      entries.push({
        id: "global",
        slug: "_global",
        slotSlug: "_global",
        rawName: "Platform Guide (_global)",
        name: friendlyWorkspaceLabel("Platform Guide", "global"),
        kind: "global",
        role: "read-only",
        roleLabel: friendlyRoleLabel("read-only", "global"),
        mounted: true,
        readOnly: true,
      });
    }

    return entries;
  }, [attached, activeSet, memberships, hasGlobal]);

  const archivedSpaces = useMemo<ArchivedSpaceEntry[]>(() => {
    const seedSlug = attached.active ?? "seed";
    const sharedIds = new Set(memberships.map((m) => m.workspace_id));
    const list: ArchivedSpaceEntry[] = [];
    for (const [slotSlug, meta] of Object.entries(attached.slots)) {
      if (!meta.archived || slotSlug === seedSlug || slotSlug === "seed-prev" || sharedIds.has(slotSlug)) continue;
      const raw = meta.name || meta.repo || slotSlug;
      list.push({
        slotSlug,
        rawName: raw,
        name: friendlyWorkspaceLabel(raw, "extra"),
      });
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [attached, memberships]);

  const activeWs = useMemo<WorkspaceEntry>(
    () => workspaces.find((w) => w.id === selectedWsId) ?? workspaces[0],
    [workspaces, selectedWsId],
  );

  const isUnsaved = editing && doc !== null && draft !== doc.content;
  const confirmDiscardDraft = useCallback((): boolean => {
    if (!isUnsaved) return true;
    if (typeof window === "undefined") return true;
    return window.confirm("You have unsaved changes. Discard them?");
  }, [isUnsaved]);

  // ── Apply external deep-link (e.g. from Cmd+K Global Search) ─────────
  useEffect(() => {
    if (!initialTarget) return;
    pendingDeepLinkRef.current = initialTarget;
    if (initialTarget.tab) setActiveTab(initialTarget.tab);
    const resolvedWs = resolveWorkspaceIdBySlug(workspaces, initialTarget.ws);
    if (resolvedWs) setSelectedWsId(resolvedWs);
    if (initialTarget.doc) setSelectedPath(initialTarget.doc);
    onConsumeInitialTarget?.();
  }, [initialTarget, workspaces, onConsumeInitialTarget]);

  // ── Load workspace catalog ───────────────────────────────────────────
  const loadWorkspaces = useCallback(async () => {
    setWsLoading(true);
    try {
      const [att, act, mem, globalTree] = await Promise.all([
        readAttachedWorkspaces().catch(() => ({ active: null, slots: {} })),
        readActiveSet().catch(() => ({ subject: "", active: [] })),
        listSharedMemberships().catch(() => []),
        listWorkspaceTree({ slug: "_global" }).catch(() => null),
      ]);
      setAttached(att);
      setActiveSet(act.active);
      setMemberships(mem);
      setHasGlobal(Array.isArray(globalTree) && globalTree.length > 0);
    } finally {
      setWsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  // Honor URL `?ws=` once workspace list is hydrated
  useEffect(() => {
    if (wsLoading || !pendingDeepLinkRef.current?.ws) return;
    const targetId = resolveWorkspaceIdBySlug(workspaces, pendingDeepLinkRef.current.ws);
    if (targetId) {
      setSelectedWsId(targetId);
      pendingDeepLinkRef.current = { ...pendingDeepLinkRef.current, ws: undefined };
    }
  }, [wsLoading, workspaces]);

  // Sync URL query params on navigation
  useEffect(() => {
    if (wsLoading || !activeWs) return;
    syncKnowledgeUrl(activeWs.slug, selectedPath, activeTab);
  }, [wsLoading, activeWs, selectedPath, activeTab]);

  // Record Back / Forward reading history whenever a page opens
  useEffect(() => {
    if (!activeWs || !selectedPath) return;
    if (navigatingHistoryRef.current) {
      navigatingHistoryRef.current = false;
      return;
    }
    setNavHistory((prev) => {
      const cur = prev[navIndex];
      if (cur && cur.wsId === activeWs.id && cur.path === selectedPath) return prev;
      const trimmed = prev.slice(0, navIndex + 1);
      const next = [...trimmed, { wsId: activeWs.id, path: selectedPath }].slice(-40);
      setNavIndex(next.length - 1);
      return next;
    });
  }, [activeWs?.id, selectedPath]); // eslint-disable-line react-hooks/exhaustive-deps

  const canGoBack = navIndex > 0;
  const canGoForward = navIndex >= 0 && navIndex < navHistory.length - 1;

  const goHistory = useCallback(
    (delta: -1 | 1) => {
      const targetIdx = navIndex + delta;
      const entry = navHistory[targetIdx];
      if (!entry || !confirmDiscardDraft()) return;
      navigatingHistoryRef.current = true;
      setNavIndex(targetIdx);
      setEditing(false);
      setSelectedWsId(entry.wsId);
      setSelectedPath(entry.path);
      setActiveTab("documents");
    },
    [navIndex, navHistory, confirmDiscardDraft],
  );

  // Alt+Left / Alt+Right shortcuts for Back / Forward
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && e.key === "ArrowLeft" && canGoBack) {
        e.preventDefault();
        goHistory(-1);
      } else if (e.altKey && e.key === "ArrowRight" && canGoForward) {
        e.preventDefault();
        goHistory(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canGoBack, canGoForward, goHistory]);

  // ── Load file list & space metadata ──────────────────────────────────
  const loadTreeAndMeta = useCallback(async (ws: WorkspaceEntry, keepSelection = true) => {
    setTreeLoading(true);
    setError(null);
    setContentHits([]);
    try {
      const opts = ws.slug ? { slug: ws.slug } : undefined;
      const [treeFiles, wsPurpose] = await Promise.all([
        listWorkspaceTree(opts),
        ws.kind === "global"
          ? Promise.resolve("Built-in starter guides, handbooks, and email templates available across every space.")
          : readWorkspacePurpose(opts).catch(() => ""),
      ]);
      setFiles(treeFiles);
      setPurpose(wsPurpose);
      setPurposeDraft(wsPurpose);
      setRenameDraft(ws.name);
      setPublishRepoName(
        `tina-${ws.rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "knowledge"}`,
      );
      const pendingDoc = pendingDeepLinkRef.current?.doc;
      if (pendingDoc && treeFiles.includes(pendingDoc)) {
        pendingDeepLinkRef.current = { ...pendingDeepLinkRef.current, doc: undefined };
        setSelectedPath(pendingDoc);
      } else {
        setSelectedPath((prev) => {
          if (keepSelection && prev && treeFiles.includes(prev)) return prev;
          return null; // Land on the friendly Library Overview!
        });
      }
    } catch (err) {
      setFiles([]);
      setSelectedPath(null);
      setError(presentError(err).headline);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeWs) return;
    setEditing(false);
    setInviteLink(null);
    setSpaceMembers([]);
    setExpandedSha(null);
    setShowDiffSha(null);
    setDiffsBySha({});
    void loadTreeAndMeta(activeWs, Boolean(pendingDeepLinkRef.current?.doc));
  }, [activeWs?.id, activeWs?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load selected document ───────────────────────────────────────────
  const loadDocument = useCallback(async (path: string | null, slug?: string) => {
    if (!path) {
      setDoc(null);
      setDraft("");
      return;
    }
    setDocLoading(true);
    setEditing(false);
    try {
      const loaded = await readWorkspaceDocument(path, slug ? { slug } : undefined);
      setDoc(loaded);
      setDraft(loaded.content);
      setError(null);
    } catch {
      try {
        const raw = await readWorkspaceFile(path, slug ? { slug } : undefined);
        if (raw === null) {
          setDoc(null);
          setDraft("");
        } else {
          setDoc({ content: raw, sha256: "", writable: false });
          setDraft(raw);
        }
      } catch (err) {
        setDoc(null);
        setError(presentError(err).headline);
      }
    } finally {
      setDocLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDocument(selectedPath, activeWs?.slug);
  }, [selectedPath, activeWs?.slug, loadDocument]);

  // ── Parsed document, TOC outline, meeting provenance & backlinks ─────
  const parsedDoc = useMemo(
    () => (doc && selectedPath ? parseDocumentClean(doc.content, selectedPath) : null),
    [doc, selectedPath],
  );
  const outlineHeadings = useMemo(
    () => (parsedDoc ? extractHeadings(parsedDoc.bodyWithoutLeadingH1) : []),
    [parsedDoc],
  );
  const humanMeta = useMemo(
    () => (parsedDoc ? visibleHumanMetadata(parsedDoc.fieldMap) : []),
    [parsedDoc],
  );
  const sourceMeetingId = useMemo(() => {
    if (!selectedPath) return null;
    const pathMatch = /^wiki\/meetings\/(\d+)\//.exec(selectedPath);
    if (pathMatch) return pathMatch[1];
    const fmMeeting = parsedDoc?.fieldMap.meeting_id;
    if (fmMeeting && /^\d+$/.test(fmMeeting)) return fmMeeting;
    return null;
  }, [selectedPath, parsedDoc]);

  useEffect(() => {
    if (!selectedPath || !activeWs || activeTab !== "documents" || isUploadedOrNonMarkdown(selectedPath)) {
      setBacklinks([]);
      return;
    }
    const queryTerm = parsedDoc?.explicitTitle || (selectedPath.split("/").pop() ?? "").replace(/\.md$/i, "");
    if (!queryTerm || queryTerm.length < 2 || queryTerm.toLowerCase() === "readme" || queryTerm === "Space Home") {
      setBacklinks([]);
      return;
    }
    let alive = true;
    setBacklinksLoading(true);
    void searchWorkspaceContent(`[[${queryTerm}`, activeWs.slug ? { slug: activeWs.slug } : undefined)
      .then((res) => {
        if (!alive) return;
        const uniqueByPath = new Map<string, WorkspaceSearchHit>();
        for (const hit of res.hits) {
          if (hit.path !== selectedPath && !uniqueByPath.has(hit.path)) {
            uniqueByPath.set(hit.path, hit);
          }
        }
        setBacklinks([...uniqueByPath.values()].slice(0, 12));
      })
      .catch(() => {
        if (alive) setBacklinks([]);
      })
      .finally(() => {
        if (alive) setBacklinksLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [selectedPath, activeWs, activeTab, parsedDoc]);

  // ── Unified Smart Search (debounced full-text + instant title filter) ─
  const executeContentSearch = useCallback(
    async (rawQuery: string, allSpaces: boolean) => {
      const q = rawQuery.trim();
      if (q.length < 2 || !activeWs) {
        setContentHits([]);
        setSearchingContent(false);
        return;
      }
      setSearchingContent(true);
      try {
        const targets = allSpaces ? workspaces : [activeWs];
        const settled = await Promise.all(
          targets.map(async (ws) => {
            try {
              const res = await searchWorkspaceContent(q, ws.slug ? { slug: ws.slug } : undefined);
              return res.hits.map<CrossSearchHit>((h) => ({ ...h, wsId: ws.id, wsName: ws.name }));
            } catch {
              return [] as CrossSearchHit[];
            }
          }),
        );
        const dedup = new Map<string, CrossSearchHit>();
        for (const hit of settled.flat()) {
          const key = `${hit.wsId}:${hit.path}`;
          if (!dedup.has(key)) dedup.set(key, hit);
        }
        setContentHits([...dedup.values()].slice(0, 40));
      } finally {
        setSearchingContent(false);
      }
    },
    [activeWs, workspaces],
  );

  useEffect(() => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      setContentHits([]);
      setSearchingContent(false);
      return;
    }
    const timer = window.setTimeout(() => {
      void executeContentSearch(q, searchAllSpaces);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [searchQuery, searchAllSpaces, executeContentSearch]);

  // ── Load Activity & GitHub Sync when on Activity & Settings view ─────
  const loadGitAndSync = useCallback(async (ws: WorkspaceEntry) => {
    const opts = ws.slug ? { slug: ws.slug } : undefined;
    const [g, rs, tok, members] = await Promise.all([
      readWorkspaceGit(opts).catch(() => null),
      ws.kind === "global" ? Promise.resolve(null) : gitRemoteStatus(opts).catch(() => null),
      ws.kind === "global"
        ? Promise.resolve({ set: false, masked: null })
        : getGitToken().catch(() => ({ set: false, masked: null })),
      ws.kind === "shared" && ws.slug
        ? listWorkspaceMembers(ws.slug).catch(() => [])
        : Promise.resolve([]),
    ]);
    setGitState(g);
    setRemoteStatus(rs);
    setGitToken(tok);
    setSpaceMembers(members);
  }, []);

  useEffect(() => {
    if (activeTab === "sync" && activeWs) {
      void loadGitAndSync(activeWs);
    }
  }, [activeTab, activeWs, loadGitAndSync]);

  // Refresh after inline Ask Tina commits edits
  const handleWorkspaceMutated = useCallback(() => {
    if (!activeWs) return;
    invalidateDocLinkCaches();
    setGraphRefreshKey((k) => k + 1);
    void loadTreeAndMeta(activeWs, true);
    if (selectedPath) void loadDocument(selectedPath, activeWs.slug);
  }, [activeWs, selectedPath, loadTreeAndMeta, loadDocument]);

  // ── In-place [[wikilink]] navigation ─────────────────────────────────
  const handleDocNavigate: DocNavigate = useCallback(
    (detail) => {
      if (!confirmDiscardDraft()) return;
      void (async () => {
        const targetSlug = "slug" in detail ? detail.slug : activeWs?.slug;
        const resolved = await resolveDocRef(
          { path: detail.path, wikilink: detail.wikilink },
          { path: selectedPath ?? undefined, slug: targetSlug },
        );
        if (!resolved) {
          setError(`Page not found: ${detail.wikilink || detail.path || ""}`);
          return;
        }
        if (resolved.slug && resolved.slug !== activeWs?.slug) {
          const match = workspaces.find((w) => w.slug === resolved.slug);
          if (match) setSelectedWsId(match.id);
        }
        setActiveTab("documents");
        setSelectedPath(resolved.path);
      })();
    },
    [activeWs?.slug, selectedPath, workspaces, confirmDiscardDraft],
  );

  // ── Library grouping (non-tech mode) & raw tree (developer view) ─────
  const userVisibleFiles = useMemo(
    () => (devView ? files : files.filter((f) => categorizePath(f) !== "system")),
    [files, devView],
  );

  const groupedLibrary = useMemo(() => {
    const map = new Map<LibraryCategory, string[]>();
    for (const cat of LIBRARY_CATEGORIES) map.set(cat.id, []);
    for (const f of userVisibleFiles) {
      const cat = categorizePath(f);
      if (cat === "system") continue;
      map.set(cat, [...(map.get(cat) ?? []), f]);
    }
    return LIBRARY_CATEGORIES.map((meta) => ({
      meta,
      items: (map.get(meta.id) ?? []).sort((a, b) =>
        friendlyPageTitle(a).localeCompare(friendlyPageTitle(b)),
      ),
    })).filter((g) => g.items.length > 0);
  }, [userVisibleFiles]);

  const titleMatches = useMemo(() => {
    const needle = searchQuery.trim().toLowerCase();
    if (!needle) return [];
    return userVisibleFiles
      .filter((f) => friendlyPageTitle(f).toLowerCase().includes(needle) || f.toLowerCase().includes(needle))
      .slice(0, 12);
  }, [userVisibleFiles, searchQuery]);

  const treeNodes = useMemo(() => buildTree(files), [files]);

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const toggleCategory = (cat: LibraryCategory) => {
    setCollapsedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const openPage = useCallback(
    (path: string, targetWsId?: string) => {
      if (!confirmDiscardDraft()) return;
      if (targetWsId && targetWsId !== activeWs?.id) {
        pendingDeepLinkRef.current = { doc: path };
        setSelectedWsId(targetWsId);
      }
      setEditing(false);
      setSelectedPath(path);
      setActiveTab("documents");
      setMobileRailOpen(false);
    },
    [activeWs?.id, confirmDiscardDraft],
  );

  // ── Document mutations ───────────────────────────────────────────────
  const handleSaveDoc = useCallback(async () => {
    if (!selectedPath || !doc?.writable || !activeWs) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const titleLabel = friendlyPageTitle(selectedPath, draft);
      const res = await saveWorkspaceDocument({
        path: selectedPath,
        content: draft,
        expected_sha256: doc.sha256 || null,
        slug: activeWs.slug,
        commit: devView ? commitOnSave : true,
        commit_message: (devView && commitMsg.trim()) || `Update ${titleLabel}`,
      });
      setDoc({ content: draft, sha256: res.sha256, writable: true });
      setEditing(false);
      setCommitMsg("");
      invalidateDocLinkCaches();
      setGraphRefreshKey((k) => k + 1);
      setNotice(
        devView && res.commit
          ? `Saved & committed (${res.commit.slice(0, 7)})`
          : res.commit_error || "Saved your changes.",
      );
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  }, [selectedPath, doc, activeWs, draft, devView, commitOnSave, commitMsg]);

  const handleCreateDoc = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeWs || activeWs.readOnly) return;
    const tpl = buildNewPageTemplate(newDocKind, newDocTitle);
    const targetPath = (devView && newDocCustomPath.trim() ? newDocCustomPath.trim() : tpl.path).replace(/^\/+/, "");
    if (!targetPath.endsWith(".md")) {
      setNewDocError("Page path must end with .md");
      return;
    }
    if (files.includes(targetPath)) {
      setNewDocError("A page with this name already exists in this section. Choose a different title.");
      return;
    }
    setBusy(true);
    setNewDocError(null);
    setError(null);
    setNotice(null);
    try {
      await saveWorkspaceDocument({
        path: targetPath,
        content: tpl.content,
        expected_sha256: null,
        slug: activeWs.slug,
        commit: true,
        commit_message: `Create ${newDocTitle.trim() || friendlyPageTitle(targetPath)}`,
      });
      invalidateDocLinkCaches();
      setGraphRefreshKey((k) => k + 1);
      setNewDocOpen(false);
      setNewDocTitle("");
      setNewDocCustomPath("");
      setNewDocError(null);
      await loadTreeAndMeta(activeWs, true);
      setActiveTab("documents");
      setSelectedPath(targetPath);
      setNotice(`Created "${newDocTitle.trim() || friendlyPageTitle(targetPath)}".`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setNewDocError("A page with this name already exists in this section. Choose a different title.");
      } else {
        setNewDocError(presentError(err).headline);
      }
    } finally {
      setBusy(false);
    }
  };

  const openMoveDialog = () => {
    if (!selectedPath) return;
    setPageMenuOpen(false);
    setMoveName(friendlyPageTitle(selectedPath, doc?.content));
    setMoveSection(sectionFromPath(selectedPath));
    setMoveDest(selectedPath);
    setMovePreview(null);
    setMoveError(null);
    setMoveOpen(true);
  };

  const effectiveMoveDest = devView
    ? moveDest.trim()
    : buildFriendlyMovePath(moveSection, moveName || "Untitled");

  const ensureEntityBeforeMove = async (): Promise<string> => {
    if (!selectedPath || !doc?.sha256 || !activeWs) return doc?.sha256 ?? "";
    const upgraded = ensureEntityFrontmatterForPath(
      doc.content,
      effectiveMoveDest,
      devView ? undefined : moveName,
    );
    if (upgraded === doc.content) return doc.sha256;
    const saved = await saveWorkspaceDocument({
      path: selectedPath,
      content: upgraded,
      expected_sha256: doc.sha256,
      slug: activeWs.slug,
      commit: false,
      commit_message: `Prepare ${friendlyPageTitle(effectiveMoveDest)} entity metadata`,
    });
    setDoc({ content: upgraded, sha256: saved.sha256, writable: doc.writable });
    setDraft(upgraded);
    return saved.sha256;
  };

  const handlePreviewMove = async () => {
    if (!selectedPath || !doc?.sha256 || !effectiveMoveDest || !activeWs) return;
    setBusy(true);
    setMoveError(null);
    setError(null);
    try {
      const currentSha = await ensureEntityBeforeMove();
      const preview = await previewMoveWorkspaceDocument({
        path: selectedPath,
        destination: effectiveMoveDest,
        expected_sha256: currentSha,
        slug: activeWs.slug,
        update_links: moveUpdateLinks,
      });
      setMovePreview(preview);
    } catch (err) {
      setMoveError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmMove = async () => {
    if (!selectedPath || !doc?.sha256 || !effectiveMoveDest || !activeWs) return;
    setBusy(true);
    setMoveError(null);
    setError(null);
    setNotice(null);
    try {
      const currentSha = await ensureEntityBeforeMove();
      let plan = movePreview;
      // In non-tech mode (or if frontmatter was just upgraded), automatically preview + apply in one click.
      if (moveUpdateLinks && (!plan || currentSha !== doc.sha256)) {
        plan = await previewMoveWorkspaceDocument({
          path: selectedPath,
          destination: effectiveMoveDest,
          expected_sha256: currentSha,
          slug: activeWs.slug,
          update_links: true,
        });
      }
      const res = await moveWorkspaceDocument({
        path: selectedPath,
        destination: effectiveMoveDest,
        expected_sha256: currentSha,
        slug: activeWs.slug,
        update_links: moveUpdateLinks && Boolean(plan),
        expected_plan: plan?.fingerprint ?? null,
      });
      invalidateDocLinkCaches();
      setGraphRefreshKey((k) => k + 1);
      setMoveOpen(false);
      setMovePreview(null);
      setMoveError(null);
      await loadTreeAndMeta(activeWs, false);
      setSelectedPath(res.path);
      setNotice(
        res.updated_links
          ? `Moved to "${friendlyPageTitle(res.path)}" and updated ${res.updated_links} link(s).`
          : `Moved to "${friendlyPageTitle(res.path)}".`,
      );
    } catch (err) {
      setMoveError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteDoc = async () => {
    if (!selectedPath || !doc?.sha256 || !doc.writable || !activeWs) return;
    setPageMenuOpen(false);
    const label = friendlyPageTitle(selectedPath, doc.content);
    if (typeof window !== "undefined" && !window.confirm(`Delete "${label}"? This cannot be undone.`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await deleteWorkspaceDocument({
        path: selectedPath,
        expected_sha256: doc.sha256,
        slug: activeWs.slug,
      });
      invalidateDocLinkCaches();
      setGraphRefreshKey((k) => k + 1);
      setNotice(`Deleted "${label}".`);
      await loadTreeAndMeta(activeWs, false);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const performUpload = useCallback(
    async (fileList: File[]) => {
      if (!fileList.length || !activeWs || activeWs.readOnly) return;
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const res = await uploadWorkspaceFiles(fileList, activeWs.slug ? { slug: activeWs.slug } : undefined);
        invalidateDocLinkCaches();
        await loadTreeAndMeta(activeWs, true);
        setNotice(`Uploaded ${res.files.length} file(s) to ${activeWs.name}.`);
      } catch (err) {
        setError(presentError(err).headline);
      } finally {
        setBusy(false);
      }
    },
    [activeWs, loadTreeAndMeta],
  );

  const handleUploadChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    await performUpload(selected);
  };

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (activeWs?.readOnly || !e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (activeWs?.readOnly || !e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (!dragActive) return;
    e.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (activeWs?.readOnly) return;
    const dropped = Array.from(e.dataTransfer?.files ?? []);
    if (dropped.length) void performUpload(dropped);
  };

  // ── Space & GitHub Sync mutations ────────────────────────────────────
  const runAction = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice(ok);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const handleCreateWorkspace = async (e: FormEvent) => {
    e.preventDefault();
    const label = newWsName.trim();
    if (!label) return;
    setBusy(true);
    setCreateWsError(null);
    setError(null);
    setNotice(null);
    try {
      if (newWsShared) {
        const created = await createSharedWorkspace(label);
        await loadWorkspaces();
        setSelectedWsId(`shared:${created.workspace_id}`);
      } else {
        const created = await createWorkspace(label);
        await loadWorkspaces();
        setSelectedWsId(`extra:${created.slug}`);
      }
      setNewWsName("");
      setCreateWsOpen(false);
      setCreateWsError(null);
      setActiveTab("documents");
      setSelectedPath(null);
      setNotice(`Created ${newWsShared ? "team" : "private"} space "${label}".`);
    } catch (err) {
      setCreateWsError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const handleToggleMount = (ws: WorkspaceEntry) => {
    if (ws.kind === "global") return;
    void runAction(async () => {
      if (ws.kind === "shared" && ws.slug) {
        await setSharedActive(ws.slug, !ws.mounted);
      } else if (ws.slotSlug) {
        if (ws.mounted) await deactivateWorkspace(ws.slotSlug);
        else await activateWorkspace({ slug: ws.slotSlug });
      }
      invalidateDocLinkCaches();
      await loadWorkspaces();
    }, ws.mounted ? `Paused Tina access for "${ws.name}".` : `Tina can now read "${ws.name}".`);
  };

  const pruneHistoryForWorkspace = useCallback((removedWsId: string) => {
    setNavHistory((prev) => {
      const filtered = prev.filter((item) => item.wsId !== removedWsId);
      setNavIndex((idx) => Math.min(idx, filtered.length - 1));
      return filtered;
    });
  }, []);

  const handleArchiveSpace = (ws: WorkspaceEntry) => {
    if (ws.kind !== "extra" || !ws.slotSlug) return;
    if (!confirmDiscardDraft()) return;
    void runAction(async () => {
      await archiveWorkspace(ws.slotSlug!, true);
      invalidateDocLinkCaches();
      await loadWorkspaces();
      pruneHistoryForWorkspace(ws.id);
      setSelectedPath(null);
      setEditing(false);
      setInviteLink(null);
      setSelectedWsId("personal");
    }, `Archived "${ws.name}". You can restore or delete it anytime under Archived Spaces.`);
  };

  const handleRestoreArchivedSpace = (entry: ArchivedSpaceEntry) => {
    void runAction(async () => {
      await archiveWorkspace(entry.slotSlug, false);
      invalidateDocLinkCaches();
      await loadWorkspaces();
      setSelectedWsId(`extra:${entry.slotSlug}`);
    }, `Restored "${entry.name}".`);
  };

  const isDeleteConfirmMatch = useMemo(() => {
    if (lifecycleModal?.action !== "delete") return false;
    const typed = deleteConfirmInput.trim().toLowerCase();
    if (!typed) return false;
    return (
      typed === lifecycleModal.name.trim().toLowerCase() ||
      typed === lifecycleModal.rawName.trim().toLowerCase()
    );
  }, [lifecycleModal, deleteConfirmInput]);

  const handleConfirmLifecycleModal = async (e: FormEvent) => {
    e.preventDefault();
    if (!lifecycleModal) return;
    if (lifecycleModal.action === "delete" && !isDeleteConfirmMatch) return;

    setBusy(true);
    setLifecycleError(null);
    setError(null);
    setNotice(null);
    try {
      if (lifecycleModal.action === "delete") {
        if (lifecycleModal.kind === "shared") {
          const unshared = await unshareWorkspace(lifecycleModal.slug);
          try {
            await deleteWorkspace(unshared.slug);
          } catch (delErr) {
            invalidateDocLinkCaches();
            await loadWorkspaces();
            pruneHistoryForWorkspace(`shared:${lifecycleModal.slug}`);
            setSelectedWsId(`extra:${unshared.slug}`);
            setSelectedPath(null);
            setEditing(false);
            setInviteLink(null);
            setLifecycleModal({
              action: "delete",
              kind: "extra",
              slug: unshared.slug,
              name: lifecycleModal.name,
              rawName: lifecycleModal.rawName,
            });
            setLifecycleError(
              `Stopped sharing "${lifecycleModal.name}", but final deletion failed: ${presentError(delErr).headline}. It is now in your Private spaces — click "Permanently delete" again to retry.`,
            );
            return;
          }
          invalidateDocLinkCaches();
          await loadWorkspaces();
          pruneHistoryForWorkspace(`shared:${lifecycleModal.slug}`);
          setSelectedWsId("personal");
          setSelectedPath(null);
          setEditing(false);
          setInviteLink(null);
        } else {
          await deleteWorkspace(lifecycleModal.slug);
          invalidateDocLinkCaches();
          await loadWorkspaces();
          if (lifecycleModal.kind === "extra") {
            pruneHistoryForWorkspace(`extra:${lifecycleModal.slug}`);
            if (activeWs?.id === `extra:${lifecycleModal.slug}`) {
              setSelectedWsId("personal");
              setSelectedPath(null);
              setEditing(false);
              setInviteLink(null);
            }
          }
        }
        const deletedName = lifecycleModal.name;
        setLifecycleModal(null);
        setDeleteConfirmInput("");
        setNotice(`Permanently deleted "${deletedName}".`);
      } else if (lifecycleModal.action === "unshare") {
        const res = await unshareWorkspace(lifecycleModal.workspaceId);
        invalidateDocLinkCaches();
        await loadWorkspaces();
        pruneHistoryForWorkspace(`shared:${lifecycleModal.workspaceId}`);
        setSelectedWsId(`extra:${res.slug}`);
        setSelectedPath(null);
        setEditing(false);
        setInviteLink(null);
        const unsharedName = lifecycleModal.name;
        setLifecycleModal(null);
        setNotice(`Stopped sharing "${unsharedName}". It is now a private space.`);
      } else if (lifecycleModal.action === "leave") {
        await leaveWorkspace(lifecycleModal.workspaceId);
        invalidateDocLinkCaches();
        await loadWorkspaces();
        pruneHistoryForWorkspace(`shared:${lifecycleModal.workspaceId}`);
        setSelectedWsId("personal");
        setSelectedPath(null);
        setEditing(false);
        setInviteLink(null);
        const leftName = lifecycleModal.name;
        setLifecycleModal(null);
        setNotice(`Left "${leftName}".`);
      }
    } catch (err) {
      setLifecycleError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const loadDiffIfNeeded = async (sha: string) => {
    if (diffsBySha[sha] || !activeWs) return;
    try {
      const res = await readWorkspaceGitDiff({ sha, slug: activeWs.slug });
      setDiffsBySha((prev) => ({ ...prev, [sha]: res.diff || "(no diff)" }));
    } catch (err) {
      setDiffsBySha((prev) => ({ ...prev, [sha]: `Could not load details: ${presentError(err).headline}` }));
    }
  };

  const handleToggleCommitRow = async (sha: string) => {
    if (expandedSha === sha) {
      setExpandedSha(null);
      return;
    }
    setExpandedSha(sha);
    if (devView) {
      setShowDiffSha(sha);
      await loadDiffIfNeeded(sha);
    }
  };

  const scrollToHeading = (headingText: string) => {
    const container = docProseRef.current;
    if (!container) return;
    const candidates = Array.from(container.querySelectorAll<HTMLElement>("h1, h2, h3, h4"));
    const match = candidates.find(
      (el) => (el.textContent || "").trim().toLowerCase() === headingText.toLowerCase(),
    );
    match?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  const renderRawTree = (nodes: TreeNode[], depth = 0): ReactNode =>
    nodes.map((node) => {
      if (node.isDir) {
        const isOpen = expandedDirs.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              className={styles.treeRow}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => toggleDir(node.path)}
              aria-expanded={isOpen}
            >
              <WebIcon name={isOpen ? "chevronDown" : "chevronRight"} size={12} />
              <WebIcon name="folder" size={13} />
              <span className={styles.treeLabel}>{node.name}</span>
              <span className={styles.treeCount}>{node.children.length}</span>
            </button>
            {isOpen && renderRawTree(node.children, depth + 1)}
          </div>
        );
      }
      const isSelected = selectedPath === node.path && activeTab === "documents";
      return (
        <button
          key={node.path}
          type="button"
          className={`${styles.treeRow} ${isSelected ? styles.treeRowActive : ""}`}
          style={{ paddingLeft: 22 + depth * 14 }}
          onClick={() => openPage(node.path)}
        >
          <WebIcon name="fileText" size={13} />
          <span className={styles.treeLabel} title={node.path}>
            {node.name}
          </span>
        </button>
      );
    });

  const isSearching = searchQuery.trim().length > 0;
  const openPageCategory = selectedPath ? CATEGORY_BY_ID[categorizePath(selectedPath)] : null;
  const openPageTitle = selectedPath ? parsedDoc?.displayTitle || friendlyPageTitle(selectedPath) : null;
  const isFilePreview = Boolean(selectedPath && isUploadedOrNonMarkdown(selectedPath));
  const showOutlineRail =
    Boolean(selectedPath) &&
    !editing &&
    !copilotOpen &&
    !isFilePreview &&
    (outlineHeadings.length > 0 || backlinks.length > 0 || backlinksLoading);

  const privateSpaces = workspaces.filter((w) => w.kind === "personal" || w.kind === "extra");
  const teamSpaces = workspaces.filter((w) => w.kind === "shared");
  const globalSpace = workspaces.find((w) => w.kind === "global");
  const sharedOwnerCount = useMemo(
    () => spaceMembers.filter((m) => m.role === "owner").length,
    [spaceMembers],
  );
  const canOwnerLeaveShared = Boolean(
    activeWs?.kind === "shared" && activeWs.role === "owner" && sharedOwnerCount > 1,
  );
  const canDeleteActiveSpace = Boolean(
    activeWs &&
      ((activeWs.kind === "extra" && activeWs.slotSlug) ||
        (activeWs.kind === "shared" && activeWs.slug && activeWs.role === "owner")),
  );
  const canLeaveActiveSpace = Boolean(
    activeWs && activeWs.kind === "shared" && activeWs.slug && activeWs.role !== "owner",
  );
  const recentCards = useMemo(() => userVisibleFiles.slice(0, 8), [userVisibleFiles]);
  const mappablePageCount = useMemo(
    () => userVisibleFiles.filter((f) => f.toLowerCase().endsWith(".md")).length,
    [userVisibleFiles],
  );

  return (
    <div
      className={`${styles.shell} ${dragActive ? styles.dropActive : ""}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        aria-label="Upload files"
        onChange={handleUploadChange}
      />

      {dragActive && activeWs && !activeWs.readOnly && (
        <div className={styles.dropOverlay} aria-hidden="true">
          <div className={styles.dropBadge}>
            <WebIcon name="upload" size={20} />
            <span>Drop files to add them to {activeWs.name}</span>
          </div>
        </div>
      )}

      {/* ── Left Notion-Style Library Sidebar ── */}
      <aside className={`${styles.rail} ${mobileRailOpen ? styles.railOpen : ""}`} aria-label="Knowledge library">
        {/* Compact Workspace Switcher Dropdown */}
        <div className={styles.railTop}>
          <div className={styles.wsPickerWrap} onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className={styles.wsPickerBtn}
              aria-haspopup="menu"
              aria-expanded={wsMenuOpen}
              aria-label={`Switch space, current space ${activeWs?.name || "My Space"}`}
              onClick={() => setWsMenuOpen((v) => !v)}
            >
              <span
                className={`${styles.wsAvatar} ${
                  activeWs?.kind === "global"
                    ? styles.wsAvatarGlobal
                    : activeWs?.kind === "shared"
                      ? styles.wsAvatarShared
                      : ""
                }`}
              >
                <WebIcon
                  name={
                    activeWs?.kind === "global"
                      ? "bookOpen"
                      : activeWs?.kind === "shared"
                        ? "users"
                        : "layers"
                  }
                  size={13}
                />
              </span>
              <span className={styles.wsPickerText}>
                <span className={styles.wsPickerName}>{activeWs?.name || "My Space"}</span>
                <span className={styles.wsPickerMeta}>{activeWs?.roleLabel || "Private"}</span>
              </span>
              <WebIcon name="chevronDown" size={14} />
            </button>

            {wsMenuOpen && (
              <div className={styles.wsDropdown} role="menu" aria-label="Spaces menu">
                <div className={styles.wsDropdownGroup}>Private</div>
                {privateSpaces.map((ws) => (
                  <button
                    key={ws.id}
                    type="button"
                    role="menuitem"
                    aria-current={ws.id === activeWs?.id ? "true" : undefined}
                    className={`${styles.wsDropdownItem} ${ws.id === activeWs?.id ? styles.wsDropdownItemActive : ""}`}
                    onClick={() => {
                      if (!confirmDiscardDraft()) return;
                      setSelectedWsId(ws.id);
                      setActiveTab("documents");
                      setSelectedPath(null);
                      setWsMenuOpen(false);
                      setMobileRailOpen(false);
                    }}
                  >
                    <span className={`${styles.wsDot} ${ws.mounted ? styles.wsDotMounted : ""}`} />
                    <span className={styles.wsName}>{ws.name}</span>
                    {ws.id === activeWs?.id && <WebIcon name="check" size={13} />}
                  </button>
                ))}

                {teamSpaces.length > 0 && (
                  <>
                    <div className={styles.wsDropdownGroup}>Team Spaces</div>
                    {teamSpaces.map((ws) => (
                      <button
                        key={ws.id}
                        type="button"
                        role="menuitem"
                        aria-current={ws.id === activeWs?.id ? "true" : undefined}
                        className={`${styles.wsDropdownItem} ${ws.id === activeWs?.id ? styles.wsDropdownItemActive : ""}`}
                        onClick={() => {
                          if (!confirmDiscardDraft()) return;
                          setSelectedWsId(ws.id);
                          setActiveTab("documents");
                          setSelectedPath(null);
                          setWsMenuOpen(false);
                          setMobileRailOpen(false);
                        }}
                      >
                        <span className={`${styles.wsDot} ${ws.mounted ? styles.wsDotMounted : ""}`} />
                        <span className={styles.wsName}>{ws.name}</span>
                        <span className={`${styles.wsTag} ${styles.wsTagShared}`}>{ws.roleLabel}</span>
                      </button>
                    ))}
                  </>
                )}

                {globalSpace && (
                  <>
                    <div className={styles.wsDropdownGroup}>Library</div>
                    <button
                      type="button"
                      role="menuitem"
                      aria-current={globalSpace.id === activeWs?.id ? "true" : undefined}
                      className={`${styles.wsDropdownItem} ${globalSpace.id === activeWs?.id ? styles.wsDropdownItemActive : ""}`}
                      onClick={() => {
                        if (!confirmDiscardDraft()) return;
                        setSelectedWsId(globalSpace.id);
                        setActiveTab("documents");
                        setSelectedPath(null);
                        setWsMenuOpen(false);
                        setMobileRailOpen(false);
                      }}
                    >
                      <span className={`${styles.wsDot} ${styles.wsDotGlobal}`} />
                      <span className={styles.wsName}>{globalSpace.name}</span>
                      <span className={`${styles.wsTag} ${styles.wsTagGlobal}`}>View only</span>
                    </button>
                  </>
                )}

                <div className={styles.wsDropdownDivider} />
                {activeWs && activeWs.kind !== "global" && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.wsDropdownActionMuted}
                    onClick={() => {
                      if (!confirmDiscardDraft()) return;
                      setWsMenuOpen(false);
                      setActiveTab("sync");
                      setMobileRailOpen(false);
                    }}
                  >
                    <WebIcon name="sliders" size={13} />
                    <span>Space settings</span>
                  </button>
                )}
                {archivedSpaces.length > 0 && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.wsDropdownActionMuted}
                    onClick={() => {
                      if (!confirmDiscardDraft()) return;
                      setWsMenuOpen(false);
                      setActiveTab("sync");
                      setMobileRailOpen(false);
                      window.setTimeout(() => {
                        archivedSectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                      }, 40);
                    }}
                  >
                    <WebIcon name="rotateCcw" size={13} />
                    <span className={styles.wsName}>Archived spaces</span>
                    <span className={styles.wsTag}>{archivedSpaces.length}</span>
                  </button>
                )}
                {canDeleteActiveSpace && activeWs && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.wsDropdownActionDanger}
                    onClick={() => {
                      if (!confirmDiscardDraft()) return;
                      setWsMenuOpen(false);
                      setMobileRailOpen(false);
                      openLifecycleModal({
                        action: "delete",
                        kind: activeWs.kind === "shared" ? "shared" : "extra",
                        slug: activeWs.kind === "shared" ? activeWs.slug! : activeWs.slotSlug!,
                        name: activeWs.name,
                        rawName: activeWs.rawName,
                      });
                    }}
                  >
                    <WebIcon name="trash" size={13} />
                    <span>Delete this space</span>
                  </button>
                )}
                {canLeaveActiveSpace && activeWs && (
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.wsDropdownActionDanger}
                    onClick={() => {
                      if (!confirmDiscardDraft()) return;
                      setWsMenuOpen(false);
                      setMobileRailOpen(false);
                      openLifecycleModal({
                        action: "leave",
                        workspaceId: activeWs.slug!,
                        name: activeWs.name,
                      });
                    }}
                  >
                    <WebIcon name="logout" size={13} />
                    <span>Leave this space</span>
                  </button>
                )}
                <div className={styles.wsDropdownDivider} />
                <button
                  type="button"
                  role="menuitem"
                  className={styles.wsDropdownAction}
                  onClick={() => {
                    setWsMenuOpen(false);
                    setCreateWsOpen(true);
                  }}
                >
                  <WebIcon name="plus" size={13} />
                  <span>Create new space</span>
                </button>
              </div>
            )}
          </div>

          {/* Single Unified Smart Search */}
          <form
            className={styles.searchForm}
            onSubmit={(e) => {
              e.preventDefault();
              void executeContentSearch(searchQuery, searchAllSpaces);
            }}
          >
            <div className={styles.searchBox}>
              <WebIcon name="search" size={13} />
              <input
                type="search"
                aria-label="Search knowledge"
                placeholder="Search pages & content…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => {
                    setSearchQuery("");
                    setContentHits([]);
                  }}
                >
                  <WebIcon name="close" size={12} />
                </button>
              )}
            </div>
            {isSearching && (
              <label className={styles.searchScopeToggle}>
                <input
                  type="checkbox"
                  checked={searchAllSpaces}
                  onChange={(e) => setSearchAllSpaces(e.target.checked)}
                />
                <span>Search all spaces</span>
              </label>
            )}
          </form>

          {/* Primary Actions Row */}
          {!activeWs?.readOnly && (
            <div className={styles.railPrimaryActions}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                style={{ flex: 1, justifyContent: "center" }}
                onClick={() => {
                  setNewDocKind("wiki");
                  setNewDocOpen(true);
                }}
              >
                <WebIcon name="plus" size={13} />
                <span>New page</span>
              </button>
              <button
                type="button"
                className={styles.btn}
                title="Upload files (or drag and drop anywhere)"
                aria-label="Upload file"
                onClick={() => fileInputRef.current?.click()}
              >
                <WebIcon name="upload" size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Navigation & Library Tree */}
        <div className={styles.treeWrap}>
          {isSearching ? (
            <div className={styles.searchResultsWrap}>
              {titleMatches.length > 0 && (
                <>
                  <div className={styles.railGroupTitle}>Matching pages</div>
                  {titleMatches.map((path) => {
                    const cat = CATEGORY_BY_ID[categorizePath(path)];
                    return (
                      <button
                        key={`title:${path}`}
                        type="button"
                        className={styles.treeRow}
                        onClick={() => openPage(path)}
                      >
                        <WebIcon name={cat.icon} size={13} />
                        <span className={styles.treeLabel}>{friendlyPageTitle(path)}</span>
                        <span className={styles.treeCount}>{cat.singular}</span>
                      </button>
                    );
                  })}
                </>
              )}

              <div className={styles.railGroupTitle} style={{ marginTop: titleMatches.length ? 10 : 0 }}>
                {searchingContent ? "Searching inside pages…" : `Inside pages (${contentHits.length})`}
              </div>
              {contentHits.map((hit) => (
                <button
                  key={`${hit.wsId}:${hit.path}:${hit.line}`}
                  type="button"
                  className={styles.searchHit}
                  onClick={() => openPage(hit.path, hit.wsId)}
                >
                  <span className={styles.searchHitMeta}>
                    <span className={styles.treeLabel}>
                      {searchAllSpaces ? `${hit.wsName} · ${friendlyPageTitle(hit.path)}` : friendlyPageTitle(hit.path)}
                    </span>
                    {devView && <span>L{hit.line}</span>}
                  </span>
                  <span className={styles.searchHitText}>{hit.text}</span>
                </button>
              ))}
              {!searchingContent && titleMatches.length === 0 && contentHits.length === 0 && (
                <p className={styles.cardSub} style={{ padding: "8px 6px" }}>
                  No pages or text matched “{searchQuery.trim()}”.
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Top Space Views */}
              <div className={styles.railQuickNav}>
                <button
                  type="button"
                  className={`${styles.treeRow} ${activeTab === "documents" && !selectedPath ? styles.treeRowActive : ""}`}
                  onClick={() => {
                    if (!confirmDiscardDraft()) return;
                    setActiveTab("documents");
                    setSelectedPath(null);
                    setEditing(false);
                    setMobileRailOpen(false);
                  }}
                >
                  <WebIcon name="home" size={14} />
                  <span className={styles.treeLabel}>Overview</span>
                </button>
                <button
                  type="button"
                  className={`${styles.treeRow} ${activeTab === "graph" ? styles.treeRowActive : ""}`}
                  onClick={() => {
                    if (!confirmDiscardDraft()) return;
                    setActiveTab("graph");
                    setMobileRailOpen(false);
                  }}
                >
                  <WebIcon name="network" size={14} />
                  <span className={styles.treeLabel}>Connections Map</span>
                  {mappablePageCount > 0 && <span className={styles.treeCount}>{mappablePageCount}</span>}
                </button>
              </div>

              <div className={styles.railDivider} />

              {treeLoading || wsLoading ? (
                <p className={styles.cardSub} style={{ padding: "10px 8px" }}>
                  Loading library…
                </p>
              ) : devView ? (
                <>
                  <div className={styles.railGroupTitle}>
                    <span>Raw files ({files.length})</span>
                    <span className={styles.devPill}>Dev</span>
                  </div>
                  {treeNodes.length ? (
                    renderRawTree(treeNodes)
                  ) : (
                    <p className={styles.cardSub} style={{ padding: "8px 6px" }}>
                      No files in this space.
                    </p>
                  )}
                </>
              ) : groupedLibrary.length > 0 ? (
                groupedLibrary.map(({ meta, items }) => {
                  const collapsed = collapsedCats.has(meta.id);
                  return (
                    <div key={meta.id} className={styles.catGroup}>
                      <button
                        type="button"
                        className={styles.catHeader}
                        aria-expanded={!collapsed}
                        onClick={() => toggleCategory(meta.id)}
                      >
                        <WebIcon name={collapsed ? "chevronRight" : "chevronDown"} size={11} />
                        <span className={styles.treeLabel}>{meta.label}</span>
                        <span className={styles.treeCount}>{items.length}</span>
                      </button>
                      {!collapsed &&
                        items.map((path) => {
                          const isSelected = selectedPath === path && activeTab === "documents";
                          return (
                            <button
                              key={path}
                              type="button"
                              className={`${styles.treeRow} ${isSelected ? styles.treeRowActive : ""}`}
                              style={{ paddingLeft: 18 }}
                              onClick={() => openPage(path)}
                            >
                              <WebIcon name={meta.icon} size={13} />
                              <span className={styles.treeLabel}>{friendlyPageTitle(path)}</span>
                            </button>
                          );
                        })}
                    </div>
                  );
                })
              ) : (
                <p className={styles.cardSub} style={{ padding: "10px 8px" }}>
                  No pages yet. Click “New page” to get started.
                </p>
              )}
            </>
          )}
        </div>

        {/* Pinned Sidebar Footer: Activity & Settings + Subtle Developer View Switch */}
        <div className={styles.railFooter}>
          <button
            type="button"
            className={`${styles.treeRow} ${activeTab === "sync" ? styles.treeRowActive : ""}`}
            onClick={() => {
              if (!confirmDiscardDraft()) return;
              setActiveTab("sync");
              setMobileRailOpen(false);
            }}
          >
            <WebIcon name="sliders" size={14} />
            <span className={styles.treeLabel}>Activity &amp; Settings</span>
          </button>

          <button
            type="button"
            role="switch"
            aria-checked={devView}
            className={styles.devSwitchRow}
            onClick={toggleDevView}
            title="Show raw file paths, Markdown/YAML, and Git details"
          >
            <span className={styles.devSwitchLabel}>
              <WebIcon name="terminal" size={12} />
              <span>Developer view</span>
            </span>
            <span className={`${styles.switchTrack} ${devView ? styles.switchTrackOn : ""}`} aria-hidden="true">
              <span className={styles.switchThumb} />
            </span>
          </button>
        </div>
      </aside>

      {/* ── Main Content Stage (Single Clean Top Bar!) ── */}
      <section className={styles.main}>
        <header className={styles.topBar}>
          <div className={styles.topBarLeft}>
            <button
              type="button"
              className={styles.mobileRailBtn}
              aria-label="Toggle library sidebar"
              onClick={() => setMobileRailOpen((v) => !v)}
            >
              <WebIcon name="sidebar" size={15} />
            </button>

            <div className={styles.historyBtns}>
              <button
                type="button"
                className={styles.iconGhostBtn}
                aria-label="Back in reading history"
                title="Back (Alt+←)"
                disabled={!canGoBack}
                onClick={() => goHistory(-1)}
              >
                <WebIcon name="arrowLeft" size={13} />
              </button>
              <button
                type="button"
                className={styles.iconGhostBtn}
                aria-label="Forward in reading history"
                title="Forward (Alt+→)"
                disabled={!canGoForward}
                onClick={() => goHistory(1)}
              >
                <WebIcon name="chevronRight" size={13} />
              </button>
            </div>

            <nav className={styles.humanBreadcrumb} aria-label="Location">
              <button
                type="button"
                className={styles.crumbBtn}
                onClick={() => {
                  if (!confirmDiscardDraft()) return;
                  setActiveTab("documents");
                  setSelectedPath(null);
                  setEditing(false);
                }}
              >
                {activeWs?.name || "My Space"}
              </button>

              {activeTab === "graph" && (
                <>
                  <span className={styles.crumbSep}>/</span>
                  <span className={styles.crumbCurrent}>Connections Map</span>
                </>
              )}

              {activeTab === "sync" && (
                <>
                  <span className={styles.crumbSep}>/</span>
                  <span className={styles.crumbCurrent}>Activity &amp; Settings</span>
                </>
              )}

              {activeTab === "documents" && selectedPath && (
                <>
                  {openPageCategory && (
                    <>
                      <span className={styles.crumbSep}>/</span>
                      <span className={styles.crumbSection}>{openPageCategory.label}</span>
                    </>
                  )}
                  <span className={styles.crumbSep}>/</span>
                  <span className={styles.crumbCurrent} title={devView ? selectedPath : openPageTitle || undefined}>
                    {devView ? selectedPath : openPageTitle}
                  </span>
                </>
              )}
            </nav>
          </div>

          <div className={styles.topBarActions}>
            <button
              type="button"
              className={`${styles.btn} ${copilotOpen ? styles.btnPrimary : ""}`}
              aria-pressed={copilotOpen}
              onClick={() => setCopilotOpen((v) => !v)}
            >
              <WebIcon name="tinaAsk" size={14} />
              <span>Ask Tina</span>
            </button>

            {activeTab === "documents" && selectedPath && doc?.writable && !editing && !isFilePreview && (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => {
                  setDraft(doc.content);
                  setEditing(true);
                }}
              >
                <WebIcon name="edit" size={13} />
                <span>Edit</span>
              </button>
            )}

            {activeTab === "documents" && selectedPath && (
              <div style={{ position: "relative" }} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={styles.iconGhostBtn}
                  aria-label="Page actions"
                  aria-haspopup="menu"
                  aria-expanded={pageMenuOpen}
                  onClick={() => setPageMenuOpen((v) => !v)}
                >
                  <WebIcon name="moreHorizontal" size={16} />
                </button>
                {pageMenuOpen && (
                  <div className={styles.pageMenu} role="menu" aria-label="Page options">
                    {doc?.writable && !isFilePreview && (
                      <button type="button" role="menuitem" className={styles.pageMenuItem} onClick={openMoveDialog}>
                        <WebIcon name="folder" size={13} />
                        <span>Rename or move</span>
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.pageMenuItem}
                      onClick={() => {
                        setPageMenuOpen(false);
                        if (typeof window !== "undefined") {
                          void navigator.clipboard?.writeText(window.location.href);
                          setNotice("Copied page link to clipboard.");
                        }
                      }}
                    >
                      <WebIcon name="copy" size={13} />
                      <span>Copy link</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className={styles.pageMenuItem}
                      onClick={() => {
                        setPageMenuOpen(false);
                        setActiveTab("sync");
                      }}
                    >
                      <WebIcon name="clock" size={13} />
                      <span>View version history</span>
                    </button>
                    {doc?.writable && (
                      <>
                        <div className={styles.wsDropdownDivider} />
                        <button
                          type="button"
                          role="menuitem"
                          className={`${styles.pageMenuItem} ${styles.pageMenuDanger}`}
                          onClick={() => void handleDeleteDoc()}
                        >
                          <WebIcon name="trash" size={13} />
                          <span>Delete page</span>
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        {(error || notice) && (
          <div className={styles.bannerRow}>
            {error && (
              <div role="alert" className={`${styles.alert} ${styles.alertDanger}`}>
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
                  <WebIcon name="close" size={13} />
                </button>
              </div>
            )}
            {notice && (
              <div role="status" className={`${styles.alert} ${styles.alertSuccess}`}>
                <span>{notice}</span>
                <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notice">
                  <WebIcon name="close" size={13} />
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── VIEW 1: LIBRARY OVERVIEW OR PAGE READER / EDITOR ── */}
        {activeTab === "documents" && (
          <div className={styles.docPane}>
            {!selectedPath ? (
              /* ── NOTION-STYLE LIBRARY OVERVIEW DASHBOARD ── */
              <div className={styles.docScroll}>
                <div className={styles.overviewWrap}>
                  <div className={styles.overviewHero}>
                    <div>
                      <div className={styles.overviewBadges}>
                        <span
                          className={`${styles.wsTag} ${
                            activeWs?.kind === "global"
                              ? styles.wsTagGlobal
                              : activeWs?.kind === "shared"
                                ? styles.wsTagShared
                                : ""
                          }`}
                        >
                          {activeWs?.kind === "global"
                            ? "Built-in · View only"
                            : activeWs?.kind === "shared"
                              ? `Team space · ${activeWs.roleLabel}`
                              : "Private space"}
                        </span>
                        {activeWs && activeWs.kind !== "global" && (
                          <button
                            type="button"
                            className={styles.tinaAccessPill}
                            disabled={busy}
                            onClick={() => handleToggleMount(activeWs)}
                            title="Choose whether Tina can read and cite pages from this space"
                          >
                            <span className={`${styles.wsDot} ${activeWs.mounted ? styles.wsDotMounted : ""}`} />
                            <span>{activeWs.mounted ? "Tina can read this space" : "Tina access paused"}</span>
                          </button>
                        )}
                      </div>
                      <h1 className={styles.overviewTitle}>{activeWs?.name || "My Space"}</h1>
                      <p className={styles.overviewSub}>
                        {purpose ||
                          "Your central library for notes, meeting summaries, projects, and reference files."}
                      </p>
                    </div>
                    {activeWs && activeWs.kind !== "global" && (
                      <button
                        type="button"
                        className={styles.btn}
                        onClick={() => {
                          if (!confirmDiscardDraft()) return;
                          setActiveTab("sync");
                        }}
                      >
                        <WebIcon name="sliders" size={13} />
                        <span>Space settings</span>
                      </button>
                    )}
                  </div>

                  {/* Quick Action Cards */}
                  <div className={styles.quickActionGrid}>
                    {!activeWs?.readOnly && (
                      <button
                        type="button"
                        className={styles.quickActionCard}
                        onClick={() => {
                          setNewDocKind("wiki");
                          setNewDocOpen(true);
                        }}
                      >
                        <span className={styles.quickActionIcon}>
                          <WebIcon name="plus" size={18} />
                        </span>
                        <span className={styles.quickActionTitle}>Create a page</span>
                        <span className={styles.quickActionDesc}>Start a note, guide, project, or person page</span>
                      </button>
                    )}

                    {!activeWs?.readOnly && (
                      <button
                        type="button"
                        className={styles.quickActionCard}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <span className={styles.quickActionIcon}>
                          <WebIcon name="upload" size={18} />
                        </span>
                        <span className={styles.quickActionTitle}>Upload a file</span>
                        <span className={styles.quickActionDesc}>Add PDFs, docs, or drop files anywhere here</span>
                      </button>
                    )}

                    <button
                      type="button"
                      className={styles.quickActionCard}
                      onClick={() => setCopilotOpen(true)}
                    >
                      <span className={styles.quickActionIcon}>
                        <WebIcon name="tinaAsk" size={18} />
                      </span>
                      <span className={styles.quickActionTitle}>Ask Tina anything</span>
                      <span className={styles.quickActionDesc}>Summarize pages, find decisions, or draft notes</span>
                    </button>
                  </div>

                  {/* Library Pages Grid */}
                  <div className={styles.overviewSection}>
                    <div className={styles.overviewSectionHead}>
                      <h2>Pages in {activeWs?.name || "this space"}</h2>
                      <span className={styles.cardSub}>{userVisibleFiles.length} item(s)</span>
                    </div>

                    {recentCards.length > 0 ? (
                      <div className={styles.pageCardGrid}>
                        {recentCards.map((path) => {
                          const cat = CATEGORY_BY_ID[categorizePath(path)];
                          return (
                            <button
                              key={path}
                              type="button"
                              className={styles.pageCard}
                              onClick={() => openPage(path)}
                            >
                              <div className={styles.pageCardTop}>
                                <span className={styles.pageCardIcon}>
                                  <WebIcon name={cat.icon} size={15} />
                                </span>
                                <span className={styles.wsTag}>{cat.singular}</span>
                              </div>
                              <div className={styles.pageCardTitle}>{friendlyPageTitle(path)}</div>
                              {devView && <div className={styles.pageCardPath}>{path}</div>}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <div className={styles.emptyCard}>
                        <WebIcon name="bookOpen" size={24} />
                        <h3>This space is ready for your first page</h3>
                        <p>
                          Create a note, upload a document, or record a meeting and Tina will organize your knowledge
                          here automatically.
                        </p>
                        {!activeWs?.readOnly && (
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnPrimary}`}
                            onClick={() => setNewDocOpen(true)}
                          >
                            <WebIcon name="plus" size={14} />
                            <span>Create your first page</span>
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Explore Shortcuts */}
                  <div className={styles.exploreGrid}>
                    <button
                      type="button"
                      className={styles.exploreCard}
                      onClick={() => setActiveTab("graph")}
                    >
                      <WebIcon name="network" size={18} />
                      <div>
                        <div className={styles.exploreTitle}>Connections Map</div>
                        <div className={styles.exploreDesc}>
                          Explore your glowing constellation of pages, people &amp; projects ({mappablePageCount} items)
                        </div>
                      </div>
                    </button>

                    {hasGlobal && activeWs?.kind !== "global" && (
                      <button
                        type="button"
                        className={styles.exploreCard}
                        onClick={() => {
                          setSelectedWsId("global");
                          setSelectedPath(null);
                        }}
                      >
                        <WebIcon name="bookOpen" size={18} />
                        <div>
                          <div className={styles.exploreTitle}>Templates &amp; Guides</div>
                          <div className={styles.exploreDesc}>
                            Browse built-in handbooks and ready-to-use templates
                          </div>
                        </div>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              /* ── CLEAN PAGE READER / EDITOR / UPLOADED FILE VIEW ── */
              <div className={styles.docBodySplit}>
                <div className={styles.docScroll}>
                  <div className={styles.docInner} style={editing ? { maxWidth: 960 } : undefined}>
                    {docLoading ? (
                      <p className={styles.cardSub}>Opening page…</p>
                    ) : isFilePreview ? (
                      <div className={styles.fileCard}>
                        <div className={styles.fileCardHead}>
                          <div className={styles.fileExtBadge}>{fileExtensionBadge(selectedPath)}</div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <h1 className={styles.pageTitle} style={{ fontSize: 24, margin: 0 }}>
                              {friendlyPageTitle(selectedPath)}
                            </h1>
                            <p className={styles.cardSub} style={{ marginTop: 4 }}>
                              Uploaded to {activeWs?.name}. Tina can read this file to answer questions or write
                              summaries for you.
                            </p>
                            {devView && <div className={styles.devPathLine}>{selectedPath}</div>}
                          </div>
                        </div>
                        <div className={styles.inlineForm}>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnPrimary}`}
                            onClick={() => {
                              setCopilotSeedPrompt(
                                `Summarize the uploaded file "${friendlyPageTitle(selectedPath)}" (${selectedPath}) and list its key takeaways.`,
                              );
                              setCopilotOpen(true);
                            }}
                          >
                            <WebIcon name="tinaAsk" size={14} />
                            <span>Ask Tina to summarize this file</span>
                          </button>
                        </div>
                        {doc?.content && (
                          <div className={styles.filePreviewBox}>
                            <div className={styles.outlineHead}>File preview</div>
                            <pre className={styles.filePreviewPre}>{doc.content.slice(0, 8000)}</pre>
                          </div>
                        )}
                      </div>
                    ) : editing && doc ? (
                      <KnowledgeDocEditor
                        path={selectedPath}
                        slug={activeWs?.slug}
                        initialContent={doc.content}
                        draft={draft}
                        onDraftChange={setDraft}
                        files={files}
                        busy={busy}
                        devView={devView}
                        commitOnSave={commitOnSave}
                        onCommitOnSaveChange={setCommitOnSave}
                        commitMsg={commitMsg}
                        onCommitMsgChange={setCommitMsg}
                        onSave={() => void handleSaveDoc()}
                        onCancel={() => {
                          if (!confirmDiscardDraft()) return;
                          setEditing(false);
                          setDraft(doc.content);
                        }}
                        onNavigateDoc={handleDocNavigate}
                      />
                    ) : doc && parsedDoc ? (
                      <>
                        <MeetingWikiSourceStatus
                          path={selectedPath}
                          slug={activeWs?.slug}
                          content={doc.content}
                        />

                        {/* Clean Notion-Style Page Header */}
                        <div className={styles.pageHeader}>
                          <div className={styles.pageMetaRow}>
                            {openPageCategory && (
                              <span className={styles.categoryPill}>
                                <WebIcon name={openPageCategory.icon} size={12} />
                                <span>{openPageCategory.singular}</span>
                              </span>
                            )}
                            {!doc.writable && <span className={styles.wsTag}>View only</span>}
                            {humanMeta.map((m) => (
                              <span key={m.label} className={styles.humanMetaPill}>
                                <span className={styles.humanMetaLabel}>{m.label}</span>
                                <span>{m.value}</span>
                              </span>
                            ))}
                            {sourceMeetingId && onOpenMeeting && (
                              <button
                                type="button"
                                className={styles.tinyBtn}
                                onClick={() => onOpenMeeting(sourceMeetingId)}
                              >
                                <WebIcon name="video" size={12} />
                                <span>Open source meeting</span>
                              </button>
                            )}
                          </div>

                          <h1 className={styles.pageTitle}>{parsedDoc.displayTitle}</h1>

                          {devView && (
                            <div className={styles.devMetaBar} aria-label="Developer metadata">
                              <span className={styles.devPathLine}>{selectedPath}</span>
                              {parsedDoc.fields.map(([k, v], i) => (
                                <span key={`${k}-${i}`} className={styles.fmItem}>
                                  <span className={styles.fmKey}>{k}</span>
                                  <span className={styles.fmVal}>{v}</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        <div ref={docProseRef} className={styles.docProse}>
                          <DocNavContext.Provider value={handleDocNavigate}>
                            <DocMetaContext.Provider value={{ path: selectedPath, slug: activeWs?.slug }}>
                              <MdxDoc>{parsedDoc.bodyWithoutLeadingH1}</MdxDoc>
                            </DocMetaContext.Provider>
                          </DocNavContext.Provider>
                        </div>
                      </>
                    ) : (
                      <p className={styles.cardSub}>This page could not be opened.</p>
                    )}
                  </div>
                </div>

                {showOutlineRail && (
                  <aside className={styles.outlineRail} aria-label="Page outline and mentions">
                    {outlineHeadings.length > 0 && (
                      <div className={styles.outlineSection}>
                        <div className={styles.outlineHead}>On this page</div>
                        {outlineHeadings.map((h, i) => (
                          <button
                            key={`${h.text}-${i}`}
                            type="button"
                            className={`${styles.outlineItem} ${h.level === 3 ? styles.outlineSub : ""}`}
                            onClick={() => scrollToHeading(h.text)}
                          >
                            {h.text}
                          </button>
                        ))}
                      </div>
                    )}

                    <div className={styles.outlineSection}>
                      <div className={styles.outlineHead}>Mentioned in ({backlinks.length})</div>
                      {backlinksLoading ? (
                        <span className={styles.cardSub}>Checking links…</span>
                      ) : backlinks.length === 0 ? (
                        <span className={styles.cardSub}>No other pages link here yet.</span>
                      ) : (
                        backlinks.map((bl) => (
                          <button
                            key={`${bl.path}:${bl.line}`}
                            type="button"
                            className={styles.inspectorLinkRow}
                            onClick={() => openPage(bl.path)}
                          >
                            <WebIcon name="link" size={12} />
                            <span className={styles.treeLabel}>{friendlyPageTitle(bl.path)}</span>
                          </button>
                        ))
                      )}
                    </div>
                  </aside>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── VIEW 2: CONNECTIONS MAP ── */}
        {activeTab === "graph" && activeWs && (
          <KnowledgeGraphCanvas
            activeSpaceId={activeWs.id}
            slug={activeWs.slug}
            workspaceName={activeWs.name}
            availableSpaces={workspaces.map((w) => ({ id: w.id, slug: w.slug, name: w.name }))}
            isReadOnly={activeWs.readOnly}
            devView={devView}
            externalRefreshKey={graphRefreshKey}
            onOpenDocument={(path, wsId) => openPage(path, wsId)}
            onAskTina={(prompt) => {
              setCopilotSeedPrompt(prompt);
              setCopilotOpen(true);
            }}
            onCreateEntity={() => {
              setNewDocKind("project");
              setNewDocOpen(true);
            }}
          />
        )}

        {/* ── VIEW 3: ACTIVITY & SETTINGS ── */}
        {activeTab === "sync" && activeWs && (
          <div className={styles.syncScroll}>
            <div className={styles.syncGrid}>
              {activeWs.kind !== "global" ? (
                <>
                  {/* Card 1: Space Info & AI Access */}
                  <section className={styles.card}>
                    <div className={styles.cardHead}>
                      <div>
                        <h3 className={styles.cardTitle}>
                          <WebIcon name="sliders" size={15} />
                          <span>Space Settings</span>
                        </h3>
                        <p className={styles.cardSub}>
                          Describe what belongs in this space so Tina organizes notes and answers accurately.
                        </p>
                      </div>
                    </div>

                    <div className={styles.settingToggleRow}>
                      <div>
                        <div className={styles.settingLabel}>Let Tina read this space</div>
                        <div className={styles.cardSub}>
                          When on, Tina automatically searches pages here during meetings and chat.
                        </div>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={activeWs.mounted}
                        aria-label="Let Tina read this space"
                        className={`${styles.switchTrack} ${activeWs.mounted ? styles.switchTrackOn : ""}`}
                        disabled={busy}
                        onClick={() => handleToggleMount(activeWs)}
                      >
                        <span className={styles.switchThumb} />
                      </button>
                    </div>

                    <form
                      className={styles.inlineForm}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void runAction(async () => {
                          const saved = await writeWorkspacePurpose(
                            purposeDraft,
                            activeWs.slug ? { slug: activeWs.slug } : undefined,
                          );
                          setPurpose(saved);
                        }, "Saved space description.");
                      }}
                    >
                      <input
                        type="text"
                        className={styles.input}
                        style={{ flex: 1, minWidth: 220 }}
                        aria-label="Space description"
                        placeholder="e.g., Product roadmap, team notes, and weekly decisions"
                        value={purposeDraft}
                        onChange={(e) => setPurposeDraft(e.target.value)}
                      />
                      <button type="submit" className={styles.btn} disabled={busy}>
                        Save description
                      </button>
                    </form>

                    {activeWs.kind !== "shared" && activeWs.slotSlug && (
                      <form
                        className={styles.inlineForm}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void runAction(async () => {
                            await renameWorkspace(activeWs.slotSlug!, renameDraft.trim());
                            await loadWorkspaces();
                          }, "Space renamed.");
                        }}
                      >
                        <input
                          type="text"
                          className={styles.input}
                          style={{ maxWidth: 260 }}
                          aria-label="Space name"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                        />
                        <button type="submit" className={styles.btn} disabled={busy}>
                          Rename space
                        </button>
                      </form>
                    )}
                  </section>

                  {/* Card 2: Share with Team */}
                  <section className={styles.card}>
                    <div className={styles.cardHead}>
                      <div>
                        <h3 className={styles.cardTitle}>
                          <WebIcon name="users" size={15} />
                          <span>Share with Team</span>
                        </h3>
                        <p className={styles.cardSub}>
                          {activeWs.kind === "personal"
                            ? "My Space is your personal private library. Create a Team Space or an additional Private Space to invite teammates."
                            : "Invite teammates to read, edit, and collaborate on pages in this space."}
                        </p>
                      </div>
                      {activeWs.kind === "shared" && spaceMembers.length > 0 && (
                        <span className={`${styles.wsTag} ${styles.wsTagShared}`}>
                          {spaceMembers.length} {spaceMembers.length === 1 ? "member" : "members"}
                        </span>
                      )}
                    </div>

                    {activeWs.kind === "personal" ? (
                      <div className={styles.inlineForm}>
                        <button
                          type="button"
                          className={styles.btn}
                          disabled={busy}
                          onClick={() => {
                            setNewWsShared(true);
                            setCreateWsOpen(true);
                          }}
                        >
                          <WebIcon name="plus" size={13} />
                          <span>Create team space</span>
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className={styles.inlineForm}>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnPrimary}`}
                            disabled={busy}
                            onClick={() =>
                              void runAction(async () => {
                                let wsId = activeWs.kind === "shared" ? activeWs.slug! : null;
                                if (!wsId && activeWs.slotSlug) {
                                  const promoted = await shareEnableWorkspace(activeWs.slotSlug);
                                  wsId = promoted.workspace_id;
                                  await loadWorkspaces();
                                  setSelectedWsId(`shared:${wsId}`);
                                }
                                if (!wsId) return;
                                const minted = await mintInvite({
                                  workspace_id: wsId,
                                  role: "contributor",
                                  mode: "open",
                                  expires_in_sec: 7 * 86400,
                                  max_uses: 25,
                                });
                                const origin = typeof window !== "undefined" ? window.location.origin : "";
                                setInviteLink(`${origin}/?invite=${encodeURIComponent(minted.token)}`);
                              }, "Share invite link created (valid 7 days).")
                            }
                          >
                            <WebIcon name="share" size={13} />
                            <span>Create share link</span>
                          </button>
                        </div>

                        {inviteLink && (
                          <div className={styles.inlineForm}>
                            <input
                              type="text"
                              readOnly
                              className={styles.input}
                              style={{ flex: 1 }}
                              value={inviteLink}
                              aria-label="Share invite link"
                            />
                            <button
                              type="button"
                              className={styles.btn}
                              onClick={() => {
                                void navigator.clipboard?.writeText(inviteLink);
                                setNotice("Copied invite link to clipboard.");
                              }}
                            >
                              <WebIcon name="copy" size={13} />
                              <span>Copy</span>
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </section>

                  {/* Card 3: Space Lifecycle & Danger Zone */}
                  <section
                    className={`${styles.card} ${activeWs.kind !== "personal" ? styles.cardDanger : ""}`}
                    aria-label={activeWs.kind === "personal" ? "Space lifecycle" : "Danger Zone"}
                  >
                    <div className={styles.cardHead}>
                      <div>
                        <h3 className={styles.cardTitle}>
                          <WebIcon
                            name={activeWs.kind === "personal" ? "shield" : "alertTriangle"}
                            size={15}
                          />
                          <span>{activeWs.kind === "personal" ? "Space Lifecycle" : "Danger Zone"}</span>
                        </h3>
                        <p className={styles.cardSub}>
                          {activeWs.kind === "personal"
                            ? "Manage archiving and permanent deletion rules for this space."
                            : activeWs.kind === "shared"
                              ? "Manage team access, leave this space, or permanently delete it."
                              : "Archive this space to hide it without losing data, or permanently delete it."}
                        </p>
                      </div>
                    </div>

                    {activeWs.kind === "personal" && (
                      <div className={styles.protectedNotice}>
                        <WebIcon name="info" size={15} />
                        <div>
                          <div className={styles.dangerRowTitle}>Default personal space cannot be deleted</div>
                          <p className={styles.cardSub}>
                            My Space is your baseline personal library and is protected from archiving or deletion.
                            Additional private spaces and team spaces can be archived, unshared, left, or deleted anytime.
                          </p>
                        </div>
                      </div>
                    )}

                    {activeWs.kind === "extra" && activeWs.slotSlug && (
                      <div className={styles.dangerList}>
                        <div className={styles.dangerRow}>
                          <div className={styles.dangerRowMeta}>
                            <div className={styles.dangerRowTitle}>Archive space</div>
                            <p className={styles.cardSub}>
                              Hide this space from your library and pause Tina access while keeping all pages and
                              history. Restore or delete it anytime under Archived Spaces.
                            </p>
                          </div>
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={busy}
                            onClick={() => handleArchiveSpace(activeWs)}
                          >
                            <WebIcon name="pause" size={13} />
                            <span>Archive space</span>
                          </button>
                        </div>

                        <div className={styles.dangerRow}>
                          <div className={styles.dangerRowMeta}>
                            <div className={styles.dangerRowTitle}>Delete space</div>
                            <p className={styles.cardSub}>
                              Permanently remove &ldquo;{activeWs.name}&rdquo; along with all pages, uploaded files, and
                              version history. This cannot be undone.
                            </p>
                          </div>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnDanger}`}
                            disabled={busy}
                            onClick={() =>
                              openLifecycleModal({
                                action: "delete",
                                kind: "extra",
                                slug: activeWs.slotSlug!,
                                name: activeWs.name,
                                rawName: activeWs.rawName,
                              })
                            }
                          >
                            <WebIcon name="trash" size={13} />
                            <span>Delete space</span>
                          </button>
                        </div>
                      </div>
                    )}

                    {activeWs.kind === "shared" && activeWs.slug && (
                      <div className={styles.dangerList}>
                        {activeWs.role === "owner" ? (
                          <>
                            <div className={styles.dangerRow}>
                              <div className={styles.dangerRowMeta}>
                                <div className={styles.dangerRowTitle}>Stop sharing (Convert to Private)</div>
                                <p className={styles.cardSub}>
                                  Revoke access for all teammates and move this space back into your private spaces. All
                                  pages and history stay intact.
                                </p>
                              </div>
                              <button
                                type="button"
                                className={styles.btn}
                                disabled={busy}
                                onClick={() =>
                                  openLifecycleModal({
                                    action: "unshare",
                                    workspaceId: activeWs.slug!,
                                    name: activeWs.name,
                                    rawName: activeWs.rawName,
                                  })
                                }
                              >
                                <WebIcon name="user" size={13} />
                                <span>Stop sharing</span>
                              </button>
                            </div>

                            <div className={styles.dangerRow}>
                              <div className={styles.dangerRowMeta}>
                                <div className={styles.dangerRowTitle}>Leave space</div>
                                <p className={styles.cardSub}>
                                  {canOwnerLeaveShared
                                    ? "Remove yourself from this team space. Other owners and members keep access."
                                    : "You are the sole owner of this space. Add another owner in Settings → Team before leaving, or stop sharing / delete it instead."}
                                </p>
                              </div>
                              <button
                                type="button"
                                className={styles.btn}
                                disabled={busy || !canOwnerLeaveShared}
                                title={
                                  canOwnerLeaveShared
                                    ? "Remove yourself from this team space"
                                    : "Assign another owner before leaving, or stop sharing / delete this space"
                                }
                                onClick={() =>
                                  openLifecycleModal({
                                    action: "leave",
                                    workspaceId: activeWs.slug!,
                                    name: activeWs.name,
                                  })
                                }
                              >
                                <WebIcon name="logout" size={13} />
                                <span>Leave space</span>
                              </button>
                            </div>

                            <div className={styles.dangerRow}>
                              <div className={styles.dangerRowMeta}>
                                <div className={styles.dangerRowTitle}>Delete team space</div>
                                <p className={styles.cardSub}>
                                  Immediately revoke access for all teammates and permanently delete &ldquo;
                                  {activeWs.name}&rdquo; including all pages, uploaded files, and version history.
                                </p>
                              </div>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnDanger}`}
                                disabled={busy}
                                onClick={() =>
                                  openLifecycleModal({
                                    action: "delete",
                                    kind: "shared",
                                    slug: activeWs.slug!,
                                    name: activeWs.name,
                                    rawName: activeWs.rawName,
                                  })
                                }
                              >
                                <WebIcon name="trash" size={13} />
                                <span>Delete space</span>
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className={styles.dangerRow}>
                              <div className={styles.dangerRowMeta}>
                                <div className={styles.dangerRowTitle}>Leave space</div>
                                <p className={styles.cardSub}>
                                  Remove yourself from &ldquo;{activeWs.name}&rdquo;. Other teammates keep access and no
                                  pages are deleted.
                                </p>
                              </div>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnDanger}`}
                                disabled={busy}
                                onClick={() =>
                                  openLifecycleModal({
                                    action: "leave",
                                    workspaceId: activeWs.slug!,
                                    name: activeWs.name,
                                  })
                                }
                              >
                                <WebIcon name="logout" size={13} />
                                <span>Leave space</span>
                              </button>
                            </div>

                            <div className={styles.protectedNotice}>
                              <WebIcon name="info" size={15} />
                              <p className={styles.cardSub}>
                                Only a space owner can stop sharing or permanently delete a team space.
                              </p>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </section>
                </>
              ) : (
                <section className={styles.card}>
                  <h3 className={styles.cardTitle}>
                    <WebIcon name="bookOpen" size={15} />
                    <span>Templates &amp; Guides (View only)</span>
                  </h3>
                  <p className={styles.cardSub}>
                    This built-in library contains shared handbooks and templates managed by your organization. Tina
                    reads these guides automatically across every space.
                  </p>
                </section>
              )}

              {/* Conditional Card: Archived Spaces */}
              {archivedSpaces.length > 0 && (
                <section
                  ref={archivedSectionRef}
                  className={styles.card}
                  aria-label="Archived spaces"
                >
                  <div className={styles.cardHead}>
                    <div>
                      <h3 className={styles.cardTitle}>
                        <WebIcon name="rotateCcw" size={15} />
                        <span>Archived Spaces</span>
                      </h3>
                      <p className={styles.cardSub}>
                        Archived private spaces are hidden from your sidebar and paused from Tina access. Restore a space
                        to continue using it, or delete it permanently.
                      </p>
                    </div>
                    <span className={styles.wsTag}>{archivedSpaces.length}</span>
                  </div>

                  <div className={styles.archivedList}>
                    {archivedSpaces.map((entry) => (
                      <div key={entry.slotSlug} className={styles.archivedRow}>
                        <div className={styles.archivedMeta}>
                          <span className={styles.dangerRowTitle}>{entry.name}</span>
                          {devView && <span className={styles.sha}>{entry.slotSlug}</span>}
                        </div>
                        <div className={styles.archivedActions}>
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={busy}
                            onClick={() => handleRestoreArchivedSpace(entry)}
                          >
                            <WebIcon name="rotateCcw" size={13} />
                            <span>Restore</span>
                          </button>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnDanger}`}
                            disabled={busy}
                            onClick={() =>
                              openLifecycleModal({
                                action: "delete",
                                kind: "archived",
                                slug: entry.slotSlug,
                                name: entry.name,
                                rawName: entry.rawName,
                              })
                            }
                          >
                            <WebIcon name="trash" size={13} />
                            <span>Delete</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Card 3: Recent Activity */}
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h3 className={styles.cardTitle}>
                      <WebIcon name="clock" size={15} />
                      <span>Recent Activity</span>
                    </h3>
                    <p className={styles.cardSub}>
                      {gitState
                        ? devView
                          ? `Branch ${gitState.branch} · ${gitState.commits.length} recent commit(s)`
                          : `${gitState.commits.length} recent update(s) saved in this space`
                        : "Loading recent updates…"}
                    </p>
                  </div>
                  <button type="button" className={styles.btn} onClick={() => void loadGitAndSync(activeWs)}>
                    <WebIcon name="refresh" size={13} />
                    <span>Refresh</span>
                  </button>
                </div>

                <div className={styles.commitList}>
                  {(gitState?.commits ?? []).map((commit) => {
                    const open = expandedSha === commit.sha;
                    const diffVisible = devView || showDiffSha === commit.sha;
                    const actor =
                      commit.kind === "member"
                        ? commit.author || "Teammate"
                        : commit.kind === "system"
                          ? "Tina"
                          : "You";
                    return (
                      <div key={commit.sha} className={styles.commitCard}>
                        <button
                          type="button"
                          className={styles.commitHead}
                          onClick={() => void handleToggleCommitRow(commit.sha)}
                          aria-expanded={open}
                        >
                          <span className={styles.treeLabel}>{commit.msg}</span>
                          <span className={styles.commitMeta}>
                            <span>{actor}</span>
                            {devView && <span className={styles.sha}>{commit.sha.slice(0, 7)}</span>}
                            <span>{commit.when}</span>
                          </span>
                        </button>
                        {open && (
                          <div className={styles.commitBody}>
                            {commit.files && commit.files.length > 0 && (
                              <div className={styles.chipRow} style={{ padding: "8px 12px", marginTop: 0 }}>
                                {commit.files.map((fp) => (
                                  <button
                                    key={fp}
                                    type="button"
                                    className={styles.chip}
                                    onClick={() => openPage(fp)}
                                  >
                                    {devView ? fp : friendlyPageTitle(fp)}
                                  </button>
                                ))}
                              </div>
                            )}
                            {!diffVisible ? (
                              <div style={{ padding: "0 12px 10px" }}>
                                <button
                                  type="button"
                                  className={styles.tinyBtn}
                                  onClick={() => {
                                    setShowDiffSha(commit.sha);
                                    void loadDiffIfNeeded(commit.sha);
                                  }}
                                >
                                  Show technical diff
                                </button>
                              </div>
                            ) : (
                              <pre className={styles.diffPre}>
                                {diffsBySha[commit.sha]
                                  ? renderDiffLines(diffsBySha[commit.sha])
                                  : "Loading diff…"}
                              </pre>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {gitState && gitState.commits.length === 0 && (
                    <p className={styles.cardSub}>No saved updates yet in this space.</p>
                  )}
                </div>
              </section>

              {/* Card 4: Collapsible Advanced · GitHub Sync */}
              {activeWs.kind !== "global" && (
                <section className={styles.card}>
                  <button
                    type="button"
                    className={styles.accordionBtn}
                    aria-expanded={advancedSyncOpen}
                    onClick={() => setAdvancedSyncOpen((v) => !v)}
                  >
                    <div style={{ textAlign: "left" }}>
                      <h3 className={styles.cardTitle}>
                        <WebIcon name="github" size={15} />
                        <span>Advanced · GitHub Sync</span>
                      </h3>
                      <p className={styles.cardSub} style={{ marginTop: 2 }}>
                        {remoteStatus?.has_home
                          ? `Connected to ${remoteStatus.url} (${remoteStatus.ahead} ahead / ${remoteStatus.behind} behind)`
                          : "Optional: back up or sync this space with a GitHub repository."}
                      </p>
                    </div>
                    <WebIcon name={advancedSyncOpen ? "chevronUp" : "chevronDown"} size={15} />
                  </button>

                  {advancedSyncOpen && (
                    <div className={styles.accordionBody}>
                      <div className={styles.inlineForm}>
                        <span className={styles.wsTag}>
                          {gitToken.set ? `GitHub connected (${gitToken.masked})` : "No GitHub token"}
                        </span>
                        {onOpenGitHubSettings && (
                          <button type="button" className={styles.btn} onClick={onOpenGitHubSettings}>
                            <span>Manage GitHub token</span>
                          </button>
                        )}
                      </div>

                      {remoteStatus?.has_home ? (
                        <div className={styles.inlineForm}>
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={busy}
                            onClick={() =>
                              void runAction(async () => {
                                const r = await pullWorkspace({ slug: activeWs.slug });
                                await loadGitAndSync(activeWs);
                                await loadTreeAndMeta(activeWs, true);
                                setNotice(
                                  r.updated
                                    ? `Pulled latest updates from GitHub (${r.head_sha.slice(0, 7)}).`
                                    : "Already up to date with GitHub.",
                                );
                              })
                            }
                          >
                            <WebIcon name="download" size={13} />
                            <span>Pull from GitHub</span>
                          </button>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnPrimary}`}
                            disabled={busy}
                            onClick={() =>
                              void runAction(async () => {
                                const r = await pushWorkspace({ slug: activeWs.slug });
                                await loadGitAndSync(activeWs);
                                setNotice(`Pushed updates to GitHub (${r.head_sha.slice(0, 7)}).`);
                              })
                            }
                          >
                            <WebIcon name="upload" size={13} />
                            <span>Push to GitHub</span>
                          </button>
                          {remoteStatus.url && (
                            <a
                              href={remoteStatus.url.replace(/\.git$/, "")}
                              target="_blank"
                              rel="noreferrer"
                              className={styles.btn}
                            >
                              <WebIcon name="externalLink" size={13} />
                              <span>Open repository</span>
                            </a>
                          )}
                        </div>
                      ) : (
                        <form
                          className={styles.inlineForm}
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (!publishRepoName.trim()) return;
                            void runAction(async () => {
                              const r = await publishWorkspace(
                                publishRepoName.trim(),
                                publishPrivate,
                                undefined,
                                undefined,
                                activeWs.slug,
                              );
                              await loadGitAndSync(activeWs);
                              setNotice(`Published to ${r.repo_url}`);
                            });
                          }}
                        >
                          <input
                            type="text"
                            className={styles.input}
                            style={{ maxWidth: 260 }}
                            aria-label="GitHub repository name"
                            placeholder="tina-knowledge"
                            value={publishRepoName}
                            onChange={(e) => setPublishRepoName(e.target.value)}
                          />
                          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                            <input
                              type="checkbox"
                              checked={publishPrivate}
                              onChange={(e) => setPublishPrivate(e.target.checked)}
                            />
                            <span>Private repository</span>
                          </label>
                          <button
                            type="submit"
                            className={`${styles.btn} ${styles.btnPrimary}`}
                            disabled={busy || !publishRepoName.trim()}
                          >
                            <WebIcon name="github" size={13} />
                            <span>Publish to GitHub</span>
                          </button>
                        </form>
                      )}
                    </div>
                  )}
                </section>
              )}
            </div>
          </div>
        )}
      </section>

      {/* ── Right Docked Inline Ask Tina Drawer ── */}
      {activeWs && (
        <KnowledgeCopilotDrawer
          open={copilotOpen}
          workspaceName={activeWs.name}
          slug={activeWs.slug}
          docPath={selectedPath}
          docTitle={openPageTitle}
          isReadOnly={activeWs.readOnly}
          devView={devView}
          initialPrompt={copilotSeedPrompt}
          onConsumeInitialPrompt={() => setCopilotSeedPrompt(null)}
          onClose={() => setCopilotOpen(false)}
          onWorkspaceMutated={handleWorkspaceMutated}
          onOpenFullAsk={(prompt) => onAskTina(prompt, "draft")}
        />
      )}

      {/* ── Modal 1: Create New Page ── */}
      {newDocOpen && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Create new page"
          onClick={() => setNewDocOpen(false)}
        >
          <form className={styles.modalCard} onClick={(e) => e.stopPropagation()} onSubmit={handleCreateDoc}>
            <h3 className={styles.modalTitle}>Create a new page</h3>
            <p className={styles.cardSub}>Choose a template and give your page a clear name.</p>
            <div className={styles.templateCardGrid}>
              {NEW_PAGE_CARDS.map((card) => (
                <button
                  key={card.kind}
                  type="button"
                  className={`${styles.templateCard} ${newDocKind === card.kind ? styles.templateCardActive : ""}`}
                  onClick={() => {
                    setNewDocKind(card.kind);
                    setNewDocError(null);
                  }}
                >
                  <WebIcon name={card.icon} size={16} />
                  <span className={styles.templateCardTitle}>{card.title}</span>
                  <span className={styles.templateCardDesc}>{card.desc}</span>
                </button>
              ))}
            </div>
            <input
              type="text"
              className={styles.input}
              placeholder="Page title (e.g., Q4 Product Plan)"
              aria-label="Page title"
              value={newDocTitle}
              onChange={(e) => {
                setNewDocTitle(e.target.value);
                setNewDocError(null);
              }}
              autoFocus
            />
            {devView && (
              <input
                type="text"
                className={styles.input}
                placeholder={buildNewPageTemplate(newDocKind, newDocTitle || "untitled").path}
                aria-label="Custom file path"
                value={newDocCustomPath}
                onChange={(e) => {
                  setNewDocCustomPath(e.target.value);
                  setNewDocError(null);
                }}
              />
            )}
            {newDocError && (
              <div className={`${styles.alert} ${styles.alertDanger}`} role="alert">
                <span>{newDocError}</span>
              </div>
            )}
            <div className={styles.inlineForm} style={{ justifyContent: "flex-end" }}>
              <button type="button" className={styles.btn} onClick={() => setNewDocOpen(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={busy || !newDocTitle.trim()}
              >
                {busy ? "Creating…" : "Create page"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Modal 2: Rename or Move Page ── */}
      {moveOpen && selectedPath && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Rename or move page"
          onClick={() => setMoveOpen(false)}
        >
          <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Rename or move page</h3>
            {devView ? (
              <>
                <p className={styles.cardSub}>Current path: {selectedPath}</p>
                <input
                  type="text"
                  className={styles.input}
                  aria-label="Destination path"
                  value={moveDest}
                  onChange={(e) => {
                    setMoveDest(e.target.value);
                    setMovePreview(null);
                  }}
                />
              </>
            ) : (
              <>
                <label className={styles.fieldLabel}>
                  <span>Page name</span>
                  <input
                    type="text"
                    className={styles.input}
                    aria-label="New page name"
                    value={moveName}
                    onChange={(e) => {
                      setMoveName(e.target.value);
                      setMovePreview(null);
                    }}
                    autoFocus
                  />
                </label>
                <label className={styles.fieldLabel}>
                  <span>Section</span>
                  <select
                    className={styles.input}
                    aria-label="Destination section"
                    value={moveSection}
                    onChange={(e) => {
                      setMoveSection(e.target.value as "wiki" | "notes" | "project" | "person" | "task");
                      setMovePreview(null);
                    }}
                  >
                    <option value="wiki">Pages &amp; Notes</option>
                    <option value="notes">Quick Notes</option>
                    <option value="project">Projects</option>
                    <option value="person">People</option>
                    <option value="task">Tasks</option>
                  </select>
                </label>
              </>
            )}

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={moveUpdateLinks}
                onChange={(e) => {
                  setMoveUpdateLinks(e.target.checked);
                  setMovePreview(null);
                }}
              />
              <span>Automatically update links from other pages</span>
            </label>

            {devView && movePreview && (
              <div className={styles.card} style={{ padding: "10px 12px" }}>
                <span className={styles.cardSub}>
                  Preview ready: {movePreview.changes.length} file(s) will have links updated.
                </span>
                {movePreview.warnings.map((w, i) => (
                  <span key={i} style={{ fontSize: 12, color: "var(--tw-danger)" }}>
                    {w}
                  </span>
                ))}
              </div>
            )}

            {moveError && (
              <div className={`${styles.alert} ${styles.alertDanger}`} role="alert">
                <span>{moveError}</span>
              </div>
            )}

            <div className={styles.inlineForm} style={{ justifyContent: "flex-end" }}>
              <button type="button" className={styles.btn} onClick={() => setMoveOpen(false)}>
                Cancel
              </button>
              {devView && moveUpdateLinks && !movePreview ? (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy || !effectiveMoveDest || effectiveMoveDest === selectedPath}
                  onClick={() => void handlePreviewMove()}
                >
                  Preview link updates
                </button>
              ) : (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy || !effectiveMoveDest || effectiveMoveDest === selectedPath}
                  onClick={() => void handleConfirmMove()}
                >
                  {busy ? "Moving…" : "Save changes"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Modal 3: Create New Space ── */}
      {createWsOpen && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Create new space"
          onClick={() => setCreateWsOpen(false)}
        >
          <form className={styles.modalCard} onClick={(e) => e.stopPropagation()} onSubmit={handleCreateWorkspace}>
            <h3 className={styles.modalTitle}>Create a new space</h3>
            <p className={styles.cardSub}>Keep a private library for yourself or start a shared space with your team.</p>
            <div className={styles.templateCardGrid}>
              <button
                type="button"
                className={`${styles.templateCard} ${!newWsShared ? styles.templateCardActive : ""}`}
                onClick={() => setNewWsShared(false)}
              >
                <WebIcon name="user" size={16} />
                <span className={styles.templateCardTitle}>Private Space</span>
                <span className={styles.templateCardDesc}>Only visible to you</span>
              </button>
              <button
                type="button"
                className={`${styles.templateCard} ${newWsShared ? styles.templateCardActive : ""}`}
                onClick={() => setNewWsShared(true)}
              >
                <WebIcon name="users" size={16} />
                <span className={styles.templateCardTitle}>Team Space</span>
                <span className={styles.templateCardDesc}>Invite teammates to edit</span>
              </button>
            </div>
            <input
              type="text"
              className={styles.input}
              placeholder="Space name (e.g., Product Team)"
              aria-label="New space name"
              value={newWsName}
              onChange={(e) => {
                setNewWsName(e.target.value);
                setCreateWsError(null);
              }}
              autoFocus
            />
            {createWsError && (
              <div className={`${styles.alert} ${styles.alertDanger}`} role="alert">
                <span>{createWsError}</span>
              </div>
            )}
            <div className={styles.inlineForm} style={{ justifyContent: "flex-end" }}>
              <button type="button" className={styles.btn} onClick={() => setCreateWsOpen(false)}>
                Cancel
              </button>
              <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !newWsName.trim()}>
                {busy ? "Creating…" : "Create space"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Modal 4: Space Lifecycle Confirmation (Delete / Stop Sharing / Leave) ── */}
      {lifecycleModal && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label={
            lifecycleModal.action === "delete"
              ? `Delete ${lifecycleModal.name}`
              : lifecycleModal.action === "unshare"
                ? `Stop sharing ${lifecycleModal.name}`
                : `Leave ${lifecycleModal.name}`
          }
          onClick={closeLifecycleModal}
        >
          <form
            className={styles.modalCard}
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleConfirmLifecycleModal}
          >
            <h3 className={styles.modalTitle}>
              {lifecycleModal.action === "delete"
                ? lifecycleModal.kind === "shared"
                  ? `Delete team space "${lifecycleModal.name}"?`
                  : `Delete "${lifecycleModal.name}"?`
                : lifecycleModal.action === "unshare"
                  ? `Stop sharing "${lifecycleModal.name}"?`
                  : `Leave "${lifecycleModal.name}"?`}
            </h3>

            {lifecycleModal.action === "delete" && (
              <>
                <div className={`${styles.alert} ${styles.alertDanger}`}>
                  <span>
                    {lifecycleModal.kind === "shared"
                      ? "All teammates will immediately lose access, and every page, uploaded file, and version history in this team space will be permanently deleted. This action cannot be undone."
                      : "Every page, uploaded file, and version history in this space will be permanently deleted. This action cannot be undone."}
                  </span>
                </div>
                <label className={styles.fieldLabel}>
                  <span>
                    Type <strong>{lifecycleModal.name}</strong> to confirm permanent deletion
                  </span>
                  <input
                    type="text"
                    className={styles.input}
                    aria-label="Confirm space name"
                    placeholder={lifecycleModal.name}
                    value={deleteConfirmInput}
                    onChange={(e) => {
                      setDeleteConfirmInput(e.target.value);
                      setLifecycleError(null);
                    }}
                    disabled={busy}
                    autoFocus
                  />
                </label>
              </>
            )}

            {lifecycleModal.action === "unshare" && (
              <p className={styles.cardSub}>
                All teammates will immediately lose access and active share links will stop working. The space will be
                moved back into your Private spaces with all pages and history intact.
              </p>
            )}

            {lifecycleModal.action === "leave" && (
              <p className={styles.cardSub}>
                You will be removed from &ldquo;{lifecycleModal.name}&rdquo; and it will no longer appear in your
                Knowledge library or Tina context. Other teammates keep access and no pages are deleted.
              </p>
            )}

            {lifecycleError && (
              <div className={`${styles.alert} ${styles.alertDanger}`} role="alert">
                <span>{lifecycleError}</span>
              </div>
            )}

            <div className={styles.inlineForm} style={{ justifyContent: "flex-end" }}>
              <button type="button" className={styles.btn} disabled={busy} onClick={closeLifecycleModal}>
                Cancel
              </button>
              {lifecycleModal.action === "delete" && (
                <button
                  type="submit"
                  className={`${styles.btn} ${styles.btnDangerSolid}`}
                  disabled={busy || !isDeleteConfirmMatch}
                >
                  <WebIcon name="trash" size={13} />
                  <span>{busy ? "Deleting…" : "Permanently delete"}</span>
                </button>
              )}
              {lifecycleModal.action === "unshare" && (
                <button type="submit" className={`${styles.btn} ${styles.btnDanger}`} disabled={busy}>
                  <WebIcon name="user" size={13} />
                  <span>{busy ? "Converting…" : "Stop sharing"}</span>
                </button>
              )}
              {lifecycleModal.action === "leave" && (
                <button type="submit" className={`${styles.btn} ${styles.btnDanger}`} disabled={busy}>
                  <WebIcon name="logout" size={13} />
                  <span>{busy ? "Leaving…" : "Leave space"}</span>
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
