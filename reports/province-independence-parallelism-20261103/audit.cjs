const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');
const crypto = require('node:crypto');
const {gunzipSync} = require('node:zlib');

// Same server-only and @ aliases as the existing Vitest configuration.
// All game changes below are confined to a newly created in-memory seed.
const empty = require.resolve('next/dist/compiled/server-only/empty.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function(request, ...args) {
  const target = request === 'server-only' ? empty
    : request.startsWith('@/') ? path.resolve('src', request.slice(2)) : request;
  return originalResolve.call(this, target, ...args);
};
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(
  fs.readFileSync(file, 'utf8'),
  {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true}},
).outputText, file);
process.env.NODE_ENV = 'test';

const fromRoot = file => require(path.resolve(file));
const {prepareOperationalCatalog} = fromRoot('src/lib/world/operational-catalog.server.ts');
const {createProductionOperationalGame} = fromRoot('src/lib/world/operational-game.server.ts');
const {transitionWorldStateV3, serializeWorldStateV3, deserializeWorldStateV3, worldStateV3ContentHash} = fromRoot('src/lib/world/world-state-v3.ts');
const {planTerritorialControl} = fromRoot('src/lib/planning/territorial-control-planner.ts');
const {operationalCellView} = fromRoot('src/lib/projection/operational-map-projection.ts');
const {createOperationalRegionIndex} = fromRoot('src/lib/simulation/operational-region.server.ts');
const {selectOperationalFrontier} = fromRoot('src/lib/simulation/operational-frontier.server.ts');
const {createSimulationStateV2} = fromRoot('src/lib/simulation/simulation-state-v2.ts');
const {createCatalogRuntime} = fromRoot('src/lib/simulation/catalog-runtime.ts');
const {createCatalogTurnPlan} = fromRoot('src/lib/simulation/catalog-turn-plan.ts');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pointerFile = 'data/runtime/operational-catalog/current.json';
const pointerBytes = fs.readFileSync(pointerFile);
const pointer = JSON.parse(pointerBytes);
const catalog = prepareOperationalCatalog();
const index = createOperationalRegionIndex(catalog);
const game = createProductionOperationalGame();
const contract = catalog.worldContract();
const base = game.pair.world;
const provenance = JSON.parse(catalog.readDeliveryAsset('provenance.json'));
const checks = [];
const check = (name, ok) => checks.push({name, ok});
check('all IDs globally unique', new Set(base.territoryOrder).size === base.territoryOrder.length);
check('all state entity references distinct', new Set(Object.values(base.territoriesById)).size === base.territoryOrder.length);
check('all state entities frozen', Object.values(base.territoriesById).every(Object.isFrozen));

const countries = [];
for (const [country, other] of [['KOR', 'PRK'], ['PRK', 'CHN'], ['CHN', 'MNG']]) {
  const cells = catalog.loadCountry(country);
  const groups = new Map();
  for (const cell of cells) {
    if (!groups.has(cell.administrativeOrdinal)) groups.set(cell.administrativeOrdinal, []);
    groups.get(cell.administrativeOrdinal).push(cell);
  }
  const chosen = [...groups.values()].find(group => catalog.administrativeParents[group[0].administrativeOrdinal - 1].kind === 'administrative' && group.length > 1 && group.every(
    cell => base.territoriesById[cell.id].ownerCountryId === country && base.territoriesById[cell.id].controllerCountryId === country,
  ));
  if (!chosen) throw Error('AUDIT_CELL_NOT_FOUND:' + country);
  const cell = chosen[0], sibling = chosen[1], initial = base.territoriesById[cell.id];
  const pair = createProductionOperationalGame(other).pair;
  const apply = (world, type, actor, target, extra = {}) => {
    const result = planTerritorialControl({
      world, simulation: pair.simulation, debugDirective: true,
      command: {
        commandId: 'command.audit.' + country + '.' + type, type, expectedRevision: world.revision,
        payload: {actorCountryId: actor, targetCountryId: target, authorityId: 'tca:debug', territoryIds: [cell.id],
          expectedSimulationRevision: pair.simulation.revision, ...extra},
      },
    });
    return {result, world: transitionWorldStateV3(world, contract, {
      territories: Object.fromEntries(result.changes.map(change => [change.after.id, change.after])),
    })};
  };
  const occupied = apply(base, 'territory.occupy', other, country);
  const occupiedCell = occupied.world.territoriesById[cell.id];
  const freed = apply(occupied.world, 'territory.liberate', country, other);
  const transferred = apply(occupied.world, 'territory.transferOwnership', country, other, {newOwnerCountryId: other, controllerPolicy: 'new-owner'});
  const unaffected = base.territoryOrder.filter(id => id !== cell.id);
  const roundtrip = deserializeWorldStateV3(JSON.parse(JSON.stringify(serializeWorldStateV3(transferred.world))), contract);
  const detail = catalog.countryDetail(country).detail;
  const features = JSON.parse(gunzipSync(catalog.readDeliveryAsset(detail.path))).features;
  const ordinals = new Set(cells.map(value => value.ordinal));
  const finding = {
    countryId: country, cellCount: cells.length, regionCount: index.listCountry(country).length,
    administrativeRegionCount: [...groups.keys()].filter(n => catalog.administrativeParents[n - 1].kind === 'administrative').length,
    residualParentCells: cells.filter(value => catalog.administrativeParents[value.administrativeOrdinal - 1].kind !== 'administrative').length,
    detail: {path: detail.path, featureCount: features.length,
      oneFeaturePerCell: features.length === cells.length && new Set(features.map(feature => feature.id)).size === cells.length && features.every(feature => ordinals.has(feature.id)),
      geometryTypes: [...new Set(features.map(feature => feature.geometry.type))]},
    membershipComplete: cells.every(value =>
      catalog.administrativeMembership(catalog.administrativeParents[value.administrativeOrdinal - 1].parentKey).some(member => member.id === value.id)
      && catalog.previousMembership(catalog.previousParents[value.previousParentOrdinal - 1].oldTerritoryId).some(member => member.id === value.id)),
    sample: {cellId: cell.id, siblingId: sibling.id, parentKey: catalog.administrativeParents[cell.administrativeOrdinal - 1].parentKey, parentMembers: chosen.length},
    singleCellOperations: {
      occupationChanges: occupied.result.changes.length,
      occupationOwnerPreserved: occupiedCell.ownerCountryId === country,
      occupationControllerChanged: occupiedCell.controllerCountryId === other,
      allOtherCellsRetainReferences: unaffected.every(id => occupied.world.territoriesById[id] === base.territoriesById[id]),
      sameParentSiblingUnchanged: occupied.world.territoriesById[sibling.id] === base.territoriesById[sibling.id],
      liberationRestoresOwnerController: freed.world.territoriesById[cell.id].ownerCountryId === country && freed.world.territoriesById[cell.id].controllerCountryId === country,
      transferChangesOwnerController: transferred.world.territoriesById[cell.id].ownerCountryId === other && transferred.world.territoriesById[cell.id].controllerCountryId === other,
      immutableSourcePreserved: transferred.world.territoriesById[cell.id].sourceCountryId === country,
      serializationRoundtrip: worldStateV3ContentHash(roundtrip) === worldStateV3ContentHash(transferred.world),
      mapMarksOccupation: operationalCellView(occupied.world, cell.ordinal).occupied,
      mapClearsOccupationAfterTransfer: !operationalCellView(transferred.world, cell.ordinal).occupied,
      baseEntityUnchanged: base.territoriesById[cell.id] === initial && initial.controllerCountryId === country,
    },
  };
  countries.push(finding);
  check(country + ' exact geometry mapping', finding.detail.oneFeaturePerCell);
  check(country + ' runtime memberships', finding.membershipComplete);
  check(country + ' cell operations isolated', Object.entries(finding.singleCellOperations).every(([key, value]) => key === 'occupationChanges' ? value === 1 : value === true));
}

const turns = [];
for (const [actor, target] of [['PRK', 'KOR'], ['KOR', 'PRK'], ['PRK', 'CHN']]) {
  const pair0 = createProductionOperationalGame(actor).pair;
  const attempts = [];
  let selection;
  for (const extent of ['near', 'limited', 'deeper']) {
    try {
      selection = selectOperationalFrontier(catalog, pair0.world, {catalogRef: catalog.ref, baseWorldRevision: pair0.world.revision,
        actorCountryId: actor, targetCountryId: target, operation: 'occupy', extent, direction: null, reference: null, regionQuery: null, cap: 512}, index);
      attempts.push({extent, ok: true, count: selection.cellIds.length});
      break;
    } catch (error) {attempts.push({extent, ok: false, error: error.message});}
  }
  if (!selection) {turns.push({actor, target, attempts, committed: false}); continue;}
  const actionId = 'action.audit.' + target;
  const simulation = createSimulationStateV2({...pair0.simulation, queuedActions: [{
    actionId, actorCountryId: actor, submittedAtDate: pair0.simulation.currentDate,
    text: '[DEBUG_WORLD_EFFECT] Audit bounded occupation', visibility: 'public', status: 'queued',
  }]}, pair0.world);
  const pair = {world: pair0.world, simulation, revisions: {worldRevision: pair0.world.revision, simulationRevision: simulation.revision}};
  const eventId = 'event.audit.' + target;
  const resolution = {
    contractVersion: 'turn-resolution.v1', baseSimulationRevision: simulation.revision, baseWorldRevision: pair.world.revision,
    period: {startDate: simulation.currentDate, endDate: '2020-01-02'},
    playerActionOutcomes: [{outcomeId: 'outcome.audit.' + target, actionId, status: 'succeeded', evidenceEventId: eventId, summary: 'Bounded occupation', remainingConditions: []}],
    events: [{eventId, date: '2020-01-02', title: 'Audit occupation', publicNarrative: 'Selected real catalog cells changed control',
      actorCountryIds: [actor, target], relatedFactIds: [], relatedSituationIds: [],
      causes: [{kind: 'queued-action', id: actionId}], outcomeCategory: 'military', significance: 'notable'}],
    factMutations: [], situationMutations: [], scheduledConsequences: [],
    worldEffects: [{effectId: 'effect.audit.' + target, type: 'territory.occupy', causedByEventId: eventId,
      actorCountryId: actor, targetCountryId: target, authorityId: 'tca:debug', territoryIds: selection.cellIds,
      regionRefs: null, frontierScope: selection.scope}],
    advisorSummary: 'Audit actual catalog partial occupation', unresolvedQuestions: [],
  };
  const runtime = createCatalogRuntime(pair, contract);
  let notifications = 0;
  runtime.subscribeChanges(() => {notifications++;});
  const plan = createCatalogTurnPlan({...pair, turnId: 'turn.audit.' + target, resolution, catalog: contract, regionIndex: index,
    frontier: {world: pair.world, resolve: (world, scope) => selectOperationalFrontier(catalog, world, scope, index)}});
  const committed = runtime.commit(plan), delta = runtime.getLastChange(), selected = new Set(selection.cellIds);
  const changed = pair.world.territoryOrder.filter(id => pair.world.territoriesById[id] !== committed.world.territoriesById[id]);
  const commitNotifications = notifications;
  const undo = runtime.undo(), redo = runtime.redo();
  const result = {
    actor, target, attempts, committed: true, selectedCount: selected.size, changedCount: changed.length,
    exactSelectionOnly: changed.length === selected.size && changed.every(id => selected.has(id)),
    otherCellsRetainReferences: pair.world.territoryOrder.filter(id => !selected.has(id)).every(id => pair.world.territoriesById[id] === committed.world.territoriesById[id]),
    preservesLegalOwner: selection.cellIds.every(id => committed.world.territoriesById[id].ownerCountryId === target && committed.world.territoriesById[id].controllerCountryId === actor),
    deltaCellCount: delta.stateChange.cells.length,
    undoRestoresWorld: worldStateV3ContentHash(undo.world) === worldStateV3ContentHash(pair.world),
    redoRestoresWorld: worldStateV3ContentHash(redo.world) === worldStateV3ContentHash(committed.world),
    commitNotifications, changeNotifications: notifications,
  };
  turns.push(result);
  check(target + ' actual frontier turn isolation', result.exactSelectionOnly && result.otherCellsRetainReferences && result.preservesLegalOwner && result.undoRestoresWorld && result.redoRestoresWorld && commitNotifications === 1);
}
const paths = [
  'AGENTS.md', 'prompts/COUNTRY_MICRO_BOUNDARY_GUIDE.txt', pointerFile,
  'src/lib/world/territory-entity-v3.ts', 'src/lib/world/world-state-v3.ts', 'src/lib/world/operational-catalog.server.ts',
  'src/lib/world/operational-game.server.ts', 'src/lib/world/world-geometry-catalog-ref.ts',
  'src/lib/simulation/catalog-turn-plan.ts', 'src/lib/simulation/operational-region.server.ts',
  'src/lib/planning/territorial-control-planner.ts', 'src/lib/map/operational-delivery.server.ts',
  'src/lib/map/chn-province-presentation.server.ts', 'src/lib/map/chn-boundary-display-lod.server.ts',
  'src/lib/simulation/server/operational-game.server.ts', 'scripts/prompt19-country-core.mjs',
  'scripts/prompt19-country-files.mjs', 'scripts/prepare-prompt19-country.mjs',
  'scripts/chn-2020/incremental-coordinator.mjs', 'scripts/prepare-prompt19-mixed-world.mjs',
  'src/lib/world/operational-mixed-membership.test.ts',
  'reports/province-independence-parallelism-20261103/audit.cjs',
];
const output = {
  schemaVersion: 'province-independence-parallelism-evidence.v1', auditDate: '2026-11-03', timezone: 'Asia/Seoul',
  scope: 'Read-only source/catalog inspection. Isolated fresh seed and development-authority planner probes. Actual catalog frontier and atomic runtime used. No live game, pointer, catalog or application source modified.',
  catalog: {pointer, pointerSha256: sha(pointerBytes), fineCountries: provenance.fineCountries, counts: catalog.descriptor.counts, summary: provenance.summary},
  worldIdentity: {entityCount: base.territoryOrder.length, uniqueEntityReferences: new Set(Object.values(base.territoriesById)).size},
  countries, actualCatalogTurnProbes: turns, checks,
  sourceSnapshots: paths.map(file => {const bytes = fs.readFileSync(file); return {path: file, sha256: sha(bytes), byteLength: bytes.length};}),
  pointerUnchanged: sha(fs.readFileSync(pointerFile)) === sha(pointerBytes),
};
const outFile = path.join(__dirname, 'evidence.json');
fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + '\n', {encoding: 'utf8'});
console.log(JSON.stringify({file: outFile, worldIdentity: output.worldIdentity,
  countries: countries.map(value => ({country: value.countryId, cells: value.cellCount, geometry: value.detail.oneFeaturePerCell,
    memberships: value.membershipComplete, operations: value.singleCellOperations})),
  turns, checks, pointerUnchanged: output.pointerUnchanged}, null, 2));
if (checks.some(value => !value.ok)) process.exitCode = 1;

