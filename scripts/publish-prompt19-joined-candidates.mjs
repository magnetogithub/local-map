// Coordinator C publishes country evidence from the already verified joint assembly.
import fs from 'node:fs';
import {digest,jsonBytes,geometryMetadata} from './prompt14-catalog-core.mjs';
import {globalCellId} from './prompt19-joined-topology.mjs';
const read=f=>JSON.parse(fs.readFileSync(f)),bundle=read('reports/maintenance/prompt19-C/joined-world-input.json');
const cells=read('reports/maintenance/prompt19-C/joint-arrangement-cells.geojson').features;
const all=new Map(cells.map(f=>[globalCellId(f),f])),records=new Map(bundle.records.map(r=>[r.id,r]));
if(bundle.report.invalid.length||bundle.report.unresolved.length||!bundle.report.topology.pass)throw Error('JOINED_ASSEMBLY_FAILED');
const published={};
for(const countryId of['KOR','PRK']){
  const selected=cells.filter(f=>f.properties.countryId===countryId),ids=new Set(selected.map(globalCellId));
  const edges=bundle.edges.filter(e=>ids.has(e.leftTerritoryId)||ids.has(e.rightTerritoryId)).map(e=>{
    const forward=ids.has(e.leftTerritoryId),left=forward?e.leftTerritoryId:e.rightTerritoryId,right=forward?e.rightTerritoryId:e.leftTerritoryId;
    const geometry={type:'LineString',coordinates:forward?e.geometry.coordinates:[...e.geometry.coordinates].reverse()};
    const row={leftLocalId:all.get(left).id,rightLocalId:ids.has(right)?all.get(right).id:null,
      externalCountryId:right&&!ids.has(right)?records.get(right).countryId:null,externalLocalId:right&&!ids.has(right)?all.get(right)?.id??null:null,
      boundaryClass:e.boundaryClass,geometry};
    return {id:`${countryId}:edge:${digest(jsonBytes(row))}`,...row};
  });
  const adjacency=Object.fromEntries(selected.map(f=>[f.id,[]]));
  for(const e of edges)if(e.rightLocalId){adjacency[e.leftLocalId].push(e.rightLocalId);adjacency[e.rightLocalId].push(e.leftLocalId);}
  for(const[id,ns]of Object.entries(adjacency)){adjacency[id]=[...new Set(ns)].sort();for(const n of ns)if(!adjacency[n].includes(id))throw Error('ASYMMETRIC_LOCAL_ADJACENCY');}
  const identity=file=>{const b=fs.readFileSync(file);return{path:file,sha256:digest(b),byteLength:b.length};};
  const validation={schemaVersion:'prompt19-country-arrangement-validation-v2',countryId,pass:true,operationalReady:true,worldCoverageComplete:true,
    fineAssignmentComplete:false,summary:bundle.report.summary.find(s=>s.countryId===countryId),sourceTrace:bundle.report.sourceTrace.filter(s=>s.countryId===countryId),
    topology:bundle.report.topology,geometry:geometryMetadata({type:'MultiPolygon',coordinates:selected.flatMap(f=>f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.coordinates)}),
    coarseResiduals:bundle.report.evidence.canonicalResiduals.filter(f=>f.countryId===countryId),
    limits:'Operational land coverage passes. Source-free fixed P0 faces remain explicitly coarse; this is not complete ADM2/3 coverage or certified 2020 boundaries.'};
  const contents={'cells.geojson':{type:'FeatureCollection',features:selected},'topology.json':{edges,adjacency},'validation.json':validation,
    'manifest.json':{schemaVersion:'prompt19-country-arrangement-candidate-v2',countryId,sourceLock:identity(`data/source-locks/prompt19/${countryId}.json`),
      globalOrdinalsAssigned:false,runtimePublication:false,coordinator:'C',baseline:identity('data/derived/prompt19/baseline-v1/artifact-index.json'),
      method:'Exact joint noding and polygonized face membership. No source snapping, external boundary movement, extrapolated lines or invented administrative identities.'}};
  const key=digest(jsonBytes(contents)).slice(0,20),root=`data/derived/prompt19/candidates/${countryId}/joined-v2-${key}`;
  const artifacts=[];
  if(!fs.existsSync(root)){fs.mkdirSync(root,{recursive:true});for(const[file,value]of Object.entries(contents)){const bytes=jsonBytes(value);fs.writeFileSync(`${root}/${file}`,bytes,{flag:'wx'});artifacts.push({path:file,sha256:digest(bytes),byteLength:bytes.length});}fs.writeFileSync(`${root}/artifact-index.json`,jsonBytes({schemaVersion:'prompt19-country-arrangement-candidate-v2',artifacts}),{flag:'wx'});}
  for(const a of read(`${root}/artifact-index.json`).artifacts){const b=fs.readFileSync(`${root}/${a.path}`);if(b.length!==a.byteLength||digest(b)!==a.sha256)throw Error('CANDIDATE_ARTIFACT_CHANGED');}
  published[countryId]={root,artifactIndex:identity(`${root}/artifact-index.json`),cells:selected.length,coarseResidualCells:validation.summary.coarseResidualCells,worldCoverageComplete:true,fineAssignmentComplete:false};
}
fs.writeFileSync('reports/maintenance/prompt19-C/published-candidates.json',jsonBytes(published));console.log(JSON.stringify(published));
