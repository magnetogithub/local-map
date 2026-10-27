import fs from 'node:fs';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import DistanceOp from 'jsts/org/locationtech/jts/operation/distance/DistanceOp.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import {arrangeSourcePartitions} from './prompt14-boundary-arrangement.mjs';
import {buildCatalogTopology,territoryIdForAtom} from './prompt14-catalog-topology.mjs';
import {normalizeGeometry,geometryMetadata,polygons,signedArea,hashCanonical,jsonBytes,digest,generateAtoms} from './prompt14-catalog-core.mjs';
import {validatePartitionCoverage,validatePolygonFeatureCollection,CANONICAL_P0_VALIDATOR_POLICY} from './prompt14-source-gate.mjs';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
const rad=Math.PI/180,R=P.earthRadiusKm,reader=new GeoJSONReader();
const writer=new GeoJSONWriter();
const intersectionPolygons=(a,b)=>{try{return polygonClipping.intersection(polygons(a),polygons(b));}catch{const result=writer.write(OverlayOp.intersection(reader.read(a),reader.read(b)));return result.type==='Polygon'?[result.coordinates]:result.type==='MultiPolygon'?result.coordinates:[];}};
const unionGeometries=geometries=>writer.write(UnaryUnionOp.union(reader.read({type:'GeometryCollection',geometries})));
export const readJSON=p=>JSON.parse(fs.readFileSync(p,'utf8'));
export const fileIdentity=p=>{const b=fs.readFileSync(p);return {path:p,sha256:digest(b),byteLength:b.length};};
export const stableCellId=({candidateId,parentKey,parentHash,geometry})=>hashCanonical('prompt15-operational-cell.v2',{policy:P.version,candidate:candidateId,parentKey,parentHash,geometry:normalizeGeometry(geometry)});
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
const validatorSignedArea=ring=>ring.slice(0,-1).reduce((sum,position,index)=>sum+position[0]*ring[index+1][1]-ring[index+1][0]*position[1],0)/2;
const survivesNumericalRing=ring=>{const rounded=ring.map(point=>point.map(gridNumber)).filter((point,index,list)=>!index||point[0]!==list[index-1][0]||point[1]!==list[index-1][1]);if(rounded.length>1&&(rounded[0][0]!==rounded.at(-1)[0]||rounded[0][1]!==rounded.at(-1)[1]))rounded.push(rounded[0]);if(rounded.length<4)return false;let area=0;for(let index=1;index<rounded.length;index++)area+=rounded[index-1][0]*rounded[index][1]-rounded[index][0]*rounded[index-1][1];return area!==0;};
const survivesNumericalGrid=geometry=>polygons(geometry).every(polygon=>polygon.every(survivesNumericalRing));
export const finalCanonicalGeometry=geometry=>{const normalized=normalizeGeometry(geometry);for(const polygon of polygons(normalized))for(const [index,ring]of polygon.entries()){const area=signedArea(ring);if(!Number.isFinite(area)||area===0||(area>0)!==(index===0))throw Error('Canonical geometry has unstable ring winding');}return normalized;};
const certifiedValidity=collection=>{const result=validatePolygonFeatureCollection(collection,'operational candidate',CANONICAL_P0_VALIDATOR_POLICY);if(result.pass)return result;const numericalOnly=result.errors.every(message=>message.includes('ring is degenerate')||message.includes('ring must be clockwise')||message.includes('ring must be counterclockwise'));let minimumStableRingArea=Infinity,stable=true;try{for(const feature of collection.features)for(const polygon of polygons(normalizeGeometry(feature.geometry)))for(const [index,ring] of polygon.entries()){const area=signedArea(ring);minimumStableRingArea=Math.min(minimumStableRingArea,Math.abs(area));if(!Number.isFinite(area)||area===0||(area>0)!==(index===0))stable=false;}}catch{stable=false;}if(!numericalOnly||!stable)return result;return {...result,pass:true,errors:[],numericalRingCertificate:{policy:'Only origin-based shoelace degenerate/winding messages may be superseded; JSTS validity and all other structural checks already passed.',originalErrors:result.errors,stableOffsetSignedArea:true,minimumStableRingArea}};};
export function loadExperimentSources(){
 const freeze=readJSON('data/catalogs/prompt14/frozen-catalog-ref.json'),base=path.dirname(freeze.artifactIndex.path),prefix=`${base}/build-only/${freeze.ref.catalogVersion}`;
 const catalog=readJSON(`${prefix}/catalog.json`),topology=readJSON(`${prefix}/topology.json`),geometry=readJSON(`${prefix}/geometry.geojson`),countries=new Map(catalog.entries.map(e=>[e.id,e.sourceCountryId]));
 const geometryById=new Map(geometry.features.map(f=>[f.properties.territoryId,f.geometry])),oldTerritories=new Map();
 for(const entry of catalog.entries){const list=oldTerritories.get(entry.sourceCountryId)??[],sourceFeatureIds=entry.provenanceIds.flatMap(id=>{const p=catalog.provenanceById[id];return p?.sourceId==='natural-earth-admin1-states-provinces-10m'?[String(p.sourceFeatureId)]:[];});list.push({id:entry.id,geometry:geometryById.get(entry.id),sourceFeatureIds});oldTerritories.set(entry.sourceCountryId,list);}
 const p0=readJSON('data/derived/prompt14/shared-game-p0.geojson'),selected=readJSON('data/derived/prompt14/selected-game-input.geojson');
 for(const id of ['SVN','DNK']){const recovered=readJSON(`reports/prompt15/candidates/${id}-first.json`);if(recovered.status!=='pass')throw Error(`Unapproved recovery ${id}`);selected.features=selected.features.filter(f=>f.properties.countryId!==id).concat(recovered.selected.features);}
 const land=new Map();for(const e of topology.edges){if(e.boundaryClass!=='country'||!e.rightTerritoryId)continue;const ids=[countries.get(e.leftTerritoryId),countries.get(e.rightTerritoryId)];for(const country of ids){const list=land.get(country)??[];for(let i=1;i<e.geometry.coordinates.length;i++)list.push({a:e.geometry.coordinates[i-1],b:e.geometry.coordinates[i],neighbor:ids.find(id=>id!==country)});land.set(country,list);}}
 return {freeze,p0,selected,land,oldTerritories,sourceVersion:readJSON('data/source-locks/prompt14-derived-game-input-lock.json').sourceVersion};
}
function landIndex(segments){const index=new STRtree();for(const e of segments){if(Math.abs(e.a[0]-e.b[0])>180)continue;index.insert(new Envelope(Math.min(e.a[0],e.b[0]),Math.max(e.a[0],e.b[0]),Math.min(e.a[1],e.b[1]),Math.max(e.a[1],e.b[1])),e);}return index;}
function expandedBox(box,km){const lat=km/R/rad,cos=Math.cos(Math.min(89.999,Math.max(Math.abs(box[1]),Math.abs(box[3]))+lat)*rad),lon=Math.min(360,lat/Math.max(1e-8,cos));return new Envelope(box[0]-lon,box[2]+lon,box[1]-lat,box[3]+lat);}
export function generateCountryCells(sources,countryId,candidate,onProgress=()=>{}){
 const start=performance.now(),parents=sources.selected.features.filter(f=>f.properties.countryId===countryId),base=sources.p0.features.find(f=>f.properties.countryId===countryId);
 const grid=latitudeGrid(candidate.baseKm),index=landIndex((sources.refinement??sources.land).get(countryId)??[]),features=[],parentStats=[],sourceComponents=[],numericalProtectedFragmentRepairs=[];let rectanglesTested=0,refinedBaseBoxes=0,numericalProtectedFragmentsSkipped=0;
 const oldCandidates=(sources.oldTerritories.get(countryId)??[]).slice().sort((a,b)=>a.id.localeCompare(b.id)),oldIndex=new STRtree();
 // Index individual polygon components. A territory-level MultiPolygon bbox can
 // span an ocean or every longitude near a pole, making every grid face pay for
 // an intersection with hundreds of unrelated remote components.
 for(const territory of oldCandidates)for(const coordinates of polygons(territory.geometry)){const geometry=normalizeGeometry({type:'Polygon',coordinates}),bbox=geometryMetadata(geometry).bbox;oldIndex.insert(new Envelope(bbox[0],bbox[2],bbox[1],bbox[3]),{id:territory.id,geometry});}
 const protectOldBoundaries=geometry=>{
  if(!sources.protectOldBoundaries)return [{geometry,oldTerritoryId:null}];
  const bbox=geometryMetadata(geometry).bbox,candidates=[];for(const it=oldIndex.query(new Envelope(bbox[0],bbox[2],bbox[1],bbox[3])).iterator();it.hasNext();)candidates.push(it.next());
  const fragments=[],collapsed=[];for(const territory of candidates.sort((a,b)=>a.id.localeCompare(b.id))){const clipped=intersectionPolygons(geometry,territory.geometry);for(const polygon of clipped){const fragment=normalizeGeometry({type:'Polygon',coordinates:polygon}),area=reader.read(fragment).getArea();if(!(area>0))continue;if(!survivesNumericalGrid(fragment)){collapsed.push({geometry:fragment,oldTerritoryId:territory.id,area});continue;}fragments.push({geometry:fragment,oldTerritoryId:territory.id});}}
  if(!fragments.length){const area=reader.read(geometry).getArea(),nearest=candidates.map(territory=>({territory,distance:DistanceOp.distance(reader.read(geometry),reader.read(territory.geometry))})).sort((a,b)=>a.distance-b.distance||a.territory.id.localeCompare(b.territory.id))[0];if(area<=1e-12&&nearest){fragments.push({geometry,oldTerritoryId:nearest.territory.id});numericalProtectedFragmentRepairs.push({kind:'uncovered-numerical-component-assignment',area,geometryHash:digest(jsonBytes(geometry)),sourceOldTerritoryId:'numerical-unassigned',assignedOldTerritoryId:nearest.territory.id,distance:nearest.distance});}else throw Error(`Protected overlay does not cover generated face in ${countryId}: ${JSON.stringify({bbox,area,candidateCount:candidates.length,geometryHash:digest(jsonBytes(geometry))})}`);}
  const bboxDistance=(a,b)=>{const dx=Math.max(0,a[0]-b[2],b[0]-a[2]),dy=Math.max(0,a[1]-b[3],b[1]-a[3]);return Math.hypot(dx,dy);};
  for(const item of collapsed.sort((a,b)=>digest(jsonBytes(a.geometry)).localeCompare(digest(jsonBytes(b.geometry))))){const itemBox=geometryMetadata(item.geometry).bbox,target=fragments.slice().sort((a,b)=>bboxDistance(itemBox,geometryMetadata(a.geometry).bbox)-bboxDistance(itemBox,geometryMetadata(b.geometry).bbox)||(a.oldTerritoryId===item.oldTerritoryId?-1:b.oldTerritoryId===item.oldTerritoryId?1:0)||a.oldTerritoryId.localeCompare(b.oldTerritoryId))[0],beforeGeometryHash=digest(jsonBytes(target.geometry));target.geometry=normalizeGeometry(unionGeometries([target.geometry,item.geometry]));numericalProtectedFragmentRepairs.push({kind:'collapsed-protected-fragment-union',area:item.area,geometryHash:digest(jsonBytes(item.geometry)),sourceOldTerritoryId:item.oldTerritoryId,assignedOldTerritoryId:target.oldTerritoryId,beforeGeometryHash,afterGeometryHash:digest(jsonBytes(target.geometry))});}
  return fragments;
 };
 for(const parent of parents){
  const p=parent.properties,parentKey=`${countryId}:${p.sourceFeatureId}`,parentHash=digest(jsonBytes(normalizeGeometry(parent.geometry))),parentMetrics=physicalMetrics(parent.geometry),adminId=p.inputRole==='P1'?String(p.sourceFeatureId):null;
  const direct=adminId?oldCandidates.filter(x=>x.sourceFeatureIds.includes(adminId)):[];
  const ranked=sources.protectOldBoundaries?[]:(direct.length?direct:oldCandidates).map(x=>({x,overlap:intersectionPolygons(parent.geometry,x.geometry).reduce((n,polygon)=>n+reader.read({type:'Polygon',coordinates:polygon}).getArea(),0)})).sort((a,b)=>b.overlap-a.overlap||a.x.id.localeCompare(b.x.id));
  const oldTerritoryId=sources.protectOldBoundaries?'protected-overlay-split':ranked[0]?.overlap>0?ranked[0].x.id:null;if(!oldTerritoryId)throw Error(`No old territory overlap for ${parentKey}`);let created=0;
  for(const [componentIndex,component]of polygons(parent.geometry).entries()){
   const componentGeometry=normalizeGeometry({type:'Polygon',coordinates:component}),componentHash=digest(jsonBytes(componentGeometry)),componentVertexCount=component.reduce((sum,ring)=>sum+ring.length,0),tiny=physicalMetrics(componentGeometry);
   const sourceTiny=tiny.areaKm2<=P.tinySourceComponent.maximumAreaKm2&&tiny.diameterUpperBoundKm<=P.tinySourceComponent.maximumDiameterKm;
   sourceComponents.push({parentKey,componentIndex,sourceHash:componentHash,areaKm2:tiny.areaKm2,diameterKm:tiny.diameterUpperBoundKm,sourceTiny,reason:sourceTiny?'Pinned source component satisfies both physical tiny-source limits; retained without merging or deletion':null});
   // Apply the immutable previous-territory overlay before gridding. Set
   // intersection is associative, so this creates the same final faces while
   // avoiding a repeated intersection with the full protected polygon for
   // every individual grid cell.
   for(const protectedSource of protectOldBoundaries(componentGeometry)){
    const bounds=geometryMetadata(protectedSource.geometry).bbox,finalOldTerritoryId=protectedSource.oldTerritoryId??oldTerritoryId;
   const row0=Math.max(0,Math.floor((bounds[1]+90)/grid.dy)),row1=Math.min(grid.rows-1,Math.floor((bounds[3]+90)/grid.dy));
   for(let row=row0;row<=row1;row++){
    const south=-90+row*grid.dy,north=-90+(row+1)*grid.dy,columns=grid.columns(row),dx=360/columns;
    // Clip only exceptionally complex source components once per latitude
    // row. Ordinary components retain the direct grid intersection path; the
    // threshold avoids introducing redundant numerical row faces while still
    // preventing Antarctica's 20k+ vertex mainland ring from being reread for
    // every small grid rectangle.
    const rowCoordinates=componentVertexCount>5000?intersectionPolygons(protectedSource.geometry,rectangle(-180,south,180,north)):polygons(protectedSource.geometry);
    const rowFragments=rowCoordinates.map(coordinates=>{const geometry=normalizeGeometry({type:'Polygon',coordinates});return {geometry,bbox:geometryMetadata(geometry).bbox};});
    const col0=Math.max(0,Math.floor((bounds[0]+180)/dx)),col1=Math.min(columns-1,Math.floor((bounds[2]+180)/dx));
    for(let col=col0;col<=col1;col++){
     const west=-180+col*dx,east=-180+(col+1)*dx,box=[west,south,east,north];
     const refine=!!candidate.refineKm&&!index.query(expandedBox(box,P.borderRefinementBandKm)).isEmpty();
     const divisions=refine?candidate.baseKm/candidate.refineKm:1;if(refine)refinedBaseBoxes++;
     for(let y=0;y<divisions;y++)for(let x=0;x<divisions;x++){
      rectanglesTested++;const cellBox=rectangle(-180+(col+x/divisions)*dx,-90+(row+y/divisions)*grid.dy,-180+(col+(x+1)/divisions)*dx,-90+(row+(y+1)/divisions)*grid.dy);
      const cellBounds=[cellBox.coordinates[0][0][0],cellBox.coordinates[0][0][1],cellBox.coordinates[0][2][0],cellBox.coordinates[0][2][1]];
      for(const rowFragment of rowFragments){if(rowFragment.bbox[2]<cellBounds[0]||rowFragment.bbox[0]>cellBounds[2]||rowFragment.bbox[3]<cellBounds[1]||rowFragment.bbox[1]>cellBounds[3])continue;
      for(const polygon of intersectionPolygons(rowFragment.geometry,cellBox)){
       const geometry=normalizeGeometry({type:'Polygon',coordinates:polygon});
       if(!(reader.read(geometry).getArea()>0))throw Error('Positive cell collapsed');
        const sourceFeatureId=stableCellId({candidateId:candidate.id,parentKey,parentHash,geometry});
        features.push({type:'Feature',properties:{countryId,sourceCountryId:countryId,oldTerritoryId:finalOldTerritoryId,adminId,sourceFeatureId,inputRole:'P1',parentKey,parentSourceFeatureId:p.sourceFeatureId,parentHash,sourceComponentHash:componentHash,componentIndex,sourceTiny,refined:refine,gridRow:row,gridColumn:col},geometry});created++;
      }
      }
     }
    }
   }
   }
  }
  parentStats.push({parentKey,sourceFeatureId:p.sourceFeatureId,parentHash,oldTerritoryId,adminId,inputRole:p.inputRole,metrics:parentMetrics,sourceComponents:polygons(parent.geometry).length,cellCount:created});
 }
 const numericalGapRepairs=[],numericalCellRepairs=[],parentByKey=new Map(parents.map(parent=>[`${countryId}:${parent.properties.sourceFeatureId}`,parent]));let arranged;
 const bboxDistance=(a,b)=>{const dx=Math.max(0,a[0]-b[2],b[0]-a[2]),dy=Math.max(0,a[1]-b[3],b[1]-a[3]);return Math.hypot(dx,dy);};
 const mergeNumericalCell=(lostIndex,kind)=>{const lost=features[lostIndex],lostBox=geometryMetadata(lost.geometry).bbox,candidates=features.filter((feature,index)=>index!==lostIndex&&feature.properties.parentKey===lost.properties.parentKey).sort((a,b)=>bboxDistance(lostBox,geometryMetadata(a.geometry).bbox)-bboxDistance(lostBox,geometryMetadata(b.geometry).bbox)||(a.properties.oldTerritoryId===lost.properties.oldTerritoryId?-1:b.properties.oldTerritoryId===lost.properties.oldTerritoryId?1:0)||a.properties.sourceFeatureId.localeCompare(b.properties.sourceFeatureId));let selected=null;
  for(const target of candidates){try{const geometry=normalizeGeometry(unionGeometries([target.geometry,lost.geometry])),refined=Boolean(target.properties.refined||lost.properties.refined),metrics=physicalMetrics(geometry),maximumDiameterKm=refined?P.boundaryMaximumDiameterKm:P.interiorMaximumDiameterKm,maximumAreaKm2=refined?P.boundaryMaximumAreaKm2:P.interiorMaximumAreaKm2;if(metrics.diameterUpperBoundKm<=maximumDiameterKm&&metrics.areaKm2<=maximumAreaKm2){selected={target,geometry,refined,metrics,maximumDiameterKm,maximumAreaKm2};break;}}catch{continue;}}
  if(!selected)return false;const {target,geometry,refined,metrics,maximumDiameterKm,maximumAreaKm2}=selected,beforeTargetSourceFeatureId=target.properties.sourceFeatureId,lostGeometryHash=digest(jsonBytes(lost.geometry)),area=reader.read(lost.geometry).getArea();target.geometry=geometry;target.properties.refined=refined;target.properties.sourceFeatureId=stableCellId({candidateId:candidate.id,parentKey:target.properties.parentKey,parentHash:target.properties.parentHash,geometry:target.geometry});features.splice(lostIndex,1);numericalCellRepairs.push({kind,area,lostSourceFeatureId:lost.properties.sourceFeatureId,lostGeometryHash,beforeTargetSourceFeatureId,afterTargetSourceFeatureId:target.properties.sourceFeatureId,parentKey:target.properties.parentKey,sourceOldTerritoryId:lost.properties.oldTerritoryId,assignedOldTerritoryId:target.properties.oldTerritoryId,mergedDiameterKm:metrics.diameterUpperBoundKm,maximumDiameterKm,mergedAreaKm2:metrics.areaKm2,maximumAreaKm2});return true;
 };
 const sanitizeNumericalComponents=feature=>{const originalComponents=polygons(feature.geometry),hasSurvivingExterior=originalComponents.some(polygon=>survivesNumericalRing(polygon[0])),components=[],repairStart=numericalCellRepairs.length;let changed=false;for(const polygon of originalComponents){if(!survivesNumericalRing(polygon[0])&&hasSurvivingExterior){changed=true;numericalCellRepairs.push({kind:'collapsed-component-ledger',area:Math.max(0,Math.abs(signedArea(polygon[0]))-polygon.slice(1).reduce((sum,hole)=>sum+Math.abs(signedArea(hole)),0)),lostSourceFeatureId:feature.properties.sourceFeatureId,lostGeometryHash:digest(jsonBytes(polygon)),beforeTargetSourceFeatureId:feature.properties.sourceFeatureId,afterTargetSourceFeatureId:null,parentKey:feature.properties.parentKey,sourceOldTerritoryId:feature.properties.oldTerritoryId,assignedOldTerritoryId:feature.properties.oldTerritoryId});continue;}const kept=[polygon[0]];for(const hole of polygon.slice(1))if(survivesNumericalRing(hole))kept.push(hole);else{changed=true;numericalCellRepairs.push({kind:'collapsed-hole-fill',area:Math.abs(signedArea(hole)),lostSourceFeatureId:feature.properties.sourceFeatureId,lostGeometryHash:digest(jsonBytes(hole)),beforeTargetSourceFeatureId:feature.properties.sourceFeatureId,afterTargetSourceFeatureId:null,parentKey:feature.properties.parentKey,sourceOldTerritoryId:feature.properties.oldTerritoryId,assignedOldTerritoryId:feature.properties.oldTerritoryId});}components.push(kept);}if(changed){feature.geometry=normalizeGeometry({type:components.length===1?'Polygon':'MultiPolygon',coordinates:components.length===1?components[0]:components});feature.properties.sourceFeatureId=stableCellId({candidateId:candidate.id,parentKey:feature.properties.parentKey,parentHash:feature.properties.parentHash,geometry:feature.geometry});for(const repair of numericalCellRepairs.slice(repairStart))repair.afterTargetSourceFeatureId=feature.properties.sourceFeatureId;}return changed;};
 for(const feature of features)sanitizeNumericalComponents(feature);
 const maximumPreNodingRepairs=features.length;for(let repairCount=0;repairCount<maximumPreNodingRepairs;repairCount++){const collapsedIndex=features.findIndex(feature=>!survivesNumericalGrid(feature.geometry));if(collapsedIndex<0)break;if(sanitizeNumericalComponents(features[collapsedIndex]))continue;if(!mergeNumericalCell(collapsedIndex,'pre-noding-collapsed-ring-union')){const feature=features[collapsedIndex];throw Error(`No same-parent cell can preserve a collapsed ring in ${countryId}: ${JSON.stringify({parentKey:feature.properties.parentKey,oldTerritoryId:feature.properties.oldTerritoryId,sourceTiny:feature.properties.sourceTiny,area:reader.read(feature.geometry).getArea(),bbox:geometryMetadata(feature.geometry).bbox,geometryHash:digest(jsonBytes(feature.geometry)),rings:polygons(feature.geometry).map(polygon=>polygon.map(ring=>({survives:survivesNumericalRing(ring),vertices:ring.length,stableArea:signedArea(ring),validatorArea:validatorSignedArea(ring)})))})}`);}}
 onProgress(`${countryId}/${candidate.id}: ${features.length} cells; common numerical noding`);
 const selectedInput={type:'FeatureCollection',features};
 for(let attempt=0;attempt<100;attempt++){
  try{arranged=arrangeSourcePartitions({type:'FeatureCollection',features:[base]},selectedInput,selectedInput,onProgress);}catch(error){
   const lostId=/^Lost source identity (.+)$/.exec(error.message)?.[1],lostIndex=lostId?features.findIndex(feature=>feature.properties.sourceFeatureId===lostId):-1;
   if(lostIndex>=0){if(!mergeNumericalCell(lostIndex,'lost-source-face-union'))throw error;arranged=null;continue;}
   const unresolved=error.evidence?.unresolved??[],repairable=unresolved.length>0&&unresolved.every(item=>item.kind==='ambiguous-gap'&&item.area>0&&item.area<=1e-12&&item.contacts?.length);if(!repairable)throw error;
   const bySourceId=new Map(features.map(feature=>[feature.properties.sourceFeatureId,feature]));
   for(const gap of unresolved.slice().sort((a,b)=>digest(jsonBytes(a.geometry)).localeCompare(digest(jsonBytes(b.geometry))))){const candidates=gap.contacts.map(id=>bySourceId.get(id)).filter(Boolean).map(feature=>({feature,parentOverlap:intersectionPolygons(gap.geometry,parentByKey.get(feature.properties.parentKey).geometry).reduce((sum,polygon)=>sum+reader.read({type:'Polygon',coordinates:polygon}).getArea(),0)})).sort((a,b)=>b.parentOverlap-a.parentOverlap||a.feature.properties.sourceFeatureId.localeCompare(b.feature.properties.sourceFeatureId)),target=candidates[0]?.feature;if(!target)throw error;
    const beforeSourceFeatureId=target.properties.sourceFeatureId;target.geometry=normalizeGeometry(unionGeometries([target.geometry,gap.geometry]));target.properties.sourceFeatureId=stableCellId({candidateId:candidate.id,parentKey:target.properties.parentKey,parentHash:target.properties.parentHash,geometry:target.geometry});numericalGapRepairs.push({kind:gap.kind,area:gap.area,geometryHash:digest(jsonBytes(normalizeGeometry(gap.geometry))),beforeSourceFeatureId,afterSourceFeatureId:target.properties.sourceFeatureId,assignedParentKey:target.properties.parentKey,parentOverlap:candidates[0].parentOverlap,contactSourceFeatureIds:gap.contacts.slice().sort()});
   }
   arranged=null;continue;
  }
  for(const feature of arranged.selected.features)feature.geometry=finalCanonicalGeometry(feature.geometry);
  const preview=certifiedValidity(arranged.selected);if(preview.pass)break;throw Object.assign(Error(`Non-repairable final geometry in ${countryId}`),{validity:preview});
 }
 if(!arranged)throw Error(`Numerical arrangement repair limit exceeded in ${countryId}`);
 const common={p0:arranged.p0,selected:arranged.selected,evidence:arranged.evidence.common},componentSeparation=[];
 // IDs are computed after common noding from immutable canonical final
 // geometry. Reassert canonical ring winding because an extremely small final
 // face can reverse orientation during arrangement boundary reconstruction.
 const componentSeparated=[];for(const f of common.selected.features){const canonical=finalCanonicalGeometry(f.geometry),components=polygons(canonical);if(components.length===1)componentSeparated.push({...f,geometry:canonical});else{const beforeGeometryHash=digest(jsonBytes(canonical)),outputs=[];for(const component of components){const geometry=finalCanonicalGeometry({type:'Polygon',coordinates:component}),sourceFeatureId=stableCellId({candidateId:candidate.id,parentKey:f.properties.parentKey,parentHash:f.properties.parentHash,geometry});outputs.push({sourceFeatureId,geometryHash:digest(jsonBytes(geometry))});componentSeparated.push({...f,properties:{...f.properties,sourceFeatureId},geometry});}componentSeparation.push({kind:'component-separated-cell',parentKey:f.properties.parentKey,oldTerritoryId:f.properties.oldTerritoryId,beforeSourceFeatureId:f.properties.sourceFeatureId,beforeGeometryHash,outputs});}}common.selected.features=componentSeparated;
 for(const f of common.selected.features){f.geometry=finalCanonicalGeometry(f.geometry);f.properties.sourceFeatureId=stableCellId({candidateId:candidate.id,parentKey:f.properties.parentKey,parentHash:f.properties.parentHash,geometry:f.geometry});}
 const atoms=generateAtoms({selected:common.selected,lock:{sourceVersion:sources.sourceVersion}});
 const topology=buildCatalogTopology(atoms,common.p0,onProgress);
 const cells=atoms.map(a=>{const f=common.selected.features[a.members[0].featureIndex],geometry=finalCanonicalGeometry(a.geometry);return {id:territoryIdForAtom(a.canonicalAtomKey),...f.properties,...physicalMetrics(a.geometry),geometry};});
 for(const parent of parentStats)parent.cellCount=cells.filter(cell=>cell.parentKey===parent.parentKey).length;
 const validity=certifiedValidity(common.selected);
 const coverage=parents.map(parent=>{const parts=cells.filter(c=>c.parentKey===`${countryId}:${parent.properties.sourceFeatureId}`).map(c=>c.geometry);
  const union=unionGeometries(parts),primary=validatePartitionCoverage(parent.geometry,[union]),sumArea=parts.reduce((n,g)=>n+reader.read(g).getArea(),0),unionArea=reader.read(union).getArea(),overlapArea=Math.max(0,sumArea-unionArea);let equality=primary,coverageAlgorithm='polygon-clipping coverage against fixed parent';
  if(!primary.pass&&primary.error)try{const expected=reader.read(parent.geometry),actual=reader.read(union),intersection=OverlayOp.intersection(expected,actual),p0Area=expected.getArea(),clippedArea=intersection.getArea(),actualArea=actual.getArea(),gapArea=Math.max(0,p0Area-clippedArea),outOfCountryArea=Math.max(0,actualArea-clippedArea),tolerance=Math.max(CANONICAL_P0_VALIDATOR_POLICY.coverageAbsoluteTolerance,p0Area*CANONICAL_P0_VALIDATOR_POLICY.coverageRelativeTolerance);equality={pass:gapArea<=tolerance&&outOfCountryArea<=tolerance,p0Area,unionArea:clippedArea,gapArea,overlapArea:0,outOfCountryArea,tolerance,primaryError:primary.error};coverageAlgorithm='Independent JSTS OverlayOp fallback after polygon-clipping ring-construction error';}catch{equality=primary;}
  return {parentKey:`${countryId}:${parent.properties.sourceFeatureId}`,...equality,overlapArea,pass:equality.pass&&overlapArea<=(equality.tolerance??0),unionAlgorithm:`Independent JSTS UnaryUnion of exact common faces; ${coverageAlgorithm}; original tolerance`};
 });
 const countryUnion=unionGeometries(cells.map(c=>c.geometry)),countryCoverage=validatePartitionCoverage(base.geometry,[countryUnion]);
 const vertexCount=cells.reduce((n,c)=>n+c.vertices,0),slivers=cells.filter(c=>c.areaKm2<P.sliver.areaKm2||c.aspectRatio>P.sliver.aspectRatio),sourceTinyCells=cells.filter(c=>c.sourceTiny);
 const metrics={cellCount:cells.length,vertexCount,edgeCount:topology.edges.length,parentCount:parents.length,refinedCells:cells.filter(c=>c.refined).length,rectanglesTested,refinedBaseBoxes,numericalProtectedFragmentsSkipped,numericalProtectedFragmentRepairs:numericalProtectedFragmentRepairs.length,numericalCellRepairs:numericalCellRepairs.length,numericalGapRepairs:numericalGapRepairs.length,
  maxDiameterKm:Math.max(...cells.map(c=>c.diameterUpperBoundKm)),maxAreaKm2:Math.max(...cells.map(c=>c.areaKm2)),maxAspectRatio:Math.max(...cells.map(c=>c.aspectRatio)),
  sliverCount:slivers.length,nonSourceTinySliverFraction:slivers.filter(c=>!c.sourceTiny).length/Math.max(1,cells.length-sourceTinyCells.length),sliverAreaFraction:slivers.reduce((n,c)=>n+c.areaKm2,0)/cells.reduce((n,c)=>n+c.areaKm2,0),
  sourceTinyCells:sourceTinyCells.length,sourceTinyParentComponents:[...new Set(sourceTinyCells.map(c=>`${c.parentKey}:${c.componentIndex}`))],elapsedMs:performance.now()-start,memory:process.memoryUsage()};
 return {candidate,countryId,policyVersion:P.version,parents:parentStats,sourceComponents,cells,topology,coverage,countryCoverage,validity,numericalNoding:common.evidence,numericalProtectedFragmentRepairs,numericalCellRepairs,numericalGapRepairs,componentSeparation,metrics};
}

const segmentKey=s=>jsonBytes([s.a,s.b].sort((a,b)=>a[0]-b[0]||a[1]-b[1])).toString();
export function frontierCells(result,sourceSegments){
 const lookup=new Map(result.cells.map(c=>[c.id,c])),edges=result.topology.edges.filter(e=>e.rightTerritoryId===null);
 const selected=[];for(const e of edges){const coordinates=e.geometry.coordinates;for(const s of sourceSegments){const mid=[(s.a[0]+s.b[0])/2,(s.a[1]+s.b[1])/2];if(!coordinates.some(p=>distanceKm(p,mid)<=distanceKm(s.a,s.b)/2+1e-5))continue;
  const dx=(s.b[0]-s.a[0])*Math.cos(mid[1]*rad),dy=s.b[1]-s.a[1],length=Math.hypot(dx,dy);if(!length)continue;
  let shared=0;for(let i=1;i<coordinates.length;i++){const a=coordinates[i-1],b=coordinates[i];const dist=p=>Math.abs((p[0]-s.a[0])*Math.cos(mid[1]*rad)*dy-(p[1]-s.a[1])*dx)/length;
   const t=p=>((p[0]-s.a[0])*Math.cos(mid[1]*rad)*dx+(p[1]-s.a[1])*dy)/(length*length);const overlap=Math.min(1,Math.max(t(a),t(b)))-Math.max(0,Math.min(t(a),t(b)));
   if(dist(a)<1e-9&&dist(b)<1e-9&&overlap>1e-9)shared+=overlap*distanceKm(s.a,s.b);
   }if(shared>1e-8)selected.push({id:e.leftTerritoryId,edgeId:e.id,sharedKm:shared,sourceSegmentKey:segmentKey(s),sourceSegmentKm:distanceKm(s.a,s.b),sourceSegment:s,cell:lookup.get(e.leftTerritoryId)});
 }}return selected;
}

export function graphSelection(result,frontier,anchor,range,occupied=new Set(),tangent=[1,0],normal=null){
 const byId=new Map(result.cells.map(c=>[c.id,c]));
 const offset=c=>{let dl=c.centroid[0]-anchor[0];if(dl>180)dl-=360;if(dl< -180)dl+=360;return [dl*rad*R*Math.cos(anchor[1]*rad),(c.centroid[1]-anchor[1])*rad*R];};
 if(!normal){const nearest=frontier.filter(id=>!occupied.has(id)).sort((a,b)=>distanceKm(byId.get(a).centroid,anchor)-distanceKm(byId.get(b).centroid,anchor)||a.localeCompare(b))[0],v=nearest?offset(byId.get(nearest)):[0,1],left=[-tangent[1],tangent[0]],sign=v[0]*left[0]+v[1]*left[1]<0?-1:1;normal=left.map(n=>n*sign);}
 const radius=Math.hypot(range.depthKm,range.widthKm/2),eligible=c=>{const v=offset(c),depth=v[0]*normal[0]+v[1]*normal[1];return depth>=-1e-8&&depth<=range.depthKm&&distanceKm(c.centroid,anchor)<=radius&&Math.abs(v[0]*tangent[0]+v[1]*tangent[1])<=range.widthKm/2;};
 const possible=[...new Set(frontier.filter(id=>!occupied.has(id)&&eligible(byId.get(id))))].sort((a,b)=>distanceKm(byId.get(a).centroid,anchor)-distanceKm(byId.get(b).centroid,anchor)||a.localeCompare(b));
 if(!possible.length)return {status:'empty',ids:[],count:0,tiers:0,areaKm2:0,maximumGraphDepthKm:0,maximumForwardDepthKm:0,maximumLateralKm:0,capExceeded:false,overflow:{count:false,area:false},parentAreaFractions:[]};
 const possibleSet=new Set(possible),component=new Set([possible[0]]),seedQueue=[possible[0]];
 while(seedQueue.length)for(const n of result.topology.adjacency[seedQueue.pop()])if(possibleSet.has(n)&&!component.has(n)){component.add(n);seedQueue.push(n);}
 const seeds=[...component].sort();
 const distances=new Map(seeds.map(id=>[id,0])),hops=new Map(seeds.map(id=>[id,0])),queue=seeds.map(id=>[0,id]);
 while(queue.length){queue.sort((a,b)=>b[0]-a[0]||b[1].localeCompare(a[1]));const [d,id]=queue.pop();if(d!==distances.get(id))continue;
  for(const next of result.topology.adjacency[id]){const c=byId.get(next);if(occupied.has(next)||!eligible(c))continue;const nd=d+distanceKm(byId.get(id).centroid,c.centroid);if(nd>range.depthKm)continue;if(nd<(distances.get(next)??Infinity)){distances.set(next,nd);hops.set(next,(hops.get(id)??0)+1);queue.push([nd,next]);}}
 }
 const ids=[...distances.keys()].sort(),areaKm2=ids.reduce((n,id)=>n+byId.get(id).areaKm2,0),vectors=ids.map(id=>offset(byId.get(id))),maximumForwardDepthKm=Math.max(0,...vectors.map(v=>v[0]*normal[0]+v[1]*normal[1])),maximumLateralKm=Math.max(0,...vectors.map(v=>Math.abs(v[0]*tangent[0]+v[1]*tangent[1]))),countOverflow=ids.length>P.lookupCap,areaOverflow=areaKm2>range.maximumAreaKm2;
 // A cap failure is explicit and retains the full diagnostic count, not a truncated success.
 return {status:countOverflow||areaOverflow?'cap-exceeded':'pass',ids,count:ids.length,tiers:Math.max(...hops.values())+1,areaKm2,maximumGraphDepthKm:Math.max(...distances.values()),maximumForwardDepthKm,maximumLateralKm,capExceeded:countOverflow||areaOverflow,overflow:{count:countOverflow,area:areaOverflow},
  anchor,range,tangent,normal,approximation:'Centroid great-circle edge weights and a forward-only frontier-oriented local corridor; not an exact geodesic band',parentAreaFractions:[...new Set(ids.map(id=>byId.get(id).parentKey))].map(parentKey=>({parentKey,occupiedAreaKm2:ids.filter(id=>byId.get(id).parentKey===parentKey).reduce((n,id)=>n+byId.get(id).areaKm2,0),parentAreaKm2:result.parents.find(p=>p.parentKey===parentKey).metrics.areaKm2}))};
}
export function behaviorExperiments(result,sources){
 const countrySegments=sources.land.get(result.countryId)??[],front=frontierCells(result,countrySegments),scenarios=[];
 if(front.length){
  for(const neighbor of [...new Set(front.map(f=>f.sourceSegment.neighbor))].sort()){
  // Prefer a sufficiently large source region, using deterministic source geometry only.
  const ordered=front.filter(f=>f.sourceSegment.neighbor===neighbor).sort((a,b)=>b.sharedKm-a.sharedKm||result.parents.find(p=>p.parentKey===b.cell.parentKey).metrics.areaKm2-result.parents.find(p=>p.parentKey===a.cell.parentKey).metrics.areaKm2||a.id.localeCompare(b.id));
  // The longest actual shared cell/source interval is the deterministic anchor.
  // This avoids selecting a tiny disconnected border tip merely because its
  // administrative parent sorts first, while remaining independent of names.
  const start=ordered[0],anchor=start.cell.centroid,frontIds=[...new Set(ordered.map(f=>f.id))];
  const dx=(start.sourceSegment.b[0]-start.sourceSegment.a[0])*Math.cos(anchor[1]*rad),dy=start.sourceSegment.b[1]-start.sourceSegment.a[1],length=Math.hypot(dx,dy),tangent=[dx/length,dy/length];
  const mid=[(start.sourceSegment.a[0]+start.sourceSegment.b[0])/2,(start.sourceSegment.a[1]+start.sourceSegment.b[1])/2],left=[-tangent[1],tangent[0]],side=(anchor[0]-mid[0])*Math.cos(anchor[1]*rad)*left[0]+(anchor[1]-mid[1])*left[1],normal=left.map(n=>n*(side<0?-1:1));
  const ranges=Object.fromEntries(Object.entries(P.ranges).map(([name,range])=>[name,graphSelection(result,frontIds,anchor,range,new Set(),tangent,normal)]));
  const occupied=new Set(ranges.near.ids),nextFront=[...new Set([...occupied].flatMap(id=>result.topology.adjacency[id]).filter(id=>!occupied.has(id)))];
  const byId=new Map(result.cells.map(c=>[c.id,c])),secondAnchor=nextFront.slice().sort((a,b)=>distanceKm(byId.get(b).centroid,anchor)-distanceKm(byId.get(a).centroid,anchor)||a.localeCompare(b))[0];
  const second=graphSelection(result,nextFront,secondAnchor?byId.get(secondAnchor).centroid:anchor,P.ranges.near,occupied,tangent,normal);
   scenarios.push({kind:'national-frontier',neighbor:start.sourceSegment.neighbor,sourceSegment:start.sourceSegment,sourceSegmentKey:start.sourceSegmentKey,frontierIds:frontIds,frontierEdgeIds:[...new Set(ordered.map(f=>f.edgeId))].sort(),anchor,ranges,second,
   firstSecondDisjoint:second.ids.every(id=>!occupied.has(id)),secondTouchesCurrentFront:second.ids.some(id=>result.topology.adjacency[id].some(n=>occupied.has(n))),
   sameParentOccupiedAndUnoccupied:result.parents.some(p=>{const all=result.cells.filter(c=>c.parentKey===p.parentKey);return all.some(c=>occupied.has(c.id))&&all.some(c=>!occupied.has(c.id));})});
  }
 }
 // An internal control boundary is simulated from REAL adjacent cells in the largest parent.
 const parent=result.parents.slice().sort((a,b)=>b.metrics.areaKm2-a.metrics.areaKm2||a.parentKey.localeCompare(b.parentKey))[0];
 const candidates=result.cells.filter(c=>c.parentKey===parent.parentKey),center=parent.metrics.centroid;
 const initial=candidates.slice().sort((a,b)=>distanceKm(a.centroid,center)-distanceKm(b.centroid,center)||a.id.localeCompare(b.id))[0];
 const controlled=new Set([initial.id]),internalFront=result.topology.adjacency[initial.id];
 const ranges=Object.fromEntries(Object.entries(P.ranges).map(([name,range])=>[name,graphSelection(result,internalFront,initial.centroid,range,controlled)]));
 scenarios.push({kind:'internal-frontier',parentKey:parent.parentKey,parentAreaKm2:parent.metrics.areaKm2,initialControlledIds:[initial.id],anchor:initial.centroid,ranges,
  cellsDoNotCrossParent:result.coverage.every(c=>c.pass),limitedHasSeveralDepthSteps:ranges.limited.tiers>=P.minimumLimitedGraphTiers,
  nearLeavesInterior:candidates.some(c=>!controlled.has(c.id)&&!ranges.near.ids.includes(c.id))});
 const frontierCoverage=Object.fromEntries([...new Set(front.map(f=>f.sourceSegment.neighbor))].sort().map(neighbor=>{const entries=front.filter(f=>f.sourceSegment.neighbor===neighbor),bySegment=new Map();for(const f of entries){const e=bySegment.get(f.sourceSegmentKey)??{sourceSegmentKey:f.sourceSegmentKey,sourceSegmentKm:f.sourceSegmentKm,coveredKm:0,cellIds:new Set(),edgeIds:new Set()};e.coveredKm+=f.sharedKm;e.cellIds.add(f.id);e.edgeIds.add(f.edgeId);bySegment.set(f.sourceSegmentKey,e);}return [neighbor,[...bySegment.values()].sort((a,b)=>a.sourceSegmentKey.localeCompare(b.sourceSegmentKey)).map(e=>({...e,coverageRatio:e.coveredKm/e.sourceSegmentKm,cellIds:[...e.cellIds].sort(),edgeIds:[...e.edgeIds].sort()}))];}));
 return {frontierCount:front.length,frontierCellIds:[...new Set(front.map(f=>f.id))].sort(),frontierCoverage,scenarios};
}

export function sourceGeometryStats(sources){
 let areaKm2=0,perimeterKm=0,components=0,vertices=0;for(const f of sources.p0.features)areaKm2+=physicalAreaKm2(f.geometry);
 for(const f of sources.selected.features)for(const p of polygons(f.geometry)){components++;for(const ring of p){vertices+=ring.length;for(let i=1;i<ring.length;i++)perimeterKm+=distanceKm(ring[i-1],ring[i]);}}
 const borders=new Map();for(const segments of sources.land.values())for(const s of segments)borders.set(segmentKey(s),distanceKm(s.a,s.b));
 return {areaKm2,parentPerimeterKm:perimeterKm,components,sourceVertices:vertices,uniqueLandBoundaryKm:[...borders.values()].reduce((a,b)=>a+b,0)};
}
