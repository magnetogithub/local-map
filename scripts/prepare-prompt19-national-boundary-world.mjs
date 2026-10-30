// Reconcile fine gameplay territories to one shared country/coast partition.
// This adjusts gameplay geometry; it does not rewrite the administrative sources.
import fs from 'node:fs';
import path from 'node:path';
import {digest, jsonBytes} from './prompt14-catalog-core.mjs';
import {reconcileNationalBoundaries} from './prompt19-national-boundary-reconciliation.mjs';

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw Error(`MISSING_ARGUMENT:${name}`);
  return process.argv[i + 1];
};
const input = option('--input', 'reports/maintenance/prompt19-C/fine-macro-2020-joined-world-input.json');
const cellsPath = option('--cells', 'reports/maintenance/prompt19-C/fine-macro-2020-joint-arrangement-cells.geojson');
const prefix = option('--output-prefix', 'reports/maintenance/prompt19-C/national-boundary-2020');
const read = file => JSON.parse(fs.readFileSync(file));
const identity = file => {const bytes = fs.readFileSync(file); return {path: file, sha256: digest(bytes), byteLength: bytes.length};};
const checked = artifact => {
  const actual = identity(artifact.path);
  if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) throw Error(`NATIONAL_BOUNDARY_INPUT_CHANGED:${artifact.path}`);
};
const bundle = read(input);
if (!bundle.report.fineMacro || bundle.report.nationalBoundaryReconciliation) throw Error('NATIONAL_BOUNDARY_REQUIRES_UNADJUSTED_FINE_MACRO_INPUT');
for (const artifact of [...bundle.report.sourceLockArtifacts, ...bundle.report.hierarchyArtifacts, ...Object.values(bundle.report.fineMacroInput)]) checked(artifact);
const result = reconcileNationalBoundaries({bundle, cells: read(cellsPath).features, onProgress: message => console.log(message)});
result.bundle.report.nationalBoundaryInput = {bundle: identity(input), cells: identity(cellsPath)};
const writeImmutable = (file, value) => {
  const bytes = jsonBytes(value);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (fs.existsSync(file)) {if (!fs.readFileSync(file).equals(bytes)) throw Error(`NATIONAL_BOUNDARY_IMMUTABLE_OUTPUT:${file}`);}
  else fs.writeFileSync(file, bytes, {flag: 'wx'});
};
writeImmutable(`${prefix}-joined-world-input.json`, result.bundle);
writeImmutable(`${prefix}-joint-arrangement-cells.geojson`, {type: 'FeatureCollection', features: result.cells});
writeImmutable(`${prefix}-reconciliation-verification.json`, {...result.evidence, summary: result.bundle.report.summary});
for (const countryId of ['KOR', 'PRK']) {
  const local = result.cells.filter(f => f.properties.countryId === countryId), key = digest(jsonBytes(local)).slice(0, 20);
  const root = `data/derived/prompt19/candidates/${countryId}/joined-${key}`;
  writeImmutable(`${root}/cells.geojson`, {type: 'FeatureCollection', features: local});
  writeImmutable(`${root}/verification.json`, {countryId, worldCoverageComplete: true, fineAssignmentComplete: false,
    summary: result.bundle.report.summary.find(s => s.countryId === countryId),
    sourceTrace: result.bundle.report.sourceTrace.filter(s => s.countryId === countryId),
    topology: result.bundle.report.topology, fineMacro: result.bundle.report.fineMacro,
    hierarchy: result.bundle.report.hierarchyArtifacts.find(a => a.countryId === countryId),
    nationalBoundaryInput: result.bundle.report.nationalBoundaryInput,
    nationalBoundaryReconciliation: result.evidence});
}
console.log(JSON.stringify({input, output: `${prefix}-joined-world-input.json`, summary: result.bundle.report.summary,
  sharedKoreaBorder: result.evidence.sharedKoreaBorderAfter, retained: result.evidence.retained.length}));
