import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync, gunzipSync} from 'node:zlib';
import {compareText, digest, jsonBytes} from './prompt14-catalog-core.mjs';

// Assembly only. Never import a generator, overlay, source loader, or proof runner.
export const VERSION = 'prompt15-sliver-adoption-draft-v1';
export const STATUS = 'DRAFT_CATALOG_PREPARED_PENDING_VALIDATION';
export const MANIFEST_PIN = Object.freeze({
  path: 'reports/prompt15/15-22-sliver-closeout/20261028-closeout-d017f7145d/adoption-manifest.json',
  sha256: '72a6d926c165fc02ee16cbea0022d11e9ee3ea1415cec3df2fcfeb107bb5ad87', byteLength: 70659,
});
const EXPECTED = Object.freeze({countries: 247, selectedCountries: 23, replacements: 16, retained: 231,
  baselineCells: 923443, originalSelectedCells: 913, selectedCells: 883, cells: 923413});
const ID = /^territory:catalog:[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const SCHEMA = 'prompt15-task-15-19-world-catalog-v1';
const entryKeys = ['id', 'sourceCountryId', 'oldTerritoryId', 'adminId', 'parentKey', 'parentSourceFeatureId',
  'sourceComponentHash', 'componentIndex', 'sourceTiny', 'refined', 'areaKm2', 'diameterKm', 'bbox', 'centroid'];
const featureKeys = ['sourceCountryId', 'oldTerritoryId', 'adminId', 'parentKey', 'parentSourceFeatureId', 'componentIndex', 'refined'];
const ownershipKeys = ['parentKey', 'oldTerritoryId', 'componentIndex', 'sourceComponentHash'];
const assert = (condition, message) => {if (!condition) throw Error(message);};
const same = (a, b) => jsonBytes(a).equals(jsonBytes(b));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const readGzip = file => JSON.parse(gunzipSync(fs.readFileSync(file)));
const writeJSON = (file, value) => fs.writeFileSync(file, jsonBytes(value), {flag: 'wx'});

export function safeRelative(value) {
  assert(typeof value === 'string' && value.length > 0 && !value.includes('\\') &&
    !value.includes(':') && !value.includes('\0') && !path.posix.isAbsolute(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..'), `Unsafe relative path: ${value}`);
  return value;
}
export function resolveInput(workspace, relative) {
  const full = path.resolve(workspace, safeRelative(relative));
  const real = fs.realpathSync(full), root = fs.realpathSync(workspace);
  assert(path.relative(root, real) && !path.relative(root, real).startsWith('..') &&
    !path.isAbsolute(path.relative(root, real)), `Input escapes workspace: ${relative}`);
  assert(fs.statSync(real).isFile(), `Input is not a file: ${relative}`);
  return full;
}
export function identity(workspace, relative) {
  const file = resolveInput(workspace, relative), hash = fs.readFileSync(file);
  return {path: relative, sha256: digest(hash), byteLength: hash.length};
}
export function verifyPin(workspace, pin) {
  assert(pin && HASH.test(pin.sha256) && Number.isSafeInteger(pin.byteLength) && pin.byteLength >= 0,
    `Malformed input pin: ${pin?.path}`);
  const actual = identity(workspace, pin.path);
  assert(actual.sha256 === pin.sha256 && actual.byteLength === pin.byteLength, `Input identity mismatch: ${pin.path}`);
  return actual;
}
export function collectPins(value, result = new Map()) {
  if (!value || typeof value !== 'object') return result;
  if (typeof value.path === 'string' && ('sha256' in value || 'byteLength' in value)) {
    safeRelative(value.path);
    assert(HASH.test(value.sha256) && Number.isSafeInteger(value.byteLength), `Incomplete pin: ${value.path}`);
    const pin = {path: value.path, sha256: value.sha256, byteLength: value.byteLength}, prior = result.get(pin.path);
    assert(!prior || same(prior, pin), `Conflicting input pins: ${pin.path}`);
    result.set(pin.path, pin);
  }
  for (const child of Object.values(value)) collectPins(child, result);
  return result;
}
function addPin(pins, pin) {
  collectPins(pin, pins);
}
export function validatePlan(manifest, directory, expected = EXPECTED) {
  const order = directory.countryOrder;
  assert(Array.isArray(order) && order.length === expected.countries && new Set(order).size === order.length &&
    order.every(c => /^[A-Z0-9]{3}$/.test(c)), 'Invalid fixed country directory');
  assert(directory.cellCount === expected.baselineCells, 'Baseline cell census mismatch');
  const selections = manifest.changedCountrySelections;
  assert(Array.isArray(selections) && selections.length === expected.selectedCountries, 'Wrong selection country count');
  const selected = new Map(); let replacements = 0, count = 0, original = 0;
  for (const item of selections) {
    assert(order.includes(item.countryId) && !selected.has(item.countryId), `Unknown/duplicate country: ${item.countryId}`);
    const kind = item.selectedCellInput?.kind;
    assert(['REPLACE_WITH_PINNED_LOCAL_PROPOSAL', 'RETAIN_BASELINE_GEOMETRY_ASSETS'].includes(kind), `Invalid selection kind: ${kind}`);
    assert((kind === 'REPLACE_WITH_PINNED_LOCAL_PROPOSAL') === item.selectedGeometryReplacementRequired, `Inconsistent selection: ${item.countryId}`);
    assert(item.selectedV2Sliver === 'PASS_REUSED' && item.unresolvedProblems?.length === 0 &&
      item.alreadyAdopted === false, `Unready selection: ${item.countryId}`);
    assert(Number.isSafeInteger(item.selectedCellInput.cellCount) && item.selectedCellInput.cellCount > 0 &&
      Number.isSafeInteger(item.originalCellCount), `Bad country census: ${item.countryId}`);
    replacements += Number(item.selectedGeometryReplacementRequired);
    count += item.selectedCellInput.cellCount; original += item.originalCellCount; selected.set(item.countryId, item);
  }
  const rest = manifest.remainingBaselineCountries;
  assert(Array.isArray(rest.countryIds) && rest.count === rest.countryIds.length && new Set(rest.countryIds).size === rest.count &&
    rest.countryIds.every(c => order.includes(c) && !selected.has(c)) && rest.count + selected.size === order.length,
  'Remaining countries do not form an exact disjoint partition');
  assert(replacements === expected.replacements && order.length - replacements === expected.retained &&
    count === expected.selectedCells && original === expected.originalSelectedCells &&
    count - original === manifest.plannedCellDelta && directory.cellCount + manifest.plannedCellDelta === expected.cells,
  'Selection census mismatch');
  return selected;
}
function validateEntry(entry, countryId) {
  assert(entryKeys.every(key => Object.hasOwn(entry, key)), `Incomplete catalog entry: ${entry.id}`);
  assert(ID.test(entry.id) && entry.sourceCountryId === countryId && entry.parentKey?.startsWith(`${countryId}:`) &&
    ID.test(entry.oldTerritoryId) && HASH.test(entry.sourceComponentHash) && Number.isSafeInteger(entry.componentIndex) &&
    entry.componentIndex >= 0 && typeof entry.sourceTiny === 'boolean' && typeof entry.refined === 'boolean',
  `Invalid identity/parent: ${entry.id}`);
  assert(entry.parentKey === `${countryId}:${entry.parentSourceFeatureId}` &&
    (entry.adminId === null || entry.adminId === entry.parentSourceFeatureId), `Invalid parent relation: ${entry.id}`);
  assert(entry.areaKm2 > 0 && Number.isFinite(entry.areaKm2) && entry.diameterKm > 0 && Number.isFinite(entry.diameterKm) &&
    entry.bbox?.length === 4 && entry.bbox.every(Number.isFinite) && entry.centroid?.length === 2 && entry.centroid.every(Number.isFinite),
  `Invalid catalog scalar schema: ${entry.id}`);
}
export function validateAssets(catalog, collection, countryId) {
  assert(catalog.schemaVersion === SCHEMA && catalog.policyVersion === 'prompt15-cell-experiment-v6' &&
    catalog.countryId === countryId && Array.isArray(catalog.entries) && catalog.entries.length > 0, `Invalid catalog schema: ${countryId}`);
  assert(collection.type === 'FeatureCollection' && Array.isArray(collection.features) &&
    collection.features.length === catalog.entries.length, `Geometry/catalog count mismatch: ${countryId}`);
  const entries = new Map();
  for (const entry of catalog.entries) {
    validateEntry(entry, countryId);
    assert(!entries.has(entry.id), `Duplicate catalog ID: ${entry.id}`); entries.set(entry.id, entry);
  }
  const geometries = new Map();
  for (const feature of collection.features) {
    const id = feature.properties?.cellId, entry = entries.get(id);
    assert(feature.type === 'Feature' && entry && !geometries.has(id), `Missing/duplicate geometry ID: ${id}`);
    assert(featureKeys.every(k => same(feature.properties[k], entry[k])), `Geometry/catalog identity mismatch: ${id}`);
    assert(['Polygon', 'MultiPolygon'].includes(feature.geometry?.type) && Array.isArray(feature.geometry.coordinates), `Invalid geometry schema: ${id}`);
    geometries.set(id, feature.geometry);
  }
  return {entries, geometries};
}
export function validateCorrespondence(correspondence, original, selected, countryId) {
  const mapped = new Set(), used = new Set();
  assert(correspondence.mode === 'MERGED_OR_IDENTITY' &&
    (correspondence.complete === true || (correspondence.allOriginalCellsUsedExactlyOnce === true &&
      correspondence.allProposalCellsMappedExactlyOnce === true)), `Incomplete correspondence: ${countryId}`);
  assert(Array.isArray(correspondence.mapping), `Missing correspondence: ${countryId}`);
  for (const row of correspondence.mapping) {
    const target = selected.entries.get(row.selectedCellId);
    assert(target && !mapped.has(target.id) && ownershipKeys.every(k => same(row[k], target[k])), `Wrong selected correspondence: ${row.selectedCellId}`);
    assert(digest(jsonBytes(selected.geometries.get(target.id))) === row.selectedGeometryHash, `Selected geometry hash mismatch: ${target.id}`);
    assert(Array.isArray(row.originalCells) && row.originalCells.length > 0, `Empty original correspondence: ${target.id}`);
    for (const old of row.originalCells) {
      const source = original.entries.get(old.id);
      assert(source && !used.has(old.id) && ownershipKeys.every(k => same(source[k], target[k])) &&
        source.sourceCountryId === countryId && source.adminId === target.adminId && source.parentSourceFeatureId === target.parentSourceFeatureId &&
        source.sourceTiny === target.sourceTiny,
      `Wrong/duplicate original correspondence: ${old.id}`);
      assert(digest(jsonBytes(original.geometries.get(old.id))) === old.geometryHash, `Original geometry hash mismatch: ${old.id}`);
      used.add(old.id);
    }
    mapped.add(target.id);
  }
  assert(used.size === original.entries.size && mapped.size === selected.entries.size, `Correspondence omissions: ${countryId}`);
  return {originalCells: used.size, selectedCells: mapped.size, complete: true};
}
export function serializeReplacement(cells, baselineCatalog, correspondence, baselineGeometry) {
  const countryId = baselineCatalog.countryId;
  assert(Array.isArray(cells) && cells.length > 0, `Empty selected cells: ${countryId}`);
  const entries = cells.map(cell => {
    assert(cell.countryId === countryId, `Wrong proposal country: ${cell.id}`);
    const entry = Object.fromEntries(entryKeys.map(key => [key, key === 'diameterKm' ? cell.diameterUpperBoundKm : cell[key]]));
    validateEntry(entry, countryId); return entry;
  });
  const catalog = {schemaVersion: baselineCatalog.schemaVersion, policyVersion: baselineCatalog.policyVersion,
    candidateId: baselineCatalog.candidateId, countryId, entries};
  const geometry = {type: 'FeatureCollection', features: cells.map(cell => ({type: 'Feature',
    properties: {cellId: cell.id, ...Object.fromEntries(featureKeys.map(k => [k, cell[k]]))}, geometry: cell.geometry}))};
  const original = validateAssets(baselineCatalog, baselineGeometry, countryId), selected = validateAssets(catalog, geometry, countryId);
  const census = validateCorrespondence(correspondence, original, selected, countryId);
  return {catalog, geometry, census};
}
export const gzipJSON = value => gzipSync(jsonBytes(value), {level: 9, mtime: 0});
export function assertFreshOutput(root) {assert(!fs.existsSync(root), `Refusing existing output: ${root}`);}
export function claimWorldIds(allIds, ids) {
  for (const id of ids) {assert(!allIds.has(id), `World ID collision: ${id}`); allIds.add(id);}
}
function codeClosure(workspace) {
  const files = new Map(), visit = relative => {
    if (files.has(relative)) return;
    const pin = identity(workspace, relative); files.set(relative, pin);
    const source = fs.readFileSync(resolveInput(workspace, relative), 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([.][^'"]+)['"]/g)) {
      const next = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1])); visit(next);
    }
  };
  visit('scripts/prompt15-sliver-adoption-draft.mjs');
  visit('scripts/prompt15-sliver-adoption-draft.node-test.mjs');
  return [...files.values()].sort((a, b) => compareText(a.path, b.path));
}
export function intake(workspace) {
  verifyPin(workspace, MANIFEST_PIN);
  const manifest = readJSON(resolveInput(workspace, MANIFEST_PIN.path));
  assert(manifest.schemaVersion === 'prompt15-sliver-adoption-input-manifest-v1', 'Unexpected manifest version');
  const pins = collectPins(manifest); addPin(pins, MANIFEST_PIN);
  const closeout = path.posix.dirname(MANIFEST_PIN.path);
  for (const file of ['summary.json', 'country-closeout.json', 'final-code.json']) addPin(pins, identity(workspace, `${closeout}/${file}`));
  for (const file of ['AGENTS.md', 'prompts/PROMPT_15_OPERATIONAL_MICRO_TERRITORIES_AND_PARTIAL_FRONTS.txt',
    'docs/automation/prompt15-numerical-deferral.json', 'docs/automation/prompt15-task-15-22.md', 'package-lock.json']) addPin(pins, identity(workspace, file));
  const priorCode = readJSON(resolveInput(workspace, `${closeout}/final-code.json`));
  for (const pin of priorCode.files) {verifyPin(workspace, pin); addPin(pins, pin);}
  // Pins inside the adoption plan are additional required receipts, not replacement source geometry.
  collectPins(readJSON(resolveInput(workspace, manifest.adoptionPlan.path)).inputs, pins);
  const base = path.posix.dirname(manifest.baseArtifactIndexes.catalog.path);
  const directory = readJSON(resolveInput(workspace, manifest.worldDirectory.path)), selected = validatePlan(manifest, directory);
  assert(directory.schemaVersion === SCHEMA, 'Unknown baseline serialization schema');
  const index = readJSON(resolveInput(workspace, manifest.baseArtifactIndexes.catalog.path)), artifacts = new Map();
  for (const item of index.artifacts) {
    safeRelative(item.path); assert(!artifacts.has(item.path), `Duplicate baseline artifact: ${item.path}`);
    artifacts.set(item.path, item); addPin(pins, {...item, path: `${base}/${item.path}`});
  }
  assert(index.root === base && index.totalByteLength === index.artifacts.reduce((n, a) => n + a.byteLength, 0), 'Invalid baseline index');
  for (const country of directory.countryOrder) for (const name of ['catalog.json.gz', 'geometry.geojson.gz', 'generation.json.gz'])
    assert(artifacts.has(`countries/${country}/${name}`), `Missing baseline artifact: ${country}/${name}`);
  for (const item of selected.values()) {
    if (item.selectedGeometryReplacementRequired) {
      assert(item.mergeEvidence && item.verificationEvidence.length > 0 && item.cellCorrespondence, `Incomplete replacement evidence: ${item.countryId}`);
    } else {
      assert(item.selectedCellInput.file.path === `${base}/countries/${item.countryId}/geometry.geojson.gz` &&
        item.selectedCellInput.catalog.path === `${base}/countries/${item.countryId}/catalog.json.gz`, `Retain selection redirects baseline: ${item.countryId}`);
    }
  }
  const code = codeClosure(workspace); for (const pin of code) addPin(pins, pin);
  const inputs = [...pins.values()].sort((a, b) => compareText(a.path, b.path));
  for (const pin of inputs) verifyPin(workspace, pin);
  const runtime = {node: process.version, zlib: process.versions.zlib};
  const contentIdentity = {version: VERSION, inputs, code, runtime};
  const contentHash = digest(Buffer.concat([Buffer.from(`${VERSION}\0`), jsonBytes(contentIdentity)]));
  return {manifest, selected, directory, artifacts, base, inputs, code, runtime, contentHash};
}
function snapshotChanges(workspace, pins) {
  return pins.flatMap(pin => {
    try {const actual = identity(workspace, pin.path); return same(actual, pin) ? [] : [{before: pin, after: actual}];}
    catch (error) {return [{before: pin, error: error.message}];}
  });
}
export function assemble(workspace, evidenceRelative, verified) {
  safeRelative(evidenceRelative);
  assert(evidenceRelative.startsWith('reports/prompt15/15-22-sliver-adoption/'), 'Evidence must use the dedicated report tree');
  const evidence = path.resolve(workspace, evidenceRelative); assertFreshOutput(evidence); fs.mkdirSync(evidence, {recursive: true});
  const state = verified ?? intake(workspace), {manifest, directory, selected, base, inputs, code, contentHash, runtime} = state;
  writeJSON(path.join(evidence, 'before.json'), {inputs, code, contentHash});
  const name = `15-19-sliver-adoption-draft-v1-${contentHash.slice(0,20)}`;
  const relative = `data/derived/prompt15/${name}`, root = path.resolve(workspace, relative);
  const staging = path.resolve(workspace, `data/derived/prompt15/.${name}.staging`);
  const artifacts = [], countries = [], allIds = new Set(), countryRoots = {};
  let cellCount = 0, selectedCount = 0, originalSelectedCount = 0, copiedAssets = 0;
  try {
    assertFreshOutput(root); assertFreshOutput(staging); fs.mkdirSync(staging);
    const write = (rel, bytes, compression = null) => {
      safeRelative(rel); const target = path.join(staging, rel); fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, bytes, {flag: 'wx'}); artifacts.push({path: rel, sha256: digest(bytes), byteLength: bytes.length, compression});
    };
    const copy = (sourcePin, rel, compression) => {
      verifyPin(workspace, sourcePin); const target = path.join(staging, rel); fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.copyFileSync(resolveInput(workspace, sourcePin.path), target, fs.constants.COPYFILE_EXCL);
      const bytes = fs.readFileSync(target);
      assert(bytes.length === sourcePin.byteLength && digest(bytes) === sourcePin.sha256, `Copied bytes changed: ${rel}`);
      artifacts.push({path: rel, sha256: sourcePin.sha256, byteLength: sourcePin.byteLength, compression});
    };
    const sourcePin = rel => ({...state.artifacts.get(rel), path: `${base}/${rel}`});
    for (const countryId of directory.countryOrder) {
      const prefix = `countries/${countryId}`, selection = selected.get(countryId);
      const catalog = readGzip(resolveInput(workspace, `${base}/${prefix}/catalog.json.gz`));
      const geometry = readGzip(resolveInput(workspace, `${base}/${prefix}/geometry.geojson.gz`));
      const original = validateAssets(catalog, geometry, countryId);
      assert(digest(jsonBytes([...original.entries.keys()].sort(compareText))) === directory.countryRoots[countryId], `Baseline country root mismatch: ${countryId}`);
      let finalCatalog = catalog, finalGeometry = geometry, correspondence = null;
      if (selection?.selectedGeometryReplacementRequired) {
        const cells = readJSON(resolveInput(workspace, selection.selectedCellInput.file.path));
        const result = serializeReplacement(cells, catalog,
          readJSON(resolveInput(workspace, selection.cellCorrespondence.path)), geometry);
        finalCatalog = result.catalog; finalGeometry = result.geometry; correspondence = result.census;
        write(`${prefix}/catalog.json.gz`, gzipJSON(finalCatalog), 'gzip');
        write(`${prefix}/geometry.geojson.gz`, gzipJSON(finalGeometry), 'gzip');
        write(`${prefix}/selection-lineage.json`, jsonBytes({source: selection.selectedCellInput.file,
          namespace: 'Actual selected cell IDs; no ordinal/edge/membership imported', cells: cells.map(cell => ({
            ...Object.fromEntries(['id', 'sourceCountryId', 'sourceFeatureId', 'inputRole', 'parentKey', 'parentHash',
              'parentSourceFeatureId', 'adminId', 'oldTerritoryId', 'sourceComponentHash', 'componentIndex', 'sourceTiny'].map(k => [k, cell[k]])),
            geometrySha256: digest(jsonBytes(cell.geometry)),
          }))}));
      } else {
        copy(sourcePin(`${prefix}/catalog.json.gz`), `${prefix}/catalog.json.gz`, 'gzip');
        copy(sourcePin(`${prefix}/geometry.geojson.gz`), `${prefix}/geometry.geojson.gz`, 'gzip'); copiedAssets += 2;
        if (selection) {
          const receipt = readJSON(resolveInput(workspace, selection.cellCorrespondence.path)), used = new Set();
          assert(receipt.mode === 'IDENTITY' && receipt.complete === true && receipt.cells.length === original.entries.size, `Invalid retained correspondence: ${countryId}`);
          for (const row of receipt.cells) {
            assert(row.originalCellId === row.selectedCellId && original.entries.has(row.originalCellId) && !used.has(row.originalCellId) &&
              digest(jsonBytes(original.geometries.get(row.originalCellId))) === row.geometryHash, `Wrong retained correspondence: ${countryId}`);
            used.add(row.originalCellId);
          }
          correspondence = {originalCells: used.size, selectedCells: used.size, complete: true};
        }
      }
      const assets = validateAssets(finalCatalog, finalGeometry, countryId);
      claimWorldIds(allIds, assets.entries.keys());
      const cellRoot = digest(jsonBytes([...assets.entries.keys()].sort(compareText))); countryRoots[countryId] = cellRoot;
      cellCount += assets.entries.size;
      if (selection) {
        assert(original.entries.size === selection.originalCellCount && assets.entries.size === selection.selectedCellInput.cellCount, `Selected country count mismatch: ${countryId}`);
        originalSelectedCount += original.entries.size; selectedCount += assets.entries.size;
      }
      const historicalPath = `historical-generation/${prefix}/generation.json.gz`;
      copy(sourcePin(`${prefix}/generation.json.gz`), historicalPath, 'gzip');
      const receipt = {countryId, cellCount: assets.entries.size, baselineCellCount: original.entries.size, cellRoot,
        action: selection?.selectedCellInput.kind ?? 'RETAIN_BASELINE_GEOMETRY_ASSETS',
        catalogAndGeometryByteIdenticalToBaseline: !selection?.selectedGeometryReplacementRequired,
        sourceCatalog: sourcePin(`${prefix}/catalog.json.gz`), sourceGeometry: sourcePin(`${prefix}/geometry.geojson.gz`),
        selectedCells: selection?.selectedCellInput ?? null, correspondence, correspondenceEvidence: selection?.cellCorrespondence ?? null,
        mergeEvidence: selection?.mergeEvidence ?? null, verificationEvidence: selection?.verificationEvidence ?? [],
        historicalGeneration: {path: historicalPath, source: sourcePin(`${prefix}/generation.json.gz`), role: 'PAST_EXECUTION_ONLY_NOT_NEW_GENERATION_OR_AUDIT'},
        sliver: selection ? {frozenV6: selection.selectedFrozenV6Sliver, v2: 'PASS_REUSED_PINNED_EVIDENCE', evidence: selection.sliverEvidence} :
          {v2: 'NOT_EVALUATED_IN_THIS_TASK'},
        scopedDeferredFindingIds: selection?.scopedDeferredFindingIds ?? [], strict: selection?.strict ?? null,
        generation: 'NOT_RUN', wholeCountryValidation: 'NOT_RUN', worldOrdinal: 'NOT_CREATED'};
      write(`${prefix}/assembly.json`, jsonBytes(receipt)); countries.push(receipt);
      if (countries.length % 25 === 0 || selection?.selectedGeometryReplacementRequired) console.log(JSON.stringify({stage: 'ASSEMBLY_INTEGRITY', countryId, completedCountries: countries.length, cellCount}));
      global.gc?.();
    }
    assert(cellCount === EXPECTED.cells && allIds.size === cellCount && selectedCount === EXPECTED.selectedCells &&
      originalSelectedCount === EXPECTED.originalSelectedCells && copiedAssets === EXPECTED.retained * 2, 'Final world census mismatch');
    const changedCountries = countries.filter(c => !c.catalogAndGeometryByteIdenticalToBaseline).map(c => c.countryId);
    assert(changedCountries.length === EXPECTED.replacements, 'Wrong replacement count');
    const rootDocument = {...directory, countryRoots, cellCount, draftId: name, preparationStatus: STATUS};
    write('catalog-root.json', jsonBytes(rootDocument));
    for (const [key, rel] of [['sliverEvaluationRule', 'inputs/sliver-evaluation-v2.json'], ['numericalDebtSupplement', 'inputs/numerical-deferral-supplement.json']]) copy(manifest[key], rel, null);
    copy(MANIFEST_PIN, 'inputs/adoption-manifest.json', null);
    copy(inputs.find(p => p.path === 'docs/automation/prompt15-numerical-deferral.json'), 'inputs/numerical-deferral.json', null);
    write('input-identities.json', jsonBytes({inputs, code, runtime, contentHash}));
    const scope = {assemblyIntegrity: 'COMPLETED', countryGeometryGeneration: 'NOT_RUN', merge: 'NOT_RUN',
      worldGeometryAudit: 'NOT_RUN', membership: 'NOT_BUILT', topology: 'NOT_BUILT', delivery: 'NOT_BUILT',
      newCandidateApproval: 'NOT_PERFORMED', task15_22: 'NOT_OVERALL_PASS', task15_23: 'NOT_RUN',
      v2RuleScope: 'GENERAL_RULE; only the 23 pinned evaluations are reused; other 224 countries not evaluated under v2'};
    const census = {countries: countries.length, replacedCountries: changedCountries.length, geometryRetainedCountries: EXPECTED.retained,
      selectedCountries: selected.size, originalSelectedCells: originalSelectedCount, selectedCells: selectedCount,
      baselineCells: directory.cellCount, cells: cellCount, delta: cellCount - directory.cellCount, byteIdenticalCatalogGeometryFiles: copiedAssets};
    const preparation = {schemaVersion: VERSION, status: STATUS, scope: 'catalog-assembly-draft-only', contentHash, census, changedCountries,
      frozenPhysicalPolicy: manifest.frozenPhysicalPolicy, separateSliverEvaluationRule: manifest.sliverEvaluationRule,
      originalNumericalDebtCountries: ['CIV', 'FRA', 'GBR', 'MYS', 'UKR', 'VNM'],
      scopedNumericalDebt: manifest.numericalDebtSupplement, scopedDebtCountries: ['AIA', 'BMU', 'LIE', 'MAC', 'MLT', 'NRU', 'SMR'],
      originalStrictFailuresAndNativeExitOnePreserved: true, checks: scope,
      countrySelectionDetails: 'countries/<countryId>/assembly.json', worldReferences: 'NOT_CREATED; local ordinal/edge/membership not imported',
      downstreamCompatibility: 'Old 15-20 CLI requires pinned roots and generation.json.gz. Historical reports are intentionally outside the country asset directory; a separately reviewed input/evidence adapter and fresh global references are required. Do not copy historical PASS to new candidate.',
      legacyHelperCompatibility: manifest.legacyHelperCompatibility};
    write('candidate-preparation.json', jsonBytes(preparation));
    write('summary.json', jsonBytes({status: STATUS, census, changedCountries, checks: scope}));
    write('provenance.json', jsonBytes({task: '15-19-draft', assemblerVersion: VERSION, contentHash, code, runtime,
      baselineIndexes: manifest.baseArtifactIndexes, adoptionManifest: MANIFEST_PIN, fixedCountryOrder: manifest.worldDirectory,
      physicalCandidateId: directory.candidateId, frozenPhysicalPolicy: manifest.frozenPhysicalPolicy,
      sliverRule: manifest.sliverEvaluationRule, numericalDeferralSupplement: manifest.numericalDebtSupplement,
      historicalGenerationRole: 'Original bytes; prior execution evidence only. No generation or country audit was run for this draft.',
      sourceParentComponentOldOwnerCorrespondence: 'Pinned adoption correspondence and country assembly receipts; unchanged source/admin/old IDs.',
      runtimeRegeneration: false, productionPublication: false, newCandidateApproved: false, checks: scope}));
    artifacts.sort((a, b) => compareText(a.path, b.path));
    const index = {schemaVersion: SCHEMA, root: relative, artifacts, totalByteLength: artifacts.reduce((sum, a) => sum + a.byteLength, 0),
      command: 'node scripts/prompt15-sliver-adoption-draft.mjs --evidence <new-execution-evidence-directory>'};
    writeJSON(path.join(staging, 'artifact-index.json'), index);
    for (const pin of artifacts) {
      const bytes = fs.readFileSync(path.join(staging, pin.path));
      assert(digest(bytes) === pin.sha256 && bytes.length === pin.byteLength, `Draft artifact mismatch: ${pin.path}`);
    }
    const actualPaths = fs.readdirSync(staging, {recursive: true, withFileTypes: true}).filter(e => e.isFile()).map(e =>
      path.relative(staging, path.join(e.parentPath, e.name)).replaceAll('\\', '/')).sort(compareText);
    assert(same(actualPaths, [...artifacts.map(a => a.path), 'artifact-index.json'].sort(compareText)), 'Unindexed or missing draft files');
    const inputChanges = snapshotChanges(workspace, inputs), codeChanges = snapshotChanges(workspace, code);
    writeJSON(path.join(evidence, 'after.json'), {inputChanges, codeChanges, verifiedInputCount: inputs.length, verifiedCodeCount: code.length});
    assert(!inputChanges.length && !codeChanges.length, 'Inputs or code changed during assembly');
    assertFreshOutput(root); fs.renameSync(staging, root);
    const indexPin = identity(workspace, `${relative}/artifact-index.json`);
    const handoff = {schemaVersion: 'prompt15-sliver-draft-downstream-handoff-v1', status: 'PENDING_SEPARATE_AUTHORIZATION',
      catalogRoot: relative, artifactIndex: indexPin, catalogDirectory: identity(workspace, `${relative}/catalog-root.json`),
      candidatePreparation: identity(workspace, `${relative}/candidate-preparation.json`), adoptionManifest: MANIFEST_PIN,
      notReusableAsWorldReferences: ['15-20 ordinals/membership/topology/edges', '15-21 delivery', 'proposal-local ordinals/membership/edges'],
      nextSteps: [
        'Review/admit this draft schema and its distinct v2 rule; retain frozen-v6 results and exact scoped numerical debt.',
        'Use the 247-country directory and actual new catalog IDs to derive a deterministic fresh world cell order and ordinal.',
        'Build administrative/previous-territory membership from selected identities and actual geometries. Reconcile retained parent and repair ledgers using original evidence, not historical PASS promotion.',
        'Build fresh topology/adjacency/incidence from actual selected boundaries; inspect changed-country and adjacent-country references and point-only contacts.',
        'Build new delivery metadata/detail/render against the fresh world references.',
        'Plan country-partitioned validation for all 247 countries with identical code/input/rule identities, bounded resource budgets, separate strict verdict and numerical debt. Start with 16 changed countries plus their actual cross-country references. No old PASS automatically reapproved.',
      ],
      legacyHelperCompatibility: manifest.legacyHelperCompatibility, generationEvidenceAdapterRequired: preparation.downstreamCompatibility,
      numericalDeferral: {originalSix: preparation.originalNumericalDebtCountries, scopedSeven: preparation.scopedDebtCountries,
        supplement: manifest.numericalDebtSupplement, strictFailureNativeExitCodesUnchanged: true},
      prohibitedAutomaticProgress: ['world audit', '15-20/21 build', 'final join', 'approval pointer change', '15-23']};
    writeJSON(path.join(evidence, 'handoff.json'), handoff);
    writeJSON(path.join(evidence, 'candidate-preparation.json'), {...preparation, root: relative, artifactIndex: indexPin});
    writeJSON(path.join(evidence, 'country-results.json'), {countries});
    const summary = {status: STATUS, root: relative, artifactIndex: indexPin, census, changedCountries, checks: scope,
      artifactCount: artifacts.length, inputChanges, codeChanges, inputPinCount: inputs.length, codePinCount: code.length,
      inputsPreserved: true, oldArtifactsAndApprovalPointersModified: false, handoff: `${evidenceRelative}/handoff.json`};
    writeJSON(path.join(evidence, 'summary.json'), summary); return summary;
  } catch (error) {
    writeJSON(path.join(evidence, 'failure.json'), {status: 'DRAFT_ASSEMBLY_FAIL', error: error.message, stack: error.stack,
      stagingPreserved: fs.existsSync(staging), root, completedCountries: countries.length,
      inputChanges: snapshotChanges(workspace, inputs), codeChanges: snapshotChanges(workspace, code)});
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), allowed = ['--evidence', '--verify-only'];
  for (let i = 0; i < args.length; i++) {assert(allowed.includes(args[i]), `Unknown argument: ${args[i]}`); if (args[i] === '--evidence') i++;}
  const evidence = args[args.indexOf('--evidence') + 1]; assert(args.includes('--evidence') && evidence, '--evidence is required');
  try {
    const state = intake(process.cwd());
    if (args.includes('--verify-only')) {
      safeRelative(evidence); assert(evidence.startsWith('reports/prompt15/15-22-sliver-adoption/'), 'Invalid evidence tree');
      assertFreshOutput(evidence); fs.mkdirSync(evidence, {recursive: true});
      writeJSON(path.join(evidence, 'intake.json'), {status: 'INPUT_IDENTITIES_VERIFIED', inputs: state.inputs, code: state.code,
        contentHash: state.contentHash, runtime: state.runtime, expected: EXPECTED});
      console.log(JSON.stringify({status: 'INPUT_IDENTITIES_VERIFIED', inputs: state.inputs.length, code: state.code.length}));
    } else console.log(JSON.stringify(assemble(process.cwd(), evidence, state)));
  } catch (error) {console.error(error.stack); process.exitCode = 1;}
}
