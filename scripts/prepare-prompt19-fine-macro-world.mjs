// Promote shared fine boundaries into macro boundaries; never overlay a second ADM1 outline.
import fs from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {digest, jsonBytes} from './prompt14-catalog-core.mjs';
import {deriveFineMacroWorld} from './prompt19-fine-macro-topology.mjs';

const option = (name, fallback) => {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw Error(`MISSING_ARGUMENT:${name}`);
  return process.argv[i + 1];
};
const input = option('--input', 'reports/maintenance/prompt19-C/kor-adm2-2020-joined-world-input.json');
const cellsPath = option('--cells', 'reports/maintenance/prompt19-C/kor-adm2-2020-joint-arrangement-cells.geojson');
const prefix = option('--output-prefix', 'reports/maintenance/prompt19-C/fine-macro-2020');
const read = file => JSON.parse(fs.readFileSync(file));
const identity = file => {const bytes = fs.readFileSync(file); return {path: file, sha256: digest(bytes), byteLength: bytes.length};};
const checked = artifact => {
  const bytes = fs.readFileSync(artifact.path);
  if (bytes.length !== artifact.byteLength || digest(bytes) !== artifact.sha256) throw Error(`FINE_MACRO_INPUT_CHANGED:${artifact.path}`);
  return JSON.parse(bytes);
};
const pin = z.object({path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative()});
const groupSchema = z.object({macroId: z.string().min(1), sourceFeatureId: z.string().min(1), name: z.string().min(1), nameKo: z.string().nullable(), sourceVersion: z.string().min(1)}).passthrough();
const hierarchySchema = z.object({schemaVersion: z.literal('prompt19-fine-macro-hierarchy-v1'), countryId: z.enum(['KOR', 'PRK']),
  fineSourceLock: pin, artifacts: z.array(pin).min(1), macroGroups: z.array(groupSchema).min(1),
  members: z.array(z.object({sourceFeatureId: z.string().min(1), macroId: z.string().min(1), method: z.string().min(1)}).passthrough()).min(1),
  verification: z.object({complete: z.literal(true), unresolved: z.array(z.unknown()).length(0), sourceFeatures: z.number().int().positive()}).passthrough(),
}).passthrough();
const bundle = read(input), cells = read(cellsPath).features, crosswalks = {}, hierarchyArtifacts = [];
for (const countryId of ['KOR', 'PRK']) {
  const lockPath = option(`--${countryId.toLowerCase()}-hierarchy`, `data/source-locks/prompt19/${countryId}-macro-hierarchy.json`);
  const hierarchy = hierarchySchema.parse(read(lockPath));
  if (hierarchy.countryId !== countryId) throw Error('FINE_MACRO_HIERARCHY_COUNTRY');
  hierarchy.artifacts.forEach(a => {const bytes = fs.readFileSync(a.path); if (bytes.length !== a.byteLength || digest(bytes) !== a.sha256) throw Error('FINE_MACRO_HIERARCHY_ARTIFACT_CHANGED');});
  for (const a of hierarchy.preprocessing?.code ?? []) {const bytes = fs.readFileSync(a.path); if (bytes.length !== a.byteLength || digest(bytes) !== a.sha256) throw Error('FINE_MACRO_HIERARCHY_CODE_CHANGED');}
  const expected = bundle.report.sourceLockArtifacts.find(a => a.countryId === countryId);
  if (!expected || expected.path !== hierarchy.fineSourceLock.path || expected.sha256 !== hierarchy.fineSourceLock.sha256) throw Error('FINE_MACRO_SOURCE_LOCK_MISMATCH');
  const sourceLock = checked(hierarchy.fineSourceLock), original = checked(sourceLock.normalizedInput);
  const sourceIds = new Set(original.features.map(f => f.properties.sourceFeatureId));
  const groups = new Map(hierarchy.macroGroups.map(g => [g.macroId, g]));
  if (groups.size !== hierarchy.macroGroups.length || sourceIds.size !== hierarchy.members.length || sourceIds.size !== hierarchy.verification.sourceFeatures) throw Error('FINE_MACRO_HIERARCHY_COUNT');
  const assignments = new Map();
  for (const member of hierarchy.members) {
    const group = groups.get(member.macroId);
    if (!group || !sourceIds.has(member.sourceFeatureId) || assignments.has(member.sourceFeatureId)) throw Error('FINE_MACRO_HIERARCHY_MEMBERSHIP');
    assignments.set(member.sourceFeatureId, {...group});
  }
  if (assignments.size !== sourceIds.size) throw Error('FINE_MACRO_HIERARCHY_INCOMPLETE');
  crosswalks[countryId] = assignments;
  hierarchyArtifacts.push({countryId, ...identity(lockPath)});
}
const result = deriveFineMacroWorld({bundle, cells, crosswalks});
result.bundle.report.hierarchyArtifacts = hierarchyArtifacts;
result.bundle.report.fineMacroInput = {bundle: identity(input), cells: identity(cellsPath)};
const writeImmutable = (file, value) => {
  const bytes = jsonBytes(value);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  if (fs.existsSync(file)) {if (!fs.readFileSync(file).equals(bytes)) throw Error(`FINE_MACRO_IMMUTABLE_OUTPUT:${file}`);}
  else fs.writeFileSync(file, bytes, {flag: 'wx'});
};
writeImmutable(`${prefix}-joined-world-input.json`, result.bundle);
writeImmutable(`${prefix}-joint-arrangement-cells.geojson`, {type: 'FeatureCollection', features: result.cells});
writeImmutable(`${prefix}-quotient-verification.json`, {...result.evidence, summary: result.bundle.report.summary});
for (const countryId of ['KOR', 'PRK']) {
  const local = result.cells.filter(f => f.properties.countryId === countryId), key = digest(jsonBytes(local)).slice(0, 20);
  const root = `data/derived/prompt19/candidates/${countryId}/joined-${key}`;
  writeImmutable(`${root}/cells.geojson`, {type: 'FeatureCollection', features: local});
  writeImmutable(`${root}/verification.json`, {countryId, worldCoverageComplete: true, fineAssignmentComplete: false,
    summary: result.bundle.report.summary.find(s => s.countryId === countryId), sourceTrace: result.bundle.report.sourceTrace.filter(s => s.countryId === countryId),
    topology: result.bundle.report.topology, hierarchy: hierarchyArtifacts.find(a => a.countryId === countryId), fineMacro: result.evidence});
}
console.log(JSON.stringify({input, output: `${prefix}-joined-world-input.json`, summary: result.bundle.report.summary, quotient: result.evidence}));
