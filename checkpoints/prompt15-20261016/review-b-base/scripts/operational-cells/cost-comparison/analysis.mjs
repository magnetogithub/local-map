import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {packPartition,packPartitionShards} from '../compact-partition.mjs';
import {policy,policyIdentity} from '../policy-validation.mjs';

export const MODEL_VERSION='prompt15-normalized-representative-cost-v2';
export const CELLS_PER_SHARD=512;
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const jsonBytes=v=>Buffer.from(JSON.stringify(v));
export const polygons=g=>g.type==='Polygon'?[g.coordinates]:g.coordinates;
export const verticesOf=g=>polygons(g).flat(2);
const bounds=cells=>cells.reduce((b,c)=>verticesOf(c.geometry).reduce((a,p)=>[Math.min(a[0],p[0]),Math.min(a[1],p[1]),Math.max(a[2],p[0]),Math.max(a[3],p[1])],b),[Infinity,Infinity,-Infinity,-Infinity]);

/** Size-delimited, independently decodable experimental typed arrays. Values
 * are experiment ordinals/fingerprints, not issued production TerritoryIds. */
export function encodeArrays(arrays,metadata={}){
  const header=jsonBytes({version:1,metadata,layout:Object.entries(arrays).map(([name,a])=>({name,type:a.constructor.name,elements:a.length,byteLength:a.byteLength}))});
  const size=Buffer.alloc(4);size.writeUInt32LE(header.length);
  return Buffer.concat([size,header,...Object.values(arrays).map(a=>Buffer.from(a.buffer,a.byteOffset,a.byteLength))]);
}
export function decodeArrays(bytes){
  const b=Buffer.from(bytes);if(b.length<4)throw new Error('INVALID_COST_PAYLOAD');
  const end=4+b.readUInt32LE(0);if(end>b.length)throw new Error('INVALID_COST_PAYLOAD');
  let header;try{header=JSON.parse(b.subarray(4,end));}catch{throw new Error('INVALID_COST_PAYLOAD');}
  if(header.version!==1||!Array.isArray(header.layout))throw new Error('INVALID_COST_PAYLOAD');
  const types={Float64Array,Uint32Array,Int32Array,Uint8Array};const arrays={};let offset=end;
  for(const item of header.layout??[]){const Type=types[item.type];
    if(!Type||!Number.isSafeInteger(item.elements)||item.elements<0||item.byteLength!==item.elements*Type.BYTES_PER_ELEMENT||offset+item.byteLength>b.length||Object.hasOwn(arrays,item.name))throw new Error('INVALID_COST_PAYLOAD');
    const copy=Uint8Array.from(b.subarray(offset,offset+item.byteLength));arrays[item.name]=new Type(copy.buffer);offset+=item.byteLength;
  }
  if(offset!==b.length)throw new Error('INVALID_COST_PAYLOAD');
  return {arrays,metadata:header.metadata};
}

function validateRecord(record,fixture){
  const r=record?.result;if(!r?.cells?.length||!r.edges?.length||!fixture?.example?.id)throw new Error('MISSING_COST_INPUT');
  const ids=new Set(r.cells.map(c=>c.ordinal)),parents=new Map(r.parents.map(p=>[p.key,p]));
  if(ids.size!==r.cells.length||r.cells.some(c=>!Number.isSafeInteger(c.ordinal)||c.ordinal<0||!parents.has(c.parentKey))||
    r.edges.some(e=>!(e.lengthMetres>0)||!e.sides.length||e.sides.length>2||e.sides.some(s=>!ids.has(s.ordinal))))throw new Error('INVALID_COST_MEMBERSHIP');
  for(const c of r.cells){const p=parents.get(c.parentKey);if(c.sourceCountryId!==p.sourceCountryId||JSON.stringify(c.administrativeParent)!==JSON.stringify(p.administrativeParent)||JSON.stringify(c.previousGeometryParent)!==JSON.stringify(p.previousGeometryParent))throw new Error('INVALID_COST_MEMBERSHIP');}
}
const traceSummary=sample=>sample.trace??(sample.correspondence??[]).map(p=>({...p,fragments:p.fragments.map(f=>({index:f.index,areaM2:f.areaM2,geometrySha256:hash(jsonBytes(f.geometry))}))}));
function membershipOf(r){
  const membership={administrative:[],previous:[],country:[]};
  for(const [kind,field]of [['administrative','administrativeParent'],['previous','previousGeometryParent'],['country','sourceCountryId']]){
    const groups=new Map();for(const c of r.cells){const k=JSON.stringify(c[field]);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(c.ordinal);}
    membership[kind]=[...groups].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([parent,ordinals])=>({parent:JSON.parse(parent),ordinals:ordinals.sort((a,b)=>a-b)}));
  }
  return membership;
}
const viewBounds=(r,chunk)=>{const ids=new Set(chunk.arrays.cellOrdinals);return bounds(r.cells.filter(c=>ids.has(c.ordinal)));};

export function encodeCostPayloads(record,fixture){
  validateRecord(record,fixture);const r=record.result,packed=packPartition(r),shards=packPartitionShards(r,{cellsPerShard:CELLS_PER_SHARD});
  const a=packed.arrays,membership=membershipOf(r),catalogArrays=Object.fromEntries(Object.entries(a).filter(([k])=>!k.startsWith('edge')));
  // SHA256 experiment fingerprints measure the same 32-byte digest storage as
  // 15-15 IDs without forging a valid previous geometry parent or production ID.
  const fingerprints=Buffer.concat(r.cells.map(c=>Buffer.from(hash(jsonBytes({sourceCountryId:c.sourceCountryId,administrativeParent:c.administrativeParent,previousGeometryParent:c.previousGeometryParent,geometry:c.geometry,policyIdentity,generator:r.generator})),'hex')));
  catalogArrays.fingerprints=new Uint8Array(fingerprints);
  const topologyArrays=Object.fromEntries(Object.entries(a).filter(([k])=>k.startsWith('edge')));
  topologyArrays.boundaryFlags=new Uint8Array(r.edges.map(e=>(e.boundary?.country?1:0)|(e.boundary?.administrative?2:0)|(e.boundary?.previous?4:0)|(e.sides.length===1?8:0)));
  const membershipArrays={},membershipDictionaries={};
  for(const [kind,groups]of Object.entries(membership)){
    const offsets=[0],ordinals=[];for(const g of groups){ordinals.push(...g.ordinals);offsets.push(ordinals.length);}
    membershipArrays[kind+'Ordinals']=new Uint32Array(ordinals);membershipArrays[kind+'Offsets']=new Uint32Array(offsets);
    membershipDictionaries[kind]=groups.map(g=>g.parent);
  }
  const tileEntries=shards.chunks.map((chunk,i)=>({key:String(i),bytes:encodeArrays(chunk.arrays,JSON.parse(chunk.metadata)),bounds:viewBounds(r,chunk)}));
  const metadata={version:MODEL_VERSION,policyIdentity,generator:r.generator,projection:record.sample.projection,
    parents:r.parents,sourceTrace:traceSummary(record.sample),identityRecordTemplate:fixture.example,
    idIndex:r.cells.map(c=>c.ordinal),membershipDictionaries,
    tileIndex:tileEntries.map(t=>({key:t.key,sha256:hash(t.bytes),byteLength:t.bytes.length,bounds:t.bounds}))};
  // Cell parent indices use first-seen dictionary order, which need not equal
  // result.parents order. Keep that dictionary in the independently decodable
  // catalog header, rather than guessing from administrative sort order.
  const payloads={catalog:encodeArrays(catalogArrays,{parents:JSON.parse(packed.metadata).parents}),topology:encodeArrays(topologyArrays),membership:encodeArrays(membershipArrays),metadataIndex:jsonBytes(metadata)};
  return {payloads,tileEntries,membership,packed,metadata};
}

export function sourceShape(parents){
  let vertices=0,perimeterMetres=0,components=0;
  for(const p of parents)for(const poly of polygons(p.geometry)){components++;for(const ring of poly){vertices+=ring.length;for(let i=1;i<ring.length;i++)perimeterMetres+=Math.hypot(ring[i][0]-ring[i-1][0],ring[i][1]-ring[i-1][1]);}}
  return {vertices,perimeterKm:perimeterMetres/1000,components,parents:parents.length};
}

export function measureEncoding(record,fixture){
  const {payloads,tileEntries,membership,packed,metadata}=encodeCostPayloads(record,fixture),r=record.result;
  const parts=Object.fromEntries(Object.entries(payloads).map(([k,b])=>[k,{byteLength:b.length,gzipBytes:gzipSync(b,{level:6}).length,sha256:hash(b)}]));
  const tileSizes=tileEntries.map(t=>t.bytes.length),gzipSizes=tileEntries.map(t=>gzipSync(t.bytes,{level:6}).length);
  const totalBytes=Object.values(parts).reduce((n,p)=>n+p.byteLength,0)+tileSizes.reduce((n,b)=>n+b,0);
  const geometryBytes=r.parents.reduce((n,p)=>n+jsonBytes(p.geometry).length,0),parentBytes=jsonBytes(metadata.parents).length,
    idIndexBytes=jsonBytes(metadata.idIndex).length,traceBytes=jsonBytes(metadata.sourceTrace).length,tileIndexBytes=jsonBytes(metadata.tileIndex).length;
  return {parts,counts:{cells:r.cells.length,vertices:r.cells.reduce((n,c)=>n+verticesOf(c.geometry).length,0),uniqueVertices:packed.uniqueVertices,
    edges:r.edges.length,positiveSharedEdges:r.edges.filter(e=>e.sides.length===2&&e.lengthMetres>0).length,
    membershipEntries:Object.values(membership).flat().reduce((n,g)=>n+g.ordinals.length,0),tiles:tileEntries.length},
    render:{tileBytes:tileSizes.reduce((n,b)=>n+b,0),gzipBytes:gzipSizes.reduce((n,b)=>n+b,0),largestTileBytes:Math.max(...tileSizes),largestTileGzipBytes:Math.max(...gzipSizes),largestShardCells:Math.min(r.cells.length,CELLS_PER_SHARD)},
    identityOverhead:{idWidth:Buffer.byteLength(fixture.example.id),binaryDigestBytes:fingerprintsLength(r),identityWidthExpansionBytes:0,inlineIdentityRecordBytes:0,
      sharedIdentityTemplateBytes:jsonBytes(fixture.example).length,method:'32-byte fingerprint table already in catalog; one shared full provenance template and per-parent dictionaries already in metadata. No per-cell JSON expansion or invented production ID.'},
    metadataBreakdown:{geometryBytes,parentDictionaryBytes:parentBytes-geometryBytes,idIndexBytes,traceBytes,tileIndexBytes,
      headerBytes:parts.metadataIndex.byteLength-parentBytes-idIndexBytes-traceBytes-tileIndexBytes},
    headers:Object.fromEntries(['catalog','topology','membership'].map(k=>[k,payloads[k].readUInt32LE(0)+4])),
    shape:sourceShape(record.sample.parents),normalizedTypedArrayBytes:packed.decodedTypedArrayBytes+fingerprintsLength(r),totalBytes,conservativeTotalBytes:totalBytes};
}
const fingerprintsLength=r=>r.cells.length*32;

/** Current approved generation evidence, not a historical unit verdict. */
export function validateGenerationEvidence(record){
  const c=record?.cost,r=record?.result;
  if(!c||!r||!Number.isFinite(c.generationMs)||c.generationMs<=0||
    !Number.isFinite(c.observedHeapUsedBytes)||c.observedHeapUsedBytes<=0||
    !Number.isFinite(c.processPeakRssBytes)||c.processPeakRssBytes<c.observedHeapUsedBytes||
    c.cells!==r.cells.length||c.vertices!==r.cells.reduce((n,x)=>n+verticesOf(x.geometry).length,0)||
    !record.measurement?.physical?.completeParentCoverage||record.sample.fullParents)throw new Error('INVALID_GENERATION_EVIDENCE');
  return {generationMs:c.generationMs,observedHeapUsedBytes:c.observedHeapUsedBytes,processPeakRssBytes:c.processPeakRssBytes,
    resultSha256:hash(jsonBytes(r)),recordedEndpointPhase:'after generation, scope measurement and packing; not an isolated generation-heap endpoint'};
}

/** Raw source structural denominator, never a replacement country envelope. */
export function sourceAreas(raw){
  const countries={},countryShapes={};let vertices=0,components=0,features=0,perimeterKm=0;
  const ringArea=r=>{let sum=0;for(let i=1;i<r.length;i++){let d=(r[i][0]-r[i-1][0])*Math.PI/180;while(d>Math.PI)d-=2*Math.PI;while(d< -Math.PI)d+=2*Math.PI;sum+=d*(Math.sin(r[i][1]*Math.PI/180)+Math.sin(r[i-1][1]*Math.PI/180));}return Math.abs(sum)*6371.007180918**2/2;};
  const distance=(a,b)=>{const rad=Math.PI/180,dlat=(b[1]-a[1])*rad,dlon=(b[0]-a[0])*rad,h=Math.sin(dlat/2)**2+Math.cos(a[1]*rad)*Math.cos(b[1]*rad)*Math.sin(dlon/2)**2;return 2*6371.007180918*Math.asin(Math.sqrt(Math.min(1,h)));};
  for(const f of raw.features){if(!f.geometry)continue;const ps=polygons(f.geometry),area=ps.reduce((n,p)=>n+ringArea(p[0])-p.slice(1).reduce((s,h)=>s+ringArea(h),0),0);if(!(area>0))throw new Error('INVALID_SOURCE_AREA');
    const id=f.properties.adm0_a3;countries[id]=(countries[id]??0)+area;countryShapes[id]??={areaKm2:0,vertices:0,components:0,features:0,perimeterKm:0};const c=countryShapes[id];c.areaKm2+=area;c.features++;features++;
    for(const p of ps){components++;c.components++;for(const r of p){vertices+=r.length;c.vertices+=r.length;for(let i=1;i<r.length;i++){const d=distance(r[i-1],r[i]);perimeterKm+=d;c.perimeterKm+=d;}}}
  }
  return {method:'WGS84 authalic-sphere raw ADM1 area/perimeter, dateline-periodic; source structure model only, not coverage proof',countries,countryShapes,vertices,components,features,perimeterKm,
    worldKm2:Object.values(countries).reduce((a,b)=>a+b,0),largestCountryKm2:Math.max(...Object.values(countries))};
}

export function compareBudget(values){return Object.entries(values).map(([metric,value])=>{
  if(!Object.hasOwn(policy.budget,metric)||!Number.isFinite(value)||value<0)throw new Error('INVALID_BUDGET_MEASUREMENT: '+metric);
  return {metric,value,limit:policy.budget[metric],ratio:value/policy.budget[metric],status:value>policy.budget[metric]?'exceeds':'within-estimate'};
});}

/** A disclosed area + perimeter + source-complexity extrapolation. Unlike
 * extending tiny-island per-km2 cost to all inland, the whole raw source's
 * actual perimeter/components/vertices are included. Not a world build PASS. */
export function summarizeCosts(cases,areas){
  return ['grid','adaptive','partition'].map(candidate=>{
    const a=cases.filter(c=>c.candidate===candidate);if(a.length!==12||new Set(a.map(c=>c.sample)).size!==12)throw new Error('INCOMPLETE_REPRESENTATIVE_COSTS');
    const max=fn=>Math.max(...a.map(fn)),size=5;
    const boundaryCoefficient=max(c=>Math.max(0,c.encoding.counts.cells-c.areaLowerKm2/(size*size))/(c.encoding.shape.perimeterKm/size+c.encoding.shape.components));
    const predict=shape=>shape.areaKm2/(size*size)+boundaryCoefficient*(shape.perimeterKm/size+shape.components);
    const n=Math.ceil(predict({areaKm2:areas.worldKm2,perimeterKm:areas.perimeterKm,components:areas.components}));
    const country=Math.ceil(Math.max(...Object.values(areas.countryShapes).map(predict)));
    const unique=areas.vertices+Math.ceil(n*max(c=>Math.max(0,c.encoding.counts.uniqueVertices-c.encoding.shape.vertices)/c.encoding.counts.cells));
    const logicalVertices=2*areas.vertices+Math.ceil(n*max(c=>Math.max(0,c.encoding.counts.vertices-2*c.encoding.shape.vertices)/c.encoding.counts.cells));
    const edgeCount=areas.vertices+Math.ceil(n*max(c=>Math.max(0,c.encoding.counts.edges-c.encoding.shape.vertices)/c.encoding.counts.cells));
    const sharedEdges=Math.ceil(n*max(c=>c.encoding.counts.positiveSharedEdges/c.encoding.counts.cells));
    const globalShards=Math.ceil(n/CELLS_PER_SHARD),parentRecords=areas.features;
    const metadataGeometryBytes=areas.vertices*max(c=>c.encoding.metadataBreakdown.geometryBytes/c.encoding.shape.vertices);
    const metadataParents=parentRecords*max(c=>c.encoding.metadataBreakdown.parentDictionaryBytes/c.encoding.shape.parents);
    const metadataTrace=parentRecords*max(c=>c.encoding.metadataBreakdown.traceBytes/c.encoding.shape.parents);
    const metadataHeader=parentRecords*max(c=>c.encoding.metadataBreakdown.headerBytes/c.encoding.shape.parents);
    const tileIndex=globalShards*max(c=>c.encoding.metadataBreakdown.tileIndexBytes/c.encoding.counts.tiles);
    // Ordinal directory: reserve ten decimal digits + separator per world cell.
    const metadataIndexBytes=metadataGeometryBytes+metadataParents+metadataTrace+metadataHeader+tileIndex+n*11;
    const catalogBytes=unique*16+(logicalVertices+n)*4+n*(4+4+4+4+32)+globalShards*max(c=>c.encoding.headers.catalog);
    const topologyBytes=edgeCount*(8+8+8+1)+globalShards*max(c=>c.encoding.headers.topology);
    const membershipBytes=n*12+parentRecords*3*8+globalShards*max(c=>c.encoding.headers.membership);
    const largestTile=Math.max(...a.map(c=>c.encoding.render.largestTileBytes));
    const renderTileBytes=globalShards*largestTile;
    const timePerCell=max(c=>c.timings.generationMs/c.encoding.counts.cells);
    const encodingPerCell=max(c=>c.timings.encodingMs/c.encoding.counts.cells);
    const decodePerByte=max(c=>c.timings.initialDecodeMs/c.initialView.transferBytes);
    const sharedTemplateBytes=max(c=>c.encoding.identityOverhead.sharedIdentityTemplateBytes);
    const globalDirectoryBytes=sharedTemplateBytes+globalShards*max(c=>Math.max(0,c.initialView.directoryBytes-c.encoding.identityOverhead.sharedIdentityTemplateBytes)/c.encoding.counts.tiles);
    const largestCountryCells=country,serverWorkingBytes=globalDirectoryBytes*2+metadataParents+metadataHeader+max(c=>c.initialView.decodedBytes);
    const values={worldCells:n,countryCells:largestCountryCells,authoritativeVertices:unique,positiveSharedEdges:sharedEdges,membershipEntries:n*3,
      catalogBytes,topologyBytes,membershipBytes,metadataIndexBytes,renderTileBytes,tileCount:globalShards,largestTileBytes:largestTile,
      generationWallMs:n*(timePerCell+encodingPerCell),generationPeakHeapBytes:max(c=>c.memory.peakHeapUpperBoundBytes)+globalDirectoryBytes,
      serverInitialDecodeBytes:serverWorkingBytes,serverInitMs:decodePerByte*(globalDirectoryBytes+max(c=>c.initialView.transferBytes)),
      browserInitialTransferBytes:globalDirectoryBytes+max(c=>c.initialView.gzipBytes),
      browserInitialDecodeBytes:globalDirectoryBytes*2+max(c=>c.initialView.decodedBytes),
      browserPeakHeapBytes:globalDirectoryBytes*4+max(c=>c.initialView.decodedBytes*2+c.initialView.stagingBytes),browserLoadMs:max(c=>c.timings.initialDecodeMs+c.timings.renderStagingMs)};
    const checks=compareBudget(values),near=Math.max(...a.flatMap(c=>c.nearCounts)),nearCapChecks=compareBudget({aggregateChangedCells:near});
    const upstreamFailures=a.filter(c=>!c.upstreamEligible).map(c=>({sample:c.sample,physical:c.upstreamPhysical,advanceFailures:c.advanceFailures}));
    const costEligible=checks.every(c=>c.status==='within-estimate')&&nearCapChecks.every(c=>c.status==='within-estimate');
    return {candidate,sampleCount:a.length,budgetChecks:checks,nearCapChecks,maxMeasuredNearCells:near,upstreamFailures,costEligible,
      decision:upstreamFailures.length||!costEligible?'ineligible: actual upstream failures or unchanged cost ceilings exceeded':'cost-feasible representative estimate; 15-17 must assess geometry and policy, world rollout unproven',
      countModel:{cellSizeKm:size,boundaryCoefficient,predictedCells:n,worldSourceAreaKm2:areas.worldKm2,worldSourcePerimeterKm:areas.perimeterKm,sourceVertices:areas.vertices,sourceComponents:areas.components,predictedLogicalVertices:logicalVertices,predictedEdges:edgeCount},
      projections:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{estimate:v}])),metadataComponents:{metadataGeometryBytes,metadataParents,metadataTrace,metadataHeader,tileIndex,ordinalDirectoryBytes:n*11},
      stressScenario:{worldCellsIfEntireWorldHadMostFragmentedSampleDensity:Math.ceil(areas.worldKm2*max(c=>c.encoding.counts.cells/c.areaLowerKm2)),
        method:'Historical homogeneous-per-area extrapolation retained as stress case, not the structural model; no sample is excluded.'},
      capCandidate:{aggregateChangedCells:policy.budget.aggregateChangedCells,changeAuthorized:false,
        costOnlyWorldCellCeiling:Math.floor(n*Math.min(...checks.filter(c=>['worldCells','authoritativeVertices','positiveSharedEdges','membershipEntries','catalogBytes','topologyBytes','membershipBytes','metadataIndexBytes','renderTileBytes','tileCount','generationWallMs'].includes(c.metric)).map(c=>c.limit/c.value))),
        recommendation:costEligible?'Normalized digest/provenance dictionaries and independently decodable shards fit this estimate; retain fixed caps pending selection and actual world measurements.':'Retain fixed caps; address reported excess before selection. No automatic cap increase.'}};
  });
}
