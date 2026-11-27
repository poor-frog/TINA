"use client";
/** Shared pure helpers for Chat Composers across AskTinaView, KnowledgeCopilotDrawer,
 *  and MeetingSidePanel: unified `@` mention catalog, workspace file upload, and `/save` export. */
import type { MeetingMock } from "../surfaces/meetingModel";
import { saveWorkspaceDocument } from "../surfaces/workspaceApi";
import type { MentionTarget } from "./lucian/LucianMentionPicker";

export const COMPOSER_ATTACHMENT_ACCEPT = [
  "image/*",
  ".pdf",
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".log",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
].join(",");

export const MAX_COMPOSER_FILES = 6;
export const MAX_COMPOSER_FILE_BYTES = 25 * 1024 * 1024;

export interface PendingAttachment {
  id: string;
  file: File;
  isImage: boolean;
  previewUrl?: string;
}

export interface UploadedWorkspaceFile {
  name: string;
  path: string;
}

const MENTIONABLE_FILE_RE = /\.(md|markdown|txt|pdf|docx?|xlsx?|pptx?|csv|tsv|json|ya?ml|png|jpe?g|webp|gif)$/i;

export function friendlyMentionFileLabel(path: string): string {
  const base = path.split("/").pop() || path;
  if (/\.md$/i.test(base)) {
    return base
      .replace(/\.md$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }
  return base.trim();
}

export function buildMentionCatalog(opts: {
  meetings?: MeetingMock[];
  spaces?: Array<{ slug: string; name?: string | null }>;
  workspaceDocs?: string[];
  extraPeople?: Array<{ name?: string | null; email?: string | null }>;
  includeScheduleOption?: boolean;
  includeTasksShortcut?: boolean;
}): MentionTarget[] {
  const out: MentionTarget[] = [];
  const seen = new Set<string>();

  for (const m of opts.meetings ?? []) {
    const label = (m.title_custom || m.title || "").trim();
    if (!label) continue;
    const key = `meeting:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const participantNames = [
      ...(m.participants ?? []).map((p) => p?.name || ""),
      ...(m.attendees ?? []).map((a) => `${a.name || ""} ${a.email || ""}`),
    ]
      .filter(Boolean)
      .join(" ");
    out.push({
      id: key,
      kind: "meeting",
      label,
      role: "Meeting",
      gradientA: "#7CCBFF",
      gradientB: "#3B6CF0",
      meetingId: m.id,
      searchText: `${m.platform || ""} ${participantNames}`.trim(),
    });
  }

  for (const space of opts.spaces ?? []) {
    const label = (space.name || space.slug || "").trim();
    if (!label) continue;
    const key = `space:${space.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: key,
      kind: "space",
      label,
      role: "Space",
      gradientA: "#D2C2FF",
      gradientB: "#7458F0",
      spaceSlug: space.slug,
      searchText: space.slug,
    });
  }

  if (opts.includeScheduleOption !== false) {
    out.push({
      id: "schedule:today",
      kind: "schedule",
      label: "Today",
      role: "Schedule",
      gradientA: "#F9C77B",
      gradientB: "#D97706",
      searchText: "schedule today lich hom nay calendar sap toi meetings",
    });
    seen.add("schedule:today");
  }

  if (opts.includeTasksShortcut !== false) {
    out.push({
      id: "task:all",
      kind: "task",
      label: "Open Tasks",
      role: "Tasks",
      gradientA: "#FCA5A5",
      gradientB: "#E11D48",
      searchText: "tasks all open viec can lam action items todo",
    });
    seen.add("task:all");
  }

  // Individual workspace files: classify task entities, person entities, markdown pages, and uploaded docs.
  for (const file of opts.workspaceDocs ?? []) {
    if (!MENTIONABLE_FILE_RE.test(file)) continue;
    if (file.startsWith(".git/") || file.startsWith("_system/")) continue;
    const label = friendlyMentionFileLabel(file);
    if (!label) continue;

    if (file.startsWith("kg/entities/task/")) {
      const key = `task:${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: key,
        kind: "task",
        label,
        role: "Task",
        gradientA: "#FDA4AF",
        gradientB: "#E11D48",
        docPath: file,
        searchText: `task viec ${file}`,
      });
      continue;
    }

    if (file.startsWith("kg/entities/person/")) {
      const key = `person:${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: key,
        kind: "person",
        label,
        role: "Person",
        gradientA: "#FCD34D",
        gradientB: "#D97706",
        docPath: file,
        searchText: `person member ${file}`,
      });
      continue;
    }

    const isMd = /\.md$/i.test(file);
    const key = `${isMd ? "page" : "file"}:${file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: key,
      kind: isMd ? "page" : "file",
      label,
      role: isMd ? "Page" : "File",
      gradientA: isMd ? "#8EE3BE" : "#93C5FD",
      gradientB: isMd ? "#139A72" : "#2563EB",
      docPath: file,
      searchText: file,
    });
  }

  // Deduplicated meeting participants / extra workspace people
  const personSeen = new Set<string>();
  const addPerson = (rawName?: string | null, rawEmail?: string | null) => {
    const email = (rawEmail || "").trim().toLowerCase();
    const name = (rawName || "").trim();
    const label = name || (email ? email.split("@")[0] : "");
    if (!label) return;
    const dedupeKey = (email || label).toLowerCase();
    if (personSeen.has(dedupeKey)) return;
    personSeen.add(dedupeKey);
    const id = `person:p:${dedupeKey}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({
      id,
      kind: "person",
      label,
      role: "Person",
      gradientA: "#FDBA74",
      gradientB: "#EA580C",
      personEmail: email || undefined,
      searchText: `${name} ${email}`,
    });
  };

  for (const p of opts.extraPeople ?? []) {
    addPerson(p.name, p.email);
  }
  for (const m of opts.meetings ?? []) {
    for (const attendee of m.attendees ?? []) {
      addPerson(attendee.name, attendee.email);
    }
    for (const participant of m.participants ?? []) {
      const clean = (participant?.name || "").trim();
      if (!clean) continue;
      if (clean.includes("@")) addPerson(undefined, clean);
      else addPerson(clean, undefined);
    }
  }

  return out;
}

export function formatAttachmentsPrompt(files: UploadedWorkspaceFile[]): string {
  if (files.length === 0) return "";
  return ["Attached files:", ...files.map((f) => `- @file:${f.path}`)].join("\n");
}

/** Parse leading `[Context: ...]` headers and trailing `Referenced context:` / `Attached files:`
 *  blocks (appended on the wire for backend grounding and reloaded via session history) into
 *  compact UI badges + clean user body text. */
export function parsePromptContextBlocks(raw: string): { badges: string[]; body: string } {
  const badges: string[] = [];
  let text = raw.trim();

  // 1. Leading `[Context: ...]` header from Knowledge/Meeting deep links
  const headerMatch = text.match(/^\s*\[Context:\s*([^\r\n]+)\]\s*(?:\r?\n)+([\s\S]*)$/);
  if (headerMatch) {
    const meta = headerMatch[1].trim();
    const rest = headerMatch[2].trim();
    if (rest) {
      const spaceMatch = meta.match(/Space\s+"([^"]+)"/i);
      if (spaceMatch) badges.push(`Space · ${spaceMatch[1]}`);
      const pageMatch = meta.match(/open page\s+"([^"]+)"/i);
      if (pageMatch) {
        badges.push(pageMatch[1].split("/").pop() || pageMatch[1]);
      }
      if (badges.length === 0) {
        badges.push(meta.replace(/\s*\(slug:[^)]*\)/gi, "").trim());
      }
      text = rest;
    }
  }

  // 2. Trailing `Attached files:\n- @file:...` and/or `Referenced context:\n- ...` blocks
  const parseTrailingBlock = (heading: "Attached files:" | "Referenced context:") => {
    const re = new RegExp(`(?:^|\\r?\\n\\r?\\n)${heading}\\r?\\n((?:- [^\\r\\n]+(?:\\r?\\n|$))+)$`);
    const m = text.match(re);
    if (!m) return false;
    const lines = m[1]
      .split(/\r?\n/)
      .map((l) => l.replace(/^- /, "").trim())
      .filter(Boolean);
    for (const line of lines) {
      if (heading === "Attached files:") {
        const path = line.replace(/^@file:/, "").trim();
        const name = (path.split("/").pop() || path).replace(/^[0-9a-f]{16}-/i, "");
        badges.push(`File · ${name}`);
      } else if (line.startsWith("@file:")) {
        const paren = line.match(/\(([^)]+)\)\s*$/);
        const path = line.replace(/^@file:/, "").replace(/\s*\([^)]+\)\s*$/, "").trim();
        badges.push(paren?.[1] || friendlyMentionFileLabel(path));
      } else if (/^Meeting:/i.test(line)) {
        const mt = line.match(/^Meeting:\s*"([^"]+)"/i);
        badges.push(`Meeting · ${mt?.[1] || line.replace(/^Meeting:\s*/i, "")}`);
      } else if (/^Space:/i.test(line)) {
        const sp = line.match(/^Space:\s*"([^"]+)"/i);
        badges.push(`Space · ${sp?.[1] || line.replace(/^Space:\s*/i, "")}`);
      } else if (/^Schedule:/i.test(line)) {
        badges.push("Schedule · Today");
      } else if (/^Tasks:/i.test(line)) {
        badges.push("Open Tasks");
      } else if (/^Person:/i.test(line)) {
        const name = line.replace(/^Person:\s*/i, "").replace(/\s*\([^)]+\)\s*$/, "").trim();
        badges.push(name);
      }
    }
    const stripped = text.slice(0, m.index ?? text.length).trim();
    text = stripped || (heading === "Attached files:" ? "Attached files" : text);
    return true;
  };

  // Strip in either order (Attached files typically follows Referenced context)
  for (let i = 0; i < 2; i++) {
    const a = parseTrailingBlock("Attached files:");
    const b = parseTrailingBlock("Referenced context:");
    if (!a && !b) break;
  }

  // Deduplicate badges while preserving order
  const uniqueBadges = Array.from(new Set(badges));
  return { badges: uniqueBadges, body: text || raw };
}

export async function uploadComposerFiles(files: File[]): Promise<UploadedWorkspaceFile[]> {
  if (files.length === 0) return [];
  const form = new FormData();
  for (const file of files) {
    form.append("files", file, file.name || "upload");
  }
  const res = await fetch("/api/workspace/upload", { method: "POST", body: form });
  if (!res.ok) {
    let detail = `Upload failed (${res.status})`;
    try {
      const data = (await res.json()) as { detail?: string; error?: string };
      if (data.detail) detail = data.detail;
      else if (data.error) detail = data.error;
    } catch {
      /* keep HTTP status message */
    }
    throw new Error(detail);
  }
  const data = (await res.json()) as { files?: UploadedWorkspaceFile[] };
  return Array.isArray(data.files) ? data.files : [];
}

function slugifyTitle(value: string): string {
  const ascii = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return ascii || "note";
}

export async function saveReplyToKnowledge(opts: {
  replyText: string;
  titleHint?: string;
  slug?: string;
}): Promise<{ path: string }> {
  const cleanReply = opts.replyText.trim();
  if (!cleanReply) {
    throw new Error("Không có nội dung phản hồi nào của Tina để lưu.");
  }
  const firstHeading = cleanReply
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim())
    .find((line) => line.length >= 4);
  const title = (opts.titleHint?.trim() || firstHeading || "Tina Note").slice(0, 96);
  const now = new Date();
  const datePart = now.toISOString().slice(0, 10);
  const suffix = Math.random().toString(36).slice(2, 6);
  const filePath = `notes/${datePart}-${slugifyTitle(title)}-${suffix}.md`;
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    "type: note",
    `created_at: ${now.toISOString()}`,
    "source: ask-tina",
    "---",
    "",
  ].join("\n");
  await saveWorkspaceDocument({
    path: filePath,
    content: `${frontmatter}${cleanReply}\n`,
    expected_sha256: null,
    slug: opts.slug,
    commit: true,
    commit_message: `Save Ask Tina reply: ${title}`,
  });
  return { path: filePath };
}
