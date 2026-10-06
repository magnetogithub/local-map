// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import {beforeAll,describe,expect,it} from 'vitest';
import {prepareProductionCatalogSeed} from '../world/production-catalog-seed.server';
import {readCatalogConsumerMetadata} from '../map/catalog-consumer-contract';
import {catalogContractForConsumer,createCatalogMapConsumerProjection} from '../projection/catalog-map-consumer-projection';
import {createCatalogRuntime,readCatalogRuntimePair,type CatalogRuntimePair} from './catalog-runtime';
import {createCatalogTurnPlan} from './catalog-turn-plan';
import {buildSimulationContext,parseSimulationContextV1,SIMULATION_CONTEXT_LIMITS} from './simulation-context';
import {SIMULATION_CONTRACT_VERSION} from './simulation-contract-primitives';
import type {WorldGeometryCatalogContract} from '../world/world-geometry-catalog-ref';
import {serializeWorldStateV3} from '../world/world-state-v3';
let seed:CatalogRuntimePair,catalog:WorldGeometryCatalogContract,bootstrap:ReturnType<typeof prepareProductionCatalogSeed>;
beforeAll(()=>{
  bootstrap=prepareProductionCatalogSeed();const metadata=readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${bootstrap.bootstrap.metadata.path}`,'utf8')),bootstrap.bootstrap.catalogRef);
  catalog=catalogContractForConsumer(metadata);seed=readCatalogRuntimePair(bootstrap.serializedPair,catalog);
});
const resolution=(pair:CatalogRuntimePair)=>({contractVersion:SIMULATION_CONTRACT_VERSION,baseSimulationRevision:pair.simulation.revision,baseWorldRevision:pair.world.revision,period:{startDate:pair.simulation.currentDate,endDate:'2020-01-02'},playerActionOutcomes:[],events:[],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[],advisorSummary:'안정된 상황이 이어지고 있습니다.',unresolvedQuestions:[]});
describe('14-10 actual production atomic cutover',()=>{
  it('initializes only World V3/Simulation V2 from approved bytes, preserving 4,231 IDs, owners, controllers and colors',()=>{
    const runtime=createCatalogRuntime(seed,catalog),pair=runtime.getSnapshot();expect(pair.world.schemaVersion).toBe(3);expect(pair.simulation.schemaVersion).toBe(2);expect(pair.world.territoryOrder).toHaveLength(4231);expect(pair.world.countryOrder).toHaveLength(247);
    expect(pair.simulation.currentDate).toBe('2020-01-01');expect(pair.simulation.territorialControlAuthorityOrder).toEqual([]);expect(pair.simulation.countryPresentationAuthorityOrder).toEqual([]);
    for(const t of Object.values(pair.world.territoriesById))expect(t.controllerCountryId).toBe(t.ownerCountryId);
    for(const c of Object.values(pair.world.countriesById))expect(c.mapColor).toMatch(/^#[0-9A-F]{6}$/);
    expect(JSON.stringify(serializeWorldStateV3(pair.world))).not.toMatch(/"geometry"|"coordinates"|"topology"/);expect('setState'in runtime.store).toBe(false);
  });
  it('rejects stale roots, altered seed bytes and unavailable delivery before returning a production entrypoint',()=>{
    for(const kind of ['root','seed','tile'])expect(()=>prepareProductionCatalogSeed(process.cwd(),file=>{
      const b=fs.readFileSync(file);
      if(kind==='root'&&file.endsWith('frozen-catalog-ref.json')){const value=JSON.parse(b.toString());value.ref.geometryRoot='0'.repeat(64);return Buffer.from(JSON.stringify(value));}
      if(kind==='seed'&&file.endsWith('migration-pair.json'))return Buffer.concat([b,Buffer.from(' ')]);
      if(kind==='tile'&&file.endsWith(path.join('tiles','6','63','63.pbf')))throw new Error('Missing tile');return b;
    })).toThrow();
    const mixed=JSON.parse(bootstrap.serializedPair);mixed.world.schemaVersion=2;expect(()=>readCatalogRuntimePair(JSON.stringify(mixed),catalog)).toThrow();
    const stale=JSON.parse(bootstrap.serializedPair);stale.world.catalogRef.topologyRoot='0'.repeat(64);expect(()=>readCatalogRuntimePair(JSON.stringify(stale),catalog)).toThrow();
  });
  it('never reads full geometry/topology in server bootstrap',()=>{
    const reads:string[]=[];prepareProductionCatalogSeed(process.cwd(),file=>{reads.push(file);return fs.readFileSync(file);});
    expect(reads.some(p=>/geometry\.geojson|topology\.json/.test(p))).toBe(false);
  });
  it('publishes narrative commit, undo, redo and restart as one pair to every observer',()=>{
    const runtime=createCatalogRuntime(seed,catalog),observed:CatalogRuntimePair[]=[];runtime.store.subscribe(next=>observed.push(next));runtime.store.subscribe(()=>{throw new Error('Observer failed');});
    const before=runtime.getSnapshot(),plan=createCatalogTurnPlan({turnId:'turn.production',simulation:before.simulation,world:before.world,resolution:resolution(before),catalog});
    const after=runtime.commit(plan);expect(after.world).toBe(before.world);expect(after.simulation.currentDate).toBe('2020-01-02');expect(runtime.canUndo()).toBe(true);
    expect(runtime.undo().simulation.currentDate).toBe('2020-01-01');expect(runtime.redo().simulation.currentDate).toBe('2020-01-02');
    const restarted=runtime.restart();expect(restarted.world).toBe(seed.world);expect(restarted.simulation).toBe(seed.simulation);expect(restarted.simulation.currentDate).toBe('2020-01-01');expect(runtime.canUndo()).toBe(false);
    expect(observed).toHaveLength(4);for(const pair of observed){expect(pair.world.schemaVersion).toBe(3);expect(pair.simulation.schemaVersion).toBe(2);expect(pair.revisions.worldRevision).toBe(pair.world.revision);expect(pair.revisions.simulationRevision).toBe(pair.simulation.revision);}
    expect(runtime.getSubscriberFailures()).toHaveLength(4);
  });
  it('rejects tampered plans and stale commits without changing either authority',()=>{
    const runtime=createCatalogRuntime(seed,catalog),before=runtime.getSnapshot(),plan=createCatalogTurnPlan({turnId:'turn.production',simulation:before.simulation,world:before.world,resolution:resolution(before),catalog});
    expect(()=>runtime.commit({...plan,afterWorldHash:'0'.repeat(64)})).toThrow();expect(runtime.getSnapshot()).toBe(before);
    runtime.commit(plan);const next=runtime.getSnapshot();expect(()=>runtime.commit(plan)).toThrow();expect(runtime.getSnapshot()).toBe(next);
  });
  it('publishes both changed authorities in a single notification and preserves geometry roots for a country rename',()=>{
    const runtime=createCatalogRuntime(seed,catalog),before=runtime.getSnapshot(),notifications:CatalogRuntimePair[]=[];runtime.store.subscribe(next=>notifications.push(next));
    const r={...resolution(before),events:[{eventId:'event.rename',date:'2020-01-02',title:'국호 변경',publicNarrative:'국호가 변경되었습니다.',actorCountryIds:['KOR'],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'domestic',significance:'notable'}],worldEffects:[{effectId:'effect.rename',causedByEventId:'event.rename',type:'country.renamed',countryId:'KOR',displayName:'변경 대한민국'}]};
    const plan=createCatalogTurnPlan({turnId:'turn.rename',simulation:before.simulation,world:before.world,resolution:r,catalog});const after=runtime.commit(plan);
    expect(notifications).toHaveLength(1);expect(notifications[0].world).toBe(after.world);expect(notifications[0].simulation).toBe(after.simulation);expect(after.world.revision).toBe(1);expect(after.simulation.revision).toBe(1);expect(after.world.countriesById.KOR.names.mapKo).toBe('변경 대한민국');expect(after.world.catalogRef).toEqual(seed.world.catalogRef);expect(after.world.countriesById.KOR.mapColor).toBe(seed.world.countriesById.KOR.mapColor);
    const unsupported={...resolution(before),events:r.events,worldEffects:[{effectId:'effect.dissolve',causedByEventId:'event.rename',type:'country.dissolved',countryId:'KOR',successorCountryId:'CHN'}]};
    expect(()=>createCatalogTurnPlan({turnId:'turn.unsupported',simulation:before.simulation,world:before.world,resolution:unsupported,catalog})).toThrow(/INVALID_DISSOLUTION_CAUSE/);expect(runtime.getSnapshot()).toBe(after);
  });
  it('selects the player without introducing V1 and bounds a real catalog turn context with explicit clipping',()=>{
    const runtime=createCatalogRuntime(seed,catalog);runtime.selectPlayer('KOR');const pair=runtime.getSnapshot();expect(pair.simulation.playerCountryId).toBe('KOR');expect(pair.simulation.schemaVersion).toBe(2);
    const metadata=readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${bootstrap.bootstrap.metadata.path}`,'utf8')),bootstrap.bootstrap.catalogRef),p=createCatalogMapConsumerProjection(pair.world,metadata);
    const context=buildSimulationContext({world:pair.world,simulation:pair.simulation,countrySearchProjection:p.search,subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:'2020-01-02'});
    expect(parseSimulationContextV1(context)).toEqual(context);expect(context.playerCountry.countryId).toBe('KOR');expect(context.metadata.clipped.some(c=>c.section.startsWith('directory:'))).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThan(SIMULATION_CONTEXT_LIMITS.requestBytes);expect(context.rules.capabilities).not.toContain('semantic-world-effects');expect(context.territoryDirectory.flatMap(c=>c.territoryIds).every(id=>pair.world.territoriesById[id])).toBe(true);
  });
  it('keeps production entrypoints off legacy geometry bootstrap, stores and test-only adapters',()=>{
    const files=['src/components/layout/WorldAppPage.tsx','src/components/layout/CatalogGameSetupShell.tsx','src/components/game/CatalogGameScreen.tsx','src/components/map/CatalogWorldMap.tsx','src/lib/world/production-catalog-seed.server.ts','src/lib/simulation/catalog-runtime.ts'];
    for(const file of files){const text=fs.readFileSync(file,'utf8');expect(text).not.toMatch(/initial-world-state-v2|createWorldStateStore|deserializeWorldStateV2|\/test-only\/|geometry\.geojson|topology\.json|localStorage|indexedDB/);}
    const bridge=fs.readFileSync('src/lib/world/regression-page.server.ts','utf8');
    expect(bridge).toContain('return null;');
    expect(bridge).not.toMatch(/cookies|import\(|\/test-only\/|LegacyRegressionPage/);
    const config=fs.readFileSync('next.config.ts','utf8');
    expect(config).toMatch(/process\.env\.PAX_E2E_BUILD === "1"/);
    expect(config).toContain('"@/lib/world/regression-page.server": "./src/lib/test-only/regression-page.server.tsx"');
  });
});
