import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ServicesProvider, createContainer, reg, CommandServiceId, createCommandService } from '../../platform';
import { LayoutServiceId, createLayoutService } from '../../workbench/layout';
import { registry } from '../../contributions';
import { Chat } from '../chat';
import { ASK_CHAT_EVENT } from '../../canvas/actions';
import * as stream from '../chatStream';
import * as api from '../workspaceApi';
import * as planned from '../plannedApi';
import type { MeetingMock } from '../meetingModel';
import '../meetingPrep';

const state = vi.hoisted(() => ({ meetings: [] as MeetingMock[] }));
vi.mock('../liveMeetings', () => ({ useLiveMeetings: () => state.meetings, refreshMeetings: vi.fn(), seedLiveMeetingFromResponse: () => undefined }));
vi.mock('../chatStream', () => ({ streamChatTurn: vi.fn(async () => ({ terminal: true, aborted: false })) }));
vi.mock('../plannedApi', async original => ({ ...await original<typeof import('../plannedApi')>(), createPlannedMeeting: vi.fn() }));
vi.mock('../workspaceApi', async original => ({ ...await original<typeof import('../workspaceApi')>(),
  listSharedMemberships: vi.fn(async () => []), listWorkspaceTree: vi.fn(async () => []),
  readActiveSet: vi.fn(), readWorkspaceFile: vi.fn(async () => null),
}));
vi.mock('../../ui-kit/MdxDoc', () => ({ MdxDoc: ({ children }: { children: string }) => <div>{children}</div> }));
let sequence = 0;
beforeEach(() => {
  state.meetings = [{ id: '77', title: 'Họp kế hoạch', title_custom: 'Họp kế hoạch', when: '', platform: 'Google Meet',
    status: 'past', live_status: 'idle', participants: [], mentioned: [], actions: [], transcript: [], insights: [] }];
  vi.mocked(api.readActiveSet).mockResolvedValue({ subject: 'owner', active: [{ slug: 'private-home', path: '/workspaces/owner', role: 'private', write: true, primary: true, repo: null, ref: null }] });
  vi.mocked(api.readWorkspaceFile).mockResolvedValue(null);
  vi.mocked(api.listWorkspaceTree).mockResolvedValue([]);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sessions: [] })));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function setup(withChat = true, draft = false) {
  const layout = createLayoutService('meetings');
  const params = draft ? { meetingId: '', draft: true } : { meetingId: '77' };
  layout.setActiveTab({ kind: 'meetingPrep', params });
  const container = createContainer([reg(LayoutServiceId, () => layout), reg(CommandServiceId, c => createCommandService(c))]);
  const Prep = registry.tabComponent('meetingPrep')!;
  render(<ServicesProvider container={container}><Prep id="prep:77" params={params} active />
    {withChat && <Chat params={{ subject: 'brief-flow', session: 'test-' + (++sequence) }} />}</ServicesProvider>);
}

it('rejects a busy chat without showing a running brief, then permits retry', async () => {
  let finish!: (value: stream.ChatStreamResult) => void;
  vi.mocked(stream.streamChatTurn).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  setup(); await screen.findByRole('button', { name: 'Start brief chat' });
  act(() => { window.dispatchEvent(new CustomEvent(ASK_CHAT_EVENT, { detail: { prompt: 'Existing request' } })); });
  await waitFor(() => expect(stream.streamChatTurn).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'Start brief chat' }));
  await screen.findByText(/Chat is busy/);
  expect(screen.queryByText(/Brief chat running/)).toBeNull();
  expect(stream.streamChatTurn).toHaveBeenCalledTimes(1);
  await act(async () => finish({ terminal: true, aborted: false, sawVisibleOutput: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Start brief chat' }));
  await waitFor(() => expect(stream.streamChatTurn).toHaveBeenCalledTimes(2));
});

it('sends an explicit meeting focus and private brief path and reads that same path', async () => {
  setup(); fireEvent.click(await screen.findByRole('button', { name: 'Start brief chat' }));
  await waitFor(() => expect(stream.streamChatTurn).toHaveBeenCalledTimes(1));
  const body = vi.mocked(stream.streamChatTurn).mock.calls[0][0];
  expect(body.prompt).toContain('/workspaces/owner/kg/entities/meeting/brief-row-77.md');
  expect(body).toMatchObject({ context: { focus: { kind: 'meeting', meeting_id: '77', status: 'idle' } } });
  vi.mocked(api.listWorkspaceTree).mockResolvedValue(['kg/entities/meeting/brief-row-77.md']);
  vi.mocked(api.readWorkspaceFile).mockResolvedValue('# Brief ready');
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await screen.findByText('# Brief ready');
  expect(api.readWorkspaceFile).toHaveBeenCalledWith('kg/entities/meeting/brief-row-77.md', { slug: 'private-home' });
});

it('does not report started when the chat handler is absent', async () => {
  setup(false); fireEvent.click(await screen.findByRole('button', { name: 'Start brief chat' }));
  await screen.findByText(/Chat is unavailable/);
  expect(screen.queryByText(/Brief chat running/)).toBeNull();
});

it('pins newly created draft meeting identity before the live meeting store refreshes', async () => {
  state.meetings = [];
  vi.mocked(planned.createPlannedMeeting).mockResolvedValue({ id: 88, platform: 'google_meet', native_meeting_id: 'abc-defg-hij', status: 'idle', data: { title: 'New plan' } });
  setup(true, true);
  fireEvent.change(await screen.findByPlaceholderText("What's this meeting about?"), { target: { value: 'New plan' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start brief chat' }));
  await waitFor(() => expect(stream.streamChatTurn).toHaveBeenCalledTimes(1));
  const body = vi.mocked(stream.streamChatTurn).mock.calls[0][0];
  expect(body).toMatchObject({ context: { focus: { kind: 'meeting', meeting_id: '88', native_id: 'abc-defg-hij', status: 'idle' } } });
  expect(body.prompt).toContain('/workspaces/owner/kg/entities/meeting/brief-abc-defg-hij.md');
});

it('refuses a private brief when only shared workspaces are active', async () => {
  vi.mocked(api.readActiveSet).mockResolvedValue({ subject: 'owner', active: [{ slug: 'team', path: '/workspaces/team', role: 'shared', write: true, primary: false, repo: null, ref: null }] });
  setup(); fireEvent.click(await screen.findByRole('button', { name: 'Start brief chat' }));
  await screen.findByText(/Enable a private writable workspace before starting a private brief/);
  expect(stream.streamChatTurn).not.toHaveBeenCalled();
});

it('reuses a legacy brief in its private workspace instead of writing a second one in the new home', async () => {
  vi.mocked(api.readActiveSet).mockResolvedValue({ subject: 'owner', active: [
    { slug: 'new-home', path: '/workspaces/new-home', role: 'private', write: true, primary: true, repo: null, ref: null },
    { slug: 'original', path: '/workspaces/original', role: 'private', write: true, primary: false, repo: null, ref: null },
  ] });
  vi.mocked(api.listWorkspaceTree).mockImplementation(async opts => opts?.slug === 'original' ? ['kg/entities/meeting/hop-ke-hoach.md'] : []);
  vi.mocked(api.readWorkspaceFile).mockResolvedValue('# Existing private brief');
  setup(); await screen.findByText('# Existing private brief');
  fireEvent.click(screen.getByTitle('Steer the brief in chat'));
  await waitFor(() => expect(stream.streamChatTurn).toHaveBeenCalledTimes(1));
  expect(vi.mocked(stream.streamChatTurn).mock.calls[0][0].prompt).toContain('/workspaces/original/kg/entities/meeting/hop-ke-hoach.md');
});

it('refreshes shared README content on focus and keeps it visible during read errors', async () => {
  state.meetings[0].workspace_id = 'team'; setup(false);
  await screen.findByText('No brief yet.');
  vi.mocked(api.readWorkspaceFile).mockResolvedValue('# Shared brief ready');
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await screen.findByText('# Shared brief ready');
  vi.mocked(api.readWorkspaceFile).mockRejectedValue(new Error('Read failed'));
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  await screen.findByRole('alert');
  expect(screen.getByText('# Shared brief ready')).toBeTruthy();
});

it('polls a shared brief while visible without requiring a page reload', async () => {
  state.meetings[0].workspace_id = 'team'; setup(false);
  await screen.findByText('No brief yet.');
  vi.mocked(api.readWorkspaceFile).mockResolvedValue('# Shared brief via timer');
  // Capture the actual registered polling callback rather than waiting twelve seconds in this test.
  const timer = vi.spyOn(window, 'setInterval');
  cleanup(); setup(false);
  await screen.findByText('# Shared brief via timer');
  const callback = timer.mock.calls.find(([, delay]) => delay === 12000)?.[0];
  expect(typeof callback).toBe('function');
  vi.mocked(api.readWorkspaceFile).mockResolvedValue('# Shared brief updated again');
  await act(async () => { (callback as () => void)(); });
  await screen.findByText('# Shared brief updated again');
  timer.mockRestore();
});
