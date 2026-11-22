export const ACCOUNT_KEY = 'tinaExtensionAccount';
export const SESSION_MESSAGE = 'tina-extension-session';
export const DEFAULT_GATEWAY = 'https://tinabot.duckdns.org/extension-api';
export const DEFAULT_TERMINAL = 'https://tinabot.duckdns.org';
export const OAUTH_VALUE = /^[A-Za-z0-9_-]{43}$/;

export interface ExtensionAccount { id: string; email: string; key: string; gateway: string; terminal: string }

export function sessionEndpoints(terminal: string, gateway: string): { terminal: string; gateway: string } {
  const urls = [terminal, gateway].map(value => new URL(value.trim()));
  const [web, api] = urls;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(web.hostname) && web.hostname === api.hostname;
  if (urls.some(url => url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)))
      || (web.origin !== api.origin && !loopback)) {
    throw new Error('TINA Terminal and Gateway must use the same HTTPS origin or the same loopback address.');
  }
  return { terminal: web.href.replace(/\/+$/, ''), gateway: api.href.replace(/\/+$/, '') };
}

type SessionCommand =
  | { action: 'login'; terminal: string; gateway: string }
  | { action: 'login-api-key'; terminal: string; gateway: string; apiKey: string }
  | { action: 'logout'; key: string }
  | { action: 'access'; key: string; gateway: string; rejected?: string };

export interface SessionResult { token?: string; apiKey?: boolean }

export async function sessionCommand(command: SessionCommand): Promise<SessionResult> {
  const runtime = (globalThis as typeof globalThis & {
    chrome?: { runtime?: { sendMessage: (message: object) => Promise<SessionResult & { ok?: boolean; error?: string }> } };
  }).chrome?.runtime;
  const result = await runtime?.sendMessage({ source: SESSION_MESSAGE, ...command });
  if (!result?.ok) throw new Error(result?.error || 'Could not connect to your TINA session.');
  return result;
}

export function storedAccount(value: unknown): ExtensionAccount | undefined {
  if (!value || typeof value !== 'object') return;
  const account = value as Partial<ExtensionAccount>;
  if (typeof account.id === 'string' && /^[1-9]\d*$/.test(account.id)
      && typeof account.email === 'string' && typeof account.key === 'string' && OAUTH_VALUE.test(account.key)
      && typeof account.gateway === 'string' && typeof account.terminal === 'string') return account as ExtensionAccount;
}

export function authorizationCode(url: URL, target: URL, state: string): string | undefined {
  if (url.origin !== target.origin || url.pathname !== target.pathname || url.search) return;
  const params = new URLSearchParams(url.hash.slice(1));
  const code = params.get('code');
  if (params.get('state') === state && code && OAUTH_VALUE.test(code)) return code;
}
