import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assertWorldGeometryCatalogRefMatches,createWorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import {readCatalogConsumerBootstrap,readCatalogConsumerMetadata,type CatalogArtifactIdentity,type CatalogConsumerBootstrap} from './catalog-consumer-contract';
type ReadBytes=(file:string)=>Buffer;
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
/** Readiness runs at server bootstrap; never reads or sends full geometry/topology. */
export function prepareCatalogConsumerBootstrap(root=process.cwd(),read:ReadBytes=file=>fs.readFileSync(file)):CatalogConsumerBootstrap{
  const json=(file:string)=>JSON.parse(read(path.join(root,file)).toString('utf8'));
  const freeze=json('data/catalogs/prompt14/frozen-catalog-ref.json'),ref=createWorldGeometryCatalogRef(freeze.ref),version=ref.catalogVersion;
  if(freeze.status!=='pass'||freeze.review!=='C')throw new Error('Catalog REVIEW C is not approved');
  const base=`data/catalogs/prompt14/${version}`,indexPath=`${base}/artifact-index.json`;
  const check=(file:string,a:{sha256:string;byteLength:number})=>{const b=read(path.join(root,file));if(b.length!==a.byteLength||hash(b)!==a.sha256)throw new Error(`Catalog asset identity mismatch: ${file}`);return b;};
  if(freeze.artifactIndex.path!==indexPath)throw new Error('Frozen catalog index path mismatch');
  const index=JSON.parse(check(indexPath,freeze.artifactIndex).toString('utf8'));
  assertWorldGeometryCatalogRefMatches(createWorldGeometryCatalogRef(index.ref),ref);
  const publicBase=`public/data/territory-catalog/${version}/`;
  const find=(file:string)=>{const records=index.artifacts.filter((a:{path:string})=>a.path===file);if(records.length!==1)throw new Error('Missing/duplicate registered catalog artifact');return records[0];};
  const manifestArtifact=find(`${publicBase}manifest.json`),tileIndexArtifact=find(`${publicBase}tile-index.json`);
  const manifest=JSON.parse(check(manifestArtifact.path,manifestArtifact).toString('utf8')),tiles=JSON.parse(check(tileIndexArtifact.path,tileIndexArtifact).toString('utf8'));
  assertWorldGeometryCatalogRefMatches(createWorldGeometryCatalogRef(manifest.ref),ref);
  if(manifest.schemaVersion!=='world-geometry-catalog-v1'||manifest.minZoom!==0||manifest.maxZoom!==6||manifest.sourceId!=='world-territory-catalog'||manifest.tileTemplate!==`/data/territory-catalog/${version}/tiles/{z}/{x}/{y}.pbf`||manifest.promoteId.territories!=='territoryId'||manifest.promoteId.edges!=='edgeId'||tiles.renderArtifactRoot!==ref.renderArtifactRoot)throw new Error('Unsupported catalog delivery manifest');
  const registered=index.artifacts.filter((a:{path:string})=>a.path.endsWith('.pbf'));
  if(JSON.stringify(tiles.artifacts)!==JSON.stringify(registered)||registered.length!==5461)throw new Error('Incomplete/unregistered tile index');
  let i=0;for(let z=0;z<=6;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
    const a=registered[i++],expected=`${publicBase}tiles/${z}/${x}/${y}.pbf`;
    if(a.path!==expected)throw new Error('Unexpected tile identity/path');check(a.path,a);
  }
  const approval=json(`data/catalog-consumers/prompt14/${version}/consumer-approval.json`);
  if(approval.schemaVersion!=='catalog-consumer-approval-v1'||approval.frozenArtifactIndexSha256!==freeze.artifactIndex.sha256)throw new Error('Consumer approval is not bound to the frozen catalog');
  assertWorldGeometryCatalogRefMatches(createWorldGeometryCatalogRef(approval.catalogRef),ref);
  const publicIdentity=(a:CatalogArtifactIdentity)=>({...a,path:a.path.replace(/^public/,'')});
  const bootstrap=readCatalogConsumerBootstrap({schemaVersion:'catalog-consumer-bootstrap-v1',catalogRef:ref,manifest:publicIdentity(manifestArtifact),tileIndex:publicIdentity(tileIndexArtifact),metadata:approval.metadata},ref);
  for(const field of ['path','sha256','byteLength'] as const)if(approval.manifest[field]!==bootstrap.manifest[field]||approval.tileIndex[field]!==bootstrap.tileIndex[field])throw new Error('Consumer manifest approval differs from registered bytes');
  const metadata=readCatalogConsumerMetadata(JSON.parse(check(`public${bootstrap.metadata.path}`,bootstrap.metadata).toString('utf8')),ref);
  const catalogArtifact=find(`build-only/${version}/catalog.json`),catalog=JSON.parse(check(`${base}/${catalogArtifact.path}`,catalogArtifact).toString('utf8'));
  if(catalog.entries.length!==metadata.territories.length||manifest.territoryCount!==metadata.territories.length)throw new Error('Catalog consumer coverage mismatch');
  metadata.territories.forEach((t,i)=>{const e=catalog.entries[i];if(e.id!==t.id||e.sourceCountryId!==t.sourceCountryId||e.area!==t.area||JSON.stringify(e.bbox)!==JSON.stringify(t.bbox))throw new Error('Consumer metadata differs from frozen catalog');});
  return bootstrap;
}
let approved:CatalogConsumerBootstrap|undefined;
export function loadCatalogConsumerBootstrap(){return approved??=(prepareCatalogConsumerBootstrap());}
