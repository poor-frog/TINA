import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../models/openai/callback/route';
import { POST } from '../models/openai/complete/route';
import { POST as start } from '../models/openai/start/route';
import { POST as logout } from '../models/openai/logout/route';
import { beginChatGPTAuth, storePending, takePending } from '../../../lib/chatgptPlanAuth';

const mocks = vi.hoisted(() => ({ subject: vi.fn(), complete: vi.fn() }));
vi.mock('../../../lib/chatgptPlanAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../lib/chatgptPlanAuth')>();
  mocks.complete.mockImplementation(actual.completeChatGPTSignIn);
  return { ...actual, currentTinaSubject: mocks.subject, completeChatGPTSignIn: mocks.complete };
});
const base = 'http://127.0.0.1:23000';
afterEach(() => { vi.unstubAllEnvs(); });
beforeEach(() => {
  vi.clearAllMocks(); mocks.subject.mockResolvedValue('one');
  vi.stubEnv('TINA_TERMINAL_PUBLIC_PORT', '23000'); vi.stubEnv('TINA_OPENAI_CALLBACK_URL', '');
});
function login() {
  const { pending } = beginChatGPTAuth({ subject_id: 'one', generation: 'one', host_id: 'host',
    client_id: 'dynamic_agent_client', redirect_uri: base + '/api/models/openai/callback', ui_origin: base });
  storePending(pending);
  const url = new URL(pending.redirect_uri);
  url.search = new URLSearchParams({ state: pending.state, code: 'synthetic-code', error: 'access_denied' }).toString();
  return { pending, url };
}
function request(callback_url: string, origin = base) {
  return new NextRequest(base + '/api/models/openai/complete', { method: 'POST',
    headers: { origin, host: '127.0.0.1:23000', 'Content-Type': 'application/json' }, body: JSON.stringify({ callback_url }) });
}
describe('ChatGPT callback across browser profiles', () => {
  it('shows a copyable handoff without consuming the request when TINA is not signed in', async () => {
    const { url } = login(); mocks.subject.mockResolvedValue(null);
    const response = await GET(new NextRequest(url)); const html = await response.text();
    expect(response.status).toBe(200); expect(html).toContain('Copy callback URL');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(mocks.complete).not.toHaveBeenCalled();
    expect((await POST(request(url.toString()))).status).toBe(401);
    mocks.subject.mockResolvedValue('other');
    expect(await (await POST(request(url.toString()))).text()).toContain('another TINA user');
    mocks.subject.mockResolvedValue('one');
    expect(await (await POST(request(url.toString()))).text()).toContain('plan access was not approved');
    expect(await (await POST(request(url.toString()))).text()).toContain('already used');
  });
  it('uses the same completion flow for a signed-in browser and reports success from the manual route', async () => {
    const { url } = login();
    expect(await (await GET(new NextRequest(url))).text()).toContain('plan access was not approved');
    mocks.complete.mockResolvedValueOnce(undefined);
    const response = await POST(request(url.toString()));
    expect(await response.json()).toEqual({ connected: true });
    expect(mocks.complete).toHaveBeenLastCalledWith('one', url);
  });
  it('rejects cross-origin and unexpected callback URLs before consuming state', async () => {
    const { url, pending } = login();
    expect((await POST(request(url.toString(), 'https://other.example'))).status).toBe(403);
    expect((await POST(request(url.toString(), 'invalid'))).status).toBe(403);
    for (const invalid of ['https://other.example/callback', base + '/other', 'not a URL']) {
      expect((await POST(request(invalid))).status).toBe(400);
    }
    expect(takePending(pending.state, 'one')).not.toBeNull();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});

it.each([['start', start], ['complete', POST], ['logout', logout]] as const)(
  'blocks local ChatGPT %s in Workspace pilot mode before checking the user',
  async (path, handle) => {
    vi.stubEnv('NEXT_PUBLIC_TERMINAL_MODE', 'workspace-pilot');
    const response = await handle(new NextRequest(`${base}/api/models/openai/${path}`, { method: 'POST' }));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.subject).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  },
);
