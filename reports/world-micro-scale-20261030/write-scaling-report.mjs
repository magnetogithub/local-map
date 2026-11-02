import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';

const root = 'reports/world-micro-scale-20261030';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => {const bytes = fs.readFileSync(file); return {path: file, sha256: sha(bytes), byteLength: bytes.length};};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const pointerPath = 'data/runtime/operational-catalog/current.json', pointer = read(pointerPath), pointerPin = pin(pointerPath);
const indexPath = `${pointer.root}/artifact-index.json`, indexPin = pin(indexPath);
if (indexPin.sha256 !== pointer.index.sha256 || indexPin.byteLength !== pointer.index.byteLength) throw Error('CATALOG_INDEX_IDENTITY');
const index = read(indexPath), artifacts = new Map(index.artifacts.map(a => [a.path, a]));
const checkedArtifact = name => {
  const file = `${pointer.root}/${name}`, actual = pin(file), expected = artifacts.get(name);
  if (!expected || actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) throw Error(`ARTIFACT_IDENTITY:${name}`);
  return {pin: actual, data: name.endsWith('.gz') ? JSON.parse(gunzipSync(fs.readFileSync(file))) : read(file)};
};
const metricArtifact = checkedArtifact('metrics.json.gz'), adjacencyArtifact = checkedArtifact('adjacency.json.gz'), details = checkedArtifact('detail-index.json');
const byId = new Map(metricArtifact.data.map(m => [m.id, m]));
const countryAreas = [];
for (const entry of details.data.countries) {
  const rows = checkedArtifact(entry.metadata.path).data.rows;
  countryAreas.push({countryId: entry.countryId, cells: rows.length, areaKm2: rows.reduce((sum, row) => sum + byId.get(row[1]).areaKm2, 0)});
}
const totalAreaKm2 = countryAreas.reduce((sum, c) => sum + c.areaKm2, 0), nonATAAreaKm2 = countryAreas.filter(c => c.countryId !== 'ATA').reduce((sum, c) => sum + c.areaKm2, 0);
const finalPath = 'reports/chn-2020/final-report.json', final = read(finalPath), current = final.scale.candidate, before = final.scale.baseline;
const baselinePath = 'reports/chn-perf-20261030/baseline-interaction.json', optimizedPath = 'reports/chn-perf-20261030/optimized-interaction.json';
const baseline = read(baselinePath), optimized = read(optimizedPath), capacityPath = `${root}/metadata-capacity.json`, capacity = read(capacityPath);
const nodePlayPath = 'reports/chn-2020/candidate-play-performance.json', nodePlay = read(nodePlayPath);
const browserPlayPath = 'reports/chn-perf-20261030/browser-play/verification.json', browserPlay = read(browserPlayPath);
const measuredSizes = new Map(capacity.scenarios.map(s => [s.count, s]));
const china = final.scale.selectedCountries.CHN;
if (metricArtifact.data.length !== current.cells || adjacencyArtifact.data.cellCount !== current.cells ||
    countryAreas.length !== current.countries || index.totalByteLength !== current.bytes.total ||
    final.activePointer.sha256 !== pointerPin.sha256) throw Error('CURRENT_CATALOG_AND_HISTORICAL_SCALE_PROOF_DIFFER');
const incremental = {cells: current.cells - before.cells, bytes: current.bytes.total - before.bytes.total,
  polygonCoordinates: current.polygonCoordinateCount - before.polygonCoordinateCount, edges: current.edges - before.edges};
const fullIdStringBytesPerCell = Buffer.byteLength('territory:catalog:' + 'a'.repeat(64)) + 3;
const scenarios = [50000, 100000, 250000, 500000].map(cells => {
  const measured = measuredSizes.get(cells), scale = cells / current.cells;
  const estimates = {mixedCurrentProportional: {method: 'Linear current whole-package ratios; planning scenario, not generated output or a performance forecast.',
    edges: Math.round(current.edges * scale), storedPolygonCoordinates: Math.round(current.polygonCoordinateCount * scale), storedEdgeCoordinates: Math.round(current.edgeCoordinateCount * scale),
    immutablePackageBytes: Math.round(current.bytes.total * scale), compressedMetadataBytes: Math.round(current.bytes.metadata * scale),
    globalIncidenceUint32PairBytes: Math.round(current.edges * scale) * 8,
    float64StoredPolygonAndEdgeCoordinateBytesIfAllResident: Math.round((current.polygonCoordinateCount + current.edgeCoordinateCount) * scale) * 16},
  chinaIncrementalProportional: {method: 'Keep current package, then apply the measured CHN increment per additional cell; includes duplicated country/cell-shard storage in this delivery format.',
    immutablePackageBytes: Math.round(current.bytes.total + (cells - current.cells) * incremental.bytes / incremental.cells),
    storedPolygonCoordinates: Math.round(current.polygonCoordinateCount + (cells - current.cells) * incremental.polygonCoordinates / incremental.cells),
    edges: Math.round(current.edges + (cells - current.cells) * incremental.edges / incremental.cells)},
  fullBrowserIdOrderRawJsonBytes: cells * fullIdStringBytesPerCell + 1,
  compactSourceOwnerControllerUint16ColumnsOnlyBytes: cells * 6,
  compactColumnsCaveat: 'Only three numeric country columns; excludes IDs, parent indexes, revision metadata, adjacency, geometry, history and validation. This layout is not implemented.'};
  return {cells, measuredGeography: false, actualMetadataFixture: measured ? {count: measured.count, retainedStateHeapBytes: measured.retainedStateHeapBytes,
    retainedAdditionalFullMapCopyHeapBytes: measured.retainedAdditionalFullMapCopyHeapBytes, byteSizes: measured.byteSizes,
    mediansMs: Object.fromEntries(Object.entries(measured.timings).map(([k, t]) => [k, t.medianMs]))} : null,
  metadata500kPlanningOnly: !measured ? {method: 'Twice the 250k retained-memory observation only; no 500k allocation or execution, no latency extrapolation.',
    retainedStateHeapBytes: measuredSizes.get(250000).retainedStateHeapBytes * 2,
    retainedAdditionalFullMapCopyHeapBytes: measuredSizes.get(250000).retainedAdditionalFullMapCopyHeapBytes * 2} : null, estimates};
});
for (const scenario of scenarios) {
  const oneMap = scenario.actualMetadataFixture?.retainedAdditionalFullMapCopyHeapBytes ?? scenario.metadata500kPlanningOnly.retainedAdditionalFullMapCopyHeapBytes;
  scenario.historyKeyTablePlanning = {method: 'Retain one additional shallow global map per changed turn, using this synthetic Node observation; not a measured game history or browser heap.',
    additionalKeyTableBytesPerChangedTurn: oneMap, oneSession100ChangedTurnTablesBytes: oneMap * 100, eightSessions100ChangedTurnTablesBytes: oneMap * 800,
    excludes: 'Entity bodies, plans, simulation, catalog indexes, rendering and checkpoints; counts only the extra key tables. Structural/paged storage would change this estimate.'};
}
const sourcePaths = ['src/lib/world/operational-catalog.server.ts', 'src/lib/world/operational-game.server.ts', 'src/lib/world/world-state-v3.ts',
  'src/lib/world/world-v3-runtime-hash.ts', 'src/lib/world/domain-hash-root.ts', 'src/lib/world/operational-state-change.ts',
  'src/lib/simulation/operational-frontier.server.ts', 'src/lib/simulation/operational-region.server.ts', 'src/lib/simulation/catalog-turn-plan.ts',
  'src/lib/simulation/catalog-runtime.ts', 'src/lib/simulation/atomic-turn-runtime.ts', 'src/lib/simulation/server/operational-game-session.ts',
  'src/lib/simulation/server/operational-game.server.ts', 'src/lib/simulation/client/operational-game-client.ts',
  'src/lib/simulation/client/operational-game-loader.ts', 'src/app/api/world/catalog/operational/cells/route.ts',
  'src/lib/map/operational-vector-delivery.ts', 'src/lib/map/operational-map-consumer.ts', 'src/lib/projection/operational-map-projection.ts',
  'scripts/prepare-prompt19-mixed-world.mjs'];
const report = {
  schemaVersion: 'world-micro-scale-readonly-audit-v1', createdAt: new Date().toISOString(),
  conclusion: {readyForWorldwideChinaScaleUnchanged: false, suitability: 'Country-by-country experimental additions are supported. Worldwide fine detail needs a different global state/index/LOD capacity design and measured staged load gates before rollout.',
    noGlobalImplementationPerformed: true, noOtherCountryFineGenerated: true, noCatalogOrApplicationEdited: true, noBrowserServerOrAIUsedByThisAudit: true},
  evidence: {pointer: pointerPin, artifactIndex: indexPin, metrics: metricArtifact.pin, adjacency: adjacencyArtifact.pin, detailIndex: details.pin,
    countryDensityMetadata: details.data.countries.map(c => pin(`${pointer.root}/${c.metadata.path}`)),
    historicalChinaImplementation: pin(finalPath), historicalPerformanceBefore: pin(baselinePath), historicalPerformanceAfter: pin(optimizedPath),
    historicalNodePlay: pin(nodePlayPath), historicalBrowserPlay: pin(browserPlayPath), metadataCapacity: pin(capacityPath),
    sourceDecision: pin('reports/chn-2020/source-decision.json'), sourceAudit: sourcePaths.map(pin),
    diagnosticCode: [pin(`${root}/metadata-capacity.mjs`), pin(`${root}/write-scaling-report.mjs`)]},
  actualCurrentCatalog: {catalogVersion: pointer.catalogVersion, countries: 247, cells: current.cells, edges: current.edges,
    storedPolygonCoordinateCount: current.polygonCoordinateCount, storedEdgeCoordinateCount: current.edgeCoordinateCount,
    coordinateDefinition: final.scale.vertexDefinition, immutablePackageBytes: current.bytes.total, detailBytes: current.bytes.exactDetail,
    duplicateCellShardBytes: current.bytes.cellShards, compressedMetadataBytes: current.bytes.metadata,
    adjacencyNeighborEntries: adjacencyArtifact.data.neighbors.length, china: {cells: china.cells, storedPolygonCoordinates: china.polygonCoordinateCount,
      incidentEdges: china.incidentEdges, compressedWholeCountryDetailBytes: china.detailCompressedBytes}},
  densityBasedPlanning: {method: 'Sum actual pinned geodesic per-cell metrics by CURRENT source-country metadata, then apply observed cells/km2. No external land-area statistic and no247-times-China multiplication.',
    totalCurrentGameAreaKm2: totalAreaKm2, currentGameAreaExcludingOnlyCountryATAKm2: nonATAAreaKm2,
    caveats: ['This is the current game extent, not a claim about official national areas, political attribution, or a uniform historical administrative level.',
      'Stored cell count includes disconnected pieces and explicit residuals. Same density is a sensitivity calculation, not a global administrative-source inventory.',
      'Excluding country ATA means that source-country ID only; it is not an authoritative geographic Antarctica mask.'],
    selectedCountryDensities: ['CHN', 'KOR', 'PRK'].map(id => {const c = countryAreas.find(c => c.countryId === id); return {...c,
      cellsPerMillionKm2: c.cells / c.areaKm2 * 1e6, meanAreaKm2: c.areaKm2 / c.cells,
      wholeCurrentGameEquivalentCells: Math.round(c.cells / c.areaKm2 * totalAreaKm2),
      excludingCountryATAEquivalentCells: Math.round(c.cells / c.areaKm2 * nonATAAreaKm2)};}), countryAreas},
  measuredPerformance: {scope: 'Historical paired Next development Chromium interaction reports and existing production-runtime scripted turns; not a worldwide performance experiment.',
    interactionConditions: optimized.conditions, hardware: optimized.hardware,
    phases: optimized.phases.map(after => {const old = baseline.phases.find(p => p.name === after.name); return {name: after.name,
      before: old ? {durationMs: old.durationMs, p95FrameMs: old.frames.p95Ms, heapAfterBytes: old.heapAfter?.usedJSHeapSize} : null,
      after: {durationMs: after.durationMs, p95FrameMs: after.frames.p95Ms, heapAfterBytes: after.heapAfter?.usedJSHeapSize,
        exactCells: after.exactCells.length, exactEdges: after.exactEdges.length}};}),
    stableScope: optimized.stableScope,
    nodeGameStartup: nodePlay.initialization,
    actualBrowserTurns: browserPlay.turns.map(t => ({condition: t.condition, committedMs: t.committedMs, renderedMs: t.renderedMs, changedCells: t.changedCellIds.length})),
    limitations: ['Headless SwiftShader software rendering and rAF-paced jumpTo are not a hardware-GPU FPS guarantee.',
      'Measured optimized world p95 remains about116.7ms, China150ms; no steady60FPS claim is supported.',
      'Later province-boundary presentation work can change UI code. Historical performance pins identify the measured versions; this audit does not rerun or certify the latest browser.',
      'Do not multiply whole browser heap or frame time by global cell count: viewport geometry, labels, caches and GPU work have different scaling factors.']},
  capacityOnlyBenchmark: {artifact: pin(capacityPath), productionGameBenchmark: false, geometricOrSourceEvidence: false,
    observations: capacity.scenarios.map(s => ({count: s.count, retainedStateHeapBytes: s.retainedStateHeapBytes,
      retainedAdditionalFullMapCopyHeapBytes: s.retainedAdditionalFullMapCopyHeapBytes,
      mediansMs: Object.fromEntries(Object.entries(s.timings).map(([k, t]) => [k, t.medianMs]))})), limitations: capacity.limitations},
  scenarios, projectionsAreEstimatesNotMeasuredWorldwideOutput: true,
  concreteHotPaths: [
    {path: 'src/lib/world/operational-catalog.server.ts', symbols: ['worldContract', 'loadAll', 'cell', 'cellMetrics', 'edge', 'administrativeMembership'],
      behavior: 'worldContract loads every country and builds full by-ID/by-ordinal metadata+contract records. An uncached cell lookup can trigger loadAll. First metric lookup parses the entire metrics file. All accessed exact edge shards remain in the server Map. Parent membership filters a complete country each call.',
      scaling: 'O(global cells) startup/metrics, O(accessed geometry) unbounded server exact cache; repeated O(country cells) membership scans.'},
    {path: 'src/lib/world/world-state-v3.ts', symbols: ['readWorldStateV3', 'transitionWorldStateV3'],
      behavior: 'Initial validation constructs all territories. A one-cell change spreads the entire territoriesById record, sharing entity objects but allocating a new global key table.', scaling: 'O(global cells) per changed record; shallow sharing does not remove the full map copy.'},
    {path: 'src/lib/simulation/client/operational-game-client.ts', symbols: ['createOperationalGameClient', 'apply'],
      behavior: 'Browser expands the complete initial runs into one entity per global ID. Each nonempty delta spreads that full record. Subsequent snapshots omit unchanged territory bodies, so network deltas are already smaller than the in-memory state.', scaling: 'O(global cells) browser startup and nonempty world-delta map copy.'},
    {path: 'src/lib/world/operational-state-change.ts', symbols: ['createOperationalStateChange'],
      behavior: 'Every new territory record compares all IDs to derive one or a few changed cells. Runtime publish and arbitrary snapshot catch-up can call it.', scaling: 'O(global cells), even when effect cap is512 and actual changed cells1.'},
    {path: 'src/lib/world/world-v3-runtime-hash.ts', symbols: ['root', 'worldV3RuntimeContentHash'], relatedPath: 'src/lib/world/domain-hash-root.ts',
      behavior: 'Immutable leaf hashes are cached, but a new record materializes all entries, sorts all leaf keys and canonically encodes the complete root input.', scaling: 'At least O(global cells) bytes, sorting O(N log N) in general. Cached leaves do not make the domain root update incremental.'},
    {path: 'src/lib/simulation/operational-frontier.server.ts', symbols: ['selectOperationalFrontier'],
      behavior: 'Before bounded Dijkstra, walks every territory to discover current actor/target and eligible cells, then examines eligible target adjacency and contacts. Near-parent area calculation traverses whole parent membership.',
      scaling: 'O(global cells + target eligible adjacency) prefix.512 limits output/traversal, not the prefix, map copies, root hashing or source decode.'},
    {path: 'src/lib/simulation/atomic-turn-runtime.ts', symbols: ['CommittedTurnHistoryEntry', 'getHistory', 'commit'], relatedPath: 'src/lib/simulation/server/operational-game-session.ts',
      behavior: 'Undo history retains before/after world snapshots and plans. Distinct shallow-copied global key tables remain reachable. The session versions map64 bound is not an engine-history size bound. The server permits up to8 local sessions.',
      scaling: 'Potential O(turn history × global cells) retained key-table slots; initial immutable entities are shared, but each changed record table is distinct.'},
    {path: 'src/lib/map/operational-vector-delivery.ts', symbols: ['loadOperationalVectorDelivery', 'incidentEdges', 'loadEdgeDetails', 'loadCountryViewportDetail', 'indexTile'],
      behavior: 'Global edge incidence and reverse incidence are initialized for the entire catalog; seenCells/seenEdges/indexedTilePaths retain visited IDs. Country metadata LRU16, decoded bytes32MiB, parsed shards4MiB/8 entries, selected-cell/edge caches4MiB each bound portions of geometry, not total worker/GPU source memory.',
      scaling: 'O(global cells+edges) metadata. Viewport decoding still encounters full intersecting shards. Source geometry and MapLibre tile/worker memory need separate budgets.'},
    {path: 'scripts/prepare-prompt19-mixed-world.mjs', symbols: ['edgeDetails', 'geojson-vt options', 'tiles'],
      behavior: 'Topology shards currently hold up to2048 edge records, rather than a strict decoded-byte/spatial budget. Readers require exactly3 decimal shard digits. Render tiles are all explicitly indexed for zoom0–6; micro IDs remain logically represented in the overview pipeline.',
      scaling: '500k mixed-model cells implies about1.64M edges/~802 shards, within3digits but near the format ceiling; >2.048M edges requires a format change. Fixed per-edge counts do not bound coordinate bytes.'},
  ],
  prerequisites: [
    {priority: 1, topic: 'Display LOD independent of logical fine IDs', work: 'Render country/macro aggregates at world zoom, load fine fills and boundaries only at useful scales/viewport, retain exact changed/occupied cells and fronts at every needed scale. Generate all aggregate boundaries from the same authoritative partition and verify shared fill/edge coverage. Preserve macro boundaries in normal mode while micro lines stay debug-only.', gate: 'Actual world/China/dense-city/coast/border hardware and software browser frame/heap/transfer budgets; visual+tile coverage proofs.'},
    {priority: 1, topic: 'Paged state and incremental roots/history', work: 'Separate immutable source geometry/IDs/parents from owner/controller columns. Use ordinal-indexed pages or persistent chunks/sparse overrides, copying touched pages only. Update authenticated roots from touched pages. Keep revision/catalog/atomic rollback/owner-controller checks, undo/redo and preserved sessions intact.', gate: 'Real512-cell and1-cell commits plus long undo/redo histories at50k/100k/250k/500k without full-map copy or full root rebuild.'},
    {priority: 1, topic: 'Current-state frontier and parent indexes', work: 'Maintain owner/controller membership and live border indexes incrementally from validated deltas; cache immutable parent membership/area totals. Restrict lookup work to relevant current fronts, not global keys. Keep distance/width/area/parent/authority512 limits unchanged.', gate: 'Existing military negative controls, stale revisions, changed controllers and bidirectional followups pass at scale; bounded visited work recorded.'},
    {priority: 2, topic: 'Spatial+byte-bounded immutable transport', work: 'Index cell/edge shards by bbox or spatial tiles and country pair; set decoded-byte/vertex caps, cancellation and backpressure. Avoid scanning all shards and avoid repeated giant coastal features. Expand shard addressing before3digit limits and keep content hashes/version isolation.', gate: 'Pan across multiple countries and coast complexity under an explicit network/decoded-memory budget; no national whole-geometry request.'},
    {priority: 2, topic: 'Paged initial snapshots and session persistence', work: 'Deliver compact ordinal state and catalog mapping pages/range manifests rather than every full hash ID and JS entity upfront. Retain source country and owner/controller separately. Persist structural chunks/checkpoints and deltas so session/history cost does not multiply full global maps.', gate: 'Cold/warm startup,8 session capacity, long-run checkpoint+restore, catalog coexistence and old-game continuity tested with exact pins.'},
    {priority: 2, topic: 'Country source programme and incremental validation', work: 'Research each country vintage/hierarchy/IDs/CRS/license separately; preserve current country masks and fine neighbours; independently verify seams/residuals, raw replay and delivery. Dense cities, sparse counties, islands and coast complexity need different natural unit choices rather than identical ADM labels or cell quotas.', gate: 'No247-times-China assumption, no uniform-source historical claim; publish only immutable per-country candidates with source-specific proof.'},
  ],
  decisionByPlanningSize: [
    {cells: 50000, assessment: 'Plausible engineering pilot after state/index/LOD work; current unchanged object-copy/root paths already show meaningful capacity cost. Not certified as playable by the metadata benchmark.'},
    {cells: 100000, assessment: 'Current architecture should not be rolled out unchanged; measured metadata copy and root lower-bound are already roughly100ms and140ms separately on this host.'},
    {cells: 250000, assessment: 'Requires paged/indexed state, true display aggregation and bounded spatial delivery before geographic integration; metadata-only copy265ms and root lower-bound436ms do not include rendering or full validation.'},
    {cells: 500000, assessment: 'Longer-term capacity target only. No actual500k fixture/browser/turn was run; package/coordinate/state estimates identify planning bounds, not a runtime guarantee.'},
  ],
  unresolved: ['No worldwide candidate or complete historical/licensed country-source inventory exists in this audit.',
    'No globe-wide exact adjacency/coastline complexity or full rendered geometry memory has been measured.',
    'No hardware-GPU browser run,500k runtime,8 concurrent fine games or long historical simulation was executed here.',
    'Geographic source precision and administrative density vary; coast-heavy island states and large sparse counties can violate simple per-cell storage ratios.',
    'The current macro-boundary UI correction is parent-owned; this report neither changes it nor substitutes for its visual verification.'],
};
if (pin(pointerPath).sha256 !== pointerPin.sha256) throw Error('ACTIVE_POINTER_CHANGED_DURING_AUDIT');
const output = `${root}/scaling-audit.json`; fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({report: pin(output), currentAreaKm2: totalAreaKm2, density: report.densityBasedPlanning.selectedCountryDensities,
  scenarios: scenarios.map(s => ({cells: s.cells, packageBytesMixed: s.estimates.mixedCurrentProportional.immutablePackageBytes,
    packageBytesCHNIncrement: s.estimates.chinaIncrementalProportional.immutablePackageBytes, metadataBench: !!s.actualMetadataFixture}))}));
