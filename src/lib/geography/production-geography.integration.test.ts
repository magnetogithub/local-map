// @vitest-environment node
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {beforeAll, describe, expect, it} from 'vitest';
import registry from '../../../data/runtime/geography/current.json';
import {createProductionGeographyLoader, loadProductionGeography, PRODUCTION_GEOGRAPHY_POINTER} from './production-geography.server';
import {loadOperationalCatalog, prepareOperationalCatalog} from '../world/operational-catalog.server';
import {createProductionOperationalGame} from '../world/operational-game.server';
import {transitionWorldStateV3} from '../world/world-state-v3';
import {loadCatalogRegionIndex} from '../simulation/catalog-region.server';
import {createOperationalGameSession} from '../simulation/server/operational-game-session';
import {executeReadOnlySimulationTool} from '../simulation/server/simulation-tools';
import {OpenAIResponsesSimulationProvider} from '../simulation/server/openai-responses-provider';
import type {OpenAIResponsesRequest} from '../simulation/server/openai-responses-transport';
import {createRegionPost} from '../simulation/server/region-route-handler';
import {geographyCountryIdSchema, geographyMetadataRefSchema, provinceIdSchema, sealGeographyMetadata, stateIdSchema} from './state-province-contract';
import {readAllGeographyMembers} from './state-province-index.server';
import {executeGeographyRead, type GeographyReadRequest} from './state-province-read';
import {validateCountryMetadataInput} from './country-metadata-input';
import type {GeographyAdmissionContext, GeographyResult} from './state-province-validation';
import type {GeographyAdmissionEvidence, GeographySnapshot, GeographySummary} from './state-province-io';
import {readCurrentGeographyInput} from '../../../scripts/geography/current-input';
import {verifyProducerMetadata} from '../../../scripts/geography/verify-metadata';
import {deriveCurrentGeographyExpectations, observedGeographyCountryPartition} from '../test-only/current-geography-expectations';

const value = <T>(result: GeographyResult<T>): T => {
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  return result.value;
};
const countryId = (id: string) => geographyCountryIdSchema.parse(id);
const selectedRef = geographyMetadataRefSchema.parse(registry.metadataRef);
const read = (patch: Partial<GeographyReadRequest> = {}): GeographyReadRequest => ({operation: 'search', sourceCountryId: null,
  kind: 'source-region', query: '청진', reference: null, page: {offset: 0, limit: 128}, ...patch});
const request = (body: unknown) => new Request('http://localhost/api/world/regions', {method: 'POST', body: JSON.stringify(body)});
const tool = (name: string, args: unknown, callId: string) => {
  const item = {type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args)};
  return [{type: 'response.output_item.added', item: {...item, arguments: ''}},
    {type: 'response.function_call_arguments.done', call_id: callId, arguments: item.arguments},
    {type: 'response.output_item.done', item}, {type: 'response.completed', response: {id: `response.${callId}`}}];
};

describe('20-08 production metadata, consumer and country handoff integration', () => {
  let snapshot: GeographySnapshot, context: GeographyAdmissionContext, expected: ReturnType<typeof deriveCurrentGeographyExpectations>;
  const paths: string[] = [], catalog = loadOperationalCatalog();
  beforeAll(async () => {
    const selected = prepareOperationalCatalog(process.cwd(), file => {
      paths.push(path.relative(process.cwd(), file).replaceAll('\\', '/'));
      // Catalog construction is synchronous; this records only metadata-only catalog reads.
      return readFileSync(file);
    });
    const loader = createProductionGeographyLoader({catalog: () => selected, readFile: async file => {
      paths.push(path.relative(process.cwd(), file).replaceAll('\\', '/'));
      return fs.readFile(file);
    }});
    const loaded = await loader({catalogRef: catalog.ref, metadataRef: selectedRef});
    if (loaded.status !== 'available') throw Error(JSON.stringify(loaded));
    snapshot = loaded.snapshot;
    const again = await loader({catalogRef: catalog.ref, metadataRef: null});
    expect(again.status === 'available' && again.snapshot === snapshot).toBe(true);
    const manifest = JSON.parse(await fs.readFile(registry.manifest.path, 'utf8'));
    const admission: GeographyAdmissionEvidence = JSON.parse(gunzipSync(await fs.readFile(manifest.admission.path)).toString('utf8'));
    context = {catalog: selected.worldContract(), countryIds: selected.descriptor.countryOrder,
      cells: selected.descriptor.countryOrder.flatMap(id => [...selected.loadCountry(id)]), administrativeParents: selected.administrativeParents,
      parentSources: admission.parentSources, sourceMemberships: admission.sourceMemberships, coverageWitnesses: admission.coverageWitnesses};
    // The oracle is offline and separate from the production loader reads recorded above.
    const independent = readCurrentGeographyInput();
    verifyProducerMetadata(snapshot.metadata, admission, independent);
    expected = deriveCurrentGeographyExpectations(independent);
    independent.assertUnchanged();
  }, 120_000);

  it('matches every post-merge catalog ID and reads pinned metadata without source polygons', () => {
    const {metadata} = snapshot;
    expect(metadata.provinces).toHaveLength(expected.cells.length); expect(metadata.states).toHaveLength(expected.states.length);
    expect(metadata.sourceRegions).toHaveLength(expected.groups.size);
    expect(metadata.countries.map(c => c.sourceCountryId).sort()).toEqual([...expected.countries].sort());
    expect(metadata.provinces.map(p => p.provinceId).sort()).toEqual([...catalog.worldContract().territoryOrder].sort());
    const observed = observedGeographyCountryPartition(metadata.provinces);
    expect(observed.fineCountries).toEqual(expected.fineCountries);
    expect(observed.coarseCountries).toEqual(expected.coarseCountries);
    const sourceIdentity = (s: typeof metadata.states[number]['source']) => ({sourceId: s.sourceId, sourceFeatureId: s.sourceFeatureId, sourceVersion: s.sourceVersion, artifact: s.artifact});
    expect(metadata.states.map(s => ({stateId: s.stateId, sourceCountryId: s.sourceCountryId, source: sourceIdentity(s.source)})).sort((a, b) => a.stateId.localeCompare(b.stateId)))
      .toEqual([...expected.states].sort((a, b) => a.stateId.localeCompare(b.stateId)));
    for (const group of metadata.sourceRegions) {
      const native = expected.groups.get(group.sourceRegionId)!;
      expect(native).toBeDefined(); expect(group.sourceCountryId).toBe(native.sourceCountryId);
      expect(sourceIdentity(group.source)).toEqual(native.source);
      expect([...group.provinceIds].sort()).toEqual([...native.provinceIds].sort());
    }
    const order = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));
    expect(metadata.provinces.map(p => [p.provinceId, p.sourceCountryId, p.stateId, p.precision]).sort(order))
      .toEqual(expected.cells.map(p => [p.provinceId, p.sourceCountryId, p.stateId, p.precision]).sort(order));
    expect([...metadata.states, ...metadata.sourceRegions].every(r => r.coverage.status !== 'complete')).toBe(true);
    expect(metadata.catalogRef).toEqual(registry.catalogRef); expect(snapshot.metadataRef).toEqual(registry.metadataRef);
    expect(paths.some(p => /\.geojson|data\/raw\/|detail\/countries|detail\/topology/.test(p))).toBe(false);
    expect(paths.filter(p => p.endsWith('/metadata.json.gz'))).toHaveLength(1);
    expect(paths).toContain(registry.manifest.path);
  });

  it('lists and explicitly inspects every province ID independently of canonical name candidate grouping', () => {
    const listed: string[] = [];
    for (let offset = 0; offset < expected.cells.length; offset += 128) {
      const page = value(snapshot.list({kind: 'province', sourceCountryId: null, page: {offset, limit: 128}}));
      expect(page.totalMatches).toBe(expected.cells.length);
      listed.push(...page.items.map(item => item.reference.target.id));
    }
    expect(listed).toEqual(expected.cells.map(p => p.provinceId).sort());
    for (const id of listed) {
      const reference = {catalogRef: snapshot.catalogRef, metadataRef: snapshot.metadataRef,
        target: {kind: 'province' as const, id: provinceIdSchema.parse(id)}};
      expect(value(snapshot.inspect(reference)).reference.target.id).toBe(id);
    }
  });

  const search = (query: string, country: string | null = null, kind: 'source-region' | 'state' = 'source-region') =>
    value(snapshot.search({query, sourceCountryId: country === null ? null : countryId(country), kind, page: {offset: 0, limit: 128}}));

  it('resolves supported Korean and English aliases to the same real identity with normalized names', () => {
    const city = search('청진', 'PRK');
    expect(city.totalMatches).toBe(1); expect(city.ambiguous).toBe(false);
    for (const name of ['청진시', 'Chongjin City', '  ＣＨＯＮＧＪＩＮ   ｃｉｔｙ  ', 'chongjin'])
      expect(search(name, 'PRK').items.map(i => i.reference.target)).toEqual(city.items.map(i => i.reference.target));
    expect(value(readAllGeographyMembers(snapshot, city.items[0].reference)).provinceIds).toEqual([...expected.groups.get(city.items[0].reference.target.id)!.provinceIds].sort());
    const inner = search('내몽골', 'CHN', 'state');
    expect(inner.items[0].reference.target.id).toBe('fine-macro:CHN:macro:CHN:CN-15');
    for (const name of ['Inner Mongolia', 'Inner Mongol', '내몽골 자치구', '  INNER   MONGOLIA  '])
      expect(search(name, 'CHN', 'state').items.map(i => i.reference.target)).toEqual(inner.items.map(i => i.reference.target));
    const members = value(readAllGeographyMembers(snapshot, inner.items[0].reference));
    expect(members.provinceIds).toEqual(expected.cells.filter(p => p.stateId === inner.items[0].reference.target.id).map(p => p.provinceId).sort());
    expect(members.coverage).toMatchObject({status: 'partial', expectedProvinceCount: null});
    expect(inner.items[0].materialization.status).toBe('unsupported');
    expect(search('북한 북부').totalMatches).toBe(0); expect(search('휴전선 인근').totalMatches).toBe(0);
  });

  it('returns one canonical unfiltered candidate for Chongjin and Taean while preserving actual Jung-gu ambiguity', () => {
    const unfiltered = (query: string, country: string, kind: 'province' | null = null, limit = 128) =>
      value(snapshot.search({query, sourceCountryId: countryId(country), kind, page: {offset: 0, limit}}));
    for (const [name, country] of [['청진', 'PRK'], ['태안군', 'KOR']] as const) {
      const result = unfiltered(name, country);
      const count = expected.groups.get(search(name, country).items[0].reference.target.id)!.provinceIds.length;
      expect(result).toMatchObject({totalMatches: 1, ambiguous: false, truncated: false});
      expect(result.items[0]).toMatchObject({reference: {target: {kind: 'source-region'}}, knownProvinceCount: count, coverage: {status: 'partial'}});
      expect(result.items[0].reference).toEqual(search(name, country).items[0].reference);
      expect(unfiltered(name, country, 'province').totalMatches).toBe(count);
    }
    expect(unfiltered('중구', 'KOR', null, 1)).toMatchObject({totalMatches: 6, ambiguous: true, truncated: true});
    expect(unfiltered('내몽골', 'CHN').items[0].reference).toEqual(search('내몽골', 'CHN', 'state').items[0].reference);
  });

  it('distinguishes real same-name candidates, multiple cells per source, limits and incomplete coverage', () => {
    const duplicate = search('중구', 'KOR');
    expect(duplicate).toMatchObject({totalMatches: 6, ambiguous: true, truncated: false});
    expect(new Set(duplicate.items.map(i => i.reference.target.id)).size).toBe(6);
    const tae = search('태안군', 'KOR');
    expect(tae.totalMatches).toBe(1); expect(search('Taean-gun', 'KOR').items[0].reference).toEqual(tae.items[0].reference);
    const memberPage = value(snapshot.members(tae.items[0].reference, {offset: 0, limit: 1}));
    expect(memberPage).toMatchObject({totalMatches: 3, ambiguous: false, truncated: true, coverage: {status: 'partial', expectedProvinceCount: null}});
    expect(value(readAllGeographyMembers(snapshot, tae.items[0].reference)).provinceIds).toHaveLength(3);
    const page = value(snapshot.list({kind: 'province', sourceCountryId: countryId('CHN'), page: {offset: 0, limit: 1}}));
    expect(page).toMatchObject({totalMatches: expected.cells.filter(p => p.sourceCountryId === 'CHN').length, ambiguous: false, truncated: true});
    expect(snapshot.metadata.provinces.filter(p => p.names.displayBasis === 'derived').map(p => p.provinceId).sort()).toEqual(expected.cells.filter(p => p.derivedDisplay).map(p => p.provinceId).sort());
    expect(snapshot.metadata.provinces.filter(p => p.sources.length === 0).map(p => p.provinceId).sort()).toEqual(expected.cells.filter(p => p.source === null).map(p => p.provinceId).sort());
    expect(snapshot.metadata.provinces.filter(p => p.stateId === null).map(p => p.provinceId).sort()).toEqual(expected.cells.filter(p => p.stateId === null).map(p => p.provinceId).sort());
    for (const p of snapshot.metadata.provinces.filter(p => p.sources.length === 0)) {
      expect(p.names.sourceName).toBeNull(); expect(p.names.displayBasis).toBe('derived');
      expect(p.stateId).toBeNull(); expect(p.parentStatus).toBe('unassigned');
    }
    expect(new Set(snapshot.metadata.provinces.map(p => p.precision))).toEqual(new Set(expected.cells.map(p => p.precision)));
  });

  it('rejects missing targets, wrong countries, stale full catalog/metadata and invalid registries', async () => {
    const city = search('청진', 'PRK').items[0], reference = city.reference;
    for (const target of [{kind: 'state' as const, id: stateIdSchema.parse('fine-macro:PRK:missing')},
      {kind: 'province' as const, id: snapshot.metadata.provinces[0].provinceId.replace(/.$/, 'f')}]) {
      expect(snapshot.inspect({...reference, target} as typeof reference).ok).toBe(false);
    }
    expect(executeGeographyRead(snapshot, read({operation: 'inspect', sourceCountryId: countryId('KOR'), kind: null, query: null, reference})).ok).toBe(false);
    expect(snapshot.search({query: '청진', sourceCountryId: countryId('AAA'), kind: null, page: {offset: 0, limit: 1}}).ok).toBe(false);
    expect(snapshot.inspect({...reference, metadataRef: {...reference.metadataRef, contentRoot: 'f'.repeat(64)}}).ok).toBe(false);
    expect(await loadProductionGeography({catalogRef: {...catalog.ref, topologyRoot: 'f'.repeat(64)}, metadataRef: null})).toMatchObject({status: 'stale'});
    expect(await loadProductionGeography({catalogRef: catalog.ref, metadataRef: {...selectedRef, contentRoot: 'f'.repeat(64)}})).toMatchObject({status: 'stale'});
    for (const invalid of [null, {...registry, manifest: {...registry.manifest, path: '../metadata.json'}},
      {...registry, manifest: {...registry.manifest, path: registry.manifest.path.replace(registry.metadataRef.contentRoot, 'f'.repeat(64))}}]) {
      const load = createProductionGeographyLoader({readFile: async file => {
        expect(file).toBe(path.join(process.cwd(), PRODUCTION_GEOGRAPHY_POINTER));
        return Buffer.from(JSON.stringify(invalid));
      }});
      expect(await load({catalogRef: catalog.ref, metadataRef: null})).toMatchObject({status: 'unavailable'});
    }
  });

  it('validates real fine countries and all current coarse countries with the independent country helper', () => {
    const {metadataRef, ...body} = snapshot.metadata; void metadataRef;
    for (const country of snapshot.metadata.countries) {
      const id = country.sourceCountryId;
      const prepared = sealGeographyMetadata({...body, countries: [country], states: body.states.filter(s => s.sourceCountryId === id),
        provinces: body.provinces.filter(p => p.sourceCountryId === id), sourceRegions: body.sourceRegions.filter(s => s.sourceCountryId === id)});
      const admitted = validateCountryMetadataInput(id, prepared, context);
      expect(admitted.ok, `${id}: ${JSON.stringify(admitted.ok ? null : admitted.diagnostics)}`).toBe(true);
      if (admitted.ok) expect(admitted.value.scope).toBe('country-preparation');
    }
  }, 120_000);

  it('returns the same compact quality facts through the actual default API and scripted model with no state/history mutation', async () => {
    const loaded = await loadProductionGeography({catalogRef: catalog.ref, metadataRef: null});
    if (loaded.status !== 'available') throw Error(JSON.stringify(loaded));
    const actual = loaded.snapshot, index = loadCatalogRegionIndex(catalog.ref, actual), game = createProductionOperationalGame('KOR');
    const session = createOperationalGameSession({seed: game.pair, catalog: game.catalog, regionIndex: index,
      frontier: () => {throw Error('No frontier evaluation in metadata reads');}, actionId: () => 'action.read-only'});
    const before = session.runtime.getSnapshot(), history = session.runtime.getHistory();
    const prepared = session.command({operation: 'prepare-turn', sessionId: 'isolated', revisions: before.revisions, targetDate: '2020-01-02'});
    if (!('context' in prepared) || !prepared.context || !prepared.turnId) throw Error('Missing prepared context');
    expect(prepared.context.geography).toEqual({catalogRef: actual.catalogRef, metadataRef: actual.metadataRef});
    const post = createRegionPost(), query = read({query: '중구', sourceCountryId: countryId('KOR'), page: {offset: 0, limit: 1}});
    const api = await post(request({mode: 'geography', catalogRef: catalog.ref, metadataRef: actual.metadataRef, request: query}));
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual(executeReadOnlySimulationTool('read_geography', query, prepared.context, index, undefined, actual));
    const missingParent = actual.metadata.provinces.find(p => p.stateId === null)!;
    const inspect = read({operation: 'inspect', kind: null, query: null, reference: {catalogRef: actual.catalogRef, metadataRef: actual.metadataRef, target: {kind: 'province', id: missingParent.provinceId}}});
    const unassigned = await (await post(request({mode: 'geography', catalogRef: catalog.ref, metadataRef: actual.metadataRef, request: inspect}))).json();
    expect(unassigned.value).toMatchObject({stateId: null, parentStatus: 'unassigned', materialization: {status: 'unsupported'}});
    const legacy = await (await post(request({catalogRef: catalog.ref, countryId: 'CHN', operation: 'occupy', query: '내몽골'}))).json();
    expect(legacy.region).toMatchObject({materializable: false, geography: {reference: {target: {kind: 'state'}}, coverage: {status: 'partial'}}});
    expect(() => index.resolve('CHN', legacy.region.ref, 'occupy')).toThrow('GEOGRAPHY_SCOPE_UNSUPPORTED');
    const requests: OpenAIResponsesRequest[] = [];
    const provider = new OpenAIResponsesSimulationProvider({apiKey: 'scripted', model: 'scripted', timeoutMs: 5000, maxRetries: 0,
      maxToolIterations: 4, maxToolCalls: 8, debugMode: false}, {async *stream(input) {
      requests.push(input);
      if (requests.length === 1) yield* tool('read_geography', query, 'geo.actual');
      else yield* tool('submit_turn_resolution', {contractVersion: 'turn-resolution.v1', baseSimulationRevision: before.simulation.revision,
        baseWorldRevision: before.world.revision, period: prepared.context!.period, playerActionOutcomes: [], events: [], factMutations: [],
        situationMutations: [], scheduledConsequences: [], worldEffects: [], advisorSummary: '지명 조회 확인', unresolvedQuestions: ['부분 coverage 유지']}, 'geo.submit');
    }}, {loadRegionIndex: () => index});
    const events = [];
    // Read provider directly: publishing an otherwise valid turn is outside this regression.
    for await (const event of provider.streamTurn({turnId: prepared.turnId, context: prepared.context,
      operationalWorld: before.world, geographySnapshot: actual, preparedRegionIndex: index}, new AbortController().signal)) events.push(event);
    expect(events.some(e => e.type === 'resolution.ready'), JSON.stringify(events)).toBe(true);
    const output = requests.at(-1)!.input.find(i => (i as {type?: string}).type === 'function_call_output') as {output: string};
    const data = JSON.parse(output.output).data.value;
    expect(data).toMatchObject({totalMatches: 6, ambiguous: true, truncated: true, metadataRef: actual.metadataRef});
    expect(data.items[0]).toMatchObject({reference: {target: {kind: 'source-region'}}, coverage: {status: 'partial'}});
    expect(session.runtime.getSnapshot()).toBe(before); expect(session.runtime.getHistory()).toEqual(history);
    const province = actual.metadata.provinces.find(p => p.sourceCountryId === 'PRK')!;
    const changed = transitionWorldStateV3(before.world, game.catalog, {territories: {[province.provinceId]: {...before.world.territoriesById[province.provinceId],
      ownerCountryId: before.world.countriesById.KOR.id, controllerCountryId: before.world.countriesById.CHN.id}}});
    expect(changed.territoriesById[province.provinceId]).toMatchObject({sourceCountryId: 'PRK', ownerCountryId: 'KOR', controllerCountryId: 'CHN'});
    const unchanged: GeographySummary = value(actual.inspect({catalogRef: actual.catalogRef, metadataRef: actual.metadataRef, target: {kind: 'province', id: province.provinceId}}));
    expect(unchanged.sourceCountryId).toBe('PRK'); expect(unchanged.names).toEqual(province.names);
    expect(session.runtime.getSnapshot().world).toBe(before.world);
  }, 120_000);
});
