/** knowledgeFriendly — Human-first presentation, categorization, Vietnamese-safe slugging,
 *  and lossless YAML frontmatter helpers for the Notion-style Knowledge Hub. */
import type { WebIconName } from "./Icons";

export type LibraryCategory =
  | "pages"
  | "meetings"
  | "people"
  | "projects"
  | "tasks"
  | "topics"
  | "files"
  | "system";

export interface CategoryMeta {
  id: LibraryCategory;
  label: string;
  singular: string;
  icon: WebIconName;
  description: string;
}

export const LIBRARY_CATEGORIES: readonly CategoryMeta[] = [
  {
    id: "pages",
    label: "Pages & Notes",
    singular: "Page",
    icon: "fileText",
    description: "Guides, wiki pages, and general notes",
  },
  {
    id: "meetings",
    label: "Meeting Notes",
    singular: "Meeting Note",
    icon: "video",
    description: "Summaries and decisions from meetings",
  },
  {
    id: "projects",
    label: "Projects",
    singular: "Project",
    icon: "layers",
    description: "Initiatives, plans, and deliverables",
  },
  {
    id: "people",
    label: "People",
    singular: "Person",
    icon: "user",
    description: "Teammates, partners, and contacts",
  },
  {
    id: "tasks",
    label: "Tasks",
    singular: "Task",
    icon: "checkSquare",
    description: "Tracked follow-ups and action items",
  },
  {
    id: "topics",
    label: "Topics & Orgs",
    singular: "Topic",
    icon: "hash",
    description: "Organizations, concepts, and topics",
  },
  {
    id: "files",
    label: "Uploaded Files",
    singular: "File",
    icon: "folder",
    description: "PDFs, docs, images, and reference files",
  },
] as const;

export const CATEGORY_BY_ID: Record<LibraryCategory, CategoryMeta> = {
  pages: LIBRARY_CATEGORIES[0],
  meetings: LIBRARY_CATEGORIES[1],
  projects: LIBRARY_CATEGORIES[2],
  people: LIBRARY_CATEGORIES[3],
  tasks: LIBRARY_CATEGORIES[4],
  topics: LIBRARY_CATEGORIES[5],
  files: LIBRARY_CATEGORIES[6],
  system: {
    id: "system",
    label: "System",
    singular: "System",
    icon: "sliders",
    description: "Workspace configuration and AI instructions",
  },
};

const UPPER_ACRONYMS = new Set([
  "AI",
  "API",
  "AWS",
  "CEO",
  "CTO",
  "FAQ",
  "HR",
  "IT",
  "KPI",
  "OKR",
  "PDF",
  "PM",
  "PR",
  "Q1",
  "Q2",
  "Q3",
  "Q4",
  "QA",
  "SOP",
  "TINA",
  "UI",
  "UX",
]);

/** Convert Vietnamese + Unicode titles into clean ASCII file slugs. */
export function slugifyTitle(title: string): string {
  const normalized = title
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "untitled";
}

/** Strip the 16-hex backend upload hash prefix (`a1b2c3d4e5f60708-Report.pdf` -> `Report.pdf`). */
export function stripUploadHash(filename: string): string {
  return filename.replace(/^[0-9a-f]{16}-/i, "");
}

/** Humanize a filename or workspace slug into Title Case. */
export function humanizeSlug(raw: string): string {
  const words = raw
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return "Untitled";
  return words
    .map((word) => {
      const upper = word.toUpperCase();
      if (UPPER_ACRONYMS.has(upper)) return upper;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

/** Classify a workspace path into a friendly non-tech library section. */
export function categorizePath(path: string): LibraryCategory {
  const clean = path.replace(/^\/+/, "");
  if (clean.startsWith("uploads/")) return "files";
  if (clean.startsWith("kg/entities/")) {
    const base = clean.split("/").pop()?.toLowerCase() ?? "";
    if (base === "index.md" || base === "log.md") return "system";
    if (clean.startsWith("kg/entities/meeting/")) return "meetings";
    if (clean.startsWith("kg/entities/person/")) return "people";
    if (clean.startsWith("kg/entities/project/")) return "projects";
    if (clean.startsWith("kg/entities/task/")) return "tasks";
    return "topics";
  }
  if (clean.startsWith("wiki/meetings/")) return "meetings";
  if (
    clean === "CLAUDE.md" ||
    clean === "kg/index.md" ||
    clean === "kg/log.md" ||
    clean.startsWith("agents/") ||
    clean.startsWith("views/") ||
    clean.startsWith("routines/") ||
    clean.startsWith("policy/") ||
    clean.startsWith("skills/") ||
    clean.startsWith(".")
  ) {
    return "system";
  }
  if (
    clean === "README.md" ||
    clean.startsWith("wiki/") ||
    clean.startsWith("notes/") ||
    clean.startsWith("docs/") ||
    clean.startsWith("mail/") ||
    clean.startsWith("sources/") ||
    clean.startsWith("concepts/") ||
    clean.toLowerCase().endsWith(".md")
  ) {
    return "pages";
  }
  return "files";
}

export function isUploadedOrNonMarkdown(path: string): boolean {
  return path.startsWith("uploads/") || !path.toLowerCase().endsWith(".md");
}

export function fileExtensionBadge(path: string): string {
  const base = stripUploadHash(path.split("/").pop() ?? path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "FILE";
  return base.slice(dot + 1).toUpperCase().slice(0, 6);
}

/** Produce a clean, human-readable title for any workspace path (optionally using content). */
export function friendlyPageTitle(path: string, content?: string | null): string {
  if (content) {
    const parsed = parseDocumentClean(content, path);
    if (parsed.explicitTitle) return parsed.explicitTitle;
  }
  const clean = path.replace(/^\/+/, "");
  if (clean === "README.md") return "Space Home";
  if (clean === "CLAUDE.md") return "AI Instructions";
  const base = clean.split("/").pop() ?? clean;
  if (clean.startsWith("uploads/") || !clean.toLowerCase().endsWith(".md")) {
    return stripUploadHash(base);
  }
  return humanizeSlug(base.replace(/\.md$/i, ""));
}

/** Friendly display name for a workspace in non-tech UI. */
export function friendlyWorkspaceLabel(
  name: string,
  kind: "personal" | "extra" | "shared" | "global",
): string {
  if (kind === "global") return "Templates & Guides";
  if (kind === "personal") {
    const lower = name.trim().toLowerCase();
    if (!lower || lower === "personal" || lower === "seed") return "My Space";
    return name;
  }
  if (kind === "shared" && /^[a-z0-9_-]+$/.test(name)) {
    return humanizeSlug(name);
  }
  return name || "Untitled Space";
}

/** Friendly permission label for non-tech users. */
export function friendlyRoleLabel(role?: string, kind?: "personal" | "extra" | "shared" | "global"): string {
  if (kind === "global") return "View only";
  const r = (role ?? "").toLowerCase();
  if (r === "owner") return "Owner";
  if (r === "contributor") return "Can edit";
  if (r === "viewer" || r === "read-only") return "View only";
  if (kind === "shared") return "Member";
  return "Private";
}

/** Friendly entity type label for Connections Map & badges. */
export function friendlyEntityType(type: string): string {
  const lower = type.trim().toLowerCase();
  const map: Record<string, string> = {
    person: "Person",
    meeting: "Meeting",
    project: "Project",
    task: "Task",
    topic: "Topic",
    company: "Organization",
    organization: "Organization",
    page: "Page",
    tag: "Tag",
  };
  return map[lower] ?? humanizeSlug(type);
}

/** Friendly plural lane label for Connections Map columns. */
export function friendlyEntityLaneLabel(type: string): string {
  const lower = type.trim().toLowerCase();
  const map: Record<string, string> = {
    person: "People",
    meeting: "Meetings",
    project: "Projects",
    task: "Tasks",
    topic: "Topics",
    company: "Organizations",
    organization: "Organizations",
    page: "Pages",
    tag: "Tags",
  };
  return map[lower] ?? humanizeSlug(type);
}

// ── Lossless Frontmatter & Clean Document Parsing ────────────────────────────

const FRONTMATTER_RE = /^---(\r?\n)([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/;
const LEADING_H1_RE = /^(\s*)#[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/;

function unquoteYaml(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

export function formatYamlScalar(value: string): string {
  const clean = value.replace(/\r?\n/g, " ").trim();
  if (!clean) return '""';
  const needsQuotes =
    /[:#[\]{}&*!|>'"%@`?]/.test(clean) ||
    clean.startsWith("-") ||
    clean.startsWith(" ") ||
    clean.endsWith(" ") ||
    /^(true|false|null|yes|no|on|off)$/i.test(clean);
  return needsQuotes ? JSON.stringify(clean) : clean;
}

export interface ParsedDocument {
  hasFrontmatter: boolean;
  rawFrontmatter: string;
  fields: Array<[string, string]>;
  fieldMap: Record<string, string>;
  body: string;
  /** Non-null when an explicit YAML title or leading `# H1` exists in the content. */
  explicitTitle: string | null;
  /** Always-present display title (falls back to humanized filename). */
  displayTitle: string;
  /** True when the body's very first heading is an `# H1` duplicating `displayTitle`. */
  hasLeadingH1: boolean;
  /** Body with the leading `# H1` stripped so Title input / Page Header never duplicate it. */
  bodyWithoutLeadingH1: string;
}

export function parseDocumentClean(raw: string, path: string): ParsedDocument {
  const fmMatch = raw.match(FRONTMATTER_RE);
  const hasFrontmatter = Boolean(fmMatch);
  const rawFrontmatter = fmMatch ? fmMatch[2] : "";
  const body = fmMatch ? fmMatch[3] : raw;

  const fields: Array<[string, string]> = [];
  const fieldMap: Record<string, string> = {};
  if (hasFrontmatter) {
    for (const line of rawFrontmatter.split(/\r?\n/)) {
      // Only top-level scalar `key: value` lines (skip indented YAML lists/objects)
      if (/^\s/.test(line) || line.trim().startsWith("#")) continue;
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const val = unquoteYaml(line.slice(idx + 1));
        if (key && val) {
          fields.push([key, val]);
          fieldMap[key.toLowerCase()] = val;
        }
      }
    }
  }

  const h1Match = body.match(LEADING_H1_RE);
  const h1Text = h1Match ? h1Match[2].replace(/[*_`[\]]/g, "").trim() : null;
  const fmTitle = fieldMap.title?.trim() || null;
  const explicitTitle = fmTitle || h1Text || null;

  const fallbackTitle = (() => {
    const clean = path.replace(/^\/+/, "");
    if (clean === "README.md") return "Space Home";
    if (clean === "CLAUDE.md") return "AI Instructions";
    const base = clean.split("/").pop() ?? clean;
    if (clean.startsWith("uploads/") || !clean.toLowerCase().endsWith(".md")) {
      return stripUploadHash(base);
    }
    return humanizeSlug(base.replace(/\.md$/i, ""));
  })();

  const displayTitle = explicitTitle || fallbackTitle;
  const shouldStripH1 = Boolean(
    h1Match &&
      (!fmTitle ||
        h1Text?.toLowerCase() === fmTitle.toLowerCase() ||
        h1Text?.toLowerCase() === fallbackTitle.toLowerCase()),
  );
  const bodyWithoutLeadingH1 = shouldStripH1 && h1Match
    ? body.slice(h1Match[0].length).replace(/^\r?\n/, "")
    : body.replace(/^\r?\n/, "");

  return {
    hasFrontmatter,
    rawFrontmatter,
    fields,
    fieldMap,
    body,
    explicitTitle,
    displayTitle,
    hasLeadingH1: shouldStripH1,
    bodyWithoutLeadingH1,
  };
}

/** Surgically update or insert a single scalar YAML field while keeping all other lines byte-intact. */
export function patchFrontmatterField(raw: string, key: string, value: string): string {
  const fmMatch = raw.match(FRONTMATTER_RE);
  if (!fmMatch) return raw;
  const eol = fmMatch[1];
  const lines = fmMatch[2].split(/\r?\n/);
  const body = fmMatch[3];
  const keyLower = key.toLowerCase();
  const trimmedVal = value.trim();

  let found = false;
  const nextLines: string[] = [];
  for (const line of lines) {
    if (!/^\s/.test(line) && !line.trim().startsWith("#")) {
      const idx = line.indexOf(":");
      if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === keyLower) {
        found = true;
        if (trimmedVal) {
          nextLines.push(`${line.slice(0, idx).trim()}: ${formatYamlScalar(trimmedVal)}`);
        }
        continue;
      }
    }
    nextLines.push(line);
  }
  if (!found && trimmedVal) {
    nextLines.push(`${key}: ${formatYamlScalar(trimmedVal)}`);
  }
  return `---${eol}${nextLines.join(eol)}${eol}---${eol}${body}`;
}

/** Update the page title cleanly — patches YAML `title:` (preserving all entity fields) and/or leading `# H1`. */
export function updateCleanDocumentTitle(raw: string, path: string, nextTitle: string): string {
  const parsed = parseDocumentClean(raw, path);
  const cleanTitle = nextTitle.replace(/\r?\n/g, " ");
  let updated = raw;

  if (parsed.hasFrontmatter) {
    updated = patchFrontmatterField(updated, "title", cleanTitle || parsed.displayTitle);
    const today = new Date().toISOString().slice(0, 10);
    if (parsed.fieldMap.updated !== undefined) {
      updated = patchFrontmatterField(updated, "updated", today);
    }
    if (parsed.hasLeadingH1) {
      const fmMatch = updated.match(FRONTMATTER_RE);
      if (fmMatch) {
        const eol = fmMatch[1];
        const bodyRest = fmMatch[3].replace(LEADING_H1_RE, "");
        const trimmedRest = bodyRest.replace(/^\r?\n/, "");
        const h1 = cleanTitle.trim() ? `# ${cleanTitle.trim()}${eol}${eol}` : "";
        return `---${eol}${fmMatch[2]}${eol}---${eol}${eol}${h1}${trimmedRest}`;
      }
    }
    return updated;
  }

  // Plain Markdown without frontmatter
  if (parsed.hasLeadingH1) {
    const rest = raw.replace(LEADING_H1_RE, "").replace(/^\r?\n/, "");
    return cleanTitle.trim() ? `# ${cleanTitle.trim()}\n\n${rest}` : rest;
  }
  const rest = raw.replace(/^\r?\n/, "");
  return cleanTitle.trim() ? `# ${cleanTitle.trim()}\n\n${rest}` : rest;
}

/** Update the body cleanly without ever exposing or corrupting YAML frontmatter or the leading `# H1`. */
export function updateCleanDocumentBody(raw: string, path: string, nextBody: string): string {
  const parsed = parseDocumentClean(raw, path);
  if (parsed.hasFrontmatter) {
    const fmMatch = raw.match(FRONTMATTER_RE);
    if (!fmMatch) return nextBody;
    const eol = fmMatch[1];
    const h1Prefix = parsed.hasLeadingH1 && parsed.explicitTitle
      ? `# ${parsed.explicitTitle}${eol}${eol}`
      : "";
    return `---${eol}${fmMatch[2]}${eol}---${eol}${eol}${h1Prefix}${nextBody}`;
  }
  if (parsed.hasLeadingH1 && parsed.explicitTitle) {
    return `# ${parsed.explicitTitle}\n\n${nextBody}`;
  }
  return nextBody;
}

export type NewPageKind = "wiki" | "notes" | "project" | "person" | "task";

export function buildNewPageTemplate(kind: NewPageKind, title: string): { path: string; content: string } {
  const cleanTitle = title.trim() || "Untitled";
  const slug = slugifyTitle(cleanTitle);
  const today = new Date().toISOString().slice(0, 10);

  if (kind === "person") {
    return {
      path: `kg/entities/person/${slug}.md`,
      content: `---\nid: person/${slug}\ntype: person\ntitle: ${formatYamlScalar(cleanTitle)}\nupdated: ${today}\n---\n\n# ${cleanTitle}\n\n## Role & Team\n\n## Notes & Context\n`,
    };
  }
  if (kind === "project") {
    return {
      path: `kg/entities/project/${slug}.md`,
      content: `---\nid: project/${slug}\ntype: project\ntitle: ${formatYamlScalar(cleanTitle)}\nstatus: active\nupdated: ${today}\n---\n\n# ${cleanTitle}\n\n## Goals\n\n## Key Decisions\n\n## Next Steps\n- [ ] \n`,
    };
  }
  if (kind === "task") {
    return {
      path: `kg/entities/task/${slug}.md`,
      content: `---\nid: task/${slug}\ntype: task\ntitle: ${formatYamlScalar(cleanTitle)}\nstatus: open\nupdated: ${today}\n---\n\n# ${cleanTitle}\n\n## Details\n\n## Checklist\n- [ ] \n`,
    };
  }
  if (kind === "notes") {
    return {
      path: `notes/${slug}.md`,
      content: `# ${cleanTitle}\n\n`,
    };
  }
  return {
    path: `wiki/${slug}.md`,
    content: `# ${cleanTitle}\n\n`,
  };
}

/** Build a friendly destination path when a non-tech user renames or moves a page by Section + Name. */
export function buildFriendlyMovePath(
  section: "wiki" | "notes" | "project" | "person" | "task",
  name: string,
): string {
  const slug = slugifyTitle(name);
  if (section === "project") return `kg/entities/project/${slug}.md`;
  if (section === "person") return `kg/entities/person/${slug}.md`;
  if (section === "task") return `kg/entities/task/${slug}.md`;
  if (section === "notes") return `notes/${slug}.md`;
  return `wiki/${slug}.md`;
}

export function sectionFromPath(path: string): "wiki" | "notes" | "project" | "person" | "task" {
  if (path.startsWith("kg/entities/project/")) return "project";
  if (path.startsWith("kg/entities/person/")) return "person";
  if (path.startsWith("kg/entities/task/")) return "task";
  if (path.startsWith("notes/")) return "notes";
  return "wiki";
}

/** Friendly human metadata chips to show under a page title (hiding internal `id`, `type`, `meeting_id`). */
export function visibleHumanMetadata(fieldMap: Record<string, string>): Array<{ label: string; value: string }> {
  const result: Array<{ label: string; value: string }> = [];
  if (fieldMap.status) result.push({ label: "Status", value: humanizeSlug(fieldMap.status) });
  if (fieldMap.role) result.push({ label: "Role", value: fieldMap.role });
  if (fieldMap.owner) result.push({ label: "Owner", value: fieldMap.owner });
  if (fieldMap.date) result.push({ label: "Date", value: fieldMap.date });
  if (fieldMap.updated) result.push({ label: "Updated", value: fieldMap.updated });
  return result;
}
