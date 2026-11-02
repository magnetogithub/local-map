import {createCatalogRegionIndex,regionRecordSchema,regionKey,type RegionRecord} from '../catalog-region';
import type {WorldStateV3} from '../../world/world-state-v3';
import type {SubdivisionCatalog,SubdivisionCatalogSummary} from '../subdivision-catalog';
import type {TurnResolutionV1} from '../turn-resolution';
export async function readCatalogRegions(world:WorldStateV3,countryId:string,signal?:AbortSignal):Promise<SubdivisionCatalog>{
  const response=await fetch('/api/world/regions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({catalogRef:world.catalogRef,countryId,operation:'occupy',limit:128}),signal});
  const result=await response.json();if(!response.ok||!result.ok)throw Error('REGION_CATALOG_UNAVAILABLE');
  const summaries=result.regions as SubdivisionCatalogSummary[];
  return {listCountry:id=>summaries.filter(r=>r.parentCountryId===id),inspect:ref=>summaries.find(r=>r.ref.subdivisionId===ref.subdivisionId&&r.ref.catalogId===ref.catalogId&&r.ref.sourceVersion===ref.sourceVersion)??null,materialize:()=>null};
}
export async function readResolutionRegionIndex(world:WorldStateV3,resolution:TurnResolutionV1,signal?:AbortSignal){
  const records:RegionRecord[]=[],seen=new Set<string>();
  for(const e of resolution.worldEffects)if('regionRefs'in e&&e.regionRefs)for(const r of e.regionRefs){
    const key=JSON.stringify(r);if(seen.has(key))continue;seen.add(key);if(seen.size>8)throw Error('REGION_REQUEST_CAP');
    if(r.reference.catalogId!==world.catalogRef.catalogVersion||r.reference.sourceVersion!==world.catalogRef.geometryRoot)throw Error('REGION_CATALOG_MISMATCH');
    const response=await fetch('/api/world/regions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({catalogRef:world.catalogRef,countryId:r.countryId,reference:r.reference,operation:e.type==='territory.transferOwnership'?'transfer':e.type.slice('territory.'.length)}),signal});
    const result=await response.json();if(!response.ok||!result.ok)throw Error(result.code??'REGION_LOOKUP_FAILED');
    const record=regionRecordSchema.parse(result.region);
    if(regionKey(record.ref)!==regionKey(r.reference)||record.parentCountryId!==r.countryId||record.territoryIds.some(id=>!world.territoriesById[id])||new Set(record.territoryIds).size!==record.territoryIds.length)throw Error('INVALID_REGION_RECEIPT');
    records.push(record);
  }
  return createCatalogRegionIndex(records,world.territoryOrder,world.catalogRef);
}
