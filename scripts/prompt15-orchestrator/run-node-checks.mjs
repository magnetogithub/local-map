import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {inside, atomicJSON} from './protocol.mjs';
import {identity} from './verification-stages.mjs';
import {runBoundedCommand} from './bounded-output.mjs';

const reporter = fileURLToPath(new URL('./compact-test-reporter.mjs', import.meta.url));
export async function runNodeChecks(root, outputDirectory, files) {
  root = path.resolve(root); outputDirectory = path.resolve(root, outputDirectory);
  if (![path.join(root, 'reports'), path.join(root, '.tmp')].some(base => inside(base, outputDirectory) && outputDirectory !== base)) throw Error('Use a fresh report/scratch output within the workspace');
  if (!Array.isArray(files) || !files.length) throw Error('Specify the exact test files; implicit workspace discovery is forbidden');
  const resolved = files.map(file => path.resolve(root, file));
  if (new Set(resolved.map(file => file.toLowerCase())).size !== files.length || resolved.some(file => !inside(root, file) || !file.endsWith('.mjs'))) throw Error('Invalid/duplicate test files');
  const inputs = await Promise.all([process.execPath, reporter, ...resolved].map(identity));
  if (fs.existsSync(outputDirectory)) throw Error('Use a fresh output directory; preserve old evidence');
  fs.mkdirSync(outputDirectory, {recursive: true});
  const scratch = path.join(outputDirectory, 'scratch'); fs.mkdirSync(scratch);
  atomicJSON(path.join(outputDirectory, 'test-inputs.json'), {version: 1, inputs});
  const command = [process.execPath, '--test', '--test-concurrency=1', `--test-reporter=${pathToFileURL(reporter).href}`, ...resolved];
  const execution = await runBoundedCommand({command, cwd: root, logPrefix: path.join(outputDirectory, 'tests'),
    env: {NODE_TEST_CONTEXT: undefined, PROMPT15_TEST_SCRATCH: scratch, PROMPT15_R9_TEST_OUTPUT: scratch}});
  let tests = null;
  try { tests = JSON.parse(fs.readFileSync(execution.stdout.path, 'utf8')); } catch { /* missing/malformed reporter result is never a PASS */ }
  const after = await Promise.all(inputs.map(input => identity(input.path)));
  const inputsUnchanged = JSON.stringify(inputs) === JSON.stringify(after);
  const result = {version: 1, kind: 'node-test', pass: execution.exitCode === 0 && !execution.signal && tests?.pass === true && inputsUnchanged,
    command, execution, tests, inputsUnchanged, inputManifest: await identity(path.join(outputDirectory, 'test-inputs.json')),
    scope: 'Exact listed test files only; transitive input closure and whole REVIEW acceptance require the independent stage journal', independentReviewIssued: false};
  atomicJSON(path.join(outputDirectory, 'result.json'), result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, ...files] = process.argv.slice(2);
  const result = await runNodeChecks(process.cwd(), directory, files);
  console.log(JSON.stringify({pass: result.pass, counts: result.tests?.counts, result: path.resolve(directory, 'result.json')}));
  process.exitCode = result.pass ? 0 : 1;
}
