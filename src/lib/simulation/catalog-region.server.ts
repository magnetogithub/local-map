import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createCatalogRegionIndex,type RegionRecord} from './catalog-region';
import {createWorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import {createCatalogBorderLookup} from './catalog-border-lookup';
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
export function prepareCatalogRegionIndex(root=process.cwd()){
  const read=(p:string)=>fs.readFileSync(path.join(root,p));
  const freeze=JSON.parse(read('data/catalogs/prompt14/frozen-catalog-ref.json').toString());
  const bytes=read(freeze.artifactIndex.path);if(sha(bytes)!==freeze.artifactIndex.sha256||freeze.status!=='pass')throw Error('UNAPPROVED_REGION_CATALOG');
  const artifactIndex=JSON.parse(bytes.toString());
  const relative=`build-only/${freeze.ref.catalogVersion}/catalog.json`,identity=artifactIndex.artifacts.find((a:{path:string})=>a.path===relative);
  const catalogBytes=read(path.join(path.dirname(freeze.artifactIndex.path),relative));
  if(!identity||sha(catalogBytes)!==identity.sha256)throw Error('REGION_CATALOG_IDENTITY');
  const catalog=JSON.parse(catalogBytes.toString()) as {entries:{id:string;sourceCountryId:string;provenanceIds:string[]}[];provenanceById:Record<string,{sourceId:string;sourceVersion:string;sourceFeatureId:string}>};
  const lock=JSON.parse(read('data/source-locks/prompt14-derived-game-input-lock.json').toString());
  if(sha(read('data/source-locks/prompt14-derived-game-input-lock.json'))!==freeze.sourceLockSha256)throw Error('REGION_SOURCE_LOCK');
  const sourcePath='data/raw/ne_10m_admin_1_states_provinces.geojson';
  const source=read(sourcePath),sourceIdentity=lock.lineageInputs.find((a:{repositoryPath:string})=>a.repositoryPath===sourcePath);
  if(!sourceIdentity||sha(source)!==sourceIdentity.sha256)throw Error('REGION_SOURCE_IDENTITY');
  const raw=JSON.parse(source.toString()) as {features:{properties:Record<string,string|number|null>}[]};
  const names=new Map(raw.features.map(f=>[String(f.properties.ne_id),f.properties]));
  const groups=new Map<string,{countryId:string;featureId:string;ids:Set<string>;provenance:Set<string>}>();
  for(const e of catalog.entries)for(const id of e.provenanceIds){const p=catalog.provenanceById[id];
    if(p.sourceId!=='natural-earth-admin1-states-provinces-10m')continue;
    if(!names.has(p.sourceFeatureId))throw Error('REGION_PROVENANCE_NAME_MISSING');
    const key=`${e.sourceCountryId}:${p.sourceFeatureId}`,g=groups.get(key)??{countryId:e.sourceCountryId,featureId:p.sourceFeatureId,ids:new Set<string>(),provenance:new Set<string>()};
    g.ids.add(e.id);g.provenance.add(id);groups.set(key,g);
  }
  const records:RegionRecord[]=[...groups.values()].map(g=>{const p=names.get(g.featureId)!;return Object.freeze({ref:{catalogId:freeze.ref.catalogVersion,sourceVersion:freeze.ref.geometryRoot,subdivisionId:`region:ne-admin1:${g.countryId}:${g.featureId}`},parentCountryId:g.countryId,
    nameEn:String(p.name_en||p.name||g.featureId),nameKo:String(p.name_ko||p.name||g.featureId),aliases:[p.name,p.name_local,p.postal,p.gns_name].filter((v):v is string=>typeof v==='string'&&!!v),territoryIds:[...g.ids].sort(),provenanceIds:[...g.provenance].sort()});}).sort((a,b)=>a.ref.subdivisionId.localeCompare(b.ref.subdivisionId,'en'));
  const topologyPath=`build-only/${freeze.ref.catalogVersion}/topology.json`;
  const topologyIdentity=artifactIndex.artifacts.find((a:{path:string})=>a.path===topologyPath);
  const topologyBytes=read(path.join(path.dirname(freeze.artifactIndex.path),topologyPath));
  if(!topologyIdentity||sha(topologyBytes)!==topologyIdentity.sha256)throw Error('BORDER_TOPOLOGY_IDENTITY');
  const topology=JSON.parse(topologyBytes.toString()) as {edges:{leftTerritoryId:string;rightTerritoryId:string|null}[]};
  return Object.freeze({...createCatalogRegionIndex(records,catalog.entries.map(e=>e.id),createWorldGeometryCatalogRef(freeze.ref)),
    borderTerritories:createCatalogBorderLookup(catalog.entries,topology.edges)});
}
let approved:ReturnType<typeof prepareCatalogRegionIndex>|undefined;
export const loadCatalogRegionIndex=()=>approved??=prepareCatalogRegionIndex();
