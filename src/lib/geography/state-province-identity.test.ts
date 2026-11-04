// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {createStateProvinceContractFixture} from '../test-only/state-province-contract-fixture';
import {createWorldStateV3} from '../world/world-state-v3';
import {createSimulationStateV2} from '../simulation/simulation-state-v2';
import {createCatalogRuntime, type CatalogRuntimePair} from '../simulation/catalog-runtime';
import {createCatalogTurnPlan} from '../simulation/catalog-turn-plan';
import {selectOperationalFrontier, type OperationalFrontierCatalog} from '../simulation/operational-frontier.server';
import {geographyArtifactBytes, type GeographyReference} from './state-province-io';
import {createGeographySnapshot, readAllGeographyMembers} from './state-province-index.server';
import {sealGeographyMetadata, type GeographyMetadata} from './state-province-contract';
import {validateGeographyMetadata, type GeographyResult} from './state-province-validation';

const value = <T>(result: GeographyResult<T>) => {if (!result.ok) throw Error(JSON.stringify(result.diagnostics)); return result.value;};
const reseal = (metadata: GeographyMetadata) => {const {metadataRef, ...body} = metadata; void metadataRef; return sealGeographyMetadata(body);};
function fixture() {
  const f = createStateProvinceContractFixture(), metadata = value(validateGeographyMetadata(f.metadata, f.context));
  const snapshot = createGeographySnapshot(metadata);
  const countries = ['AAA', 'BBB'].map((id, i) => ({id, names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: []},
    politicalStatus: 'sovereign', presentationOverride: null, moduleVersions: {core: 1}, mapColor: ['#00CC00', '#CC0000'][i]}));
  const world = createWorldStateV3({...f.worldBefore, schemaVersion: 3, seedVersion: 'identity-fixture-v1', policyVersion: 'identity-fixture-v1',
    countriesById: Object.fromEntries(countries.map(c => [c.id, c])), countryOrder: countries.map(c => c.id), retiredCountryIds: new Set(), territoryOrder: f.ids}, f.catalog);
  const ground = {eventId: 'event.ground', date: '2020-01-01', title: '기존 전황', publicNarrative: '두 국가 사이의 검증된 전황',
    actorCountryIds: ['AAA', 'BBB'], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: 'military', significance: 'notable'};
  const authority = {id: 'tca:identity:occupy', actorCountryId: 'BBB', targetCountryId: 'AAA', allowedOperations: ['occupy'],
    allowedTerritoryIds: [f.ids[0]], validFrom: '2020-01-01', validTo: null, sourceEventId: ground.eventId};
  const simulation = createSimulationStateV2({schemaVersion: 2, revision: 0, currentDate: '2020-01-01', turnNumber: 0, playerCountryId: 'BBB',
    queuedActions: [], factsById: {}, factOrder: [], situationsById: {}, situationOrder: [], scheduledConsequences: [], eventLog: [ground],
    history: {lastCommittedTurnId: null, committedTurnCount: 0}, territorialControlAuthoritiesById: {[authority.id]: authority},
    territorialControlAuthorityOrder: [authority.id], countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: []}, world);
  const pair: CatalogRuntimePair = {world, simulation, revisions: {worldRevision: 0, simulationRevision: 0}};
  const cell = (id: string | number) => {const c = f.context.cells.find(c => typeof id === 'number' ? c.ordinal === id : c.id === id); if (!c) throw Error('UNKNOWN_FIXTURE_CELL'); return c;};
  // Independent synthetic land graph: only the first same-name AAA cell borders BBB.
  // The real frontier selector, authority checks, planner and runtime remain in the execution path.
  const graph: OperationalFrontierCatalog = {ref: f.catalog.ref, cell, administrativeParents: f.context.administrativeParents,
    administrativeMembership: key => f.context.cells.filter(c => f.context.administrativeParents[c.administrativeOrdinal - 1].parentKey === key),
    neighbors: n => n === 1 ? [4] : n === 4 ? [1] : [],
    cellMetrics: id => ({areaKm2: 1, diameterKm: 1, centroid: [cell(id).ordinal === 4 ? 0 : cell(id).ordinal * 0.01, 0]}),
    sharedBoundary: (a, b) => {if (!([a, b].includes(1) && [a, b].includes(4))) throw Error('NO_FIXTURE_LAND_BOUNDARY');
      return {edgeOrdinal: 1, start: [0.005, -0.005], end: [0.005, 0.005]};}};
  const scope = {catalogRef: f.catalog.ref, baseWorldRevision: 0, actorCountryId: 'BBB', targetCountryId: 'AAA',
    operation: 'occupy' as const, extent: 'near' as const, direction: null, reference: null, regionQuery: null, cap: 512};
  const selected = selectOperationalFrontier(graph, world, scope);
  const resolution = {contractVersion: 'turn-resolution.v1', baseWorldRevision: 0, baseSimulationRevision: 0,
    period: {startDate: '2020-01-01', endDate: '2020-01-02'}, playerActionOutcomes: [],
    events: [{...ground, eventId: 'event.identity', date: '2020-01-02', causes: [{kind: 'authoritative-event', id: ground.eventId}]}],
    factMutations: [], situationMutations: [], scheduledConsequences: [],
    worldEffects: [{effectId: 'effect.identity', causedByEventId: 'event.identity', type: 'territory.occupy', actorCountryId: 'BBB', targetCountryId: 'AAA',
      authorityId: authority.id, territoryIds: [...selected.cellIds], regionRefs: null, frontierScope: scope}], advisorSummary: '한 셀의 점령을 반영합니다.', unresolvedQuestions: []};
  const plan = (r: unknown = resolution) => createCatalogTurnPlan({...pair, catalog: f.catalog, turnId: 'turn.identity', resolution: r,
    frontier: {world, issuedScopes: [scope], resolve: (w, request) => selectOperationalFrontier(graph, w, request)}});
  const reference = (target: GeographyReference['target']): GeographyReference => ({catalogRef: snapshot.catalogRef, metadataRef: snapshot.metadataRef, target});
  return {f, snapshot, pair, selected, resolution, plan, reference};
}

describe('State and Province identity independent of names and search grouping', () => {
  it('keeps same-name objects, shared parents and every explicit province reachable after canonical candidate grouping', () => {
    const {f, snapshot, reference} = fixture(), [first, second] = snapshot.metadata.provinces;
    expect(first.provinceId).not.toBe(second.provinceId); expect(first.stateId).toBe(second.stateId);
    expect(first.names).toEqual(second.names);
    const request = {sourceCountryId: first.sourceCountryId, query: first.names.displayName, page: {offset: 0, limit: 128}};
    const grouped = value(snapshot.search({...request, kind: null})), explicit = value(snapshot.search({...request, kind: 'province'}));
    // The state and child source have different native identities, despite the shared label.
    // Canonicalization removes their province representations, not this real distinction.
    expect(grouped.totalMatches).toBe(2); expect(grouped.ambiguous).toBe(true);
    expect(grouped.items.map(i => i.reference.target.kind).sort()).toEqual(['source-region', 'state']);
    expect(explicit.items.map(i => i.reference.target.id)).toEqual(f.ids.slice(0, 2));
    expect(value(readAllGeographyMembers(snapshot, grouped.items.find(i => i.reference.target.kind === 'source-region')!.reference)).provinceIds).toEqual(f.ids.slice(0, 2));
    expect(value(snapshot.list({kind: 'province', sourceCountryId: null, page: {offset: 0, limit: 128}})).items.map(i => i.reference.target.id)).toEqual(f.ids);
    for (const id of f.ids) expect(value(snapshot.inspect(reference({kind: 'province', id}))).reference.target.id).toBe(id);
    expect(snapshot.metadata.states[0].names).toEqual(snapshot.metadata.states[1].names);
    expect(snapshot.metadata.states[0].stateId).not.toBe(snapshot.metadata.states[1].stateId);
    for (const p of snapshot.metadata.provinces.filter(p => p.stateId === null)) expect(p.unassignedReason).toBeTruthy();
  });

  it('occupies and undoes/redoes exactly one same-name, same-State province through validated frontier and atomic history', () => {
    const h = fixture(), runtime = createCatalogRuntime(h.pair, h.f.catalog), bytes = geographyArtifactBytes(h.snapshot.metadata);
    expect(h.selected.cellIds).toEqual([h.f.ids[0]]);
    const next = runtime.commit(h.plan());
    expect(next.world.territoriesById[h.f.ids[0]]).toMatchObject({ownerCountryId: 'AAA', controllerCountryId: 'BBB', sourceCountryId: 'AAA'});
    for (const id of h.f.ids.slice(1)) expect(next.world.territoriesById[id]).toBe(h.pair.world.territoriesById[id]);
    expect(runtime.getLastChange()?.stateChange?.cells.map(c => c.id)).toEqual([h.f.ids[0]]);
    expect(h.snapshot.metadata.provinces[0].stateId).toBe(h.f.stateA);
    const undo = runtime.undo(); expect(undo.world.territoriesById[h.f.ids[0]].controllerCountryId).toBe('AAA');
    expect(runtime.getLastChange()?.stateChange?.cells.map(c => c.id)).toEqual([h.f.ids[0]]);
    const redo = runtime.redo(); expect(redo.world.territoriesById[h.f.ids[0]].controllerCountryId).toBe('BBB');
    expect(runtime.getLastChange()?.stateChange?.cells.map(c => c.id)).toEqual([h.f.ids[0]]);
    for (const world of [undo.world, redo.world]) {
      expect(world.territoriesById[h.f.ids[1]]).toBe(h.pair.world.territoriesById[h.f.ids[1]]);
      expect(world.catalogRef).toEqual(h.snapshot.catalogRef);
    }
    expect(geographyArtifactBytes(h.snapshot.metadata)).toEqual(bytes);
    expect(runtime.getHistory().entries).toHaveLength(1); expect(runtime.getHistory().pointer).toBe(1);
    const beforeAlias = runtime.getSnapshot(), history = runtime.getHistory(), changed = structuredClone(h.snapshot.metadata);
    changed.states[0].names.displayName = 'A renamed display'; changed.states[0].names.displayBasis = 'derived';
    changed.provinces[0].names.aliases.push({value: 'Cell alias', language: 'en', basis: 'verified-alias', evidence: changed.provinces[0].evidence});
    const updated = createGeographySnapshot(value(validateGeographyMetadata(reseal(changed), h.f.context)));
    expect(updated.metadataRef).not.toEqual(h.snapshot.metadataRef); expect(updated.catalogRef).toEqual(h.snapshot.catalogRef);
    expect(updated.metadata.states.map(s => s.stateId)).toEqual(h.snapshot.metadata.states.map(s => s.stateId));
    expect(updated.metadata.provinces.map(p => p.provinceId)).toEqual(h.f.ids);
    expect(runtime.getSnapshot()).toBe(beforeAlias); expect(runtime.getHistory()).toEqual(history);
  });

  it('rejects an unauthorized ID, a substituted frontier cell, a stale revision and a raised cap before commit', () => {
    const h = fixture(), runtime = createCatalogRuntime(h.pair, h.f.catalog), before = runtime.getSnapshot(), effect = h.resolution.worldEffects[0];
    const invalidEffects = [
      {...effect, authorityId: 'tca:missing'},
      {...effect, territoryIds: [h.f.ids[1]]},
      {...effect, frontierScope: {...effect.frontierScope, baseWorldRevision: 1}},
      {...effect, frontierScope: {...effect.frontierScope, cap: 513}},
    ];
    for (const invalid of invalidEffects) expect(() => h.plan({...h.resolution, worldEffects: [invalid]})).toThrow();
    expect(runtime.getSnapshot()).toBe(before); expect(runtime.getHistory().entries).toHaveLength(0);
  });

  it.each(['states', 'provinces'] as const)('rejects duplicate %s IDs while permitting duplicated display names', kind => {
    const f = createStateProvinceContractFixture(), changed = structuredClone(f.metadata);
    if (kind === 'states') changed.states.push(structuredClone(changed.states[0]));
    else changed.provinces.push(structuredClone(changed.provinces[0]));
    expect(validateGeographyMetadata(reseal(changed), f.context)).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_MEMBERSHIP'}]});
  });
});
