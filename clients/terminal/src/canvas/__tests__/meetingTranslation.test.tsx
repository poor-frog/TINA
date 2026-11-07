import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LiveTranscriptEngine } from "../LiveTranscriptEngine";
import { TranslationControls, useMeetingTranslation, type TranscriptLanguage, type TranslationSnapshot } from "../MeetingTranslation";
import { useState } from "react";
import { projectTranslationGroups, type TranslationGroup } from "../translationGroups";

function group(members: TranslationGroup['members'], translated_text: string | null, ready = true): TranslationGroup {
  return { group_id: `phrase:${members[0].segment_id}`, members, source_text: members.map(m => m.source_text).join(' '),
    translated_text, ready, speaker_id: 'nam', speaker_name: 'Nam', start_ms: 0, end_ms: 2000 };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("pairs translations with exact source text and retains Vietnamese on errors, drafts and edits", () => {
  const segments = [{ id: "s1", text: "Xin chào.", speaker: "Nam" }, { id: "s2", text: "Vừa sửa." }, { id: "draft", text: "Đang nói", completed: false }];
  const groups = [group([{ segment_id: 's1', source_text: 'Xin chào.' }], 'Hello.'),
    group([{ segment_id: 's2', source_text: 'Bản cũ.' }], 'Stale English.')];
  const paired = projectTranslationGroups(segments, groups);
  const view = render(<LiveTranscriptEngine segments={paired} language="bilingual" translationPaused />);
  expect(screen.getByText("Xin chào.")).toBeTruthy();
  expect(screen.getByText("Hello.")).toBeTruthy();
  expect(screen.getByText("Vừa sửa.")).toBeTruthy();
  expect(screen.queryByText("Stale English.")).toBeNull();
  expect(screen.getByText("Đang nói")).toBeTruthy();
  view.rerender(<LiveTranscriptEngine segments={paired} language="en" translationPaused />);
  expect(screen.queryByText("Xin chào.")).toBeNull();
  expect(screen.getByText("Vừa sửa.")).toBeTruthy();
});

function Viewer({ meeting = "6" }: { meeting?: string }) {
  const [language, setLanguage] = useState<TranscriptLanguage>("vi");
  const state = useMeetingTranslation(meeting, language);
  return <><TranslationControls language={language} onChange={setLanguage} snapshot={state.snapshot} error={state.error} onRetry={state.retry} />
    {state.snapshot?.groups.map(row => <p key={row.group_id}>{row.translated_text}</p>)}</>;
}

it("does not infer in the original view; bilingual advances through the shared cache", async () => {
  let completed = false;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") completed = true;
    return Response.json({ version: 'meeting-translation.v2', meeting_id: 6, status: completed ? "complete" : "pending", total: 1, completed: Number(completed), retry_after: 0,
      groups: [group([{ segment_id: 's1', source_text: 'Xin chào.' }], completed ? 'Hello.' : null)] });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<Viewer />);
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("combobox", { name: "Transcript language" }), { target: { value: "bilingual" } });
  await waitFor(() => expect(screen.getByText("Hello.")).toBeTruthy());
  expect(fetcher.mock.calls.some(([url, init]) => url === "/api/meeting-translations/6" && init?.method === "POST")).toBe(true);
});

it("offers retry on API failure without hiding the language controls", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 503 })));
  render(<Viewer />);
  fireEvent.change(screen.getByRole("combobox", { name: "Transcript language" }), { target: { value: "en" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Thử lại" })).toBeTruthy());
  expect(screen.getByRole("option", { name: "No Translate · Bản gốc" })).toBeTruthy();
});

it("clears the previous meeting's translations when navigating to another meeting", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith("/7")) return Response.json({}, { status: 404 });
    return Response.json({ version: 'meeting-translation.v2', meeting_id: 6, status: "complete", total: 1, completed: 1, retry_after: 0,
      groups: [group([{ segment_id: 's1', source_text: 'Xin chào.' }], 'Private meeting six')] });
  }));
  const view = render(<Viewer />);
  fireEvent.change(screen.getByRole("combobox", { name: "Transcript language" }), { target: { value: "bilingual" } });
  await waitFor(() => expect(screen.getByText("Private meeting six")).toBeTruthy());
  view.rerender(<Viewer meeting="7" />);
  expect(screen.queryByText("Private meeting six")).toBeNull();
});

it('renders one bilingual phrase for multiple fragments and keeps playback linked to its first source', () => {
  const segments = [{ id: 'a', text: 'Mục tiêu', speaker: 'Nam' }, { id: 'b', text: 'là tối ưu mô hình.', speaker: 'Nam' }];
  const groups = [group(segments.map(s => ({ segment_id: s.id, source_text: s.text })), 'The goal is to optimize the model.')];
  const onPlay = vi.fn();
  render(<LiveTranscriptEngine segments={projectTranslationGroups(segments, groups)} language="bilingual"
    onSegmentClick={onPlay} playableSegmentIds={new Set(['a', 'b'])} />);
  expect(screen.getAllByText('The goal is to optimize the model.')).toHaveLength(1);
  expect(screen.getByText('Mục tiêu là tối ưu mô hình.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Play transcript segment' }));
  expect(onPlay).toHaveBeenCalledWith('a');
});

it('invalidates the whole English phrase when one source member changes', () => {
  const groups = [group([{ segment_id: 'a', source_text: 'Mục tiêu' }, { segment_id: 'b', source_text: 'là tối ưu.' }], 'Old translation')];
  const segments = [{ id: 'a', text: 'Mục tiêu' }, { id: 'b', text: 'đã được sửa.' }];
  render(<LiveTranscriptEngine segments={projectTranslationGroups(segments, groups)} language="en" />);
  expect(screen.queryByText('Old translation')).toBeNull();
  expect(screen.getByText('đã được sửa.')).toBeTruthy();
});

it('shows the growing Vietnamese phrase while the backend waits for a boundary', () => {
  const groups = [group([{ segment_id: 'a', source_text: 'Tiếp theo' }, { segment_id: 'b', source_text: 'là mô hình' }], null, false)];
  render(<LiveTranscriptEngine segments={projectTranslationGroups([{ id: 'a', text: 'Tiếp theo' }, { id: 'b', text: 'là mô hình' }], groups)} language="bilingual" />);
  expect(screen.getByText('Tiếp theo là mô hình')).toBeTruthy();
  expect(screen.getByText('Đang gom câu…')).toBeTruthy();
});

it('keeps new translations advancing while a failed phrase waits independently', async () => {
  const state: TranslationSnapshot = { version: 'meeting-translation.v2', meeting_id: 6, status: 'pending',
    total: 2, completed: 0, retry_after: 0, can_advance: true, groups: [
      { ...group([{ segment_id: 'a', source_text: 'Câu bị lỗi.' }], null), status: 'retrying', retry_after: 15 },
      { ...group([{ segment_id: 'b', source_text: 'Câu mới.' }], null), status: 'pending' },
    ] };
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(init?.method === 'POST'
    ? { ...state, status: 'paused', completed: 1, can_advance: false, retry_after: 15,
        groups: [state.groups[0], { ...state.groups[1], status: 'complete', translated_text: 'New sentence.' }] } : state));
  vi.stubGlobal('fetch', fetcher);
  render(<Viewer />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Transcript language' }), { target: { value: 'bilingual' } });
  await waitFor(() => expect(screen.getByText('New sentence.')).toBeTruthy());
  expect(screen.getByRole('status').textContent).toContain('1 cụm chờ thử lại');
  expect(screen.getByRole('button', { name: 'Thử lại' })).toBeTruthy();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('does not automatically post exhausted phrases, but explicit retry can recover them', async () => {
  const failed = { ...group([{ segment_id: 'a', source_text: 'Câu bị lỗi.' }], null), status: 'failed' };
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const retry = init?.method === 'POST' && JSON.parse(String(init.body)).retry;
    return Response.json({ version: 'meeting-translation.v2', meeting_id: 6, status: retry ? 'complete' : 'paused',
      total: 1, completed: retry ? 1 : 0, retry_after: retry ? 0 : 300, can_advance: false,
      groups: [retry ? { ...failed, status: 'complete', translated_text: 'Recovered.' } : failed] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<Viewer />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Transcript language' }), { target: { value: 'en' } });
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 cụm cần thử lại'));
  expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
  await waitFor(() => expect(screen.getByText('Recovered.')).toBeTruthy());
});

it('shows provider quota and authentication recovery hints without replacing the transcript', () => {
  const snapshot: TranslationSnapshot = { version: 'meeting-translation.v2', meeting_id: 6, status: 'paused',
    total: 1, completed: 0, retry_after: 15, can_advance: false, service_error: 'rate_limit', groups: [] };
  const controls = <TranslationControls language="bilingual" onChange={vi.fn()} error="" onRetry={vi.fn()} snapshot={snapshot} />;
  const view = render(controls);
  expect(screen.getByRole('status').textContent).toContain('API đang giới hạn lượt gọi');
  view.rerender(<TranslationControls language="bilingual" onChange={vi.fn()} error="" onRetry={vi.fn()}
    snapshot={{ ...snapshot, service_error: 'auth' }} />);
  expect(screen.getByRole('status').textContent).toContain('kiểm tra khóa trong Settings → Models');
});

it('retains original text and identifies phrases waiting for retry or requiring manual retry', () => {
  const groups: TranslationGroup[] = [
    { ...group([{ segment_id: 'a', source_text: 'Chờ dịch lại.' }], null), status: 'retrying' },
    { ...group([{ segment_id: 'b', source_text: 'Cần thử lại.' }], null), status: 'failed' },
  ];
  render(<LiveTranscriptEngine language="en" segments={projectTranslationGroups([
    { id: 'a', text: 'Chờ dịch lại.' }, { id: 'b', text: 'Cần thử lại.' },
  ], groups)} />);
  expect(screen.getByText('Chờ dịch lại.')).toBeTruthy();
  expect(screen.getByText('Cần thử lại.')).toBeTruthy();
  expect(screen.getByText('Đoạn này đang chờ thử lại…')).toBeTruthy();
  expect(screen.getByText('Chưa dịch được đoạn này · bấm Thử lại')).toBeTruthy();
});

it('rejects same-text translations from a previous canonical revision', () => {
  const groups = [group([{ segment_id: 'a', source_text: 'Xin chào.', revision: 0 }], 'Stale English')];
  expect(projectTranslationGroups([{ id: 'a', text: 'Xin chào.', revision: 1 }], groups)[0].translation).toBeUndefined();
});
