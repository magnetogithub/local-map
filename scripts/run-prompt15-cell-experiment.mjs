import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import geojsonVt from 'geojson-vt';
import {fromGeojsonVt} from '@maplibre/vt-pbf';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {loadExperimentSources,generateCountryCells,behaviorExperiments,fileIdentity,readJSON} from './prompt15-cell-core.mjs';
import {jsonBytes,digest} from './prompt14-catalog-core.mjs';
import {DELIVERY_POLICY} from './prompt14-source-gate.mjs';
const country=process.argv[2],candidate=P.candidates.find(c=>c.id===process.argv[3]),run=process.argv[4]??'first';
if(!P.representativeCountries.includes(country)||!candidate||!['first','second'].includes(run))throw Error('Unknown experimental input');
const review=readJSON('reports/prompt15/15-REVIEW-A.json');if(review.status!=='pass')throw Error('REVIEW A required');
const policyPath='reports/prompt15/15-03-predeclared-policy.json';
if(!fs.existsSync(policyPath))fs.writeFileSync(policyPath,jsonBytes(P));
if(!fs.readFileSync(policyPath).equals(jsonBytes(P)))throw Error('Predeclared policy changed');
const dir=`reports/prompt15/cell-experiments/${candidate.id}/${country}/${run}`;fs.mkdirSync(dir,{recursive:true});
if(fs.existsSync(path.join(dir,'failure.json'))){let n=1;while(fs.existsSync(path.join(dir,`implementation-attempt-${n}-failure.json`)))n++;fs.renameSync(path.join(dir,'failure.json'),path.join(dir,`implementation-attempt-${n}-failure.json`));}
const executionInputs=[policyPath,'scripts/prompt15-cell-policy.mjs','scripts/prompt15-cell-core.mjs','scripts/prompt15-cell-resources.mjs','scripts/run-prompt15-cell-experiment.mjs',
 'data/derived/prompt14/shared-game-p0.geojson','data/derived/prompt14/selected-game-input.geojson','reports/prompt15/candidates/SVN-first.json','reports/prompt15/candidates/DNK-first.json'].map(fileIdentity);
const artifacts=[];
const write=(name,data)=>{const p=path.join(dir,name);fs.writeFileSync(p,jsonBytes(data));const a=fileIdentity(p);artifacts.push(a);return a;};
const start=performance.now(),sources=loadExperimentSources();
try{
 const result=generateCountryCells(sources,country,candidate,console.log),behavior=behaviorExperiments(result,sources);
 const cellById=new Map(result.cells.map(c=>[c.id,c]));
 const cellFeatures={type:'FeatureCollection',features:result.cells.map((c,i)=>({type:'Feature',id:i+1,properties:{territoryId:c.id,sourceCountryId:c.countryId,parentKey:c.parentKey,syntheticOperational:true},geometry:c.geometry}))};
 const edgeFeatures={type:'FeatureCollection',features:result.topology.edges.map((e,i)=>({type:'Feature',id:i+1,properties:{edgeId:e.id,leftTerritoryId:e.leftTerritoryId,rightTerritoryId:e.rightTerritoryId??'',boundaryClass:e.rightTerritoryId&&cellById.get(e.leftTerritoryId).parentKey===cellById.get(e.rightTerritoryId).parentKey?'operational':e.boundaryClass},geometry:e.geometry}))};
 const ordinalById=new Map(result.cells.map((c,i)=>[c.id,i+1]));
 const compactCells={...cellFeatures,features:cellFeatures.features.map(f=>({...f,properties:{}}))};
 const compactEdges={...edgeFeatures,features:edgeFeatures.features.map(f=>({...f,properties:{l:ordinalById.get(f.properties.leftTerritoryId),r:ordinalById.get(f.properties.rightTerritoryId)??0,c:['coast','country','administrative','operational'].indexOf(f.properties.boundaryClass)}}))};
 const cellsArtifact=write('geometry.geojson',cellFeatures),topologyArtifact=write('topology.json',result.topology),membership=write('membership.json',result.parents.map(p=>({...p,cellIds:result.cells.filter(c=>c.parentKey===p.parentKey).map(c=>c.id).sort()})));
 const tileOptions={...DELIVERY_POLICY.tileOptions,promoteId:null,generateId:false,maxZoom:6};
 const cellIndex=geojsonVt(compactCells,tileOptions),edgeIndex=geojsonVt(compactEdges,tileOptions);
 const tiles=[],seen=new Set(),countsByZoom=[];let totalBytes=0,maximumTileBytes=0;
 for(let z=0;z<=6;z++){let count=0,bytesAtZoom=0;for(let x=0;x<2**z;x++)for(let y=0;y<2**z;y++){
  const territories=cellIndex.getTile(z,x,y),edges=edgeIndex.getTile(z,x,y);if(!territories&&!edges)continue;
  const b=Buffer.from(fromGeojsonVt({...(territories?{territories}:{}),...(edges?{edges}:{})},{version:2,extent:DELIVERY_POLICY.tileOptions.extent}));
  const p=path.join(dir,`tiles/${z}/${x}/${y}.pbf`);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,b);
  const id=fileIdentity(p);tiles.push(id);totalBytes+=b.length;bytesAtZoom+=b.length;maximumTileBytes=Math.max(maximumTileBytes,b.length);count++;
  const tile=new VectorTile(new PbfReader(b)),layer=tile.layers.territories;if(layer)for(let i=0;i<layer.length;i++){const f=layer.feature(i);if(!Number.isInteger(f.id)||f.id<1||f.id>result.cells.length)throw Error('Invalid render ordinal');seen.add(result.cells[f.id-1].id);}
 }countsByZoom.push({zoom:z,tiles:count,bytes:bytesAtZoom});}
 const renderArtifact=write('render-index.json',{tiles,countsByZoom,policy:tileOptions,totalBytes,maximumTileBytes,decodedUniqueCellIds:seen.size,transport:'Positive feature.id ordinal bound to immutable catalog order; canonical IDs remain in catalog/metadata. Edge l/r ordinals and c class enum. No repeated SHA strings in each PBF feature.',territoryOrder:result.cells.map(c=>c.id),edgeOrder:result.topology.edges.map(e=>e.id)});
 const physical=write('cell-measurements.json',result.cells.map(c=>({id:c.id,parentKey:c.parentKey,componentIndex:c.componentIndex,sourceTiny:c.sourceTiny,refined:c.refined,areaKm2:c.areaKm2,diameterUpperBoundKm:c.diameterUpperBoundKm,aspectRatio:c.aspectRatio,centroid:c.centroid,bbox:c.bbox,planarArea:c.area,vertices:c.vertices})));
 const resourceRun=spawnSync(process.execPath,['--expose-gc','scripts/prompt15-cell-resources.mjs',physical.path,country],{encoding:'utf8'});
 if(resourceRun.status!==0)throw Error(`Resource proxy failed: ${resourceRun.stderr}`);
 const proxy=JSON.parse(resourceRun.stdout);if(!(proxy.retainedHeapBytes>0))throw Error('Nonpositive resource measurement');
 const frontierSet=new Set(behavior.frontierCellIds),borderCells=result.cells.filter(c=>frontierSet.has(c.id));
 const maxBorderDiameterKm=borderCells.length?Math.max(...borderCells.map(c=>c.diameterUpperBoundKm)):0,maxBorderAreaKm2=borderCells.length?Math.max(...borderCells.map(c=>c.areaKm2)):0;
 const largeFractions=behavior.scenarios.flatMap(s=>s.ranges.near.parentAreaFractions??[]).filter(p=>p.parentAreaKm2>=P.sufficientlyLargeAdministrativeAreaKm2);
 const checks={validGeometry:result.validity.pass,parentCoverage:result.coverage.every(c=>c.pass),countryCoverage:result.countryCoverage.pass,
  allSourceParentsPreserved:result.parents.every(p=>p.cellCount>0),sourceComponentsPreserved:result.parents.every(p=>new Set(result.cells.filter(c=>c.parentKey===p.parentKey).map(c=>c.componentIndex)).size===p.sourceComponents),
  topology:result.topology.evidence.completeBoundaryCoverage&&result.topology.evidence.symmetricAdjacency,
  interiorDiameter:result.metrics.maxDiameterKm<=P.interiorMaximumDiameterKm,interiorArea:result.metrics.maxAreaKm2<=P.interiorMaximumAreaKm2,
  borderDiameter:maxBorderDiameterKm<=P.boundaryMaximumDiameterKm,borderArea:maxBorderAreaKm2<=P.boundaryMaximumAreaKm2,
  advanceResolutionRatio:result.metrics.maxDiameterKm/P.representativeAdvanceDepthKm<=P.maximumDiameterToAdvanceDepthRatio,
  sliverCount:result.metrics.nonSourceTinySliverFraction<=P.sliver.maximumNonSourceTinyCellFraction,sliverArea:result.metrics.sliverAreaFraction<=P.sliver.maximumSliverAreaFraction,
  countryCells:result.cells.length<=P.budgets.countryCells,rss:process.memoryUsage().rss<=P.budgets.offlineCountryRssBytes,
  nearSuccess:behavior.scenarios.every(s=>s.ranges.near.status==='pass'||(result.parents.every(p=>p.metrics.diameterUpperBoundKm<=P.interiorMaximumDiameterKm)&&s.ranges.near.status==='empty')),
  largeParentNearFraction:largeFractions.every(p=>p.occupiedAreaKm2/p.parentAreaKm2<=P.nearMaximumParentAreaFraction),
  interiorAdvance:behavior.scenarios.filter(s=>s.kind==='internal-frontier'&&s.parentAreaKm2>=P.sufficientlyLargeAdministrativeAreaKm2).every(s=>s.limitedHasSeveralDepthSteps&&s.nearLeavesInterior),
  secondAdvance:behavior.scenarios.filter(s=>s.kind==='national-frontier').every(s=>s.firstSecondDisjoint&&s.secondTouchesCurrentFront&&s.sameParentOccupiedAndUnoccupied),
  renderIds:seen.size===result.cells.length};
 const nearPayloadBytes=Math.max(0,...behavior.scenarios.map(s=>Buffer.byteLength(JSON.stringify({catalogRevision:'experimental',worldRevision:0,cellIds:s.ranges.near.ids,effectTarget:{territoryIds:s.ranges.near.ids},parentKeys:s.ranges.near.parentAreaFractions?.map(p=>p.parentKey)??[]}))));
 checks.nearProviderPayload=nearPayloadBytes<=P.budgets.nearProviderPayloadBytes;
 write('summary.json',{status:Object.values(checks).every(Boolean)?'pass':'fail',candidate,countryId:country,checks,metrics:result.metrics,maxBorderDiameterKm,maxBorderAreaKm2,nearPayloadBytes,proxy,behavior,coverage:result.coverage,countryCoverage:result.countryCoverage,validity:result.validity,numericalNoding:{maximumNodedSegmentDisplacement:result.numericalNoding.maximumNodedSegmentDisplacement,insertedNodes:result.numericalNoding.insertedNodes},
  render:{totalBytes,maximumTileBytes,decodedCellIds:seen.size,tileCount:tiles.length},deterministicRoots:{geometry:cellsArtifact.sha256,topology:topologyArtifact.sha256,membership:membership.sha256,render:digest(jsonBytes(tiles.map(t=>({...t,path:path.relative(dir,t.path).split(path.sep).join('/')})))),measurements:physical.sha256},
  artifacts:[cellsArtifact,topologyArtifact,membership,renderArtifact,physical],inputs:executionInputs,tools:{node:process.version,polygonClipping:readJSON('node_modules/polygon-clipping/package.json').version,jsts:readJSON('node_modules/jsts/package.json').version},totalElapsedMs:performance.now()-start,memory:process.memoryUsage(),scope:'Offline country candidate geometry/graph/render experiment; no production tool/migration/runtime cutover'});
 console.log(JSON.stringify({country,candidate:candidate.id,checks,status:Object.values(checks).every(Boolean)?'pass':'fail',cells:result.cells.length}));
}catch(e){write('failure.json',{status:'fail',country,candidate,message:e.message,evidence:e.evidence??null,elapsedMs:performance.now()-start,memory:process.memoryUsage()});console.error(e.stack);process.exitCode=1;}
