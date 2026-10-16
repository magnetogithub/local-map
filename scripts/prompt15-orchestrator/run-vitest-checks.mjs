import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inside, atomicJSON, resolveInside} from './protocol.mjs';
import {identity} from './verification-stages.mjs';
import {runBoundedCommand} from './bounded-output.mjs';

export async function runVitestChecks(root, outputDirectory, files) {
  root = fs.realpathSync(root); outputDirectory = path.resolve(root, outputDirectory);
  const bases = ['reports', '.tmp'].map(name => path.join(root, name));
  if (!bases.some(base => inside(base, outputDirectory) && outputDirectory !== base)) throw Error('Use a fresh report/scratch output within the workspace');
  resolveInside(root, outputDirectory);
  // Validate existing ancestors too; a fresh destination must not traverse a link.
  let ancestor = path.dirname(outputDirectory);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  resolveInside(root, ancestor);
  if (!Array.isArray(files) || !files.length) throw Error('Specify exact test files; implicit workspace discovery is forbidden');
  const resolved = files.map(file => resolveInside(root, file));
  if (new Set(resolved.map(file => file.toLowerCase())).size !== files.length || resolved.some(file => !/\.(?:[cm]?[jt]s|tsx)$/.test(file) || /[*?{}\[\]!]/.test(file))) throw Error('Invalid/duplicate test files');
  const selected = resolved.map(file => path.relative(root, file).replaceAll('\\', '/'));
  const config = path.join(root, 'vitest.prompt15.config.ts');
  const cli = path.join(root, 'node_modules/vitest/vitest.mjs');
  const reporter = path.join(root, 'scripts/prompt15-orchestrator/compact-vitest-reporter.mjs');
  const inputs = await Promise.all([process.execPath, cli, config, reporter, fileURLToPath(import.meta.url),
    path.join(root, 'package.json'), path.join(root, 'package-lock.json'), ...resolved].map(file=>identity(fs.realpathSync(file))));
  if (fs.existsSync(outputDirectory)) throw Error('Use a fresh output directory; preserve old evidence');
  fs.mkdirSync(outputDirectory, {recursive: true});
  const temporaryDirectory=path.join(outputDirectory,'temp');fs.mkdirSync(temporaryDirectory);
  atomicJSON(path.join(outputDirectory, 'test-inputs.json'), {version: 1, selected, inputs});
  const command = [process.execPath, cli, 'run', '--config', config, '--configLoader', 'native'];
  const execution = await runBoundedCommand({command, cwd: root, logPrefix: path.join(outputDirectory, 'tests'),
    env: {PROMPT15_TEST_FILES: JSON.stringify(selected), PROMPT15_TEST_OUTPUT: outputDirectory, NODE_TEST_CONTEXT: undefined,TMPDIR:temporaryDirectory,TMP:temporaryDirectory,TEMP:temporaryDirectory}});
  let tests = null;
  try { tests = JSON.parse(fs.readFileSync(execution.stdout.path, 'utf8')); } catch { /* incomplete reporter output cannot pass */ }
  const after = await Promise.all(inputs.map(input => identity(input.path)));
  const inputsUnchanged = JSON.stringify(inputs) === JSON.stringify(after);
  const actual = tests?.files?.map(file => path.resolve(file).toLowerCase()).sort();
  const allFilesExecuted = JSON.stringify(actual) === JSON.stringify(resolved.map(file => file.toLowerCase()).sort());
  const result = {version: 1, kind: 'vitest', pass: execution.exitCode === 0 && !execution.signal && tests?.complete === true && tests?.pass === true && inputsUnchanged && allFilesExecuted,
    command, execution, tests, inputsUnchanged, allFilesExecuted, inputManifest: await identity(path.join(outputDirectory, 'test-inputs.json')),
    scope: 'Exact listed test files only; transitive input closure and whole REVIEW acceptance require the independent stage journal', independentReviewIssued: false};
  atomicJSON(path.join(outputDirectory, 'result.json'), result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, ...files] = process.argv.slice(2);
  const result = await runVitestChecks(process.cwd(), directory, files);
  console.log(JSON.stringify({pass: result.pass, counts: result.tests?.counts, result: path.resolve(directory, 'result.json')}));
  process.exitCode = result.pass ? 0 : 1;
}
