// Delivery-only verifier: never imports the generator, tiler, source loader or geometry overlay.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {digest, hashCanonical, jsonBytes, compareText} from './prompt14-catalog-core.mjs';
import {verifyTree, identity, readJSON, readGzipJSON, artifactRoot, tileCoordinates, decodeTilePayload, checkTransportFeature, POLICY, CLASSES} from './prompt15-world-delivery-core.mjs';
import {VERSION, REF_VERSION, assert, equal, missing, openDeliveryInputs, budgetAccounting, resource} from './prompt15-sliver-delivery-adapter.mjs';

export function verifyDraftDelivery(root, context, progress = console.log) {
  const started = process.hrtime.bigint(), tree = verifyTree(root), manifest = readJSON(`${root}/manifest.json`), delivery = readJSON(`${root}/delivery-index.json`),
    tileIndex = readJSON(`${root}/tile-index.json`), detailIndex = readJSON(`${root}/detail-index.json`), summary = readJSON(`${root}/summary.json`), provenance = readJSON(`${root}/provenance.json`);
  assert([tree.index, manifest, delivery, tileIndex, detailIndex, summary, provenance].every(x => x.schemaVersion === VERSION), 'Wrong draft delivery schema');
  assert(manifest.status === 'UNAPPROVED_DRAFT' && manifest.scope === context.scope && manifest.productionPublication === false &&
    manifest.runtimeRegeneration === false && manifest.exactDetailRequired === true && manifest.ref.schemaVersion === REF_VERSION, 'Wrong draft lifecycle/scope');
  equal(manifest.policy, POLICY, 'Frozen transport policy changed'); equal(provenance.inputPins, context.inputPins, 'Upstream input identities changed');
  for (const p of provenance.code) {const actual = identity(p.path); assert(actual.sha256 === p.sha256 && actual.byteLength === p.byteLength, `Compiler/dependency identity changed ${p.path}`);}
  const sourceIdentity = {policy: provenance.policy, inputPins: provenance.inputPins, code: provenance.code, runtime: provenance.runtime,
    scope: provenance.scope, sourceBindings: provenance.sourceBindings, independentStructure: provenance.independentStructure};
  const key = hashCanonical('prompt15-sliver-delivery-build.v1', sourceIdentity).slice(0, 20), ref = manifest.ref;
  assert(ref.catalogVersion === `catalog-sliver-adoption-draft-v1-${key}` && ref.sourceCatalogRoot === context.catalogRoot && ref.sourceIndicesRoot === context.indicesRoot &&
    ref.catalogOrderRoot === context.indexRoot.roots.catalogOrder && ref.topologyRoot === context.indexRoot.roots.topology, 'Wrong source root/catalog reference');
  equal(ref.sourceCatalogIndex, context.trees[0].identity, 'Catalog input index mismatch'); equal(ref.sourceIndicesIndex, context.trees[1].identity, 'Indices input index mismatch');
  equal(ref.membership.sourceBindings, context.sourceBindings, 'Separate membership artifact bindings changed or combined root substituted');
  assert(ref.geometryRoot === artifactRoot('prompt15-15-21-source-geometry.v1', context.trees[0].index.artifacts.filter(a => a.path.endsWith('/geometry.geojson.gz'))), 'Source geometry asset root mismatch');
  for (const value of [tree.index.ref, delivery.ref, tileIndex.ref, detailIndex.ref, summary.ref]) equal(value, ref, 'Cross-index draft reference mismatch');
  const expectedDelivered = tree.index.artifacts.filter(a => !['summary.json', 'provenance.json', 'delivery-index.json'].includes(a.path));
  equal(delivery.artifacts, expectedDelivered, 'Delivered artifact census differs');
  equal(delivery.additionalDeliveredIndexPaths, ['delivery-index.json', 'artifact-index.json'], 'Index self-accounting paths missing');
  assert(delivery.totalByteLength === expectedDelivered.reduce((n, a) => n + a.byteLength, 0) &&
    delivery.deliveryRoot === artifactRoot('prompt15-sliver-delivery-root.v1', expectedDelivered) && tree.index.deliveryRoot === delivery.deliveryRoot && summary.deliveryRoot === delivery.deliveryRoot, 'Wrong delivery root/bytes');
  const payload = expectedDelivered.filter(a => !['manifest.json', 'tile-index.json', 'detail-index.json'].includes(a.path));
  assert(ref.renderArtifactRoot === artifactRoot('prompt15-sliver-delivery-render.v1', payload), 'Render payload root mismatch');
  const descriptor = name => {const a = delivery.artifacts.find(a => a.path === name); assert(a, `Missing delivered descriptor ${name}`); return a;};
  equal(manifest.tileIndex, descriptor('tile-index.json'), 'Manifest tile index mismatch'); equal(manifest.detailIndex, descriptor('detail-index.json'), 'Manifest detail index mismatch');
  const parents = readGzipJSON(`${root}/${detailIndex.parents.path}`);
  equal(detailIndex.parents, descriptor('metadata/parents.json.gz'), 'Parent metadata descriptor mismatch');
  equal(parents.sourceBindings, context.sourceBindings, 'Parent source membership identities changed');
  const expectedCellSet = new Set(context.expectedCells), expectedEdgeSet = new Set(context.expectedEdges), {cellCount, edgeCount} = context;
  const parentGroups = [['administrative', context.admin, new Set(context.expectedCells.map(o => context.admin.parentOrdinalByCell[o - 1]))],
    ['previous', context.previous, new Set(context.expectedCells.map(o => context.previous.oldParentOrdinalByCell[o - 1]))]];
  for (const [kind, source, expectedParents] of parentGroups) {
    const transport = detailIndex.membership[kind]; equal(transport, ref.membership.transport[kind], 'Membership ref transport mismatch');
    equal({...descriptor(transport.path)}, {path: transport.path, sha256: transport.sha256, byteLength: transport.byteLength}, 'Membership transport identity mismatch');
    equal(transport.source, context.sourceBindings[kind], 'Membership source artifact mismatch');
    assert(transport.recordCount === source.cellOrdinals.length && transport.recordBytes === 4 && transport.decodedByteLength === source.cellOrdinals.length * 4, 'Truncated membership transport');
    const bytes = gunzipSync(fs.readFileSync(`${root}/${transport.path}`)); assert(bytes.length === transport.decodedByteLength, 'Missing membership bytes');
    const populated = new Uint8Array(source.cellOrdinals.length);
    assert(parents[kind].length === expectedParents.size, 'Missing/duplicate parent descriptors');
    const used = new Set();
    for (const row of parents[kind]) {
      assert(expectedParents.has(row.ordinal) && !used.has(row.ordinal), 'Unknown/duplicate parent ordinal'); used.add(row.ordinal);
      const p = source.parents[row.ordinal - 1], {historicalParent, ...currentDescriptor} = p;
      equal(row.descriptor, currentDescriptor, 'Current parent identity/count changed');
      equal(row.currentMembership, {start: p.start, count: p.count, recordBytes: 4, format: 'uint32-le-cell-ordinal', artifact: transport}, 'Parent CSR reference changed');
      if (historicalParent) assert(row.historicalGeneration.cellCount === historicalParent.cellCount && row.historicalGeneration.parentHash === historicalParent.parentHash &&
        row.historicalGeneration.role.startsWith('PAST_EVIDENCE_ONLY'), 'Historical count promoted/substituted');
      else assert(row.historicalGeneration === null, 'Invented historical count');
      for (let i = p.start; i < p.start + p.count; i++) {
        assert(!populated[i] && bytes.readUInt32LE(i * 4) === source.cellOrdinals[i], 'Wrong/duplicate/truncated membership value'); populated[i] = 1;
      }
    }
    for (let i = 0; i < populated.length; i++) if (!populated[i]) assert(context.scope !== 'WORLD' && bytes.readUInt32LE(i * 4) === 0, 'Unexplained partial membership data');
  }
  const cells = context.order.cells, cellSeen = new Uint8Array(cellCount + 1), edgeSeen = new Uint8Array(edgeCount + 1), overviewCells = new Uint8Array(cellCount + 1), overviewEdges = new Uint8Array(edgeCount + 1);
  const adminOrdinals = new Map(context.admin.parents.map((p, i) => [p.parentKey, i + 1])), oldOrdinals = new Map(context.previous.parents.map((p, i) => [p.oldTerritoryId, i + 1]));
  equal(detailIndex.countries.map(c => c.countryId), context.activeCountries, 'Country detail directory mismatch');
  for (const c of detailIndex.countries) {
    progress(`[verify scoped exact] ${c.countryId}`);
    equal(c.detail, descriptor(`detail/countries/${c.countryId}.geojson.gz`), 'Exact country descriptor mismatch'); equal(c.metadata, descriptor(`metadata/countries/${c.countryId}.json.gz`), 'Country metadata descriptor mismatch');
    const source = context.readCountry ? context.readCountry(c.countryId) : {geometry: readGzipJSON(`${context.catalogRoot}/countries/${c.countryId}/geometry.geojson.gz`)};
    const byId = new Map(source.geometry.features.map(f => [f.properties.cellId, f.geometry])), detail = readGzipJSON(`${root}/${c.detail.path}`), meta = readGzipJSON(`${root}/${c.metadata.path}`);
    equal(meta.columns, ['cellOrdinal', 'cellId', 'administrativeOrdinal', 'previousParentOrdinal'], 'Wrong country metadata columns');
    assert(meta.schemaVersion === VERSION && meta.countryId === c.countryId && detail.type === 'FeatureCollection' && detail.features.length === c.cellCount && meta.rows.length === c.cellCount && byId.size === c.cellCount, 'Exact country count/schema mismatch');
    let last = 0;
    for (const [i, f] of detail.features.entries()) {
      const cell = cells[f.id - 1]; assert(cell && f.id > last && expectedCellSet.has(f.id) && !cellSeen[f.id] && cell.sourceCountryId === c.countryId, 'Duplicate/stale/unknown exact cell'); last = f.id; cellSeen[f.id] = 1;
      equal(f.geometry, byId.get(cell.id), 'Exact coordinates/hole/positive source face changed'); equal(f.properties, {}, 'Mutable state in exact detail');
      equal(meta.rows[i], [f.id, cell.id, adminOrdinals.get(cell.parentKey), oldOrdinals.get(cell.oldTerritoryId)], 'Wrong global ID/parent row');
    } global.gc?.();
  }
  equal(detailIndex.omittedDerivedEdgeFields, ['lengthKm'], 'Wrong omitted topology fields');
  const left = new Uint32Array(edgeCount + 1), right = new Uint32Array(edgeCount + 1), classes = new Uint8Array(edgeCount + 1), administrative = new Uint8Array(edgeCount + 1);
  const expectedDetails = [];
  for (const shard of context.indexRoot.topologyShards) {
    const src = context.readTopology ? context.readTopology(shard) : readGzipJSON(`${context.indicesRoot}/${shard}`), edges = src.edges.filter(e => expectedEdgeSet.has(e.ordinal));
    if (context.scope !== 'WORLD' && !edges.length) continue; expectedDetails.push(shard);
    const item = detailIndex.edgeDetails.find(d => d.shard === shard); assert(item, 'Missing topology exact shard'); equal(item.artifact, descriptor(`detail/${shard}`), 'Topology exact descriptor mismatch');
    const exact = readGzipJSON(`${root}/${item.artifact.path}`), expected = {schemaVersion: VERSION, sourceSchemaVersion: src.schemaVersion, bucket: src.bucket,
      edges: edges.map(e => {const copy = {...e}; delete copy.lengthKm; return copy;})};
    equal(exact, expected, 'Topology exact coordinates/ID/flags/incidence changed'); assert(item.count === edges.length && item.firstOrdinal === (edges[0]?.ordinal ?? null), 'Topology ordinal descriptor mismatch');
    for (const e of edges) {
      assert(e.ordinal > 0 && e.ordinal <= edgeCount && !edgeSeen[e.ordinal] && expectedCellSet.has(e.left) && (!e.right || expectedCellSet.has(e.right)), 'Duplicate/unknown edge/incidence');
      edgeSeen[e.ordinal] = 1; left[e.ordinal] = e.left; right[e.ordinal] = e.right; classes[e.ordinal] = CLASSES.indexOf(e.boundaryClass); administrative[e.ordinal] = Number(e.flags.administrative);
    }
  }
  equal(detailIndex.edgeDetails.map(d => d.shard), expectedDetails, 'Topology detail directory mismatch');
  assert(!missing(cellSeen, context.expectedCells).length && !missing(edgeSeen, context.expectedEdges).length, 'Missing exact cell/edge');
  equal(manifest.edgeIncidence, {...POLICY.edgeIncidence, artifact: descriptor(POLICY.edgeIncidence.path), recordCount: edgeCount, decodedByteLength: edgeCount * 8, partial: context.scope !== 'WORLD'}, 'Wrong incidence schema/count');
  const binary = gunzipSync(fs.readFileSync(`${root}/${POLICY.edgeIncidence.path}`)); assert(binary.length === edgeCount * 8, 'Missing binary incidence');
  for (let o = 1; o <= edgeCount; o++) assert(binary.readUInt32LE((o - 1) * 8) === left[o] && binary.readUInt32LE((o - 1) * 8 + 4) === right[o], `Wrong/missing incidence record ${o}`);
  const expectedTiles = [...tileCoordinates()]; equal(tileIndex.artifacts.map(a => a.path), expectedTiles.map(t => t.path), 'Incomplete tile pyramid');
  const byZoom = [];
  for (const {z, path: p} of expectedTiles) {
    const a = tileIndex.artifacts.find(a => a.path === p); equal(a, descriptor(p), 'Tile identity not delivered');
    const compressed = fs.readFileSync(`${root}/${p}`), bytes = decodeTilePayload(compressed), tile = new VectorTile(new PbfReader(bytes));
    for (const [name, layer] of Object.entries(tile.layers)) for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i); checkTransportFeature(name, f, cellCount, edgeCount, z);
      if (name === 'territories') {assert(expectedCellSet.has(f.id) && !Object.keys(f.properties).length, 'Unexpected/mutable tile cell'); overviewCells[f.id] = 1;}
      else {assert(expectedEdgeSet.has(f.id) && f.properties.c === classes[f.id] && f.properties.a === administrative[f.id], 'Tile edge class/source mismatch'); overviewEdges[f.id] = 1;}
    }
    const row = byZoom[z] ??= {zoom: z, tiles: 0, nonempty: 0, byteLength: 0, decodedByteLength: 0}; row.tiles++; row.nonempty += Number(bytes.length > 0); row.byteLength += compressed.length; row.decodedByteLength += bytes.length;
  }
  equal(byZoom, tileIndex.tileCountsByZoom, 'Tile per-zoom census changed'); equal(byZoom, summary.tileCountsByZoom, 'Summary zoom census changed');
  const coverage = readGzipJSON(`${root}/${detailIndex.lodCoverage}`), mCells = missing(overviewCells, context.expectedCells), mEdges = missing(overviewEdges, context.expectedEdges);
  equal(coverage, {schemaVersion: VERSION, scope: context.scope, sourceCellCount: cellCount, sourceEdgeCount: edgeCount,
    exactCells: context.expectedCells.length, exactEdges: context.expectedEdges.length, overviewCells: context.expectedCells.length - mCells.length,
    overviewEdges: context.expectedEdges.length - mEdges.length, missingOverviewCellOrdinals: mCells, missingOverviewEdgeOrdinals: mEdges, policy: POLICY.lod}, 'Actual LOD omissions differ');
  const expectedFiles = [...expectedTiles.map(t => t.path), ...context.activeCountries.flatMap(c => [`detail/countries/${c}.geojson.gz`, `metadata/countries/${c}.json.gz`]),
    ...expectedDetails.map(s => `detail/${s}`), 'metadata/parents.json.gz', 'metadata/membership/administrative.bin.gz', 'metadata/membership/previous.bin.gz',
    POLICY.edgeIncidence.path, 'lod-coverage.json.gz', 'manifest.json', 'tile-index.json', 'detail-index.json', 'delivery-index.json', 'summary.json', 'provenance.json'].sort(compareText);
  equal(tree.index.artifacts.map(a => a.path), expectedFiles, 'Unexpected offline/extra/omitted delivery asset');
  const actual = budgetAccounting({artifacts: delivery.artifacts, deliveryIndexBytes: identity(`${root}/delivery-index.json`).byteLength, artifactIndexBytes: tree.identity.byteLength});
  assert(actual.pass && actual.delivered === summary.bytes.delivered && actual.initialMetadata === summary.bytes.initialMetadata, 'Actual complete delivery byte budget/census mismatch');
  return {status: context.scope === 'WORLD' ? 'DRAFT_INDEPENDENT_DELIVERY_PASS_PENDING_COUNTRY_VALIDATION' : 'DRAFT_DELIVERY_SMOKE_VERIFIED', scope: context.scope,
    smokeVerified: context.scope !== 'WORLD', root, artifactIndex: tree.identity, codeRoot: digest(jsonBytes(provenance.code)), inputRoot: digest(jsonBytes(context.inputPins)),
    counts: manifest.counts, bytes: actual, missingOverviewCells: mCells.length, missingOverviewEdges: mEdges.length, resources: resource(started),
    sourceGeometryAudit: 'NOT_RUN', task15_22OverallPass: false};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {}; let root, out;
  for (let i = 0; i < args.length; i++) {if (args[i] === '--smoke') options.smoke = true;
    else {const k = {'--catalog-root': 'catalogRoot', '--indices-root': 'indicesRoot', '--structural-report': 'structuralReport'}[args[i]];
      assert(args[i + 1] && !args[i + 1].startsWith('--'), 'Missing verifier argument');
      if (args[i] === '--delivery-root') root = args[++i]; else if (args[i] === '--out') out = args[++i]; else {assert(k, `Unknown verifier argument ${args[i]}`); options[k] = args[++i];}}}
  try {
    assert(root && out && !fs.existsSync(out), 'Fresh --out report and --delivery-root required');
    const report = verifyDraftDelivery(root, openDeliveryInputs(options)); fs.mkdirSync(path.dirname(out), {recursive: true}); fs.writeFileSync(out, jsonBytes(report), {flag: 'wx'}); console.log(JSON.stringify(report));
  } catch (error) {console.error(error.stack); process.exitCode = 1;}
}
