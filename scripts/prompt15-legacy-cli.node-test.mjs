import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retired = [
  'prompt15-prepare-15-18-resume.mjs',
  'prompt15-reconcile-review-b.mjs',
  'prompt15-reconcile-15-18-restart.mjs',
  'prompt15-reconcile-stopped-dispatch.mjs',
  'prompt15-record-v18-result.mjs',
];

const inventory = directory => Object.fromEntries(fs.readdirSync(directory, {withFileTypes: true})
  .flatMap(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory()
      ? Object.entries(inventory(filename)).map(([name, bytes]) => [path.join(entry.name, name), bytes])
      : [[entry.name, fs.readFileSync(filename).toString('base64')]];
  }));

for (const filename of retired) test(`F11 ${filename} exits clearly without touching historical state`, () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pax-retired-cli-'));
  try {
    const reportDirectory = path.join(temporary, 'reports', 'prompt15', 'orchestration', '20261015T115644-KST-eae9ad74');
    fs.mkdirSync(reportDirectory, {recursive: true});
    fs.writeFileSync(path.join(reportDirectory, 'state.json'), '{"status":"stopped","sentinel":"preserve"}\n');
    const before = inventory(temporary), absolute = path.join(root, 'scripts', filename);
    const result = spawnSync(process.execPath, [absolute, '--dry-run', '--clear-stale-owner', '--run', reportDirectory], {
      cwd: temporary, encoding: 'utf8', windowsHide: true, timeout: 5_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /LEGACY_CLI_UNSUPPORTED/);
    assert.ok(result.stderr.includes(`scripts/${filename}`));
    assert.match(result.stderr, /scripts\/prompt15-orchestrator\/run\.mjs status --run <v2-run>/);
    assert.doesNotMatch(result.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|does not provide an export/);
    assert.deepEqual(inventory(temporary), before);
  } finally {
    const resolved = fs.realpathSync(temporary), expectedParent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), expectedParent);
    assert.ok(path.basename(resolved).startsWith('pax-retired-cli-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  }
});

test('F11 importing retired command stubs performs no work', () => {
  const imports = retired.map(filename => `await import(${JSON.stringify(pathToFileURL(path.join(root, 'scripts', filename)).href)});`).join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', imports], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 5_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('F11 supported package commands still use the current controller', () => {
  const {scripts} = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const command of ['start', 'resume', 'status', 'stop']) {
    assert.equal(scripts[`prompt15:${command}`], `node scripts/prompt15-orchestrator/run.mjs ${command}`);
  }
  assert.ok(Object.values(scripts).every(command => retired.every(filename => !command.includes(filename))));
  for (const filename of retired) {
    const source = fs.readFileSync(path.join(root, 'scripts', filename), 'utf8');
    assert.doesNotMatch(source, /prompt15-orchestrator\/(?:protocol|product-target|app-server)\.mjs|node:(?:fs|child_process|http|https)/);
  }
});
