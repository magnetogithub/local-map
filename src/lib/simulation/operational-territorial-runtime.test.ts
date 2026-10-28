// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {createCatalogRuntime, type CatalogRuntimeChange, type CatalogRuntimePair} from './catalog-runtime';
import {createCatalogTurnPlan} from './catalog-turn-plan';
import {createSimulationStateV2} from './simulation-state-v2';
import {createWorldStateV3} from '../world/world-state-v3';
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from '../world/world-geometry-catalog-ref';
import {OPERATIONAL_CATALOG_VERSION} from '../world/operational-catalog';
import {createCatalogRegionIndex, resolveCatalogRegionEffects} from './catalog-region';
import {planTerritorialControlBatch} from '../planning/territorial-control-planner';
import type {OperationalFrontierValidation} from './operational-frontier-validation';
import type {OperationalSelection} from '../world/operational-catalog';
import {parseTurnResolutionV1} from './turn-resolution';

function fixture(count = 6) {
  const ids = Array.from({length: count}, (_, i) => readCatalogTerritoryId(`territory:catalog:${(i + 1).toString(16).padStart(64, '0')}`));
  const catalog = createWorldGeometryCatalogContract({ref: {catalogVersion: OPERATIONAL_CATALOG_VERSION,
    geometryRoot: '1'.repeat(64), topologyRoot: '2'.repeat(64), renderArtifactRoot: '3'.repeat(64),
    manifestPath: `/data/territory-catalog/${OPERATIONAL_CATALOG_VERSION}/manifest.json`}, territoryOrder: ids,
    territoriesById: Object.fromEntries(ids.map((id, i) => [id, {id, sourceCountryId: i ? 'BBB' : 'AAA'}]))});
  const countries = ['AAA', 'BBB', 'CCC'].map((id, i) => ({id, names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
    politicalStatus: 'sovereign', presentationOverride: null, moduleVersions: {core: 1}, mapColor: ['#00CC00', '#CC0000', '#0000CC'][i]}));
  const world = createWorldStateV3({schemaVersion: 3, seedVersion: 'seed-v1', policyVersion: 'policy-v1', revision: 0,
    countriesById: Object.fromEntries(countries.map(c => [c.id, c])), countryOrder: ['AAA', 'BBB', 'CCC'], retiredCountryIds: new Set(),
    territoriesById: Object.fromEntries(ids.map((id, i) => [id, {id, sourceCountryId: i ? 'BBB' : 'AAA',
      ownerCountryId: i ? 'BBB' : 'AAA', controllerCountryId: i ? 'BBB' : 'AAA'}])), territoryOrder: ids, catalogRef: catalog.ref}, catalog);
  const ground = {eventId: 'event.ground', date: '2020-01-01', title: '기존 전황', publicNarrative: '검증된 전황과 협상 기록',
    actorCountryIds: ['AAA', 'BBB', 'CCC'], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: 'military', significance: 'notable'};
  const authority = (id: string, actor: string, target: string, operation: string, scope = ids.slice(1)) => ({id, actorCountryId: actor,
    targetCountryId: target, allowedOperations: [operation], allowedTerritoryIds: scope, validFrom: '2020-01-01', validTo: null, sourceEventId: ground.eventId});
  const authorities = [authority('tca:occupy', 'AAA', 'BBB', 'occupy'), authority('tca:transfer', 'BBB', 'CCC', 'transfer')];
  const simulation = createSimulationStateV2({schemaVersion: 2, revision: 0, currentDate: '2020-01-01', turnNumber: 0, playerCountryId: 'AAA',
    queuedActions: [], factsById: {}, factOrder: [], situationsById: {}, situationOrder: [], scheduledConsequences: [], eventLog: [ground],
    history: {lastCommittedTurnId: null, committedTurnCount: 0}, territorialControlAuthoritiesById: Object.fromEntries(authorities.map(a => [a.id, a])),
    territorialControlAuthorityOrder: authorities.map(a => a.id), countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: []}, world);
  const pair: CatalogRuntimePair = Object.freeze({world, simulation, revisions: Object.freeze({worldRevision: 0, simulationRevision: 0})});
  const occupy = (scope = [ids[1]], effectId = 'effect.occupy') => ({effectId, causedByEventId: 'event.operation', type: 'territory.occupy',
    actorCountryId: 'AAA', targetCountryId: 'BBB', authorityId: 'tca:occupy', territoryIds: scope, regionRefs: null});
  const resolution = (base: CatalogRuntimePair, worldEffects: unknown[], endDate = '2020-01-02') => ({contractVersion: 'turn-resolution.v1',
    baseSimulationRevision: base.simulation.revision, baseWorldRevision: base.world.revision, period: {startDate: base.simulation.currentDate, endDate},
    playerActionOutcomes: [], events: [{...ground, eventId: 'event.operation', date: endDate, causes: [{kind: 'authoritative-event', id: ground.eventId}]}],
    factMutations: [], situationMutations: [], scheduledConsequences: [], worldEffects, advisorSummary: '전황을 반영합니다.', unresolvedQuestions: []});
  const bind = (base: CatalogRuntimePair, r: ReturnType<typeof resolution>) => {
    const selected = new Map<string, OperationalSelection>();
    const worldEffects = r.worldEffects.map(raw => {
      const effect = raw as ReturnType<typeof occupy>;
      if (!['territory.occupy', 'territory.liberate', 'territory.transferOwnership'].includes(effect.type)) return raw;
      const operation = effect.type === 'territory.occupy' ? 'occupy' : effect.type === 'territory.liberate' ? 'liberate' : 'transfer';
      const selection: OperationalSelection = {catalogRef: catalog.ref, baseWorldRevision: base.world.revision,
        actorCountryId: effect.actorCountryId, targetCountryId: effect.targetCountryId, operation, cellIds: effect.territoryIds};
      const reference = {catalogId: catalog.ref.catalogVersion, sourceVersion: catalog.ref.geometryRoot, subdivisionId: `fixture:${effect.effectId}`};
      selected.set(reference.subdivisionId, selection);
      return {...effect, frontierScope: {catalogRef: catalog.ref, baseWorldRevision: base.world.revision,
        actorCountryId: effect.actorCountryId, targetCountryId: effect.targetCountryId, operation, extent: 'near', reference, cap: 512}};
    });
    // 16-06 tests the graph selector. Here a deterministic host selection port
    // keeps these tests focused on authoritative commit and history behavior.
    const frontier: OperationalFrontierValidation = {world: base.world, resolve: (_world, scope) => selected.get(scope.reference!.subdivisionId)!};
    return {resolution: {...r, worldEffects}, frontier};
  };
  const plan = (base: CatalogRuntimePair, effects: unknown[], turnId = 'turn.operation', endDate = '2020-01-02') => {
    const r = resolution(base, effects, endDate);
    // Turn event IDs are unique across the authoritative event log.
    const eventId = `event.${turnId}`;
    return createCatalogTurnPlan({...base, catalog, turnId, ...bind(base, {...r, events: r.events.map(e => ({...e, eventId})),
      worldEffects: effects.map(effect => ({...effect as object, causedByEventId: eventId,
        ...((effect as {type?: string}).type === 'territorialAuthority.granted'
          ? {authority: {...(effect as {authority: object}).authority, sourceEventId: eventId}} : {})}))})});
  };
  return {pair, catalog, ids, authority, occupy, resolution, bind, plan};
}

describe('16-03 authoritative operational cell turns', () => {
  it('occupies only selected cells, commits one pair, and emits complete deltas through advance/undo/redo', () => {
    const f = fixture(), runtime = createCatalogRuntime(f.pair, f.catalog), changes: CatalogRuntimeChange[] = [];
    const display = new Map(f.ids.map(id => [id, f.pair.world.territoriesById[id].controllerCountryId]));
    runtime.subscribeChanges(change => {changes.push(change); for (const cell of change.stateChange?.cells ?? []) display.set(cell.id, cell.after.controllerCountryId);});
    let notifications = 0; runtime.store.subscribe(() => {notifications++;});
    const first = runtime.commit(f.plan(runtime.getSnapshot(), [f.occupy()]));
    expect(notifications).toBe(1); expect(changes).toHaveLength(1);
    expect(changes[0].changedCountryIds).toEqual(['AAA', 'BBB']);
    expect(first.world.territoriesById[f.ids[1]].ownerCountryId).toBe('BBB');
    expect(first.world.territoriesById[f.ids[1]].controllerCountryId).toBe('AAA');
    expect(first.world.territoriesById[f.ids[2]]).toBe(f.pair.world.territoriesById[f.ids[2]]);
    expect(first.world.countriesById).toBe(f.pair.world.countriesById);
    const second = runtime.commit(f.plan(runtime.getSnapshot(), [f.occupy([f.ids[2]])], 'turn.advance', '2020-01-03'));
    expect(second.world.territoriesById[f.ids[1]]).toBe(first.world.territoriesById[f.ids[1]]);
    expect(changes.at(-1)?.stateChange?.cells.map(c => c.id)).toEqual([f.ids[2]]);
    expect(runtime.getHistory().entries).toHaveLength(2);
    const undone = runtime.undo(), undoChange = runtime.getLastChange()!;
    expect(undone.simulation.currentDate).toBe(first.simulation.currentDate);
    expect(undoChange.kind).toBe('undo'); expect(undoChange.requiresFullRefresh).toBe(false);
    expect(undoChange.stateChange?.cells[0].before.controllerCountryId).toBe('AAA');
    expect(undoChange.stateChange?.cells[0].after.controllerCountryId).toBe('BBB');
    expect([...display]).toEqual(f.ids.map(id => [id, undone.world.territoriesById[id].controllerCountryId]));
    const redone = runtime.redo(), redoChange = runtime.getLastChange()!;
    expect(redoChange.kind).toBe('redo'); expect(redoChange.stateChange?.cells.map(c => c.id)).toEqual([f.ids[2]]);
    expect(redoChange.stateChange?.baseWorldRevision).toBe(undone.world.revision);
    expect(redoChange.stateChange?.worldRevision).toBe(redone.world.revision);
    expect(redoChange.next).toBe(runtime.getSnapshot());
    expect([...display]).toEqual(f.ids.map(id => [id, redone.world.territoriesById[id].controllerCountryId]));
    expect(Object.isFrozen(redoChange.stateChange?.cells)).toBe(true);
    expect(Object.isFrozen(redoChange.stateChange?.cells[0])).toBe(true);
  });

  it('liberates to the preserved owner and restores occupation and grant history on undo/redo', () => {
    const f = fixture(), runtime = createCatalogRuntime(f.pair, f.catalog);
    runtime.commit(f.plan(runtime.getSnapshot(), [f.occupy()]));
    const occupied = runtime.getSnapshot();
    const grant = {effectId: 'effect.grant', type: 'territorialAuthority.granted', authority: {
      ...f.authority('tca:liberate', 'BBB', 'AAA', 'liberate', [f.ids[1]]), validFrom: '2020-01-03'}};
    const effect = {...f.occupy(), type: 'territory.liberate', actorCountryId: 'BBB', targetCountryId: 'AAA', authorityId: 'tca:liberate'};
    const freed = runtime.commit(f.plan(occupied, [grant, effect], 'turn.liberate', '2020-01-03'));
    expect(freed.world.territoriesById[f.ids[1]]).toMatchObject({ownerCountryId: 'BBB', controllerCountryId: 'BBB', sourceCountryId: 'BBB'});
    expect(freed.simulation.eventLog.some(e => e.authorityLifecycle?.authorityId === 'tca:liberate')).toBe(true);
    expect(runtime.getLastChange()?.stateChange?.cells.map(c => c.id)).toEqual([f.ids[1]]);
    const undo = runtime.undo(); expect(undo.world.territoriesById[f.ids[1]].controllerCountryId).toBe('AAA');
    expect(undo.simulation.eventLog).toEqual(occupied.simulation.eventLog);
    expect(runtime.redo().simulation.eventLog).toEqual(freed.simulation.eventLog);
  });

  it.each(['preserve', 'new-owner'])('transfers selected ownership with %s controller policy and keeps source identity', controllerPolicy => {
    const f = fixture(), runtime = createCatalogRuntime(f.pair, f.catalog);
    runtime.commit(f.plan(runtime.getSnapshot(), [f.occupy()]));
    const occupied = runtime.getSnapshot();
    const effect = {...f.occupy(), type: 'territory.transferOwnership', actorCountryId: 'BBB', targetCountryId: 'CCC',
      authorityId: 'tca:transfer', newOwnerCountryId: 'CCC', controllerPolicy};
    const transferred = runtime.commit(f.plan(occupied, [effect], 'turn.transfer', '2020-01-03'));
    expect(transferred.world.territoriesById[f.ids[1]]).toMatchObject({ownerCountryId: 'CCC',
      controllerCountryId: controllerPolicy === 'preserve' ? 'AAA' : 'CCC', sourceCountryId: 'BBB'});
    expect(transferred.world.territoriesById[f.ids[2]]).toBe(occupied.world.territoriesById[f.ids[2]]);
    expect(runtime.undo().world.territoriesById[f.ids[1]]).toEqual(occupied.world.territoriesById[f.ids[1]]);
    expect(runtime.redo().world.territoriesById[f.ids[1]]).toEqual(transferred.world.territoriesById[f.ids[1]]);
  });

  it('rejects invalid tail, stale revisions, authority mismatch and tampered plans without any pair/history/delta publication', () => {
    const f = fixture(), runtime = createCatalogRuntime(f.pair, f.catalog), before = runtime.getSnapshot();
    let notices = 0; runtime.subscribeChanges(() => {notices++;}); runtime.store.subscribe(() => {notices++;});
    for (const tail of [f.occupy([readCatalogTerritoryId(`territory:catalog:${'f'.repeat(64)}`)], 'effect.bad'),
      {...f.occupy([f.ids[2]], 'effect.bad'), authorityId: 'tca:missing'},
      {...f.occupy([f.ids[2]], 'effect.bad'), actorCountryId: 'CCC'}]) {
      expect(() => f.plan(before, [f.occupy(), tail])).toThrow();
    }
    const resolution = f.resolution(before, [f.occupy()]);
    expect(() => createCatalogTurnPlan({...before, catalog: f.catalog, turnId: 'turn.stale', ...f.bind(before, {...resolution, baseWorldRevision: 1})})).toThrow('STALE_FRONTIER_REVISION');
    expect(() => createCatalogTurnPlan({...before, catalog: f.catalog, turnId: 'turn.stale-simulation', ...f.bind(before, {...resolution, baseSimulationRevision: 1})})).toThrow('STALE_REVISION');
    expect(() => createCatalogTurnPlan({...before, catalog: {...f.catalog, ref: {...f.catalog.ref, topologyRoot: '0'.repeat(64)}}, turnId: 'turn.catalog', resolution})).toThrow('Catalog ref mismatch');
    const plan = f.plan(before, [f.occupy()]);
    expect(() => runtime.commit({...plan, afterWorldHash: '0'.repeat(64)})).toThrow('content hash mismatch');
    expect(runtime.getSnapshot()).toBe(before); expect(runtime.getHistory().entries).toHaveLength(0);
    expect(runtime.getLastChange()).toBeNull(); expect(notices).toBe(0);
    runtime.commit(plan); const committed = runtime.getSnapshot(), delta = runtime.getLastChange();
    expect(() => runtime.commit(plan)).toThrow('stale');
    expect(runtime.getSnapshot()).toBe(committed); expect(runtime.getLastChange()).toBe(delta);
    expect(runtime.getHistory().entries).toHaveLength(1);
  });

  it('enforces the aggregate 512-cell limit for direct, mixed-region, and batch submissions without truncation', () => {
    const f = fixture(514), runtime = createCatalogRuntime(f.pair, f.catalog), before = runtime.getSnapshot();
    const first = f.occupy(f.ids.slice(1, 257)), second = f.occupy(f.ids.slice(257), 'effect.second');
    expect(() => f.plan(before, [first, second])).toThrow('FRONTIER_AGGREGATE_CAP');
    expect(() => resolveCatalogRegionEffects(parseTurnResolutionV1(f.resolution(before, [first, second])))).toThrow('REGION_REQUEST_CAP');
    const ref = {catalogId: f.catalog.ref.catalogVersion, sourceVersion: f.catalog.ref.geometryRoot, subdivisionId: 'region:BBB:test'};
    const index = createCatalogRegionIndex([{ref, parentCountryId: 'BBB', nameKo: '지역', nameEn: 'Region', aliases: [],
      territoryIds: f.ids.slice(257), provenanceIds: ['source:test']}], f.ids, f.catalog.ref);
    const mixed = f.resolution(before, [first, {...second, territoryIds: [], regionRefs: [{countryId: 'BBB', reference: ref}]}]);
    expect(() => resolveCatalogRegionEffects(parseTurnResolutionV1(mixed), index)).toThrow('REGION_REQUEST_CAP');
    expect(() => createCatalogTurnPlan({...before, catalog: f.catalog, regionIndex: index, turnId: 'turn.cap', ...f.bind(before, mixed)})).toThrow('FRONTIER_REGION_REPLACEMENT');
    const command = (effect: ReturnType<typeof f.occupy>) => ({commandId: effect.effectId, type: effect.type, expectedRevision: 0,
      payload: {actorCountryId: effect.actorCountryId, targetCountryId: effect.targetCountryId, authorityId: effect.authorityId,
        expectedSimulationRevision: 0, territoryIds: effect.territoryIds}});
    expect(() => planTerritorialControlBatch({...before, commands: [command(first), command(second)]})).toThrow('TERRITORIAL_AGGREGATE_CAP');
    expect(runtime.getSnapshot()).toBe(before); expect(runtime.getLastChange()).toBeNull();
    // 512 still succeeds, including when inherited stored authority covers more cells.
    const accepted = runtime.commit(f.plan(before, [first, {...second, territoryIds: f.ids.slice(257, 513)}]));
    expect(runtime.getLastChange()?.stateChange?.cells).toHaveLength(512);
    expect(accepted.world.territoriesById[f.ids[513]].controllerCountryId).toBe('BBB');
  });

  it('derives deltas independently of summary metadata and isolates failed render observers', () => {
    const f = fixture(), runtime = createCatalogRuntime(f.pair, f.catalog), seen: CatalogRuntimeChange[] = [];
    runtime.subscribeChanges(() => {throw Error('Render observer failed');});
    const unsubscribe = runtime.subscribeChanges(change => {seen.push(change);});
    const plan = f.plan(runtime.getSnapshot(), [f.occupy()]);
    runtime.commit({...plan, changeSummary: {...plan.changeSummary, changedTerritoryIds: []}});
    expect(seen[0].stateChange?.cells.map(c => c.id)).toEqual([f.ids[1]]);
    expect(runtime.getSubscriberFailures()).toContain('Error: Render observer failed');
    unsubscribe(); runtime.undo(); expect(seen).toHaveLength(1);
  });
});
