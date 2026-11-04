// Run existing read-only checks with worktree/run-local outputs and child environment.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const script = fileURLToPath(import.meta.url);
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inside = (parent, child) => {const rel = path.relative(parent, child); return !rel || !rel.startsWith('..') && !path.isAbsolute(rel);};
const pointers = ['data/runtime/operational-catalog/current.json', 'data/runtime/geography/current.json'];

async function worker(inputFile) {
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const {root, runRoot, mode, filters} = input;
  const resultFile = path.join(runRoot, 'results', mode === 'vitest' ? 'vitest.json' : 'metadata.json');
  const observation = {pid: process.pid, startedAt: new Date().toISOString(), root, runRoot,
    osTmpdir: os.tmpdir(), nextDistDir: process.env.PAX_BUILD_DIST_DIR, mode};
  const tempMarker = path.join(os.tmpdir(), `verification-${process.pid}.json`);
  writeJson(tempMarker, {pid: process.pid, createdAt: observation.startedAt});
  observation.tempMarker = tempMarker;
  try {
    if (mode === 'metadata') {
      const registry = JSON.parse(fs.readFileSync(path.join(root, pointers[1]), 'utf8'));
      const child = spawnSync(process.execPath, ['scripts/geography/build-current-metadata.cjs', '--verify', registry.manifest.path], {
        cwd: root, env: process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      });
      observation.verifierPid = child.pid;
      process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
      if (child.error || child.status !== 0) throw child.error || Error(`Metadata verifier exit ${child.status}`);
      const metadata = JSON.parse(child.stdout);
      if (metadata.status !== 'validated-metadata-only') throw Error('Metadata verifier did not validate');
      writeJson(resultFile, metadata);
    } else {
      // Imports happen only after the parent has supplied the isolated child environment.
      const {startVitest} = await import('vitest/node');
      let context;
      const capture = () => {
        observation.rootVite = {root: context.vite.config.root, cacheDir: context.vite.config.cacheDir};
        observation.projects = context.projects.map(project => ({name: project.name, root: project.vite.config.root,
          cacheDir: project.vite.config.cacheDir, environment: project.config.environment}));
      };
      const observer = {
        onInit(ctx) {context = ctx;},
        onTestRunStart() {capture();},
        onTestRunEnd(modules, errors, reason) {
          capture(); observation.reason = reason; observation.unhandledErrors = errors.length;
          observation.collectedModules = modules.map(module => ({path: module.moduleId, state: module.state()}));
        },
      };
      const cacheDir = path.join(runRoot, 'vite-cache');
      const isolateProjectCaches = {
        name: 'workspace-verification-cache', enforce: 'pre',
        config(config) {
          config.cacheDir = cacheDir;
          // Inline projects do not inherit the root Vite override automatically.
          for (const project of config.test?.projects || []) {
            if (!project || typeof project !== 'object' || Array.isArray(project)) throw Error('Expected existing inline Vitest projects');
            project.cacheDir = cacheDir;
          }
        },
      };
      const ctx = await startVitest('test', filters, {root, run: true, watch: false, cache: false, configLoader: 'runner',
        reporters: ['json', observer], outputFile: {json: resultFile}, passWithNoTests: false,
      }, {root, cacheDir, plugins: [isolateProjectCaches]});
      try {
        // startVitest closes a completed non-watch run before returning.
        const resolved = [observation.rootVite, ...(observation.projects || [])];
        if (!observation.rootVite || !observation.projects?.length) throw Error('Resolved Vite paths were not observed during the run');
        if (resolved.some(config => !inside(cacheDir, config.cacheDir) || path.resolve(config.root) !== root)) throw Error('Resolved Vite root/cache escaped the run');
        const tests = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        observation.counts = {total: tests.numTotalTests, passed: tests.numPassedTests, failed: tests.numFailedTests,
          pending: tests.numPendingTests, files: tests.testResults.length};
        if (!tests.success || tests.numTotalTests < 1 || tests.numFailedTests || tests.numFailedTestSuites || observation.unhandledErrors || observation.reason !== 'passed') throw Error('Tests failed, were not collected, or had unhandled errors');
      } finally {await ctx.close();}
    }
    observation.status = 'passed';
  } catch (error) {
    observation.status = 'failed'; observation.error = error.stack || String(error); process.exitCode = 1;
    process.stderr.write(observation.error + '\n');
  } finally {
    observation.finishedAt = new Date().toISOString();
    writeJson(path.join(runRoot, 'results', 'observed-paths.json'), observation);
  }
}

function parent() {
  const args = process.argv.slice(2), options = {}, filters = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {filters.push(...args.slice(index + 1)); break;}
    if (!['--workspace-key', '--run-id', '--mode'].includes(arg) || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('Usage: node scripts/workspaces/run-verification.mjs --workspace-key <key> --run-id <id> [--mode vitest|metadata] [-- <test filters>]');
    if (options[arg]) throw Error(`Duplicate option: ${arg}`);
    options[arg] = args[++index];
  }
  for (const name of ['--workspace-key', '--run-id']) if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(options[name] || '')) throw Error(`Invalid ${name}`);
  const mode = options['--mode'] || 'vitest';
  if (!['vitest', 'metadata'].includes(mode) || mode === 'metadata' && filters.length) throw Error('Unsupported mode or metadata filters');
  if (filters.some(filter => path.isAbsolute(filter) || filter.split(/[\\/]/).includes('..'))) throw Error('Use worktree-relative test filters');
  if (!filters.length && mode === 'vitest') filters.push('src/lib/geography/country-metadata-input.test.ts');
  const root = fs.realpathSync(process.cwd());
  if (!fs.existsSync(path.join(root, 'vitest.config.ts')) || !inside(root, fs.realpathSync(script))) throw Error('Run the helper inside its own worktree root');
  const relative = `.tmp/prompt21/${options['--workspace-key']}/${options['--run-id']}`;
  const runRoot = path.join(root, relative), runParent = path.dirname(runRoot);
  fs.mkdirSync(runParent, {recursive: true});
  if (!inside(root, fs.realpathSync(runParent))) throw Error('Run parent escaped worktree');
  fs.mkdirSync(runRoot); // Never overwrite a prior run or its evidence.
  for (const child of ['os-temp', 'logs', 'results', 'vite-cache']) fs.mkdirSync(path.join(runRoot, child));
  const before = pointers.map(file => ({path: file, sha256: digest(path.join(root, file))}));
  const env = {...process.env, TEMP: path.join(runRoot, 'os-temp'), TMP: path.join(runRoot, 'os-temp'), TMPDIR: path.join(runRoot, 'os-temp'),
    PAX_BUILD_DIST_DIR: `.next-prompt21-${options['--workspace-key']}-${options['--run-id']}`};
  delete env.PAX_E2E_BUILD; delete env.PAX_REVIEW_G_E2E;
  const inputFile = path.join(runRoot, 'input.json');
  writeJson(inputFile, {root, runRoot, mode, filters});
  const out = fs.openSync(path.join(runRoot, 'logs', 'stdout.log'), 'wx');
  const err = fs.openSync(path.join(runRoot, 'logs', 'stderr.log'), 'wx');
  const startedAt = new Date().toISOString();
  let child;
  try {child = spawnSync(process.execPath, [script, '--internal-worker', inputFile], {cwd: root, env, stdio: ['ignore', out, err], windowsHide: true});}
  finally {fs.closeSync(out); fs.closeSync(err);}
  const observationFile = path.join(runRoot, 'results', 'observed-paths.json');
  const observation = fs.existsSync(observationFile) ? JSON.parse(fs.readFileSync(observationFile, 'utf8')) : null;
  const protectedPointersUnchanged = before.every(pin => digest(path.join(root, pin.path)) === pin.sha256);
  const success = child.status === 0 && !child.error && observation?.status === 'passed' && protectedPointersUnchanged;
  const result = {schemaVersion: 'workspace-verification-run-v1', mode, root, runRoot, workspaceKey: options['--workspace-key'], runId: options['--run-id'],
    startedAt, finishedAt: new Date().toISOString(), childPid: child.pid, exitCode: child.status, signal: child.signal, error: child.error?.message,
    filters, protectedPointers: before, protectedPointersUnchanged, status: success ? 'passed' : 'failed', observedPaths: observationFile,
    nextOutput: env.PAX_BUILD_DIST_DIR, nextBuildExecuted: false};
  writeJson(path.join(runRoot, 'execution.json'), result);
  console.log(JSON.stringify({status: result.status, mode, runRoot: relative, childPid: child.pid, exitCode: child.status,
    counts: observation?.counts, protectedPointersUnchanged}, null, 2));
  if (!success) process.exitCode = 1;
}

try {
  if (process.argv[2] === '--internal-worker') await worker(process.argv[3]);
  else parent();
} catch (error) {console.error(error.stack || String(error)); process.exitCode = 1;}
