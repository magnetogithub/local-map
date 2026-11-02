// Complete the remaining western gameplay sector from actual fine contact lines.
// Raw administrative source artifacts and all existing fine land remain intact.
import fs from 'node:fs';
import path from 'node:path';
import {digest, jsonBytes} from './prompt14-catalog-core.mjs';
import {reconcileWesternSector} from './prompt19-western-sector-reconciliation.mjs';

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw Error(`MISSING_ARGUMENT:${name}`);
  return process.argv[i + 1];
};
const input = option('--input', 'reports/maintenance/prompt19-C/boundary-cleanup-2020-joined-world-input.json');
const cellsPath = option('--cells', 'reports/maintenance/prompt19-C/boundary-cleanup-2020-joint-arrangement-cells.geojson');
const prefix = option('--output-prefix', 'reports/maintenance/prompt19-C/western-sector-2020');
const read = file => JSON.parse(fs.readFileSync(file));
const identity = file => {const bytes = fs.readFileSync(file); return {path: file, sha256: digest(bytes), byteLength: bytes.length};};
const checked = artifact => {
  const actual = identity(artifact.path);
  if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) throw Error(`WESTERN_SECTOR_INPUT_CHANGED:${artifact.path}`);
};
const bundle = read(input);
if (!bundle.report.nationalBoundaryReconciliation?.cleanupBoundarySlivers || bundle.report.westernSectorReconciliation) throw Error('WESTERN_SECTOR_REQUIRES_CLEANED_INPUT');
for (const artifact of [...bundle.report.sourceLockArtifacts, ...bundle.report.hierarchyArtifacts,
  ...Object.values(bundle.report.fineMacroInput), ...Object.values(bundle.report.nationalBoundaryInput)]) checked(artifact);
const result = reconcileWesternSector({bundle, cells: read(cellsPath).features, onProgress: message => console.log(message)});
result.bundle.report.westernSectorInput = {bundle: identity(input), cells: identity(cellsPath)};
const writeImmutable = (file, value) => {
  const bytes = jsonBytes(value);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (fs.existsSync(file)) {if (!fs.readFileSync(file).equals(bytes)) throw Error(`WESTERN_SECTOR_IMMUTABLE_OUTPUT:${file}`);}
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
    nationalBoundaryReconciliation: result.bundle.report.nationalBoundaryReconciliation,
    westernSectorInput: result.bundle.report.westernSectorInput, westernSectorReconciliation: result.evidence});
}
console.log(JSON.stringify({input, output: `${prefix}-joined-world-input.json`, summary: result.bundle.report.summary,
  sharedKoreaBorder: result.bundle.report.nationalBoundaryReconciliation.sharedKoreaBorderAfter,
  remainingDmzResiduals: result.bundle.report.nationalBoundaryReconciliation.remainingDmzResiduals.length}));
