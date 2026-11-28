"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WebIcon } from "./Icons";
import { LucianSlidingTabs } from "./lucian/LucianSlidingTabs";
import { LucianSkeletonList } from "./lucian/LucianSkeletonCard";
import { LucianTaskChecklist } from "./lucian/LucianTaskChecklist";
import { emitWebToast } from "./lucian/webToast";
import { patchFrontmatterField } from "./knowledgeFriendly";
import { Markdown } from "../ui-kit/Markdown";
import {
  listSharedMemberships,
  listWorkspaceTree,
  readAttachedWorkspaces,
  readWorkspaceDocument,
  readWorkspaceFile,
  saveWorkspaceDocument,
  type Membership,
} from "../surfaces/workspaceApi";
import { presentError } from "../surfaces/apiClient";

interface TaskItem {
  path: string;
  title: string;
  state: string;
  priority: string;
  due?: string;
  assignee?: string;
  body: string;
}

function isTaskDone(state: string): boolean {
  return state === "done" || state === "accepted" || state === "completed";
}

function parseTaskFile(path: string, content: string): TaskItem {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = content;
  if (m) {
    for (const line of m[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) meta[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    body = m[2].trim();
  }
  const fallbackTitle = path.split("/").pop()?.replace(/\.md$/, "") || path;
  return {
    path,
    title: meta.title || fallbackTitle,
    state: (meta.status || meta.state || "draft").toLowerCase(),
    priority: (meta.priority || "").toLowerCase(),
    due: meta.due,
    assignee: meta.assignee || meta.owner,
    body,
  };
}

export function TasksView({ onAskTina }: { onAskTina: (prompt: string, mode?: "draft") => void }) {
  const [workspace, setWorkspace] = useState("");
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [workspaceNames, setWorkspaceNames] = useState<Record<string, string>>({});
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const loadVersion = useRef(0);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [togglingPath, setTogglingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writable = !workspace || memberships.some(
    (member) => member.workspace_id === workspace && (member.role === "owner" || member.role === "contributor"),
  );

  useEffect(() => {
    let active = true;
    void Promise.all([listSharedMemberships(), readAttachedWorkspaces().catch(() => null)])
      .then(([members, attached]) => {
        if (!active) return;
        setMemberships(members);
        setWorkspaceNames(Object.fromEntries(
          Object.entries(attached?.slots ?? {}).map(([id, slot]) => [id, slot.name || id]),
        ));
      })
      .catch((err) => {
        if (active) setWorkspaceError(presentError(err).headline);
      });
    return () => { active = false; };
  }, []);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    const scope = workspace ? { slug: workspace } : undefined;
    setLoading(true);
    try {
      const tree = scope ? await listWorkspaceTree(scope) : await listWorkspaceTree();
      const files = tree.filter((f) => /^kg\/entities\/task\/(?!index\.md$|log\.md$)[^/]+\.md$/.test(f));
      const items = (
        await Promise.all(
          files.map(async (path) => {
            const content = scope ? await readWorkspaceFile(path, scope) : await readWorkspaceFile(path);
            return content === null ? null : parseTaskFile(path, content);
          }),
        )
      ).filter((x): x is TaskItem => x !== null);
      if (version !== loadVersion.current) return;
      setTasks(items);
      setSelectedPath((cur) => (cur && items.some((i) => i.path === cur) ? cur : items[0]?.path ?? null));
      setError(null);
    } catch (err) {
      if (version === loadVersion.current) setError(presentError(err).headline);
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    void load();
    const onChanged = (e: Event) => {
      if ((e as CustomEvent<{ source?: string }>).detail?.source === "tasks-view") return;
      void load();
    };
    window.addEventListener("tina:tasks-changed", onChanged);
    return () => {
      loadVersion.current += 1;
      window.removeEventListener("tina:tasks-changed", onChanged);
    };
  }, [load]);

  const handleToggleDone = useCallback(
    async (path: string, nextDone: boolean) => {
      const target = tasks.find((t) => t.path === path);
      if (!writable || !target || togglingPath) return;
      const prevState = target.state;
      const nextState = nextDone ? "done" : "open";

      setTasks((cur) => cur.map((t) => (t.path === path ? { ...t, state: nextState } : t)));
      setTogglingPath(path);
      setError(null);

      try {
        const doc = workspace ? await readWorkspaceDocument(path, { slug: workspace }) : await readWorkspaceDocument(path);
        const patched = patchFrontmatterField(doc.content, "status", nextState);
        await saveWorkspaceDocument({
          path,
          ...(workspace ? { slug: workspace } : {}),
          content: patched,
          expected_sha256: doc.sha256,
          commit: false,
          commit_message: `${nextDone ? "Complete" : "Reopen"} task ${target.title}`,
        });
        emitWebToast(nextDone ? `Completed “${target.title}”` : `Reopened “${target.title}”`);
        window.dispatchEvent(new CustomEvent("tina:tasks-changed", { detail: { source: "tasks-view" } }));
      } catch (err) {
        setTasks((cur) => cur.map((t) => (t.path === path ? { ...t, state: prevState } : t)));
        const msg = presentError(err).headline;
        setError(msg);
        emitWebToast({ message: msg, tone: "error" });
      } finally {
        setTogglingPath((cur) => (cur === path ? null : cur));
      }
    },
    [tasks, togglingPath, workspace, writable],
  );

  const doneCount = useMemo(() => tasks.filter((t) => isTaskDone(t.state)).length, [tasks]);
  const openCount = tasks.length - doneCount;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      const done = isTaskDone(t.state);
      if (filter === "open" && done) return false;
      if (filter === "done" && !done) return false;
      if (!q) return true;
      return `${t.title} ${t.state} ${t.assignee ?? ""} ${t.body}`.toLowerCase().includes(q);
    });
  }, [tasks, filter, query]);

  const selected = visible.find((t) => t.path === selectedPath) ?? visible[0] ?? null;

  return (
    <div className="tina-web-view-scroll">
      <div className="tina-web-page-wrap">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 style={{ margin: "0 0 4px", fontFamily: "var(--tw-font-display)", fontSize: 24, fontWeight: 500 }}>
              Tasks &amp; Action Items
            </h1>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--tw-text-3)" }}>
              Tracked in your workspace under <code>kg/entities/task/</code>. Tina drafts items for human review.
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="tina-web-btn-ghost" onClick={() => void load()}>
              <WebIcon name="refresh" size={14} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="tina-web-btn-primary"
              disabled={!writable}
              onClick={() => onAskTina(
                `Draft action items from my latest meeting for ${workspace ? `shared workspace "${workspace}"` : "my primary workspace"}. ` +
                "Show the drafts for review before saving. After approval, create a Markdown file per item at " +
                "kg/entities/task/<slug>.md with YAML frontmatter id: task/<slug>, type: task, title, and status: open. " +
                "Only include an assignee or due date if the meeting states it. Report the workspace and path returned by the write operation.",
              )}
            >
              <WebIcon name="plus" size={14} />
              <span>Draft tasks with Tina</span>
            </button>
          </div>
        </div>

        <div className="tina-web-tasks-toolbar">
          <label className="tina-web-field">
            <span className="sr-only">Workspace</span>
            <select value={workspace} disabled={!!togglingPath} onChange={(event) => {
              loadVersion.current += 1;
              setTasks([]);
              setSelectedPath(null);
              setError(null);
              setLoading(true);
              setWorkspace(event.target.value);
            }}>
              <option value="">My workspace</option>
              {memberships.map(({ workspace_id: id }) => <option key={id} value={id}>{workspaceNames[id] || id}</option>)}
            </select>
          </label>
          <LucianSlidingTabs
            ariaLabel="Task status filter"
            value={filter}
            onChange={setFilter}
            tabs={[
              { id: "all", label: "All", count: tasks.length },
              { id: "open", label: "Open / Draft", count: openCount },
              { id: "done", label: "Completed", count: doneCount },
            ]}
          />
          <input
            type="search"
            className="tina-web-filter-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            aria-label="Search tasks"
          />
        </div>

        {workspaceError && <p role="alert">Shared workspaces are unavailable. {workspaceError}</p>}
        {error && (
          <div role="alert" style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "var(--tw-danger-bg)", color: "var(--tw-danger)", fontSize: 13 }}>
            {error}
          </div>
        )}

        <div className="tina-web-tasks-grid">
          <div className="tina-web-panel" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {loading && tasks.length === 0 ? (
              <LucianSkeletonList count={4} variant="row" label="Loading tasks…" />
            ) : visible.length === 0 ? (
              <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--tw-text-4)", fontSize: 13.5 }}>
                No tasks found. Ask Tina to draft action items from a meeting.
              </div>
            ) : (
              <LucianTaskChecklist
                tasks={visible.map((task) => ({
                  path: task.path,
                  title: task.title,
                  state: task.state,
                  done: isTaskDone(task.state),
                  priority: task.priority,
                  meta:
                    [task.assignee, task.due ? `Due ${task.due}` : "", task.priority].filter(Boolean).join(" · ") ||
                    task.path,
                }))}
                totalCount={tasks.length}
                doneCount={doneCount}
                selectedPath={selected?.path ?? null}
                togglingPath={togglingPath}
                readOnly={!writable}
                onSelect={setSelectedPath}
                onToggleDone={(path, nextDone) => void handleToggleDone(path, nextDone)}
              />
            )}
          </div>

          <div className="tina-web-panel">
            {selected ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{selected.title}</h2>
                  <button
                    type="button"
                    className="tina-web-btn-ghost"
                    disabled={!writable}
                    onClick={() => onAskTina(
                      workspace ? `Update task in shared workspace "${workspace}" at ${selected.path}: ` : `Update task @file:${selected.path}: `,
                      "draft",
                    )}
                  >
                    Ask Tina to update
                  </button>
                </div>
                <div style={{ fontSize: 12, color: "var(--tw-text-4)", marginBottom: 14 }}>
                  {selected.path}
                </div>
                {selected.body ? (
                  <Markdown>{selected.body}</Markdown>
                ) : (
                  <div style={{ color: "var(--tw-text-4)", fontSize: 13 }}>No additional details in this task note.</div>
                )}
              </div>
            ) : (
              <div style={{ padding: "32px 12px", textAlign: "center", color: "var(--tw-text-4)", fontSize: 13.5 }}>
                Select a task to view its full note and linked meeting context.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
