import fs from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import {arrangeSourcePartitions} from './prompt14-boundary-arrangement.mjs';
import {buildCatalogTopology,territoryIdForAtom} from './prompt14-catalog-topology.mjs';
import {normalizeGeometry,geometryMetadata,polygons,hashCanonical,jsonBytes,digest,generateAtoms} from './prompt14-catalog-core.mjs';
import {validatePartitionCoverage,validatePolygonFeatureCollection,CANONICAL_P0_VALIDATOR_POLICY} from './prompt14-source-gate.mjs';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
const rad=Math.PI/180,R=P.earthRadiusKm,reader=new GeoJSONReader();
const writer=new GeoJSONWriter();
export const readJSON=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export const fileIdentity=p=>{const b=fs.readFileSync(p);return {path:p,sha256:digest(b),byteLength:b.length};};
export function distanceKm(a,b){const lat1=a[1]*rad,lat2=b[1]*rad,dl=(b[0]-a[0])*rad,dp=lat2-lat1;return 2*R*Math.asin(Math.sqrt(Math.min(1,Math.sin(dp/2)**2+Math.cos(lat1)*Math.cos(lat2)*Math.sin(dl/2)**2)));}
export function physicalAreaKm2(g){
 let total=0;for(const p of polygons(g)){for(const [i,ring]of p.entries()){let a=0,winding=0;for(let j=1;j<ring.length;j++){let d=(ring[j][0]-ring[j-1][0])*rad;if(d>Math.PI)d-=2*Math.PI;if(d< -Math.PI)d+=2*Math.PI;winding+=d;a+=d*(Math.sin(ring[j][1]*rad)+Math.sin(ring[j-1][1]*rad));}if(Math.abs(winding)>Math.PI)a+=2*winding;let area=Math.abs(a*R*R/2),sphereArea=4*Math.PI*R*R;if(area>sphereArea/2)area=sphereArea-area;total+=(i===0?1:-1)*area;}}return Math.max(0,total);
}
export function physicalMetrics(g){const m=geometryMetadata(g),b=m.bbox,minAbs=b[1]<=0&&b[3]>=0?0:Math.min(Math.abs(b[1]),Math.abs(b[3]));
 const width=(b[2]-b[0])*rad*R*Math.cos(minAbs*rad),height=(b[3]-b[1])*rad*R;
 return {...m,areaKm2:physicalAreaKm2(g),diameterUpperBoundKm:Math.hypot(width,height),aspectRatio:Math.max(width,height)/Math.max(1e-12,Math.min(width,height))};
}
export function latitudeGrid(baseKm){const rows=Math.ceil(Math.PI*R/baseKm),dy=180/rows;return {rows,dy,columns:row=>{const s=-90+row*dy,n=-90+(row+1)*dy,minAbs=s<=0&&n>=0?0:Math.min(Math.abs(s),Math.abs(n));return Math.max(1,Math.ceil(2*Math.PI*R*Math.cos(minAbs*rad)/baseKm));}};}
const gridNumber=n=>Math.round(n*1e12)/1e12;
const rectangle=(w,s,e,n)=>{[w,s,e,n]=[w,s,e,n].map(gridNumber);return {type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]};};
export function loadExperimentSources(){
 const freeze=readJSON('data/catalogs/prompt14/frozen-catalog-ref.json'),base=path.dirname(freeze.artifactIndex.path),prefix=`${base}/build-only/${freeze.ref.catalogVersion}`;
 const catalog=readJSON(`${prefix}/catalog.json`),topology=readJSON(`${prefix}/topology.json`),countries=new Map(catalog.entries.map(e=>[e.id,e.sourceCountryId]));
 const p0=readJSON('data/derived/prompt14/shared-game-p0.geojson'),selected=readJSON('data/derived/prompt14/selected-game-input.geojson');
 for(const id of ['SVN','DNK']){const recovered=readJSON(`reports/prompt15/candidates/${id}-first.json`);if(recovered.status!=='pass')throw Error(`Unapproved recovery ${id}`);selected.features=selected.features.filter(f=>f.properties.countryId!==id).concat(recovered.selected.features);}
 const land=new Map();for(const e of topology.edges){if(e.boundaryClass!=='country'||!e.rightTerritoryId)continue;const ids=[countries.get(e.leftTerritoryId),countries.get(e.rightTerritoryId)];for(const country of ids){const list=land.get(country)??[];for(let i=1;i<e.geometry.coordinates.length;i++)list.push({a:e.geometry.coordinates[i-1],b:e.geometry.coordinates[i],neighbor:ids.find(id=>id!==country)});land.set(country,list);}}
 return {freeze,p0,selected,land,sourceVersion:readJSON('data/source-locks/prompt14-derived-game-input-lock.json').sourceVersion};
}
function landIndex(segments){const index=new STRtree();for(const e of segments){if(Math.abs(e.a[0]-e.b[0])>180)continue;index.insert(new Envelope(Math.min(e.a[0],e.b[0]),Math.max(e.a[0],e.b[0]),Math.min(e.a[1],e.b[1]),Math.max(e.a[1],e.b[1])),e);}return index;}
function expandedBox(box,km){const lat=km/R/rad,cos=Math.cos(Math.min(89.999,Math.max(Math.abs(box[1]),Math.abs(box[3]))+lat)*rad),lon=Math.min(360,lat/Math.max(1e-8,cos));return new Envelope(box[0]-lon,box[2]+lon,box[1]-lat,box[3]+lat);}
export function generateCountryCells(sources,countryId,candidate,onProgress=()=>{}){
 const start=performance.now(),parents=sources.selected.features.filter(f=>f.properties.countryId===countryId),base=sources.p0.features.find(f=>f.properties.countryId===countryId);
 const grid=latitudeGrid(candidate.baseKm),index=landIndex(sources.land.get(countryId)??[]),features=[],parentStats=[];let rectanglesTested=0,refinedBaseBoxes=0;
 for(const parent of parents){
  const p=parent.properties,parentKey=`${countryId}:${p.sourceFeatureId}`,parentHash=digest(jsonBytes(normalizeGeometry(parent.geometry))),parentMetrics=physicalMetrics(parent.geometry);let created=0;
  for(const [componentIndex,component]of polygons(parent.geometry).entries()){
   const bounds=geometryMetadata(normalizeGeometry({type:'Polygon',coordinates:component})).bbox;
   const tiny=physicalMetrics(normalizeGeometry({type:'Polygon',coordinates:component}));
   const sourceTiny=tiny.areaKm2<=P.tinySourceComponent.maximumAreaKm2&&tiny.diameterUpperBoundKm<=P.tinySourceComponent.maximumDiameterKm;
   const row0=Math.max(0,Math.floor((bounds[1]+90)/grid.dy)),row1=Math.min(grid.rows-1,Math.floor((bounds[3]+90)/grid.dy));
   for(let row=row0;row<=row1;row++){
    const south=-90+row*grid.dy,north=-90+(row+1)*grid.dy,columns=grid.columns(row),dx=360/columns;
    const col0=Math.max(0,Math.floor((bounds[0]+180)/dx)),col1=Math.min(columns-1,Math.floor((bounds[2]+180)/dx));
    for(let col=col0;col<=col1;col++){
     const west=-180+col*dx,east=-180+(col+1)*dx,box=[west,south,east,north];
     const refine=!!candidate.refineKm&&!index.query(expandedBox(box,P.borderRefinementBandKm)).isEmpty();
     const divisions=refine?candidate.baseKm/candidate.refineKm:1;if(refine)refinedBaseBoxes++;
     for(let y=0;y<divisions;y++)for(let x=0;x<divisions;x++){
      rectanglesTested++;const cellBox=rectangle(-180+(col+x/divisions)*dx,-90+(row+y/divisions)*grid.dy,-180+(col+(x+1)/divisions)*dx,-90+(row+(y+1)/divisions)*grid.dy);
      const clipped=polygonClipping.intersection([component],polygons(cellBox));
      for(const polygon of clipped){
       const geometry=normalizeGeometry({type:'Polygon',coordinates:polygon});
       if(!(reader.read(geometry).getArea()>0))throw Error('Positive cell collapsed');
       const sourceFeatureId=hashCanonical('prompt15-operational-cell.v1',{policy:P.version,candidate:candidate.id,parentKey,parentHash,geometry});
       features.push({type:'Feature',properties:{countryId,sourceCountryId:countryId,sourceFeatureId,inputRole:'P1',parentKey,parentSourceFeatureId:p.sourceFeatureId,parentHash,componentIndex,sourceTiny,refined:refine,gridRow:row,gridColumn:col},geometry});created++;
      }
     }
    }
   }
  }
  parentStats.push({parentKey,sourceFeatureId:p.sourceFeatureId,parentHash,metrics:parentMetrics,sourceComponents:polygons(parent.geometry).length,cellCount:created});
 }
 onProgress(`${countryId}/${candidate.id}: ${features.length} cells; common numerical noding`);
 const arranged=arrangeSourcePartitions({type:'FeatureCollection',features:[base]},{type:'FeatureCollection',features},{type:'FeatureCollection',features},onProgress);
 const common={p0:arranged.p0,selected:arranged.selected,evidence:arranged.evidence.common};
 // IDs are computed after common noding from immutable canonical final geometry.
 for(const f of common.selected.features)f.properties.sourceFeatureId=hashCanonical('prompt15-operational-cell.v1',{policy:P.version,candidate:candidate.id,parentKey:f.properties.parentKey,parentHash:f.properties.parentHash,geometry:normalizeGeometry(f.geometry)});
 const atoms=generateAtoms({selected:common.selected,lock:{sourceVersion:sources.sourceVersion}});
 let topology;try{topology=buildCatalogTopology(atoms,common.p0,onProgress);}catch(error){topology={edges:[],adjacency:{},evidence:{completeBoundaryCoverage:false,symmetricAdjacency:false,legacyFailure:error.message,legacyFailureEvidence:error.evidence??null}};}
 const cells=atoms.map(a=>{const f=common.selected.features[a.members[0].featureIndex];return {id:territoryIdForAtom(a.canonicalAtomKey),...f.properties,...physicalMetrics(a.geometry),geometry:a.geometry};});
 const validity=validatePolygonFeatureCollection(common.selected,'operational candidate',CANONICAL_P0_VALIDATOR_POLICY);
 const unionGeometries=geometries=>writer.write(UnaryUnionOp.union(reader.read({type:'GeometryCollection',geometries})));
 const coverage=parents.map(parent=>{const parts=cells.filter(c=>c.parentKey===`${countryId}:${parent.properties.sourceFeatureId}`).map(c=>c.geometry);
  const union=unionGeometries(parts),equality=validatePartitionCoverage(parent.geometry,[union]),sumArea=parts.reduce((n,g)=>n+reader.read(g).getArea(),0),unionArea=reader.read(union).getArea(),overlapArea=Math.max(0,sumArea-unionArea);
  return {parentKey:`${countryId}:${parent.properties.sourceFeatureId}`,...equality,overlapArea,pass:equality.pass&&overlapArea<=equality.tolerance,unionAlgorithm:'Independent JSTS UnaryUnion of exact common faces; single-union coverage against fixed parent with original tolerance'};
 });
 const countryUnion=unionGeometries(cells.map(c=>c.geometry)),countryCoverage=validatePartitionCoverage(base.geometry,[countryUnion]);
 const vertexCount=cells.reduce((n,c)=>n+c.vertices,0),slivers=cells.filter(c=>c.areaKm2<P.sliver.areaKm2||c.aspectRatio>P.sliver.aspectRatio),sourceTinyCells=cells.filter(c=>c.sourceTiny);
 const metrics={cellCount:cells.length,vertexCount,edgeCount:topology.edges.length,parentCount:parents.length,refinedCells:cells.filter(c=>c.refined).length,rectanglesTested,refinedBaseBoxes,
  maxDiameterKm:Math.max(...cells.map(c=>c.diameterUpperBoundKm)),maxAreaKm2:Math.max(...cells.map(c=>c.areaKm2)),maxAspectRatio:Math.max(...cells.map(c=>c.aspectRatio)),
  sliverCount:slivers.length,nonSourceTinySliverFraction:slivers.filter(c=>!c.sourceTiny).length/Math.max(1,cells.length-sourceTinyCells.length),sliverAreaFraction:slivers.reduce((n,c)=>n+c.areaKm2,0)/cells.reduce((n,c)=>n+c.areaKm2,0),
  sourceTinyCells:sourceTinyCells.length,sourceTinyParentComponents:[...new Set(sourceTinyCells.map(c=>`${c.parentKey}:${c.componentIndex}`))],elapsedMs:performance.now()-start,memory:process.memoryUsage()};
 return {candidate,countryId,policyVersion:P.version,parents:parentStats,cells,topology,coverage,countryCoverage,validity,numericalNoding:common.evidence,metrics};
}

