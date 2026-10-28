// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {createOperationalStateMigration, migrateOperationalRegionReference, PREVIOUS_OPERATIONAL_CATALOG_VERSION} from './operational-state-migration';
import {OPERATIONAL_CATALOG_VERSION, type OperationalCell} from './operational-catalog';
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from './world-geometry-catalog-ref';
import {createWorldStateV3} from './world-state-v3';
import {createSimulationStateV2, territorialControlAuthoritySchema} from '../simulation/simulation-state-v2';
import {createCatalogRuntime, type CatalogRuntimePair} from '../simulation/catalog-runtime';
import {createCatalogTurnPlan} from '../simulation/catalog-turn-plan';
import {createCatalogRegionIndex} from '../simulation/catalog-region';
import type {CountryId} from './country-id';

const id = (value: number) => readCatalogTerritoryId(`territory:catalog:${value.toString(16).padStart(64, '0')}`);
function fixture() {
  const sourceIds = [id(1), id(2), id(3)], ids = Array.from({length: 516}, (_, i) => id(i + 100));
  const contract = (version: string, order: typeof ids, country: (i: number) => string) => createWorldGeometryCatalogContract({
    ref: {catalogVersion: version, geometryRoot: '1'.repeat(64), topologyRoot: '2'.repeat(64), renderArtifactRoot: '3'.repeat(64),
      manifestPath: `/data/territory-catalog/${version}/manifest.json`}, territoryOrder: order,
    territoriesById: Object.fromEntries(order.map((id, i) => [id, {id, sourceCountryId: country(i)}])),
  });
  const source = contract(PREVIOUS_OPERATIONAL_CATALOG_VERSION, sourceIds, () => 'BBB');
  const catalog = contract(OPERATIONAL_CATALOG_VERSION, ids, () => 'BBB');
  const parents = sourceIds.map((oldTerritoryId, i) => ({ordinal: i + 1, oldTerritoryId, sourceCountryId: 'BBB',
    start: i === 0 ? 0 : i === 1 ? 513 : 515, count: i === 0 ? 513 : i === 1 ? 2 : 1}));
  const cells: OperationalCell[] = ids.map((id, i) => ({id, ordinal: i + 1, sourceCountryId: 'BBB' as CountryId,
    administrativeOrdinal: 1, previousParentOrdinal: i < 513 ? 1 : i < 515 ? 2 : 3}));
  const mapping = {ref: catalog.ref, worldContract: () => catalog, previousParents: parents,
    previousMembership: (oldId: string) => {const p = parents.find(p => p.oldTerritoryId === oldId)!; return cells.slice(p.start, p.start + p.count);}};
  const countries = ['AAA', 'BBB'].map((id, i) => ({id, names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: [id]},
    politicalStatus: 'sovereign', presentationOverride: null, moduleVersions: {core: 1}, mapColor: i ? '#CC0000' : '#00CC00'}));
  const world = createWorldStateV3({schemaVersion: 3, seedVersion: 'seed-v1', policyVersion: 'policy-v1', revision: 0,
    countriesById: Object.fromEntries(countries.map(c => [c.id, c])), countryOrder: ['AAA', 'BBB'], retiredCountryIds: new Set(),
    territoriesById: Object.fromEntries(sourceIds.map((id, i) => [id, {id, sourceCountryId: 'BBB',
      ownerCountryId: i === 1 ? null : i === 0 ? 'AAA' : 'BBB', controllerCountryId: i === 0 ? 'BBB' : 'AAA'}])),
    territoryOrder: sourceIds, catalogRef: source.ref}, source);
  const simulation = createSimulationStateV2({schemaVersion: 2, revision: 0, currentDate: '2020-01-01', turnNumber: 0,
    playerCountryId: 'AAA', queuedActions: [], factsById: {}, factOrder: [], situationsById: {}, situationOrder: [],
    scheduledConsequences: [], eventLog: [], history: {lastCommittedTurnId: null, committedTurnCount: 0},
    territorialControlAuthoritiesById: {}, territorialControlAuthorityOrder: [],
    countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: []}, world);
  const pair: CatalogRuntimePair = Object.freeze({world, simulation, revisions: Object.freeze({worldRevision: 0, simulationRevision: 0})});
  return {source, catalog, mapping, cells, parents, sourceIds, ids, pair, migration: createOperationalStateMigration(source, mapping)};
}
const plan = (pair: CatalogRuntimePair, catalog: ReturnType<typeof fixture>['catalog'], turnId: string, date: string) => createCatalogTurnPlan({
  ...pair, catalog, turnId, resolution: {contractVersion: 'turn-resolution.v1', baseSimulationRevision: pair.simulation.revision,
    baseWorldRevision: pair.world.revision, period: {startDate: pair.simulation.currentDate, endDate: date}, playerActionOutcomes: [],
    events: [], factMutations: [], situationMutations: [], scheduledConsequences: [], worldEffects: [], advisorSummary: '상황을 유지합니다.', unresolvedQuestions: []},
});

describe('16-02 operational state initialization and atomic catalog transition', () => {
  it('initializes every real cell with previous owner/controller, including occupation and unowned control', () => {
    const f = fixture(), next = f.migration.migrate(f.pair, 'initial');
    expect(next.revisions).toEqual({worldRevision: 0, simulationRevision: 0});
    expect(next.world.territoryOrder).toEqual(f.ids);
    for (const cell of f.cells) {
      const parent = f.pair.world.territoriesById[f.sourceIds[cell.previousParentOrdinal - 1]], current = next.world.territoriesById[cell.id];
      expect([current.ownerCountryId, current.controllerCountryId]).toEqual([parent.ownerCountryId, parent.controllerCountryId]);
      expect(current.sourceCountryId).toBe('BBB');
    }
    expect(next.world.countriesById).toEqual(f.pair.world.countriesById);
    expect(next.world.catalogRef).toEqual(f.catalog.ref);
    expect(f.pair.world.territoryOrder).toHaveLength(3);
  });

  it('expands full authority scope beyond 512 while preserving pending actions, dates, narrative and grant/action limits', () => {
    const f = fixture(), event = {eventId: 'event.scope', date: '2020-01-01', title: '기존 권한', publicNarrative: '기존 영토 권한을 유지합니다.',
      actorCountryIds: ['AAA'], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: 'territorial', significance: 'notable'};
    const simulation = createSimulationStateV2({...f.pair.simulation, eventLog: [event],
      queuedActions: [{actionId: 'action.pending', actorCountryId: 'AAA', submittedAtDate: '2020-01-01', text: '접경으로 진격', visibility: 'public', status: 'queued'}],
      factsById: {'fact.scope': {factId: 'fact.scope', kind: 'territorial-claim', actorCountryIds: ['AAA'], publicSummary: '기존 기록', startDate: '2020-01-01', status: 'active', sourceEventId: event.eventId}}, factOrder: ['fact.scope'],
      territorialControlAuthoritiesById: {'tca:scope': {id: 'tca:scope', actorCountryId: 'AAA', targetCountryId: 'BBB', allowedOperations: ['occupy'],
        allowedTerritoryIds: [f.sourceIds[0]], validFrom: '2020-01-01', validTo: null, sourceEventId: event.eventId}}, territorialControlAuthorityOrder: ['tca:scope']}, f.pair.world);
    const pair = {...f.pair, simulation}, next = f.migration.migrate(pair), authority = next.simulation.territorialControlAuthoritiesById['tca:scope'];
    expect(authority.allowedTerritoryIds).toEqual(f.ids.slice(0, 513));
    expect(() => territorialControlAuthoritySchema.parse(authority)).toThrow();
    for (const field of ['currentDate', 'turnNumber', 'queuedActions', 'eventLog', 'history', 'factsById'] as const) expect(next.simulation[field]).toEqual(simulation[field]);
    expect(f.migration.territoryIds([f.sourceIds[0], f.sourceIds[0]])).toEqual(authority.allowedTerritoryIds);
    expect(() => f.migration.territoryIds(['unknown'])).toThrow('UNRESOLVED_PREVIOUS_TERRITORY');
    expect(() => f.migration.migrate({...pair, revisions: {...pair.revisions, worldRevision: 1}})).toThrow('STALE_CATALOG_REVISION_PAIR');
    expect(() => f.migration.migrate({...pair, simulation: {...simulation, queuedActions: [{...simulation.queuedActions[0], territoryIds: ['unknown']}]}} as unknown as typeof pair)).toThrow();
  });

  it('retains original history snapshots and restores the matching catalog on undo/redo across conversion', () => {
    const f = fixture(), runtime = createCatalogRuntime(f.pair, f.source);
    runtime.commit(plan(runtime.getSnapshot(), f.source, 'turn.before', '2020-01-02'));
    const before = runtime.getSnapshot(), history = runtime.getHistory();
    let notifications = 0; runtime.store.subscribe(() => {notifications++;});
    const next = f.migration.migrate(before), initialSeed = f.migration.migrate(f.pair, 'initial');
    runtime.transitionCatalog({expected: before, next, catalog: f.catalog, initialSeed});
    expect(notifications).toBe(1);
    expect(runtime.getHistory().entries).toBe(history.entries);
    expect(runtime.getHistory().pointer).toBe(history.pointer);
    expect(runtime.getHistory().entries[0].afterWorld).toBe(before.world);
    runtime.commit(plan(runtime.getSnapshot(), f.catalog, 'turn.after', '2020-01-03'));
    expect(runtime.undo().world.catalogRef).toEqual(f.catalog.ref);
    const old = runtime.undo(); expect(old.world.catalogRef).toEqual(f.source.ref);
    expect(runtime.getCatalogForSnapshot(old.world)).toBe(f.source);
    expect(runtime.redo().world.catalogRef).toEqual(f.source.ref);
    expect(runtime.redo().world.catalogRef).toEqual(f.catalog.ref);
    expect(runtime.restart().world).toBe(initialSeed.world);
  });

  it('rejects stale or invalid conversion without partial publication or history loss', () => {
    const f = fixture(), runtime = createCatalogRuntime(f.pair, f.source), before = runtime.getSnapshot();
    const next = f.migration.migrate(before), initialSeed = f.migration.migrate(f.pair, 'initial');
    let notifications = 0; runtime.store.subscribe(() => {notifications++;});
    expect(() => runtime.transitionCatalog({expected: before, next: {...next, simulation: {...next.simulation, playerCountryId: 'XXX' as never}}, catalog: f.catalog, initialSeed})).toThrow();
    expect(runtime.getSnapshot()).toBe(before); expect(notifications).toBe(0);
    expect(() => runtime.getCatalogForSnapshot(next.world)).toThrow('UNKNOWN_SNAPSHOT_CATALOG');
    const invalidWorld = createWorldStateV3({...next.world, revision: 3}, f.catalog);
    expect(() => runtime.transitionCatalog({expected: before, next: {...next, world: invalidWorld,
      revisions: {...next.revisions, worldRevision: 3}}, catalog: f.catalog, initialSeed})).toThrow('INVALID_CATALOG_TRANSITION_REVISIONS');
    expect(runtime.getSnapshot()).toBe(before); expect(notifications).toBe(0);
    expect(runtime.getInitialSnapshot()).toBe(f.pair);
    expect(() => runtime.getCatalogForSnapshot(next.world)).toThrow('UNKNOWN_SNAPSHOT_CATALOG');
    runtime.replacePendingActions([]);
    const current = runtime.getSnapshot();
    expect(() => runtime.transitionCatalog({expected: before, next, catalog: f.catalog, initialSeed})).toThrow('STALE_CATALOG_TRANSITION');
    expect(runtime.getSnapshot()).toBe(current); expect(runtime.canUndo()).toBe(false);
    const missing = {...f.mapping, previousParents: f.parents.slice(1)};
    expect(() => createOperationalStateMigration(f.source, missing)).toThrow('OPERATIONAL_PREVIOUS_COVERAGE');
    const overlap = {...f.mapping, previousMembership: () => [f.cells[0]]};
    expect(() => createOperationalStateMigration(f.source, overlap)).toThrow();
    expect(() => f.migration.migrate({...f.pair, world: {...f.pair.world, catalogRef: {...f.source.ref, topologyRoot: '0'.repeat(64)}}})).toThrow('Catalog ref mismatch');
  });

  it('rebinds administrative identity to complete new membership and fails unknown references', () => {
    const f = fixture(), reference = (catalogId: string) => ({catalogId, sourceVersion: '1'.repeat(64), subdivisionId: 'region:ne-admin1:BBB:123'});
    const record = {ref: reference(f.source.ref.catalogVersion), parentCountryId: 'BBB', nameKo: '지역', nameEn: 'Region', aliases: [], territoryIds: [f.sourceIds[0]], provenanceIds: ['source:123']};
    const source = createCatalogRegionIndex([record], f.sourceIds, f.source.ref);
    const target = createCatalogRegionIndex([{...record, ref: reference(f.catalog.ref.catalogVersion), territoryIds: f.ids}], f.ids, f.catalog.ref);
    expect(migrateOperationalRegionReference('BBB', record.ref, source, target).territoryIds).toHaveLength(516);
    expect(() => target.resolve('BBB', reference(f.catalog.ref.catalogVersion), 'occupy')).toThrow('REGION_REQUEST_CAP');
    expect(() => migrateOperationalRegionReference('AAA', record.ref, source, target)).toThrow('REGION_COUNTRY_SCOPE');
    expect(() => migrateOperationalRegionReference('BBB', {...record.ref, sourceVersion: '0'.repeat(64)}, source, target)).toThrow('UNKNOWN_REGION_OR_CATALOG');
  });
});
