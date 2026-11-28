/**
 * session-store — persist & retrieve a browser session (cookies / Local Storage /
 * Login Data) so a login done once survives across browser launches.
 *
 * Two backends, one auth-essential manifest:
 *   - S3   (syncBrowserDataFromS3 / syncBrowserDataToS3) — the production path,
 *          shells out to the `aws` CLI. Carved verbatim from tina-bot/s3-sync.ts.
 *   - local (loadSessionLocal / saveSessionLocal) — fs copy to/from a named dir,
 *          for desktop/dev with no S3 creds.
 *
 * The Chromium *persistent context* profile dir (BROWSER_DATA_DIR) IS the live
 * session; these helpers just copy the auth-essential subset of it in/out of a
 * durable store. Cache/GPU/IndexedDB junk is excluded — ~200KB, not the full profile.
 */
import { execFileSync, spawn } from 'child_process';
import { createHash, createHmac } from 'crypto';
import { existsSync, unlinkSync, mkdirSync, cpSync, mkdtempSync, rmSync, readdirSync, readlinkSync, statSync, readFileSync } from 'fs';
import { mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { join, dirname, basename, resolve, sep } from 'path';

export const BROWSER_DATA_DIR = process.env.BROWSER_DATA_DIR || '/tmp/browser-data';

/**
 * A fresh, caller-owned Chromium profile dir: `${BROWSER_DATA_DIR}-XXXXXX`.
 *
 * Concurrent browsers MUST NOT share a profile dir: Chromium takes a SingletonLock on it,
 * and a second launch against a locked dir prints "Opening in existing browser session."
 * and exits — every bot after the first dies <1s (#478). Anything that may launch more
 * than one browser per filesystem (process-mode bots in tina-lite) gets its dir from here
 * and removes it with removeProfileDir() on teardown.
 */
export function makeEphemeralProfileDir(): string {
  mkdirSync(dirname(BROWSER_DATA_DIR), { recursive: true });
  sweepStaleProfileDirs();
  return mkdtempSync(`${BROWSER_DATA_DIR}-`);
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Remove sibling ephemeral profile dirs whose browser is gone. A workload killed hard
 * (runtime stop = SIGKILL) never runs its close() cleanup, so each launch sweeps instead:
 * Chromium's SingletonLock is a symlink to `<host>-<pid>` — dead pid ⇒ stale dir; no lock
 * at all ⇒ stale after 1h (browser never launched, or launched+closed cleanly elsewhere).
 * Best-effort by design: pid reuse just defers removal to a later sweep.
 */
export function sweepStaleProfileDirs(): void {
  const parent = dirname(BROWSER_DATA_DIR);
  const prefix = `${basename(BROWSER_DATA_DIR)}-`;
  let names: string[];
  try { names = readdirSync(parent).filter((n) => n.startsWith(prefix)); } catch { return; }
  for (const n of names) {
    const p = join(parent, n);
    try {
      let stale: boolean;
      try {
        const pid = Number(readlinkSync(join(p, 'SingletonLock')).split('-').pop());
        stale = !(pid > 0 && pidAlive(pid));
      } catch {
        stale = Date.now() - statSync(p).mtimeMs > 60 * 60 * 1000;
      }
      if (stale) rmSync(p, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
}

/** Best-effort removal of a profile dir created by makeEphemeralProfileDir(). */
export function removeProfileDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

export const BROWSER_CACHE_EXCLUDES = [
  '*/Cache/*', '*/Code Cache/*', '*/GrShaderCache/*', '*/ShaderCache/*', '*/GraphiteDawnCache/*',
  '*/Service Worker/*', '*BrowserMetrics*',
  'SingletonLock', 'SingletonCookie', 'SingletonSocket',
  '*/GPUCache/*', '*/DawnGraphiteCache/*', '*/DawnWebGPUCache/*',
  '*/blob_storage/*', '*/File System/*', '*/IndexedDB/*',
];

export interface S3Config {
  userdataS3Path?: string;
  s3Endpoint?: string;
  s3Bucket?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
}

// The auth-essential subset of a Chromium profile — cookies, localStorage, login
// data, prefs. Shared by both the S3 and local backends so they persist the same
// bits. ~200KB total (vs minutes for a full-profile sync).
const AUTH_ESSENTIAL_FILES = [
  'Local State',
  'Default/Cookies',
  'Default/Cookies-journal',
  'Default/Preferences',
  'Default/Secure Preferences',
  'Default/Login Data',
  'Default/Login Data-journal',
  'Default/Login Data For Account',
  'Default/Login Data For Account-journal',
  'Default/Network Persistent State',
  'Default/Web Data',
];

const AUTH_ESSENTIAL_DIRS = [
  'Default/Local Storage',
  'Default/Session Storage',
];

// ── S3 backend (production) ───────────────────────────────────────────────

/**
 * A typed, attributed S3-session-sync failure. The restore half THROWS this (an authenticated
 * bot whose session cannot be restored must fail loud with the step named — never die on an
 * unattributed exec, never silently join signed-out); the save half only WARNS (teardown
 * must never hang or fail the exit on a flaky upload — the durable copy simply stays at the
 * last restore).
 */
export class SessionSyncError extends Error {
  constructor(
    public readonly step: 'session-restore' | 'session-save',
    detail: string,
    public readonly cause?: unknown,
  ) {
    super(`[session-store] ${step} failed: ${detail}`);
    this.name = 'SessionSyncError';
  }
}

/** Attribute an `aws` exec failure: a missing CLI (ENOENT / 127) is named as such —
 *  the deployment's image must ship the aws CLI — anything else carries the exit status. */
function describeAwsFailure(err: any): string {
  const status = err?.status ?? err?.code;
  if (status === 127 || err?.code === 'ENOENT') {
    return 'aws CLI not found on PATH — the bot image (or provisioning host) must ship it';
  }
  return `aws exited with ${String(status ?? 'unknown')}: ${String(err?.message ?? err)}`;
}

function getS3Env(config: S3Config): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  // Only override AWS static credentials when explicitly configured (e.g. MinIO / scoped key pair).
  // Leaving them untouched when unset lets AWS CLI use the ECS Task Role / default credential chain.
  if (config.s3AccessKey || config.s3SecretKey) {
    env.AWS_ACCESS_KEY_ID = config.s3AccessKey || '';
    env.AWS_SECRET_ACCESS_KEY = config.s3SecretKey || '';
    delete env.AWS_SESSION_TOKEN;
  }
  return env;
}

export function s3Sync(localDir: string, s3Path: string, config: S3Config, direction: 'up' | 'down', excludes: string[] = []): void {
  if (!config.userdataS3Path || !config.s3Endpoint || !config.s3Bucket) return;
  const s3Uri = `s3://${config.s3Bucket}/${s3Path}`;
  const [src, dst] = direction === 'down' ? [s3Uri, `${localDir}/`] : [`${localDir}/`, s3Uri];
  console.log(`[s3-sync] S3 sync ${direction}: ${src} → ${dst}`);
  try {
    // argv-exec, never a shell — config values are arguments, they cannot inject.
    execFileSync(
      'aws',
      ['s3', 'sync', src, dst, '--endpoint-url', config.s3Endpoint, ...excludes.flatMap(e => ['--exclude', e])],
      { env: getS3Env(config), stdio: 'inherit', timeout: 300000 }
    );
  } catch (err: any) {
    // Attributed, typed failure naming the sync step + target (#724 C3). The pre-guard shape —
    // an unguarded exec — killed the process before Chromium launched with nothing on the
    // log naming the step (the #461 signature).
    throw new SessionSyncError(
      direction === 'down' ? 'session-restore' : 'session-save',
      `${describeAwsFailure(err)} (endpoint ${config.s3Endpoint}, path ${s3Path})`,
      err,
    );
  }
}

export function syncBrowserDataFromS3(config: S3Config, dataDir: string = BROWSER_DATA_DIR): void {
  s3Sync(dataDir, `${config.userdataS3Path}/browser-data`, config, 'down', BROWSER_CACHE_EXCLUDES);
}

export interface AsyncSessionRestoreOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Override fetch in unit tests for native SigV4 S3 sync. */
  fetchImpl?: typeof fetch;
}

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Path(path: string): string {
  return path.split('/').map(encodeRfc3986).join('/');
}

function resolveS3Region(endpoint: string): string {
  const fromEnv = (process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const host = new URL(endpoint).hostname;
    const match = /^s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i.exec(host);
    if (match?.[1]) return match[1];
  } catch { /* fall through */ }
  return 'us-east-1';
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

const COMPILED_CACHE_EXCLUDES = BROWSER_CACHE_EXCLUDES.map(globToRegex);

function isExcludedRelativePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const base = basename(normalized);
  return COMPILED_CACHE_EXCLUDES.some((rx) => rx.test(normalized) || rx.test(base));
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function parseListObjectsV2Xml(xml: string): { keys: string[]; isTruncated: boolean; nextToken?: string } {
  const keys: string[] = [];
  const keyRx = /<Key>([\s\S]*?)<\/Key>/g;
  let match: RegExpExecArray | null;
  while ((match = keyRx.exec(xml)) !== null) {
    keys.push(decodeXmlEntities(match[1]));
  }
  const isTruncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  const nextToken = tokenMatch ? decodeXmlEntities(tokenMatch[1]) : undefined;
  return { keys, isTruncated, nextToken };
}

async function resolveNativeAwsCredentials(
  config: S3Config,
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<AwsCredentials> {
  if (config.s3AccessKey || config.s3SecretKey) {
    return { accessKeyId: config.s3AccessKey || '', secretAccessKey: config.s3SecretKey || '' };
  }
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    };
  }
  const relUri = (process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || '').trim();
  const fullUri = (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI || '').trim();
  const url = relUri ? `http://169.254.170.2${relUri}` : fullUri;
  if (!url) {
    throw new Error('no AWS credentials found (static keys, AWS_* env, or ECS container credentials)');
  }
  const headers: Record<string, string> = {};
  if (process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN) {
    headers.Authorization = process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN;
  } else if (process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) {
    headers.Authorization = readFileSync(process.env.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, 'utf8').trim();
  }
  const res = await fetchFn(url, { headers, signal });
  if (!res.ok) {
    throw new Error(`ECS credentials endpoint returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { AccessKeyId?: string; SecretAccessKey?: string; Token?: string };
  if (!body.AccessKeyId || !body.SecretAccessKey) {
    throw new Error('ECS credentials payload missing AccessKeyId/SecretAccessKey');
  }
  return {
    accessKeyId: body.AccessKeyId,
    secretAccessKey: body.SecretAccessKey,
    ...(body.Token ? { sessionToken: body.Token } : {}),
  };
}

function buildSignedS3Request(opts: {
  method: 'GET' | 'PUT';
  endpoint: string;
  bucket: string;
  key?: string;
  query?: Record<string, string>;
  body?: Buffer;
  creds: AwsCredentials;
  region: string;
  now?: Date;
}): { url: string; headers: Record<string, string> } {
  const base = opts.endpoint.replace(/\/+$/, '');
  const parsed = new URL(base);
  const basePath = parsed.pathname.replace(/\/+$/, '');
  const keySegment = opts.key ? `/${encodeS3Path(opts.key.replace(/^\/+/, ''))}` : '';
  const canonicalUri = `${basePath}/${encodeRfc3986(opts.bucket)}${keySegment}` || '/';

  const queryPairs = Object.entries(opts.query ?? {})
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const canonicalQuery = queryPairs.map(([k, v]) => `${k}=${v}`).join('&');

  const now = opts.now ?? new Date();
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const amzDate = iso;
  const dateStamp = iso.slice(0, 8);
  const payloadHash = sha256Hex(opts.body ?? Buffer.alloc(0));

  const signedHeaderMap: Record<string, string> = {
    host: parsed.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (opts.creds.sessionToken) {
    signedHeaderMap['x-amz-security-token'] = opts.creds.sessionToken;
  }
  const sortedNames = Object.keys(signedHeaderMap).sort();
  const canonicalHeaders = sortedNames.map((k) => `${k}:${signedHeaderMap[k]}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${opts.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmacSha256(`AWS4${opts.creds.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, opts.region);
  const kService = hmacSha256(kRegion, 's3');
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  const headers: Record<string, string> = {
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (opts.creds.sessionToken) {
    headers['x-amz-security-token'] = opts.creds.sessionToken;
  }
  const url = `${parsed.protocol}//${parsed.host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  return { url, headers };
}

function useNativeS3Sync(): boolean {
  return process.env.TINA_S3_NATIVE === '1';
}

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

/** Zero-dependency parallel Node SigV4 restore — eliminates 68 MB awscli + Python cold start. */
async function syncBrowserDataFromS3Native(
  config: S3Config,
  dataDir: string,
  options: AsyncSessionRestoreOptions,
): Promise<void> {
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? options.timeoutMs!
    : 15_000;
  const s3Path = `${config.userdataS3Path}/browser-data`;
  const prefix = `${s3Path.replace(/^\/+|\/+$/g, '')}/`;
  const startedAt = Date.now();

  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => controller.abort(options.signal?.reason ?? new Error('session restore aborted'));
  if (options.signal?.aborted) {
    throw new SessionSyncError('session-restore', 'session restore aborted before S3 request started', options.signal.reason);
  }
  options.signal?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`session restore timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  console.log(`[s3-sync] Native S3 restore: s3://${config.s3Bucket}/${prefix} → ${dataDir}/`);
  try {
    const creds = await resolveNativeAwsCredentials(config, fetchFn, controller.signal);
    const region = resolveS3Region(config.s3Endpoint!);
    const allKeys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (continuationToken) query['continuation-token'] = continuationToken;
      const req = buildSignedS3Request({
        method: 'GET',
        endpoint: config.s3Endpoint!,
        bucket: config.s3Bucket!,
        query,
        creds,
        region,
      });
      const res = await fetchFn(req.url, { method: 'GET', headers: req.headers, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`S3 ListObjectsV2 returned HTTP ${res.status}`);
      }
      const xml = await res.text();
      const page = parseListObjectsV2Xml(xml);
      allKeys.push(...page.keys);
      continuationToken = page.isTruncated ? page.nextToken : undefined;
    } while (continuationToken);

    const rootDir = resolve(dataDir);
    await mkdir(rootDir, { recursive: true });
    const targets: Array<{ key: string; dest: string }> = [];
    for (const key of allKeys) {
      if (!key.startsWith(prefix) || key.endsWith('/')) continue;
      const rel = key.slice(prefix.length);
      if (!rel || isExcludedRelativePath(rel)) continue;
      const dest = resolve(rootDir, rel);
      if (!dest.startsWith(`${rootDir}${sep}`)) {
        throw new Error(`unsafe S3 object key outside profile dir: ${key}`);
      }
      targets.push({ key, dest });
    }

    let totalBytes = 0;
    await runWithConcurrency(targets, 8, async ({ key, dest }) => {
      const req = buildSignedS3Request({
        method: 'GET',
        endpoint: config.s3Endpoint!,
        bucket: config.s3Bucket!,
        key,
        creds,
        region,
      });
      const res = await fetchFn(req.url, { method: 'GET', headers: req.headers, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`S3 GetObject failed for ${key} (HTTP ${res.status})`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      totalBytes += buf.length;
    });

    console.log(
      `[s3-sync] Native S3 restore complete: ${targets.length} file(s), ${(totalBytes / 1024).toFixed(1)} KiB in ${Date.now() - startedAt}ms`,
    );
  } catch (error: any) {
    if (error instanceof SessionSyncError) throw error;
    const detail = timedOut
      ? `session restore timed out after ${timeoutMs}ms`
      : options.signal?.aborted
        ? 'session restore aborted'
        : String(error?.message ?? error);
    throw new SessionSyncError(
      'session-restore',
      `${detail} (endpoint ${config.s3Endpoint}, path ${s3Path})`,
      error,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
  }
}

async function listLocalFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...await listLocalFilesRecursive(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

/** Async write-back: uses native parallel SigV4 uploads when TINA_S3_NATIVE=1, else delegates to aws CLI. */
export async function syncBrowserDataToS3Async(
  config: S3Config,
  dataDir: string = BROWSER_DATA_DIR,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<number> {
  if (!config.userdataS3Path || !config.s3Endpoint || !config.s3Bucket) return 0;
  if (!useNativeS3Sync()) {
    return syncBrowserDataToS3(config, dataDir);
  }
  const fetchFn = options.fetchImpl ?? globalThis.fetch;
  const perFileTimeoutMs = options.timeoutMs ?? 10_000;
  const prefix = `${config.userdataS3Path.replace(/^\/+|\/+$/g, '')}/browser-data`;
  console.log(`[s3-sync] Native S3 save (auth-essential files only) from ${dataDir}...`);

  let creds: AwsCredentials;
  try {
    creds = await resolveNativeAwsCredentials(config, fetchFn);
  } catch (err: any) {
    console.log(`[s3-sync] Warning: failed to resolve credentials for save: ${String(err?.message ?? err)}`);
    return 0;
  }
  const region = resolveS3Region(config.s3Endpoint);

  const uploads: Array<{ local: string; key: string; label: string }> = [];
  for (const file of AUTH_ESSENTIAL_FILES) {
    const local = join(dataDir, file);
    if (!existsSync(local)) continue;
    uploads.push({ local, key: `${prefix}/${file}`, label: file });
  }
  for (const dir of AUTH_ESSENTIAL_DIRS) {
    const localDir = join(dataDir, dir);
    if (!existsSync(localDir)) continue;
    try {
      const nested = await listLocalFilesRecursive(localDir);
      const baseRoot = resolve(dataDir);
      for (const full of nested) {
        const rel = resolve(full).slice(baseRoot.length + 1).replace(/\\/g, '/');
        uploads.push({ local: full, key: `${prefix}/${rel}`, label: rel });
      }
    } catch (err: any) {
      console.log(`[s3-sync] Warning: failed to scan ${dir}: ${String(err?.message ?? err)}`);
    }
  }

  let uploaded = 0;
  await runWithConcurrency(uploads, 6, async ({ local, key, label }) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), perFileTimeoutMs);
    try {
      const body = await readFile(local);
      const req = buildSignedS3Request({
        method: 'PUT',
        endpoint: config.s3Endpoint!,
        bucket: config.s3Bucket!,
        key,
        body,
        creds,
        region,
      });
      const res = await fetchFn(req.url, {
        method: 'PUT',
        headers: { ...req.headers, 'content-length': String(body.length) },
        body: new Uint8Array(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      uploaded++;
    } catch (err: any) {
      console.log(`[s3-sync] Warning: failed to upload ${label}: ${String(err?.message ?? err)}`);
    } finally {
      clearTimeout(timer);
    }
  });

  console.log(`[s3-sync] Native S3 uploaded ${uploaded} auth-essential file(s)`);
  return uploaded;
}

/** Async, abortable restore for long-lived workers. Uses native parallel SigV4 S3 sync when
 *  TINA_S3_NATIVE=1 (fast, zero awscli dependency), otherwise spawns the AWS CLI asynchronously. */
export async function syncBrowserDataFromS3Async(
  config: S3Config,
  dataDir: string = BROWSER_DATA_DIR,
  options: AsyncSessionRestoreOptions = {},
): Promise<void> {
  if (!config.userdataS3Path || !config.s3Endpoint || !config.s3Bucket) return;
  if (useNativeS3Sync()) {
    await syncBrowserDataFromS3Native(config, dataDir, options);
    return;
  }
  if (options.signal?.aborted) {
    throw new SessionSyncError('session-restore', 'restore aborted before the AWS CLI started', options.signal.reason);
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
    ? options.timeoutMs!
    : 15_000;
  const s3Path = `${config.userdataS3Path}/browser-data`;
  const s3Uri = `s3://${config.s3Bucket}/${s3Path}`;
  const args = ['s3', 'sync', s3Uri, `${dataDir}/`, '--endpoint-url', config.s3Endpoint,
    ...BROWSER_CACHE_EXCLUDES.flatMap((exclude) => ['--exclude', exclude])];

  console.log(`[s3-sync] S3 async restore: ${s3Uri} → ${dataDir}/`);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('aws', args, { env: getS3Env(config), stdio: 'inherit' });
      let settled = false;
      let terminationError: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = (): void => {
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        options.signal?.removeEventListener('abort', abort);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const terminate = (error: Error): void => {
        if (settled || terminationError) return;
        terminationError = error;
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      };
      const abort = (): void => terminate(new Error('session restore aborted'));

      timeout = setTimeout(() => terminate(new Error(`session restore timed out after ${timeoutMs}ms`)), timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      child.once('error', (error) => finish(terminationError ?? error));
      child.once('close', (code, signal) => {
        if (terminationError) finish(terminationError);
        else if (code !== 0) finish(new Error(`aws exited with ${String(code ?? signal ?? 'unknown')}`));
        else finish();
      });
    });
  } catch (error) {
    throw new SessionSyncError(
      'session-restore',
      `${describeAwsFailure(error)} (endpoint ${config.s3Endpoint}, path ${s3Path})`,
      error,
    );
  }
}

/**
 * Upload the auth-essential subset of a LIVE profile dir to the durable S3 copy — the write-back
 * half of restore→use→write-back (#725 C1). `dataDir` names the profile the browser actually ran
 * on (a per-bot ephemeral `${BROWSER_DATA_DIR}-XXXXXX` dir — symmetric with
 * `syncBrowserDataFromS3(config, dataDir)`). Per-item failures are attributed warnings, never a
 * throw and never unbounded (each call carries its own timeout) — a flaky upload on teardown
 * leaves the durable copy at the last restore, it never hangs the exit. Returns the number of
 * items uploaded (0 ⇒ nothing durable changed — provisioning treats that as failure).
 */
export function syncBrowserDataToS3(config: S3Config, dataDir: string = BROWSER_DATA_DIR): number {
  if (!config.userdataS3Path || !config.s3Endpoint || !config.s3Bucket) return 0;
  const s3Base = `s3://${config.s3Bucket}/${config.userdataS3Path}/browser-data`;
  const env = getS3Env(config);
  const endpointArgs = ['--endpoint-url', config.s3Endpoint];
  let uploaded = 0;

  console.log(`[s3-sync] S3 save (auth-essential files only) from ${dataDir}...`);

  for (const file of AUTH_ESSENTIAL_FILES) {
    const local = join(dataDir, file);
    if (!existsSync(local)) continue;
    try {
      execFileSync('aws', ['s3', 'cp', local, `${s3Base}/${file}`, ...endpointArgs], { env, stdio: 'pipe', timeout: 10000 });
      uploaded++;
    } catch (err: any) {
      console.log(`[s3-sync] Warning: failed to upload ${file}: ${describeAwsFailure(err)}`);
    }
  }

  for (const dir of AUTH_ESSENTIAL_DIRS) {
    const local = join(dataDir, dir);
    if (!existsSync(local)) continue;
    try {
      execFileSync('aws', ['s3', 'sync', `${local}/`, `${s3Base}/${dir}/`, ...endpointArgs], { env, stdio: 'pipe', timeout: 10000 });
      uploaded++;
    } catch (err: any) {
      console.log(`[s3-sync] Warning: failed to sync ${dir}: ${describeAwsFailure(err)}`);
    }
  }

  console.log(`[s3-sync] Uploaded ${uploaded} auth-essential items`);
  return uploaded;
}

// ── Local backend (desktop/dev, no S3 creds) ─────────────────────────────

/** Copy the auth-essential profile subset OUT of a live profile dir into a durable dir. */
export function saveSessionLocal(destDir: string, srcDataDir: string = BROWSER_DATA_DIR): number {
  mkdirSync(destDir, { recursive: true });
  let n = 0;
  for (const file of AUTH_ESSENTIAL_FILES) {
    const src = join(srcDataDir, file);
    if (!existsSync(src)) continue;
    const dst = join(destDir, file);
    mkdirSync(dirname(dst), { recursive: true });
    try { cpSync(src, dst); n++; } catch (err: any) { console.log(`[session-store] save skip ${file}: ${err.message}`); }
  }
  for (const dir of AUTH_ESSENTIAL_DIRS) {
    const src = join(srcDataDir, dir);
    if (!existsSync(src)) continue;
    try { cpSync(src, join(destDir, dir), { recursive: true }); n++; } catch (err: any) { console.log(`[session-store] save skip ${dir}: ${err.message}`); }
  }
  console.log(`[session-store] Saved ${n} auth-essential items → ${destDir}`);
  return n;
}

/** Copy the auth-essential profile subset back INTO a profile dir before launch. */
export function loadSessionLocal(srcDir: string, destDataDir: string = BROWSER_DATA_DIR): number {
  if (!existsSync(srcDir)) { console.log(`[session-store] no saved session at ${srcDir}`); return 0; }
  mkdirSync(destDataDir, { recursive: true });
  let n = 0;
  for (const file of AUTH_ESSENTIAL_FILES) {
    const src = join(srcDir, file);
    if (!existsSync(src)) continue;
    const dst = join(destDataDir, file);
    mkdirSync(dirname(dst), { recursive: true });
    try { cpSync(src, dst); n++; } catch (err: any) { console.log(`[session-store] load skip ${file}: ${err.message}`); }
  }
  for (const dir of AUTH_ESSENTIAL_DIRS) {
    const src = join(srcDir, dir);
    if (!existsSync(src)) continue;
    try { cpSync(src, join(destDataDir, dir), { recursive: true }); n++; } catch (err: any) { console.log(`[session-store] load skip ${dir}: ${err.message}`); }
  }
  console.log(`[session-store] Loaded ${n} auth-essential items ← ${srcDir}`);
  return n;
}

// ── Profile hygiene ───────────────────────────────────────────────────────

export function cleanStaleLocks(dir: string = BROWSER_DATA_DIR): void {
  const lockFiles = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'];
  for (const f of lockFiles) {
    const p = join(dir, f);
    if (existsSync(p)) {
      try { unlinkSync(p); } catch {}
      console.log(`[session-store] Removed stale lock: ${f}`);
    }
  }
}

export function ensureBrowserDataDir(dir: string = BROWSER_DATA_DIR): void {
  mkdirSync(dir, { recursive: true });
}
