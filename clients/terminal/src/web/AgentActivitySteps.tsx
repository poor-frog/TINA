"use client";
// Lucian UX/UI Prompt #454 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#454
/** AgentActivitySteps — Collapsible, human-friendly tool execution summary shared across
 *  Ask Tina, Meeting SidePanel, and Knowledge Copilot. Upgraded with Lucian #454 vertical
 *  task progression timeline, animated check marks, connecting progress rail, and live timer. */
import { useEffect, useMemo, useRef, useState } from "react";
import { WebIcon, type WebIconName } from "./Icons";
import styles from "./agentActivitySteps.module.css";
import "./lucian/lucian-454.css";

export interface ToolDescriptor {
  icon: WebIconName;
  active: string;
  done: string;
  pluralDone: (count: number) => string;
  kind: "read" | "write" | "web" | "tool";
}

export function normalizeAgentToolName(rawTool: string): string {
  const trimmed = rawTool.trim();
  const mcpMatch = /^mcp__(?:tina[-_](?:workspace|reach))__(.+)$/i.exec(trimmed);
  return mcpMatch ? mcpMatch[1] : trimmed;
}

export function describeAgentTool(rawTool: string): ToolDescriptor {
  const normalized = normalizeAgentToolName(rawTool);
  switch (normalized) {
    case "list_wiki":
    case "Glob":
      return {
        icon: "folder",
        active: "Browsing Knowledge library…",
        done: "Browsed Knowledge library",
        pluralDone: (n) => `Browsed Knowledge (${n})`,
        kind: "read",
      };
    case "search_wiki":
    case "Grep":
      return {
        icon: "search",
        active: "Searching Knowledge…",
        done: "Searched Knowledge",
        pluralDone: (n) => `Searched Knowledge (${n})`,
        kind: "read",
      };
    case "read_wiki":
    case "Read":
      return {
        icon: "fileText",
        active: "Reading page…",
        done: "Read page",
        pluralDone: (n) => `Read ${n} pages`,
        kind: "read",
      };
    case "create_wiki":
    case "Write":
      return {
        icon: "plus",
        active: "Creating page…",
        done: "Created page",
        pluralDone: (n) => `Created ${n} pages`,
        kind: "write",
      };
    case "update_wiki":
    case "Edit":
    case "FileChange":
      return {
        icon: "edit",
        active: "Updating page…",
        done: "Updated page",
        pluralDone: (n) => `Updated ${n} pages`,
        kind: "write",
      };
    case "delete_wiki":
      return {
        icon: "trash",
        active: "Deleting page…",
        done: "Deleted page",
        pluralDone: (n) => `Deleted ${n} pages`,
        kind: "write",
      };
    case "move_wiki":
      return {
        icon: "folder",
        active: "Moving page…",
        done: "Moved page",
        pluralDone: (n) => `Moved ${n} pages`,
        kind: "write",
      };
    case "reach_web_search":
    case "WebSearch":
      return {
        icon: "globe",
        active: "Searching the web…",
        done: "Searched the web",
        pluralDone: (n) => `Web searches (${n})`,
        kind: "web",
      };
    case "reach_web_read":
    case "WebFetch":
      return {
        icon: "globe",
        active: "Reading web page…",
        done: "Read web page",
        pluralDone: (n) => `Read ${n} web pages`,
        kind: "web",
      };
    case "reach_github_search":
    case "reach_github_read":
      return {
        icon: "github",
        active: "Checking GitHub…",
        done: "Checked GitHub",
        pluralDone: (n) => `Checked GitHub (${n})`,
        kind: "web",
      };
    default: {
      const pretty = rawTool
        .replace(/[_-]+/g, " ")
        .trim()
        .replace(/^\w/, (c) => c.toUpperCase());
      return {
        icon: "zap",
        active: `${pretty || "Running action"}…`,
        done: pretty || "Ran action",
        pluralDone: (n) => `${pretty || "Ran action"} (${n})`,
        kind: "tool",
      };
    }
  }
}

interface GroupedStep {
  tool: string;
  count: number;
  desc: ToolDescriptor;
}

const STEP_ROW_H = 38;

export function AgentActivitySteps({
  ops,
  streaming = false,
  commit,
  compact = false,
  showRawToolNames = false,
}: {
  ops?: string[];
  streaming?: boolean;
  commit?: string;
  compact?: boolean;
  showRawToolNames?: boolean;
}) {
  const [expanded, setExpanded] = useState(streaming);
  const [userToggled, setUserToggled] = useState(false);
  const [elapsedSec, setElapsedSec] = useState(0);
  const startedAtRef = useRef<number>(Date.now());
  const prevStreamingRef = useRef<boolean>(streaming);

  useEffect(() => {
    if (streaming && !prevStreamingRef.current) {
      startedAtRef.current = Date.now();
      setElapsedSec(0);
      if (!userToggled) setExpanded(true);
    } else if (!streaming && prevStreamingRef.current) {
      setElapsedSec(Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000)));
      if (!userToggled) setExpanded(false);
    }
    prevStreamingRef.current = streaming;
  }, [streaming, userToggled]);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  const grouped = useMemo<GroupedStep[]>(() => {
    if (!ops || ops.length === 0) return [];
    const out: GroupedStep[] = [];
    for (const op of ops) {
      const prev = out[out.length - 1];
      if (prev && prev.tool === op) {
        prev.count += 1;
      } else {
        out.push({ tool: op, count: 1, desc: describeAgentTool(op) });
      }
    }
    return out;
  }, [ops]);

  if (grouped.length === 0) return null;

  const totalSteps = ops?.length ?? 0;
  const lastStep = grouped[grouped.length - 1];

  const summaryParts = grouped.slice(0, 3).map((g) => (g.count > 1 ? g.desc.pluralDone(g.count) : g.desc.done));
  if (grouped.length > 3) summaryParts.push(`+${grouped.length - 3} more`);
  const summaryText = streaming
    ? lastStep.desc.active
    : `${totalSteps === 1 ? "1 step" : `${totalSteps} steps`} · ${summaryParts.join(", ")}`;

  const totalRows = grouped.length + (commit ? 1 : 0);
  const completedRows = streaming ? Math.max(0, totalRows - 1) : totalRows;
  const fillRatio =
    totalRows <= 1 ? 1 : Math.min(1, Math.max(0, (completedRows - (streaming ? 0 : 1)) / (totalRows - 1)));
  const trackHeight = Math.max(0, (totalRows - 1) * STEP_ROW_H);

  return (
    <div
      className={`${styles.root} ${compact ? styles.compact : ""} ${streaming ? styles.streaming : ""}`}
      data-testid="agent-activity-steps"
    >
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={expanded}
        onClick={() => {
          setUserToggled(true);
          setExpanded((v) => !v);
        }}
      >
        <span
          className={`${styles.leadIcon} ${streaming ? styles.leadIconLive : styles.leadIconDone}`}
          aria-hidden="true"
        >
          {streaming ? (
            <span className={styles.liveDot} />
          ) : (
            <WebIcon name={commit ? "check" : lastStep.desc.icon} size={11} />
          )}
        </span>
        <span className={styles.summary}>{summaryText}</span>
        {streaming && totalSteps > 1 && <span className={styles.stepBadge}>{totalSteps}</span>}
        <span className={`${styles.chevron} ${expanded ? styles.chevronOpen : ""}`} aria-hidden="true">
          <WebIcon name="chevronDown" size={12} />
        </span>
      </button>

      {expanded && (
        <div className={`ux u454 ${!streaming ? "is-done" : ""} ${compact ? "is-compact" : ""}`}>
          <div className="u454-c">
            {totalRows > 1 && (
              <i className="u454-tr" aria-hidden="true" style={{ height: `${trackHeight}px` }}>
                <i style={{ "--u454-p": fillRatio.toFixed(3) } as React.CSSProperties} />
              </i>
            )}
            <ol className="u454-l" aria-label="Agent tool activity">
              {grouped.map((step, idx) => {
                const isActiveStep = streaming && idx === grouped.length - 1;
                const state = isActiveStep ? "run" : "done";
                const label = isActiveStep
                  ? step.desc.active
                  : step.count > 1
                    ? step.desc.pluralDone(step.count)
                    : step.desc.done;
                return (
                  <li
                    key={`${step.tool}-${idx}`}
                    className="u454-s"
                    data-s={state}
                    aria-current={isActiveStep ? "step" : undefined}
                  >
                    <span className="u454-ic" aria-hidden="true">
                      <i className="u454-d" />
                      <i className="u454-sp" />
                      <span className="u454-ck">
                        <svg viewBox="0 0 24 24">
                          <path d="m6 12.5 4 4 8-9" />
                        </svg>
                      </span>
                    </span>
                    <span className="u454-t">{label}</span>
                    {(showRawToolNames || step.count > 1) && (
                      <span className="u454-m">
                        {showRawToolNames ? <code>{step.tool}</code> : `×${step.count}`}
                      </span>
                    )}
                  </li>
                );
              })}
              {commit && (
                <li className="u454-s" data-s="done">
                  <span className="u454-ic" aria-hidden="true">
                    <i className="u454-d" />
                    <i className="u454-sp" />
                    <span className="u454-ck">
                      <svg viewBox="0 0 24 24">
                        <path d="m6 12.5 4 4 8-9" />
                      </svg>
                    </span>
                  </span>
                  <span className="u454-t">Saved changes to workspace</span>
                  {showRawToolNames && (
                    <span className="u454-m">
                      <code>{commit.slice(0, 7)}</code>
                    </span>
                  )}
                </li>
              )}
            </ol>

            <div className="u454-f">
              <span className="u454-fi" aria-hidden="true">
                <i className="u454-pu" />
                <svg className="u454-ok" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="9.2" />
                  <path d="m8 12.3 2.8 2.8L16.2 9.6" />
                </svg>
              </span>
              <span className="u454-fx">
                <span className="u454-fw" aria-hidden={!streaming || undefined}>
                  <b>Working</b>
                  <small>{elapsedSec}s</small>
                </span>
                <span className="u454-fd" aria-hidden={streaming || undefined}>
                  <b>Done</b>
                  <small>
                    · {totalSteps === 1 ? "1 step" : `${totalSteps} steps`}
                    {elapsedSec > 0 ? ` · ${elapsedSec}s` : ""}
                  </small>
                </span>
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
