/** Markdown — a compact, self-contained markdown renderer (no npm dependency).
 *  Parses a markdown string into React nodes, styled with the terminal's dark tokens
 *  (--t1/--t2/--t3, --accent, --blue, --mono, --line, --panel, --panel2). Supports:
 *  headings (#..####), bold, italic, inline code, fenced ```code```, bullet + numbered
 *  lists, links (new tab, rel noreferrer), [[wikilinks]], blockquotes, horizontal rules,
 *  GFM pipe tables, paragraphs and line breaks. Intentionally a small subset — robust,
 *  not spec-complete. */
"use client";
import { Fragment, useState, type ReactNode } from "react";
import { Card, CardGroup, InternalLink, Wikilink, isInternalHref, useOpenEntity } from "./docLinks";

// A workspace-doc path in inline code → clickable to open the doc. Matches Knowledge docs by any
// spelling the agent uses (relative `kg/entities/x.md`, `notes/...md`, `wiki/...md`, or verbatim
// absolute mount path `<root>/<subject>/kg/...`) plus any doc inside an attached-workspace mount
// (`<root>/.attached/<subject>/<slug>/...md`) — resolveDocRef translates all of them.
const ENTITY_PATH = /^(?:(?:[\w./-]*\/)?(?:kg|wiki|notes|sources|concepts|docs|mail)\/(?!.*\.\.)[^\n`]+\.md|\/[\w./-]*\.attached\/(?!.*\.\.)[^\n`]+\.md)$/;
// Clickable `kg/entities/...` inline code — a component so it can read the doc's
// workspace context (DocMeta/DocNav) via useOpenEntity, same as every other link.
function EntityCode({ code }: { code: string }) {
  const openEntity = useOpenEntity();
  return (
    <code onClick={() => openEntity({ path: code })}
      style={{
        fontFamily: "var(--mono)",
        fontSize: "0.86em",
        background: "var(--panel2)",
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: "1px 6px",
        color: "var(--blue)",
        cursor: "pointer",
        textDecoration: "none",
      }}>
      {code}
    </code>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const label = lang.trim().split(/\s+/)[0] || "code";

  const copy = () => {
    const cb = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!cb?.writeText) return;
    void cb.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    }).catch(() => undefined);
  };

  return (
    <div style={{
      margin: "10px 0 14px",
      borderRadius: 10,
      border: "1px solid var(--line)",
      background: "var(--panel)",
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "5px 10px 5px 12px",
        background: "var(--panel2)",
        borderBottom: "1px solid var(--line)",
        fontSize: 11,
        color: "var(--t3)",
      }}>
        <span style={{ fontFamily: "var(--mono)", textTransform: "lowercase", letterSpacing: "0.02em" }}>
          {label}
        </span>
        <button
          type="button"
          aria-label={copied ? "Copied code" : "Copy code"}
          onClick={copy}
          style={{
            background: "transparent",
            border: "none",
            padding: "2px 6px",
            borderRadius: 5,
            fontSize: 11,
            fontWeight: 500,
            color: copied ? "var(--accent)" : "var(--t3)",
            cursor: "pointer",
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: "11px 13px",
        overflowX: "auto",
        fontFamily: "var(--mono)",
        fontSize: 12.5,
        lineHeight: 1.58,
        color: "var(--t1)",
      }}>
        <code>{code}</code>
      </pre>
    </div>
  );
}

// ── inline span parsing: code, bold, italic, links, wikilinks ──────────────────────
// Order matters — `code` is tokenized first so emphasis markers inside it are left literal.
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  // split on inline code first; odd indices are code content
  const codeParts = text.split(/((?<!\\)`(?:\\.|[^`])+?(?<!\\)`)/g);
  codeParts.forEach((seg, ci) => {
    if (seg.startsWith("`") && seg.endsWith("`") && seg.length >= 2) {
      const code = seg.slice(1, -1);
      out.push(ENTITY_PATH.test(code)
        ? <EntityCode key={`c${ci}`} code={code} />
        : <code key={`c${ci}`}
            style={{ fontFamily: "var(--mono)", fontSize: "0.88em", background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: 4, padding: "0.5px 5px", color: "var(--t1)" }}>
            {code}
          </code>,
      );
    } else {
      emphasis(seg, `${ci}`, out);
    }
  });
  return out;
}

// bold / italic / links / wikilinks within a non-code segment
function emphasis(text: string, key: string, out: ReactNode[]): void {
  const re = /(\[\[[^\]]+\]\])|(\[(?:\\.|[^\]\\])*\]\((?:\\.|[^)\\])+\))|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={`${key}-t${i}`}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (m[1]) {
      // [[wikilink]] — the same typed entity chip MdxDoc renders (shared resolver; a
      // title with no entity doc renders muted + tooltip instead of a dead click)
      out.push(<Wikilink key={`${key}-w${i}`} title={tok.slice(2, -2)} />);
    } else if (m[2]) {
      // [text](url) — workspace-internal (schemeless) hrefs navigate in place, resolving
      // relative paths against the linking doc; external links open a browser tab
      const lm = tok.match(/^\[((?:\\.|[^\]\\])*)\]\(([^)]+)\)$/)!;
      const title = lm[1].replace(/\\([\\`*{}\[\]()<>_!])/g, '$1') || lm[2];
      out.push(isInternalHref(lm[2])
        ? <InternalLink key={`${key}-l${i}`} href={lm[2]}>{title}</InternalLink>
        : <a key={`${key}-l${i}`} href={/^https?:/i.test(lm[2]) || lm[2].startsWith("#") ? lm[2] : undefined} target="_blank" rel="noreferrer noopener" style={{ color: "var(--blue)", textDecoration: "underline" }}>
            {title}
          </a>,
      );
    } else if (m[3]) {
      // **bold** / __bold__ — recurse so **[[wikilink]]** renders the chip, not literal brackets
      const inner: ReactNode[] = [];
      emphasis(tok.slice(2, -2), `${key}-b${i}`, inner);
      out.push(<strong key={`${key}-b${i}`} style={{ fontWeight: 600, color: "var(--t1)" }}>{inner}</strong>);
    } else if (m[4]) {
      // *italic* / _italic_ — recurse for the same reason
      const innerI: ReactNode[] = [];
      emphasis(tok.slice(1, -1), `${key}-i${i}`, innerI);
      out.push(<em key={`${key}-i${i}`} style={{ fontStyle: "italic" }}>{innerI}</em>);
    }
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) out.push(<Fragment key={`${key}-t${i}`}>{text.slice(last)}</Fragment>);
}

// ── <Card>/<CardGroup> fallback parity ─────────────────────────────────────────────
// This renderer is where docs land when their MDX compile FAILS, and agent-written docs
// use the Mintlify card vocabulary heavily — without this, every failed doc prints
// `<CardGroup cols={2}>` as literal text. Parse just those two tags (string/number
// attributes only, matching MdxDoc's no-expressions rule) and render the SAME Card /
// CardGroup components from ./docLinks.
export interface ParsedCard { title?: string; icon?: string; href?: string; body: string }
export interface ParsedCardBlock { cols: number; grouped: boolean; cards: ParsedCard[] }
const CARD_BLOCK_START = /^\s*<Card(Group)?\b/;
function parseCardAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of attrs.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(\d+)\s*\})/g))
    out[m[1]] = m[2] ?? m[3] ?? m[4];
  return out;
}
/** Parse one card block's source (a <CardGroup>…</CardGroup> or bare <Card>s). Exported for tests. */
export function parseCardBlock(src: string): ParsedCardBlock {
  const group = src.match(/<CardGroup\b([^>]*)>/);
  const cols = group ? Number(parseCardAttrs(group[1]).cols) || 2 : 2;
  const cards: ParsedCard[] = [];
  for (const m of src.matchAll(/<Card\b([^>]*?)(\/>|>([\s\S]*?)<\/Card>)/g)) {
    const a = parseCardAttrs(m[1]);
    cards.push({ title: a.title, icon: a.icon, href: a.href, body: (m[3] ?? "").trim() });
  }
  return { cols, grouped: Boolean(group), cards };
}

const HEADING_SIZE: Record<number, number> = { 1: 18, 2: 16, 3: 14.5, 4: 13.5 };
type TableAlign = "left" | "center" | "right";

function splitTableRow(line: string): string[] | null {
  let body = line.trim();
  if (!body.includes("|")) return null;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);

  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());

  return cells.length >= 2 ? cells : null;
}

function parseTableSeparator(line: string): TableAlign[] | null {
  const cells = splitTableRow(line);
  if (!cells) return null;

  const aligns: TableAlign[] = [];
  for (const cell of cells) {
    const marker = cell.replace(/\s+/g, "");
    if (!/^:?-{3,}:?$/.test(marker)) return null;
    const left = marker.startsWith(":");
    const right = marker.endsWith(":");
    aligns.push(left && right ? "center" : right ? "right" : "left");
  }
  return aligns;
}

function tableStart(lines: string[], index: number): { header: string[]; align: TableAlign[] } | null {
  if (index + 1 >= lines.length) return null;
  const header = splitTableRow(lines[index]);
  const align = parseTableSeparator(lines[index + 1]);
  if (!header || !align) return null;

  const columns = Math.max(header.length, align.length);
  return {
    header: Array.from({ length: columns }, (_, col) => header[col] ?? ""),
    align: Array.from({ length: columns }, (_, col) => align[col] ?? "left"),
  };
}

// ── block parser: split lines into headings, lists, code fences, quotes, rules, paras ──
export function Markdown({ children, style }: { children: string; style?: React.CSSProperties }): ReactNode {
  const src = children ?? "";
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const flushList = (items: string[], ordered: boolean) => {
    const Tag = ordered ? "ol" : "ul";
    blocks.push(
      <Tag key={key++} style={{ margin: "6px 0 11px", paddingLeft: 21, display: "flex", flexDirection: "column", gap: 4 }}>
        {items.map((it, j) => <li key={j} style={{ lineHeight: 1.66 }}>{inline(it)}</li>)}
      </Tag>,
    );
  };

  while (i < lines.length) {
    const line = lines[i];

    // fenced code block ```
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1] ?? "";
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; // closing fence
      blocks.push(<CodeBlock key={key++} lang={lang} code={buf.join("\n")} />);
      continue;
    }

    // blank line
    if (/^\s*$/.test(line)) { i++; continue; }

    // horizontal rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key++} style={{ border: "none", borderTop: "1px solid var(--line)", margin: "16px 0" }} />);
      i++; continue;
    }

    // heading
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      blocks.push(
        <div key={key++} style={{ fontSize: HEADING_SIZE[lvl], fontWeight: 600, color: "var(--t1)", lineHeight: 1.35, letterSpacing: lvl <= 2 ? "-0.015em" : undefined, margin: lvl <= 2 ? "16px 0 8px" : "12px 0 6px" }}>
          {inline(h[2])}
        </div>,
      );
      i++; continue;
    }

    // blockquote (consume consecutive > lines)
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      blocks.push(
        <blockquote key={key++} style={{ borderLeft: "2.5px solid var(--accent)", background: "var(--panel)", borderRadius: "0 8px 8px 0", padding: "8px 13px", margin: "8px 0 12px", color: "var(--t2)", lineHeight: 1.62 }}>
          {inline(buf.join("\n"))}
        </blockquote>,
      );
      continue;
    }

    // bullet list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      flushList(items, false);
      continue;
    }

    // numbered list
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.)]\s+/, "")); i++; }
      flushList(items, true);
      continue;
    }

    // <Card> / <CardGroup> block — same card UI MdxDoc renders (fallback parity)
    if (CARD_BLOCK_START.test(line)) {
      const isGroup = /^\s*<CardGroup\b/.test(line);
      const closeRe = isGroup ? /<\/CardGroup>/ : /(\/>\s*$|<\/Card>)/;
      const buf: string[] = [lines[i]];
      i++;
      while (i < lines.length && !closeRe.test(buf[buf.length - 1])) { buf.push(lines[i]); i++; }
      const parsed = parseCardBlock(buf.join("\n"));
      if (parsed.cards.length === 0) {
        // not actually card markup (e.g. a lone unclosed tag) — show it as literal text
        blocks.push(<p key={key++} style={{ margin: "0 0 10px", lineHeight: 1.68 }}>{inline(buf.join(" "))}</p>);
        continue;
      }
      const rendered = parsed.cards.map((c, j) => (
        <Card key={j} title={c.title} icon={c.icon} href={c.href}>{c.body ? inline(c.body.replace(/\s*\n\s*/g, " ")) : undefined}</Card>
      ));
      blocks.push(parsed.grouped
        ? <CardGroup key={key++} cols={parsed.cols}>{rendered}</CardGroup>
        : <div key={key++} style={{ display: "flex", flexDirection: "column", gap: 10, margin: "8px 0 12px" }}>{rendered}</div>);
      continue;
    }

    // GFM pipe table
    const table = tableStart(lines, i);
    if (table) {
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length) {
        const row = splitTableRow(lines[i]);
        if (!row) break;
        rows.push(Array.from({ length: table.header.length }, (_, col) => row[col] ?? ""));
        i++;
      }
      blocks.push(
        <div key={key++} style={{ overflowX: "auto", margin: "10px 0 14px", borderRadius: 10, border: "1px solid var(--line)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", color: "var(--t1)", fontSize: "0.94em", lineHeight: 1.5 }}>
            <thead>
              <tr>
                {table.header.map((cell, col) => (
                  <th key={col} style={{ background: "var(--panel2)", borderBottom: "1px solid var(--line)", borderRight: col < table.header.length - 1 ? "1px solid var(--line)" : undefined, padding: "8px 11px", textAlign: table.align[col], color: "var(--t1)", fontWeight: 600 }}>
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, col) => (
                    <td key={col} style={{ borderBottom: rowIndex < rows.length - 1 ? "1px solid var(--line)" : undefined, borderRight: col < table.header.length - 1 ? "1px solid var(--line)" : undefined, padding: "8px 11px", textAlign: table.align[col], color: "var(--t2)", verticalAlign: "top" }}>
                      {inline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // paragraph — gather consecutive plain lines until a blank or a block starter
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*```/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*>/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i]) && !CARD_BLOCK_START.test(lines[i]) && !tableStart(lines, i)) {
      para.push(lines[i]); i++;
    }
    blocks.push(
      <p key={key++} style={{ margin: "0 0 10px", lineHeight: 1.68 }}>
        {para.map((pl, j) => <Fragment key={j}>{j > 0 && <br />}{inline(pl)}</Fragment>)}
      </p>,
    );
  }

  return <div style={{ color: "var(--t1)", ...style }}>{blocks}</div>;
}
