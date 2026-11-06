import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DiscussionReview } from '../DiscussionReview';

const fetchMock = vi.fn();
const source = { id: 's0', segment_id: 'a/b', revision: 2, speaker_name: 'Lan', start_ms: 12000, end_ms: 14000, quote: 'Payment service cần idempotency key.', audio_available: true };
const decision = { label: 'relevant', reason: 'Đúng mục tiêu payment service.', source_ids: ['s0'] };
const report = { id: 'a'.repeat(32), meeting_id: 42, agenda: 'Review payment service', canonical_revision: 3, model: 'test-model', created_at: '2026-11-04T00:00:00Z',
  windows: [{ id: 'w0', relevance: decision, interaction: { labels: [], reason: 'Không công kích.', source_ids: ['s0'] }, progress: { ...decision, label: 'advancing' } }], sources: [source] };
const response = (value: unknown, ok = true) => ({ ok, json: async () => value });

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock); fetchMock.mockReset();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('waits for initial state before editing and retains the agenda draft on refresh', async () => {
  let release!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  render(<DiscussionReview meetingId="42" />);
  fireEvent.click(screen.getByRole('button', { name: 'Discussion review' }));
  const input = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(input.disabled).toBe(true);
  await act(async () => { release(response({ report, stale: false, can_generate: true })); });
  expect(input.disabled).toBe(false);
  expect(input.value).toBe(report.agenda);
  fireEvent.change(input, { target: { value: 'New meeting objective' } });
  fetchMock.mockResolvedValue(response({ report, stale: false, can_generate: true }));
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(input.value).toBe('New meeting objective');
});

it('submits an agenda with the current review identity and shows exact evidence', async () => {
  fetchMock.mockResolvedValueOnce(response({ report: null, stale: false, can_generate: true }));
  fetchMock.mockResolvedValueOnce(response({ report, stale: false, can_generate: true }));
  render(<DiscussionReview meetingId="42" />);
  fireEvent.click(screen.getByRole('button', { name: 'Discussion review' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: report.agenda } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo đánh giá thảo luận' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo đánh giá thảo luận' }));
  await screen.findByText('Phạm vi: Đúng trọng tâm');
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ agenda: report.agenda, expected_id: null });
  expect(screen.getAllByText(source.quote).length).toBeGreaterThan(0);
  expect(screen.getByText('Tương tác: Không phát hiện tín hiệu tương tác trong danh mục')).toBeTruthy();
  expect(document.querySelector('audio')?.getAttribute('src')).toBe('/api/transcripts/by-id/42/segments/a%2Fb/audio');
});

it('hides audio on stale evidence and ignores responses from a previous meeting', async () => {
  let release!: (value: unknown) => void;
  fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const view = render(<DiscussionReview meetingId="42" />);
  fireEvent.click(screen.getByRole('button', { name: 'Discussion review' }));
  fetchMock.mockResolvedValue(response({ report: null, stale: false, can_generate: false }));
  view.rerender(<DiscussionReview meetingId="43" />);
  await screen.findByText('Cần cuộc họp đã hoàn tất và có transcript để tạo đánh giá.');
  await act(async () => { release(response({ report, stale: false, can_generate: true })); });
  expect(screen.queryByText(source.quote)).toBeNull();
  fetchMock.mockResolvedValue(response({ report, stale: true, can_generate: true }));
  view.rerender(<DiscussionReview meetingId="42" />);
  await screen.findByText('Nguồn đã thay đổi hoặc chưa kiểm tra được. Hãy tải lại và tạo đánh giá mới.');
  expect(document.querySelector('audio')).toBeNull();
});

it('shows provider failures without inventing an uncertain result', async () => {
  fetchMock.mockResolvedValueOnce(response({ report: null, stale: false, can_generate: true }));
  fetchMock.mockResolvedValueOnce(response({ detail: 'Discussion review is unavailable' }, false));
  render(<DiscussionReview meetingId="42" />);
  fireEvent.click(screen.getByRole('button', { name: 'Discussion review' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Retry' } });
  await waitFor(() => expect((screen.getByRole('button', { name: 'Tạo đánh giá thảo luận' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Tạo đánh giá thảo luận' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Discussion review is unavailable');
  expect(screen.queryByText(/Phạm vi:/)).toBeNull();
});

it('supports an external Tools trigger and consumes Escape before workbench navigation', async () => {
  fetchMock.mockResolvedValue(response({ report: null, stale: false, can_generate: true }));
  const openRef: { current: (() => void) | null } = { current: null };
  const navigate = vi.fn();
  window.addEventListener('keydown', navigate);
  const view = render(<DiscussionReview meetingId="42" openRef={openRef} />);
  try {
    expect(screen.queryByRole('button', { name: 'Discussion review' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { openRef.current?.(); });
    const dialog = screen.getByRole('dialog', { name: 'Đánh giá thảo luận' });
    expect((dialog as HTMLDialogElement).open).toBe(true);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect((dialog as HTMLDialogElement).open).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  } finally { window.removeEventListener('keydown', navigate); view.unmount(); }
  expect(openRef.current).toBeNull();
});
