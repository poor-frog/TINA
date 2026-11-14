"use client";
import { useEffect, useRef, useState } from 'react';
import styles from './workspacePanel.module.css';

export function WorkspaceContentSearch({ mounts, onOpen, forceOpen = false, showSummary = true, hidden = false }: {
  mounts: Array<{ slug: string; name?: string | null }>;
  onOpen: (path: string, slug: string) => void;
  forceOpen?: boolean;
  showSummary?: boolean;
  hidden?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Array<{ path: string; line: number; text: string; slug: string; workspace: string }>>([]);
  const [status, setStatus] = useState('');
  const serial = useRef(0);
  const scope = mounts.map(m => m.slug).join('\0');
  useEffect(() => { serial.current++; setHits([]); setStatus(''); return () => { serial.current++; }; }, [scope]);
  async function search() {
    const ticket = ++serial.current;
    setHits([]); setStatus('Searching file contents…');
    try {
      const results = await Promise.all(mounts.map(async mount => {
        const response = await fetch(`/api/workspace/search?${new URLSearchParams({ q: query.trim(), slug: mount.slug })}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Couldn’t search workspace ${mount.name || mount.slug}.`);
        const result: { hits: Array<{ path: string; line: number; text: string }>; bounded: boolean } = await response.json();
        return { ...result, hits: result.hits.map(hit => ({ ...hit, slug: mount.slug, workspace: mount.name || mount.slug })) };
      }));
      if (ticket !== serial.current) return;
      const all = results.flatMap(result => result.hits);
      setHits(all.slice(0, 50));
      setStatus(`${Math.min(all.length, 50)} results${all.length > 50 || results.some(result => result.bounded) ? '. Search limit reached.' : ''}`);
    } catch (error) { if (ticket === serial.current) setStatus((error as Error).message); }
  }
  const content = <>
    <form className={styles.searchForm} aria-label="Search workspace content" onSubmit={event => { event.preventDefault(); void search(); }}>
      <input type="search" aria-label="Search file contents" placeholder="Word or phrase…" value={query} maxLength={200} onChange={event => setQuery(event.target.value)} />
      <button type="submit" className={styles.searchButton} disabled={!query.trim() || !mounts.length}>Search</button>
    </form>
    <p className={styles.searchStatus} role="status">{status}</p>
    {hits.length > 0 && <div className={styles.searchResults}>
      {hits.map(hit => <button className={styles.searchResult} type="button" key={`${hit.slug}:${hit.path}:${hit.line}`}
        aria-label={`${hit.workspace}, ${hit.path}, line ${hit.line}: ${hit.text}`} onClick={() => onOpen(hit.path, hit.slug)}>
        <span className={styles.resultMeta}>
          <span>{hit.workspace}</span>
          <span className={styles.resultPath}>{hit.path}</span>
          <span>Line {hit.line}</span>
        </span>
        <span className={styles.resultExcerpt}>{hit.text}</span>
      </button>)}
    </div>}
  </>;
  return showSummary
    ? <details className={styles.contentSearch} open={forceOpen || undefined} hidden={hidden}><summary>Search within content</summary>{content}</details>
    : <div className={styles.contentSearch} hidden={hidden}>{content}</div>;
}
