// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {beforeAll,describe,expect,it,vi} from 'vitest';
import type {Map as MapLibreMap,AddProtocolAction,SourceSpecification,LayerSpecification} from 'maplibre-gl';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {prepareCatalogConsumerBootstrap} from './catalog-consumer.server';
import * as catalogServer from './catalog-consumer.server';
import {GET} from '@/app/api/world/catalog/route';
import {catalogArtifactIdentity,readCatalogConsumerMetadata,readCatalogConsumerBootstrap,type CatalogConsumerBootstrap} from './catalog-consumer-contract';
import {fetchCatalogVectorDelivery,loadCatalogVectorDelivery,registerCatalogTileProtocol,verifyCatalogResponse,type CatalogFetch,type CatalogVectorDelivery} from './catalog-vector-delivery';
import {createCatalogMapConsumer,mountCatalogMapConsumer,type CatalogMapPort,CATALOG_MAP_LAYER_IDS} from './catalog-map-consumer';
import {mapLibreFeatureTarget} from './render-feature-ref';
import {catalogContractForConsumer,createCatalogMapConsumerProjection,updateCatalogMapConsumerProjection,catalogHitTerritory,CATALOG_MAP_SOURCE_ID} from '../projection/catalog-map-consumer-projection';
import {deserializeMigratedSchemaPair} from '../test-only/world-simulation-schema-checkpoint';
import {createWorldStateV3,serializeWorldStateV3,type WorldStateV3} from '../world/world-state-v3';
import {createWorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';

// A real MapLibre Map is structurally accepted by the opt-in adapter.
const mapPort=(map:MapLibreMap):CatalogMapPort=>map;
const root=process.cwd(),freeze=JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json','utf8'));
const ref=createWorldGeometryCatalogRef(freeze.ref),base=`/data/territory-catalog/${ref.catalogVersion}/`;
const bytesResponse=(bytes:Uint8Array)=>new Response(new Uint8Array(bytes).buffer);
const requested:string[]=[];
const fetcher:CatalogFetch=async(url)=>{
  requested.push(url);
  if(url==='/api/world/catalog')return GET();
  if(!url.startsWith(base))throw new Error(`Unexpected browser request: ${url}`);
  return bytesResponse(fs.readFileSync(path.join(root,`public${url}`)));
};
let bootstrap:CatalogConsumerBootstrap,delivery:CatalogVectorDelivery,world:WorldStateV3;
beforeAll(async()=>{
  bootstrap=prepareCatalogConsumerBootstrap();
  delivery=await fetchCatalogVectorDelivery(ref,fetcher);
  const pair=deserializeMigratedSchemaPair(fs.readFileSync(`data/catalogs/prompt14/${ref.catalogVersion}/migration-pair.json`,'utf8'),catalogContractForConsumer(delivery.metadata));
  world=pair.world;
});

function mockMap(){
  const sources=new Map<string,{spec:SourceSpecification;setData:ReturnType<typeof vi.fn>;updateData:ReturnType<typeof vi.fn>}>(),layers=new Map<string,LayerSpecification>();
  const listeners=new Map<string,(event:{features?:Parameters<typeof catalogHitTerritory>[1][]})=>void>();
  const states=vi.fn(),edgeStates=vi.fn();
  const map:CatalogMapPort={
    addSource:(id,spec)=>sources.set(id,{spec,setData:vi.fn(),updateData:vi.fn()}),removeSource:id=>sources.delete(id),
    addLayer:layer=>layers.set(layer.id,layer),removeLayer:id=>layers.delete(id),getSource:id=>sources.get(id),getLayer:id=>layers.get(id),
    setFeatureState:(target,state)=>target.sourceLayer==='edges'?edgeStates(target,state):states(target,state),on:(event,layer,fn)=>listeners.set(`${event}:${layer}`,fn),off:(event,layer)=>listeners.delete(`${event}:${layer}`),
  };
  return {map,sources,layers,listeners,states,edgeStates};
}
const changedWorld=(id:string,ownerCountryId:string|null,controllerCountryId:string|null)=>createWorldStateV3({...world,revision:world.revision+1,
  territoriesById:{...world.territoriesById,[id]:{...world.territoriesById[id],ownerCountryId,controllerCountryId}}},catalogContractForConsumer(delivery.metadata));
const hit=(id:string)=>({id,source:CATALOG_MAP_SOURCE_ID,sourceLayer:'territories',properties:{territoryId:id,ownerCountryId:'forged-country'}});

describe('frozen catalog consumer: actual delivery and immutable contracts',()=>{
  it('boots through the real API with all 4,231 territories and 247 source countries',()=>{
    expect(typeof mapPort).toBe('function');expect(bootstrap.catalogRef).toEqual(ref);
    expect(delivery.metadata.territories).toHaveLength(4231);expect(delivery.metadata.countries).toHaveLength(247);
    expect(world.schemaVersion).toBe(3);expect(delivery.source.promoteId).toEqual({territories:'territoryId',edges:'edgeId'});
    expect(delivery.source.type).toBe('vector');expect(delivery.source.maxzoom).toBe(6);
    expect(JSON.stringify(bootstrap)).not.toMatch(/geometry\.geojson|topology\.json|build-only/);
    expect(JSON.stringify(delivery.metadata)).not.toMatch(/"geometry"|"coordinates":\[\[|"ownerCountryId"|canonicalAtomKey/);
  });
  it('fails server readiness for missing assets, stale roots and altered PBF bytes',()=>{
    for(const kind of ['missing','stale','corrupt'])expect(()=>prepareCatalogConsumerBootstrap(root,file=>{
      const b=fs.readFileSync(file);
      if(kind==='missing'&&file.endsWith(path.join('tiles','6','63','63.pbf')))throw new Error('missing asset');
      if(kind==='stale'&&file.endsWith('frozen-catalog-ref.json')){const f=JSON.parse(b.toString());f.ref.geometryRoot='0'.repeat(64);return Buffer.from(JSON.stringify(f));}
      if(kind==='corrupt'&&file.endsWith('tile-index.json'))return Buffer.concat([b,Buffer.from(' ')]);
      return b;
    })).toThrow();
    expect(()=>prepareCatalogConsumerBootstrap(root,file=>{const b=fs.readFileSync(file);if(file.endsWith('.pbf')){const copy=Buffer.from(b);copy[0]^=1;return copy;}return b;})).toThrow(/identity/);
  });
  it('returns a readiness failure without exposing filesystem paths or partial contracts',async()=>{
    const mock=vi.spyOn(catalogServer,'loadCatalogConsumerBootstrap').mockImplementation(()=>{throw new Error('private filesystem failure');});
    try{const response=await GET();expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'catalog_not_ready',message:'지도 catalog를 불러올 수 없습니다.'});}
    finally{mock.mockRestore();}
  });
  it('rejects stale browser refs, path traversal, unknown metadata, duplicate IDs and forged seed links',()=>{
    expect(()=>readCatalogConsumerBootstrap({...bootstrap,catalogRef:{...ref,topologyRoot:'0'.repeat(64)}},ref)).toThrow();
    for(const suffix of ['../geometry.geojson','tiles/%2e%2e/private','tiles/0/0/0.pbf?x=1'])expect(()=>catalogArtifactIdentity({...bootstrap.metadata,path:base+suffix},ref)).toThrow();
    for(const mutate of [
      (m:Record<string,unknown>)=>{m.geometry={type:'FeatureCollection'};},
      (m:Record<string,unknown>)=>{const t=m.territories as {id:string}[];t[1].id=t[0].id;},
      (m:Record<string,unknown>)=>{const c=m.countries as {label:{territoryId:string}}[];c[0].label.territoryId=c[1].label.territoryId;},
    ]){const m=JSON.parse(JSON.stringify(delivery.metadata));mutate(m);expect(()=>readCatalogConsumerMetadata(m,ref)).toThrow();}
  });
  it('checks requested response hashes and lengths and rejects HTTP failures, redirect and abort',async()=>{
    const bytes=fs.readFileSync(`public${bootstrap.manifest.path}`),id=bootstrap.manifest;
    await expect(verifyCatalogResponse(bytesResponse(bytes),id)).resolves.toHaveProperty('byteLength',bytes.length);
    await expect(verifyCatalogResponse(bytesResponse(bytes.subarray(1)),id)).rejects.toThrow(/length/);
    const corrupt=Buffer.from(bytes);corrupt[0]^=1;
    await expect(verifyCatalogResponse(bytesResponse(corrupt),id)).rejects.toThrow(/SHA/);
    await expect(verifyCatalogResponse(new Response('',{status:503}),id)).rejects.toThrow(/503/);
    const redirect=bytesResponse(bytes);Object.defineProperty(redirect,'redirected',{value:true});
    await expect(verifyCatalogResponse(redirect,id)).rejects.toThrow(/redirect/);
    await expect(verifyCatalogResponse(bytesResponse(bytes),id,AbortSignal.abort())).rejects.toThrow();
  });
  it('uses canonical string property IDs from real PBF, caches verified bytes, and rejects unregistered requests',async()=>{
    // vector-tile's legacy declaration still names Pbf; the pinned decoder uses PbfReader.
    const file=`${base}tiles/0/0/0.pbf`,bytes=await delivery.loadTile(file),tile=new VectorTile(new PbfReader(new Uint8Array(bytes)) as unknown as ConstructorParameters<typeof VectorTile>[0]);
    expect(tile.layers.territories.length).toBeGreaterThan(0);expect(tile.layers.edges.length).toBeGreaterThan(0);
    for(let i=0;i<tile.layers.territories.length;i++){
      const f=tile.layers.territories.feature(i),id=f.properties.territoryId;
      expect(typeof id).toBe('string');expect(world.territoriesById[String(id)]).toBeDefined();
      expect(catalogHitTerritory(createCatalogMapConsumerProjection(world,delivery.metadata),{...hit(String(id)),id:f.id})).toBeNull();
      if(i>4)break;
    }
    const count=delivery.counters().verifiedRequests,cached=await delivery.loadTile(file);
    expect(Buffer.from(cached).equals(Buffer.from(bytes))).toBe(true);expect(delivery.counters().verifiedRequests).toBe(count);expect(delivery.counters().cacheHits).toBeGreaterThan(0);
    new Uint8Array(cached)[0]^=1;expect(Buffer.from(await delivery.loadTile(file)).equals(Buffer.from(bytes))).toBe(true);
    await expect(delivery.loadTile(`${base}geometry.geojson`)).rejects.toThrow(/Unregistered/);
    await expect(delivery.loadTile(`${base}tiles/7/0/0.pbf`)).rejects.toThrow(/Unregistered/);
  });
  it('connects and removes the MapLibre protocol and forwards cancellation',async()=>{
    let action:AddProtocolAction|undefined;const api={addProtocol:vi.fn((_name:string,handler:AddProtocolAction)=>{action=handler;}),removeProtocol:vi.fn()};
    const remove=registerCatalogTileProtocol(api,delivery),controller=new AbortController();
    const response=await action!({url:`${delivery.protocol}://${base}tiles/0/0/0.pbf`},controller);
    expect(response.data).toBeInstanceOf(ArrayBuffer);controller.abort();
    await expect(action!({url:`${delivery.protocol}://${base}tiles/0/0/0.pbf`},controller)).rejects.toThrow();
    remove();expect(api.removeProtocol).toHaveBeenCalledWith(delivery.protocol);
  });
  it('shares protocol registration across maps until the final consumer releases it',()=>{
    const api={addProtocol:vi.fn(),removeProtocol:vi.fn()},a=registerCatalogTileProtocol(api,delivery),b=registerCatalogTileProtocol(api,delivery);
    expect(api.addProtocol).toHaveBeenCalledTimes(1);a();a();expect(api.removeProtocol).not.toHaveBeenCalled();b();b();expect(api.removeProtocol).toHaveBeenCalledTimes(1);
    const c=registerCatalogTileProtocol(api,delivery);expect(api.addProtocol).toHaveBeenCalledTimes(2);c();
  });
  it('bounds cached tiles while verifying the entire actual z0–6 delivery',async()=>{
    const fresh=await loadCatalogVectorDelivery(bootstrap,ref,fetcher);
    for(let z=0;z<=6;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++)await fresh.loadTile(`${base}tiles/${z}/${x}/${y}.pbf`);
    expect(fresh.counters().verifiedRequests).toBe(5464);expect(fresh.counters().cachedTiles).toBeLessThanOrEqual(256);expect(fresh.counters().cachedBytes).toBeLessThanOrEqual(8*1024*1024);
    expect(requested.every(p=>p==='/api/world/catalog'||p.startsWith(base))).toBe(true);
    expect(requested.some(p=>/build-only|geometry\.geojson|topology\.json/.test(p))).toBe(false);
  },30000);
});

describe('catalog projection and MapLibre consumer before production cutover',()=>{
  it('updates partial occupation/controller color and adjacent fronts only, then restores both through undo/redo',async()=>{
    const local=await loadCatalogVectorDelivery(bootstrap,ref,fetcher),incidences=new Map<string,import('./catalog-vector-delivery').CatalogEdgeIncidence>();
    const stop=local.observeEdges(batch=>batch.forEach(e=>incidences.set(e.id,e)));
    await local.loadTile(`${base}tiles/0/0/0.pbf`);
    const m=mockMap(),consumer=createCatalogMapConsumer({map:m.map,delivery:local,world}),ids=world.territoryOrder.filter(id=>world.territoriesById[id].ownerCountryId==='CHN').slice(0,3);
    const initialProjection=consumer.getProjection(),territories={...world.territoriesById};for(const id of ids)territories[id]={...territories[id],controllerCountryId:'KOR' as never};
    const occupied=createWorldStateV3({...world,revision:world.revision+1,territoriesById:territories},catalogContractForConsumer(local.metadata));
    for(const next of [occupied,createWorldStateV3({...world,revision:world.revision+2},catalogContractForConsumer(local.metadata)),createWorldStateV3({...occupied,revision:world.revision+3},catalogContractForConsumer(local.metadata))]){
      m.states.mockClear();m.edgeStates.mockClear();consumer.updateWorld(next);const p=consumer.getProjection();
      expect(m.states.mock.calls.map(([t])=>t.id)).toEqual(ids);expect(p.projectionStats.fullBuilds).toBe(1);expect(p.projectionStats.countryRebuilds).toBe(247);
      for(const id of ids){expect(p.featuresById[id].ownerCountryId).toBe('CHN');expect(p.featuresById[id].mapColor).toBe(next.countriesById[next.territoriesById[id].controllerCountryId!].mapColor);}
      expect(p.labels.pointFallbacksByLabelId.get('catalog-label:CHN')).toBe(initialProjection.labels.pointFallbacksByLabelId.get('catalog-label:CHN'));expect(p.capitals.featuresByCountryId.get('CHN' as never)).toBe(initialProjection.capitals.featuresByCountryId.get('CHN' as never));
      for(const [target,state]of m.edgeStates.mock.calls){const e=incidences.get(target.id)!;const affected=new Set<string>(ids);expect(affected.has(e.left??'')||affected.has(e.right??'')).toBe(true);expect(target.sourceLayer).toBe('edges');
        const a=e.left?next.territoriesById[e.left]:null,b=e.right?next.territoriesById[e.right]:null;expect(state.front).toBe(!!(a&&b&&((a.controllerCountryId!==a.ownerCountryId)||(b.controllerCountryId!==b.ownerCountryId))&&a.controllerCountryId!==b.controllerCountryId));}
      expect(m.edgeStates.mock.calls.length).toBeGreaterThan(0);for(const s of m.sources.values()){expect(s.setData).not.toHaveBeenCalled();expect(s.updateData).not.toHaveBeenCalled();}
    }
    expect(consumer.getCountryPanel('CHN')?.ownedTerritoryCount).toBe(initialProjection.ownedByCountry.CHN.length);expect(consumer.getCountryPanel('KOR')?.controlledTerritoryCount).toBe(initialProjection.controlledByCountry.KOR.length+3);consumer.dispose();stop();
  });
  it('incremental ownership transfer matches a full projection and retains unaffected label/search objects',()=>{
    const p=createCatalogMapConsumerProjection(world,delivery.metadata),id=p.ownedByCountry.CHN[0],next=changedWorld(id,'KOR','KOR'),incremental=updateCatalogMapConsumerProjection(p,next).projection,full=createCatalogMapConsumerProjection(next,delivery.metadata);
    for(const key of ['ownedByCountry','controlledByCountry','presentedByCountry','featuresById','focusByCountryId'] as const)expect(incremental[key]).toEqual(full[key]);
    expect(incremental.capitals.featuresByCountryId).toEqual(full.capitals.featuresByCountryId);expect(incremental.panel.inputById).toEqual(full.panel.inputById);expect(incremental.search.entriesById).toEqual(full.search.entriesById);
    expect(incremental.labels.pointFallbacksByLabelId.get('catalog-label:USA')).toBe(p.labels.pointFallbacksByLabelId.get('catalog-label:USA'));expect(incremental.search.entriesById.get('USA' as never)).toBe(p.search.entriesById.get('USA' as never));expect(incremental.projectionStats.countryRebuilds).toBe(249);
  });
  it('mounts from the server bootstrap through browser delivery and registers the actual vector protocol',async()=>{
    const m=mockMap(),api={addProtocol:vi.fn(),removeProtocol:vi.fn()};
    const consumer=await mountCatalogMapConsumer({map:m.map,world,protocolApi:api,fetcher});
    expect(api.addProtocol).toHaveBeenCalledTimes(1);expect(m.sources.get(CATALOG_MAP_SOURCE_ID)?.spec).toEqual(delivery.source);
    expect(consumer.getProjection().world.territoryOrder).toHaveLength(4231);consumer.dispose();consumer.dispose();expect(api.removeProtocol).toHaveBeenCalledTimes(1);
    await expect(mountCatalogMapConsumer({map:m.map,world,protocolApi:api,fetcher,signal:AbortSignal.abort()})).rejects.toThrow();expect(m.sources.size).toBe(0);
  });
  it('projects all territories, grouped selection/hover, country labels, capitals, panel and focus against frozen roots',()=>{
    const original=JSON.stringify(serializeWorldStateV3(world)),p=createCatalogMapConsumerProjection(world,delivery.metadata);
    expect(p.catalogRef).toEqual(ref);expect(Object.keys(p.featuresById)).toHaveLength(4231);
    for(const id of world.territoryOrder){const t=world.territoriesById[id];expect(p.featuresById[id].ref).toEqual({sourceType:'vector',sourceId:CATALOG_MAP_SOURCE_ID,sourceLayer:'territories',featureId:id});expect(p.featuresById[id].mapColor).toBe(world.countriesById[t.ownerCountryId!].mapColor);}
    for(const id of world.countryOrder){expect(p.presentedByCountry[id].length).toBeGreaterThan(0);expect(p.focusByCountryId[id]).toBeDefined();expect(p.panel.inputById.get(id)?.nameKo).toBe(world.countriesById[id].names.shortKo);expect(p.search.entriesById.get(id)?.english).toBe(world.countriesById[id].names.english);}
    expect(p.labels.jobs).toHaveLength(247);for(const f of p.capitals.features)expect(world.territoriesById[f.properties.territoryId].ownerCountryId).toBe(f.properties.countryId);
    expect(JSON.stringify(serializeWorldStateV3(world))).toBe(original);
  });
  it('separates vector and GeoJSON feature-state targets, stripping sourceLayer from GeoJSON',()=>{
    expect(mapLibreFeatureTarget({sourceType:'vector',sourceId:'s',sourceLayer:'territories',featureId:'id'})).toEqual({source:'s',sourceLayer:'territories',id:'id'});
    const contaminated={sourceType:'geojson' as const,sourceId:'labels',featureId:'label',sourceLayer:'territories'};
    expect(mapLibreFeatureTarget(contaminated)).toEqual({source:'labels',id:'label'});
    expect(Object.hasOwn(mapLibreFeatureTarget(contaminated),'sourceLayer')).toBe(false);
  });
  it('uses committed owner/controller rather than source-country or hit properties for interactions',()=>{
    const id=world.territoryOrder[0],owner=world.territoriesById[id].ownerCountryId!,other=world.countryOrder.find(c=>c!==owner)!;
    for(const [o,c,expected]of [[other,owner,other],[null,other,other],[null,null,null]] as const){
      const p=createCatalogMapConsumerProjection(changedWorld(id,o,c),delivery.metadata);
      expect(catalogHitTerritory(p,hit(id))?.countryId).toBe(expected);
      expect(p.featuresById[id].mapColor).toBe(c?world.countriesById[c].mapColor:o?world.countriesById[o].mapColor:'#D6D3C7');
      expect(p.ownedByCountry[owner]).not.toContain(id);
      expect(catalogHitTerritory(p,{...hit(id),sourceLayer:'edges'})).toBeNull();
      expect(catalogHitTerritory(p,{...hit(id),properties:{territoryId:'unknown'}})).toBeNull();
    }
  });
  it('mounts real catalog sources, handles selection/hover, applies mutable changes without vector setData, and disposes',()=>{
    const m=mockMap(),onSelect=vi.fn(),onHover=vi.fn(),consumer=createCatalogMapConsumer({map:m.map,delivery,world,onSelect,onHover});
    expect(m.sources.get(CATALOG_MAP_SOURCE_ID)?.spec.type).toBe('vector');expect(m.states).toHaveBeenCalledTimes(4231+world.countryOrder.length);
    expect(m.listeners.size).toBe(3);expect([...m.listeners.keys()].some(k=>/moveend|zoom|render/.test(k))).toBe(false);
    const id=world.territoryOrder[0],owner=world.territoriesById[id].ownerCountryId!,other=world.countryOrder.find(c=>c!==owner)!;
    const initial=consumer.getProjection(),requests=delivery.counters().verifiedRequests;
    m.listeners.get(`mousemove:${CATALOG_MAP_LAYER_IDS.fill}`)!({features:[hit(id)]});m.listeners.get(`click:${CATALOG_MAP_LAYER_IDS.fill}`)!({features:[hit(id)]});
    expect(onHover).toHaveBeenLastCalledWith(owner);expect(onSelect).toHaveBeenLastCalledWith(owner);
    expect(consumer.getCountryPanel(owner)?.ownedTerritoryCount).toBe(initial.ownedByCountry[owner].length);
    for(let i=0;i<20;i++){consumer.hoverCountry(i%2?owner:other);consumer.selectCountry(i%2?owner:other);}
    expect(consumer.getProjection()).toBe(initial);expect(delivery.counters().verifiedRequests).toBe(requests);
    expect(()=>consumer.updateWorld(world)).not.toThrow();m.states.mockClear();
    consumer.updateWorld(changedWorld(id,other,owner));expect(m.states).toHaveBeenCalledTimes(1);
    expect(m.states.mock.calls[0][0]).toEqual({source:CATALOG_MAP_SOURCE_ID,sourceLayer:'territories',id});
    expect(m.states.mock.calls[0][1]).toMatchObject({ownerCountryId:other,controllerCountryId:owner,occupied:true});
    expect(m.sources.get(CATALOG_MAP_SOURCE_ID)?.setData).not.toHaveBeenCalled();expect(m.sources.get('catalog-country-labels')?.setData).not.toHaveBeenCalled();
    expect(()=>consumer.updateWorld(world)).toThrow(/Stale/);expect(()=>consumer.selectCountry('unknown')).toThrow(/active/);
    m.listeners.get(`click:${CATALOG_MAP_LAYER_IDS.fill}`)!({features:[hit(id)]});expect(onSelect).toHaveBeenLastCalledWith(other);
    consumer.dispose();consumer.dispose();expect(m.sources.size).toBe(0);expect(m.layers.size).toBe(0);expect(m.listeners.size).toBe(0);
  });
  it('updates RGB color, names and labels from mutable country state without changing catalog identity',()=>{
    const id=world.countryOrder[0],country=world.countriesById[id],m=mockMap(),consumer=createCatalogMapConsumer({map:m.map,delivery,world});m.states.mockClear();
    const next=createWorldStateV3({...world,revision:world.revision+1,countriesById:{...world.countriesById,[id]:{...country,mapColor:'#123456',names:{...country.names,shortKo:'변경 국가',mapKo:'변경 라벨'}}}},catalogContractForConsumer(delivery.metadata));
    consumer.updateWorld(next);expect(consumer.getProjection().catalogRef).toEqual(ref);
    expect(consumer.getCountryPanel(id)?.nameKo).toBe('변경 국가');expect(consumer.getProjection().search.entriesById.get(id)?.mapKo).toBe('변경 라벨');
    expect(consumer.getProjection().labels.jobs.find(j=>j.countryId===id)?.text).toBe('변경 라벨');
    expect(m.states).toHaveBeenCalledTimes(consumer.getProjection().ownedByCountry[id].length+1);for(const [,state]of m.states.mock.calls)expect(state.mapColor).toBe('#123456');consumer.dispose();
  });
  it('clears retired-country interactions and removes its labels and panel while preserving source identity',()=>{
    const old=world.countryOrder[0],nextOwner=world.countryOrder[1],m=mockMap(),onSelect=vi.fn(),onHover=vi.fn();
    const consumer=createCatalogMapConsumer({map:m.map,delivery,world,onSelect,onHover});consumer.selectCountry(old);consumer.hoverCountry(old);
    const next=createWorldStateV3({...world,revision:world.revision+1,countryOrder:world.countryOrder.filter(id=>id!==old),countriesById:Object.fromEntries(Object.entries(world.countriesById).filter(([id])=>id!==old)),
      retiredCountryIds:new Set([...world.retiredCountryIds,old]),territoriesById:Object.fromEntries(Object.entries(world.territoriesById).map(([id,t])=>[id,{...t,ownerCountryId:t.ownerCountryId===old?nextOwner:t.ownerCountryId,controllerCountryId:t.controllerCountryId===old?nextOwner:t.controllerCountryId}]))},catalogContractForConsumer(delivery.metadata));
    consumer.updateWorld(next);expect(onSelect).toHaveBeenLastCalledWith(null);expect(onHover).toHaveBeenLastCalledWith(null);expect(consumer.getCountryPanel(old)).toBeNull();
    expect(consumer.getProjection().labels.jobs.some(j=>j.countryId===old)).toBe(false);expect(consumer.getProjection().catalogRef).toEqual(ref);
    expect(m.sources.get('catalog-country-labels')?.updateData.mock.calls[0][0].remove).toContain(`catalog-label:${old}`);
    consumer.updateWorld(createWorldStateV3({...world,revision:next.revision+1},catalogContractForConsumer(delivery.metadata)));
    expect(m.sources.get('catalog-country-labels')?.updateData.mock.calls[1][0].add.some((f:{id:string})=>f.id===`catalog-label:${old}`)).toBe(true);
    for(const source of m.sources.values())expect(source.setData).not.toHaveBeenCalled();consumer.dispose();
  });
  it('updates only the renamed label through rename, undo and redo, with no capital or whole-source updates',()=>{
    const m=mockMap(),consumer=createCatalogMapConsumer({map:m.map,delivery,world}),id='KOR',country=world.countriesById[id];
    for(const [index,text]of ['새 대한민국',country.names.mapKo,'새 대한민국'].entries()){
      const next=createWorldStateV3({...world,revision:world.revision+index+1,countriesById:{...world.countriesById,[id]:{...country,names:{...country.names,mapKo:text}}}},catalogContractForConsumer(delivery.metadata));
      consumer.updateWorld(next);
      const calls=m.sources.get('catalog-country-labels')!.updateData.mock.calls;expect(calls).toHaveLength(index+1);
      const diff=calls.at(-1)![0];expect(diff.remove).toBeUndefined();expect(diff.add).toBeUndefined();expect(diff.update).toHaveLength(1);
      expect(diff.update[0].id).toBe('catalog-label:KOR');expect(diff.update[0].newGeometry).toBeUndefined();
      expect(diff.update[0].addOrUpdateProperties).toContainEqual({key:'text',value:text});
      expect(m.sources.get('catalog-capitals')!.updateData).not.toHaveBeenCalled();for(const source of m.sources.values())expect(source.setData).not.toHaveBeenCalled();
    }
    const last=consumer.getProjection().world;consumer.updateWorld(createWorldStateV3({...last,revision:last.revision+1},catalogContractForConsumer(delivery.metadata)));
    expect(m.sources.get('catalog-country-labels')!.updateData).toHaveBeenCalledTimes(3);expect(m.states).toHaveBeenCalledTimes(world.territoryOrder.length+world.countryOrder.length);consumer.dispose();
  });
  it('rejects incompatible world/catalog input before mounting or applying any source mutation',()=>{
    const bad={...world,catalogRef:{...ref,renderArtifactRoot:'0'.repeat(64)}},m=mockMap();
    expect(()=>createCatalogMapConsumer({map:m.map,delivery,world:bad})).toThrow();expect(m.sources.size).toBe(0);
    const consumer=createCatalogMapConsumer({map:m.map,delivery,world}),before=consumer.getProjection();m.states.mockClear();
    expect(()=>consumer.updateWorld({...bad,revision:world.revision+1})).toThrow();expect(consumer.getProjection()).toBe(before);expect(m.states).not.toHaveBeenCalled();consumer.dispose();
  });
  it('preserves the actual frozen migration snapshot and catalog roots',()=>{
    expect(createHash('sha256').update(fs.readFileSync(freeze.artifactIndex.path)).digest('hex')).toBe(freeze.artifactIndex.sha256);
    expect(JSON.parse(fs.readFileSync('reports/prompt14/14-08-immutable-catalog-checkpoint.json','utf8')).status).toBe('pass');
  });
});
