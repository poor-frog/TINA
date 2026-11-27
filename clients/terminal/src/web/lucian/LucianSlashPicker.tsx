"use client";
import { useEffect, useRef } from "react";
/** LucianSlashPicker — Keyboard-navigable `/` slash command popover & prompt compiler
 *  shared across AskTinaView, KnowledgeCopilotDrawer, and MeetingSidePanel. */
import "./lucian-451.css";
import { routineCreationPrompt } from "../../surfaces/chat";
import { normalizeSearchText } from "./LucianMentionPicker";

export type SlashCommandId =
  | "research"
  | "routine"
  | "recap"
  | "prep"
  | "tasks"
  | "draft"
  | "schedule"
  | "save"
  | "new";

export interface SlashCommandDef {
  id: SlashCommandId;
  command: `/${SlashCommandId}`;
  label: string;
  description: string;
  /** Text inserted into the composer when selected (instant commands run immediately). */
  insertTemplate: string;
  /** Client-side instant action (does not wait for extra prompt text). */
  instant?: boolean;
  /** Extra Vietnamese + English search aliases. */
  keywords: string[];
  /** Visual accent tag in popover. */
  badge: string;
}

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    id: "research",
    command: "/research",
    label: "Research & save note",
    description: "Nghiên cứu từ Workspace + Web và lưu trang có nguồn vào Knowledge",
    insertTemplate: "/research ",
    keywords: ["nghien cuu", "tim hieu", "web", "source", "save", "wiki"],
    badge: "AI",
  },
  {
    id: "routine",
    command: "/routine",
    label: "Schedule recurring agent",
    description: "Tạo lịch chạy Tina tự động định kỳ (VD: mỗi sáng 9h)",
    insertTemplate: "/routine Mỗi sáng thứ 2 lúc 9:00, ",
    keywords: ["lich", "dinh ky", "auto", "cron", "schedule", "automation"],
    badge: "Auto",
  },
  {
    id: "recap",
    command: "/recap",
    label: "Meeting recap",
    description: "Tóm tắt điểm chính, quyết định, việc cần làm & câu hỏi mở",
    insertTemplate: "/recap ",
    keywords: ["tom tat", "summary", "bien ban", "minutes", "cuoc hop"],
    badge: "Meeting",
  },
  {
    id: "prep",
    command: "/prep",
    label: "Pre-meeting brief",
    description: "Soạn agenda, bối cảnh liên quan & câu hỏi cần chốt trước họp",
    insertTemplate: "/prep ",
    keywords: ["chuan bi", "brief", "agenda", "truoc hop"],
    badge: "Meeting",
  },
  {
    id: "tasks",
    command: "/tasks",
    label: "Action items & tasks",
    description: "Rà soát hoặc trích xuất đầu việc cần làm từ cuộc họp & Knowledge",
    insertTemplate: "/tasks ",
    keywords: ["viec can lam", "action", "todo", "dau viec", "deadline"],
    badge: "Tasks",
  },
  {
    id: "draft",
    command: "/draft",
    label: "Draft email or doc",
    description: "Soạn email follow-up, báo cáo hoặc trang Knowledge từ ngữ cảnh",
    insertTemplate: "/draft ",
    keywords: ["soan", "email", "viet", "tai lieu", "follow up", "doc"],
    badge: "Write",
  },
  {
    id: "schedule",
    command: "/schedule",
    label: "Toggle today's schedule",
    description: "Bật / tắt ngữ cảnh lịch họp hôm nay & sắp tới cho phiên chat",
    insertTemplate: "/schedule",
    instant: true,
    keywords: ["lich hom nay", "calendar", "today", "sap toi"],
    badge: "Context",
  },
  {
    id: "save",
    command: "/save",
    label: "Save last reply to Knowledge",
    description: "Lưu câu trả lời gần nhất của Tina thành trang Markdown trong Knowledge",
    insertTemplate: "/save",
    instant: true,
    keywords: ["luu", "export", "knowledge", "note", "markdown"],
    badge: "Action",
  },
  {
    id: "new",
    command: "/new",
    label: "New conversation",
    description: "Mở nhanh một cuộc trò chuyện mới",
    insertTemplate: "/new",
    instant: true,
    keywords: ["moi", "clear", "reset", "chat moi"],
    badge: "Action",
  },
] as const;

export interface SlashMatch {
  anchor: number;
  query: string;
}

const SLASH_ROW_H = 44;

/** Detects an active leading `/query` while the caret is inside the command token. */
export function detectSlashAtStart(value: string, cursor: number): SlashMatch | null {
  const before = value.slice(0, Math.max(0, cursor));
  const match = /^(\s*)\/([a-zA-Z0-9_-]{0,20})$/.exec(before);
  if (!match) return null;
  const leading = match[1]?.length ?? 0;
  const query = match[2] ?? "";
  return { anchor: leading, query };
}

export function filterSlashCommands(
  rawQuery: string,
  allowedIds?: readonly SlashCommandId[],
): SlashCommandDef[] {
  const pool = allowedIds
    ? SLASH_COMMANDS.filter((c) => allowedIds.includes(c.id))
    : [...SLASH_COMMANDS];
  const q = normalizeSearchText(rawQuery);
  if (!q) return pool;
  return pool.filter((cmd) => {
    const cmdText = normalizeSearchText(cmd.id);
    const labelText = normalizeSearchText(cmd.label);
    const descText = normalizeSearchText(cmd.description);
    if (cmdText.startsWith(q) || cmdText.includes(q)) return true;
    if (labelText.includes(q) || descText.includes(q)) return true;
    return cmd.keywords.some((kw) => normalizeSearchText(kw).includes(q));
  });
}

export type CompiledSlashPrompt =
  | { kind: "instant"; commandId: "schedule" | "save" | "new" }
  | { kind: "error"; message: string }
  | { kind: "prompt"; wirePrompt: string; displayPrompt: string; research: boolean };

/** Compile a leading slash command into either an instant client action or an enriched agent wire prompt. */
export function compileSlashPrompt(
  rawPrompt: string,
  opts: {
    tz: string;
    meetingTitle?: string | null;
    docPath?: string | null;
  },
): CompiledSlashPrompt {
  const trimmed = rawPrompt.trim();
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) {
    return { kind: "prompt", wirePrompt: trimmed, displayPrompt: trimmed, research: false };
  }

  const cmd = match[1].toLowerCase();
  const rest = (match[2] ?? "").trim();

  if (cmd === "new" || cmd === "clear") {
    return { kind: "instant", commandId: "new" };
  }
  if (cmd === "schedule" && !rest) {
    return { kind: "instant", commandId: "schedule" };
  }
  if (cmd === "save" && !rest) {
    return { kind: "instant", commandId: "save" };
  }

  if (cmd === "research") {
    if (!rest) {
      return {
        kind: "error",
        message: "Nhập chủ đề sau /research, ví dụ: /research So sánh các phương án kiến trúc hiện tại.",
      };
    }
    return { kind: "prompt", wirePrompt: trimmed, displayPrompt: trimmed, research: true };
  }

  if (cmd === "routine") {
    if (!rest) {
      return {
        kind: "error",
        message: "Nhập lịch và yêu cầu sau /routine, ví dụ: /routine Mỗi sáng thứ 2 lúc 9:00, tổng hợp việc tồn đọng.",
      };
    }
    return {
      kind: "prompt",
      wirePrompt: routineCreationPrompt(trimmed, opts.tz),
      displayPrompt: trimmed,
      research: false,
    };
  }

  if (cmd === "recap" || cmd === "summary") {
    const scopeHint = opts.meetingTitle
      ? `cuộc họp "${opts.meetingTitle}"`
      : "cuộc họp gần nhất hoặc cuộc họp được đề cập";
    const extra = rest ? ` Trọng tâm bổ sung: ${rest}` : "";
    return {
      kind: "prompt",
      displayPrompt: trimmed,
      research: false,
      wirePrompt:
        `Hãy tổng kết ${scopeHint} theo cấu trúc rõ ràng gồm: (1) Tổng quan & chủ đề chính, ` +
        `(2) Các quyết định đã chốt, (3) Việc cần làm (Action items kèm người phụ trách & hạn nếu có), ` +
        `và (4) Câu hỏi mở / rủi ro. Chỉ dựa trên dữ liệu có căn cứ, không suy diễn.${extra}`,
    };
  }

  if (cmd === "prep" || cmd === "brief") {
    const scopeHint = opts.meetingTitle
      ? `cuộc họp "${opts.meetingTitle}"`
      : "cuộc họp sắp tới (hoặc chủ đề được nhắc)";
    const extra = rest ? ` Yêu cầu cụ thể: ${rest}` : "";
    return {
      kind: "prompt",
      displayPrompt: trimmed,
      research: false,
      wirePrompt:
        `Hãy soạn Pre-meeting Brief cho ${scopeHint}, gồm: mục tiêu buổi họp, bối cảnh liên quan từ các cuộc họp ` +
        `và tài liệu Knowledge trước đó, đề xuất agenda gọn, và danh sách câu hỏi/quyết định cần chốt.${extra}`,
    };
  }

  if (cmd === "tasks" || cmd === "actions") {
    const extra = rest ? ` Yêu cầu cụ thể: ${rest}` : "";
    return {
      kind: "prompt",
      displayPrompt: trimmed,
      research: false,
      wirePrompt:
        `Hãy rà soát các việc cần làm đang mở trong workspace và/hoặc trích xuất các action items mới từ ngữ cảnh cuộc họp/tài liệu hiện tại ` +
        `(liệt kê rõ người phụ trách, mức ưu tiên, hạn chót nếu có và đề xuất bước tiếp theo).${extra}`,
    };
  }

  if (cmd === "draft") {
    const targetHint = opts.meetingTitle
      ? `dựa trên cuộc họp "${opts.meetingTitle}"`
      : opts.docPath
        ? `dựa trên tài liệu "${opts.docPath}"`
        : "dựa trên ngữ cảnh hiện có";
    const extra = rest
      ? rest
      : "một email follow-up chuyên nghiệp và súc tích tóm tắt quyết định cùng các bước tiếp theo";
    return {
      kind: "prompt",
      displayPrompt: trimmed,
      research: false,
      wirePrompt: `Hãy soạn thảo ${extra} (${targetHint}). Trình bày rõ ràng, sẵn sàng gửi hoặc lưu ngay.`,
    };
  }

  // Unknown `/...` command: pass through untouched so users can still send literal slash text.
  return { kind: "prompt", wirePrompt: trimmed, displayPrompt: trimmed, research: false };
}

export function LucianSlashPopover({
  open,
  listboxId,
  items,
  activeIndex,
  onHoverIndex,
  onPick,
}: {
  open: boolean;
  listboxId: string;
  items: SlashCommandDef[];
  activeIndex: number;
  onHoverIndex: (idx: number) => void;
  onPick: (cmd: SlashCommandDef) => void;
}) {
  const safeIdx = items.length > 0 ? Math.min(Math.max(activeIndex, 0), items.length - 1) : 0;
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || items.length === 0) return;
    const box = popRef.current;
    if (!box) return;
    const rowTop = safeIdx * SLASH_ROW_H + 5;
    const rowBottom = rowTop + SLASH_ROW_H;
    const viewTop = box.scrollTop;
    const viewBottom = viewTop + box.clientHeight;
    if (box.clientHeight > 0) {
      if (rowTop < viewTop) {
        box.scrollTop = Math.max(0, rowTop - 5);
      } else if (rowBottom > viewBottom) {
        box.scrollTop = rowBottom - box.clientHeight + 5;
      }
    }
  }, [open, safeIdx, items.length]);

  return (
    <div
      ref={popRef}
      className={`ux u451-pop u451-slash-pop ${open && items.length > 0 ? "is-open" : ""}`}
      data-testid="lucian-slash-popover"
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="u451-lb" id={listboxId} role="listbox" aria-label="Slash commands">
        {items.length > 0 && (
          <i
            className="u451-pill u451-slash-pill"
            aria-hidden="true"
            style={{ "--u451-py": `${safeIdx * SLASH_ROW_H}px` } as React.CSSProperties}
          />
        )}
        {items.map((item, idx) => {
          const isSelected = idx === safeIdx;
          return (
            <div
              key={item.id}
              id={`${listboxId}-opt-${idx}`}
              role="option"
              aria-selected={isSelected}
              className="u451-o u451-slash-o"
              onPointerMove={() => {
                if (idx !== activeIndex) onHoverIndex(idx);
              }}
              onClick={() => onPick(item)}
            >
              <code className="u451-slash-cmd">{item.command}</code>
              <span className="u451-slash-meta">
                <span className="u451-slash-title">{item.label}</span>
                <span className="u451-slash-desc">{item.description}</span>
              </span>
              <span className="u451-rl">{item.badge}</span>
            </div>
          );
        })}
      </div>
      <p className="u451-live" role="status">
        {open ? `${items.length} commands` : ""}
      </p>
    </div>
  );
}

export function LucianSlashTriggerButton({
  onClick,
  disabled = false,
  expanded = false,
}: {
  onClick: () => void;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      className="ux u451-at"
      aria-label="Slash commands"
      aria-haspopup="listbox"
      aria-expanded={expanded}
      title="Slash commands (/research, /routine, /recap, /prep, /tasks, /draft…)"
      disabled={disabled}
      onPointerDown={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="4" />
        <path d="M14.2 8.2 9.8 15.8" />
      </svg>
    </button>
  );
}
