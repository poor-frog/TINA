"use client";
/** KnowledgeView — Full Knowledge Hub for TINA's Production Web UI (`/?nav=knowledge`).
 *  Unifies Personal & Extra workspaces, Shared Team Wikis, and the read-only `_global` Platform Guide
 *  with Markdown/MDX reading & inline editing, [[wikilink]] navigation, full-text search, file uploads,
 *  Meeting Source Provenance checks, Entity-Lane Knowledge Graph, Git History + Diff, and GitHub Sync. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import { WebIcon } from "./Icons";
import { KnowledgeGraphCanvas } from "./KnowledgeGraphCanvas";
import { MdxDoc } from "../ui-kit/MdxDoc";
import {
  DocMetaContext,
  DocNavContext,
  invalidateDocLinkCaches,
  resolveDocRef,
  type DocNavigate,
} from "../ui-kit/docLinks";
import { MeetingWikiSourceStatus } from "../surfaces/MeetingKnowledge";
import { presentError } from "../surfaces/apiClient";
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
  listSharedMemberships,
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
  type WorkspaceSearchHit,
} from "../surfaces/workspaceApi";
import styles from "./knowledgeView.module.css";

type KnowledgeTab = "documents" | "graph" | "sync";
type EntityFilter = "all" | "meeting" | "person" | "project" | "task" | "docs";

interface WorkspaceEntry {
  id: string;
  /** Undefined targets the caller's primary personal baseline; otherwise the workspace slug / shared id / `_global`. */
  slug?: string;
  slotSlug?: string;
  name: string;
  kind: "personal" | "extra" | "shared" | "global";
  role?: string;
  mounted: boolean;
  readOnly: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
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

function parseFrontmatter(text: string): { fm: Array<[string, string]>; body: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: [], body: text };
  const fm: Array<[string, string]> = [];
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) fm.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return { fm, body: m[2] };
}

function matchesEntityFilter(path: string, filter: EntityFilter): boolean {
  if (filter === "all") return true;
  if (filter === "meeting") return path.startsWith("kg/entities/meeting/") || path.startsWith("wiki/meetings/");
  if (filter === "person") return path.startsWith("kg/entities/person/");
  if (filter === "project") return path.startsWith("kg/entities/project/");
  if (filter === "task") return path.startsWith("kg/entities/task/");
  if (filter === "docs") {
    return (
      path === "README.md" ||
      path === "CLAUDE.md" ||
      path.startsWith("docs/") ||
      path.startsWith("wiki/") ||
      path.startsWith("notes/") ||
      path.startsWith("mail/")
    );
  }
  return true;
}

function pickInitialDoc(files: string[]): string | null {
  if (!files.length) return null;
  for (const preferred of ["README.md", "docs/tina-handbook.md", "kg/index.md"]) {
    if (files.includes(preferred)) return preferred;
  }
  return files.find((f) => f.endsWith(".md")) ?? files[0] ?? null;
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

function newDocTemplate(kind: string, title: string): { path: string; content: string } {
  const cleanTitle = title.trim() || "Untitled";
  const slug =
    cleanTitle
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "untitled";
  const today = new Date().toISOString().slice(0, 10);
  if (kind === "person") {
    return {
      path: `kg/entities/person/${slug}.md`,
      content: `---\nid: person/${slug}\ntype: person\ntitle: ${cleanTitle}\nupdated: ${today}\n---\n\n# ${cleanTitle}\n\n- Role:\n- Related projects:\n`,
    };
  }
  if (kind === "project") {
    return {
      path: `kg/entities/project/${slug}.md`,
      content: `---\nid: project/${slug}\ntype: project\ntitle: ${cleanTitle}\nstatus: active\nupdated: ${today}\n---\n\n# ${cleanTitle}\n\n## Goals\n\n## Key decisions\n`,
    };
  }
  if (kind === "wiki") {
    return {
      path: `wiki/${slug}.md`,
      content: `# ${cleanTitle}\n\nCreated ${today}.\n`,
    };
  }
  return {
    path: `notes/${slug}.md`,
    content: `# ${cleanTitle}\n\n`,
  };
}

export function KnowledgeView({
  onAskTina,
  onOpenGitHubSettings,
}: {
  onAskTina: (prompt: string, mode?: "send" | "draft") => void;
  onOpenGitHubSettings?: () => void;
}) {
  // ── Workspaces state ─────────────────────────────────────────────────
  const [attached, setAttached] = useState<AttachedWorkspaces>({ active: null, slots: {} });
  const [activeSet, setActiveSet] = useState<ActiveMount[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [hasGlobal, setHasGlobal] = useState(false);
  const [selectedWsId, setSelectedWsId] = useState<string>("personal");
  const [wsLoading, setWsLoading] = useState(true);
  const [mobileRailOpen, setMobileRailOpen] = useState(false);

  // Create workspace inline form
  const [createWsOpen, setCreateWsOpen] = useState(false);
  const [newWsName, setNewWsName] = useState("");
  const [newWsShared, setNewWsShared] = useState(false);

  // ── Tree, Search & Filter state ──────────────────────────────────────
  const [files, setFiles] = useState<string[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => new Set(["kg", "kg/entities", "docs", "wiki"]));
  const [entityFilter, setEntityFilter] = useState<EntityFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"files" | "content">("files");
  const [contentHits, setContentHits] = useState<WorkspaceSearchHit[]>([]);
  const [contentSearchStatus, setContentSearchStatus] = useState("");
  const [searchingContent, setSearchingContent] = useState(false);

  // ── Main pane tabs & Document state ──────────────────────────────────
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("documents");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [doc, setDoc] = useState<WorkspaceDocument | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [editPreview, setEditPreview] = useState(false);
  const [commitOnSave, setCommitOnSave] = useState(true);
  const [commitMsg, setCommitMsg] = useState("");

  // ── Modals: Create Doc & Move Doc ────────────────────────────────────
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [newDocKind, setNewDocKind] = useState<"notes" | "wiki" | "person" | "project">("wiki");
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocCustomPath, setNewDocCustomPath] = useState("");

  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDest, setMoveDest] = useState("");
  const [moveUpdateLinks, setMoveUpdateLinks] = useState(true);
  const [movePreview, setMovePreview] = useState<DocumentMovePreview | null>(null);

  // ── History, Sync & Workspace Management state ───────────────────────
  const [gitState, setGitState] = useState<GitState | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<GitRemoteStatus | null>(null);
  const [gitToken, setGitToken] = useState<SavedGitToken>({ set: false, masked: null });
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
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

  const workspaces = useMemo<WorkspaceEntry[]>(() => {
    const entries: WorkspaceEntry[] = [];
    const primaryMount = activeSet.find((m) => m.primary);
    const seedSlug = attached.active ?? "seed";
    const seedMeta = attached.slots[seedSlug];
    entries.push({
      id: "personal",
      slug: undefined,
      slotSlug: seedSlug,
      name: seedMeta?.name || primaryMount?.name || "Personal",
      kind: "personal",
      mounted: Boolean(primaryMount) || activeSet.length === 0,
      readOnly: false,
    });

    const sharedIds = new Set(memberships.map((m) => m.workspace_id));
    for (const [slotSlug, meta] of Object.entries(attached.slots)) {
      if (meta.archived || slotSlug === seedSlug || slotSlug === "seed-prev" || sharedIds.has(slotSlug)) continue;
      const isMounted = activeSet.some((m) => m.slug === slotSlug && m.role !== "shared");
      entries.push({
        id: `extra:${slotSlug}`,
        slug: slotSlug,
        slotSlug,
        name: meta.name || meta.repo || slotSlug,
        kind: "extra",
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
        name: mem.workspace_id,
        kind: "shared",
        role: mem.role,
        mounted: isMounted,
        readOnly: mem.role === "viewer",
      });
    }

    if (hasGlobal) {
      entries.push({
        id: "global",
        slug: "_global",
        slotSlug: "_global",
        name: "Platform Guide (_global)",
        kind: "global",
        role: "read-only",
        mounted: true,
        readOnly: true,
      });
    }

    return entries;
  }, [attached, activeSet, memberships, hasGlobal]);

  const activeWs = useMemo<WorkspaceEntry>(
    () => workspaces.find((w) => w.id === selectedWsId) ?? workspaces[0],
    [workspaces, selectedWsId],
  );

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

  // ── Load file tree & metadata for selected workspace ─────────────────
  const loadTreeAndMeta = useCallback(async (ws: WorkspaceEntry, keepSelection = true) => {
    setTreeLoading(true);
    setError(null);
    setContentHits([]);
    setContentSearchStatus("");
    try {
      const opts = ws.slug ? { slug: ws.slug } : undefined;
      const [treeFiles, wsPurpose] = await Promise.all([
        listWorkspaceTree(opts),
        ws.kind === "global"
          ? Promise.resolve("Platform-wide read-only guidelines, handbook, and email templates mounted into every TINA session.")
          : readWorkspacePurpose(opts).catch(() => ""),
      ]);
      setFiles(treeFiles);
      setPurpose(wsPurpose);
      setPurposeDraft(wsPurpose);
      setRenameDraft(ws.name);
      setPublishRepoName(
        `tina-${ws.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "knowledge"}`,
      );
      setSelectedPath((prev) => {
        if (keepSelection && prev && treeFiles.includes(prev)) return prev;
        return pickInitialDoc(treeFiles);
      });
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
    setExpandedSha(null);
    setDiffsBySha({});
    void loadTreeAndMeta(activeWs, false);
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
    setEditPreview(false);
    try {
      const loaded = await readWorkspaceDocument(path, slug ? { slug } : undefined);
      setDoc(loaded);
      setDraft(loaded.content);
      setError(null);
    } catch {
      // Fall back to plain file read (e.g., JSON/non-document files)
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

  // ── Load Git history & remote sync when on History & Sync tab ────────
  const loadGitAndSync = useCallback(async (ws: WorkspaceEntry) => {
    const opts = ws.slug ? { slug: ws.slug } : undefined;
    const [g, rs, tok] = await Promise.all([
      readWorkspaceGit(opts).catch(() => null),
      ws.kind === "global" ? Promise.resolve(null) : gitRemoteStatus(opts).catch(() => null),
      ws.kind === "global" ? Promise.resolve({ set: false, masked: null }) : getGitToken().catch(() => ({ set: false, masked: null })),
    ]);
    setGitState(g);
    setRemoteStatus(rs);
    setGitToken(tok);
  }, []);

  useEffect(() => {
    if (activeTab === "sync" && activeWs) {
      void loadGitAndSync(activeWs);
    }
  }, [activeTab, activeWs, loadGitAndSync]);

  // ── In-place [[wikilink]] navigation ─────────────────────────────────
  const handleDocNavigate: DocNavigate = useCallback(
    (detail) => {
      void (async () => {
        const targetSlug = "slug" in detail ? detail.slug : activeWs?.slug;
        const resolved = await resolveDocRef(
          { path: detail.path, wikilink: detail.wikilink },
          { path: selectedPath ?? undefined, slug: targetSlug },
        );
        if (!resolved) {
          setError(`Document not found: ${detail.wikilink || detail.path || ""}`);
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
    [activeWs?.slug, selectedPath, workspaces],
  );

  // ── Tree filtering ───────────────────────────────────────────────────
  const visibleFiles = useMemo(() => {
    const needle = searchMode === "files" ? searchQuery.trim().toLowerCase() : "";
    return files.filter((f) => {
      if (!matchesEntityFilter(f, entityFilter)) return false;
      if (needle && !f.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [files, entityFilter, searchMode, searchQuery]);

  const treeNodes = useMemo(() => buildTree(visibleFiles), [visibleFiles]);

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  // ── Full-text content search ─────────────────────────────────────────
  const runContentSearch = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = searchQuery.trim();
    if (!q || !activeWs) return;
    setSearchingContent(true);
    setContentSearchStatus("Searching…");
    try {
      const res = await searchWorkspaceContent(q, activeWs.slug ? { slug: activeWs.slug } : undefined);
      setContentHits(res.hits);
      setContentSearchStatus(
        `${res.hits.length} match${res.hits.length === 1 ? "" : "es"}${res.bounded ? " (limit reached)" : ""}`,
      );
    } catch (err) {
      setContentHits([]);
      setContentSearchStatus(presentError(err).headline);
    } finally {
      setSearchingContent(false);
    }
  };

  // ── Document mutations ───────────────────────────────────────────────
  const handleSaveDoc = useCallback(async () => {
    if (!selectedPath || !doc?.writable || !activeWs) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await saveWorkspaceDocument({
        path: selectedPath,
        content: draft,
        expected_sha256: doc.sha256 || null,
        slug: activeWs.slug,
        commit: commitOnSave,
        commit_message: commitMsg || `Update ${selectedPath}`,
      });
      setDoc({ content: draft, sha256: res.sha256, writable: true });
      setEditing(false);
      setCommitMsg("");
      invalidateDocLinkCaches();
      setNotice(
        res.commit
          ? `Saved & committed (${res.commit.slice(0, 7)})`
          : res.commit_error || "Saved to workspace.",
      );
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  }, [selectedPath, doc, activeWs, draft, commitOnSave, commitMsg]);

  const handleCreateDoc = async (e: FormEvent) => {
    e.preventDefault();
    if (!activeWs || activeWs.readOnly) return;
    const tpl = newDocTemplate(newDocKind, newDocTitle);
    const targetPath = (newDocCustomPath.trim() || tpl.path).replace(/^\/+/, "");
    if (!targetPath.endsWith(".md")) {
      setError("Document path must end with .md");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveWorkspaceDocument({
        path: targetPath,
        content: tpl.content,
        expected_sha256: null,
        slug: activeWs.slug,
        commit: true,
        commit_message: `Create ${targetPath}`,
      });
      invalidateDocLinkCaches();
      setNewDocOpen(false);
      setNewDocTitle("");
      setNewDocCustomPath("");
      await loadTreeAndMeta(activeWs, true);
      setActiveTab("documents");
      setSelectedPath(targetPath);
      setNotice(`Created ${targetPath}`);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const handlePreviewMove = async () => {
    if (!selectedPath || !doc?.sha256 || !moveDest.trim() || !activeWs) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await previewMoveWorkspaceDocument({
        path: selectedPath,
        destination: moveDest.trim(),
        expected_sha256: doc.sha256,
        slug: activeWs.slug,
        update_links: moveUpdateLinks,
      });
      setMovePreview(preview);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmMove = async () => {
    if (!selectedPath || !doc?.sha256 || !moveDest.trim() || !activeWs) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await moveWorkspaceDocument({
        path: selectedPath,
        destination: moveDest.trim(),
        expected_sha256: doc.sha256,
        slug: activeWs.slug,
        update_links: moveUpdateLinks && Boolean(movePreview),
        expected_plan: movePreview?.fingerprint ?? null,
      });
      invalidateDocLinkCaches();
      setMoveOpen(false);
      setMovePreview(null);
      await loadTreeAndMeta(activeWs, false);
      setSelectedPath(res.path);
      setNotice(
        res.updated_links
          ? `Moved to ${res.path} and updated ${res.updated_links} wikilink(s).`
          : `Moved to ${res.path}.`,
      );
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteDoc = async () => {
    if (!selectedPath || !doc?.sha256 || !doc.writable || !activeWs) return;
    if (typeof window !== "undefined" && !window.confirm(`Delete ${selectedPath}? This cannot be undone.`)) return;
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
      setNotice(`Deleted ${selectedPath}`);
      await loadTreeAndMeta(activeWs, false);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  const handleUploadChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!selected.length || !activeWs) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await uploadWorkspaceFiles(selected);
      invalidateDocLinkCaches();
      await loadTreeAndMeta(activeWs, true);
      setNotice(`Uploaded ${res.files.length} file(s) to uploads/.`);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setBusy(false);
    }
  };

  // ── Workspace & GitHub Sync mutations ────────────────────────────────
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

  const handleCreateWorkspace = (e: FormEvent) => {
    e.preventDefault();
    const label = newWsName.trim();
    if (!label) return;
    void runAction(async () => {
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
    }, `Created ${newWsShared ? "shared" : "private"} workspace "${label}".`);
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
    }, ws.mounted ? `Unmounted "${ws.name}" from Agent context.` : `Mounted "${ws.name}" into Agent context.`);
  };

  const handleToggleCommitDiff = async (sha: string) => {
    if (expandedSha === sha) {
      setExpandedSha(null);
      return;
    }
    setExpandedSha(sha);
    if (diffsBySha[sha] || !activeWs) return;
    try {
      const res = await readWorkspaceGitDiff({ sha, slug: activeWs.slug });
      setDiffsBySha((prev) => ({ ...prev, [sha]: res.diff || "(empty diff)" }));
    } catch (err) {
      setDiffsBySha((prev) => ({ ...prev, [sha]: `Failed to load diff: ${presentError(err).headline}` }));
    }
  };

  // ── Recursive Tree Renderer ──────────────────────────────────────────
  const renderTree = (nodes: TreeNode[], depth = 0): ReactNode =>
    nodes.map((node) => {
      if (node.isDir) {
        const isOpen = Boolean(searchQuery.trim()) || entityFilter !== "all" || expandedDirs.has(node.path);
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
            {isOpen && renderTree(node.children, depth + 1)}
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
          onClick={() => {
            setSelectedPath(node.path);
            setActiveTab("documents");
            setMobileRailOpen(false);
          }}
        >
          <WebIcon name="fileText" size={13} />
          <span className={styles.treeLabel} title={node.path}>
            {node.name}
          </span>
        </button>
      );
    });

  const parsedDoc = useMemo(() => (doc ? parseFrontmatter(doc.content) : null), [doc]);

  return (
    <div className={styles.shell}>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        aria-label="Upload workspace files"
        onChange={handleUploadChange}
      />

      {/* ── Left Navigator Rail ── */}
      <aside className={`${styles.rail} ${mobileRailOpen ? styles.railOpen : ""}`} aria-label="Knowledge navigator">
        <div className={styles.railSection}>
          <div className={styles.railSectionHead}>
            <span>Workspaces</span>
            <div className={styles.railHeadActions}>
              <button
                type="button"
                className={styles.tinyBtn}
                onClick={() => setCreateWsOpen((v) => !v)}
                aria-label="New workspace"
              >
                <WebIcon name="plus" size={12} />
                <span>New</span>
              </button>
            </div>
          </div>

          <div className={styles.wsList} aria-label="Workspaces list">
            {workspaces.map((ws) => {
              const active = ws.id === activeWs?.id;
              return (
                <button
                  key={ws.id}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  className={`${styles.wsRow} ${active ? styles.wsRowActive : ""}`}
                  onClick={() => {
                    setSelectedWsId(ws.id);
                    setMobileRailOpen(false);
                  }}
                >
                  <span
                    className={`${styles.wsDot} ${
                      ws.kind === "global"
                        ? styles.wsDotGlobal
                        : ws.mounted
                          ? styles.wsDotMounted
                          : ""
                    }`}
                  />
                  <span className={styles.wsName}>{ws.name}</span>
                  {ws.kind === "global" && (
                    <span className={`${styles.wsTag} ${styles.wsTagGlobal}`}>RO</span>
                  )}
                  {ws.kind === "shared" && (
                    <span className={`${styles.wsTag} ${styles.wsTagShared}`}>{ws.role || "shared"}</span>
                  )}
                </button>
              );
            })}
            {wsLoading && <span className={styles.cardSub}>Loading workspaces…</span>}
          </div>

          {createWsOpen && (
            <form onSubmit={handleCreateWorkspace} className={styles.createWsForm}>
              <input
                type="text"
                className={styles.input}
                placeholder="Workspace name…"
                aria-label="New workspace name"
                value={newWsName}
                onChange={(e) => setNewWsName(e.target.value)}
                autoFocus
              />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--tw-text-3)" }}>
                <input
                  type="checkbox"
                  checked={newWsShared}
                  onChange={(e) => setNewWsShared(e.target.checked)}
                />
                <span>Shared team workspace</span>
              </label>
              <div className={styles.inlineForm}>
                <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !newWsName.trim()}>
                  Create
                </button>
                <button type="button" className={styles.btn} onClick={() => setCreateWsOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>

        <div className={styles.railSection}>
          <div className={styles.railSectionHead}>
            <span>Files ({files.length})</span>
            <div className={styles.railHeadActions}>
              <button
                type="button"
                className={styles.tinyBtn}
                disabled={activeWs?.readOnly || activeWs?.kind === "shared"}
                title={
                  activeWs?.readOnly
                    ? "Read-only workspace"
                    : activeWs?.kind === "shared"
                      ? "Use Ask Tina or Git to add files in shared workspaces"
                      : "Create Markdown document"
                }
                onClick={() => setNewDocOpen(true)}
              >
                <WebIcon name="plus" size={12} />
                <span>Doc</span>
              </button>
              <button
                type="button"
                className={styles.tinyBtn}
                disabled={activeWs?.readOnly}
                title="Upload files to workspace"
                onClick={() => fileInputRef.current?.click()}
              >
                <WebIcon name="upload" size={12} />
              </button>
            </div>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (searchMode === "content") void runContentSearch();
            }}
          >
            <div className={styles.searchBox}>
              <WebIcon name="search" size={13} />
              <input
                type="search"
                aria-label="Search knowledge"
                placeholder={searchMode === "files" ? "Filter filenames…" : "Full-text search…"}
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
                    setContentSearchStatus("");
                  }}
                >
                  <WebIcon name="close" size={12} />
                </button>
              )}
            </div>
            <div className={styles.searchModeRow}>
              <div className={styles.railHeadActions}>
                <button
                  type="button"
                  className={`${styles.chip} ${searchMode === "files" ? styles.chipActive : ""}`}
                  onClick={() => setSearchMode("files")}
                >
                  Filenames
                </button>
                <button
                  type="button"
                  className={`${styles.chip} ${searchMode === "content" ? styles.chipActive : ""}`}
                  onClick={() => setSearchMode("content")}
                >
                  Full-text
                </button>
              </div>
              {searchMode === "content" && (
                <button
                  type="submit"
                  className={styles.tinyBtn}
                  disabled={!searchQuery.trim() || searchingContent}
                >
                  {searchingContent ? "…" : "Go"}
                </button>
              )}
            </div>
          </form>

          {searchMode === "files" && (
            <div className={styles.chipRow}>
              {(
                [
                  ["all", "All"],
                  ["meeting", "Meetings"],
                  ["person", "People"],
                  ["project", "Projects"],
                  ["task", "Tasks"],
                  ["docs", "Docs"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`${styles.chip} ${entityFilter === id ? styles.chipActive : ""}`}
                  onClick={() => setEntityFilter(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={styles.treeWrap}>
          {searchMode === "content" ? (
            <>
              {contentSearchStatus && (
                <div className={styles.cardSub} style={{ padding: "4px 6px 8px" }} role="status">
                  {contentSearchStatus}
                </div>
              )}
              {contentHits.map((hit) => (
                <button
                  key={`${hit.path}:${hit.line}`}
                  type="button"
                  className={styles.searchHit}
                  onClick={() => {
                    setSelectedPath(hit.path);
                    setActiveTab("documents");
                    setMobileRailOpen(false);
                  }}
                >
                  <span className={styles.searchHitMeta}>
                    <span className={styles.treeLabel}>{hit.path}</span>
                    <span>L{hit.line}</span>
                  </span>
                  <span className={styles.searchHitText}>{hit.text}</span>
                </button>
              ))}
              {!contentHits.length && !contentSearchStatus && (
                <p className={styles.cardSub} style={{ padding: "8px 6px" }}>
                  Press Enter or Go to search inside Markdown files of {activeWs?.name}.
                </p>
              )}
            </>
          ) : treeLoading ? (
            <p className={styles.cardSub} style={{ padding: "10px 8px" }}>
              Loading files…
            </p>
          ) : treeNodes.length ? (
            renderTree(treeNodes)
          ) : (
            <p className={styles.cardSub} style={{ padding: "10px 8px" }}>
              No matching files in this workspace.
            </p>
          )}
        </div>
      </aside>

      {/* ── Main Content Area ── */}
      <section className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerLeft}>
            <button
              type="button"
              className={styles.mobileRailBtn}
              aria-label="Toggle workspace files"
              onClick={() => setMobileRailOpen((v) => !v)}
            >
              <WebIcon name="sidebar" size={15} />
            </button>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <h2 className={styles.wsTitle}>{activeWs?.name || "Knowledge"}</h2>
                {activeWs?.kind === "global" ? (
                  <span className={`${styles.wsTag} ${styles.wsTagGlobal}`}>Platform · Read-Only</span>
                ) : activeWs?.kind === "shared" ? (
                  <span className={`${styles.wsTag} ${styles.wsTagShared}`}>Shared · {activeWs.role || "member"}</span>
                ) : (
                  <span className={styles.wsTag}>Personal S3 + KMS</span>
                )}
                {activeWs && activeWs.kind !== "global" && (
                  <button
                    type="button"
                    className={styles.tinyBtn}
                    disabled={busy}
                    onClick={() => handleToggleMount(activeWs)}
                    title="Toggle whether AI agents mount this workspace automatically"
                  >
                    <span className={`${styles.wsDot} ${activeWs.mounted ? styles.wsDotMounted : ""}`} />
                    <span>{activeWs.mounted ? "Mounted in Agent" : "Parked (Click to mount)"}</span>
                  </button>
                )}
              </div>
              {purpose && <p className={styles.wsPurpose}>{purpose}</p>}
            </div>
          </div>

          <div className={styles.tabs} role="tablist" aria-label="Knowledge mode">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "documents"}
              className={`${styles.tabBtn} ${activeTab === "documents" ? styles.tabBtnActive : ""}`}
              onClick={() => setActiveTab("documents")}
            >
              <WebIcon name="fileText" size={14} />
              <span>Documents</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "graph"}
              className={`${styles.tabBtn} ${activeTab === "graph" ? styles.tabBtnActive : ""}`}
              onClick={() => setActiveTab("graph")}
            >
              <WebIcon name="network" size={14} />
              <span>Knowledge Graph</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "sync"}
              className={`${styles.tabBtn} ${activeTab === "sync" ? styles.tabBtnActive : ""}`}
              onClick={() => setActiveTab("sync")}
            >
              <WebIcon name="gitBranch" size={14} />
              <span>History &amp; Sync</span>
            </button>
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

        {/* ── TAB 1: DOCUMENTS ── */}
        {activeTab === "documents" && (
          <div className={styles.docPane}>
            {selectedPath ? (
              <>
                <div className={styles.docToolbar}>
                  <div className={styles.breadcrumb} title={selectedPath}>
                    <WebIcon name="fileText" size={13} />
                    <span>{selectedPath}</span>
                    {doc && (
                      <span className={styles.wsTag} style={{ marginLeft: 6 }}>
                        {doc.writable ? "Editable" : "Read-only"}
                      </span>
                    )}
                  </div>
                  <div className={styles.docActions}>
                    <button
                      type="button"
                      className={styles.btn}
                      onClick={() =>
                        onAskTina(
                          `Read "${selectedPath}" in ${activeWs?.name || "my workspace"} and answer questions or suggest updates based on it.`,
                          "draft",
                        )
                      }
                    >
                      <WebIcon name="tinaAsk" size={13} />
                      <span>Ask Tina</span>
                    </button>
                    {doc?.writable && !editing && (
                      <>
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
                        <button
                          type="button"
                          className={styles.btn}
                          onClick={() => {
                            setMoveDest(selectedPath);
                            setMovePreview(null);
                            setMoveOpen(true);
                          }}
                        >
                          <span>Move</span>
                        </button>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnDanger}`}
                          onClick={handleDeleteDoc}
                          disabled={busy}
                        >
                          <WebIcon name="trash" size={13} />
                        </button>
                      </>
                    )}
                    {editing && (
                      <>
                        <button
                          type="button"
                          className={styles.btn}
                          onClick={() => setEditPreview((v) => !v)}
                        >
                          <WebIcon name="eye" size={13} />
                          <span>{editPreview ? "Write" : "Preview"}</span>
                        </button>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnPrimary}`}
                          disabled={busy}
                          onClick={() => void handleSaveDoc()}
                        >
                          <WebIcon name="check" size={13} />
                          <span>{busy ? "Saving…" : "Save"}</span>
                        </button>
                        <button
                          type="button"
                          className={styles.btn}
                          onClick={() => {
                            setEditing(false);
                            setDraft(doc?.content ?? "");
                          }}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className={styles.docScroll}>
                  <div className={styles.docInner}>
                    {docLoading ? (
                      <p className={styles.cardSub}>Loading document…</p>
                    ) : editing ? (
                      <div className={styles.editorWrap}>
                        {editPreview ? (
                          <div className={styles.docProse}>
                            <DocNavContext.Provider value={handleDocNavigate}>
                              <DocMetaContext.Provider value={{ path: selectedPath, slug: activeWs?.slug }}>
                                <MdxDoc>{parseFrontmatter(draft).body}</MdxDoc>
                              </DocMetaContext.Provider>
                            </DocNavContext.Provider>
                          </div>
                        ) : (
                          <textarea
                            className={styles.editorTextarea}
                            aria-label="Markdown editor"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                                e.preventDefault();
                                void handleSaveDoc();
                              }
                            }}
                          />
                        )}
                        <div className={styles.editorBar}>
                          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
                            <input
                              type="checkbox"
                              checked={commitOnSave}
                              onChange={(e) => setCommitOnSave(e.target.checked)}
                            />
                            <span>Commit to Git history</span>
                          </label>
                          {commitOnSave && (
                            <input
                              type="text"
                              className={styles.input}
                              style={{ maxWidth: 320 }}
                              placeholder={`Update ${selectedPath}`}
                              aria-label="Commit message"
                              value={commitMsg}
                              onChange={(e) => setCommitMsg(e.target.value)}
                            />
                          )}
                        </div>
                      </div>
                    ) : doc && parsedDoc ? (
                      <>
                        <MeetingWikiSourceStatus
                          path={selectedPath}
                          slug={activeWs?.slug}
                          content={doc.content}
                        />
                        {parsedDoc.fm.length > 0 && (
                          <div className={styles.frontmatter} aria-label="Document metadata">
                            {parsedDoc.fm.map(([k, v], i) => (
                              <span key={`${k}-${i}`} className={styles.fmItem}>
                                <span className={styles.fmKey}>{k}</span>
                                <span className={styles.fmVal}>{v}</span>
                              </span>
                            ))}
                          </div>
                        )}
                        <div className={styles.docProse}>
                          <DocNavContext.Provider value={handleDocNavigate}>
                            <DocMetaContext.Provider value={{ path: selectedPath, slug: activeWs?.slug }}>
                              <MdxDoc>{parsedDoc.body}</MdxDoc>
                            </DocMetaContext.Provider>
                          </DocNavContext.Provider>
                        </div>
                      </>
                    ) : (
                      <p className={styles.cardSub}>Document could not be loaded.</p>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className={styles.emptyState}>
                <WebIcon name="bookOpen" size={28} />
                <h3>Select or create a document</h3>
                <p>
                  Browse your workspace Markdown files on the left, explore relationships in the Knowledge Graph, or
                  view the Platform Guide (<code>_global</code>).
                </p>
                {activeWs && !activeWs.readOnly && activeWs.kind !== "shared" && (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => setNewDocOpen(true)}
                  >
                    <WebIcon name="plus" size={14} />
                    <span>New Markdown doc</span>
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* ── TAB 2: KNOWLEDGE GRAPH ── */}
        {activeTab === "graph" && activeWs && (
          <KnowledgeGraphCanvas
            slug={activeWs.slug}
            workspaceName={activeWs.name}
            isReadOnly={activeWs.readOnly || activeWs.kind === "shared"}
            onOpenDocument={(path) => {
              setSelectedPath(path);
              setActiveTab("documents");
            }}
            onAskTina={(prompt) => onAskTina(prompt, "send")}
            onCreateEntity={() => {
              setNewDocKind("project");
              setNewDocOpen(true);
            }}
          />
        )}

        {/* ── TAB 3: HISTORY & SYNC ── */}
        {activeTab === "sync" && activeWs && (
          <div className={styles.syncScroll}>
            <div className={styles.syncGrid}>
              {activeWs.kind !== "global" ? (
                <>
                  {/* GitHub Sync Card */}
                  <section className={styles.card}>
                    <div className={styles.cardHead}>
                      <div>
                        <h3 className={styles.cardTitle}>
                          <WebIcon name="github" size={16} />
                          <span>GitHub Sync</span>
                        </h3>
                        <p className={styles.cardSub}>
                          {remoteStatus?.has_home
                            ? `Connected to ${remoteStatus.url} (${remoteStatus.branch || "main"}) · ${remoteStatus.ahead} ahead / ${remoteStatus.behind} behind`
                            : "Publish this workspace to GitHub or sync with an existing repository."}
                        </p>
                      </div>
                      <div className={styles.inlineForm}>
                        <span className={styles.wsTag}>
                          {gitToken.set ? `Token saved (${gitToken.masked})` : "No GitHub token"}
                        </span>
                        {onOpenGitHubSettings && (
                          <button type="button" className={styles.btn} onClick={onOpenGitHubSettings}>
                            <span>Manage token</span>
                          </button>
                        )}
                      </div>
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
                              setNotice(r.updated ? `Pulled ${r.head_sha.slice(0, 7)} from ${r.remote}.` : "Already up to date.");
                            })
                          }
                        >
                          <WebIcon name="download" size={13} />
                          <span>Pull</span>
                        </button>
                        <button
                          type="button"
                          className={`${styles.btn} ${styles.btnPrimary}`}
                          disabled={busy}
                          onClick={() =>
                            void runAction(async () => {
                              const r = await pushWorkspace({ slug: activeWs.slug });
                              await loadGitAndSync(activeWs);
                              setNotice(`Pushed ${r.head_sha.slice(0, 7)} to ${r.url}.`);
                            })
                          }
                        >
                          <WebIcon name="upload" size={13} />
                          <span>Push</span>
                        </button>
                        {remoteStatus.url && (
                          <a
                            href={remoteStatus.url.replace(/\.git$/, "")}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.btn}
                          >
                            <WebIcon name="externalLink" size={13} />
                            <span>Open on GitHub</span>
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
                          <span>Private repo</span>
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
                  </section>

                  {/* Workspace Purpose, Share & Lifecycle */}
                  <section className={styles.card}>
                    <div className={styles.cardHead}>
                      <div>
                        <h3 className={styles.cardTitle}>
                          <WebIcon name="sliders" size={15} />
                          <span>Workspace Settings &amp; Sharing</span>
                        </h3>
                        <p className={styles.cardSub}>
                          Describe this workspace’s purpose so AI agents automatically route notes here.
                        </p>
                      </div>
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
                        }, "Workspace purpose updated.");
                      }}
                    >
                      <input
                        type="text"
                        className={styles.input}
                        style={{ flex: 1, minWidth: 220 }}
                        aria-label="Workspace purpose"
                        placeholder="e.g., Product roadmap, customer specs, and weekly sync decisions"
                        value={purposeDraft}
                        onChange={(e) => setPurposeDraft(e.target.value)}
                      />
                      <button type="submit" className={styles.btn} disabled={busy}>
                        Save purpose
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
                          }, "Workspace renamed.");
                        }}
                      >
                        <input
                          type="text"
                          className={styles.input}
                          style={{ maxWidth: 260 }}
                          aria-label="Workspace display name"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                        />
                        <button type="submit" className={styles.btn} disabled={busy}>
                          Rename
                        </button>
                      </form>
                    )}

                    <div className={styles.inlineForm}>
                      <button
                        type="button"
                        className={styles.btn}
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
                          }, "Share invite link generated (valid 7 days).")
                        }
                      >
                        <WebIcon name="share" size={13} />
                        <span>Mint share link</span>
                      </button>

                      {activeWs.kind === "extra" && activeWs.slotSlug && (
                        <>
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={busy}
                            onClick={() =>
                              void runAction(async () => {
                                await archiveWorkspace(activeWs.slotSlug!, true);
                                await loadWorkspaces();
                                setSelectedWsId("personal");
                              }, `Archived "${activeWs.name}".`)
                            }
                          >
                            Archive
                          </button>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnDanger}`}
                            disabled={busy}
                            onClick={() => {
                              if (
                                typeof window !== "undefined" &&
                                !window.confirm(`Permanently delete workspace "${activeWs.name}"?`)
                              ) {
                                return;
                              }
                              void runAction(async () => {
                                await deleteWorkspace(activeWs.slotSlug!);
                                await loadWorkspaces();
                                setSelectedWsId("personal");
                              }, `Deleted "${activeWs.name}".`);
                            }}
                          >
                            <WebIcon name="trash" size={13} />
                            <span>Delete workspace</span>
                          </button>
                        </>
                      )}
                    </div>

                    {inviteLink && (
                      <div className={styles.inlineForm}>
                        <input
                          type="text"
                          readOnly
                          className={styles.input}
                          style={{ flex: 1 }}
                          value={inviteLink}
                          aria-label="Workspace invite URL"
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
                  </section>
                </>
              ) : (
                <section className={styles.card}>
                  <h3 className={styles.cardTitle}>
                    <WebIcon name="shield" size={15} />
                    <span>Platform Read-Only Workspace (_global)</span>
                  </h3>
                  <p className={styles.cardSub}>
                    This workspace is maintained centrally by TINA on KMS-encrypted S3 and mounted read-only into every
                    user’s AI agent session. Editing and GitHub sync are disabled.
                  </p>
                </section>
              )}

              {/* Git Commit History + Diff */}
              <section className={styles.card}>
                <div className={styles.cardHead}>
                  <div>
                    <h3 className={styles.cardTitle}>
                      <WebIcon name="clock" size={15} />
                      <span>Revision History</span>
                    </h3>
                    <p className={styles.cardSub}>
                      {gitState
                        ? `Branch ${gitState.branch} · ${gitState.commits.length} recent commit(s)`
                        : "Loading Git history…"}
                    </p>
                  </div>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => void loadGitAndSync(activeWs)}
                  >
                    <WebIcon name="refresh" size={13} />
                    <span>Refresh</span>
                  </button>
                </div>

                <div className={styles.commitList}>
                  {(gitState?.commits ?? []).map((commit) => {
                    const open = expandedSha === commit.sha;
                    return (
                      <div key={commit.sha} className={styles.commitCard}>
                        <button
                          type="button"
                          className={styles.commitHead}
                          onClick={() => void handleToggleCommitDiff(commit.sha)}
                          aria-expanded={open}
                        >
                          <span className={styles.treeLabel}>{commit.msg}</span>
                          <span className={styles.commitMeta}>
                            <span>{commit.kind === "member" ? commit.author || "member" : commit.kind || "you"}</span>
                            <span className={styles.sha}>{commit.sha.slice(0, 7)}</span>
                            <span>{commit.when}</span>
                          </span>
                        </button>
                        {open && (
                          <div>
                            {commit.files && commit.files.length > 0 && (
                              <div className={styles.chipRow} style={{ padding: "6px 12px", marginTop: 0 }}>
                                {commit.files.map((fp) => (
                                  <button
                                    key={fp}
                                    type="button"
                                    className={styles.chip}
                                    onClick={() => {
                                      setSelectedPath(fp);
                                      setActiveTab("documents");
                                    }}
                                  >
                                    {fp}
                                  </button>
                                ))}
                              </div>
                            )}
                            <pre className={styles.diffPre}>
                              {diffsBySha[commit.sha]
                                ? renderDiffLines(diffsBySha[commit.sha])
                                : "Loading diff…"}
                            </pre>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {gitState && gitState.commits.length === 0 && (
                    <p className={styles.cardSub}>No commits yet in this workspace.</p>
                  )}
                </div>
              </section>
            </div>
          </div>
        )}
      </section>

      {/* ── Create Document Modal ── */}
      {newDocOpen && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Create Markdown document"
          onClick={() => setNewDocOpen(false)}
        >
          <form className={styles.modalCard} onClick={(e) => e.stopPropagation()} onSubmit={handleCreateDoc}>
            <h3 className={styles.modalTitle}>Create Markdown document</h3>
            <div className={styles.chipRow} style={{ marginTop: 0 }}>
              {(
                [
                  ["wiki", "Wiki Page"],
                  ["notes", "Note"],
                  ["project", "Project Entity"],
                  ["person", "Person Entity"],
                ] as const
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  className={`${styles.chip} ${newDocKind === kind ? styles.chipActive : ""}`}
                  onClick={() => setNewDocKind(kind)}
                >
                  {label}
                </button>
              ))}
            </div>
            <input
              type="text"
              className={styles.input}
              placeholder="Document title (e.g., Q4 Architecture Plan)"
              aria-label="Document title"
              value={newDocTitle}
              onChange={(e) => setNewDocTitle(e.target.value)}
              autoFocus
            />
            <input
              type="text"
              className={styles.input}
              placeholder={newDocTemplate(newDocKind, newDocTitle || "untitled").path}
              aria-label="Custom document path"
              value={newDocCustomPath}
              onChange={(e) => setNewDocCustomPath(e.target.value)}
            />
            <div className={styles.inlineForm} style={{ justifyContent: "flex-end" }}>
              <button type="button" className={styles.btn} onClick={() => setNewDocOpen(false)}>
                Cancel
              </button>
              <button type="submit" className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || !newDocTitle.trim()}>
                {busy ? "Creating…" : "Create document"}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Move / Rename Document Modal ── */}
      {moveOpen && selectedPath && (
        <div
          className={styles.modalBackdrop}
          role="dialog"
          aria-modal="true"
          aria-label="Move or rename document"
          onClick={() => setMoveOpen(false)}
        >
          <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
            <h3 className={styles.modalTitle}>Move or rename document</h3>
            <p className={styles.cardSub}>Current: {selectedPath}</p>
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
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <input
                type="checkbox"
                checked={moveUpdateLinks}
                onChange={(e) => {
                  setMoveUpdateLinks(e.target.checked);
                  setMovePreview(null);
                }}
              />
              <span>Automatically update [[wikilinks]] across workspace</span>
            </label>
            {movePreview && (
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
            <div className={styles.inlineForm} style={{ justifyContent: "flex-end" }}>
              <button type="button" className={styles.btn} onClick={() => setMoveOpen(false)}>
                Cancel
              </button>
              {moveUpdateLinks && !movePreview ? (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy || !moveDest.trim() || moveDest.trim() === selectedPath}
                  onClick={() => void handlePreviewMove()}
                >
                  Preview link updates
                </button>
              ) : (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={busy || !moveDest.trim() || moveDest.trim() === selectedPath}
                  onClick={() => void handleConfirmMove()}
                >
                  Confirm move
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
