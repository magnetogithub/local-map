// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {expect, it, vi} from 'vitest';
import type {OperationalFrontierSelection} from '../../src/lib/simulation/operational-frontier.server';
import type {OpenAIResponsesRequest} from '../../src/lib/simulation/server/openai-responses-transport';
import type {SimulationProviderEvent} from '../../src/lib/simulation/server/simulation-provider';

// CHN_CATALOG_POINTER supplies a candidate pointer without changing the active
// pointer, importing an old save, or bypassing any delivery digest checks.
const pointerPath = process.env.CHN_CATALOG_POINTER || 'data/runtime/operational-catalog/current.json';
const pointerBytes = fs.readFileSync(pointerPath);
const pointer = JSON.parse(pointerBytes.toString('utf8'));
const phase = process.env.CHN_VERIFY_PHASE || 'baseline';
const strict = process.env.CHN_VERIFY_STRICT === '1';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
if (process.env.CHN_CATALOG_POINTER) {
  vi.doMock('../../data/runtime/operational-catalog/current.json', () => ({default: pointer}));
  const originalRead = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (typeof file === 'string' && path.resolve(file) === path.resolve('data/runtime/operational-catalog/current.json')) {
      return args[0] === 'utf8' ? pointerBytes.toString('utf8') : Buffer.from(pointerBytes);
    }
    return Reflect.apply(originalRead, fs, [file, ...args]);
  }) as typeof fs.readFileSync);
}

const probe = process.env.CHN_VERIFY_PHASE ? it : it.skip;
probe('measures and validates the actual immutable catalog with zero external AI calls', async () => {
  const networkCalls: string[] = [];
  vi.stubGlobal('fetch', (input: unknown) => {networkCalls.push(String(input)); throw Error('EXTERNAL_NETWORK_FORBIDDEN_IN_CATALOG_PROBE');});
  const {prepareOperationalCatalog} = await import('../../src/lib/world/operational-catalog.server');
  const {createProductionOperationalGame} = await import('../../src/lib/world/operational-game.server');
  const {selectOperationalFrontier} = await import('../../src/lib/simulation/operational-frontier.server');
  const {createOperationalRegionIndex} = await import('../../src/lib/simulation/operational-region.server');
  const {createTerritoryEntityV3} = await import('../../src/lib/world/territory-entity-v3');
  const {createSimulationStateV2} = await import('../../src/lib/simulation/simulation-state-v2');
  const {buildSimulationContext} = await import('../../src/lib/simulation/simulation-context');
  const {createCountrySearchProjection} = await import('../../src/lib/projection/country-search-index-patch');
  const {OpenAIResponsesSimulationProvider} = await import('../../src/lib/simulation/server/openai-responses-provider');
  const {createCatalogRuntime} = await import('../../src/lib/simulation/catalog-runtime');
  const {createCatalogTurnPlan} = await import('../../src/lib/simulation/catalog-turn-plan');
  const measured = <T,>(fn: () => T) => {const t = performance.now(); const value = fn(); return {value, ms: performance.now() - t};};
  const memoryBefore = process.memoryUsage();
  const coldCatalog = measured(() => prepareOperationalCatalog());
  const catalog = coldCatalog.value;
  const countryCold = measured(() => catalog.loadCountry('CHN'));
  const countryWarm = measured(() => catalog.loadCountry('CHN'));
  const coldGame = measured(() => createProductionOperationalGame('CHN'));
  const warmGames = Array.from({length: 5}, () => measured(() => createProductionOperationalGame('CHN')).ms);
  const game = coldGame.value;
  const regionsCold = measured(() => createOperationalRegionIndex(catalog));
  const regions = regionsCold.value;
  const regionRecords = regions.listCountry('CHN');
  expect(regionRecords.length).toBeGreaterThan(0);
  for (const record of regionRecords) {
    expect(record.ref.catalogId).toBe(catalog.ref.catalogVersion);
    expect(record.territoryIds.every(id => catalog.cell(id).sourceCountryId === 'CHN')).toBe(true);
    expect(regions.lookup('CHN', record.ref)).toBe(record);
  }
  const memoryAfterInitialization = process.memoryUsage();
  const world = {catalogRef: catalog.ref, revision: 0, territoriesById: game.pair.world.territoriesById};
  const limits = (selection: OperationalFrontierSelection) => {
    expect(selection.limits).toEqual({depthKm: 36, widthKm: 36, maximumAreaKm2: 2800});
    expect(selection.metrics.maximumGraphDepthKm).toBeLessThanOrEqual(36);
    expect(selection.metrics.maximumForwardDepthKm).toBeLessThanOrEqual(36);
    expect(selection.metrics.maximumLateralKm).toBeLessThanOrEqual(18);
    expect(selection.metrics.areaKm2).toBeLessThanOrEqual(2800);
    for (const n of new Set(selection.cellIds.map(id => catalog.cell(id).administrativeOrdinal))) {
      const parent = catalog.administrativeParents[n - 1];
      const total = catalog.administrativeMembership(parent.parentKey).reduce((sum, c) => sum + catalog.cellMetrics(c.ordinal).areaKm2, 0);
      const selected = selection.cellIds.filter(id => catalog.cell(id).administrativeOrdinal === n).reduce((sum, id) => sum + catalog.cellMetrics(id).areaKm2, 0);
      if (total >= 8000) expect(selected).toBeLessThanOrEqual(total * .35);
    }
  };
  const gameplay: Record<string, unknown>[] = [];
  for (const [actor, target] of [['CHN', 'PRK'], ['PRK', 'CHN'], ['KOR', 'PRK'], ['PRK', 'KOR']]) {
    const record: Record<string, unknown> = {actor, target};
    gameplay.push(record);
    try {
      const request = {catalogRef: catalog.ref, baseWorldRevision: 0, actorCountryId: actor, targetCountryId: target, operation: 'occupy', extent: 'near', cap: 512};
      const firstTimed = measured(() => selectOperationalFrontier(catalog, world, request, regions));
      const first = firstTimed.value;
      const warmSelectionMs = Array.from({length: 5}, () => measured(() => selectOperationalFrontier(catalog, world, request, regions)).ms);
      limits(first);
      expect(first.cellIds.length).toBeGreaterThan(0);
      expect(first.cellIds.length).toBeLessThan(catalog.loadCountry(target).length);
      const advanced = {...world, revision: 1, territoriesById: {...world.territoriesById,
        ...Object.fromEntries(first.cellIds.map(id => [id, createTerritoryEntityV3({...world.territoriesById[id], controllerCountryId: actor})]))}};
      for (const id of first.cellIds) expect(advanced.territoriesById[id]).toMatchObject({sourceCountryId: target, ownerCountryId: target, controllerCountryId: actor});
      const followupTimed = measured(() => selectOperationalFrontier(catalog, advanced, {...request, baseWorldRevision: 1}, regions));
      const followup = followupTimed.value;
      limits(followup);
      expect(followup.frontier.kind).toBe('current-controller');
      expect(first.cellIds).toContain(followup.frontier.supportCellId);
      expect(followup.cellIds.every(id => !first.cellIds.includes(id))).toBe(true);
      expect(catalog.neighbors(catalog.cell(followup.frontier.cellId).ordinal)).toContain(catalog.cell(followup.frontier.supportCellId).ordinal);
      expect(() => selectOperationalFrontier(catalog, advanced, request, regions)).toThrow('STALE_WORLD_REVISION');
      expect(() => selectOperationalFrontier(catalog, world, {...request, catalogRef: {...catalog.ref, geometryRoot: '0'.repeat(64)}}, regions)).toThrow();
      for (const cell of catalog.loadCountry('USA')) expect(advanced.territoriesById[cell.id]).toBe(world.territoriesById[cell.id]);
      Object.assign(record, {pass: true, first: {ids: first.cellIds, metrics: first.metrics, frontier: first.frontier, ms: firstTimed.ms}, warmSelectionMs, followup: {ids: followup.cellIds, metrics: followup.metrics, frontier: followup.frontier, ms: followupTimed.ms}, limits: first.limits, ownerControllerSeparated: true, staleRevisionRejected: true, staleCatalogRejected: true});
    } catch (error) {
      Object.assign(record, {pass: false, error: error instanceof Error ? error.message : String(error)});
    }
  }

  // A complete host-validated turn uses the actual catalog and scripted tool
  // output through the production provider protocol. No HTTP transport exists.
  const turns: Record<string, unknown>[] = [];
  for (const actor of ['CHN', 'PRK']) {
    const target = actor === 'CHN' ? 'PRK' : 'CHN';
    if (!gameplay.find(r => r.actor === actor && r.target === target)?.pass) continue;
    const seed = createProductionOperationalGame(actor).pair;
    const ground = {eventId: `event.probe.ground.${actor}`, date: '2020-01-01', title: '접경 검증', publicNarrative: '실제 카탈로그의 접경 점령을 검증합니다.', actorCountryIds: [actor, target], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: 'military', significance: 'notable'};
    const action = {actionId: `action.probe.${actor}`, actorCountryId: actor, submittedAtDate: '2020-01-01', text: `${target} 접경 인근을 점령한다`, visibility: 'public', status: 'queued'};
    const authority = {id: `tca:probe:${actor}`, actorCountryId: actor, targetCountryId: target, allowedTerritoryIds: catalog.loadCountry(target).map(c => c.id), allowedOperations: ['occupy'], validFrom: '2020-01-01', validTo: null, sourceEventId: ground.eventId};
    const simulation = createSimulationStateV2({...seed.simulation, playerCountryId: actor, queuedActions: [action], eventLog: [...seed.simulation.eventLog, ground], territorialControlAuthoritiesById: {[authority.id]: authority}, territorialControlAuthorityOrder: [authority.id]}, seed.world);
    const pair = {...seed, simulation};
    const contextTimed = measured(() => buildSimulationContext({simulation, world: seed.world, countrySearchProjection: createCountrySearchProjection(seed.world), subdivisionCatalog: {listCountry: () => [], inspect: () => null, materialize: () => null}, scenarioId: 'chn-2020-verification', scenarioStartDate: '2020-01-01', targetDate: '2020-01-02'}));
    const context = contextTimed.value;
    let calls = 0;
    const outputs: unknown[] = [];
    const toolEvents = (name: string, args: unknown) => {
      const item = {type: 'function_call', call_id: `probe.${actor}.${calls}`, name, arguments: JSON.stringify(args)};
      return [{type: 'response.output_item.added', item: {...item, arguments: ''}}, {type: 'response.function_call_arguments.done', call_id: item.call_id, arguments: item.arguments}, {type: 'response.output_item.done', item}, {type: 'response.completed', response: {id: `response.probe.${actor}.${calls}`}}];
    };
    const provider = new OpenAIResponsesSimulationProvider({apiKey: 'scripted-no-network', model: 'scripted', timeoutMs: 30000, maxRetries: 0, maxToolIterations: 1, maxToolCalls: 3, debugMode: false}, {async *stream(request: OpenAIResponsesRequest) {
      calls++;
      let args: unknown, name: string;
      if (calls === 1) {
        name = 'find_frontier_territories';
        args = {actorCountryId: actor, targetCountryId: target, operation: 'occupy', extent: 'near', direction: null, reference: null, regionQuery: null, cap: 512};
      } else {
        const found = request.input.filter(i => typeof i === 'object' && i !== null && 'type' in i && i.type === 'function_call_output') as {output: string}[];
        const output = JSON.parse(found.at(-1)!.output);
        outputs.push(output);
        expect(output.ok).toBe(true);
        expect(output.data.ok).toBe(true);
        const eventId = `event.probe.advance.${actor}`;
        name = 'submit_turn_resolution';
        args = {contractVersion: 'turn-resolution.v1', baseSimulationRevision: simulation.revision, baseWorldRevision: seed.world.revision, period: context.period,
          playerActionOutcomes: [{outcomeId: `outcome.probe.${actor}`, actionId: action.actionId, status: 'succeeded', evidenceEventId: eventId, summary: '접경 일부 점령', remainingConditions: []}],
          events: [{...ground, eventId, date: '2020-01-02', causes: [{kind: 'queued-action', id: action.actionId}]}], factMutations: [], situationMutations: [], scheduledConsequences: [],
          worldEffects: [{effectId: `effect.probe.${actor}`, type: 'territory.occupy', causedByEventId: eventId, actorCountryId: actor, targetCountryId: target, authorityId: authority.id, ...output.data.effectTarget}], advisorSummary: '실제 카탈로그 부분 점령 검증', unresolvedQuestions: []};
      }
      yield* toolEvents(name, args);
    }}, {loadOperationalCatalog: () => catalog, loadRegionIndex: () => regions});
    const providerStarted = performance.now();
    const events: SimulationProviderEvent[] = [];
    for await (const event of provider.streamTurn({turnId: `turn.probe.${actor}`, context, operationalWorld: seed.world, operationalTerritorialAuthorities: [authority]}, new AbortController().signal)) events.push(event);
    const providerMs = performance.now() - providerStarted;
    const ready = events.find(e => e.type === 'resolution.ready');
    expect(ready, JSON.stringify(events)).toBeDefined();
    if (ready?.type !== 'resolution.ready') throw Error('SCRIPTED_PROVIDER_RESOLUTION_MISSING');
    const frontier = {world: seed.world, resolve: (current: typeof world, scope: unknown) => selectOperationalFrontier(catalog, current, scope, regions)};
    const runtime = createCatalogRuntime(pair, game.catalog);
    let notifications = 0;
    runtime.store.subscribe(() => notifications++);
    const planTimed = measured(() => createCatalogTurnPlan({...pair, turnId: `turn.probe.${actor}`, catalog: game.catalog, resolution: ready.resolution, regionIndex: regions, frontier}));
    const commitTimed = measured(() => runtime.commit(planTimed.value));
    expect(notifications).toBe(1);
    const changed = runtime.getLastChange()!.stateChange!.cells;
    expect(changed.length).toBeGreaterThan(0);
    expect(changed.every(c => c.before.ownerCountryId === target && c.after.ownerCountryId === target && c.after.controllerCountryId === actor)).toBe(true);
    const id = changed[0].id;
    expect(runtime.undo().world.territoriesById[id].controllerCountryId).toBe(target);
    expect(runtime.redo().world.territoriesById[id].controllerCountryId).toBe(actor);
    const beforeFailure = runtime.getSnapshot();
    expect(() => runtime.commit(planTimed.value)).toThrow();
    expect(runtime.getSnapshot()).toBe(beforeFailure);
    const warmTurnSamples = Array.from({length: 5}, (_, n) => {
      const repeated = createCatalogRuntime(pair, game.catalog);
      const plan = measured(() => createCatalogTurnPlan({...pair, turnId: `turn.probe.warm.${actor}.${n}`, catalog: game.catalog, resolution: ready.resolution, regionIndex: regions, frontier}));
      const committed = measured(() => repeated.commit(plan.value));
      return {planMs: plan.ms, commitMs: committed.ms};
    });
    turns.push({actor, target, pass: true, scriptedCalls: calls, externalAiCalls: 0, contextMs: contextTimed.ms, contextBytes: Buffer.byteLength(JSON.stringify(context)), providerMs, planMs: planTimed.ms, commitMs: commitTimed.ms, warmTurnSamples, changedCells: changed.length, atomicNotifications: 1, undoRedo: true, staleCommitAtomic: true, toolOutputs: outputs});
  }
  const index = JSON.parse(fs.readFileSync(path.join(pointer.root, 'artifact-index.json'), 'utf8'));
  const artifactBytes = (prefix: string) => index.artifacts.filter((a: {path: string}) => a.path.startsWith(prefix)).reduce((sum: number, a: {byteLength: number}) => sum + a.byteLength, 0);
  const report = {schemaVersion: 'chn-2020-play-performance-v1', phase, pass: gameplay.every(r => r.pass) && turns.length === 2 && networkCalls.length === 0,
    pointer: {path: pointerPath, sha256: sha(pointerBytes), byteLength: pointerBytes.length, ...pointer},
    code: ['scripts/chn-2020/verify-play-performance.test.ts', 'src/lib/simulation/operational-frontier-policy.ts', 'src/lib/simulation/operational-frontier.server.ts', 'src/lib/simulation/catalog-turn-plan.ts', 'src/lib/simulation/catalog-runtime.ts'].map(file => {const bytes = fs.readFileSync(file); return {path: file, sha256: sha(bytes), byteLength: bytes.length};}),
    conditions: {mode: 'Vitest Node production runtime; fresh process module caches for cold, same process immutable metadata cache for warm', osPageCache: 'not flushed', player: 'CHN/PRK', scenario: '2020-01-01 to 2020-01-02', viewport: null, browserMeasurement: 'separate root-owned browser evidence', externalAiCalls: 0},
    counts: catalog.descriptor.counts, countryCells: Object.fromEntries(['CHN', 'PRK', 'KOR'].map(id => [id, catalog.loadCountry(id).length])),
    initialization: {catalogColdMs: coldCatalog.ms, chnMetadataColdMs: countryCold.ms, chnMetadataWarmMs: countryWarm.ms, newGameColdMs: coldGame.ms, newGameWarmMs: warmGames, regionsColdMs: regionsCold.ms},
    bytes: {artifactIndex: fs.statSync(path.join(pointer.root, 'artifact-index.json')).size, metadata: artifactBytes('metadata/'), detail: artifactBytes('detail/'), tiles: artifactBytes('tiles/'), overviewZ0: artifactBytes('tiles/0/'), overviewZ2: artifactBytes('tiles/2/'), total: index.totalByteLength, adjacencyDecoded: gunzipSync(fs.readFileSync(path.join(pointer.root, 'adjacency.json.gz'))).length},
    memory: {before: memoryBefore, afterInitialization: memoryAfterInitialization, afterTurns: process.memoryUsage()}, gameplay, turns};
  fs.mkdirSync('reports/chn-2020', {recursive: true});
  fs.writeFileSync(`reports/chn-2020/${phase}-play-performance.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({phase, pass: report.pass, counts: report.counts, initialization: report.initialization, gameplay: gameplay.map(({actor, target, pass, error}) => ({actor, target, pass, error})), turns: turns.map(({actor, target, contextMs, providerMs, planMs, commitMs}) => ({actor, target, contextMs, providerMs, planMs, commitMs}))}));
  expect(networkCalls).toEqual([]);
  if (strict) expect(report.pass).toBe(true);
}, 120000);
