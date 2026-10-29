import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import geojsonVt from 'geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {compareText, digest, hashCanonical, jsonBytes} from './prompt14-catalog-core.mjs';
import {POLICY, identity, readJSON, readGzipJSON, writeArtifact, tileCoordinates, artifactRoot, edgeFeature, checkTransportFeature,
  nondegenerateTileFeature, edgeTileBucket, encodeEdgeIncidence, verifyTree} from './prompt15-world-delivery-core.mjs';
import {VERSION, REF_VERSION, assert, equal, missing, openDeliveryInputs, codeIdentities, inputChanges, membershipBytes, parentMetadata,
  budgetAccounting, resource} from './prompt15-sliver-delivery-adapter.mjs';

export const COMPLETE = 'DRAFT_DELIVERY_GENERATED_PENDING_INDEPENDENT_VERIFICATION';
const collection = features => ({type: 'FeatureCollection', features});
export function encodeScopedIncidence(left, right, expected, cellCount, full) {
  if (full) {for (const o of expected) assert(left[o] <= cellCount && right[o] <= cellCount, 'Invalid incidence cell range'); return encodeEdgeIncidence(left, right);}
  const bytes = Buffer.alloc((left.length - 1) * 8);
  for (const o of expected) {
    assert(Number.isInteger(o) && o > 0 && o < left.length && left[o] > 0 && left[o] <= cellCount && right[o] <= cellCount && left[o] !== right[o], 'Missing/invalid scoped incidence');
    bytes.writeUInt32LE(left[o], (o - 1) * 8); bytes.writeUInt32LE(right[o], (o - 1) * 8 + 4);
  }
  return bytes;
}
export function buildDeliveryAssets(context, {staging, work, key, sourceIdentity, progress = console.log}) {
  assert(!fs.existsSync(staging) && !fs.existsSync(work), 'Refusing existing delivery staging/work'); fs.mkdirSync(staging, {recursive: true}); fs.mkdirSync(work, {recursive: true});
  const artifacts = [], payload = [];
  const write = (name, value, options) => {const a = writeArtifact(staging, name, value, options); artifacts.push(a); return a;};
  const deliver = (name, value, options) => {const a = write(name, value, options); payload.push(a); return a;};
  const expectedCellSet = new Set(context.expectedCells), expectedEdgeSet = new Set(context.expectedEdges), {cellCount, edgeCount} = context;
  const cells = context.order.cells, ordinalById = new Map(cells.map(c => [c.id, c.ordinal]));
  const adminOrdinal = new Map(context.admin.parents.map((p, i) => [p.parentKey, i + 1])), oldOrdinal = new Map(context.previous.parents.map((p, i) => [p.oldTerritoryId, i + 1]));
  const selectedAdmin = new Set(context.expectedCells.map(o => context.admin.parentOrdinalByCell[o - 1])), selectedOld = new Set(context.expectedCells.map(o => context.previous.oldParentOrdinalByCell[o - 1]));
  const transports = {};
  for (const [name, membership, selected] of [['administrative', context.admin, selectedAdmin], ['previous', context.previous, selectedOld]]) {
    const artifact = deliver(`metadata/membership/${name}.bin.gz`, gzipSync(membershipBytes(membership, selected), {level: 9, mtime: 0}), {raw: true});
    transports[name] = {...artifact, compression: 'gzip', format: 'uint32-le-cell-ordinal', recordBytes: 4,
      recordCount: membership.cellOrdinals.length, decodedByteLength: membership.cellOrdinals.length * 4,
      source: context.sourceBindings[name], partial: context.scope !== 'WORLD'};
  }
  const parents = parentMetadata(context, transports);
  const parentArtifact = deliver('metadata/parents.json.gz', parents, {compressed: true});
  const tileWork = path.join(work, 'tiles'), edgeWork = path.join(work, 'edges'); fs.mkdirSync(tileWork); fs.mkdirSync(edgeWork);
  const removePrivate = (file, below) => {
    const relative = path.relative(path.resolve(below), path.resolve(file)); assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Private work file escaped checked directory'); fs.unlinkSync(file);
  };
  const appendTiles = (features, layer) => {
    const index = geojsonVt(collection(features), POLICY.tileOptions);
    for (const {z, x, y} of tileCoordinates()) {
      const tile = index.getTile(z, x, y); if (!tile?.features.length) continue;
      const surviving = tile.features.map(nondegenerateTileFeature).filter(Boolean); if (!surviving.length) continue;
      fs.appendFileSync(path.join(tileWork, `${z}-${x}-${y}-${layer}.ndjson`), surviving.map(f => JSON.stringify(f) + '\n').join(''));
      if (layer === 'edges' && z >= POLICY.administrativeMinZoom) {
        const admin = surviving.filter(f => f.tags.a === 1);
        if (admin.length) fs.appendFileSync(path.join(tileWork, `${z}-${x}-${y}-administrative.ndjson`), admin.map(f => JSON.stringify(f) + '\n').join(''));
      }
    }
  };
  const countries = [], edgeDetails = [], exactCells = new Uint8Array(cellCount + 1), exactEdges = new Uint8Array(edgeCount + 1), metadataSeen = new Uint8Array(cellCount + 1);
  const seenCells = new Uint8Array(cellCount + 1), seenEdges = new Uint8Array(edgeCount + 1), left = new Uint32Array(edgeCount + 1), right = new Uint32Array(edgeCount + 1), edgeClass = new Uint8Array(edgeCount + 1), edgeAdmin = new Uint8Array(edgeCount + 1);
  for (const [ci, countryId] of context.activeCountries.entries()) {
    progress(JSON.stringify({stage: 'country', countryId, completed: ci + 1, total: context.activeCountries.length, rssBytes: process.memoryUsage().rss}));
    const catalog = context.readCountry ? context.readCountry(countryId).catalog : readGzipJSON(`${context.catalogRoot}/countries/${countryId}/catalog.json.gz`);
    const source = context.readCountry ? context.readCountry(countryId).geometry : readGzipJSON(`${context.catalogRoot}/countries/${countryId}/geometry.geojson.gz`);
    const features = source.features.map(feature => {
      const o = ordinalById.get(feature.properties.cellId), cell = cells[o - 1];
      assert(cell && expectedCellSet.has(o) && !exactCells[o] && cell.sourceCountryId === countryId, 'Unknown/duplicate/wrong-country exact cell', feature.properties);
      for (const k of ['sourceCountryId', 'parentKey', 'parentSourceFeatureId', 'adminId', 'oldTerritoryId', 'componentIndex']) equal(feature.properties[k], cell[k], `Cell geometry identity mismatch ${k}`);
      exactCells[o] = 1; return {type: 'Feature', id: o, properties: {}, geometry: feature.geometry};
    }).sort((a, b) => a.id - b.id);
    const rows = catalog.entries.map(entry => {
      const o = ordinalById.get(entry.id), cell = cells[o - 1], a = adminOrdinal.get(entry.parentKey), p = oldOrdinal.get(entry.oldTerritoryId);
      assert(cell && expectedCellSet.has(o) && !metadataSeen[o] && a && p && cell.sourceCountryId === countryId && !Object.hasOwn(entry, 'ordinal'), 'Unknown/duplicate/stale catalog metadata');
      for (const k of ['parentKey', 'parentSourceFeatureId', 'adminId', 'oldTerritoryId', 'componentIndex', 'sourceComponentHash']) equal(entry[k], cell[k], `Wrong metadata parent ${k}`);
      metadataSeen[o] = 1; return [o, entry.id, a, p];
    }).sort((a, b) => a[0] - b[0]);
    assert(rows.length === features.length, 'Catalog/exact feature count mismatch');
    const detail = deliver(`detail/countries/${countryId}.geojson.gz`, collection(features), {compressed: true});
    const metadata = deliver(`metadata/countries/${countryId}.json.gz`, {schemaVersion: VERSION, countryId,
      ordinalNamespace: 'NEW_15_20_GLOBAL_ORDER', columns: ['cellOrdinal', 'cellId', 'administrativeOrdinal', 'previousParentOrdinal'], rows}, {compressed: true});
    countries.push({countryId, cellCount: features.length, detail, metadata}); appendTiles(features, 'territories'); global.gc?.();
  }
  for (const [si, shard] of context.indexRoot.topologyShards.entries()) {
    const source = context.readTopology ? context.readTopology(shard) : readGzipJSON(`${context.indicesRoot}/${shard}`);
    const edges = source.edges.filter(edge => expectedEdgeSet.has(edge.ordinal));
    if (context.scope !== 'WORLD' && !edges.length) continue;
    progress(JSON.stringify({stage: 'exact-topology', completed: si + 1, total: context.indexRoot.topologyShards.length, shard, rssBytes: process.memoryUsage().rss}));
    const spatial = Array.from({length: 16}, () => []);
    for (const edge of edges) {
      assert(Number.isInteger(edge.ordinal) && edge.ordinal >= 1 && edge.ordinal <= edgeCount && !exactEdges[edge.ordinal] &&
        expectedCellSet.has(edge.left) && (!edge.right || expectedCellSet.has(edge.right)), 'Missing/duplicate/invalid source edge incidence', edge);
      const f = edgeFeature(edge); exactEdges[edge.ordinal] = 1; left[edge.ordinal] = edge.left; right[edge.ordinal] = edge.right;
      edgeClass[edge.ordinal] = f.properties.c; edgeAdmin[edge.ordinal] = f.properties.a;
      spatial[edgeTileBucket(f)].push(JSON.stringify(f) + '\n');
    }
    const transport = {schemaVersion: VERSION, sourceSchemaVersion: source.schemaVersion, bucket: source.bucket,
      edges: edges.map(edge => {const copy = {...edge}; delete copy.lengthKm; return copy;})};
    const artifact = deliver(`detail/${shard}`, transport, {compressed: true});
    edgeDetails.push({shard, firstOrdinal: edges[0]?.ordinal ?? null, count: edges.length, artifact});
    for (let bi = 0; bi < 16; bi++) if (spatial[bi].length) fs.appendFileSync(path.join(edgeWork, `${bi}.ndjson`), spatial[bi].join('')); global.gc?.();
  }
  assert(!missing(exactCells, context.expectedCells).length && !missing(metadataSeen, context.expectedCells).length && !missing(exactEdges, context.expectedEdges).length, 'Exact delivery census incomplete');
  for (let bi = 0; bi < 16; bi++) {
    const file = path.join(edgeWork, `${bi}.ndjson`); if (!fs.existsSync(file)) continue;
    progress(JSON.stringify({stage: 'edge-tiles', bucket: bi + 1, total: 16, rssBytes: process.memoryUsage().rss}));
    const features = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    appendTiles(features, 'edges'); removePrivate(file, edgeWork); global.gc?.();
  }
  const incidence = encodeScopedIncidence(left, right, context.expectedEdges, cellCount, context.scope === 'WORLD');
  const incidenceArtifact = deliver(POLICY.edgeIncidence.path, gzipSync(incidence, {level: 9, mtime: 0}), {raw: true});
  const tiles = [], byZoom = [];
  for (const {z, x, y, path: tilePath} of tileCoordinates()) {
    if (x === 0 && y === 0) progress(JSON.stringify({stage: 'encode-tiles', zoom: z, rssBytes: process.memoryUsage().rss}));
    const layers = {}, consumed = [];
    for (const name of ['territories', 'edges', 'administrative']) {
      const file = path.join(tileWork, `${z}-${x}-${y}-${name}.ndjson`); if (!fs.existsSync(file)) continue;
      consumed.push(file); layers[name] = {features: fs.readFileSync(file, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line)).sort((a, b) => a.id - b.id)};
    }
    try {
      const bytes = Buffer.from(fromGeojsonVt(layers, {version: 2, extent: POLICY.tileOptions.extent})), decoded = new VectorTile(new PbfReader(bytes));
      for (const [name, layer] of Object.entries(decoded.layers)) for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i); checkTransportFeature(name, f, cellCount, edgeCount, z);
        if (name === 'territories') {assert(expectedCellSet.has(f.id) && !Object.keys(f.properties).length, 'Unexpected scoped/mutable tile cell'); seenCells[f.id] = 1;}
        else {assert(expectedEdgeSet.has(f.id) && f.properties.c === edgeClass[f.id] && f.properties.a === edgeAdmin[f.id], 'Wrong tile edge class/incidence'); seenEdges[f.id] = 1;}
      }
      const a = deliver(tilePath, gzipSync(bytes, {level: 9, mtime: 0}), {raw: true}); tiles.push(a);
      const row = byZoom[z] ??= {zoom: z, tiles: 0, nonempty: 0, byteLength: 0, decodedByteLength: 0}; row.tiles++; row.nonempty += Number(bytes.length > 0); row.byteLength += a.byteLength; row.decodedByteLength += bytes.length;
      for (const file of consumed) removePrivate(file, tileWork);
    } catch (error) {throw Object.assign(error, {detail: {tile: {z, x, y}, inputFragments: consumed, cause: error.detail ?? null}});}
  }
  assert(!fs.readdirSync(tileWork).length && !fs.readdirSync(edgeWork).length, 'Unconsumed delivery work fragments');
  const coverage = {schemaVersion: VERSION, scope: context.scope, sourceCellCount: cellCount, sourceEdgeCount: edgeCount,
    exactCells: context.expectedCells.length, exactEdges: context.expectedEdges.length,
    overviewCells: context.expectedCells.filter(o => seenCells[o]).length, overviewEdges: context.expectedEdges.filter(o => seenEdges[o]).length,
    missingOverviewCellOrdinals: missing(seenCells, context.expectedCells), missingOverviewEdgeOrdinals: missing(seenEdges, context.expectedEdges), policy: POLICY.lod};
  deliver('lod-coverage.json.gz', coverage, {compressed: true});
  const ref = {schemaVersion: REF_VERSION, catalogVersion: `catalog-sliver-adoption-draft-v1-${key}`, sourceCatalogRoot: context.catalogRoot,
    sourceIndicesRoot: context.indicesRoot, sourceCatalogIndex: context.trees[0].identity, sourceIndicesIndex: context.trees[1].identity,
    geometryRoot: artifactRoot('prompt15-15-21-source-geometry.v1', context.trees[0].index.artifacts.filter(a => a.path.endsWith('/geometry.geojson.gz'))),
    catalogOrderRoot: context.indexRoot.roots.catalogOrder, topologyRoot: context.indexRoot.roots.topology,
    membership: {sourceBindings: context.sourceBindings, transport: transports}, renderArtifactRoot: artifactRoot('prompt15-sliver-delivery-render.v1', payload)};
  const tileIndex = write('tile-index.json', {schemaVersion: VERSION, ref, artifacts: tiles, tileCountsByZoom: byZoom});
  const detailIndex = write('detail-index.json', {schemaVersion: VERSION, ref, countries, edgeDetails, omittedDerivedEdgeFields: POLICY.topologyDetailOmittedDerivedFields,
    parents: parentArtifact, membership: transports, lodCoverage: 'lod-coverage.json.gz', lazy: true});
  const counts = {countries: countries.length, cells: context.expectedCells.length, edges: context.expectedEdges.length, tiles: tiles.length,
    administrativeParents: parents.administrative.length, previousParents: parents.previous.length,
    overviewCells: coverage.overviewCells, overviewEdges: coverage.overviewEdges,
    missingOverviewCells: coverage.missingOverviewCellOrdinals.length, missingOverviewEdges: coverage.missingOverviewEdgeOrdinals.length};
  const manifest = write('manifest.json', {schemaVersion: VERSION, status: 'UNAPPROVED_DRAFT', scope: context.scope, ref, counts,
    sourceUniverse: {cells: cellCount, edges: edgeCount}, sourceId: 'world-operational-catalog', tileTemplate: 'tiles/{z}/{x}/{y}.pbf.gz', minZoom: 0, maxZoom: 6,
    policy: POLICY, tileIndex, detailIndex, edgeIncidence: {...POLICY.edgeIncidence, artifact: incidenceArtifact, recordCount: edgeCount,
      decodedByteLength: edgeCount * 8, partial: context.scope !== 'WORLD'},
    initialAssets: ['artifact-index.json', 'manifest.json', 'tile-index.json', 'detail-index.json', 'delivery-index.json', POLICY.edgeIncidence.path],
    exactDetailRequired: true, runtimeRegeneration: false, productionPublication: false,
    remaining: 'Independent complete delivery verification and country geometry audits NOT_RUN. Historical strict FAIL/native 1 retained; no approval or runtime integration.'});
  const deliveredArtifacts = [...payload, tileIndex, detailIndex, manifest].sort((a, b) => compareText(a.path, b.path));
  const deliveryRoot = artifactRoot('prompt15-sliver-delivery-root.v1', deliveredArtifacts);
  const deliveryIndex = write('delivery-index.json', {schemaVersion: VERSION, ref, deliveryRoot, artifacts: deliveredArtifacts,
    totalByteLength: deliveredArtifacts.reduce((n, a) => n + a.byteLength, 0), additionalDeliveredIndexPaths: ['delivery-index.json', 'artifact-index.json'],
    accounting: 'Actual bytes of both additional indices are included in delivered and initial metadata budgets. No cryptographic self-reference.'});
  const provenance = {schemaVersion: VERSION, ...sourceIdentity, inputDraftsApproved: false, historicalGenerationRole: 'PAST_EVIDENCE_ONLY',
    numericalDebt: {originalSix: 'docs/automation/prompt15-numerical-deferral.json', scopedSeven: 'reports/prompt15/15-22-sliver-closeout/20261028-closeout-d017f7145d/numerical-deferral-supplement.json', strictFAILAndNativeOnePreserved: true},
    offlineSourceSupportDelivered: false, countryGeometryAudit: 'NOT_RUN', independentDeliveryVerification: 'NOT_RUN', runtimePerformance: 'UNMEASURED'};
  const summary = {schemaVersion: VERSION, status: context.scope === 'WORLD' ? COMPLETE : 'DRAFT_DELIVERY_SMOKE_GENERATED', scope: context.scope,
    ref, counts, deliveryRoot, tileCountsByZoom: byZoom, checks: {exactCellCoverage: true, exactEdgeCoverage: true, tileOrdinals: true,
      administrativeZoom: true, tilePyramid: tiles.length === 5461}, budgets: {render: POLICY.renderByteBudget, initialMetadata: POLICY.initialMetadataByteBudget},
    bytes: {}, independentDeliveryVerification: 'NOT_RUN', countryGeometryAudit: 'NOT_RUN', task15_22OverallPass: false};
  const provBytes = jsonBytes(provenance), provDescriptor = {path: 'provenance.json', sha256: digest(provBytes), byteLength: provBytes.length};
  let indexBytes, summaryBytes, accounting = {delivered: 0, initialMetadata: 0};
  for (let attempt = 0; attempt < 10; attempt++) {
    summary.bytes = {...accounting, tiles: tiles.reduce((n, a) => n + a.byteLength, 0),
      exactAndMetadata: payload.filter(a => !a.path.endsWith('.pbf.gz')).reduce((n, a) => n + a.byteLength, 0)};
    summary.checks.renderByteBudget = accounting.delivered <= POLICY.renderByteBudget; summary.checks.initialMetadataByteBudget = accounting.initialMetadata <= POLICY.initialMetadataByteBudget;
    summaryBytes = jsonBytes(summary);
    const descriptors = [...artifacts, provDescriptor, {path: 'summary.json', sha256: digest(summaryBytes), byteLength: summaryBytes.length}].sort((a, b) => compareText(a.path, b.path));
    indexBytes = jsonBytes({schemaVersion: VERSION, ref, deliveryRoot, artifacts: descriptors, totalByteLength: descriptors.reduce((n, a) => n + a.byteLength, 0)});
    const next = budgetAccounting({artifacts: deliveredArtifacts, deliveryIndexBytes: deliveryIndex.byteLength, artifactIndexBytes: indexBytes.length});
    if (next.delivered === accounting.delivered && next.initialMetadata === accounting.initialMetadata) break;
    accounting = {delivered: next.delivered, initialMetadata: next.initialMetadata}; assert(attempt < 9, 'Index accounting length did not converge');
  }
  fs.writeFileSync(path.join(staging, 'provenance.json'), provBytes, {flag: 'wx'}); fs.writeFileSync(path.join(staging, 'summary.json'), summaryBytes, {flag: 'wx'});
  fs.writeFileSync(path.join(staging, 'artifact-index.json'), indexBytes, {flag: 'wx'});
  assert(summary.checks.renderByteBudget && summary.checks.initialMetadataByteBudget, 'Actual complete delivery bytes exceed frozen budget', summary.bytes);
  verifyTree(staging); return {summary, coverage};
}
export function generateDraftDelivery(options) {
  const {evidence, smokeReceipt} = options; assert(evidence?.startsWith('reports/prompt15/15-21-sliver-adoption/') && !fs.existsSync(evidence), 'Fresh evidence path required');
  fs.mkdirSync(evidence, {recursive: true}); const started = process.hrtime.bigint(), startedAt = new Date().toISOString(); let context, code, root, staging;
  try {
    context = openDeliveryInputs(options); code = codeIdentities(); const codeRoot = digest(jsonBytes(code)), inputRoot = digest(jsonBytes(context.inputPins));
    const runtime = {node: process.version, v8: process.versions.v8, zlib: process.versions.zlib, arch: process.arch, platform: process.platform};
    const sourceIdentity = {policy: POLICY, inputPins: context.inputPins, code, runtime, scope: context.scope, sourceBindings: context.sourceBindings, independentStructure: context.independentReport};
    const key = hashCanonical('prompt15-sliver-delivery-build.v1', sourceIdentity).slice(0, 20);
    root = options.smoke ? `${evidence}/smoke-output` : `data/derived/prompt15/15-21-sliver-adoption-delivery-draft-v1-${key}`;
    staging = options.smoke ? `${evidence}/smoke-staging` : `data/derived/prompt15/.15-21-sliver-adoption-delivery-draft-v1-${key}.staging`;
    assert(!fs.existsSync(root) && !fs.existsSync(staging), 'Refusing existing delivery output');
    if (!options.smoke) {const receipt = readJSON(smokeReceipt); assert(receipt.codeRoot === codeRoot && receipt.inputRoot === inputRoot && receipt.smokeVerified === true, 'Missing/mismatched final smoke verification');}
    fs.writeFileSync(`${evidence}/before.json`, jsonBytes({inputs: context.inputPins, code, codeRoot, inputRoot, runtime}), {flag: 'wx'});
    const result = buildDeliveryAssets(context, {staging, work: `${evidence}/work`, key, sourceIdentity});
    const changedInputs = inputChanges(context.inputPins), changedCode = inputChanges(code); assert(!changedInputs.length && !changedCode.length, 'Inputs or compiler changed during delivery', {changedInputs, changedCode});
    assert(!fs.existsSync(root), 'Output appeared during generation'); fs.renameSync(staging, root);
    const receipt = {...result.summary, root, artifactIndex: identity(`${root}/artifact-index.json`), sourceRoots: {catalog: context.catalogRoot, indices: context.indicesRoot},
      codeRoot, inputRoot, inputChanges: changedInputs, codeChanges: changedCode, startedAt, finishedAt: new Date().toISOString(), resources: resource(started),
      generationRuns: options.smoke ? 0 : 1, fullIndependentDeliveryVerification: 'NOT_RUN', fullCountryGeometryAudit: 'NOT_RUN'};
    fs.writeFileSync(`${evidence}/summary.json`, jsonBytes(receipt), {flag: 'wx'}); console.log(JSON.stringify(receipt)); return receipt;
  } catch (error) {
    fs.writeFileSync(`${evidence}/failure.json`, jsonBytes({status: 'DRAFT_DELIVERY_GENERATION_FAIL', message: error.message, detail: error.detail ?? null, stack: error.stack,
      root: root ?? null, staging: staging ?? null, startedAt, finishedAt: new Date().toISOString(), resources: resource(started),
      inputChanges: context ? inputChanges(context.inputPins) : null, codeChanges: code ? inputChanges(code) : null}), {flag: 'wx'}); throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {if (args[i] === '--smoke') options.smoke = true;
    else {const name = {'--catalog-root': 'catalogRoot', '--indices-root': 'indicesRoot', '--structural-report': 'structuralReport', '--evidence': 'evidence', '--smoke-receipt': 'smokeReceipt'}[args[i]];
      assert(name && args[i + 1] && !args[i + 1].startsWith('--'), `Invalid argument ${args[i]}`); options[name] = args[++i];}}
  try {generateDraftDelivery(options);} catch (error) {console.error(error.stack); process.exitCode = 1;}
}
