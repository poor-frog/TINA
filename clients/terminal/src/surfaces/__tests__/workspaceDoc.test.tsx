import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ASK_CHAT_EVENT, type AskChatDetail } from '../../canvas/actions';
import { ServicesProvider, createContainer, reg } from '../../platform';
import { LayoutServiceId, createLayoutService } from '../../workbench/layout';
import { registry } from '../../contributions';
import * as api from '../workspaceApi';
import '../workspace';

vi.mock('../workspaceApi', async (original) => ({
  ...(await original<typeof import('../workspaceApi')>()), readWorkspaceFile: vi.fn(), readActiveSet: vi.fn(),
}));
vi.mock('../../ui-kit/MdxDoc', () => ({ MdxDoc: ({ children }: { children: string }) => <div>{children}</div> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('researches the document in its exact active mount with an explicit save request', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.mocked(api.readWorkspaceFile).mockResolvedValue('REPO_SOURCE');
  vi.mocked(api.readActiveSet).mockResolvedValue({ subject: 'u', active: [{
    slug: 'repo', path: '/workspaces/.attached/u/repo', role: 'private', write: true,
    primary: false, repo: 'https://github.com/example/repo', ref: 'main',
  }] });
  let received: AskChatDetail | undefined;
  const accept = (event: Event) => { received = (event as CustomEvent<AskChatDetail>).detail; received.onAccepted?.(); };
  window.addEventListener(ASK_CHAT_EVENT, accept);
  try {
    const Comp = registry.tabComponent('doc')!;
    const container = createContainer([reg(LayoutServiceId, () => createLayoutService('files'))]);
    render(<ServicesProvider container={container}><Comp id="doc:repo" params={{ path: 'docs/design.md', slug: 'repo' }} active /></ServicesProvider>);
    await screen.findByText('REPO_SOURCE');
    fireEvent.click(screen.getByRole('button', { name: 'Research & save' }));
    await waitFor(() => expect(received?.research).toBe(true));
    expect(received?.prompt).toContain('/workspaces/.attached/u/repo/docs/design.md');
  } finally { window.removeEventListener(ASK_CHAT_EVENT, accept); }
});

it.each(['initial', 'focus'])('ignores a late %s read after switching documents', async (kind) => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  let finishOld!: (value: string) => void;
  const pending = new Promise<string>(resolve => { finishOld = resolve; });
  vi.mocked(api.readWorkspaceFile).mockImplementation((path) => path === 'notes/b.md'
    ? Promise.resolve('CONTENT_B') : pending);
  if (kind === 'focus') vi.mocked(api.readWorkspaceFile).mockResolvedValueOnce('CONTENT_A');
  const Comp = registry.tabComponent('doc')!;
  const container = createContainer([reg(LayoutServiceId, () => createLayoutService('files'))]);
  const view = render(<ServicesProvider container={container}><Comp id="doc:preview" params={{ path: 'notes/a.md' }} active /></ServicesProvider>);
  if (kind === 'focus') {
    await screen.findByText('CONTENT_A');
    window.dispatchEvent(new Event('focus'));
  }
  await waitFor(() => expect(api.readWorkspaceFile).toHaveBeenCalledWith('notes/a.md', undefined));
  view.rerender(<ServicesProvider container={container}><Comp id="doc:preview" params={{ path: 'notes/b.md' }} active /></ServicesProvider>);
  await screen.findByText('CONTENT_B');
  await act(async () => finishOld('OLD_RESPONSE'));
  expect(screen.getByText('b.md')).toBeTruthy();
  expect(screen.getByText('CONTENT_B')).toBeTruthy();
  expect(screen.queryByText('OLD_RESPONSE')).toBeNull();
});


it('does not repeat a frontmatter title when the Markdown body starts with the same heading', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.mocked(api.readWorkspaceFile).mockResolvedValue('---\ntype: company\nid: acme\ntitle: Acme Corp\n---\n# Acme Corp\nCompany notes.');
  const Comp = registry.tabComponent('doc')!;
  const container = createContainer([reg(LayoutServiceId, () => createLayoutService('files'))]);
  render(<ServicesProvider container={container}><Comp id="doc:company" params={{ path: 'kg/entities/company/acme.md' }} active /></ServicesProvider>);

  expect(await screen.findByText(/# Acme Corp/)).toBeTruthy();
  expect(screen.queryByText('title', { selector: 'dt' })).toBeNull();
  expect(screen.getByText('type', { selector: 'dt' })).toBeTruthy();
});

it('shows a recoverable document load error and retries the active path', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() });
  vi.mocked(api.readWorkspaceFile).mockRejectedValueOnce(new Error('Workspace API unavailable'))
    .mockResolvedValue('RECOVERED_DOCUMENT');
  const Comp = registry.tabComponent('doc')!;
  const container = createContainer([reg(LayoutServiceId, () => createLayoutService('files'))]);
  render(<ServicesProvider container={container}><Comp id="doc:retry" params={{ path: 'docs/retry.md' }} active /></ServicesProvider>);

  expect(await screen.findByRole('heading', { name: 'Document couldn’t be opened' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('RECOVERED_DOCUMENT')).toBeTruthy();
});
