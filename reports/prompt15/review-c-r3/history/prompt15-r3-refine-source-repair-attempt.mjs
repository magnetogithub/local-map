import fs from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import {pathToFileURL} from 'node:url';
import {readJSON,fileIdentity,physicalMetrics,latitudeGrid} from './prompt15-cell-core.mjs';
import {polygons,normalizeGeometry,jsonBytes,hashCanonical,compareText} from './prompt14-catalog-core.mjs';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {REVISION_POLICY as Q} from './prompt15-r3-policy.mjs';
import {validatePositiveGeometry} from './prompt15-r3-validity.mjs';
import {validatePartitionCoverage} from './prompt14-source-gate.mjs';
import {union} from './prompt15-r3-input.mjs';
import {stableCellId} from './prompt15-r3-validation.mjs';
const round=n=>Math.round(n*1e12)/1e12;
// A numerical arrangement can join adjacent grid faces. Enforce the unchanged
// physical bounds by intersecting that joined face with the SAME declared grid.
// Neither administrative nor protected parent ownership can change in this pass.
export function refineMesh(output,countryId){
 const summary=readJSON(`${output}/mesh/${countryId}/summary.json`),input=readJSON(`${output}/inputs/${countryId}.json`),partitions=new Map(input.partitions.map(p=>[hashCanonical('prompt15-protected-administrative-partition.v1',{policy:Q.version,countryId,oldTerritoryId:p.oldTerritoryId,adminId:p.adminId,geometry:p.geometry}),p])),sourceVersion=readJSON('data/source-locks/prompt14-derived-game-input-lock.json').sourceVersion,chunks=[],changes=[],grid=latitudeGrid(24),start=performance.now();let peakRss=summary.peakRss;
 const dir=`${output}/refined-mesh/${countryId}`;fs.mkdirSync(dir,{recursive:true});if(fs.existsSync(`${dir}/summary.json`))throw Error('Preserve completed refinement artifacts');
 for(const chunk of summary.chunks){const original=readJSON(`${output}/${chunk.path}`),cells=[];
  for(const c of original){const maximum=c.refined?P.boundaryMaximumDiameterKm:P.interiorMaximumDiameterKm,areaMaximum=c.refined?P.boundaryMaximumAreaKm2:P.interiorMaximumAreaKm2;
   if(c.metrics.diameterKm<=maximum&&c.metrics.areaKm2<=areaMaximum){cells.push(c);continue;}
   const pieces=[],bounds=c.metrics.bbox,row0=Math.max(0,Math.floor((bounds[1]+90)/grid.dy)),row1=Math.min(grid.rows-1,Math.floor((bounds[3]+90)/grid.dy)),divisions=c.refined?2:1;
   for(let row=row0;row<=row1;row++){const dx=360/grid.columns(row),col0=Math.max(0,Math.floor((bounds[0]+180)/dx)),col1=Math.min(grid.columns(row)-1,Math.floor((bounds[2]+180)/dx));
    for(let col=col0;col<=col1;col++)for(let y=0;y<divisions;y++)for(let x=0;x<divisions;x++){
     const w=round(-180+(col+x/divisions)*dx),e=round(-180+(col+(x+1)/divisions)*dx),s=round(-90+(row+y/divisions)*grid.dy),n=round(-90+(row+(y+1)/divisions)*grid.dy),rectangle=[[[w,s],[e,s],[e,n],[w,n],[w,s]]];
     for(const polygon of polygonClipping.intersection(polygons(c.geometry),[rectangle])){const geometry=normalizeGeometry({type:'Polygon',coordinates:polygon}),m=physicalMetrics(geometry),record={...c,geometry,metrics:{areaKm2:m.areaKm2,planarArea:m.area,diameterKm:m.diameterUpperBoundKm,aspectRatio:m.aspectRatio,vertices:m.vertices,bbox:m.bbox,centroid:m.centroid}};record.id=stableCellId(record,partitions.get(c.partitionId),sourceVersion);pieces.push(record);}
    }
   }
   const coverage=validatePartitionCoverage(c.geometry,[union(pieces.map(p=>p.geometry))]);if(!coverage.pass||!pieces.length||!validatePositiveGeometry(pieces.map(p=>p.geometry)).pass)throw Error('Physical refinement failed exact source coverage');
   changes.push({originalCellId:c.id,oldMetrics:c.metrics,newCellIds:pieces.map(p=>p.id).sort(compareText),coverage,reason:'Re-intersect oversized joined operational face with unchanged 24/12 km declared grid; admin and old parent preserved'});cells.push(...pieces);
  }
  cells.sort((a,b)=>compareText(a.id,b.id));if(new Set(cells.map(c=>c.id)).size!==cells.length)throw Error('Duplicate refined cell');
  const file=`refined-mesh/${countryId}/${path.basename(chunk.path)}`;fs.writeFileSync(`${output}/${file}`,jsonBytes(cells));const a=fileIdentity(`${output}/${file}`),slivers=cells.filter(c=>c.metrics.areaKm2<P.sliver.areaKm2||c.metrics.aspectRatio>P.sliver.aspectRatio),max=k=>cells.reduce((n,c)=>Math.max(n,c.metrics[k]),0);
  chunks.push({...chunk,path:file,sha256:a.sha256,byteLength:a.byteLength,count:cells.length,vertices:cells.reduce((n,c)=>n+c.metrics.vertices,0),maxAreaKm2:max('areaKm2'),maxDiameterKm:max('diameterKm'),sliverCount:slivers.length,nonTinySlivers:slivers.filter(c=>!c.sourceTiny).length,tinyCells:cells.filter(c=>c.sourceTiny).length,sliverAreaKm2:slivers.reduce((n,c)=>n+c.metrics.areaKm2,0),areaKm2:cells.reduce((n,c)=>n+c.metrics.areaKm2,0),checks:{...chunk.checks,geometry:validatePositiveGeometry(cells.map(c=>c.geometry)).pass}});
  peakRss=Math.max(peakRss,process.memoryUsage().rss);global.gc?.();
 }
 peakRss=Math.max(peakRss,process.resourceUsage().maxRSS*1024);
 const count=chunks.reduce((n,c)=>n+c.count,0),tiny=chunks.reduce((n,c)=>n+c.tinyCells,0),area=chunks.reduce((n,c)=>n+c.areaKm2,0),checks={...summary.checks,allChunkChecks:chunks.every(c=>Object.values(c.checks).every(Boolean)),countryCellBudget:count<=P.budgets.countryCells,offlineCountryRssBudget:peakRss<=P.budgets.offlineCountryRssBytes,maximumDiameter:chunks.every(c=>c.maxDiameterKm<=P.interiorMaximumDiameterKm),maximumArea:chunks.every(c=>c.maxAreaKm2<=P.interiorMaximumAreaKm2),sliverCount:chunks.reduce((n,c)=>n+c.nonTinySlivers,0)/Math.max(1,count-tiny)<=P.sliver.maximumNonSourceTinyCellFraction,sliverArea:chunks.reduce((n,c)=>n+c.sliverAreaKm2,0)/area<=P.sliver.maximumSliverAreaFraction};
 const result={...summary,status:Object.values(checks).every(Boolean)?'pass':'fail',checks,chunks,count,peakRss,elapsedMs:summary.elapsedMs+performance.now()-start,refinementChanges:changes,originalMeshSummary:fileIdentity(`${output}/mesh/${countryId}/summary.json`),refinementGenerator:fileIdentity('scripts/prompt15-r3-refine.mjs')};fs.writeFileSync(`${dir}/summary.json`,jsonBytes(result));return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const r=refineMesh(process.argv[2],process.argv[3]);console.log(JSON.stringify({status:r.status,country:r.countryId,changes:r.refinementChanges.length,count:r.count}));if(r.status!=='pass')process.exitCode=1;}
