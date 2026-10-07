// Fresh-process measurement of the existing V3 seed/metadata representation.
import fs from 'node:fs';
const cells=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),country=process.argv[3];
const states=[],metadatas=[],repetitions=Math.max(1,Math.ceil(10000/cells.length));
const modelState={territoryOrder:cells.map(c=>c.id),territoriesById:Object.fromEntries(cells.map(c=>[c.id,{id:c.id,sourceCountryId:country,ownerCountryId:country,controllerCountryId:country}]))};
const modelMetadata={territories:cells.map(c=>({id:c.id,sourceCountryId:country,anchor:c.centroid,bbox:c.bbox,area:c.planarArea}))};
const stateText=JSON.stringify(modelState),metadataText=JSON.stringify(modelMetadata);
global.gc();const before=process.memoryUsage().heapUsed,start=performance.now();
for(let i=0;i<repetitions;i++){states.push(JSON.parse(stateText));metadatas.push(JSON.parse(metadataText));}
globalThis.proxyRetention={states,metadatas};global.gc();const retainedHeapBytes=(process.memoryUsage().heapUsed-before)/repetitions,constructionMs=(performance.now()-start)/repetitions;
if(states.length!==repetitions||metadatas[0].territories.length!==cells.length)throw Error('Proxy retention failed');
console.log(JSON.stringify({stateBytes:Buffer.byteLength(stateText),metadataBytes:Buffer.byteLength(metadataText),retainedHeapBytes,constructionMs,repetitions,retainedRecordCount:cells.length*2,
 method:'Fresh Node process: parse actual V3 territory seed and consumer metadata JSON shapes, retain >=10000 records across GC, divide allocation/time by repetitions. Includes parsed ID strings and coordinate arrays. Excludes full validation/projection; planning proxy only.'}));
