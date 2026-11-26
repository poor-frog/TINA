import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginChatGPTAuth, exchangeChatGPTCode } from '../../clients/terminal/src/lib/chatgptPlanAuth.ts';

const origin = 'http://127.0.0.1:23101';
const callback = '/api/models/openai/callback';
const stack = 'tina-staging-agent-api';
const awsProfile = process.env.TINA_AWS_PROFILE || 'tina';

function aws(service, action, ...args) {
  try {
    const value = execFileSync('aws', [service, action, ...args, '--profile', awsProfile,
      '--region', 'us-east-1', '--no-cli-pager', '--output', 'json'],
    { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] });
    return value.trim() ? JSON.parse(value) : null;
  } catch {
    throw new Error('AWS could not complete ' + action + '. Check the staging profile and try again.');
  }
}

function storeProfile(secret, previousVersion, profile) {
  const candidate = randomUUID();
  const stage = 'tina-' + candidate;
  const directory = mkdtempSync(join(tmpdir(), 'tina-workspace-auth-'));
  const file = join(directory, 'profile.json');
  try {
    writeFileSync(file, JSON.stringify(profile), { mode: 0o600, flag: 'wx' });
    aws('secretsmanager', 'put-secret-value', '--secret-id', secret, '--client-request-token',
      candidate, '--version-stages', stage, '--secret-string', 'file://' + file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  try {
    aws('secretsmanager', 'update-secret-version-stage', '--secret-id', secret,
      '--version-stage', 'AWSCURRENT', '--move-to-version-id', candidate, '--remove-from-version-id', previousVersion);
  } finally {
    try {
      aws('secretsmanager', 'update-secret-version-stage', '--secret-id', secret,
        '--version-stage', stage, '--remove-from-version-id', candidate);
    } catch { console.error('Could not remove the temporary Secrets Manager version label.'); }
  }
}

function main() {
  const [deployment] = aws('cloudformation', 'describe-stacks', '--stack-name', stack).Stacks;
  const params = Object.fromEntries(deployment.Parameters.map(p => [p.ParameterKey, p.ParameterValue]));
  const owner = params.WorkspaceChatGPTOwner;
  const secret = params.WorkspaceChatGPTSecretArn;
  const account = deployment.StackId.split(':')[4];
  const pilotIds = params.WorkspacePilotUserIds?.split(',').map(id => id.trim());
  if (!/^[1-9][0-9]*$/.test(owner || '') || !(pilotIds?.includes('*') || pilotIds?.includes(owner))
      || !secret?.startsWith('arn:aws:secretsmanager:us-east-1:' + account + ':secret:tina/staging/workspace-pilot/chatgpt/' + owner + '/')) {
    throw new Error('The staging Workspace ChatGPT owner and secret must be configured first.');
  }
  const previous = aws('secretsmanager', 'get-secret-value', '--secret-id', secret, '--version-stage', 'AWSCURRENT');
  const existing = JSON.parse(previous.SecretString);
  if (existing.tina_owner !== owner || existing.tina_scope !== 'workspace-agent' || !existing.host_id || !previous.VersionId) {
    throw new Error('The existing secret does not belong to this staging workspace.');
  }

  const start = '/start/' + randomBytes(24).toString('base64url');
  let pending;
  let used = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self' https://auth.openai.com; frame-ancestors 'none'");
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    if (req.headers.host !== '127.0.0.1:23101') return res.writeHead(400).end('Invalid host.');
    let url;
    try { url = new URL(req.url, origin); }
    catch { return res.writeHead(400).end('Invalid URL.'); }
    if (req.method === 'GET' && url.origin === origin && url.pathname === '/' && !used) {
      res.setHeader('Referrer-Policy', 'same-origin');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>TINA Workspace ChatGPT</title>'
        + '<h1>Connect ChatGPT to TINA Workspace staging</h1><p>The selected ChatGPT plan will be used by your staging Workspace agent.</p>'
        + '<form method="post" action="' + start + '"><button>Continue with ChatGPT</button></form></html>');
    }
    if (req.method === 'POST' && url.origin === origin && url.pathname === start && req.headers.origin === origin && !used && !pending) {
      const clientId = existing.client_id || 'dynamic_agent_client';
      const flow = beginChatGPTAuth({
        generation: previous.VersionId, redirect_uri: origin + callback, ui_origin: origin, subject_id: owner,
        host_id: existing.host_id, client_id: clientId,
        ...(clientId === 'dynamic_agent_client' ? { agent_name_hint: 'TINA' } : {}),
        ...(existing.id_token ? { id_token_hint: existing.id_token } : {}),
        ...(existing.email ? { login_hint: existing.email } : {}),
      });
      pending = flow.pending;
      return res.writeHead(303, { Location: flow.authorizationUrl }).end();
    }
    if (req.method !== 'GET' || url.origin !== origin || url.pathname !== callback
        || used || !pending || url.searchParams.get('state') !== pending.state) {
      return res.writeHead(400).end('Invalid or expired TINA sign-in.');
    }
    used = true;
    try {
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) throw new Error();
      const profile = await exchangeChatGPTCode({ code, callbackClientId: url.searchParams.get('client_id'), pending, existing });
      if (!profile.scopes.includes('offline_access')) throw new Error();
      const current = aws('secretsmanager', 'get-secret-value', '--secret-id', secret, '--version-stage', 'AWSCURRENT');
      const active = JSON.parse(current.SecretString);
      if (active.host_id !== existing.host_id || active.client_id !== existing.client_id
          || active.tina_owner !== owner || active.tina_scope !== 'workspace-agent') throw new Error();
      storeProfile(secret, current.VersionId, { ...profile, tina_owner: owner, tina_scope: 'workspace-agent' });
      res.end('ChatGPT is connected for TINA Workspace staging. Return to TINA Settings to refresh the status.');
      console.log('Workspace ChatGPT connection saved.');
    } catch {
      res.writeHead(400).end('Sign-in could not be saved. Restart the helper and try again.');
      console.error('Workspace ChatGPT sign-in was not saved.');
      process.exitCode = 1;
    } finally {
      clearTimeout(timeout);
      server.close();
    }
  });
  const timeout = setTimeout(() => server.close(), 10 * 60 * 1000);
  timeout.unref();
  server.on('error', () => { console.error('Could not open the ChatGPT callback on 127.0.0.1:23101.'); process.exitCode = 1; });
  server.listen(23101, '127.0.0.1', () => console.log('Open ' + origin + '/ to connect ChatGPT for TINA Workspace staging.'));
}

try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
