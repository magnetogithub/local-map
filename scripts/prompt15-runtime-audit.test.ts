// @vitest-environment node
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {prepareProductionCatalogSeed} from '../src/lib/world/production-catalog-seed.server';
import {readCatalogConsumerMetadata} from '../src/lib/map/catalog-consumer-contract';
import {catalogContractForConsumer} from '../src/lib/projection/catalog-map-consumer-projection';
import {readCatalogRuntimePair} from '../src/lib/simulation/catalog-runtime';
import {prepareCatalogRegionIndex} from '../src/lib/simulation/catalog-region.server';
import {createSimulationToolManifest,executeReadOnlySimulationTool} from '../src/lib/simulation/server/simulation-tools';
import {buildSimulationContext} from '../src/lib/simulation/simulation-context';
import {createCountrySearchProjection} from '../src/lib/projection/country-search-index-patch';

it('audits the real production border tool and rejects overflow without truncating',()=>{
 const start=performance.now(),prepared=prepareProductionCatalogSeed(),index=prepareCatalogRegionIndex();
 const metadata=readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${prepared.bootstrap.metadata.path}`,'utf8')),prepared.bootstrap.catalogRef);
 const pair=readCatalogRuntimePair(prepared.serializedPair,catalogContractForConsumer(metadata));
 const context=buildSimulationContext({simulation:pair.simulation,world:pair.world,countrySearchProjection:createCountrySearchProjection(pair.world),
  subdivisionCatalog:{listCountry:()=>[],inspect:()=>null,materialize:()=>null},scenarioId:'2020-otl',scenarioStartDate:'2020-01-01',targetDate:'2020-01-08'});
 const direct=index.borderTerritories!('PRK','KOR',512);
 const response=executeReadOnlySimulationTool('find_border_territories',{countryId:'PRK',neighborCountryId:'KOR',cap:512},context,index);
 const baseline=JSON.parse(fs.readFileSync('reports/prompt15/15-01-baseline.json','utf8'));
 expect(direct).toEqual(baseline.northKoreaBorder.territories.map((t:{territoryId:string})=>t.territoryId));
 expect(direct.length).toBeGreaterThan(1);
 expect(()=>index.borderTerritories!('PRK','KOR',1)).toThrow('BORDER_REQUEST_CAP');
 const administrative=index.records.filter(r=>r.parentCountryId==='PRK'&&r.territoryIds.some(id=>direct.includes(id)));
 expect(administrative.length).toBe(direct.length);
 expect(administrative.every(r=>r.territoryIds.length===1)).toBe(true);
 const manifest=createSimulationToolManifest();
 expect(manifest.every(t=>t.strict&&t.parameters.additionalProperties===false)).toBe(true);
 fs.mkdirSync('reports/prompt15',{recursive:true});
 const identity=(path:string)=>{const bytes=fs.readFileSync(path);return {path,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length};};
 fs.writeFileSync('reports/prompt15/15-01-runtime-audit.json',JSON.stringify({status:'pass',command:'npx vitest run scripts/prompt15-runtime-audit.test.ts',
  mode:'Offline actual production functions and frozen assets; no provider network call or browser interaction',catalogRef:pair.world.catalogRef,
  directBorderTerritoryIds:direct,toolResponse:response,administrativeMembership:administrative,toolManifest:manifest,
  negativeCapCheck:'BORDER_REQUEST_CAP at cap=1; no truncated success',worldRevision:pair.world.revision,simulationRevision:pair.simulation.revision,
  elapsedMs:performance.now()-start,memory:process.memoryUsage(),inputs:[identity('src/lib/simulation/catalog-region.server.ts'),identity('src/lib/simulation/catalog-border-lookup.ts'),identity('src/lib/simulation/server/simulation-tools.ts')]}));
},120_000);
