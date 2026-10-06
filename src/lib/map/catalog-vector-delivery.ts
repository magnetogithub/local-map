import type {AddProtocolAction,VectorSourceSpecification} from 'maplibre-gl';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {assertWorldGeometryCatalogRefMatches,createWorldGeometryCatalogRef,type WorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import {catalogArtifactIdentity,readCatalogConsumerBootstrap,readCatalogConsumerMetadata,type CatalogArtifactIdentity,type CatalogConsumerBootstrap,type CatalogConsumerMetadata} from './catalog-consumer-contract';
export type CatalogFetch=(path:string,init?:RequestInit)=>Promise<Response>;
const decoder=new TextDecoder();
export async function verifyCatalogResponse(response:Response,identity:CatalogArtifactIdentity,signal?:AbortSignal){
  if(!response.ok)throw new Error(`Catalog asset request failed: ${response.status}`);
  if(response.redirected)throw new Error('Catalog asset redirect rejected');
  const bytes=await response.arrayBuffer();if(bytes.byteLength!==identity.byteLength)throw new Error('Catalog asset byte length mismatch');
  signal?.throwIfAborted();const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(n=>n.toString(16).padStart(2,'0')).join('');
  if(hash!==identity.sha256)throw new Error('Catalog asset SHA-256 mismatch');return bytes;
}
export type CatalogEdgeIncidence=Readonly<{id:string;left:string|null;right:string|null;boundaryClass:string}>;
export type CatalogVectorDelivery=Readonly<{bootstrap:CatalogConsumerBootstrap;metadata:CatalogConsumerMetadata;source:VectorSourceSpecification;protocol:string;
  observeEdges:(listener:(edges:readonly CatalogEdgeIncidence[])=>void)=>()=>void;
  loadTile:(path:string,signal?:AbortSignal)=>Promise<ArrayBuffer>;counters:()=>Readonly<{verifiedRequests:number;cacheHits:number;cachedTiles:number;cachedBytes:number}>}>;
export async function loadCatalogVectorDelivery(value:unknown,expected:WorldGeometryCatalogRef,fetcher:CatalogFetch=fetch,signal?:AbortSignal):Promise<CatalogVectorDelivery>{
  const bootstrap=readCatalogConsumerBootstrap(value,expected);let verifiedRequests=0,cacheHits=0;
  const read=async(a:CatalogArtifactIdentity,s=signal)=>{const bytes=await verifyCatalogResponse(await fetcher(a.path,{signal:s,cache:'force-cache',redirect:'error'}),a,s);verifiedRequests++;return bytes;};
  const manifest=JSON.parse(decoder.decode(await read(bootstrap.manifest))),tileIndex=JSON.parse(decoder.decode(await read(bootstrap.tileIndex)));
  assertWorldGeometryCatalogRefMatches(createWorldGeometryCatalogRef(manifest.ref),expected);
  const base=`/data/territory-catalog/${expected.catalogVersion}/`,template=`${base}tiles/{z}/{x}/{y}.pbf`;
  if(manifest.minZoom!==0||manifest.maxZoom!==6||manifest.schemaVersion!=='world-geometry-catalog-v1'||manifest.sourceId!=='world-territory-catalog'||manifest.tileTemplate!==template||manifest.promoteId?.territories!=='territoryId'||manifest.promoteId?.edges!=='edgeId'||tileIndex.renderArtifactRoot!==expected.renderArtifactRoot||tileIndex.artifacts.length!==5461)throw new Error('Invalid approved vector manifest/tile index');
  const tiles=new Map<string,CatalogArtifactIdentity>();let i=0;
  for(let z=0;z<=6;z++)for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
    const a=catalogArtifactIdentity({...tileIndex.artifacts[i],path:tileIndex.artifacts[i++].path.replace(/^public/,'')},expected);
    if(a.path!==`${base}tiles/${z}/${x}/${y}.pbf`||tiles.has(a.path))throw new Error('Unexpected/duplicate catalog tile');tiles.set(a.path,a);
  }
  const metadata=readCatalogConsumerMetadata(JSON.parse(decoder.decode(await read(bootstrap.metadata))),expected);
  const cache=new Map<string,ArrayBuffer>();let cachedBytes=0;
  const edges=new Map<string,CatalogEdgeIncidence>(),listeners=new Set<(edges:readonly CatalogEdgeIncidence[])=>void>(),territoryIds=new Set(metadata.territories.map(t=>t.id));
  const indexEdges=(bytes:ArrayBuffer)=>{
    const tile=new VectorTile(new PbfReader(new Uint8Array(bytes)) as unknown as ConstructorParameters<typeof VectorTile>[0]),layer=tile.layers.edges,newEdges:CatalogEdgeIncidence[]=[];
    for(let i=0;i<(layer?.length??0);i++){const p=layer.feature(i).properties,id=String(p.edgeId),left=String(p.leftTerritoryId)||null,right=String(p.rightTerritoryId)||null,boundaryClass=String(p.boundaryClass);
      if(!/^edge:catalog:[a-f0-9]{64}$/.test(id)||(!left&&!right)||(left&&!territoryIds.has(left as never))||(right&&!territoryIds.has(right as never))||!['country','administrative','coast'].includes(boundaryClass))throw Error('Invalid approved edge incidence');
      const old=edges.get(id);if(old){if(old.left!==left||old.right!==right||old.boundaryClass!==boundaryClass)throw Error('Inconsistent approved edge incidence');continue;}
      if(edges.size>=15955)throw Error('Catalog edge cap exceeded');const edge=Object.freeze({id,left,right,boundaryClass});edges.set(id,edge);newEdges.push(edge);
    }
    if(newEdges.length)for(const listener of listeners)listener(newEdges);
  };
  const loadTile=async(path:string,s?:AbortSignal)=>{
    s?.throwIfAborted();const a=tiles.get(path);if(!a)throw new Error('Unregistered catalog request');
    const old=cache.get(path);if(old){cache.delete(path);cache.set(path,old);cacheHits++;return old.slice(0);}
    const bytes=await read(a,s);
    if(listeners.size)indexEdges(bytes);
    if(bytes.byteLength<=8*1024*1024){
      const replaced=cache.get(path);if(replaced){cachedBytes-=replaced.byteLength;cache.delete(path);}
      cache.set(path,bytes);cachedBytes+=bytes.byteLength;
      while(cache.size>256||cachedBytes>8*1024*1024){const first=cache.keys().next().value!;cachedBytes-=cache.get(first)!.byteLength;cache.delete(first);}
    }
    return bytes.slice(0);
  };
  const protocol=`pax-catalog-${expected.catalogVersion.replace(/^catalog-v1-/,'')}`;
  const source:VectorSourceSpecification={type:'vector',tiles:[`${protocol}://${template}`],minzoom:0,maxzoom:6,promoteId:{territories:'territoryId',edges:'edgeId'},attribution:manifest.attribution};
  const observeEdges=(listener:(edges:readonly CatalogEdgeIncidence[])=>void)=>{listeners.add(listener);listener([...edges.values()]);for(const bytes of cache.values())indexEdges(bytes);return()=>{listeners.delete(listener);};};
  return Object.freeze({bootstrap,metadata,source,protocol,loadTile,observeEdges,counters:()=>({verifiedRequests,cacheHits,cachedTiles:cache.size,cachedBytes})});
}
export async function fetchCatalogVectorDelivery(expected:WorldGeometryCatalogRef,fetcher:CatalogFetch=fetch,signal?:AbortSignal){
  const response=await fetcher('/api/world/catalog',{signal,cache:'no-store'});if(!response.ok)throw new Error('Catalog server readiness failed');
  return loadCatalogVectorDelivery(await response.json(),expected,fetcher,signal);
}
type CatalogProtocolApi={addProtocol:(name:string,handler:AddProtocolAction)=>void;removeProtocol:(name:string)=>void};
const protocolRegistrations=new WeakMap<CatalogProtocolApi,Map<string,{users:number;manifestHash:string;tileIndexHash:string;deliveries:Map<CatalogVectorDelivery,number>}>>();
export function registerCatalogTileProtocol(api:CatalogProtocolApi,delivery:CatalogVectorDelivery){
  let registrations=protocolRegistrations.get(api);if(!registrations){registrations=new Map();protocolRegistrations.set(api,registrations);}
  let entry=registrations.get(delivery.protocol);
  if(entry){
    if(entry.manifestHash!==delivery.bootstrap.manifest.sha256||entry.tileIndexHash!==delivery.bootstrap.tileIndex.sha256)throw new Error('Catalog protocol identity conflict');entry.users++;entry.deliveries.set(delivery,(entry.deliveries.get(delivery)??0)+1);
  }else{
    api.addProtocol(delivery.protocol,async(params,abort)=>{
      const prefix=`${delivery.protocol}://`;if(!params.url.startsWith(prefix))throw new Error('Unexpected catalog protocol request');
      // Each active consumer indexes verified edges in its own immutable delivery.
      const values=await Promise.all([...entry!.deliveries.keys()].map(d=>d.loadTile(params.url.slice(prefix.length),abort.signal)));
      return {data:values[0]};
    });
    entry={users:1,manifestHash:delivery.bootstrap.manifest.sha256,tileIndexHash:delivery.bootstrap.tileIndex.sha256,deliveries:new Map([[delivery,1]])};registrations.set(delivery.protocol,entry);
  }
  let removed=false;
  return ()=>{if(removed)return;removed=true;const count=entry.deliveries.get(delivery)!;if(count===1)entry.deliveries.delete(delivery);else entry.deliveries.set(delivery,count-1);if(--entry.users===0){api.removeProtocol(delivery.protocol);registrations.delete(delivery.protocol);}};
}
