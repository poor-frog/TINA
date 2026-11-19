"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useService } from "../platform";
import { LayoutServiceId } from "../workbench/layout";
import type { TabProps } from "../contributions";
import { Icon } from "../ui-kit";
import { listWorkspaceTree, readWorkspaceFile } from "./workspaceApi";
import { presentError } from "./apiClient";
import { buildWorkspaceGraph, type WorkspaceGraph, type WorkspaceGraphEdge, type WorkspaceGraphEntity, type WorkspaceGraphFile } from "./workspaceGraphModel";
import styles from "./workspaceGraph.module.css";

const ENTITY_PATH = /^kg\/entities\/[^/]+\/[^/]+\.md$/i;
const BATCH_SIZE = 8; // shortcut: read entity pages in small batches; use a graph endpoint if per-file reads become slow.
const NODE_WIDTH = 184;
const NODE_HEIGHT = 44;
const LANE_STEP = 244;
const ROW_STEP = 72;

interface Position { x: number; y: number }

function documentTab(path: string, slug?: string) {
  return { id: slug ? `doc:${slug}:${path}` : `doc:${path}`, title: path.split("/").pop() ?? path, kind: "doc", params: { path, slug } };
}

function edgePath(from: Position, to: Position): string {
  const fromY = from.y + NODE_HEIGHT / 2;
  const toY = to.y + NODE_HEIGHT / 2;
  if (from.x === to.x) {
    const bend = from.x - 44;
    return `M ${from.x} ${fromY} C ${bend} ${fromY}, ${bend} ${toY}, ${from.x} ${toY}`;
  }
  if (from.x < to.x) {
    const gap = to.x - (from.x + NODE_WIDTH);
    const bend = Math.max(28, gap / 2);
    return `M ${from.x + NODE_WIDTH} ${fromY} C ${from.x + NODE_WIDTH + bend} ${fromY}, ${to.x - bend} ${toY}, ${to.x} ${toY}`;
  }
  const gap = from.x - (to.x + NODE_WIDTH);
  const bend = Math.max(28, gap / 2);
  return `M ${from.x} ${fromY} C ${from.x - bend} ${fromY}, ${to.x + NODE_WIDTH + bend} ${toY}, ${to.x + NODE_WIDTH} ${toY}`;
}

function nodeMatches(node: WorkspaceGraphEntity, query: string): boolean {
  return `${node.title} ${node.id} ${node.type}`.toLocaleLowerCase().includes(query);
}

export function WorkspaceGraphTab({ params }: TabProps) {
  const layout = useService(LayoutServiceId);
  const markerId = `kg-edge-${useId().replace(/:/g, "")}`;
  const slug = typeof params.slug === "string" ? params.slug : undefined;
  const workspaceName = typeof params.name === "string" ? params.name : "Workspace";
  const [graph, setGraph] = useState<WorkspaceGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setGraph(null);
    setSelectedPath(null);
    void (async () => {
      const paths = (await listWorkspaceTree({ slug })).filter((path) => ENTITY_PATH.test(path));
      const files: WorkspaceGraphFile[] = [];
      for (let offset = 0; offset < paths.length; offset += BATCH_SIZE) {
        const batch = await Promise.all(paths.slice(offset, offset + BATCH_SIZE).map(async (path) => ({
          path,
          content: await readWorkspaceFile(path, slug ? { slug } : undefined),
        })));
        if (!current) return;
        files.push(...batch);
      }
      const result = buildWorkspaceGraph(files);
      if (current) {
        setGraph(result);
        setSelectedPath(result.nodes[0]?.path ?? null);
      }
    })().catch((reason: unknown) => {
      if (current) setError(presentError(reason).headline);
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [slug, refreshKey]);

  const needle = query.trim().toLocaleLowerCase();
  const matchingPaths = useMemo(() => new Set((graph?.nodes ?? []).filter((node) => nodeMatches(node, needle)).map((node) => node.path)), [graph, needle]);
  useEffect(() => {
    if (matchingPaths.size && selectedPath && !matchingPaths.has(selectedPath)) setSelectedPath([...matchingPaths][0]);
  }, [matchingPaths, selectedPath]);

  const lanes = useMemo(() => {
    const byType = new Map<string, WorkspaceGraphEntity[]>();
    for (const node of graph?.nodes ?? []) byType.set(node.type, [...(byType.get(node.type) ?? []), node]);
    return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([type, nodes]) => ({
      type,
      nodes: nodes.sort((a, b) => Number(matchingPaths.has(b.path)) - Number(matchingPaths.has(a.path)) || a.title.localeCompare(b.title)),
    }));
  }, [graph, matchingPaths]);
  const positions = useMemo(() => {
    const result = new Map<string, Position>();
    lanes.forEach((lane, laneIndex) => lane.nodes.forEach((node, rowIndex) => {
      result.set(node.path, { x: 34 + laneIndex * LANE_STEP, y: 64 + rowIndex * ROW_STEP });
    }));
    return result;
  }, [lanes]);
  const width = Math.max(620, 34 + Math.max(0, lanes.length - 1) * LANE_STEP + NODE_WIDTH + 34);
  const height = Math.max(380, 118 + Math.max(0, ...lanes.map((lane) => lane.nodes.length)) * ROW_STEP);
  const selected = graph?.nodes.find((node) => node.path === selectedPath) ?? null;
  const byPath = useMemo(() => new Map((graph?.nodes ?? []).map((node) => [node.path, node])), [graph]);
  const linksTo = (graph?.edges ?? []).filter((edge) => edge.from === selectedPath).map((edge) => byPath.get(edge.to)).filter((node): node is WorkspaceGraphEntity => Boolean(node));
  const linkedFrom = (graph?.edges ?? []).filter((edge) => edge.to === selectedPath).map((edge) => byPath.get(edge.from)).filter((node): node is WorkspaceGraphEntity => Boolean(node));

  return (
    <main className={styles.root}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <Icon name="link" size={19} />
          <div>
            <h1>Knowledge graph</h1>
            <p>{workspaceName}: Markdown entities connected by [[wikilinks]]</p>
          </div>
        </div>
        {graph && <div className={styles.counts} aria-label={`${graph.nodes.length} entities and ${graph.edges.length} links`}>
          <span>{graph.nodes.length} entities</span>
          <span>{graph.edges.length} links</span>
        </div>}
      </header>

      <div className={styles.toolbar}>
        <label className={styles.search}>
          <Icon name="search" size={15} />
          <input type="search" aria-label="Search entities" placeholder="Search entities" value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <span className={styles.searchStatus} aria-live="polite">
          {needle ? matchingPaths.size ? `${matchingPaths.size} matches` : "No matching entities" : "Search by name, ID, or type"}
        </span>
        <button type="button" className={styles.refresh} onClick={() => setRefreshKey((key) => key + 1)} disabled={loading}>
          <Icon name="refresh" size={14} />
          <span>{loading ? "Loading" : "Refresh"}</span>
        </button>
      </div>

      <div className={styles.workarea}>
        {loading ? (
          <section className={styles.state} role="status" aria-label="Loading knowledge graph">
            <div className={styles.skeleton} aria-hidden="true"><i /><i /><i /></div>
            <p>Loading entity pages…</p>
          </section>
        ) : error ? (
          <section className={styles.state} role="alert">
            <h2>Couldn’t load this graph</h2>
            <p>{error}</p>
            <button type="button" className={styles.retry} onClick={() => setRefreshKey((key) => key + 1)}>Try again</button>
          </section>
        ) : !graph?.nodes.length ? (
          <section className={styles.state}>
            <h2>No entity pages found</h2>
            <p>Add Markdown pages under <code>kg/entities/&lt;type&gt;/</code> with <code>type</code>, <code>id</code>, and <code>title</code> fields. Connect pages with <code>[[wikilinks]]</code>, then refresh.</p>
          </section>
        ) : (
          <>
            <section className={styles.plot} aria-label="Entity relationship map">
              <svg className={styles.map} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`${graph.nodes.length} entity nodes connected by ${graph.edges.length} workspace wikilinks`}>
                <defs>
                  <marker id={`${markerId}-plain`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto" markerUnits="userSpaceOnUse">
                    <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--line)" />
                  </marker>
                  <marker id={`${markerId}-active`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto" markerUnits="userSpaceOnUse">
                    <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--accent)" />
                  </marker>
                </defs>
                {lanes.map((lane, index) => {
                  const x = 34 + index * LANE_STEP;
                  return <g key={lane.type}>
                    <text className={styles.laneTitle} x={x} y={22}>{lane.type}</text>
                    <text className={styles.laneCount} x={x} y={42}>{lane.nodes.length} entities</text>
                  </g>;
                })}
                <g aria-hidden="true">
                  {graph.edges.map((edge: WorkspaceGraphEdge) => {
                    const from = positions.get(edge.from);
                    const to = positions.get(edge.to);
                    if (!from || !to) return null;
                    const active = selectedPath === edge.from || selectedPath === edge.to;
                    const found = matchingPaths.has(edge.from) || matchingPaths.has(edge.to);
                    const muted = Boolean(needle) && !found;
                    return <path key={`${edge.from}:${edge.to}`} d={edgePath(from, to)}
                      markerEnd={`url(#${markerId}-${active ? "active" : "plain"})`}
                      className={`${styles.edge}${active ? ` ${styles.edgeActive}` : ""}${muted ? ` ${styles.edgeMuted}` : ""}`} />;
                  })}
                </g>
                {lanes.flatMap((lane) => lane.nodes.map((node) => {
                  const point = positions.get(node.path)!;
                  const isSelected = selectedPath === node.path;
                  const isMatch = matchingPaths.has(node.path);
                  const muted = Boolean(needle) && !isMatch;
                  const label = node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title;
                  return <g
                    key={node.path}
                    className={`${styles.node}${isSelected ? ` ${styles.nodeSelected}` : ""}${isMatch && needle ? ` ${styles.nodeMatch}` : ""}${muted ? ` ${styles.nodeMuted}` : ""}`}
                    role="button"
                    aria-label={`${node.title}, ${node.type}`}
                    aria-pressed={isSelected}
                    tabIndex={0}
                    onClick={() => setSelectedPath(node.path)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedPath(node.path); }
                    }}
                  >
                    <title>{node.title}</title>
                    <rect x={point.x} y={point.y} width={NODE_WIDTH} height={NODE_HEIGHT} />
                    <text className={styles.nodeTitle} x={point.x + 12} y={point.y + 19}>{label}</text>
                    <text className={styles.nodeType} x={point.x + 12} y={point.y + 35}>{node.type}</text>
                  </g>;
                }))}
              </svg>
            </section>

            <aside className={styles.details} aria-label="Selected entity details">
              {selected ? <>
                <div className={styles.detailHeading}>
                  <span>{selected.type}</span>
                  <h2>{selected.title}</h2>
                </div>
                <dl className={styles.metadata}>
                  <div><dt>ID</dt><dd>{selected.id}</dd></div>
                  <div><dt>File</dt><dd title={selected.path}>{selected.path}</dd></div>
                </dl>
                <RelationshipList title="Links to" nodes={linksTo} onSelect={setSelectedPath} />
                <RelationshipList title="Linked from" nodes={linkedFrom} onSelect={setSelectedPath} />
                <button type="button" className={styles.openDocument} onClick={() => layout.openTab(documentTab(selected.path, slug))}>
                  <Icon name="file" size={15} />
                  <span>Open document</span>
                </button>
              </> : <p>Select an entity to inspect its links.</p>}
            </aside>
          </>
        )}
      </div>
    </main>
  );
}

function RelationshipList({ title, nodes, onSelect }: { title: string; nodes: WorkspaceGraphEntity[]; onSelect: (path: string) => void }) {
  return <section className={styles.relationships}>
    <h3>{title}</h3>
    {nodes.length ? nodes.map((node) => <button key={node.path} type="button" className={styles.relationship} onClick={() => onSelect(node.path)}>
      <span>{node.title}</span><small>{node.type}</small>
    </button>) : <p className={styles.noLinks}>No linked entities</p>}
  </section>;
}
