import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const trees = [];
after(() => {
  for (const dir of trees) {
    assert.equal(dirname(realpathSync(dir)), realpathSync(tmpdir()));
    assert(dir.startsWith(join(tmpdir(), "tina-python-gate-")));
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(failing) {
  const dir = mkdtempSync(join(tmpdir(), "tina-python-gate-"));
  trees.push(dir);
  copyFileSync(join(root, "scripts/gates.mjs"), join(dir, "gates.mjs"));
  mkdirSync(join(dir, "bin"));
  for (const name of ["first", "second"]) {
    mkdirSync(join(dir, name, "tests"), { recursive: true });
    writeFileSync(join(dir, name, "pyproject.toml"), "# package discovery fixture\n");
  }
  const shim = join(dir, "bin/uv");
  writeFileSync(shim, `#!/usr/bin/env node
import { basename } from 'node:path';
import assert from 'node:assert/strict';
assert.deepEqual(process.argv.slice(2), ['run', 'pytest', '-v', '-o', 'faulthandler_timeout=120', '--durations=10']);
assert.equal(process.env.PYTHONUNBUFFERED, '1');
console.log('child stdout: ' + basename(process.cwd()));
console.error('child stderr: ' + basename(process.cwd()));
process.exit(${failing ? "7" : "0"});
`);
  // An extensionless shim is CommonJS unless this directory declares ESM.
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  chmodSync(shim, 0o755);
  return { cwd: dir, env: { ...process.env, PATH: join(dir, "bin") + ":" + process.env.PATH }, encoding: "utf8" };
}

test("python gate streams child progress and reports successful package durations", { skip: process.platform === "win32" }, () => {
  const options = fixture(false);
  const out = execFileSync(process.execPath, ["gates.mjs", "python"], options);
  assert.match(out, /▶ pytest first/);
  assert.match(out, /child stdout: first/);
  assert.match(out, /✓ pytest first — [\d.]+s/);
  assert.match(out, /child stdout: second/);
  assert(out.indexOf("child stdout: first") < out.indexOf("✓ pytest first"));
  assert.match(out, /2 package\(s\) · pytest green/);
});

test("python gate preserves child failure output and never starts the next package", { skip: process.platform === "win32" }, () => {
  assert.throws(() => execFileSync(process.execPath, ["gates.mjs", "python"], fixture(true)), error => {
    assert.equal(error.status, 1);
    assert.match(error.stdout, /child stdout: first/);
    assert.match(error.stderr, /child stderr: first/);
    assert.match(error.stderr, /pytest first failed \(7\)/);
    assert.doesNotMatch(error.stdout, /pytest second|gates green/);
    return true;
  });
});
