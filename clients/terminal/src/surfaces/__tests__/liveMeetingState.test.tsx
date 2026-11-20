import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LiveMeetingState } from '../LiveMeetingState';

const fetchMock = vi.fn();
const state = { configured: true, enabled: true, can_configure: true, readonly: false, revision: 3,
  goal: { text: 'Test retries', revision: 1 }, config: { fast_seconds: 30, reason_seconds: 120, timezone: 'UTC', eagerness: 'normal', approval: 'host', approvers: [], quorum: 1 },
  items: [{ id: 'q1', type: 'question', text: 'Should we test retries?', status: 'open', revision: 2, provisional: true, human: false, stale: false,
    evidence: [{ segment_id: 's1', speaker_name: 'Lan', start_ms: 12000, quote: 'Should we test retries?' }] }],
  summaries: { current: 'Exploring retries', meeting: 'Testing service behavior' },
  freshness: { fast: { status: 'completed', covered: 4 }, reason: { status: 'running', covered: 1 } }, proposals: [], activity: [] };
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });

beforeEach(() => {
  fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  fetchMock.mockImplementation((path: string) => Promise.resolve(path === '/api/admin/me' ? response({}, false) : response(state)));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows separately attributed stage state and cited provisional items only after opening', async () => {
  render(<LiveMeetingState meetingId="42" />);
  expect(fetchMock).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Live State' }));
  fireEvent.click(await screen.findByText('Should we test retries?', { selector: 'summary span' }));
  expect(screen.getByText(/Provisional/)).toBeTruthy();
  fireEvent.click(screen.getByText('Processing and activity'));
  expect(screen.getByRole('status').textContent).toContain('Extraction: completed');
  expect(screen.getByRole('status').textContent).toContain('Reasoning: running');
  expect(screen.getByText('Source · Lan · 12s')).toBeTruthy();
  expect(screen.queryByText('Operator diagnostics')).toBeNull();
});

it('opens model settings first and sends the interval selected for each model', async () => {
  render(<LiveMeetingState meetingId="42" advanced />);
  fireEvent.click(screen.getByRole('button', { name: 'Advanced controls' }));
  const fast = await screen.findByLabelText('Extraction window');
  const reasoning = screen.getByLabelText('Reconciliation interval');
  expect(screen.getByRole('heading', { name: 'Fast model' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Reasoning model' })).toBeTruthy();
  fireEvent.change(fast, { target: { value: '15' } });
  await waitFor(() => expect(fast.matches(':disabled')).toBe(false));
  fireEvent.change(reasoning, { target: { value: '300' } });
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/configure')).map(([, init]) => JSON.parse(init.body))).toEqual([
    { fast_seconds: 15 }, { reason_seconds: 300 },
  ]));
});

it('jumps from an exact transcript citation to its segment', async () => {
  const jump = vi.fn();
  render(<LiveMeetingState meetingId="42" onSourceJump={jump} />);
  fireEvent.click(screen.getByRole('button', { name: 'Live State' }));
  fireEvent.click(await screen.findByText('Should we test retries?', { selector: 'summary span' }));
  fireEvent.click(screen.getByText('Source · Lan · 12s'));
  fireEvent.click(screen.getByText('Jump to transcript'));
  expect(jump).toHaveBeenCalledWith('s1');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('sends revision-checked manual field edits and keeps draft on a conflict', async () => {
  render(<LiveMeetingState meetingId="42" />);
  fireEvent.click(screen.getByRole('button', { name: 'Live State' }));
  fireEvent.click(await screen.findByText('Should we test retries?', { selector: 'summary span' }));
  fireEvent.click(await screen.findByText('Edit field'));
  fireEvent.change(screen.getByLabelText('Edit state text'), { target: { value: 'Human clarification' } });
  fetchMock.mockImplementation((path: string) => Promise.resolve(path.endsWith('/edit') ? response({ detail: 'Field changed' }, false) : response(state)));
  fireEvent.click(screen.getByText('Save field'));
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Edit state text') as HTMLTextAreaElement).value).toBe('Human clarification');
  const mutation = fetchMock.mock.calls.find(([path]) => path.endsWith('/edit'))!;
  expect(JSON.parse(mutation[1].body)).toEqual({ id: 'q1', expected_revision: 2, patch: { text: 'Human clarification', details: {} } });
});

it('exposes no edit controls after meeting end and keeps final export available', async () => {
  fetchMock.mockImplementation((path: string) => Promise.resolve(path === '/api/admin/me' ? response({}, false) : response({ ...state, readonly: true, final: 'incomplete' })));
  render(<LiveMeetingState meetingId="42" />);
  fireEvent.click(screen.getByRole('button', { name: 'Live State' }));
  await screen.findByText('Should we test retries?', { selector: 'summary span' });
  expect(screen.queryByText('Edit field')).toBeNull();
  expect(screen.queryByText('Pause assistant')).toBeNull();
  expect(screen.getByText('Export current state').getAttribute('href')).toBe('/api/transcripts/by-id/42/state/export');
});

it('requires explicit opt-in before revealing a planned draft', async () => {
  fetchMock.mockImplementation((path: string) => Promise.resolve(path === '/api/admin/me' ? response({}, false) : response({ configured: false, enabled: false, can_configure: true, readonly: false })));
  render(<LiveMeetingState meetingId="42" />);
  fireEvent.click(screen.getByRole('button', { name: 'Live State' }));
  await screen.findByText('Enable assistant');
  expect(screen.queryByText('Edit goal')).toBeNull();
  fireEvent.click(screen.getByText('Enable assistant'));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => path.endsWith('/configure'))).toBe(true));
});

it('explains that a completed meeting with no live-state opt-in cannot be processed retroactively', async () => {
  fetchMock.mockImplementation((path: string) => Promise.resolve(path === '/api/admin/me'
    ? response({}, true)
    : response({ configured: false, enabled: false, can_configure: true, readonly: true })));
  render(<LiveMeetingState meetingId="42" />);
  fireEvent.click(screen.getByRole('button', { name: 'Live State' }));
  await screen.findByText('Live assist was not enabled for this completed meeting. Past meetings are not processed retroactively.');
  expect(screen.queryByText('Enable assistant')).toBeNull();
  expect(screen.queryByText('Operator diagnostics')).toBeNull();
  expect(screen.queryByText('Retry failed jobs')).toBeNull();
});

it('edits each summary with its own revision and requests earlier archive pages', async () => {
  const loaded = { ...state, summaries: { current: 'Current', meeting: 'Overall', current_revision: 5, meeting_revision: 3 },
    archive_more: true, archive_offset: 0, archive_count: 155, archive_items: [{ id: 'old1', type: 'question', text: 'Earlier question', status: 'open', revision: 1, human: false, provisional: false, stale: false, evidence: [] }] };
  const earlier = { ...loaded, archive_offset: 100, archive_more: false, archive_items: [] };
  const respond = (path: string) => Promise.resolve(path === '/api/admin/me' ? response({}, false)
    : response(path.includes('archive_offset=100') ? earlier : loaded));
  fetchMock.mockImplementation(respond);
  render(<LiveMeetingState meetingId="42" />);
  fireEvent.click(screen.getByRole('button', { name: 'Live State' }));
  fireEvent.click(await screen.findByText('Edit discussion summary'));
  fireEvent.change(screen.getByLabelText('Edit state text'), { target: { value: 'Human summary' } });
  fireEvent.click(screen.getByText('Save field'));
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).endsWith('/edit'))).toBe(true));
  const call = fetchMock.mock.calls.find(([path]) => String(path).endsWith('/edit'))!;
  expect(JSON.parse(call[1].body)).toEqual({ id: 'summary-current', expected_revision: 5, patch: { text: 'Human summary' } });
  await waitFor(() => expect(fetchMock.mock.calls.some(([path]) => String(path).includes('archive_offset=100'))).toBe(true));
});
