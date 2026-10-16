import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createFreezeReceipt, policyIdentity} from './policy-validation.mjs';

// No result-file/threshold overrides: this command seals criteria, never scores experiments.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [command, manifestName, outputName, ...extra] = process.argv.slice(2);
if (command !== 'freeze' || !manifestName || !outputName || extra.length) {
  throw new Error('Usage: node scripts/operational-cells/policy-cli.mjs freeze .reports/input-manifest.json .reports/freeze-receipt.json');
}
const reports = fs.realpathSync(path.join(root, '.reports'));
function reportFile(name, mustExist) {
  const file = path.resolve(root, name);
  const relative = path.relative(reports, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('REPORT_PATH_REQUIRED');
  const parent = fs.realpathSync(path.dirname(file));
  const physical = path.relative(reports, parent);
  if (physical.startsWith('..') || path.isAbsolute(physical)) throw new Error('REPORT_PATH_ESCAPE');
  if (mustExist && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error('REGULAR_FILE_REQUIRED');
  return file;
}
const manifest = JSON.parse(fs.readFileSync(reportFile(manifestName, true), 'utf8'));
if (manifest.version !== 1 || !Array.isArray(manifest.inputs) || !manifest.inputs.length) throw new Error('INPUT_MANIFEST_REQUIRED');
for (const pin of manifest.inputs) {
  const bytes = fs.readFileSync(pin.path);
  if (bytes.length !== pin.byteLength || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new Error('INPUT_CHANGED');
}
const receipt = createFreezeReceipt(manifest.inputs);
fs.writeFileSync(reportFile(outputName, false), `${JSON.stringify(receipt, null, 2)}\n`, {flag: 'wx'});
process.stdout.write(`${JSON.stringify({kind: 'criteria-sealed', ...policyIdentity, candidateResultsConsumed: 0})}\n`);
