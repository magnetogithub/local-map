// @vitest-environment node
import fs from 'node:fs';
import {expect,it,vi} from 'vitest';
import type {Map as MapLibreMap} from 'maplibre-gl';
import {mountCatalogLabelRenderer} from './catalog-label-renderer';
import {prepareProductionCatalogSeed} from '../world/production-catalog-seed.server';
import {readCatalogConsumerMetadata} from './catalog-consumer-contract';
import {catalogContractForConsumer} from '../projection/catalog-map-consumer-projection';
import {readCatalogRuntimePair} from '../simulation/catalog-runtime';
it('updates only affected glyphs and restores the exact approved seed on undo; camera/controller/color need no layout',async()=>{
 const p=prepareProductionCatalogSeed(),catalog=catalogContractForConsumer(readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${p.bootstrap.metadata.path}`,'utf8')),p.bootstrap.catalogRef)),{world}=readCatalogRuntimePair(p.serializedPair,catalog);
 const read=(name:string)=>JSON.parse(fs.readFileSync(`public/data/maps/${name}-2020.geojson`,'utf8'));
 const seed={placements:read('country-labels'),fills:read('country-label-glyph-fills'),outlines:read('country-label-glyph-outlines')};
 const layers=new Map<string,Record<string,unknown>>(),sources=new Map<string,{updateData:ReturnType<typeof vi.fn>}>(),camera=new Map<string,()=>void>();
 const map={addSource:(id:string)=>sources.set(id,{updateData:vi.fn()}),addLayer:(l:Record<string,unknown>)=>layers.set(String(l.id),l),getLayer:(id:string)=>({serialize:()=>layers.get(id)}),getSource:(id:string)=>sources.get(id),setLayoutProperty:vi.fn(),setFeatureState:vi.fn(),setFilter:vi.fn(),moveLayer:vi.fn(),getZoom:()=>3,on:(event:string,f:()=>void)=>camera.set(event,f),off:vi.fn(),removeSource:vi.fn(),removeLayer:vi.fn()};
 let calls=0;const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async(_url,init)=>{
   if(!init?.body)return Response.json(seed);calls++;const {countryId,text}=JSON.parse(String(init.body));return Response.json({placement:{...seed.placements.features.find((f:{properties:{countryId:string}})=>f.properties.countryId===countryId),properties:{countryId,mapLabelKo:text,placementMode:'territory-point'}},fills:{type:'FeatureCollection',features:seed.fills.features.filter((f:{properties:{countryId:string}})=>f.properties.countryId===countryId)},outlines:{type:'FeatureCollection',features:seed.fills.features.filter((f:{properties:{countryId:string}})=>f.properties.countryId===countryId)}});
 });
 try{
  const labels=await mountCatalogLabelRenderer(map as unknown as MapLibreMap,world,new AbortController().signal),initial=labels.collections().get('catalog-country-glyph-fills')!.features;
  camera.get('zoom')!();expect(calls).toBe(0);
  const color={...world,countriesById:{...world.countriesById,FRA:{...world.countriesById.FRA,mapColor:'#123456'}}} as typeof world;labels.updateWorld(color);expect(calls).toBe(0);
  const id=world.territoryOrder.find(id=>world.territoriesById[id].ownerCountryId==='CHN')!,occupied={...color,territoriesById:{...color.territoriesById,[id]:{...color.territoriesById[id],controllerCountryId:'KOR'}}} as typeof world;labels.updateWorld(occupied);expect(calls).toBe(0);
  labels.updateWorld({...occupied,countriesById:{...occupied.countriesById,FRA:{...occupied.countriesById.FRA,names:{...occupied.countriesById.FRA.names,mapKo:'Renamed France'}}}});
  await vi.waitFor(()=>expect(labels.ready()).toBe(true));expect(calls).toBe(1);
  const changed=labels.collections().get('catalog-country-glyph-fills')!.features;
  const initialOutlines=labels.collections().get('catalog-country-glyph-outlines')!.features.filter(f=>f.properties.countryId!=='FRA');
  expect(changed.filter(f=>f.properties.countryId!=='FRA')).toEqual(initial.filter(f=>f.properties.countryId!=='FRA'));
  labels.updateWorld(world);expect(labels.ready()).toBe(true);expect(calls).toBe(1);expect(labels.collections().get('catalog-country-glyph-fills')!.features.filter(f=>f.properties.countryId==='FRA')).toEqual(initial.filter(f=>f.properties.countryId==='FRA'));
  const restoredOutlines=labels.collections().get('catalog-country-glyph-outlines')!.features;
  expect(restoredOutlines.filter(f=>f.properties.countryId!=='FRA')).toEqual(initialOutlines);
  expect(restoredOutlines.filter(f=>f.properties.countryId==='FRA').every(f=>f.properties.role==='outline')).toBe(true);
  const transferred=world.territoryOrder.find(id=>world.territoriesById[id].ownerCountryId==='DEU')!;
  labels.updateWorld({...world,territoriesById:{...world.territoriesById,[transferred]:{...world.territoriesById[transferred],ownerCountryId:'FRA',controllerCountryId:'FRA'}}} as typeof world);
  await vi.waitFor(()=>expect(labels.ready()).toBe(true));expect(calls).toBe(3);expect(labels.collections().get('catalog-country-glyph-fills')!.features.filter(f=>!['FRA','DEU'].includes(String(f.properties.countryId)))).toEqual(initial.filter(f=>!['FRA','DEU'].includes(String(f.properties.countryId))));
  labels.updateWorld(world);expect(calls).toBe(3);expect(labels.stats()).toMatchObject({labelLayoutRequests:3,labelFailures:[]});labels.dispose();
 }finally{fetcher.mockRestore();}
});
