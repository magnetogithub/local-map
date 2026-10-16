import {polygons} from './partition-prototype.mjs';

/** Offline normalized codec experiment. Shared vertices, offsets and parent
 * dictionaries avoid repeated per-cell JSON provenance and decoded objects.
 * No runtime asset publication or browser delivery/migration is installed. */
export function packPartition(result) {
  const vertices=[],vertexMap=new Map(),indices=[],ringOffsets=[0],cellOffsets=[0],parents=[],parentMap=new Map(),cellParents=[];
  const vertex=p=>{const key=JSON.stringify(p);let i=vertexMap.get(key);if(i===undefined){i=vertices.length/2;vertexMap.set(key,i);vertices.push(...p);}return i;};
  for(const c of result.cells) {
    let parent=parentMap.get(c.parentKey);
    if(parent===undefined){parent=parents.length;parentMap.set(c.parentKey,parent);parents.push({key:c.parentKey,sourceCountryId:c.sourceCountryId,
      administrativeParent:c.administrativeParent,previousGeometryParent:c.previousGeometryParent});}
    cellParents.push(parent);
    // Component/ring start offsets explicitly retain multi-polygons and holes.
    for(const poly of polygons(c.geometry)) {
      for(let r=0;r<poly.length;r++) {
        indices.push(r===0?0xffffffff:0xfffffffe,...poly[r].map(vertex));
        ringOffsets.push(indices.length);
      }
    }
    cellOffsets.push(ringOffsets.length-1);
  }
  const edgeVertices=[],edgeSides=[],edgeLengths=[];
  for(const e of result.edges){edgeVertices.push(...e.coordinates.map(vertex));edgeSides.push(e.sides[0].ordinal,e.sides[1]?.ordinal??-1);edgeLengths.push(e.lengthMetres);}
  const arrays={vertices:new Float64Array(vertices),ringVertices:new Uint32Array(indices),ringOffsets:new Uint32Array(ringOffsets),cellOrdinals:new Uint32Array(result.cells.map(c=>c.ordinal)),
    cellOffsets:new Uint32Array(cellOffsets),cellParents:new Uint32Array(cellParents),edgeVertices:new Uint32Array(edgeVertices),edgeSides:new Int32Array(edgeSides),edgeLengths:new Float64Array(edgeLengths)};
  const layout=Object.fromEntries(Object.entries(arrays).map(([name,a])=>[name,{type:a.constructor.name,byteLength:a.byteLength,elements:a.length}]));
  const metadata=Buffer.from(JSON.stringify({version:1,parents,layout,policyIdentity:result.policyIdentity,generator:result.generator,numericalModel:result.numericalModel}));
  const buffers=Object.values(arrays).map(a=>Buffer.from(a.buffer,a.byteOffset,a.byteLength));
  return {version:1,arrays,metadata,byteLength:buffers.reduce((s,b)=>s+b.length,metadata.length),
    decodedTypedArrayBytes:buffers.reduce((s,b)=>s+b.length,0),uniqueVertices:vertices.length/2,
    membershipEntries:cellParents.length,provenanceDictionaryEntries:parents.length,
    layout};
}
export function unpackPartition(packed) {
  const a=packed.arrays,metadata=JSON.parse(packed.metadata.toString()),cells=[];
  const position=i=>[a.vertices[i*2],a.vertices[i*2+1]];
  for(let i=0;i<a.cellParents.length;i++) {
    const components=[];
    for(let r=a.cellOffsets[i];r<a.cellOffsets[i+1];r++) {
      const start=a.ringOffsets[r],end=a.ringOffsets[r+1],tag=a.ringVertices[start];
      if(tag===0xffffffff)components.push([]);else if(tag!==0xfffffffe||!components.length)throw new Error('INVALID_COMPACT_RING');
      components.at(-1).push(Array.from(a.ringVertices.subarray(start+1,end),position));
    }
    const parent=metadata.parents[a.cellParents[i]];
    cells.push({ordinal:a.cellOrdinals[i],parentKey:parent.key,sourceCountryId:parent.sourceCountryId,administrativeParent:parent.administrativeParent,
      previousGeometryParent:parent.previousGeometryParent,geometry:{type:'MultiPolygon',coordinates:components}});
  }
  return cells;
}

/** Exact independently decodable shards for cost/decode/delivery experiments.
 * Geometry remains in its complete parent; sharding changes transport only and
 * never splits a logical selection, changes commit caps, or drops adjacency. */
export function packPartitionShards(result,{cellsPerShard=512}={}) {
  if(!Number.isInteger(cellsPerShard)||cellsPerShard<1||cellsPerShard>4096)throw new Error('INVALID_SHARD_SIZE');
  const chunks=[];
  for(let start=0;start<result.cells.length;start+=cellsPerShard) {
    const cells=result.cells.slice(start,start+cellsPerShard),ids=new Set(cells.map(c=>c.ordinal));
    const edges=result.edges.filter(e=>e.sides.some(s=>ids.has(s.ordinal)));
    chunks.push(packPartition({...result,cells,edges}));
  }
  const directory=Buffer.from(JSON.stringify({version:1,cells:result.cells.length,shards:chunks.map(c=>({
    firstOrdinal:c.arrays.cellOrdinals[0],lastOrdinal:c.arrays.cellOrdinals.at(-1),bytes:c.byteLength,metadataBytes:c.metadata.length}))}));
  return {chunks,directory,byteLength:directory.length+chunks.reduce((n,c)=>n+c.byteLength,0),
    initialDirectoryDecodeBytes:directory.length,
    largestShardBytes:Math.max(...chunks.map(c=>c.byteLength)),
    largestShardTypedArrayDecodeBytes:Math.max(...chunks.map(c=>c.decodedTypedArrayBytes))};
}
