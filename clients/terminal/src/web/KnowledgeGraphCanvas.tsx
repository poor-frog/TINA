"use client";
/** KnowledgeGraphCanvas — Upgraded Entity-Lane Knowledge Graph for the Production Web UI.
 *  Reuses `buildWorkspaceGraph` (entity Markdown files under `kg/entities/<type>/` connected via `[[wikilinks]]`), adds
 *  entity-type filter chips, zoom controls, directional link highlighting, and one-click document opening. */
import { useEffect, useId, useMemo, useState } from "react";
import { WebIcon } from "./Icons";
import { listWorkspaceTree, readWorkspaceFile } from "../surfaces/workspaceApi";
import { presentError } from "../surfaces/apiClient";
import {
  buildWorkspaceGraph,
  type WorkspaceGraph,
  type WorkspaceGraphEntity,
  type WorkspaceGraphFile,
} from "../surfaces/workspaceGraphModel";
import styles from "./knowledgeView.module.css";

const ENTITY_PATH = /^kg\/entities\/[^/]+\/[^/]+\.md$/i;
const BATCH_SIZE = 8;
const NODE_WIDTH = 192;
const NODE_HEIGHT = 48;
const LANE_STEP = 252;
const ROW_STEP = 74;

const TYPE_ACCENTS: Record<string, string> = {
  person: "#7ab8f5",
  meeting: "#91d7be",
  project: "#f2b880",
  company: "#c4a7f7",
  organization: "#c4a7f7",
  topic: "#f099b8",
  task: "#8ce09b",
};

interface Position {
  x: number;
  y: number;
}

function edgePath(from: Position, to: Position): string {
  const fromY = from.y + NODE_HEIGHT / 2;
  const toY = to.y + NODE_HEIGHT / 2;
  if (from.x === to.x) {
    const bend = from.x - 46;
    return `M ${from.x} ${fromY} C ${bend} ${fromY}, ${bend} ${toY}, ${from.x} ${toY}`;
  }
  if (from.x < to.x) {
    const gap = to.x - (from.x + NODE_WIDTH);
    const bend = Math.max(30, gap / 2);
    return `M ${from.x + NODE_WIDTH} ${fromY} C ${from.x + NODE_WIDTH + bend} ${fromY}, ${to.x - bend} ${toY}, ${to.x} ${toY}`;
  }
  const gap = from.x - (to.x + NODE_WIDTH);
  const bend = Math.max(30, gap / 2);
  return `M ${from.x} ${fromY} C ${from.x - bend} ${fromY}, ${to.x + NODE_WIDTH + bend} ${toY}, ${to.x + NODE_WIDTH} ${toY}`;
}

function nodeMatches(node: WorkspaceGraphEntity, needle: string): boolean {
  if (!needle) return true;
  return `${node.title} ${node.id} ${node.type} ${node.path}`.toLocaleLowerCase().includes(needle);
}

export function KnowledgeGraphCanvas({
  slug,
  workspaceName,
  isReadOnly,
  onOpenDocument,
  onAskTina,
  onCreateEntity,
}: {
  slug?: string;
  workspaceName: string;
  isReadOnly: boolean;
  onOpenDocument: (path: string) => void;
  onAskTina: (prompt: string) => void;
  onCreateEntity?: () => void;
}) {
  const markerBase = `wkg-${useId().replace(/:/g, "")}`;
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState("");
  const [activeType, setActiveType] = useState<string>("all");
  const [zoom, setZoom] = useState<number>(1);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setGraph(null);
    setSelectedPath(null);
    setActiveType("all");
    void (async () => {
      const paths = (await listWorkspaceTree(slug ? { slug } : undefined)).filter((p) => ENTITY_PATH.test(p));
      const files: WorkspaceGraphFile[] = [];
      for (let offset = 0; offset < paths.length; offset += BATCH_SIZE) {
        const batch = await Promise.all(
          paths.slice(offset, offset + BATCH_SIZE).map(async (path) => ({
            path,
            content: await readWorkspaceFile(path, slug ? { slug } : undefined),
          })),
        );
        if (!alive) return;
        files.push(...batch);
      }
      const built = buildWorkspaceGraph(files);
      if (alive) {
        setGraph(built);
        setSelectedPath(built.nodes[0]?.path ?? null);
      }
    })()
      .catch((err: unknown) => {
        if (alive) setError(presentError(err).headline);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, refreshKey]);

  const allTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of graph?.nodes ?? []) {
      counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [graph]);

  const visibleNodes = useMemo(() => {
    const nodes = graph?.nodes ?? [];
    if (activeType === "all") return nodes;
    return nodes.filter((n) => n.type === activeType);
  }, [graph, activeType]);

  const needle = query.trim().toLocaleLowerCase();
  const matchingPaths = useMemo(
    () => new Set(visibleNodes.filter((n) => nodeMatches(n, needle)).map((n) => n.path)),
    [visibleNodes, needle],
  );

  useEffect(() => {
    if (!visibleNodes.length) {
      setSelectedPath(null);
      return;
    }
    if (!selectedPath || !visibleNodes.some((n) => n.path === selectedPath)) {
      setSelectedPath([...matchingPaths][0] ?? visibleNodes[0]?.path ?? null);
    }
  }, [visibleNodes, matchingPaths, selectedPath]);

  const lanes = useMemo(() => {
    const byType = new Map<string, WorkspaceGraphEntity[]>();
    for (const node of visibleNodes) {
      byType.set(node.type, [...(byType.get(node.type) ?? []), node]);
    }
    return [...byType.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([type, nodes]) => ({
        type,
        nodes: [...nodes].sort(
          (a, b) =>
            Number(matchingPaths.has(b.path)) - Number(matchingPaths.has(a.path)) ||
            a.title.localeCompare(b.title),
        ),
      }));
  }, [visibleNodes, matchingPaths]);

  const positions = useMemo(() => {
    const pos = new Map<string, Position>();
    lanes.forEach((lane, laneIdx) => {
      lane.nodes.forEach((node, rowIdx) => {
        pos.set(node.path, { x: 36 + laneIdx * LANE_STEP, y: 60 + rowIdx * ROW_STEP });
      });
    });
    return pos;
  }, [lanes]);

  const visibleSet = useMemo(() => new Set(visibleNodes.map((n) => n.path)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => (graph?.edges ?? []).filter((e) => visibleSet.has(e.from) && visibleSet.has(e.to)),
    [graph, visibleSet],
  );

  const byPath = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.path, n])), [graph]);
  const selected = (selectedPath ? byPath.get(selectedPath) : null) ?? null;

  const linksTo = useMemo(
    () =>
      (graph?.edges ?? [])
        .filter((e) => e.from === selectedPath)
        .map((e) => byPath.get(e.to))
        .filter((n): n is WorkspaceGraphEntity => Boolean(n)),
    [graph, selectedPath, byPath],
  );
  const linkedFrom = useMemo(
    () =>
      (graph?.edges ?? [])
        .filter((e) => e.to === selectedPath)
        .map((e) => byPath.get(e.from))
        .filter((n): n is WorkspaceGraphEntity => Boolean(n)),
    [graph, selectedPath, byPath],
  );

  const rawWidth = Math.max(620, 36 + Math.max(0, lanes.length - 1) * LANE_STEP + NODE_WIDTH + 40);
  const rawHeight = Math.max(380, 108 + Math.max(0, ...lanes.map((l) => l.nodes.length)) * ROW_STEP);

  return (
    <section className={styles.graphShell} aria-label="Knowledge graph">
      <div className={styles.graphToolbar}>
        <div className={styles.searchBox} style={{ width: 220 }}>
          <WebIcon name="search" size={14} />
          <input
            type="search"
            aria-label="Filter graph entities"
            placeholder="Filter entities…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className={styles.chipRow} style={{ marginTop: 0 }}>
          <button
            type="button"
            className={`${styles.chip} ${activeType === "all" ? styles.chipActive : ""}`}
            onClick={() => setActiveType("all")}
          >
            All ({graph?.nodes.length ?? 0})
          </button>
          {allTypes.map(([type, count]) => (
            <button
              key={type}
              type="button"
              className={`${styles.chip} ${activeType === type ? styles.chipActive : ""}`}
              onClick={() => setActiveType(type)}
            >
              {type} ({count})
            </button>
          ))}
        </div>

        <div className={styles.graphZoom}>
          <span className={styles.graphStats}>
            {visibleNodes.length} entities · {visibleEdges.length} links
          </span>
          <button
            type="button"
            className={styles.tinyBtn}
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.55, Number((z - 0.15).toFixed(2))))}
          >
            −
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            aria-label="Reset zoom"
            onClick={() => setZoom(1)}
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(1.45, Number((z + 0.15).toFixed(2))))}
          >
            +
          </button>
          <button
            type="button"
            className={styles.tinyBtn}
            onClick={() => setRefreshKey((k) => k + 1)}
            disabled={loading}
          >
            <WebIcon name="refresh" size={12} />
            <span>{loading ? "Loading" : "Refresh"}</span>
          </button>
        </div>
      </div>

      {loading ? (
        <div className={styles.emptyState} role="status">
          <WebIcon name="network" size={26} />
          <h3>Building knowledge graph…</h3>
          <p>Scanning entity pages and [[wikilinks]] in {workspaceName}.</p>
        </div>
      ) : error ? (
        <div className={styles.emptyState} role="alert">
          <WebIcon name="alertTriangle" size={26} />
          <h3>Could not load knowledge graph</h3>
          <p>{error}</p>
          <button type="button" className={styles.btn} onClick={() => setRefreshKey((k) => k + 1)}>
            Try again
          </button>
        </div>
      ) : !graph?.nodes.length ? (
        <div className={styles.emptyState}>
          <WebIcon name="network" size={28} />
          <h3>No entity pages yet in {workspaceName}</h3>
          <p>
            Entity Markdown files under <code>kg/entities/&lt;type&gt;/</code> connected by{" "}
            <code>[[wikilinks]]</code> appear here automatically after meetings or edits.
          </p>
          {!isReadOnly && onCreateEntity && (
            <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={onCreateEntity}>
              <WebIcon name="plus" size={14} />
              <span>Create first entity</span>
            </button>
          )}
        </div>
      ) : (
        <div className={styles.graphWorkarea}>
          <div className={styles.graphCanvas}>
            <div style={{ width: rawWidth * zoom, height: rawHeight * zoom }}>
              <svg
                className={styles.graphSvg}
                width={rawWidth}
                height={rawHeight}
                viewBox={`0 0 ${rawWidth} ${rawHeight}`}
                style={{ transform: `scale(${zoom})` }}
                role="img"
                aria-label={`${workspaceName} knowledge graph with ${visibleNodes.length} entities`}
              >
                <defs>
                  <marker
                    id={`${markerBase}-arrow`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--tw-line-strong)" />
                  </marker>
                  <marker
                    id={`${markerBase}-arrow-active`}
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="var(--tw-mint)" />
                  </marker>
                </defs>

                {lanes.map((lane, laneIdx) => {
                  const accent = TYPE_ACCENTS[lane.type] ?? "#91d7be";
                  return (
                    <g key={lane.type}>
                      <circle cx={42 + laneIdx * LANE_STEP} cy={28} r={4} fill={accent} />
                      <text x={52 + laneIdx * LANE_STEP} y={32} className={styles.laneHeader}>
                        {lane.type} ({lane.nodes.length})
                      </text>
                    </g>
                  );
                })}

                {visibleEdges.map((edge) => {
                  const from = positions.get(edge.from);
                  const to = positions.get(edge.to);
                  if (!from || !to) return null;
                  const touchesSelected = selectedPath === edge.from || selectedPath === edge.to;
                  const cls = selectedPath
                    ? touchesSelected
                      ? `${styles.edge} ${styles.edgeActive}`
                      : `${styles.edge} ${styles.edgeDim}`
                    : styles.edge;
                  return (
                    <path
                      key={`${edge.from}->${edge.to}`}
                      d={edgePath(from, to)}
                      className={cls}
                      markerEnd={`url(#${markerBase}-${touchesSelected ? "arrow-active" : "arrow"})`}
                    />
                  );
                })}

                {visibleNodes.map((node) => {
                  const pos = positions.get(node.path);
                  if (!pos) return null;
                  const isSel = node.path === selectedPath;
                  const dimmed = Boolean(needle && !matchingPaths.has(node.path));
                  const accent = TYPE_ACCENTS[node.type] ?? "#91d7be";
                  const label = node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title;
                  return (
                    <g
                      key={node.path}
                      transform={`translate(${pos.x}, ${pos.y})`}
                      className={`${styles.nodeGroup} ${isSel ? styles.nodeSelected : ""} ${dimmed ? styles.nodeDim : ""}`}
                      onClick={() => setSelectedPath(node.path)}
                      onDoubleClick={() => onOpenDocument(node.path)}
                      role="button"
                      tabIndex={0}
                      aria-label={`${node.title} (${node.type})`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedPath(node.path);
                        }
                      }}
                    >
                      <rect className={styles.nodeRect} width={NODE_WIDTH} height={NODE_HEIGHT} rx={10} />
                      <rect x={0} y={10} width={3.5} height={NODE_HEIGHT - 20} rx={2} fill={accent} />
                      <text x={14} y={22} className={styles.nodeTitle}>
                        {label}
                      </text>
                      <text x={14} y={37} className={styles.nodeMeta}>
                        {node.type} · {node.id.slice(0, 16)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>

          <aside className={styles.graphInspector} aria-label="Selected entity details">
            {selected ? (
              <>
                <div>
                  <span className={styles.wsTag}>{selected.type}</span>
                  <h3 className={styles.inspectorTitle}>{selected.title}</h3>
                  <div className={styles.inspectorPath}>{selected.path}</div>
                </div>

                <div className={styles.inlineForm}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    onClick={() => onOpenDocument(selected.path)}
                  >
                    <WebIcon name="fileText" size={14} />
                    <span>Open document</span>
                  </button>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() =>
                      onAskTina(`Summarize what we know about "${selected.title}" (${selected.path}) and its related meetings or tasks.`)
                    }
                  >
                    <WebIcon name="tinaAsk" size={14} />
                    <span>Ask Tina</span>
                  </button>
                </div>

                <div className={styles.inspectorGroup}>
                  <div className={styles.inspectorGroupTitle}>Links to ({linksTo.length})</div>
                  {linksTo.length === 0 ? (
                    <span className={styles.cardSub}>No outgoing wikilinks.</span>
                  ) : (
                    linksTo.map((target) => (
                      <button
                        key={target.path}
                        type="button"
                        className={styles.inspectorLinkRow}
                        onClick={() => {
                          setActiveType("all");
                          setSelectedPath(target.path);
                        }}
                      >
                        <WebIcon name="link" size={12} />
                        <span className={styles.treeLabel}>{target.title}</span>
                        <span className={styles.wsTag}>{target.type}</span>
                      </button>
                    ))
                  )}
                </div>

                <div className={styles.inspectorGroup}>
                  <div className={styles.inspectorGroupTitle}>Linked from ({linkedFrom.length})</div>
                  {linkedFrom.length === 0 ? (
                    <span className={styles.cardSub}>No incoming wikilinks.</span>
                  ) : (
                    linkedFrom.map((source) => (
                      <button
                        key={source.path}
                        type="button"
                        className={styles.inspectorLinkRow}
                        onClick={() => {
                          setActiveType("all");
                          setSelectedPath(source.path);
                        }}
                      >
                        <WebIcon name="link" size={12} />
                        <span className={styles.treeLabel}>{source.title}</span>
                        <span className={styles.wsTag}>{source.type}</span>
                      </button>
                    ))
                  )}
                </div>
              </>
            ) : (
              <p className={styles.cardSub}>Select a node to inspect its wikilinks and open its Markdown page.</p>
            )}
          </aside>
        </div>
      )}
    </section>
  );
}
