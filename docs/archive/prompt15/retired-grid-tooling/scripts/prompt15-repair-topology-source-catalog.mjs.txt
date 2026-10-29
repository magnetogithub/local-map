// Repair two numerical defects in the pinned 15-19 catalog without mutating it:
// 1. canonical ring winding for six cancellation-prone, positive-area faces;
// 2. one CAN/USA sub-tolerance overlap wedge, assigned to the USA side of the
//    already shared operational boundary. The repair is local, deterministic,
//    and fully recorded before task 15-20 derives topology from the new root.
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import polygonClipping from 'polygon-clipping';
import {fileIdentity,physicalMetrics,stableCellId} from './prompt15-cell-core.mjs';
import {territoryIdForAtom} from './prompt14-catalog-topology.mjs';
import {compareText,digest,hashCanonical,jsonBytes,normalizeGeometry,polygons,signedArea} from './prompt14-catalog-core.mjs';
import {TASK_15_19_VERSION} from './prompt15-world-catalog.mjs';
import {CELL_EXPERIMENT_POLICY} from './prompt15-cell-policy.mjs';

export const TOPOLOGY_SOURCE_REPAIR_VERSION='prompt15-task-15-19-topology-source-repair-v2';

const SOURCE_ROOT='data/derived/prompt15/15-19-operational-catalog-v2-2aec1da86420bc4aebe0';
const SOURCE_INDEX={path:`${SOURCE_ROOT}/artifact-index.json`,byteLength:118836,sha256:'21fabbcfd7d8b454d7787feb9306e92bedcc5072429ad3cfedbf97f7e1b14806'};
const SOURCE_V19={path:'reports/prompt15/15-19-v19-component-separated.json',byteLength:54334,sha256:'81ade98f5f8d1158a853c19b07e8907019af0920a5cad095a0a4f3d0de90432c'};
const WINDING_REPAIRS=new Map([['DOM',1],['FRA',1],['GBR',2],['JAM',1],['TUN',1]]);
const CAN_TARGET='territory:catalog:af6228a8d699bb7e0ff0ddacb81c7434d156cd849262054680eab6c39b7bf0de';
const CAN_A=[-141.003146,64.548671];
const CAN_B=[-141.003140186825,64.532374100719];
const CAN_C=[-141.003108206704,64.442719675132];
const CAN_RING=[CAN_A,CAN_C,[-141.003101693553,64.424460431655],[-140.912863070539,64.424460431655],[-140.912863070539,64.532374100719],CAN_B,CAN_A];
const COORDINATE_TOLERANCE_DEGREES=1e-12;
// `prompt15-cell-core.mjs` materializes every operational grid cell with P1
// atom identity, including cells cut from a P0R country-envelope parent.
const CELL_ATOM_INPUT_ROLE='P1';
const slash=value=>String(value).replaceAll('\\','/');
const readJSON=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const readGzipJSON=file=>JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8'));
const same=(actual,expected)=>actual.byteLength===expected.byteLength&&actual.sha256===expected.sha256;
const equal=(first,second)=>JSON.stringify(first)===JSON.stringify(second);
const pointEqual=(first,second)=>first[0]===second[0]&&first[1]===second[1];
const ringEdgeCount=geometry=>polygons(geometry).reduce((sum,polygon)=>sum+polygon.reduce((ringSum,ring)=>ringSum+ring.length-1,0),0);

function geometryInvariantEvidence(geometry){
 const components=polygons(geometry),segments=[];let rings=0,vertices=0,areaDegrees=0;
 for(const polygon of components)for(const [ringIndex,ring] of polygon.entries()){rings++;vertices+=ring.length;areaDegrees+=(ringIndex===0?1:-1)*Math.abs(signedArea(ring));for(let index=1;index<ring.length;index++){const first=ring[index-1],second=ring[index],firstKey=JSON.stringify(first),secondKey=JSON.stringify(second);segments.push(compareText(firstKey,secondKey)<=0?[first,second]:[second,first]);}}
 segments.sort((first,second)=>compareText(JSON.stringify(first),JSON.stringify(second)));
 return {components:components.length,rings,vertices,areaDegrees,boundaryHash:hashCanonical('prompt15-repair-undirected-boundary.v1',segments)};
}

function deriveCellIdentity({countryId,geometry,parentKey,parentHash,candidateId,sourceVersion}){
 if(typeof sourceVersion!=='string'||!sourceVersion||typeof parentHash!=='string'||!parentHash)throw Error('Incomplete operational-cell identity regime');
 const normalized=normalizeGeometry(geometry),sourceFeatureId=stableCellId({candidateId,parentKey,parentHash,geometry:normalized}),componentKeys=polygons(normalized).map(component=>hashCanonical('catalog-component.v1',component)).sort(compareText);
 if(new Set(componentKeys).size!==componentKeys.length)throw Error('Duplicate normalized component in repaired operational cell');
 const identity={sourceCountryId:countryId,sourceVersion,sourceFeatureId,inputRole:CELL_ATOM_INPUT_ROLE,componentKeys},canonicalAtomKey=`atom:${countryId}:${hashCanonical('catalog-atom.v1',identity)}`;
 return {sourceFeatureId,componentKeys,identity,canonicalAtomKey,cellId:territoryIdForAtom(canonicalAtomKey)};
}

function assertSource(){
 const indexIdentity=fileIdentity(SOURCE_INDEX.path),v19Identity=fileIdentity(SOURCE_V19.path);if(!same(indexIdentity,SOURCE_INDEX)||!same(v19Identity,SOURCE_V19))throw Error('Topology-source repair prerequisite identity changed');
 const index=readJSON(SOURCE_INDEX.path),report=readJSON(SOURCE_V19.path);if(index.artifacts?.length!==744||report.status!=='pass'||slash(report.root)!==slash(SOURCE_ROOT))throw Error('Topology-source repair prerequisite is not the pinned V19 PASS');
 let total=0;for(const artifact of index.artifacts){if(typeof artifact.path!=='string'||artifact.path.includes('\\')||path.posix.isAbsolute(artifact.path)||artifact.path.split('/').some(part=>!part||part==='.'||part==='..'))throw Error(`Unsafe source artifact path: ${artifact.path}`);const actual=fileIdentity(path.join(SOURCE_ROOT,...artifact.path.split('/')));if(!same(actual,artifact))throw Error(`Source artifact changed: ${artifact.path}`);total+=actual.byteLength;}if(total!==index.totalByteLength)throw Error('Source artifact byte total changed');
 return {index,indexIdentity,v19Identity};
}

function stableWinding(geometry){return normalizeGeometry(geometry);}

function windingDefects(geometry){
 let count=0;for(const polygon of polygons(geometry))for(const [ringIndex,ring] of polygon.entries())if((signedArea(ring)>0)!==(ringIndex===0))count++;return count;
}

function pointSegmentWitness(point,start,end){
 const dx=end[0]-start[0],dy=end[1]-start[1],denominator=dx*dx+dy*dy;
 if(!Number.isFinite(denominator)||!(denominator>0))return null;
 const rawT=((point[0]-start[0])*dx+(point[1]-start[1])*dy)/denominator,t=Math.max(0,Math.min(1,rawT)),projection=[start[0]+t*dx,start[1]+t*dy],distance=Math.hypot(point[0]-projection[0],point[1]-projection[1]);
 return Number.isFinite(rawT)&&Number.isFinite(distance)?{distance,rawT,projection}:null;
}

function countryP0SegmentWitness(feature,countryId){
 const candidates=[];
 for(const polygon of polygons(feature.geometry))for(const ring of polygon)for(let index=1;index<ring.length;index++){
  const start=ring[index-1],end=ring[index],aAtStart=pointEqual(start,CAN_A),aAtEnd=pointEqual(end,CAN_A);if(!aAtStart&&!aAtEnd)continue;
  const a=pointSegmentWitness(CAN_A,start,end),b=pointSegmentWitness(CAN_B,start,end),c=pointSegmentWitness(CAN_C,start,end);if(!a||!b||!c)continue;
  const fromA=value=>aAtStart?value.rawT:1-value.rawT,bFromA=fromA(b),cFromA=fromA(c);
  if([a,b,c].some(value=>value.distance>COORDINATE_TOLERANCE_DEGREES||value.rawT<0||value.rawT>1)||!(bFromA>0&&cFromA>bFromA&&cFromA<1))continue;
  candidates.push({countryId,segment:[start,end],distances:{a:a.distance,b:b.distance,c:c.distance},positionsFromA:{a:fromA(a),b:bFromA,c:cFromA}});
 }
 if(candidates.length!==1)throw Error(`Expected one finite ${countryId} P0 segment containing A/B/C, found ${candidates.length}`);
 return candidates[0];
}

function p0Witness(){
 const p0=readJSON('data/derived/prompt14/shared-game-p0.geojson'),can=p0.features.find(feature=>feature.properties.countryId==='CAN'),usa=p0.features.find(feature=>feature.properties.countryId==='USA');if(!can||!usa)throw Error('Locked bilateral CAN/USA P0 features are missing');
 const canWitness=countryP0SegmentWitness(can,'CAN'),usaWitness=countryP0SegmentWitness(usa,'USA'),[canStart,canEnd]=canWitness.segment,[usaStart,usaEnd]=usaWitness.segment;
 if(!pointEqual(canStart,usaEnd)||!pointEqual(canEnd,usaStart))throw Error('CAN/USA P0 witness is not the same exact segment in opposite directions');
 const maximumDistance=Math.max(...Object.values(canWitness.distances),...Object.values(usaWitness.distances));if(!Number.isFinite(maximumDistance)||maximumDistance>COORDINATE_TOLERANCE_DEGREES)throw Error('CAN/USA P0 witness exceeds the fixed coordinate tolerance');
 return {can:canWitness,usa:usaWitness,maximumDistance,coordinateToleranceDegrees:COORDINATE_TOLERANCE_DEGREES};
}

function directedSegmentOccurrences(collection,start,end){
 const matches=[];
 for(const feature of collection.features??[])for(const [componentIndex,polygon] of polygons(feature.geometry).entries())for(const [ringIndex,ring] of polygon.entries())for(let index=1;index<ring.length;index++)if(pointEqual(ring[index-1],start)&&pointEqual(ring[index],end))matches.push({cellId:feature.properties.cellId,feature,componentIndex,ringIndex,segmentIndex:index-1});
 return matches;
}

function singleDirectedSegment(collection,start,end,label){
 const matches=directedSegmentOccurrences(collection,start,end);if(matches.length!==1)throw Error(`Expected one ${label} directed segment, found ${matches.length}`);return matches[0];
}

function canonicalizeCountryOrder(catalog,geometry,generation,candidateId,sourceVersion,changedCellId){
 if(catalog.entries.length!==geometry.features.length)throw Error('CAN catalog/geometry cardinality changed');
 const parents=new Map(generation.parents.map(parent=>[parent.parentKey,parent])),pairs=catalog.entries.map((entry,index)=>{
  const feature=geometry.features[index];if(feature.properties.cellId!==entry.id||entry.sourceCountryId!=='CAN'||feature.properties.sourceCountryId!=='CAN')throw Error(`CAN catalog/geometry identity mismatch at ${index}`);
  const parent=parents.get(entry.parentKey);if(!parent||typeof parent.parentHash!=='string')throw Error(`Missing CAN parent identity for ${entry.id}`);
  const derived=deriveCellIdentity({countryId:'CAN',geometry:feature.geometry,parentKey:entry.parentKey,parentHash:parent.parentHash,candidateId,sourceVersion});if(derived.cellId!==entry.id)throw Error(`CAN cell ID does not match the frozen derivation regime: ${entry.id}`);
  return {entry,feature,canonicalAtomKey:derived.canonicalAtomKey,originalIndex:index};
 });
 if(new Set(pairs.map(pair=>pair.canonicalAtomKey)).size!==pairs.length)throw Error('Duplicate CAN canonical atom identity after repair');
 const unchanged=pairs.filter(pair=>pair.entry.id!==changedCellId);if(unchanged.some((pair,index)=>index&&compareText(unchanged[index-1].canonicalAtomKey,pair.canonicalAtomKey)>0))throw Error('Pinned CAN catalog was not canonically ordered before the local repair');
 pairs.sort((first,second)=>compareText(first.canonicalAtomKey,second.canonicalAtomKey));
 const newIndex=pairs.findIndex(pair=>pair.entry.id===changedCellId),movedEntries=pairs.filter((pair,index)=>pair.originalIndex!==index).length;if(newIndex<0)throw Error('Repaired CAN cell disappeared during canonical ordering');
 return {catalog:{...catalog,entries:pairs.map(pair=>pair.entry)},geometry:{...geometry,features:pairs.map(pair=>pair.feature)},newIndex,movedEntries,canonicalOrderHash:hashCanonical('prompt15-repair-canonical-order.v1',pairs.map(pair=>pair.canonicalAtomKey))};
}

function repairWinding(countryId,geometry){
 const repaired={...geometry,features:geometry.features.map(feature=>({...feature,geometry:stableWinding(feature.geometry)}))},items=[];
 for(let index=0;index<geometry.features.length;index++){
  const before=geometry.features[index],after=repaired.features[index],defects=windingDefects(before.geometry),afterDefects=windingDefects(after.geometry),coordinatesChanged=before.geometry.type!==after.geometry.type||!equal(before.geometry.coordinates,after.geometry.coordinates);if(afterDefects!==0)throw Error(`Canonical winding repair failed for ${countryId}:${before.properties.cellId}`);
  if(coordinatesChanged){
   if(defects!==1)throw Error(`Unexpected ${countryId} winding rewrite for ${before.properties.cellId}`);
   const beforeInvariant=geometryInvariantEvidence(before.geometry),afterInvariant=geometryInvariantEvidence(after.geometry),areaTolerance=Math.max(Number.MIN_VALUE,Math.abs(beforeInvariant.areaDegrees)*Number.EPSILON*32);
   if(beforeInvariant.components!==afterInvariant.components||beforeInvariant.rings!==afterInvariant.rings||beforeInvariant.vertices!==afterInvariant.vertices||beforeInvariant.boundaryHash!==afterInvariant.boundaryHash||Math.abs(beforeInvariant.areaDegrees-afterInvariant.areaDegrees)>areaTolerance)throw Error(`Winding repair changed the ${countryId}:${before.properties.cellId} boundary, area, or vertex structure`);
   items.push({countryId,cellId:before.properties.cellId,beforeGeometryHash:digest(jsonBytes(before.geometry)),afterGeometryHash:digest(jsonBytes(after.geometry)),defects,afterDefects,boundaryHash:afterInvariant.boundaryHash,components:afterInvariant.components,rings:afterInvariant.rings,vertices:afterInvariant.vertices,areaDegrees:afterInvariant.areaDegrees,areaTolerance});
  }
 }
 const expected=WINDING_REPAIRS.get(countryId)??0;if(items.length!==expected)throw Error(`Expected ${expected} winding repairs in ${countryId}, found ${items.length}`);return {geometry:repaired,items};
}

function repairCanada(catalog,geometry,generation,usaGeometry,candidateId,sourceVersion,p0){
 if(catalog.schemaVersion!==TASK_15_19_VERSION||catalog.policyVersion!==CELL_EXPERIMENT_POLICY.version||catalog.candidateId!==candidateId||catalog.countryId!=='CAN'||generation.countryId!=='CAN')throw Error('CAN repair input is outside the frozen generator/identity regime');
 const catalogIndex=catalog.entries.findIndex(entry=>entry.id===CAN_TARGET),geometryIndex=geometry.features.findIndex(feature=>feature.properties.cellId===CAN_TARGET);if(catalogIndex<0||geometryIndex!==catalogIndex)throw Error('Pinned CAN overlap cell is absent or catalog/geometry order changed');
 const entry=catalog.entries[catalogIndex],feature=geometry.features[geometryIndex],ring=feature.geometry.type==='Polygon'&&feature.geometry.coordinates.length===1?feature.geometry.coordinates[0]:null;if(!ring||!equal(ring,CAN_RING))throw Error('Pinned CAN overlap geometry changed');
 const parent=generation.parents.find(item=>item.parentKey===entry.parentKey);if(!parent||typeof parent.parentHash!=='string'||parent.inputRole!==CELL_ATOM_INPUT_ROLE)throw Error('Pinned CAN parent identity regime changed');
 const oldDerivation=deriveCellIdentity({countryId:'CAN',geometry:feature.geometry,parentKey:entry.parentKey,parentHash:parent.parentHash,candidateId,sourceVersion});if(oldDerivation.cellId!==CAN_TARGET)throw Error(`Pinned CAN target does not reproduce under the frozen ID derivation regime: ${oldDerivation.cellId}`);
 const repairedGeometry=normalizeGeometry({type:'Polygon',coordinates:[[CAN_B,...ring.slice(1,-2),CAN_B]]}),newDerivation=deriveCellIdentity({countryId:'CAN',geometry:repairedGeometry,parentKey:entry.parentKey,parentHash:parent.parentHash,candidateId,sourceVersion}),{sourceFeatureId,canonicalAtomKey,cellId}=newDerivation;if(catalog.entries.some((item,index)=>index!==catalogIndex&&item.id===cellId))throw Error('CAN overlap repair produced a duplicate cell ID');

 const oldMetrics=physicalMetrics(feature.geometry),metrics=physicalMetrics(repairedGeometry),vertexDelta=metrics.vertices-oldMetrics.vertices,edgeDelta=ringEdgeCount(repairedGeometry)-ringEdgeCount(feature.geometry),wedge=normalizeGeometry({type:'Polygon',coordinates:[[CAN_A,CAN_C,CAN_B,CAN_A]]}),wedgeAreaDegrees=Math.abs(signedArea(polygons(wedge)[0][0])),wedgeAreaKm2=physicalMetrics(wedge).areaKm2;
 if(!(wedgeAreaDegrees>0&&wedgeAreaDegrees<=COORDINATE_TOLERANCE_DEGREES&&p0.maximumDistance<=COORDINATE_TOLERANCE_DEGREES)||vertexDelta!==-1||edgeDelta!==-1)throw Error('CAN overlap repair exceeds the frozen numerical/structural bounds');
 const removedCoordinates=polygonClipping.difference(polygons(feature.geometry),polygons(repairedGeometry)),addedCoordinates=polygonClipping.difference(polygons(repairedGeometry),polygons(feature.geometry));if(removedCoordinates.length!==1||addedCoordinates.length!==0)throw Error('CAN overlap repair is not a strict one-wedge subtraction');
 const removedGeometry=normalizeGeometry({type:'Polygon',coordinates:removedCoordinates[0]});if(!equal(removedGeometry,wedge))throw Error('CAN overlap repair removed geometry other than the pinned wedge');

 const canNorth=singleDirectedSegment(geometry,CAN_A,CAN_B,'CAN A->B boundary'),usaNorth=singleDirectedSegment(usaGeometry,CAN_B,CAN_A,'USA B->A boundary'),usaSouth=singleDirectedSegment(usaGeometry,CAN_C,CAN_B,'USA C->B boundary'),repairedSouth=singleDirectedSegment({features:[{...feature,geometry:repairedGeometry}]},CAN_B,CAN_C,'repaired CAN B->C boundary');
 const usaOwners=[...new Map([usaNorth,usaSouth].map(match=>[match.cellId,match.feature])).values()],uncoveredWedge=polygonClipping.difference(polygons(wedge),...usaOwners.map(owner=>polygons(owner.geometry)));if(uncoveredWedge.length)throw Error('Removed CAN wedge is not completely covered by the witnessed USA cells');

 const provisionalCatalog={...catalog,entries:catalog.entries.slice()},provisionalFeatures=geometry.features.slice();provisionalCatalog.entries[catalogIndex]={...entry,id:cellId,areaKm2:metrics.areaKm2,diameterKm:metrics.diameterUpperBoundKm,bbox:metrics.bbox,centroid:metrics.centroid};provisionalFeatures[geometryIndex]={...feature,properties:{...feature.properties,cellId},geometry:repairedGeometry};
 const ordered=canonicalizeCountryOrder(provisionalCatalog,{...geometry,features:provisionalFeatures},generation,candidateId,sourceVersion,cellId),cellRoot=digest(jsonBytes(ordered.catalog.entries.map(item=>item.id).sort(compareText))),ledger={kind:'fixed-p0-overlap-wedge-removal',countryId:'CAN',neighborCountryId:'USA',oldCellId:CAN_TARGET,newCellId:cellId,parentKey:entry.parentKey,oldTerritoryId:entry.oldTerritoryId,beforeGeometryHash:digest(jsonBytes(feature.geometry)),afterGeometryHash:digest(jsonBytes(repairedGeometry)),removedGeometryHash:digest(jsonBytes(wedge)),removedAreaDegrees:wedgeAreaDegrees,removedAreaKm2:wedgeAreaKm2,maximumBoundaryDisplacementDegrees:p0.maximumDistance,coordinateToleranceDegrees:COORDINATE_TOLERANCE_DEGREES,p0Witness:p0,sharedCellBoundaryWitness:{canNorthCellId:canNorth.cellId,canSouthCellId:cellId,usaNorthCellId:usaNorth.cellId,usaSouthCellId:usaSouth.cellId,northSegment:[CAN_A,CAN_B],southSegment:[CAN_B,CAN_C],repairedSouthSegmentIndex:repairedSouth.segmentIndex,usaCoversRemovedWedge:true},oldSourceFeatureId:oldDerivation.sourceFeatureId,sourceFeatureId,oldCanonicalAtomKey:oldDerivation.canonicalAtomKey,canonicalAtomKey,oldCatalogIndex:catalogIndex,newCatalogIndex:ordered.newIndex,canonicallyReorderedEntries:ordered.movedEntries,canonicalOrderHash:ordered.canonicalOrderHash,metricDeltas:{vertices:vertexDelta,edges:edgeDelta}};
 if(generation.metrics.vertexCount!==generation.validity?.counts?.vertices||!Number.isInteger(generation.metrics.edgeCount))throw Error('Pinned CAN generation metrics cannot accept the local repair deltas');
 const repairedGeneration={...generation,cellRoot,metrics:{...generation.metrics,vertexCount:generation.metrics.vertexCount+vertexDelta,edgeCount:generation.metrics.edgeCount+edgeDelta},validity:{...generation.validity,counts:{...generation.validity.counts,vertices:generation.validity.counts.vertices+vertexDelta}},topologySourceRepairs:[...(generation.topologySourceRepairs??[]),ledger]};
 return {catalog:ordered.catalog,geometry:ordered.geometry,generation:repairedGeneration,ledger,cellRoot,oldCellId:CAN_TARGET,newCellId:cellId,vertexDelta,edgeDelta,checks:{p0BilateralWitness:true,usaWedgeCoverage:true,cellIdDerivation:true,canonicalCellOrder:true,repairMetricDeltas:true}};
}

export function repairTopologySourceCatalog({outputBase='data/derived/prompt15',onProgress=console.log}={}){
 const pinned=assertSource(),sourceSummary=readJSON(`${SOURCE_ROOT}/summary.json`),sourceCatalogRoot=readJSON(`${SOURCE_ROOT}/catalog-root.json`),sourceProvenance=readJSON(`${SOURCE_ROOT}/provenance.json`),sourceLock=readJSON('data/source-locks/prompt14-derived-game-input-lock.json'),candidateId=sourceCatalogRoot.candidateId,sourceVersion=sourceLock.sourceVersion,p0=p0Witness(),rewrites=new Map(),windingItems=[];
 if(sourceSummary.schemaVersion!==TASK_15_19_VERSION||sourceCatalogRoot.schemaVersion!==TASK_15_19_VERSION||sourceProvenance.generatorVersion!==TASK_15_19_VERSION||sourceProvenance.policyVersion!==CELL_EXPERIMENT_POLICY.version||sourceSummary.candidate?.id!==candidateId)throw Error('Pinned source catalog generator/policy regime changed');
 for(const countryId of WINDING_REPAIRS.keys()){const source=readGzipJSON(`${SOURCE_ROOT}/countries/${countryId}/geometry.geojson.gz`),repair=repairWinding(countryId,source);rewrites.set(`countries/${countryId}/geometry.geojson.gz`,repair.geometry);windingItems.push(...repair.items);}
 const canCatalog=readGzipJSON(`${SOURCE_ROOT}/countries/CAN/catalog.json.gz`),canGeometry=readGzipJSON(`${SOURCE_ROOT}/countries/CAN/geometry.geojson.gz`),canGeneration=readGzipJSON(`${SOURCE_ROOT}/countries/CAN/generation.json.gz`),canTarget=canGeometry.features.find(feature=>feature.properties.cellId===CAN_TARGET);if(!canTarget)throw Error('Pinned CAN overlap cell is missing');if(windingDefects(canTarget.geometry))throw Error('CAN repair target has an unexpected winding defect');const canRepair=repairCanada(canCatalog,canGeometry,canGeneration,readGzipJSON(`${SOURCE_ROOT}/countries/USA/geometry.geojson.gz`),candidateId,sourceVersion,p0);rewrites.set('countries/CAN/catalog.json.gz',canRepair.catalog);rewrites.set('countries/CAN/geometry.geojson.gz',canRepair.geometry);rewrites.set('countries/CAN/generation.json.gz',canRepair.generation);
 const generator=fileIdentity('scripts/prompt15-repair-topology-source-catalog.mjs'),inputs=[pinned.indexIdentity,pinned.v19Identity,generator,fileIdentity('scripts/prompt15-world-catalog.mjs'),fileIdentity('scripts/prompt15-cell-core.mjs'),fileIdentity('scripts/prompt14-catalog-core.mjs'),fileIdentity('scripts/prompt14-catalog-topology.mjs'),fileIdentity('scripts/prompt15-cell-policy.mjs'),fileIdentity('data/derived/prompt14/shared-game-p0.geojson'),fileIdentity('data/source-locks/prompt14-derived-game-input-lock.json'),fileIdentity('package-lock.json')],runtime={node:process.version,v8:process.versions.v8,zlib:process.versions.zlib,platform:process.platform,arch:process.arch},repairIdentity={windingItems,overlap:canRepair.ledger},rootKey=hashCanonical(TOPOLOGY_SOURCE_REPAIR_VERSION,{sourceSchemaVersion:TASK_15_19_VERSION,inputs,runtime,repairIdentity}).slice(0,20),root=path.join(outputBase,`15-19-operational-catalog-v3-${rootKey}`),staging=path.join(outputBase,`.15-19-topology-source-repair-${rootKey}-${process.pid}`);if(fs.existsSync(root)||fs.existsSync(staging))throw Error(`Refusing to overwrite topology-source repair output: ${fs.existsSync(root)?root:staging}`);fs.mkdirSync(staging,{recursive:true});
 const artifacts=[],record=(relative,target)=>{const identity=fileIdentity(target);artifacts.push({path:slash(relative),sha256:identity.sha256,byteLength:identity.byteLength,compression:relative.endsWith('.gz')?'gzip':null});return identity;},write=(relative,value,compressed=false)=>{const target=path.join(staging,...relative.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,compressed?gzipSync(jsonBytes(value),{level:9,mtime:0}):jsonBytes(value),{flag:'wx'});return record(relative,target);};
 const rewrittenIdentities=new Map();for(const artifact of pinned.index.artifacts){if(['catalog-root.json','provenance.json','summary.json'].includes(artifact.path))continue;const target=path.join(staging,...artifact.path.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});if(rewrites.has(artifact.path))rewrittenIdentities.set(artifact.path,write(artifact.path,rewrites.get(artifact.path),true));else{fs.copyFileSync(path.join(SOURCE_ROOT,...artifact.path.split('/')),target,fs.constants.COPYFILE_EXCL);record(artifact.path,target);}}
 const countries=sourceSummary.countries.map(country=>{
  const changed=country.files.some(file=>rewrittenIdentities.has(file.path));if(!changed)return country;
  const files=country.files.map(file=>{const identity=rewrittenIdentities.get(file.path);return identity?{...file,sha256:identity.sha256,byteLength:identity.byteLength}:file;});
  if(country.countryId!=='CAN')return {...country,files};
  return {...country,cellRoot:canRepair.cellRoot,files,metrics:{...country.metrics,vertexCount:country.metrics.vertexCount+canRepair.vertexDelta,edgeCount:country.metrics.edgeCount+canRepair.edgeDelta}};
 });
 const counts={...sourceSummary.counts,vertices:sourceSummary.counts.vertices+canRepair.vertexDelta,edges:sourceSummary.counts.edges+canRepair.edgeDelta};
 const canonicalWinding=windingItems.length===[...WINDING_REPAIRS.values()].reduce((sum,count)=>sum+count,0)&&windingItems.every(item=>item.defects===1&&item.afterDefects===0&&typeof item.boundaryHash==='string');
 const checks={...sourceSummary.checks,canonicalWinding,...canRepair.checks,topologySourceRepair:Object.values(canRepair.checks).every(Boolean)};
 const status=Object.values(checks).every(Boolean)?'pass':'fail';
 const catalogRoot={...sourceCatalogRoot,countryRoots:{...sourceCatalogRoot.countryRoots,CAN:canRepair.cellRoot}};
 const provenance={task:'15-19',generatorVersion:TOPOLOGY_SOURCE_REPAIR_VERSION,sourceGeneratorVersion:TASK_15_19_VERSION,generator,command:'node scripts/prompt15-repair-topology-source-catalog.mjs',inputs,runtime,candidate:sourceSummary.candidate,policyVersion:sourceProvenance.policyVersion,sourceCatalogRoot:SOURCE_ROOT,reusePolicy:'The complete pinned V19 tree is rehashed. Unchanged artifacts are byte-copied; six cancellation-prone rings are re-normalized with boundary/area/vertex invariants and one exact CAN overlap wedge is removed only after bilateral P0 and USA-cell coverage witnesses pass.',repairs:repairIdentity,validationScope:'Generator-local repair assertions. Independent V19 verification is external and is not claimed by this immutable tree.',runtimeRegeneration:false,productionPublication:false,scope:'Offline immutable 15-19 topology-source repair only. Task 15-20 indices, render delivery, migration, runtime, API, browser and cutover are not executed.'};
 const summary={...sourceSummary,status,root:slash(root),checks,counts,countries,validation:{scope:'generator-local',sourceV19:pinned.v19Identity,independentV19:'external-required'},next:status==='pass'?'independent V19 verification required before 15-20':'15-19 topology-source repair rejected'};
 write('catalog-root.json',catalogRoot);write('provenance.json',provenance);write('summary.json',summary);const artifactIndex={schemaVersion:TASK_15_19_VERSION,root:slash(root),artifacts:artifacts.slice().sort((first,second)=>compareText(first.path,second.path)),totalByteLength:artifacts.reduce((sum,artifact)=>sum+artifact.byteLength,0),command:provenance.command};fs.writeFileSync(path.join(staging,'artifact-index.json'),jsonBytes(artifactIndex),{flag:'wx'});if(status!=='pass')throw Object.assign(Error('Topology-source catalog repair rejected'),{staging,summary});onProgress(`[topology-source repair] validated ${windingItems.length} winding fixes; publishing CAN ${canRepair.oldCellId} -> ${canRepair.newCellId}`);fs.renameSync(staging,root);return {root,summary,artifactIndexIdentity:fileIdentity(path.join(root,'artifact-index.json')),repairIdentity};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)try{const result=repairTopologySourceCatalog();console.log(JSON.stringify({status:result.summary.status,root:result.root,counts:result.summary.counts,artifactIndex:result.artifactIndexIdentity,repairs:result.repairIdentity,next:result.summary.next}));}catch(error){console.error(JSON.stringify({status:'fail',message:error.message,staging:error.staging??null}));process.exitCode=1;}
