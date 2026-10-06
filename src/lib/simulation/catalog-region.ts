import {z} from 'zod';
import {subdivisionReferenceSchema} from './world-effect';
import type {TurnResolutionV1} from './turn-resolution';
import {readCatalogTerritoryId,type WorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import type {CatalogBorderLookup} from './catalog-border-lookup';
export type RegionReference=z.infer<typeof subdivisionReferenceSchema>;
export type RegionRecord=Readonly<{ref:RegionReference;parentCountryId:string;nameKo:string;nameEn:string;aliases:readonly string[];territoryIds:readonly string[];provenanceIds:readonly string[]}>;
export const regionRecordSchema=z.strictObject({ref:subdivisionReferenceSchema,parentCountryId:z.string().min(1).max(160),nameKo:z.string().min(1).max(120),nameEn:z.string().min(1).max(120),aliases:z.array(z.string().max(120)).max(16),territoryIds:z.array(z.string().min(1)).min(1).max(512),provenanceIds:z.array(z.string().min(1)).min(1).max(512)});
export type CatalogRegionIndex=Readonly<{catalogRef?:WorldGeometryCatalogRef;borderTerritories?:CatalogBorderLookup;records:readonly RegionRecord[];hasTerritory:(id:string)=>boolean;resolve:(countryId:string,ref:RegionReference,operation:string,cap?:number)=>RegionRecord;search:(countryId:string,query:string)=>readonly RegionRecord[]}>;
export const regionKey=(r:RegionReference)=>`${r.catalogId}/${r.sourceVersion}/${r.subdivisionId}`;
export const regionOperation=z.enum(['occupy','liberate','transfer']);
export function createCatalogRegionIndex(records:readonly RegionRecord[],territoryIds:readonly string[],catalogRef?:WorldGeometryCatalogRef):CatalogRegionIndex{
  const ids=new Set(territoryIds),byKey=new Map(records.map(r=>[regionKey(r.ref),r]));
  if(byKey.size!==records.length)throw Error('DUPLICATE_REGION_REFERENCE');
  for(const r of records)if(!r.territoryIds.length||r.territoryIds.some(id=>!ids.has(id)))throw Error('INVALID_REGION_MEMBERSHIP');
  return Object.freeze({catalogRef,records,hasTerritory:(id:string)=>ids.has(id),resolve:(countryId:string,ref:RegionReference,operation:string,cap=512)=>{
    regionOperation.parse(operation);subdivisionReferenceSchema.parse(ref);
    if(!Number.isInteger(cap)||cap<1||cap>512)throw Error('REGION_REQUEST_CAP');
    const r=byKey.get(regionKey(ref));if(!r)throw Error('UNKNOWN_REGION_OR_CATALOG');
    if(r.parentCountryId!==countryId)throw Error('REGION_COUNTRY_SCOPE');
    if(r.territoryIds.length>cap)throw Error('REGION_REQUEST_CAP');return r;
  },search:(countryId:string,query:string)=>{
    if(!query.trim()||query.length>120)throw Error('INVALID_REGION_QUERY');
    const q=query.normalize('NFKC').toLocaleLowerCase('en-US');
    const matches=records.filter(r=>r.parentCountryId===countryId&&[r.nameEn,r.nameKo,...r.aliases].some(n=>n.normalize('NFKC').toLocaleLowerCase('en-US').includes(q)));
    return Object.freeze(matches.slice(0,8));
  }});
}
export function resolveCatalogRegionEffects(r:TurnResolutionV1,index?:CatalogRegionIndex):TurnResolutionV1{
  const requested=new Set<string>(),allIds=new Set<string>();
  return {...r,worldEffects:r.worldEffects.map(e=>{
    if(!('regionRefs'in e)||!e.regionRefs?.length){if(['territory.occupy','territory.liberate','territory.transferOwnership'].includes(e.type)&&'territoryIds'in e&&!e.territoryIds.length)throw Error('EMPTY_TERRITORY_REQUEST');return e;}
    if(!index)throw Error('REGION_RESOLVER_REQUIRED');
    const operation=e.type==='territory.transferOwnership'?'transfer':e.type.slice('territory.'.length);
    const resolved=[...new Set(e.regionRefs.flatMap(ref=>{requested.add(regionKey(ref.reference));return index.resolve(ref.countryId,ref.reference,operation).territoryIds;}))].sort().map(id=>readCatalogTerritoryId(id));
    for(const id of resolved)allIds.add(id);
    if(resolved.length>512||allIds.size>512||requested.size>8)throw Error('REGION_REQUEST_CAP');
    if(e.territoryIds.length&&JSON.stringify(e.territoryIds)!==JSON.stringify(resolved))throw Error('REGION_MEMBERSHIP_MISMATCH');
    return {...e,territoryIds:resolved};
  })};
}
