// A/B use the same CLI after acquiring a real fine source and writing its source lock.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {digest, hashCanonical, jsonBytes} from './prompt14-catalog-core.mjs';
import {buildPrompt19CountryCandidate, prompt19Country, prompt19SourceLockSchema} from './prompt19-country-core.mjs';
import {createPrompt19CandidateDirectory, resolvePrompt19Input} from './prompt19-country-files.mjs';

export const PROMPT19_GENERATOR_FILES = ['scripts/prepare-prompt19-country.mjs', 'scripts/prompt19-country-core.mjs',
  'scripts/prompt19-country-files.mjs', 'scripts/prompt14-catalog-core.mjs', 'scripts/prompt14-catalog-topology.mjs', 'scripts/prompt14-source-gate.mjs', 'scripts/prompt14-exact-ring.mjs', 'package-lock.json'];
export function preparePrompt19Country(countryId, root = process.cwd()) {
  prompt19Country.parse(countryId);
  const read = (file, scope) => fs.readFileSync(resolvePrompt19Input(root, file, scope));
  const json = file => JSON.parse(read(file));
  const checked = (pin, scope) => {const bytes = read(pin.path, scope); if (bytes.length !== pin.byteLength || digest(bytes) !== pin.sha256) throw Error(`PROMPT19_INPUT_IDENTITY: ${pin.path}`); return bytes;};
  const handoff = json('reports/maintenance/prompt19-handoff.json');
  if (handoff.schemaVersion !== 'prompt19-handoff-v1' || handoff.baseline.root !== 'data/derived/prompt19/baseline-v1') throw Error('PROMPT19_HANDOFF_REQUIRED');
  if (!Array.isArray(handoff.commonGenerator.files) || PROMPT19_GENERATOR_FILES.some(file => !handoff.commonGenerator.files.some(pin => pin.path === file))) throw Error('PROMPT19_GENERATOR_CONTRACT_REQUIRED');
  handoff.commonGenerator.files.forEach(pin => checked(pin));
  const current = json('data/runtime/operational-catalog/current.json');
  if (current.catalogVersion !== handoff.coarseWorld.catalogVersion || current.index.sha256 !== handoff.coarseWorld.artifactIndex.sha256) throw Error('PROMPT19_COARSE_PREDECESSOR_CHANGED');
  const baselineIdentity = handoff.baseline.artifactIndex;
  const index = JSON.parse(checked(baselineIdentity));
  const baseline = file => {
    const a = index.artifacts.find(a => a.path === file); if (!a) throw Error('PROMPT19_BASELINE_PIN_REQUIRED');
    return JSON.parse(checked({...a, path: `${handoff.baseline.root}/${a.path}`}));
  };
  const lockPath = `data/source-locks/prompt19/${countryId}.json`;
  const sourceLockBytes = read(lockPath), sourceLock = prompt19SourceLockSchema.parse(JSON.parse(sourceLockBytes));
  if (sourceLock.countryId !== countryId) throw Error('PROMPT19_SOURCE_LOCK_COUNTRY');
  const sourcePrefix = `data/raw/prompt19/${countryId}/`, codePrefix = `scripts/prompt19/${countryId}/`;
  for (const pin of sourceLock.sources.map(s => s.artifact)) {
    if (!pin.path.startsWith(sourcePrefix)) throw Error('PROMPT19_RAW_INPUT_COUNTRY_SCOPE'); checked(pin, sourcePrefix.slice(0, -1));
  }
  if (!sourceLock.normalizedInput.path.startsWith(sourcePrefix)) throw Error('PROMPT19_RAW_INPUT_COUNTRY_SCOPE');
  const normalizedBytes = checked(sourceLock.normalizedInput, sourcePrefix.slice(0, -1));
  for (const pin of sourceLock.preprocessing.code) {
    if (!pin.path.startsWith(codePrefix)) throw Error('PROMPT19_ADAPTER_COUNTRY_SCOPE'); checked(pin, codePrefix.slice(0, -1));
  }
  const candidate = buildPrompt19CountryCandidate({countryId, sourceLock, normalized: JSON.parse(normalizedBytes), baselineIdentity,
    envelope: baseline('country-envelopes.geojson').features.find(f => f.properties.countryId === countryId),
    coarseParents: baseline('coarse-parents.geojson').features.filter(f => f.properties.countryId === countryId)});
  const code = handoff.commonGenerator.files.map(pin => ({path: pin.path, sha256: pin.sha256}));
  const key = hashCanonical('prompt19-country-candidate-output.v1', {countryId, sourceLockSha256: digest(sourceLockBytes), baselineIdentity, code}).slice(0, 20);
  const {relative, output} = createPrompt19CandidateDirectory(root, countryId, key);
  const artifacts = [];
  const write = (file, value) => {const bytes = jsonBytes(value); fs.writeFileSync(path.join(output, file), bytes, {flag: 'wx'}); artifacts.push({path: file, sha256: digest(bytes), byteLength: bytes.length});};
  write('cells.geojson', candidate.cells); write('topology.json', candidate.topology); write('residuals.geojson', candidate.residuals);
  write('validation.json', candidate.validation);
  write('manifest.json', {schemaVersion: candidate.schemaVersion, countryId, status: candidate.status, baselineIdentity,
    sourceLock: {path: lockPath, sha256: digest(sourceLockBytes), byteLength: sourceLockBytes.length}, code,
    totals: candidate.validation.totals, runtimePublication: false, globalOrdinalsAssigned: false, sourceLockCanonicalSha256: candidate.sourceLockSha256});
  fs.writeFileSync(path.join(output, 'artifact-index.json'), jsonBytes({schemaVersion: candidate.schemaVersion, artifacts}), {flag: 'wx'});
  return {root: relative, status: candidate.status, totals: candidate.validation.totals, pass: candidate.validation.pass};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = preparePrompt19Country(process.argv[2]); console.log(JSON.stringify(result)); if (!result.pass) process.exitCode = 2;
}
