import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WorkspaceContentSearch } from '../WorkspaceContentSearch';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('searches authorized mounted workspaces and opens the matching workspace', async () => {
  const fetch = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ bounded: false,
    hits: url.includes('slug=shared') ? [{ path: 'wiki/budget.md', line: 3, text: 'Budget approved' }] : [] }) }));
  vi.stubGlobal('fetch', fetch);
  const open = vi.fn();
  render(<WorkspaceContentSearch mounts={[{ slug: 'home' }, { slug: 'shared', name: 'Team' }]} onOpen={open} />);
  fireEvent.click(screen.getByText('Search within content'));
  fireEvent.change(screen.getByLabelText('Search file contents'), { target: { value: 'budget' } });
  fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Team, wiki\/budget\.md, line 3/i }));
  expect(open).toHaveBeenCalledWith('wiki/budget.md', 'shared');
  expect(fetch).toHaveBeenCalledTimes(2);
});
