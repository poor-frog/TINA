"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WebIcon } from "./Icons";
import { Markdown } from "../ui-kit/Markdown";
import { listWorkspaceTree, readWorkspaceFile } from "../surfaces/workspaceApi";
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
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "open" | "done">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const tree = await listWorkspaceTree();
      const files = tree.filter((f) => f.startsWith("kg/entities/task/"));
      const items = (
        await Promise.all(
          files.map(async (path) => {
            const content = await readWorkspaceFile(path);
            return content === null ? null : parseTaskFile(path, content);
          }),
        )
      ).filter((x): x is TaskItem => x !== null);
      setTasks(items);
      setSelectedPath((cur) => (cur && items.some((i) => i.path === cur) ? cur : items[0]?.path ?? null));
      setError(null);
    } catch (err) {
      setError(presentError(err).headline);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const onChanged = () => void load();
    window.addEventListener("tina:tasks-changed", onChanged);
    return () => window.removeEventListener("tina:tasks-changed", onChanged);
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((t) => {
      const isDone = t.state === "done" || t.state === "accepted" || t.state === "completed";
      if (filter === "open" && isDone) return false;
      if (filter === "done" && !isDone) return false;
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
              onClick={() => onAskTina("Extract and draft action items from my latest meeting as workspace tasks.")}
            >
              <WebIcon name="plus" size={14} />
              <span>Draft tasks with Tina</span>
            </button>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 20 }}>
          <div className="tina-web-tabs">
            {(["all", "open", "done"] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={`tina-web-tab ${filter === f ? "active" : ""}`}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : f === "open" ? "Open / Draft" : "Completed"}
              </button>
            ))}
          </div>
          <input
            type="search"
            className="tina-web-filter-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tasks…"
            aria-label="Search tasks"
          />
        </div>

        {error && (
          <div role="alert" style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "var(--tw-danger-bg)", color: "var(--tw-danger)", fontSize: 13 }}>
            {error}
          </div>
        )}

        <div className="tina-web-tasks-grid">
          <div className="tina-web-panel" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {loading && <div style={{ padding: 12, color: "var(--tw-text-4)", fontSize: 13 }}>Loading tasks…</div>}
            {!loading && visible.length === 0 && (
              <div style={{ padding: "24px 12px", textAlign: "center", color: "var(--tw-text-4)", fontSize: 13.5 }}>
                No tasks found. Ask Tina to draft action items from a meeting.
              </div>
            )}
            {visible.map((task) => {
              const active = selected?.path === task.path;
              const pillClass = ["done", "accepted", "draft", "rejected", "pending", "open"].includes(task.state)
                ? task.state
                : "open";
              return (
                <button
                  key={task.path}
                  type="button"
                  onClick={() => setSelectedPath(task.path)}
                  className="tina-web-feed-row"
                  style={{
                    minHeight: 54,
                    border: active ? "1px solid rgba(145, 215, 190, 0.28)" : "1px solid transparent",
                    background: active ? "rgba(23, 107, 91, 0.14)" : undefined,
                  }}
                >
                  <span className="tina-web-feed-main">
                    <span className="tina-web-feed-title">
                      <span>{task.title}</span>
                      <span className={`tina-web-task-pill ${pillClass}`}>{task.state}</span>
                    </span>
                    <span className="tina-web-feed-meta">
                      {[task.assignee, task.due ? `Due ${task.due}` : "", task.priority].filter(Boolean).join(" · ") || task.path}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          <div className="tina-web-panel">
            {selected ? (
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 12 }}>
                  <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>{selected.title}</h2>
                  <button
                    type="button"
                    className="tina-web-btn-ghost"
                    onClick={() => onAskTina(`Update task @file:${selected.path}: `, "draft")}
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
