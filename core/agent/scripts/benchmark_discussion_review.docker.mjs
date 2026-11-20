// Runs the Python benchmark in a disposable Linux container against a separate Ollama.
// Assumes tina-review-benchmark-ollama has already been started; see discussion-review.md.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const slots = value('--parallel-slots', '1');
if (!['1', '2'].includes(slots)) throw new Error('parallel-slots must be 1 or 2');
const environment = JSON.parse(execFileSync('docker', ['inspect', 'tina-review-benchmark-ollama',
  '--format', '{{json .Config.Env}}'], { encoding: 'utf8' }));
if (!environment.includes(`OLLAMA_NUM_PARALLEL=${slots}`)) throw new Error('Benchmark server parallelism does not match --parallel-slots');
const name = value('--name', `experiment-parallel${slots}`);
if (!/^[a-z0-9-]+$/.test(name)) throw new Error('Use an alphanumeric experiment name');
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = join(root, 'output/discussion-review-docker');
mkdirSync(output, { recursive: true });
const statusPath = join(output, `${name}-status.json`);
const gpuPath = join(output, `${name}-gpu.json`);
const log = createWriteStream(join(output, `${name}.log`));
const pythonArgs = ['--base-url', 'http://tina-review-benchmark-ollama:11434',
  '--parallel-slots', slots, '--runs', value('--runs', '10'), '--output', `/results/${name}.json`];
for (const key of ['--input', '--temperature', '--repeat-transcript', '--max-tokens']) {
  if (args.includes(key)) pythonArgs.push(key, value(key));
}
const modes = value('--modes', slots === '1' ? 'sequential,concurrent,batch2,batch4' : 'sequential,concurrent');
pythonArgs.push('--modes', ...modes.split(','));
const child = spawn('docker', ['run', '--rm', '--name', 'tina-review-benchmark-runner',
  '--network', 'tina-local_tina', '--mount', `type=bind,source=${join(root, 'core/agent')},target=/work,readonly`,
  '--mount', `type=bind,source=${output},target=/results`, '--workdir', '/work',
  '--env', 'PYTHONPATH=/work', '--env', 'PYTHONDONTWRITEBYTECODE=1', 'tina/v012-agent-api:local',
  'python', 'scripts/benchmark_discussion_review.py', ...pythonArgs], { cwd: root });
const started = new Date().toISOString();
writeFileSync(statusPath, JSON.stringify({ status: 'running', pid: child.pid, started, args: pythonArgs }, null, 2));
child.stdout.on('data', data => { log.write(data); process.stdout.write(data); });
child.stderr.on('data', data => { log.write(data); process.stderr.write(data); });
const samples = [];
let sampling = false;
const timer = setInterval(() => {
  if (sampling) return;
  sampling = true;
  execFile('docker', ['exec', 'tina-review-benchmark-ollama', 'nvidia-smi',
    '--query-gpu=name,memory.used,memory.total,utilization.gpu,power.draw', '--format=csv,noheader,nounits'],
  { timeout: 10000 }, (error, stdout) => {
    sampling = false;
    if (!error) samples.push({ time: new Date().toISOString(), gpu: stdout.trim() });
    writeFileSync(gpuPath, JSON.stringify(samples, null, 2));
  });
}, 2000);
child.on('close', code => {
  clearInterval(timer);
  log.end();
  writeFileSync(statusPath, JSON.stringify({ status: code === 0 ? 'completed' : 'failed', exit_code: code,
    started, finished: new Date().toISOString(), args: pythonArgs }, null, 2));
  process.exitCode = code ?? 1;
});
child.on('error', error => {
  clearInterval(timer); log.end();
  writeFileSync(statusPath, JSON.stringify({ status: 'failed', error: error.message }, null, 2));
  process.exitCode = 1;
});
