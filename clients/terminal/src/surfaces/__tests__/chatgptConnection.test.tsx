import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatGPTPlanConnection } from '../settings';
import { ModelChips } from '../meeting';
beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('ChatGPT account switch', () => {
  it('keeps a reconnect handoff visible when the old account is still connected', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/start')
      ? Response.json({ authorization_url: 'https://auth.openai.com/api/accounts/authorize?state=test' })
      : Response.json({ connected: true, email: 'old@example.test' }));
    render(<ChatGPTPlanConnection />);
    const reconnect = await screen.findByRole('button', { name: 'Reconnect with ChatGPT' });
    // Flush the async sign-in update and its focus effect before simulating a return
    // from the popup. Finding the input alone can precede passive-effect setup in CI.
    await act(async () => { fireEvent.click(reconnect); });
    await screen.findByLabelText('Callback URL from the other browser');
    const statusCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/status')).length;
    const before = statusCalls();
    await act(async () => { fireEvent.focus(window); });
    expect(statusCalls()).toBe(before + 1);
    expect(screen.getByText(/old@example.test/)).toBeTruthy();
    expect(screen.getByLabelText('Callback URL from the other browser')).toBeTruthy();
  });
  it('finishes a callback copied from another browser in the initiating TINA tab', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    let connected = false;
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input).endsWith('/start')) return Response.json({ authorization_url: 'https://auth.openai.com/api/accounts/authorize?state=test' });
      if (String(input).endsWith('/complete')) { connected = true; return Response.json({ connected: true }); }
      return Response.json({ connected });
    });
    render(<ChatGPTPlanConnection />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
    const input = await screen.findByLabelText('Callback URL from the other browser');
    const callback = 'http://127.0.0.1:23000/api/models/openai/callback?state=test&code=synthetic';
    fireEvent.change(input, { target: { value: callback } });
    fireEvent.click(screen.getByRole('button', { name: 'Finish connection' }));
    await screen.findByRole('button', { name: 'Reconnect with ChatGPT' });
    expect(screen.queryByLabelText('Callback URL from the other browser')).toBeNull();
    const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/complete'));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ callback_url: callback });
  });
  it('keeps a copyable sign-in link when the popup is blocked and clears it after connecting in another tab', async () => {
    const url = 'https://auth.openai.com/api/accounts/authorize?state=synthetic-test';
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.spyOn(window, 'open').mockReturnValue(null);
    let connected = false;
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/start')
      ? Response.json({ authorization_url: url }) : Response.json({ connected }));
    render(<ChatGPTPlanConnection />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
    const link = await screen.findByRole('link', { name: 'Open ChatGPT sign-in link' });
    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect((screen.getByLabelText('ChatGPT sign-in URL') as HTMLInputElement).value).toBe(url);
    fireEvent.click(screen.getByRole('button', { name: 'Copy sign-in link' }));
    await screen.findByText('Copied'); expect(writeText).toHaveBeenCalledWith(url);
    connected = true; fireEvent.focus(window);
    await screen.findByRole('button', { name: 'Reconnect with ChatGPT' });
    expect(screen.queryByRole('link', { name: 'Open ChatGPT sign-in link' })).toBeNull();
  });
  it('does not show a sign-in link when the authorization request fails', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/start')
      ? Response.json({ error: 'Unable to start sign-in' }, { status: 503 }) : Response.json({ connected: false }));
    render(<ChatGPTPlanConnection />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('ChatGPT sign-in URL')).toBeNull();
  });
  it('shows the saved account and disconnects only ChatGPT before reconnecting', async () => {
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/status')
      ? Response.json({ connected: true, email: 'old@example.test' }) : Response.json({ connected: false }));
    render(<ChatGPTPlanConnection />);
    expect(await screen.findByText(/old@example.test/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect ChatGPT' }));
    await screen.findByRole('button', { name: 'Continue with ChatGPT' });
    expect(screen.queryByText(/old@example.test/)).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([url, options]) => url === '/api/models/openai/logout' && options?.method === 'POST')).toBe(true);
  });
  it('retains the connected account when logout fails', async () => {
    vi.mocked(fetch).mockImplementation(async input => String(input).endsWith('/status') ? Response.json({ connected: true, email: 'old@example.test' }) : new Response('{}', { status: 503 }));
    render(<ChatGPTPlanConnection />); await screen.findByText(/old@example.test/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect ChatGPT' }));
    await screen.findByRole('alert'); expect(screen.getByText(/old@example.test/)).toBeTruthy();
  });
  it('distinguishes Meeting AI from ASR configuration and refreshes after account changes', async () => {
    vi.mocked(fetch).mockImplementation(async input => String(input) === '/api/models'
      ? Response.json({ chat_model: 'gpt-6-luna', streaming_model: 'gpt-6-luna', chatgpt_connected: false })
      : Response.json({ effective: { label: 'Gipformer' } }));
    render(<ModelChips />);
    await screen.findByText('Meeting AI'); await screen.findByText('Gipformer'); await screen.findByText('Connect ChatGPT in Settings');
    expect(screen.queryByText('stream')).toBeNull();
    const before = vi.mocked(fetch).mock.calls.length; window.dispatchEvent(new Event('tina-models-changed'));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(before));
  });
  it('keeps Meeting AI visible when the ASR status request fails', async () => {
    vi.mocked(fetch).mockImplementation(async input => {
      if (String(input) === '/api/models') return Response.json({ streaming_model: 'gpt-6-luna' });
      throw new Error('ASR unavailable');
    });
    render(<ModelChips />);
    await screen.findByText('gpt-6-luna');
    await screen.findByText('Unavailable');
  });
});
