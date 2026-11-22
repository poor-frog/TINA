import { ACCOUNT_KEY, SESSION_MESSAGE, OAUTH_VALUE, authorizationCode, sessionEndpoints, type ExtensionAccount, type SessionResult } from './extension-session';

// Reset the previous toolbar behavior when an existing installation updates.
void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }).catch(() => {});
void chrome.action?.setPopup?.({ popup: 'welcome.html' }).catch(() => {});

interface Session { account: ExtensionAccount; access: string; refresh: string; expires: number }
type StoredSession = Session | { account: ExtensionAccount; apiKey: string };
interface LoginFlow { terminal: string; gateway: string; state: string; verifier: string; expires: number; tabId?: number }
const FLOW_KEY = 'tinaExtensionLogin';
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}

// The credential store is on the extension origin, including when a Meet content script is present.
function credential(next?: StoredSession | null): Promise<StoredSession | undefined> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tina-extension-session', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('session');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('session', next === undefined ? 'readonly' : 'readwrite');
      const store = tx.objectStore('session');
      const operation = next === undefined ? store.get('current') : next === null
        ? store.delete('current') : store.put(next, 'current');
      tx.oncomplete = () => { db.close(); resolve(operation.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

function encode(buffer: Uint8Array): string {
  return btoa(String.fromCharCode(...buffer)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const randomValue = () => encode(crypto.getRandomValues(new Uint8Array(32)));

class SessionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function requestSession(terminal: string, action: 'exchange' | 'refresh' | 'logout',
  value: string, verifier?: string): Promise<any> {
  const response = await fetch(`${terminal}/api/auth/extension/${action}`, {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ credential: value, ...(verifier && { verifier }) }),
  });
  if (!response.ok) throw new SessionError(response.status, response.status === 401
    ? 'Your TINA session has expired. Sign in again.'
    : 'The TINA server did not accept the extension connection.');
  return response.json();
}

function parseSession(result: any, endpoints: { gateway: string; terminal: string }, key: string): Session {
  if (typeof result?.access_token !== 'string' || !OAUTH_VALUE.test(result.access_token)
      || typeof result.refresh_token !== 'string' || !OAUTH_VALUE.test(result.refresh_token)
      || typeof result.user?.id !== 'string' || !/^[1-9]\d*$/.test(result.user.id)
      || typeof result.user.email !== 'string'
      || !Number.isSafeInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 900) {
    throw new Error('The server returned an invalid TINA session.');
  }
  return { account: { ...endpoints, id: result.user.id, email: result.user.email, key },
    access: result.access_token, refresh: result.refresh_token, expires: Date.now() + result.expires_in * 1000 };
}

async function clearSession() {
  await credential(null);
  await chrome.storage.local.remove(ACCOUNT_KEY);
}

async function saveSession(session: StoredSession) {
  await credential(session);
  try {
    await chrome.storage.local.set({ [ACCOUNT_KEY]: session.account });
  } catch (error) {
    await credential(null);
    throw error;
  }
}

async function connectApiKey(terminal: string, gateway: string, rawKey: string) {
  if (await credential()) throw new Error('Sign out before connecting a different account.');
  const endpoints = sessionEndpoints(terminal, gateway);
  const apiKey = rawKey.trim();
  if (!/^[\x21-\x7E]{1,255}$/.test(apiKey)) throw new Error('Enter a valid TINA API key.');
  const response = await fetch(`${endpoints.gateway}/auth/me`, {
    headers: { 'X-API-Key': apiKey }, credentials: 'omit', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => { throw new Error('Could not reach the TINA Gateway. Check the address and try again.'); });
  if (response.status === 401 || response.status === 403) throw new Error('This API key was rejected by the TINA Gateway.');
  if (!response.ok) throw new Error('The TINA Gateway could not verify this API key.');
  const identity = await response.json().catch(() => null);
  const id = identity?.user_id;
  if (!((typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
      || (typeof id === 'string' && /^[1-9]\d*$/.test(id))) || typeof identity.email !== 'string' || !identity.email) {
    throw new Error('The TINA Gateway returned an invalid account.');
  }
  if (!Array.isArray(identity.scopes) || !identity.scopes.includes('tx')) {
    throw new Error('This API key needs transcript access (tx) to list meetings.');
  }
  await chrome.storage.session.remove(FLOW_KEY);
  await saveSession({ account: { ...endpoints, id: String(id), email: identity.email, key: randomValue() }, apiKey });
}

async function finishLogin(flow: LoginFlow, url: string, target: URL) {
  const pending = (await chrome.storage.session.get(FLOW_KEY))[FLOW_KEY] as LoginFlow | undefined;
  const code = authorizationCode(new URL(url), target, flow.state);
  if (!code || pending?.state !== flow.state || flow.expires <= Date.now()) {
    throw new Error('This TINA sign-in request has expired or no longer matches. Try signing in again.');
  }
  const result = await requestSession(flow.terminal, 'exchange', code, flow.verifier);
  const session = parseSession(result, { terminal: flow.terminal, gateway: flow.gateway }, randomValue());
  await saveSession(session);
  await chrome.storage.session.remove(FLOW_KEY);
}

async function startLogin(terminal: string, gateway: string) {
  if (await credential()) throw new Error('Sign out before connecting a different account.');
  const endpoints = sessionEndpoints(terminal, gateway);
  const flow = { ...endpoints, state: randomValue(), verifier: randomValue(), expires: Date.now() + 10 * 60_000 };
  const challenge = encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(flow.verifier))));
  const start = new URL(`${flow.terminal}/connect-extension`);
  start.search = new URLSearchParams({ extension: chrome.runtime.id, challenge, state: flow.state }).toString();
  await chrome.storage.session.set({ [FLOW_KEY]: flow });

  const identity = chrome.identity;
  if (typeof identity?.launchWebAuthFlow === 'function' && typeof identity.getRedirectURL === 'function') {
    let callback: string | undefined;
    try {
      callback = await identity.launchWebAuthFlow({ url: start.href, interactive: true });
    } catch (error) {
      if (!/not supported|not implemented|unavailable/i.test(error instanceof Error ? error.message : String(error))) {
        await chrome.storage.session.remove(FLOW_KEY);
        throw new Error('The sign-in window was closed. Try again.');
      }
    }
    if (callback) {
      await finishLogin(flow, callback, new URL(identity.getRedirectURL('tina')));
      return;
    }
  }
  // Embedded Chromium browsers may expose tabs but lack the interactive identity API.
  start.searchParams.set('mode', 'tab');
  const tab = await chrome.tabs.create({ url: start.href });
  await chrome.storage.session.set({ [FLOW_KEY]: { ...flow, tabId: tab.id } });
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.url?.includes('/connect-extension#')) return;
  const url = change.url;
  void serialize(async () => {
    const flow = (await chrome.storage.session.get(FLOW_KEY))[FLOW_KEY] as LoginFlow | undefined;
    if (!flow || flow.tabId !== tabId) return;
    await finishLogin(flow, url, new URL(`${flow.terminal}/connect-extension`));
    await chrome.tabs.remove(tabId).catch(() => {});
  }).catch(() => {});
});

async function handle(message: any): Promise<SessionResult> {
  if (message.action === 'login' && typeof message.terminal === 'string' && typeof message.gateway === 'string') {
    await startLogin(message.terminal, message.gateway);
    return {};
  }
  if (message.action === 'login-api-key' && typeof message.terminal === 'string'
      && typeof message.gateway === 'string' && typeof message.apiKey === 'string') {
    await connectApiKey(message.terminal, message.gateway, message.apiKey);
    return {};
  }
  const current = await credential();
  if (!current || current.account.key !== message.key) {
    if (!current) await clearSession();
    throw new Error('Sign in to TINA to continue.');
  }
  if (message.action === 'logout') {
    try {
      if (!('apiKey' in current)) await requestSession(current.account.terminal, 'logout', current.refresh);
    }
    finally { await clearSession(); }
    return {};
  }
  if (message.action !== 'access' || current.account.gateway !== message.gateway) {
    throw new Error('Invalid TINA session request.');
  }
  if ('apiKey' in current) return { token: current.apiKey, apiKey: true };
  if (Date.now() + 30_000 < current.expires && message.rejected !== current.access) return { token: current.access };
  try {
    const result = await requestSession(current.account.terminal, 'refresh', current.refresh);
    const next = parseSession(result, { terminal: current.account.terminal, gateway: current.account.gateway }, current.account.key);
    if (next.account.id !== current.account.id) throw new SessionError(401, 'Your TINA account no longer matches the session.');
    await credential(next);
    return { token: next.access };
  } catch (error) {
    if (error instanceof SessionError && error.status === 401) await clearSession();
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, send) => {
  const ownPage = sender.id === chrome.runtime.id && typeof sender.url === 'string'
    && ['meet-panel.html', 'sidepanel.html', 'welcome.html'].some(path => sender.url!.split(/[?#]/, 1)[0] === chrome.runtime.getURL(path));
  if (!ownPage || message?.source !== SESSION_MESSAGE) return;
  void serialize(() => handle(message)).then(value => send({ ok: true, ...value }),
    error => send({ ok: false, error: error instanceof Error ? error.message : 'Could not connect to TINA.' }));
  return true;
});
