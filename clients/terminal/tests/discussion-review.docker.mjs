// Real Docker/browser/LLM smoke test. Requires the local discussion overlay and Chrome.
// Creates labeled synthetic meetings and two @example.test accounts; prints no credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(join(root, 'services/dashboard/package.json'));
const { chromium } = require('playwright');
const Ajv = createRequire(join(root, 'package.json'))('ajv/dist/2020.js').default;
const base = process.env.TINA_REVIEW_TEST_URL || 'http://localhost:13000';
const email = 'reviewer@example.test';
const project = process.env.TINA_REVIEW_TEST_PROJECT || 'tina-local';
const envFile = process.env.TINA_REVIEW_TEST_ENV_FILE || 'deploy/compose/.env.local';
assert.match(project, /^tina-[a-z0-9-]+$/);
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname), 'Local test only');
const compose = ['compose', '--env-file', envFile, '-f', 'deploy/compose/docker-compose.yml',
  '-f', 'deploy/compose/docker-compose.discussion-local.yml', '-p', project];
const output = join(root, 'output/discussion-review-docker');
mkdirSync(output, { recursive: true });

const turns = [
  ['Lan', 0, 'Mục tiêu là chọn retry cho payment API. Tôi chọn retry cố định ba lần.'],
  ['Minh', 12, 'Em không đồng ý vì request chưa có idempotency key. Em đề xuất exponential backoff để giảm double charge.'],
  ['Lan', 70, 'Cuối tuần đội bóng nào thắng? Chúng ta bàn chuyện bóng đá và đặt vé du lịch nhé.'],
  ['Huy', 82, 'Tôi muốn nói về trận bóng và khách sạn, không liên quan payment API.'],
  ['Huy', 140, 'Minh ngu như vậy mà cũng bày đặt thiết kế backend. Im đi, đừng phát biểu nữa.'],
  ['Minh', 152, 'Đừng công kích cá nhân. Hãy phản biện thiết kế thay vì xúc phạm tôi.'],
  ['Lan', 210, 'Tôi nhắc lại y nguyên quan điểm ban đầu: retry cố định ba lần. Tôi không có dữ liệu mới hay bước tiếp theo.'],
  ['Minh', 222, 'Tôi cũng chỉ lặp lại quan điểm cũ: exponential backoff. Chưa có tiêu chí mới, quyết định hay thử nghiệm nào được chốt.'],
];
const agenda = 'Chọn chiến lược retry cho payment API, làm rõ idempotency và thống nhất tiêu chí hoặc thử nghiệm tiếp theo.';
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(60000);
const pageErrors = [];
page.on('pageerror', error => pageErrors.push(error.message));

async function json(response) {
  const value = await response.json();
  assert.ok(response.ok(), `${response.status()} ${JSON.stringify(value)}`);
  return value;
}

try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.locator('input[type=email]').fill(email);
  const login = page.waitForResponse(response => response.url().endsWith('/api/auth/login') && response.request().method() === 'POST');
  await page.getByRole('button', { name: /^(Sign in as admin|Sign in)$/ }).click();
  assert.equal((await login).status(), 200);
  // The UI reloads immediately after login, so resolve identity through a fresh request.
  const owner = (await json(await context.request.get(base + '/api/tokens'))).tokens[0].user_id;
  assert.match(String(owner), /^[1-9]\d*$/);
  await json(await context.request.post(base + '/api/workspace/init'));

  const setup = await json(await context.request.get(base + '/api/admin/settings/setup'));
  if (setup.value?.completed !== 'true') {
    await page.getByText('OpenRouter or custom endpoint', { exact: true }).click();
    await page.getByPlaceholder('https://openrouter.ai/api/v1').fill('http://ollama:11434/v1');
    await page.getByPlaceholder('Model — e.g. anthropic/claude-sonnet-4.5').fill('qwen2.5:7b-instruct');
    await page.getByRole('button', { name: 'Save & test', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Skip for now', exact: true }).click();
    await page.getByRole('button', { name: 'Go to Meetings', exact: true }).click();
  }

  const origin = Math.floor(Date.now() / 1000) - 300;
  const native = 'discussion-demo-' + Date.now();
  const data = JSON.stringify({ title: 'Discussion Review demo — VI/EN payment retry', discussion_review_demo: true,
    notes: 'Synthetic discussion-review test fixture; not a recorded real meeting.' });
  const rows = turns.map(([speaker, offset, text], index) =>
    `(${quote('demo-' + index)},${origin + offset},${origin + offset + 8},${quote(speaker)},${quote(text)})`).join(',');
  const sql = `WITH meeting AS (
    INSERT INTO meetings(user_id,platform,platform_specific_id,status,start_time,end_time,data)
    VALUES (${owner},'google_meet',${quote(native)},'completed',to_timestamp(${origin}),to_timestamp(${origin + 240}),${quote(data)}::jsonb)
    RETURNING id
  ), session AS (
    INSERT INTO meeting_sessions(meeting_id,session_uid,session_start_time)
    SELECT id,${quote(native)},to_timestamp(${origin}) FROM meeting
  ), segments AS (
    INSERT INTO transcriptions(meeting_id,segment_id,start_time,end_time,speaker,text,language,session_uid)
    SELECT m.id,v.segment_id,v.start_time,v.end_time,v.speaker,v.text,'vi',${quote(native)}
    FROM meeting m CROSS JOIN (VALUES ${rows}) AS v(segment_id,start_time,end_time,speaker,text)
  ) SELECT id FROM meeting;`;
  const mid = execFileSync('docker', [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'tina', '-tAq', '-v', 'ON_ERROR_STOP=1'],
    { cwd: root, input: sql, encoding: 'utf8', timeout: 20000 }).trim();
  assert.match(mid, /^[1-9]\d*$/);
  const path = `/api/discussion-reviews/${mid}`;
  const canonical = await json(await context.request.get(base + `/api/transcripts/by-id/${mid}/canonical`));
  assert.equal(canonical.segments.length, turns.length);

  await page.goto(base + '/meetings/' + mid, { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Transcript language').selectOption('vi');
  // Let an already-started default translation finish before this single-GPU review request.
  for (let attempt = 0; attempt < 50; attempt++) {
    const response = await context.request.get(base + `/api/meeting-translations/${mid}`, { maxRetries: 2 });
    if (!response.ok() || (await response.json()).status !== 'running') break;
    await page.waitForTimeout(1000);
  }
  await page.getByRole('button', { name: 'Meeting tools', exact: true }).click();
  await page.getByRole('button', { name: 'Discussion review', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Đánh giá thảo luận' });
  await dialog.getByRole('textbox').fill(agenda);
  const start = performance.now();
  const [generated] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'POST', { timeout: 300000 }),
    dialog.getByRole('button', { name: 'Tạo đánh giá thảo luận', exact: true }).click(),
  ]);
  const state = await json(generated);
  const seconds = Math.round((performance.now() - start) / 1000);
  const report = state.report;
  const schema = JSON.parse(readFileSync(join(root, 'core/agent/contracts/discussion-review.v1/discussion-review.schema.json'), 'utf8'));
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const validate = ajv.compile({ $ref: '#/$defs/Report', $defs: schema.$defs });
  assert.ok(validate(report), ajv.errorsText(validate.errors));
  assert.equal(report.meeting_id, Number(mid));
  assert.equal(state.stale, false);
  assert.equal(report.windows.length, 4);
  assert.equal(report.sources.length, turns.length);
  assert.deepEqual(report.sources.map(source => source.quote), turns.map(turn => turn[2]));
  assert.equal(report.windows[1].relevance.label, 'off_scope', 'Obvious football tangent should be off scope');
  assert.ok(report.windows[2].interaction.labels.includes('personal_hostility'), 'Explicit insult should be personal hostility');
  assert.equal(report.windows[3].progress.label, 'repeating_unresolved_positions', 'Explicit unchanged positions should be repetition');
  await dialog.getByText(/qwen2\.5:7b-instruct/).waitFor();
  await dialog.locator('details').first().locator('summary').click();
  await page.screenshot({ path: join(output, 'review.png'), fullPage: true });
  const cached = await json(await context.request.post(base + path, { data: { agenda, expected_id: report.id } }));
  assert.equal(cached.report.id, report.id);
  assert.equal((await context.request.post(base + path, { data: { agenda: ' ' } })).status(), 422);
  const after = await json(await context.request.get(base + `/api/transcripts/by-id/${mid}/canonical`));
  assert.deepEqual(after, canonical, 'Review must not rewrite canonical transcript');

  const other = await browser.newContext();
  try {
    await json(await other.request.post(base + '/api/auth/login', { data: { email: 'review-outsider@example.test' } }));
    assert.equal((await other.request.get(base + path)).status(), 404);
  } finally { await other.close(); }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByLabel('Transcript language').selectOption('vi');
  await page.getByRole('button', { name: 'Meeting tools', exact: true }).click();
  await page.getByRole('button', { name: 'Discussion review', exact: true }).click();
  await page.getByRole('dialog', { name: 'Đánh giá thảo luận' }).getByText(/qwen2\.5:7b-instruct/).waitFor();
  assert.deepEqual(pageErrors, []);
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  const summary = { passed: true, terminal: base, meeting_url: base + '/meetings/' + mid, email,
    model: report.model, elapsed_seconds: seconds, windows: report.windows.length, exact_sources: report.sources.length,
    checks: ['real UI generation', 'schema', 'off-scope example', 'hostility example', 'repetition example', 'exact quotes', 'unchanged canonical', 'cached reuse', 'owner isolation', 'reload persistence'] };
  writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  const message = String(error?.message || error)
    .replace(/(cookie|authorization|x-api-key):[^\r\n]*/gi, '$1: [redacted]')
    .replace(/tina_(?:bot_)?[A-Za-z0-9_-]+/g, '[redacted]');
  throw new Error(message);
} finally { await browser.close(); }
