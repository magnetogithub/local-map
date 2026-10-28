import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {compareText, digest, hashCanonical, jsonBytes} from './prompt14-catalog-core.mjs';
import {MANIFEST_PIN, collectPins, identity, verifyPin, safeRelative, validatePlan, validateAssets,
  serializeReplacement} from './prompt15-sliver-adoption-draft.mjs';

export const DRAFT_INDEX_IDENTITY = Object.freeze({sha256: 'a32a1687a0988eabd48175ccd394c800005bc652be085927854124d4e0f046af', byteLength: 165354});
export const VERSION = 'prompt15-sliver-indices-input-adapter-v1';
export const assert = (condition, message, detail) => {if (!condition) throw Object.assign(Error(message), {detail});};
export const readJSON = file => JSON.parse(fs.readFileSync(file));
export const readGzip = file => JSON.parse(gunzipSync(fs.readFileSync(file)));
export const same = (a, b) => jsonBytes(a).equals(jsonBytes(b));
export const writeJSON = (file, value) => fs.writeFileSync(file, jsonBytes(value), {flag: 'wx'});
const addPin = (pins, pin) => collectPins(pin, pins);
function treePins(root, index) {
  safeRelative(root); const pins = [], paths = new Set(); let total = 0;
  for (const item of index.artifacts) {
    safeRelative(item.path); assert(!paths.has(item.path), `Duplicate indexed path ${item.path}`); paths.add(item.path);
    pins.push({...item, path: `${root}/${item.path}`}); total += item.byteLength;
  }
  assert(index.root.replaceAll('\\', '/') === root && total === index.totalByteLength, 'Indexed root or byte total mismatch',
    {declaredRoot: index.root, expectedRoot: root, declaredBytes: index.totalByteLength, actualBytes: total});
  const disk = fs.readdirSync(root, {recursive: true, withFileTypes: true}).filter(e => e.isFile()).map(e =>
    path.relative(root, path.join(e.parentPath, e.name)).replaceAll('\\', '/')).sort(compareText);
  assert(same(disk, [...paths, 'artifact-index.json'].sort(compareText)), 'Indexed tree file census mismatch');
  return pins;
}
export function compilerPins() {
  const files = new Map();
  const visit = file => {
    if (files.has(file)) return;
    files.set(file, identity(process.cwd(), file));
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      const spec = match[1];
      if (spec.startsWith('.')) visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)));
      else if (!spec.startsWith('node:')) {
        const resolved = import.meta.resolve(spec);
        if (!resolved.startsWith('node:')) visit(path.relative(process.cwd(), fileURLToPath(resolved)).replaceAll('\\', '/'));
      }
    }
  };
  for (const file of ['scripts/prompt15-sliver-indices.mjs', 'scripts/prompt15-sliver-indices.node-test.mjs']) visit(file);
  for (const file of ['package.json', 'package-lock.json', 'node_modules/jsts/package.json']) files.set(file, identity(process.cwd(), file));
  return [...files.values()].sort((a, b) => compareText(a.path, b.path));
}
export function changes(pins) {
  return pins.flatMap(pin => {
    try {const after = identity(process.cwd(), pin.path); return same(pin, after) ? [] : [{before: pin, after}];}
    catch (error) {return [{before: pin, error: error.message}];}
  });
}
export function openDraft({catalogRoot, evidenceManifest}) {
  safeRelative(catalogRoot); safeRelative(evidenceManifest);
  const indexPin = {path: `${catalogRoot}/artifact-index.json`, ...DRAFT_INDEX_IDENTITY}; verifyPin(process.cwd(), indexPin);
  assert(evidenceManifest === MANIFEST_PIN.path, 'Evidence manifest must identify the pinned selection receipt'); verifyPin(process.cwd(), MANIFEST_PIN);
  const manifest = readJSON(evidenceManifest), index = readJSON(indexPin.path), pins = collectPins(manifest);
  addPin(pins, indexPin); addPin(pins, MANIFEST_PIN);
  for (const pin of treePins(catalogRoot, index)) addPin(pins, pin);
  const preparation = readJSON(`${catalogRoot}/candidate-preparation.json`), directory = readJSON(`${catalogRoot}/catalog-root.json`);
  assert(preparation.status === 'DRAFT_CATALOG_PREPARED_PENDING_VALIDATION' && directory.preparationStatus === preparation.status,
    'Input is not the recognized unapproved catalog draft');
  const baseline = path.posix.dirname(manifest.baseArtifactIndexes.catalog.path);
  validatePlan(manifest, readJSON(`${baseline}/catalog-root.json`));
  assert(directory.countryOrder.length === 247 && directory.cellCount === 923413 &&
    same(directory.countryOrder, readJSON(`${baseline}/catalog-root.json`).countryOrder), 'Draft world directory mismatch');
  // Receipts include bytes of the retained catalog, prior reports, source approvals and rules, never a new PASS.
  const priorInputs = readJSON(`${catalogRoot}/input-identities.json`);
  for (const pin of priorInputs.inputs) addPin(pins, pin);
  const adoptionPlan = readJSON(manifest.adoptionPlan.path); collectPins(adoptionPlan.inputs, pins);
  const administrativeRoot = path.posix.dirname(manifest.baseArtifactIndexes.administrative.path);
  for (const pin of treePins(administrativeRoot, readJSON(manifest.baseArtifactIndexes.administrative.path))) addPin(pins, pin);
  const oldRoot = path.posix.dirname(manifest.baseArtifactIndexes.indices.path), oldIndex = readJSON(manifest.baseArtifactIndexes.indices.path);
  const oldProvenanceArtifact = oldIndex.artifacts.find(a => a.path === 'provenance.json');
  assert(oldProvenanceArtifact, 'Missing historical compiler source provenance');
  const oldProvenancePin = {...oldProvenanceArtifact, path: `${oldRoot}/provenance.json`}; addPin(pins, oldProvenancePin); verifyPin(process.cwd(), oldProvenancePin);
  const p0Pin = readJSON(oldProvenancePin.path).inputs.find(p => p.path === 'data/derived/prompt14/shared-game-p0.geojson');
  assert(p0Pin, 'Missing immutable country boundary identity'); addPin(pins, p0Pin);
  for (const file of ['AGENTS.md', 'prompts/PROMPT_15_OPERATIONAL_MICRO_TERRITORIES_AND_PARTIAL_FRONTS.txt',
    'docs/automation/prompt15-numerical-deferral.json']) addPin(pins, identity(process.cwd(), file));
  const snapshot = [...pins.values()].map(p => ({path: p.path, sha256: p.sha256, byteLength: p.byteLength})).sort((a, b) => compareText(a.path, b.path));
  for (const pin of snapshot) verifyPin(process.cwd(), pin);
  const selected = new Map(manifest.changedCountrySelections.map(item => [item.countryId, item]));
  const approvedParents = new Map();
  const administrative = readJSON(`${administrativeRoot}/administrative-restoration.geojson`), residual = readJSON(`${administrativeRoot}/residuals.geojson`);
  for (const feature of administrative.features) {
    const p = feature.properties; approvedParents.set(`${p.sourceCountryId}:${p.sourceFeatureId}`, feature);
  }
  for (const feature of residual.features) {
    const p = feature.properties; approvedParents.set(`${p.sourceCountryId}:country-envelope:${p.residualId}`, feature);
  }
  const oldParents = new Map(readJSON(`${administrativeRoot}/protected-overlay.geojson`).features.map(f => [f.properties.territoryId, f]));
  const p0 = readJSON(p0Pin.path);
  return {catalogRoot, indexPin, index, manifest, selected, directory, preparation, snapshot, baseline, approvedParents, oldParents, p0,
    historicalRole: 'PINNED_PAST_SOURCE_AND_REPAIR_EVIDENCE_ONLY; not new generation or approval'};
}
export function countryAssets(context, countryId) {
  const prefix = `${context.catalogRoot}/countries/${countryId}`, catalog = readGzip(`${prefix}/catalog.json.gz`), geometry = readGzip(`${prefix}/geometry.geojson.gz`);
  validateAssets(catalog, geometry, countryId);
  return {catalog, geometry};
}
function repairReceipt(countryId, ledger, record, originalIds, selectedIds, correspondence, oldParents) {
  const area = ledger === 'topology-source' ? record.removedAreaDegrees : record.area;
  assert(Number.isFinite(area) && area > 0, `Invalid historical repair area ${countryId}/${ledger}`, record);
  if (ledger !== 'topology-source') assert(area <= 1e-12, 'Historical repair bound exceeded', record);
  for (const key of ['assignedOldTerritoryId', 'sourceOldTerritoryId', 'oldTerritoryId']) if (record[key] && record[key] !== 'numerical-unassigned')
    assert(oldParents.has(record[key]), `Unknown repair old owner: ${record[key]}`);
  const references = [];
  const visit = (v, field = '') => {
    if (typeof v === 'string' && originalIds.has(v)) {
      const targets = selectedIds.has(v) ? [v] : correspondence.get(v);
      assert(targets?.length === 1 && selectedIds.has(targets[0]), `Unresolved historical cell reference ${v}`);
      references.push({field, originalCellId: v, selectedCellId: targets[0]});
    } else if (v && typeof v === 'object') for (const [key, child] of Object.entries(v)) visit(child, `${field}/${key}`);
  }; visit(record);
  return {countryId, ledger, evidenceId: hashCanonical('prompt15-historical-repair-receipt.v1', {countryId, ledger, record}),
    originalRecord: record, cellReferences: references,
    areaApplication: 'NOT_REAPPLIED_OR_ADDED_TO_GEOMETRY; unchanged evidence for later source-preservation validation'};
}
export function loadMembershipInputs(context, countryOrder) {
  assert(new Set(countryOrder).size === countryOrder.length && countryOrder.every(c => context.directory.countryOrder.includes(c)), 'Invalid country subset');
  const cells = [], parents = new Map(), repairs = [], repairIds = new Set(), selectionReceipts = [];
  for (const countryId of countryOrder) {
    const prefix = `${context.catalogRoot}/countries/${countryId}`, catalog = readGzip(`${prefix}/catalog.json.gz`);
    const history = readGzip(`${context.catalogRoot}/historical-generation/countries/${countryId}/generation.json.gz`);
    const receipt = readJSON(`${prefix}/assembly.json`), selection = context.selected.get(countryId);
    assert(history.countryId === countryId && receipt.countryId === countryId && receipt.cellCount === catalog.entries.length, 'Country evidence census mismatch');
    const byParent = new Map(history.parents.map(p => [p.parentKey, p]));
    assert(byParent.size === history.parents.length && !(history.numericalGapRepairs?.length), 'Duplicate parent or ambiguous historical gap repair');
    const components = new Map(history.sourceComponents.map(c => [`${c.parentKey}:${c.componentIndex}`, c]));
    const lineages = new Map(), correspondence = new Map();
    const originals = readGzip(`${context.baseline}/countries/${countryId}/catalog.json.gz`).entries;
    const originalIds = new Set(originals.map(c => c.id)), selectedIds = new Set(catalog.entries.map(c => c.id));
    if (selection?.selectedGeometryReplacementRequired) {
      const lineage = readJSON(`${prefix}/selection-lineage.json`);
      assert(same(lineage.source, selection.selectedCellInput.file) && lineage.cells.length === catalog.entries.length, 'Selected lineage receipt mismatch');
      for (const row of lineage.cells) {assert(!lineages.has(row.id), 'Duplicate selected lineage'); lineages.set(row.id, row);}
      // Reuse the assembly adapter's exact field/hash/correspondence checks, without any geometry operations.
      const baselineGeometry = readGzip(`${context.baseline}/countries/${countryId}/geometry.geojson.gz`);
      const baselineCatalog = readGzip(`${context.baseline}/countries/${countryId}/catalog.json.gz`);
      const map = readJSON(selection.cellCorrespondence.path);
      const serialized = serializeReplacement(readJSON(selection.selectedCellInput.file.path), baselineCatalog, map, baselineGeometry);
      assert(same(serialized.catalog, catalog), `Selected catalog serialization changed: ${countryId}`);
      for (const row of map.mapping) for (const old of row.originalCells) {
        assert(!correspondence.has(old.id), `Duplicate historical correspondence ${old.id}`); correspondence.set(old.id, [row.selectedCellId]);
      }
    } else {
      const originalCatalogPin = receipt.sourceCatalog, originalGeometryPin = receipt.sourceGeometry;
      assert(identity(process.cwd(), `${prefix}/catalog.json.gz`).sha256 === originalCatalogPin.sha256 &&
        identity(process.cwd(), `${prefix}/geometry.geojson.gz`).sha256 === originalGeometryPin.sha256 &&
        receipt.catalogAndGeometryByteIdenticalToBaseline === true, `Retained evidence bytes mismatch: ${countryId}`);
    }
    for (const entry of catalog.entries) {
      assert(!Object.hasOwn(entry, 'ordinal'), `Local/stale ordinal in input catalog ${entry.id}`);
      const source = context.approvedParents.get(entry.parentKey), evidence = byParent.get(entry.parentKey), old = context.oldParents.get(entry.oldTerritoryId);
      const component = components.get(`${entry.parentKey}:${entry.componentIndex}`);
      assert(source && evidence && old && source.properties.sourceCountryId === countryId && old.properties.sourceCountryId === countryId &&
        evidence.sourceFeatureId === entry.parentSourceFeatureId && evidence.adminId === entry.adminId &&
        component?.sourceHash === entry.sourceComponentHash && component.sourceTiny === entry.sourceTiny,
      `Unknown or mismatched source/parent/component/old owner ${entry.id}`, entry);
      if (selection?.selectedGeometryReplacementRequired) {
        const lineage = lineages.get(entry.id);
        assert(lineage && lineage.parentHash === evidence.parentHash && ['parentKey', 'oldTerritoryId', 'sourceComponentHash', 'componentIndex'].every(k => same(lineage[k], entry[k])), `Wrong selected source lineage: ${entry.id}`);
      }
      if (!parents.has(entry.parentKey)) parents.set(entry.parentKey, {parentKey: entry.parentKey, sourceCountryId: countryId,
        sourceFeatureId: entry.parentSourceFeatureId, adminId: entry.adminId, inputRole: evidence.inputRole,
        kind: entry.adminId === null ? 'country-envelope-residual' : 'administrative',
        preparedGeometryHash: evidence.parentHash, approvedSourceGeometryHash: digest(jsonBytes(source.geometry)),
        sourceEvidenceRole: context.historicalRole, historicalParent: evidence,
        geometryPreservationReaudit: 'NOT_RUN; source identity and pinned prepared receipt linked without re-preparation'});
      cells.push({...Object.fromEntries(['id', 'sourceCountryId', 'parentKey', 'parentSourceFeatureId', 'adminId', 'oldTerritoryId', 'sourceComponentHash', 'componentIndex'].map(k => [k, entry[k]]))});
    }
    for (const [key, ledger] of [['numericalProtectedFragmentRepairs', 'protected'], ['numericalCellRepairs', 'cell'], ['topologySourceRepairs', 'topology-source']]) {
      for (const record of history[key] ?? []) {
        const proof = repairReceipt(countryId, ledger, record, originalIds, selectedIds, correspondence, context.oldParents);
        assert(!repairIds.has(proof.evidenceId), 'Duplicate historical repair evidence', proof); repairIds.add(proof.evidenceId); repairs.push(proof);
      }
    }
    selectionReceipts.push({countryId, selectedCells: catalog.entries.length, baselineCells: originals.length,
      evidenceRole: context.historicalRole, replacement: Boolean(selection?.selectedGeometryReplacementRequired),
      correspondence: selection?.cellCorrespondence ?? null, sourceGenerationStatusNotPromoted: history.status,
      strictFindingAndNativeExit: selection?.strict ?? null, deferredFindingIds: selection?.scopedDeferredFindingIds ?? []});
  }
  cells.sort((a, b) => compareText(a.id, b.id));
  assert(new Set(cells.map(c => c.id)).size === cells.length, 'Duplicate world cell ID');
  cells.forEach((cell, i) => {cell.ordinal = i + 1;});
  return {cells, parents, repairs, selectionReceipts};
}
