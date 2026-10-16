import fs from 'node:fs';
import {gzipSync} from 'node:zlib';
import {hash,jsonBytes,measureEncoding,encodeCostPayloads,decodeArrays,verticesOf,validateGenerationEvidence} from './analysis.mjs';

const [fixtureFile,evidenceFile,indexArg]=process.argv.slice(2),record=JSON.parse(fs.readFileSync(0,'utf8')),fixture=JSON.parse(fs.readFileSync(fixtureFile));
const evidence=JSON.parse(fs.readFileSync(evidenceFile)),row=evidence.rows[Number(indexArg)],generation=validateGenerationEvidence(record);
if(!row||row.sample!==record.sample.name||row.candidate!==record.result.candidate||row.resultSha256!==generation.resultSha256||row.generationMs!==generation.generationMs)throw new Error('GENERATION_RECEIPT_MISMATCH');
global.gc();
const heapStart=process.memoryUsage().heapUsed,generated=record.result;
const generationMs=generation.generationMs,heapAfterGeneration=generation.observedHeapUsedBytes;
const encodingStart=performance.now(),encoding=measureEncoding(record,fixture),encoded=encodeCostPayloads(record,fixture);
const encodingMs=performance.now()-encodingStart;
const decodeStart=performance.now(),decoded=Object.fromEntries(Object.entries(encoded.payloads).map(([k,b])=>[k,k==='metadataIndex'?JSON.parse(b):decodeArrays(b)]));
const decodeMs=performance.now()-decodeStart;
// Decode the largest independent shard plus the actual index/provenance header,
// rather than silently loading a world catalog for an initial viewport.
const largest=encoded.tileEntries.reduce((a,b)=>a.bytes.length>b.bytes.length?a:b);
const directory=jsonBytes({version:1,tileIndex:encoded.metadata.tileIndex,identityRecordTemplate:fixture.example});
const initialStart=performance.now(),initial=decodeArrays(largest.bytes),initialDirectory=JSON.parse(directory);
const initialDecodeMs=performance.now()-initialStart,stageStart=performance.now();
const coords=generated.cells.flatMap(c=>verticesOf(c.geometry)),positions=new Float64Array(coords.length*2);
for(let i=0;i<coords.length;i++){positions[i*2]=coords[i][0];positions[i*2+1]=coords[i][1];}
const indices=new Uint32Array(generated.edges.length*2);let checksum=0;
generated.edges.forEach((e,i)=>{indices[i*2]=e.sides[0].ordinal;indices[i*2+1]=e.sides.at(-1).ordinal;checksum+=e.lengthMetres;});
const renderStagingMs=performance.now()-stageStart,heapAfterEncoding=process.memoryUsage().heapUsed;
if(decoded.catalog.arrays.cellOrdinals.length!==generated.cells.length||initialDirectory.tileIndex.length!==encoding.counts.tiles)throw new Error('COST_DECODE_MISMATCH');
const encodingProcessPeakRSSBytes=process.resourceUsage().maxRSS*1024;
const peakRSSBytes=Math.max(encodingProcessPeakRSSBytes,generation.processPeakRssBytes);
process.stdout.write(JSON.stringify({sample:record.sample.name,candidate:generated.candidate,encoding,
  regenerationSha256:hash(jsonBytes(generated)),areaLowerKm2:record.measurement.physical.cellMetrics.reduce((n,c)=>n+c.areaLowerKm2,0),
  generationEvidence:{sourceReport:evidence.sourceReport,resultSha256:generation.resultSha256,generationMs,regenerationPerformedHere:false,
    measuredBy:'current approved 15-14',heapEndpointPhase:generation.recordedEndpointPhase},
  upstreamEligible:record.measurement.candidateEligible,upstreamPhysical:record.measurement.physical.status,
  advanceFailures:[...record.measurement.advances.initial,...record.measurement.advances.subsequent].map(s=>({extent:s.extent,status:s.status,failures:s.failures})),
  nearCounts:[record.measurement.advances.initial[0].selected.length,record.measurement.advances.subsequent[0].selected.length],
  timings:{generationMs,encodingMs,decodeMs,initialDecodeMs,renderStagingMs},staging:{bytes:positions.byteLength+indices.byteLength,checksum},
  initialView:{directoryBytes:directory.length,directoryGzipBytes:gzipSync(directory).length,transferBytes:directory.length+largest.bytes.length,gzipBytes:gzipSync(directory).length+gzipSync(largest.bytes).length,
    stagingBytes:initial.arrays.vertices.byteLength+initial.arrays.edgeSides.byteLength,
    decodedBytes:directory.length*2+Object.values(initial.arrays).reduce((n,a)=>n+a.byteLength,0)+jsonBytes(initial.metadata).length*2},
  memory:{heapStart,heapAfterGeneration,heapAfterEncoding,encodingProcessPeakRSSBytes,generationProcessCumulativePeakRSSBytes:generation.processPeakRssBytes,
    observedHeapBytes:Math.max(heapStart,heapAfterGeneration,heapAfterEncoding),peakRSSBytes,peakHeapUpperBoundBytes:peakRSSBytes,
    method:'Maximum of current 15-14 cumulative OS RSS and fresh encoding-process OS RSS conservatively bounds JS heap. heapAfterGeneration is the post-generation/measurement/packing endpoint, not an isolated generation peak. Sequential phases do not overlap.'}}));
