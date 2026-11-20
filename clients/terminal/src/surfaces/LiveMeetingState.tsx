"use client";
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Download, FileText, SlidersHorizontal, X } from 'lucide-react';
import { useMeetingDialogEscape } from './useMeetingDialogEscape';
import type { LiveMeetingEvidence, LiveMeetingStateSnapshot as State } from './liveMeetingStateApi';
import { mergeLiveMeetingState, readAllLiveMeetingState, readLiveMeetingState } from './liveMeetingStateApi';
import styles from './meetingToolDialogs.module.css';
const statuses: Record<string, string[]> = { question: ['open', 'answered', 'deferred', 'withdrawn'], agenda: ['pending', 'in_progress', 'completed', 'deferred', 'uncertain'], task: ['proposed', 'accepted', 'in_progress', 'blocked', 'completed', 'cancelled', 'uncertain'], conclusion: ['proposed', 'tentative', 'agreed', 'contested', 'unresolved', 'deferred', 'superseded'] };
const statusText = (value: string) => value.charAt(0).toUpperCase() + value.slice(1).replaceAll('_', ' ');

export function LiveMeetingState({ meetingId, meetingTitle, onSourceJump, advanced = false }: {
  meetingId: string; meetingTitle?: string; onSourceJump?: (segmentId: string) => void; advanced?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [opened, setOpened] = useState(false);
  useMeetingDialogEscape(dialog, opened);
  const [snapshot, setData] = useState<State | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ id: string; revision: number; text: string; details?: Record<string, string | string[]>; type?: string } | null>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const draftId = draft?.id;
  useEffect(() => { if (draftId) draftInput.current?.focus(); }, [draftId]);
  const [profile, setProfile] = useState<unknown>(null);
  const [operator, setOperator] = useState(false);
  const [query, setQuery] = useState('');
  const [researchNotice, setResearchNotice] = useState('');
  const [archiveQuery, setArchiveQuery] = useState('');
  const [activityOffset, setActivityOffset] = useState(0);
  const base = `/api/transcripts/by-id/${encodeURIComponent(meetingId)}/state`;
  const loadedFor = useRef('');
  const data = loadedFor.current === base ? snapshot : null;
  const snapshotRef = useRef<State | null>(null);
  const publishData = useCallback((next: State | null) => { snapshotRef.current = next; setData(next); }, []);
  const serial = useRef(0);
  const pending = useRef(false);
  const requestedAt = useRef(0);
  const reportedRevision = useRef<number | null>(null);

  useEffect(() => {
    loadedFor.current = '';
    publishData(null); setDraft(null); setError(''); setProfile(null); setOperator(false); setQuery(''); setResearchNotice(''); setArchiveQuery(''); setActivityOffset(0); reportedRevision.current = null;
  }, [base, publishData]);

  useEffect(() => {
    if (!opened) return;
    const abort = new AbortController();
    async function refresh() {
      if (pending.current) return;
      const ticket = ++serial.current;
      try {
        requestedAt.current = performance.now();
        const previous = snapshotRef.current;
        let value = previous ? await readLiveMeetingState(meetingId, abort.signal, 0, activityOffset) : await readAllLiveMeetingState(meetingId, abort.signal, activityOffset);
        let reloadHistory = !previous;
        if (previous && value.configured && (!previous.configured || previous.archive_count !== value.archive_count || (!previous.source_notice && !!value.source_notice))) {
          value = await readAllLiveMeetingState(meetingId, abort.signal, activityOffset);
          reloadHistory = true;
        }
        if (!abort.signal.aborted && ticket === serial.current) {
          loadedFor.current = base;
          publishData(reloadHistory ? value : mergeLiveMeetingState(previous, value));
          setError('');
        }
      } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'State unavailable'); }
    }
    void refresh();
    void fetch('/api/admin/me', { signal: abort.signal }).then(r => { if (!abort.signal.aborted) setOperator(r.ok); }).catch(() => {});
    const timer = window.setInterval(refresh, 5000);
    return () => { abort.abort(); serial.current++; window.clearInterval(timer); };
  }, [base, activityOffset, meetingId, opened, publishData]);

  useEffect(() => {
    if (!opened || !data?.configured || reportedRevision.current === data.revision) return;
    const revision = data.revision, started = requestedAt.current;
    let second = 0;
    const first = window.requestAnimationFrame(() => {
      second = window.requestAnimationFrame(() => {
        const duration = performance.now() - started;
        if (document.visibilityState !== 'visible' || duration < 0 || duration > 60000) return;
        reportedRevision.current = revision;
        void fetch(`/api/meeting-state-metrics/${encodeURIComponent(meetingId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ duration_ms: duration, revision }) }).catch(() => {});
      });
    });
    return () => { window.cancelAnimationFrame(first); window.cancelAnimationFrame(second); };
  }, [data?.revision, data?.configured, opened, meetingId]);

  async function operation(action: string, payload: unknown) {
    if (pending.current || loadedFor.current !== base) return;
    pending.current = true; setBusy(true); setError(''); serial.current++;
    const ticket = serial.current;
    try {
      requestedAt.current = performance.now();
      const response = await fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.detail || 'Operation failed');
      if (ticket !== serial.current) return;
      let next = action === 'remove-source'
        ? await readAllLiveMeetingState(meetingId)
        : mergeLiveMeetingState(snapshot, value as State);
      if (action === 'edit' && payload && typeof payload === 'object' && (payload as { patch?: { status?: string } }).patch?.status === 'withdrawn') {
        const id = (payload as { id?: string }).id;
        next = { ...next, items: (next.items || []).filter((item) => item.id !== id) };
      }
      if (ticket !== serial.current) return;
      publishData(next);
      if (action === 'configure' || action === 'edit' || action === 'add' || action === 'vote' || action === 'remove-source') setActivityOffset(0);
      if (action === 'edit' || action === 'add') setDraft(null);
    } catch (e) { if (ticket === serial.current) setError(e instanceof Error ? e.message : 'Operation failed'); }
    finally { pending.current = false; setBusy(false); }
  }

  async function diagnostics(retry = false) {
    setError('');
    try {
      const response = await fetch(`/api/admin/meeting-state/${encodeURIComponent(meetingId)}`, { method: retry ? 'POST' : 'GET', cache: 'no-store' });
      if (!response.ok) throw new Error('Operator diagnostics unavailable');
      setProfile(await response.json());
    } catch (e) { setError(e instanceof Error ? e.message : 'Diagnostics unavailable'); }
  }

  async function research(event: React.FormEvent) {
    event.preventDefault();
    if (pending.current || !query.trim()) return;
    pending.current = true; setBusy(true); setError(''); setResearchNotice('');
    const ticket = ++serial.current;
    try {
      const response = await fetch(`/api/meeting-state-research/${encodeURIComponent(meetingId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: query.trim() }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.detail || 'Document research unavailable');
      if (ticket !== serial.current) return;
      setResearchNotice(result.sources_added ? `${result.sources_added} cited excerpts checked and attached for reconciliation.` : 'No matches within the bounded shared-document search.');
      requestedAt.current = performance.now();
      const next = await readAllLiveMeetingState(meetingId, undefined, activityOffset);
      if (ticket === serial.current) publishData(next);
    } catch (e) { if (ticket === serial.current) setError(e instanceof Error ? e.message : 'Document research unavailable'); }
    finally { pending.current = false; setBusy(false); }
  }

  function renderEvidence(evidence: LiveMeetingEvidence[]) {
    return evidence.map((source, index) => {
      const { document_id, segment_id, path, workspace_id, speaker_name, sha256, quote } = source;
      const start = source.start_ms || 0;
      const timestamp = start > 1e12 ? new Date(start).toLocaleTimeString() : `${Math.floor(start / 1000)}s`;
      return <details key={`${document_id || segment_id}-${index}`} className={styles.citation}>
        <summary>{document_id ? `Document · ${path}` : `Source · ${speaker_name} · ${timestamp}`}</summary>
        <blockquote>{quote}</blockquote>
        {segment_id && onSourceJump && <button type="button" className={styles.sourceLink} onClick={() => {
          dialog.current?.close();
          onSourceJump(segment_id);
        }}>Jump to transcript</button>}
        {document_id && <div className={styles.row}>
          <small>SHA-256 {sha256}</small>
          <a href={`/api/workspace/file?path=${encodeURIComponent(path || '')}&slug=${encodeURIComponent(workspace_id || '')}`} target="_blank" rel="noreferrer">Open source</a>
          {!data?.readonly && <button className={styles.button} disabled={busy} onClick={() => void operation('remove-source', { id: document_id })}>Remove source</button>}
        </div>}
      </details>;
    });
  }

  const title = advanced ? 'Advanced controls' : 'Live State';
  const DialogIcon = advanced ? SlidersHorizontal : FileText;
  const config = data?.config;
  const stages = [
    { role: 'fast', name: 'Fast model', label: 'Extraction', text: 'Extracts agenda items, decisions, actions, and questions from finalized speech.' },
    { role: 'reason', name: 'Reasoning model', label: 'Reasoning', text: 'Reconciles extracted items and updates summaries and relationships.' },
  ] as const;
  const meetingState = data?.configured && <>
    <section className={`${styles.card} ${styles.stack}`}>
      <h3>{data.readonly ? 'Meeting summary' : 'Meeting so far'}</h3>
      <p className={styles.summaryText}>{data.summaries?.meeting || 'Awaiting reconciliation'}</p>
      {data.summaries?.meeting_provenance && <small>{data.summaries.meeting_provenance.origin}{data.summaries.meeting_provenance.model && ` · ${data.summaries.meeting_provenance.model}`}</small>}
      {!data.readonly && <div><button className={styles.button} onClick={() => setDraft({ id: 'summary-meeting', type: 'summary', revision: data.summaries?.meeting_revision || 0, text: data.summaries?.meeting || '' })}>Edit meeting summary</button></div>}
      <p className={styles.goal}><strong>Goal</strong>{data.goal?.text || 'Not supplied'}</p>
      {data.goal && (data.goal.tentative || data.goal.source || data.goal.stale) && <small>
        {[data.goal.tentative && 'Tentative inference', data.goal.source, data.goal.stale && 'Stale source'].filter(Boolean).join(' · ')}
      </small>}
      {renderEvidence(data.goal?.evidence || [])}
      {!data.readonly && <div><button className={styles.button} onClick={() => setDraft({ id: 'goal', revision: data.goal?.revision || 0, text: data.goal?.text || '' })}>Edit goal</button></div>}
    </section>
    {data.summaries?.stale && <p className={styles.notice} role="status">Sources changed; the summary is awaiting reconciliation.</p>}
    {data.source_notice && <p className={styles.notice} role="status">Some document evidence is unavailable or no longer shareable. Dependent content is withheld.</p>}
    {!data.readonly && <div className={styles.row}>
      <button className={styles.button} onClick={() => setDraft({ id: 'new-agenda', type: 'agenda', revision: 0, text: '', details: {} })}>Add agenda item</button>
      <button className={styles.button} onClick={() => setDraft({ id: 'new-task', type: 'task', revision: 0, text: '', details: {} })}>Add action item</button>
      <button className={styles.button} onClick={() => setDraft({ id: 'new-question', type: 'question', revision: 0, text: '', details: {} })}>Add question</button>
    </div>}
    {draft && !data.readonly && <form className={`${styles.card} ${styles.stack}`} onSubmit={e => { e.preventDefault(); const adding = draft.id.startsWith('new-'); void operation(adding ? 'add' : 'edit', adding ? { type: draft.type, text: draft.text, details: draft.details || {} } : { id: draft.id, expected_revision: draft.revision, patch: { text: draft.text, ...(draft.details ? { details: draft.details } : {}) } }); }}>
      <label>Edit text<textarea ref={draftInput} aria-label="Edit state text" maxLength={draft.type === 'summary' ? 8000 : 3000} value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label>
      {(draft.type === 'task' ? ['assignees_text', 'deadline_text', 'deadline_date', 'timezone', 'definition_of_done', 'deliverables'] : draft.type === 'claim' ? ['claim_type', 'tags'] : []).map(key => <label key={key}>{key.replaceAll('_', ' ')} {key === 'claim_type' ? <select value={draft.details?.[key] || ''} onChange={e => setDraft({ ...draft, details: { ...draft.details, [key]: e.target.value } })}><option value="">Unclassified</option>{['factual_assertion', 'observation', 'opinion', 'assumption', 'hypothesis', 'proposal'].map(value => <option key={value}>{value}</option>)}</select> : <input maxLength={500} value={Array.isArray(draft.details?.[key]) ? (draft.details![key] as string[]).join(', ') : draft.details?.[key] || ''} onChange={e => setDraft({ ...draft, details: { ...draft.details, [key]: e.target.value } })} />}</label>)}
      <div className={styles.row}>
        <button className={styles.button} disabled={busy}>Save field</button>
        <button type="button" className={styles.button} onClick={() => setDraft(null)}>Cancel</button>
        <button type="button" className={styles.button} onClick={() => { const current = draft.id === 'summary-current' ? { revision: data.summaries?.current_revision || 0 } : draft.id === 'summary-meeting' ? { revision: data.summaries?.meeting_revision || 0 } : draft.id === 'goal' ? data.goal : data.items?.find(i => i.id === draft.id); if (current) setDraft({ ...draft, revision: current.revision }); }}>Use latest revision, keep draft</button>
      </div>
    </form>}
    {[{ title: 'Captured items', items: (data.items || []).slice(-100), recent: true }, { title: 'Earlier items', items: (data.items || []).slice(0, -100), recent: false }].filter(group => group.items.length).map(group => {
      const contents = <div className={styles.itemList}>
        {group.items.filter(item => group.recent || `${item.type} ${item.text} ${item.status}`.toLocaleLowerCase().includes(archiveQuery.toLocaleLowerCase())).map(item =>
          <details key={item.id} className={styles.item}>
            <summary>
              <span className={styles.itemType}>{item.type === 'task' ? 'Action' : statusText(item.type)}</span>
              <span className={styles.itemTitle}>{item.text}</span>
              <span className={`${styles.chip} ${['completed', 'agreed', 'answered'].includes(item.status) ? styles.active : ''}`}>{statusText(item.status)}</span>
            </summary>
            <div className={styles.detailsBody}>
              <small>{[
                item.provisional && 'Provisional', item.type === 'agenda' && !item.human && 'Inferred agenda',
                item.id === data.active_topic && 'Current discussion', item.stale && 'Stale source',
                item.provenance?.origin || (item.human ? 'human-edited' : 'model-derived'), item.provenance?.model,
                item.last_editor && `Last edited by ${item.last_editor}`,
              ].filter(Boolean).join(' · ')}</small>
              {Object.entries(item.details || {}).map(([key, value]) => <p key={key}><small>{key.replaceAll('_', ' ')}: {Array.isArray(value) ? value.join(', ') : value}{item.manual_fields?.includes(`details.${key}`) ? ' · human-edited' : ''}</small></p>)}
              {renderEvidence(item.evidence)}
              {!data.readonly && <div className={styles.row}>
                <button className={styles.button} onClick={() => setDraft({ id: item.id, revision: item.revision, text: item.text, details: item.details || {}, type: item.type })}>Edit field</button>
                {item.type === 'suggestion' && <button className={styles.button} onClick={() => setQuery(item.text.slice(0, 300))}>Use as document query</button>}
                {statuses[item.type] && <label>Status <select aria-label={`${item.type} status`} value={item.status} disabled={busy} onChange={e => void operation('edit', { id: item.id, expected_revision: item.revision, patch: { status: e.target.value } })}>{statuses[item.type].map(v => <option key={v}>{v}</option>)}</select></label>}
              </div>}
            </div>
          </details>
        )}
      </div>;
      return group.recent
        ? <section key={group.title}><h3>{group.title} <small>{group.items.length}</small></h3>{contents}</section>
        : <details key={group.title} className={styles.panel}>
            <summary>{group.title} ({group.items.length})</summary>
            <div className={styles.detailsBody}><label>Search loaded earlier items <input value={archiveQuery} onChange={e => setArchiveQuery(e.target.value)} /></label>{contents}</div>
          </details>;
    })}
    <details className={styles.panel} open={!data.readonly || undefined}>
      <summary>Current discussion</summary>
      <div className={styles.detailsBody}>
        <p className={styles.summaryText}>{data.summaries?.current || 'Awaiting reconciliation'}</p>
        {data.summaries?.current_provenance && <small>{data.summaries.current_provenance.origin}{data.summaries.current_provenance.model && ` · ${data.summaries.current_provenance.model}`}</small>}
        {!data.readonly && <div><button className={styles.button} onClick={() => setDraft({ id: 'summary-current', type: 'summary', revision: data.summaries?.current_revision || 0, text: data.summaries?.current || '' })}>Edit discussion summary</button></div>}
      </div>
    </details>
    {data.enabled && !data.readonly && <form className={`${styles.card} ${styles.stack}`} onSubmit={research}>
      <label>Search shared meeting documents <input aria-label="Document research query" maxLength={300} value={query} onChange={e => setQuery(e.target.value)} placeholder="Retry policy, project assumptions…" /></label>
      <div><button className={styles.button} disabled={busy || !query.trim() || data.research_available === false}>Research documents</button></div>
      {data.research_available === false && <p>Bind a shared workspace to use document research.</p>}
      {researchNotice && <p role="status">{researchNotice}</p>}
    </form>}
    {!!data.links?.length && <details className={styles.panel}>
      <summary>Reasoned relationships ({data.links.length})</summary>
      <div className={styles.detailsBody}>{data.links.map((link, index) => <article key={`${link.from}-${link.to}-${link.kind}-${index}`}>
        <p><strong>{link.kind}</strong> {link.from_text} → {link.to_text}</p>
        {link.evidence.map((e, i) => <blockquote key={`${e.segment_id || e.document_id}-${i}`}>{e.quote}</blockquote>)}
      </article>)}</div>
    </details>}
    {!!data.proposals?.length && <section className={styles.stack}>
      <h3>Approval requested</h3>
      {data.proposals.map(proposal => <article key={proposal.id} className={`${styles.card} ${styles.stack}`}>
        {proposal.item_id === 'summary-current' && <strong>Discussion summary proposal</strong>}
        {proposal.item_id === 'summary-meeting' && <strong>Meeting summary proposal</strong>}
        <p>{proposal.patch.text}</p>
        {proposal.roster_changed && <p role="status">Voting authorization changed; removed participants no longer count.</p>}
        <div className={styles.row}>
          <button className={styles.button} disabled={busy || !data.enabled || data.readonly} onClick={() => void operation('vote', { id: proposal.id, approve: true })}>Approve</button>
          <button className={styles.button} disabled={busy || !data.enabled || data.readonly} onClick={() => void operation('vote', { id: proposal.id, approve: false })}>Reject</button>
        </div>
      </article>)}
    </section>}
  </>;

  return <>
    <button type="button" className={styles.trigger} aria-haspopup="dialog" onClick={() => {
      setOpened(true);
      dialog.current?.showModal();
      if (body.current) body.current.scrollTop = 0;
    }}><DialogIcon size={16} aria-hidden="true" />{title}</button>
    <dialog ref={dialog} onClose={() => setOpened(false)} aria-labelledby={titleId} className={`${styles.dialog} ${advanced ? styles.advanced : ''}`}>
      <header className={styles.header}>
        <span className={styles.headerIcon}><DialogIcon size={20} aria-hidden="true" /></span>
        <div><h2 id={titleId}>{title}</h2><p>{meetingTitle && `${meetingTitle} · `}{advanced ? 'Live Assist' : 'Final meeting snapshot'}</p></div>
        <form method="dialog"><button className={`${styles.button} ${styles.quiet} ${styles.iconButton}`} aria-label={`Close ${title}`}><X size={19} aria-hidden="true" /></button></form>
      </header>
      <div className={styles.body} ref={body}>
        {error && <p className={styles.error} role="alert">{error}{draft && ' Your draft has been kept; reload the latest revision before reapplying.'}</p>}
        {!data && !error && <p role="status">Loading…</p>}
        {data && !data.configured && <p role="status">{data.readonly ? 'Live assist was not enabled for this completed meeting. Past meetings are not processed retroactively.' : 'Enable assistant to start collecting state from finalized meeting speech.'}</p>}
        {data?.configured && !data.enabled && !data.readonly && <p className={styles.notice}>Assistant is paused. Recorded finalized speech will be processed on re-enable.</p>}
        {data?.configured && <>
          {data.readonly && <div className={styles.row}>
            {data.final && <span className={`${styles.chip} ${data.final === 'complete' ? styles.active : ''}`}>{data.final === 'complete' ? 'Finalized' : `Finalization ${data.final}`}</span>}
            <span className={styles.chip}>Read only</span>
            {!!data.participants?.length && <span className={styles.meta}>{data.participants.map(p => `${p.name}${p.status === 'unknown' ? ' (unconfirmed)' : ''}`).join(', ')}</span>}
          </div>}
          {(advanced || !data.readonly) && <fieldset disabled={busy || !data.enabled}>
            <div className={`${styles.row} ${styles.spread}`}>
              <h3>Model processing</h3><span className={`${styles.chip} ${data.enabled ? styles.active : ''}`}>Live Assist {data.enabled ? 'active' : 'paused'}</span>
            </div>
            <div className={styles.modelGrid}>{stages.map(stage => {
              const freshness = data.freshness?.[stage.role];
              return <section className={`${styles.card} ${styles.modelCard}`} key={stage.role}>
                <div className={`${styles.row} ${styles.spread}`}>
                  <h4>{stage.name}</h4>
                  {freshness && <span className={styles.stage} data-status={freshness.status}>{statusText(freshness.status)}</span>}
                </div>
                <p>{stage.text}</p>
                {data.can_configure && !data.readonly && config && (stage.role === 'fast'
                  ? <label>Extraction window<select value={config.fast_seconds} onChange={e => void operation('configure', { fast_seconds: Number(e.target.value) })}><option value={15}>15 seconds</option><option value={30}>30 seconds</option></select></label>
                  : <label>Reconciliation interval<select value={config.reason_seconds} onChange={e => void operation('configure', { reason_seconds: Number(e.target.value) })}><option value={60}>1 minute</option><option value={120}>2 minutes</option><option value={300}>5 minutes</option></select></label>)}
              </section>;
            })}</div>
          </fieldset>}
          {data.can_configure && !data.readonly && config && <fieldset disabled={busy || !data.enabled}>
            <legend><h3>Meeting setup</h3></legend>
            <div className={styles.fieldGrid}>
              <label>Eagerness<select value={config.eagerness} onChange={e => void operation('configure', { eagerness: e.target.value })}>{['low', 'normal', 'high'].map(v => <option key={v} value={v}>{statusText(v)}</option>)}</select></label>
              <label>Timezone<input defaultValue={config.timezone} onBlur={e => { if (e.target.value !== config.timezone) void operation('configure', { timezone: e.target.value }); }} /></label>
              <label>AI-conflict approval<select value={config.approval} onChange={e => void operation('configure', { approval: e.target.value })}>{['host', 'named', 'any', 'quorum', 'unanimous'].map(v => <option key={v} value={v}>{statusText(v)}</option>)}</select></label>
              <label>Named approver account IDs<input defaultValue={config.approvers.join(',')} onBlur={e => { const values = e.target.value.trim() ? e.target.value.split(',').map(v => Number(v.trim())) : []; if (JSON.stringify(values) !== JSON.stringify(config.approvers)) void operation('configure', { approvers: values }); }} /></label>
              {config.approval === 'quorum' && <label>Required approvals<input type="number" min={1} max={100} defaultValue={config.quorum} onBlur={e => { const value = Number(e.target.value); if (value !== config.quorum) void operation('configure', { quorum: value }); }} /></label>}
            </div>
          </fieldset>}
          {advanced
            ? <details className={styles.panel}><summary>Meeting state</summary><div className={styles.detailsBody}>{meetingState}</div></details>
            : meetingState}
          <details className={styles.panel}>
            <summary>{advanced ? 'Processing details' : 'Processing and activity'}</summary>
            <div className={styles.detailsBody}>
              <p className={styles.status} role="status">{stages.flatMap(stage => {
                const value = data.freshness?.[stage.role];
                return value ? [`${stage.label}: ${value.status}${value.error ? ` (${value.error})` : ''} · coverage ${value.covered}`] : [];
              }).join(' | ')}</p>
              {!data.readonly && !!data.participants?.length && <p>Observed speakers: {data.participants.map(p => `${p.name}${p.status === 'unknown' ? ' (unconfirmed)' : ''}`).join(', ')}</p>}
              <details className={styles.citation}>
                <summary>Activity ({data.activity_count || 0})</summary>
                {data.activity?.map(e => <p key={e.sequence}>#{e.sequence} · {e.actor} · {e.kind}{e.target_text ? ` · ${e.target_text}` : ''}{e.status ? `: ${e.status}` : ''}{e.redacted && ' · source no longer shareable'}{e.before?.text && <> · Before: {e.before.text}</>}{e.after?.text && <> · After: {e.after.text}</>}{e.authorization_changed && ' · Voting authorization changed'}</p>)}
                {data.activity_more && <button className={styles.button} onClick={() => setActivityOffset((data.activity_offset || 0) + 100)}>Load older changes</button>}
              </details>
              {data.readonly && <p>Wiki: {data.wiki || 'pending'}{data.wiki_ref && <> · <a href={`/api/workspace/file?path=${encodeURIComponent(data.wiki_ref.path)}&slug=${encodeURIComponent(data.wiki_ref.workspace_id)}`} target="_blank" rel="noreferrer">Open final Wiki snapshot</a></>}</p>}
            </div>
          </details>
        </>}
        {operator && data?.configured && <details className={styles.panel}>
          <summary>Operator diagnostics</summary>
          <div className={styles.detailsBody}>
            <div className={styles.row}><button className={styles.button} onClick={() => void diagnostics()}>Load profiler</button><button className={styles.button} onClick={() => void diagnostics(true)}>Retry failed jobs</button>
              <a href={`/api/admin/meeting-state/${encodeURIComponent(meetingId)}`} download={`meeting-state-${meetingId}.json`}>Export trace</a>
            </div>
            {profile !== null && <pre>{JSON.stringify(profile, null, 2)}</pre>}
          </div>
        </details>}
      </div>
      <footer className={styles.footer}>
        {data?.can_configure && !data.readonly && <>
          <button type="button" className={`${styles.button} ${styles.quiet}`} disabled={busy} onClick={() => void operation('configure', {
            enabled: !data.enabled,
            ...(!data.configured ? { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
          })}>{data.enabled ? 'Pause assistant' : data.configured ? 'Resume assistant' : 'Enable assistant'}</button>
          {data.configured && data.enabled && <span className={styles.meta}>{busy ? 'Saving changes…' : 'Changes save automatically'}</span>}
        </>}
        {data?.configured && <a className={styles.button} href={`${base}/export`} download="meeting-state.md"><Download size={16} aria-hidden="true" />Export current state</a>}
        <form method="dialog"><button className={styles.button}>{advanced ? 'Done' : 'Close'}</button></form>
      </footer>
    </dialog>
  </>;
}
