import type {TerritoryId} from '../world/territory-id';
import {createWorldGeometryCatalogRef,readCatalogTerritoryId,assertWorldGeometryCatalogRefMatches,type WorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import {assertWorldV3Keys,readWorldV3CountryId,readWorldV3Record} from '../world/world-v3-validation';
export type CatalogArtifactIdentity=Readonly<{path:string;sha256:string;byteLength:number}>;
export type CatalogTerritoryMetadata=Readonly<{id:TerritoryId;sourceCountryId:string;bbox:readonly[number,number,number,number];area:number;anchor:readonly[number,number]}>;
export type CatalogCountryMetadata=Readonly<{countryId:string;iso3:string;flagCode:string;region:string;label:Readonly<{territoryId:TerritoryId;anchor:readonly[number,number]}>;
  capital:Readonly<{territoryId:TerritoryId;coordinates:readonly[number,number];countryId:string;nameKo:string;nameEn:string;capitalType:string;labelRank:number}>|null}>;
export type CatalogConsumerMetadata=Readonly<{schemaVersion:'catalog-consumer-metadata-v1';catalogRef:WorldGeometryCatalogRef;territories:readonly CatalogTerritoryMetadata[];countries:readonly CatalogCountryMetadata[]}>;
export type CatalogConsumerBootstrap=Readonly<{schemaVersion:'catalog-consumer-bootstrap-v1';catalogRef:WorldGeometryCatalogRef;manifest:CatalogArtifactIdentity;tileIndex:CatalogArtifactIdentity;metadata:CatalogArtifactIdentity}>;
const record=readWorldV3Record;
export function catalogArtifactIdentity(value:unknown,ref:WorldGeometryCatalogRef):CatalogArtifactIdentity{
  const a=record(value,'catalog artifact');assertWorldV3Keys(a,['path','sha256','byteLength'],'catalog artifact');
  const prefix=`/data/territory-catalog/${ref.catalogVersion}/`;
  if(typeof a.path!=='string'||!a.path.startsWith(prefix)||a.path.slice(prefix.length).split('/').some(p=>!p||!/^[-A-Za-z0-9._]+$/.test(p)||p==='.'||p==='..')||!/^([a-f0-9]{64})$/.test(String(a.sha256))||!Number.isSafeInteger(a.byteLength)||Number(a.byteLength)<0)throw new Error('Invalid versioned catalog artifact identity');
  return Object.freeze({path:a.path,sha256:a.sha256 as string,byteLength:a.byteLength as number});
}
export function readCatalogConsumerBootstrap(value:unknown,expected:WorldGeometryCatalogRef):CatalogConsumerBootstrap{
  const b=record(value,'catalog bootstrap');assertWorldV3Keys(b,['schemaVersion','catalogRef','manifest','tileIndex','metadata'],'catalog bootstrap');
  if(b.schemaVersion!=='catalog-consumer-bootstrap-v1')throw new Error('Invalid catalog bootstrap schema');
  const ref=createWorldGeometryCatalogRef(b.catalogRef);assertWorldGeometryCatalogRefMatches(ref,expected);
  const manifest=catalogArtifactIdentity(b.manifest,ref),tileIndex=catalogArtifactIdentity(b.tileIndex,ref),metadata=catalogArtifactIdentity(b.metadata,ref);
  if(manifest.path!==ref.manifestPath||!tileIndex.path.endsWith('/tile-index.json')||!metadata.path.endsWith('/consumer-metadata.json'))throw new Error('Unexpected catalog browser artifact');
  return Object.freeze({schemaVersion:'catalog-consumer-bootstrap-v1',catalogRef:ref,manifest,tileIndex,metadata});
}
const coordinates=(value:unknown,size:number)=>{if(!Array.isArray(value)||value.length!==size||!value.every(n=>typeof n==='number'&&Number.isFinite(n)))throw new Error('Invalid catalog coordinates');return Object.freeze([...value]);};
export function readCatalogConsumerMetadata(value:unknown,expected:WorldGeometryCatalogRef):CatalogConsumerMetadata{
  const m=record(value,'catalog metadata');assertWorldV3Keys(m,['schemaVersion','catalogRef','territories','countries'],'catalog metadata');
  if(m.schemaVersion!=='catalog-consumer-metadata-v1'||!Array.isArray(m.territories)||!Array.isArray(m.countries))throw new Error('Invalid catalog metadata schema');
  const ref=createWorldGeometryCatalogRef(m.catalogRef);assertWorldGeometryCatalogRefMatches(ref,expected);
  const territories=m.territories.map(value=>{const t=record(value,'territory metadata');assertWorldV3Keys(t,['id','sourceCountryId','bbox','area','anchor'],'territory metadata');
    if(typeof t.area!=='number'||!(t.area>0)||!Number.isFinite(t.area))throw new Error('Invalid territory area');
    const bbox=coordinates(t.bbox,4) as readonly[number,number,number,number],anchor=coordinates(t.anchor,2) as readonly[number,number];
    if(bbox[0]>bbox[2]||bbox[1]>bbox[3]||bbox[0]<-180||bbox[2]>180||bbox[1]<-90||bbox[3]>90||anchor[0]<bbox[0]||anchor[0]>bbox[2]||anchor[1]<bbox[1]||anchor[1]>bbox[3])throw new Error('Catalog anchor/bbox mismatch');
    return Object.freeze({id:readCatalogTerritoryId(t.id),sourceCountryId:readWorldV3CountryId(t.sourceCountryId,'source country'),bbox,area:t.area,anchor});});
  if(territories.length>6000||territories.some((t,i)=>i>0&&territories[i-1].id>=t.id))throw new Error('Invalid catalog territory order/cap');
  const byId=new Map(territories.map(t=>[t.id,t]));
  const countries=m.countries.map(value=>{const c=record(value,'country metadata');assertWorldV3Keys(c,['countryId','iso3','flagCode','region','label','capital'],'country metadata');const countryId=readWorldV3CountryId(c.countryId,'country metadata');
    if(!['iso3','flagCode','region'].every(k=>typeof c[k]==='string'))throw new Error('Invalid country presentation');
    const label=record(c.label,'label seed');assertWorldV3Keys(label,['territoryId','anchor'],'label seed');const labelId=readCatalogTerritoryId(label.territoryId);
    if(byId.get(labelId)?.sourceCountryId!==countryId)throw new Error('Label seed source mismatch');
    let capital:CatalogCountryMetadata['capital']=null;
    if(c.capital!==null){const p=record(c.capital,'capital seed');assertWorldV3Keys(p,['territoryId','coordinates','countryId','nameKo','nameEn','capitalType','labelRank'],'capital seed');
      const id=readCatalogTerritoryId(p.territoryId);if(byId.get(id)?.sourceCountryId!==countryId||p.countryId!==countryId||!['nameKo','nameEn','capitalType'].every(k=>typeof p[k]==='string')||!Number.isFinite(p.labelRank))throw new Error('Invalid capital seed');
      capital=Object.freeze({...p,territoryId:id,coordinates:coordinates(p.coordinates,2)}) as CatalogCountryMetadata['capital'];}
    return Object.freeze({countryId,iso3:c.iso3 as string,flagCode:c.flagCode as string,region:c.region as string,label:Object.freeze({territoryId:labelId,anchor:coordinates(label.anchor,2) as readonly[number,number]}),capital});});
  if(countries.some((c,i)=>i>0&&countries[i-1].countryId>=c.countryId)||new Set(territories.map(t=>t.sourceCountryId)).size!==countries.length||territories.some(t=>!countries.some(c=>c.countryId===t.sourceCountryId)))throw new Error('Catalog country coverage/order mismatch');
  return Object.freeze({schemaVersion:'catalog-consumer-metadata-v1',catalogRef:ref,territories:Object.freeze(territories),countries:Object.freeze(countries)});
}
