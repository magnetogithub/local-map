// @vitest-environment node
import {describe, expect, it, vi} from 'vitest';
import {createStateProvinceContractFixture} from '../test-only/state-province-contract-fixture';
import {createCatalogRegionIndex, type RegionRecord} from '../simulation/catalog-region';
import {createRegionPost} from '../simulation/server/region-route-handler';
import {createGeographyLoader} from './state-province-loader.server';
import {attachGeographyRegionIndex, type RegionGeographyLoader} from './state-province-region.server';
import {geographyArtifactBytes, identifyGeographyArtifact, type GeographyLoaderDependencies, type GeographySnapshot} from './state-province-io';
import {sealGeographyMetadata} from './state-province-contract';
import {geographyReadRequestSchema, type GeographyReadRequest} from './state-province-read';
import {executeReadOnlySimulationTool, createSimulationToolManifest} from '../simulation/server/simulation-tools';
import {OpenAIResponsesSimulationProvider} from '../simulation/server/openai-responses-provider';
import type {OpenAIResponsesRequest} from '../simulation/server/openai-responses-transport';
import {parseSimulationContextV1, type SimulationContextV1} from '../simulation/simulation-context';
import {createOperationalGameSession} from '../simulation/server/operational-game-session';
import {createWorldStateV3} from '../world/world-state-v3';
import {createSimulationStateV2} from '../simulation/simulation-state-v2';
import {validateResolutionAgainstContext} from '../simulation/server/context-resolution-validator';
import {createSimulationTurnPost} from '../simulation/server/simulation-turn-handler';

const read = (patch: Partial<GeographyReadRequest> = {}): GeographyReadRequest => ({operation: 'search', sourceCountryId: null,
  kind: 'source-region', query: 'Springfield', reference: null, page: {offset: 0, limit: 1}, ...patch});
const collect = async <T>(events: AsyncIterable<T>) => {const result: T[] = []; for await (const event of events) result.push(event); return result;};
function tool(callId: string, name: string, args: unknown) {
  const item = {type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args)};
  return [{type: 'response.output_item.added', item: {...item, arguments: ''}},
    {type: 'response.function_call_arguments.done', call_id: callId, arguments: item.arguments},
    {type: 'response.output_item.done', item}, {type: 'response.completed', response: {id: `response.${callId}`}}];
}
async function fixture() {
  const f = createStateProvinceContractFixture(); let manifestPin = f.manifestIdentity;
  const dependencies: GeographyLoaderDependencies = {
    locateManifest: vi.fn(async () => ({status: 'available' as const, manifest: manifestPin})),
    readArtifact: async artifact => {const bytes = f.files.get(artifact.path); if (!bytes) throw Error('Missing pinned file'); return bytes;},
    catalogView: async () => f.context,
  };
  const loader = createGeographyLoader({allowFixture: true});
  const load: RegionGeographyLoader = request => loader(request, dependencies);
  const loaded = await load({catalogRef: f.catalog.ref, metadataRef: null});
  if (loaded.status !== 'available') throw Error(JSON.stringify(loaded));
  const snapshot = loaded.snapshot;
  const records: RegionRecord[] = f.metadata.states.map((state, i) => ({
    ref: {catalogId: f.catalog.ref.catalogVersion, sourceVersion: f.catalog.ref.geometryRoot, subdivisionId: `region:fixture:${state.sourceCountryId}:existing`},
    parentCountryId: state.sourceCountryId, nameKo: `Legacy ${i}`, nameEn: `Legacy ${i}`, aliases: [],
    territoryIds: i === 0 ? f.ids.slice(0, 2) : [f.ids[3]], provenanceIds: ['fictional-existing-parent'],
  }));
  const legacy = createCatalogRegionIndex(records, f.ids, f.catalog.ref);
  const links = f.metadata.states.map((s, i) => ({stateId: s.stateId, reference: records[i].ref}));
  const adapt = (snapshot: GeographySnapshot) => attachGeographyRegionIndex(legacy, snapshot, links);
  const index = adapt(snapshot);
  const context: SimulationContextV1 = {
    contextVersion: 'simulation-context.v1', scenario: {id: 'fixture', startDate: '2020-01-01'}, revisions: {simulation: 0, world: 0},
    period: {startDate: '2020-01-01', endDate: '2020-01-02'}, playerCountry: {countryId: 'AAA', name: 'AAA'}, queuedActions: [],
    countries: [{countryId: 'AAA', shortKo: 'AAA', english: 'AAA', politicalStatus: 'sovereign', territoryCount: 3, territoryIds: [f.ids[0]]}],
    countryDirectory: ['AAA', 'BBB'].map(countryId => ({countryId, shortKo: countryId, english: countryId, searchAliases: [], politicalStatus: 'sovereign'})),
    territoryDirectory: [{countryId: 'AAA', territoryIds: [f.ids[0]]}], facts: [], situations: [], dueConsequences: [], recentEvents: [],
    subdivisions: [], regionCatalog: f.catalog.ref, geography: {catalogRef: f.catalog.ref, metadataRef: snapshot.metadataRef},
    rules: {locale: 'ko-KR', capabilities: ['narrative-events']}, metadata: {clipped: []},
  };
  const resolution = {contractVersion: 'turn-resolution.v1', baseSimulationRevision: 0, baseWorldRevision: 0, period: context.period,
    playerActionOutcomes: [], events: [], factMutations: [], situationMutations: [], scheduledConsequences: [], worldEffects: [], advisorSummary: '추가 근거를 확인합니다.', unresolvedQuestions: ['공식 범위가 부분적으로만 확인되었습니다.']};
  const update = async () => {
    const {metadataRef, ...body} = structuredClone(f.metadata); void metadataRef;
    body.sourceRegions[0].names.aliases.push({value: 'New release alias', language: 'en', basis: 'verified-alias', evidence: body.sourceRegions[0].evidence});
    const metadata = sealGeographyMetadata(body), admission = {...f.admission, metadataRef: metadata.metadataRef};
    const metadataBytes = geographyArtifactBytes(metadata), admissionBytes = geographyArtifactBytes(admission);
    const manifest = {...f.manifest, metadataRef: metadata.metadataRef,
      metadata: identifyGeographyArtifact(f.manifest.metadata.path, metadataBytes), admission: identifyGeographyArtifact(f.manifest.admission.path, admissionBytes)};
    const bytes = geographyArtifactBytes(manifest);
    manifestPin = identifyGeographyArtifact(f.manifestIdentity.path, bytes);
    f.files.set(manifest.metadata.path, metadataBytes); f.files.set(manifest.admission.path, admissionBytes); f.files.set(manifestPin.path, bytes);
    const next = await load({catalogRef: f.catalog.ref, metadataRef: null});
    if (next.status !== 'available') throw Error(JSON.stringify(next));
    return {snapshot: next.snapshot, regionIndex: adapt(next.snapshot)};
  };
  const post = createRegionPost({loadGeography: load, loadIndex: (_ref, pinned) => pinned ? adapt(pinned) : index});
  const request = (body: unknown) => new Request('http://localhost/api/world/regions', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const api = (query: GeographyReadRequest, metadataRef = snapshot.metadataRef) => post(request({mode: 'geography', catalogRef: f.catalog.ref, metadataRef, request: query}));
  return {f, snapshot, index, links, legacy, adapt, load, context, resolution, update, post, request, api};
}

describe('20-06 canonical geography API and model consumers', () => {
  it('returns identical canonical names, ambiguity, pagination and evidence through API and AI tools', async () => {
    const h = await fixture(), response = await h.api(read());
    expect(response.status).toBe(200); expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = await response.json();
    expect(body).toEqual(executeReadOnlySimulationTool('read_geography', read(), h.context, h.index, undefined, h.snapshot));
    expect(body.value).toMatchObject({totalMatches: 2, ambiguous: true, truncated: true, limit: 1});
    expect(body.value.items[0].names.displayEvidence).not.toHaveLength(0);
    expect(body.value.items[0].reference.target.kind).toBe('source-region');
    expect(JSON.stringify(h.context)).not.toContain('Old Harbour');
    const omitted = await (await h.api(read({query: ' ＯＬＤ   HARBOUR '}))).json();
    expect(omitted.value.items).toHaveLength(1);
    expect(omitted.value.items[0]).toMatchObject({parentStatus: 'unassigned', stateId: null, coverage: {status: 'partial'}, materialization: {status: 'unsupported'}});
  });

  it('shares canonical unfiltered place search between HTTP and the model tool without hiding real ambiguity', async () => {
    const h = await fixture(), query = read({query: 'Old Harbour', kind: null});
    const body = await (await h.api(query)).json();
    expect(body).toEqual(executeReadOnlySimulationTool('read_geography', query, h.context, h.index, undefined, h.snapshot));
    expect(body.value).toMatchObject({totalMatches: 1, ambiguous: false, truncated: false});
    expect(body.value.items[0]).toMatchObject({reference: {target: {kind: 'source-region'}}, parentStatus: 'unassigned', coverage: {status: 'partial'}});
    const actualAmbiguity = await (await h.api(read({kind: null}))).json();
    expect(actualAmbiguity.value).toMatchObject({totalMatches: 3, ambiguous: true, truncated: true});
  });

  it('keeps complete known membership distinct from incomplete geographic coverage and source ownership', async () => {
    const h = await fixture();
    const reference = {catalogRef: h.snapshot.catalogRef, metadataRef: h.snapshot.metadataRef,
      target: {kind: 'source-region' as const, id: h.f.metadata.sourceRegions[1].sourceRegionId}};
    const result = await (await h.api(read({operation: 'members', kind: null, query: null, reference}))).json();
    expect(result).toMatchObject({ok: true, countryIdSemantics: 'source', value: {items: [h.f.ids[2]], truncated: false, coverage: {status: 'partial', expectedProvinceCount: null}, summary: {materialization: {status: 'unsupported'}}}});
    const provinceRef = {...reference, target: {kind: 'province' as const, id: h.f.ids[0]}};
    const province = await (await h.api(read({operation: 'inspect', kind: null, query: null, reference: provinceRef, sourceCountryId: h.f.metadata.countries[0].sourceCountryId}))).json();
    expect(province.value.sourceCountryId).toBe('AAA'); expect(h.f.worldAfter.territoriesById[h.f.ids[0]].ownerCountryId).toBe('BBB');
    const wrong = await h.api(read({operation: 'inspect', kind: null, query: null, reference: provinceRef, sourceCountryId: h.f.metadata.countries[1].sourceCountryId}));
    expect(wrong.status).toBe(400);
  });

  it('rejects stale versions, malformed/oversized reads and foreign production catalogs without legacy fallback', async () => {
    const h = await fixture();
    expect((await h.api(read(), {...h.snapshot.metadataRef, contentRoot: 'f'.repeat(64)})).status).toBe(409);
    const malformed = {...read()}; delete (malformed as Partial<GeographyReadRequest>).reference;
    expect((await h.post(h.request({mode: 'geography', catalogRef: h.f.catalog.ref, metadataRef: null, request: malformed}))).status).toBe(400);
    expect((await h.api(read({page: {offset: 0, limit: 129}}))).status).toBe(400);
    expect((await h.post(h.request({oversized: 'x'.repeat(4096)}))).status).toBe(413);
    expect((await createRegionPost()(h.request({mode: 'geography', catalogRef: h.f.catalog.ref, metadataRef: null, request: read()}))).status).toBe(409);
    expect(() => executeReadOnlySimulationTool('read_geography', read(), {...h.context, geography: {...h.context.geography!, metadataRef: {...h.snapshot.metadataRef, contentRoot: 'f'.repeat(64)}}}, h.index)).toThrow('STALE_GEOGRAPHY_METADATA');
  });

  it('converts legacy states only with an explicit exact-membership crosswalk and retains metadata in compact responses', async () => {
    const h = await fixture();
    const found = executeReadOnlySimulationTool('find_region', {countryId: 'AAA', query: '스프링필드'}, h.context, h.index);
    expect(found).toMatchObject({ok: true, region: {ref: h.links[0].reference, materializable: false, geography: {parentStatus: 'not-applicable', coverage: {status: 'complete'}}}});
    expect(h.links[0].reference.subdivisionId).not.toBe(h.f.stateA);
    const oldRequest = {catalogRef: h.f.catalog.ref, countryId: 'BBB', operation: 'occupy', metadataRef: h.snapshot.metadataRef,
      reference: h.links[1].reference};
    expect((await h.post(h.request(oldRequest))).status).toBe(400);
    const membership = await (await h.post(h.request({...oldRequest, mode: 'membership'}))).json();
    expect(membership.region).toMatchObject({territoryIds: [h.f.ids[3]], geography: {coverage: {status: 'partial'}}});
    expect(() => attachGeographyRegionIndex(h.legacy, h.snapshot, h.links.slice(0, 1))).toThrow('GEOGRAPHY_STATE_CROSSWALK');
    expect(() => attachGeographyRegionIndex(h.legacy, h.snapshot, [{stateId: h.f.stateA, reference: h.links[1].reference}, h.links[1]])).toThrow();
    expect(validateResolutionAgainstContext(h.resolution, h.context, {regionIndex: h.index, geographySnapshot: h.snapshot}).ok).toBe(true);
    expect(validateResolutionAgainstContext(h.resolution, {...h.context, geography: {...h.context.geography!, metadataRef: {...h.snapshot.metadataRef, contentRoot: 'f'.repeat(64)}}}, {regionIndex: h.index}).ok).toBe(false);
  });

  it('keeps the function manifest strict and nullable fields required, including current-frontier arguments', async () => {
    const manifest = createSimulationToolManifest({operational: true, geography: true});
    const visit = (schema: unknown) => {
      if (!schema || typeof schema !== 'object') return;
      const node = schema as Record<string, unknown>;
      if (node.type === 'object') {expect(node.additionalProperties).toBe(false); expect(node.required).toEqual(Object.keys(node.properties as object));}
      for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
    };
    const geographyTool = manifest.find(tool => tool.name === 'read_geography')!;
    visit(geographyTool.parameters);
    for (const field of ['sourceCountryId', 'kind', 'query', 'reference']) {
      const raw: Record<string, unknown> = {...read()}; delete raw[field];
      expect(geographyReadRequestSchema.safeParse(raw).success).toBe(false);
    }
    const h = await fixture();
    expect(() => executeReadOnlySimulationTool('find_frontier_territories', {actorCountryId: 'AAA', targetCountryId: 'BBB', operation: 'occupy', extent: 'near', cap: 512}, h.context)).toThrow();
    expect(parseSimulationContextV1(h.context).geography).toEqual(h.context.geography);
  });

  it('uses one pinned snapshot across a scripted provider turn while the selected release changes', async () => {
    const h = await fixture(), requests: OpenAIResponsesRequest[] = [];
    const load = vi.fn(h.load);
    const provider = new OpenAIResponsesSimulationProvider({apiKey: 'fixture', model: 'fixture', timeoutMs: 5000, maxRetries: 0, maxToolIterations: 4, maxToolCalls: 8, debugMode: false}, {
      async *stream(request) {
        requests.push(request); const n = requests.length;
        if (n === 1) {
          expect(JSON.stringify(request.input)).not.toContain('Old Harbour');
          expect(request.tools.some(t => (t as {name: string}).name === 'read_geography')).toBe(true);
          await h.update();
          yield* tool('geo.1', 'read_geography', read());
        } else if (n === 2) yield* tool('geo.2', 'read_geography', read({query: 'Old Harbour'}));
        else if (n === 3) yield* tool('geo.3', 'read_geography', read({query: 'New release alias'}));
        else yield* tool('geo.submit', 'submit_turn_resolution', h.resolution);
      },
    }, {loadGeography: load, loadRegionIndex: () => h.index});
    const post = createSimulationTurnPost({createProvider: () => provider});
    const response = await post(new Request('http://localhost/api/simulation/turn', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({turnId: 'turn.fixture', context: h.context})}));
    expect(response.status).toBe(200);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    expect(events.some(e => e.type === 'resolution.ready'), JSON.stringify(events)).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    const outputs = requests.at(-1)!.input.filter(item => (item as {type?: string}).type === 'function_call_output') as {output: string}[];
    const data = outputs.map(output => JSON.parse(output.output).data.value);
    expect(data[0]).toMatchObject({ambiguous: true, truncated: true, totalMatches: 2, metadataRef: h.snapshot.metadataRef});
    expect(data[1].items[0]).toMatchObject({parentStatus: 'unassigned', coverage: {status: 'partial'}, materialization: {status: 'unsupported'}});
    expect(data[2].totalMatches).toBe(0);
    expect(h.f.worldBefore.revision).toBe(0);
  });

  it('pins prepared context, host objects and cache identity across release changes without world mutations', async () => {
    const h = await fixture(); let active = {snapshot: h.snapshot, regionIndex: h.index};
    const countries = ['AAA', 'BBB'].map((id, i) => ({id, names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: []},
      politicalStatus: 'sovereign', presentationOverride: null, moduleVersions: {core: 1}, mapColor: ['#00CC00', '#CC0000'][i]}));
    const world = createWorldStateV3({...h.f.worldBefore, schemaVersion: 3, seedVersion: 'fixture-v1', policyVersion: 'fixture-v1',
      countriesById: Object.fromEntries(countries.map(c => [c.id, c])), countryOrder: ['AAA', 'BBB'], retiredCountryIds: new Set(), territoryOrder: h.f.ids}, h.f.catalog);
    const simulation = createSimulationStateV2({schemaVersion: 2, revision: 0, currentDate: '2020-01-01', turnNumber: 0, playerCountryId: 'AAA',
      queuedActions: [], factsById: {}, factOrder: [], situationsById: {}, situationOrder: [], scheduledConsequences: [], eventLog: [],
      history: {lastCommittedTurnId: null, committedTurnCount: 0}, territorialControlAuthoritiesById: {}, territorialControlAuthorityOrder: [],
      countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: []}, world);
    const session = createOperationalGameSession({seed: {world, simulation, revisions: {worldRevision: 0, simulationRevision: 0}}, catalog: h.f.catalog,
      regionIndex: h.index, frontier: () => {throw Error('No frontier in read-only fixture');}, actionId: () => 'action.fixture', prepareGeography: () => active});
    const command = {operation: 'prepare-turn' as const, sessionId: 'fictional', revisions: session.runtime.getSnapshot().revisions, targetDate: '2020-01-02'};
    const first = session.command(command);
    if (!('context' in first) || !first.context || !first.turnId) throw Error('Missing prepared context');
    active = await h.update();
    session.setPreparationGeography(active);
    expect(session.resolveRequest({turnId: first.turnId, context: first.context})).toBe(world);
    const captured: GeographySnapshot[] = [];
    await collect(session.provider({async *streamTurn(request) {
      captured.push(request.geographySnapshot!);
      expect(request.preparedRegionIndex?.geography?.snapshot).toBe(h.snapshot);
      yield {type: 'turn.failed', code: 'INVALID_RESOLUTION', message: 'Read-only test complete', retryable: false};
    }}).streamTurn({turnId: first.turnId, context: first.context}, new AbortController().signal));
    expect(captured).toEqual([h.snapshot]);
    const next = session.command(command);
    if (!('context' in next) || !next.context || !next.turnId) throw Error('Missing prepared context');
    expect(next.context.geography?.metadataRef).toEqual(active.snapshot.metadataRef);
    expect(next.context.geography?.metadataRef).not.toEqual(first.context.geography?.metadataRef);
    expect(() => session.resolveRequest({turnId: first.turnId!, context: first.context!})).toThrow('STALE_STATE');
    expect(session.runtime.getSnapshot().world).toBe(world); expect(session.runtime.getHistory().entries).toHaveLength(0);
  });
});
