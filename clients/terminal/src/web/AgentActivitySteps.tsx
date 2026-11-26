"use client";
/** AgentActivitySteps — Collapsible, human-friendly tool execution summary shared across
 *  Ask Tina, Meeting SidePanel, and Knowledge Copilot. Replaces raw snake_case tool pills
 *  with a calm single-line timeline that expands on click. */
import { useMemo, useState } from "react";
import { WebIcon, type WebIconName } from "./Icons";
import styles from "./agentActivitySteps.module.css";

export interface ToolDescriptor {
  icon: WebIconName;
  active: string;
  done: string;
  pluralDone: (count: number) => string;
  kind: "read" | "write" | "web" | "tool";
}

export function describeAgentTool(rawTool: string): ToolDescriptor {
  switch (rawTool) {
    case "list_wiki":
      return {
        icon: "folder",
        active: "Browsing Knowledge library…",
        done: "Browsed Knowledge library",
        pluralDone: (n) => `Browsed Knowledge (${n})`,
        kind: "read",
      };
    case "search_wiki":
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
  const [expanded, setExpanded] = useState(false);

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

  return (
    <div
      className={`${styles.root} ${compact ? styles.compact : ""} ${streaming ? styles.streaming : ""}`}
      data-testid="agent-activity-steps"
    >
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
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
        <ol className={styles.timeline} aria-label="Agent tool activity">
          {grouped.map((step, idx) => {
            const isActiveStep = streaming && idx === grouped.length - 1;
            const label = isActiveStep
              ? step.desc.active
              : step.count > 1
                ? step.desc.pluralDone(step.count)
                : step.desc.done;
            return (
              <li
                key={`${step.tool}-${idx}`}
                className={`${styles.stepRow} ${styles[`kind_${step.desc.kind}`]} ${isActiveStep ? styles.stepActive : ""}`}
              >
                <span className={styles.stepIcon} aria-hidden="true">
                  <WebIcon name={step.desc.icon} size={11} />
                </span>
                <span className={styles.stepLabel}>{label}</span>
                {showRawToolNames && <code className={styles.rawCode}>{step.tool}</code>}
                {!showRawToolNames && step.count > 1 && <span className={styles.countPill}>×{step.count}</span>}
              </li>
            );
          })}
          {commit && (
            <li className={`${styles.stepRow} ${styles.kind_write}`}>
              <span className={styles.stepIcon} aria-hidden="true">
                <WebIcon name="check" size={11} />
              </span>
              <span className={styles.stepLabel}>Saved changes to workspace</span>
              {showRawToolNames && <code className={styles.rawCode}>{commit.slice(0, 7)}</code>}
            </li>
          )}
        </ol>
      )}
    </div>
  );
}
