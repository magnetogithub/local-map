import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {CANDIDATES,generatePartition,polygons,auditPartition,reconstructBoundaryCells,shapeMetrics} from './partition-prototype.mjs';

// Explicit offline reader. Every byte is read from the supplied candidate root;
// no historical product imports, generated coordinates, or source sub-windows.
export const RAW_PATH='data/raw/ne_10m_admin_1_states_provinces.geojson';
const LOCK_PATH='data/source-locks/prompt14-derived-game-input-lock.json';
export const pinFile=file=>{const b=fs.readFileSync(file);return {path:path.resolve(file),sha256:createHash('sha256').update(b).digest('hex'),byteLength:b.length};};
const smallWitnesses=[['SVN-Piran',['1159310877']],['SVN-Piran-Izola-common-boundary',['1159310877','1159310863']],
  ['KOR-Incheon-components',['1159312029']],['ESB-Dhekelia-hole',['1159315583']],['MWI-Likoma-islands',['1159317167']]];
const largeWitnesses=[['NOR-Troms',['1159309663']]];
const radians=Math.PI/180,A=6378137,E2=6.6943799901413165e-3;
const transform=(g,fn)=>({type:g.type,coordinates:g.type==='Polygon'?g.coordinates.map(r=>r.map(fn)):g.coordinates.map(p=>p.map(r=>r.map(fn)))});

function affine(features) {
  const points=features.flatMap(f=>polygons(f.geometry).flat(2)),xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const lo=Math.min(...ys),hi=Math.max(...ys),lon0=(Math.min(...xs)+Math.max(...xs))/2,lat0=(lo+hi)/2;
  const radii=lat=>{const phi=lat*radians,d=1-E2*Math.sin(phi)**2;return {x:A/Math.sqrt(d)*Math.cos(phi),y:A*(1-E2)/d**1.5};};
  const centre=radii(lat0),samples=[lo,hi,...(lo<=0&&hi>=0?[0]:[])].map(radii);
  const error=Math.max(...samples.flatMap(r=>[Math.abs(centre.x/r.x-1),Math.abs(centre.y/r.y-1)]));
  if(error>.005)throw new Error('UNCERTIFIED_AFFINE_CHART');
  return {features:features.map(f=>({...f,geometry:transform(f.geometry,([x,y])=>[(x-lon0)*radians*centre.x,(y-lat0)*radians*centre.y])})),
    projection:{unit:'metre',relativeErrorBound:error,scaleMin:1/(1+error),scaleMax:1/(1-error),id:'WGS84-local-affine-ellipsoidal-v1'}};
}

// Ellipsoidal tangent Lambert conformal conic. Analytic scale extrema cover
// the inverse image of the ENTIRE projected bounding rectangle, including all
// straight cell edges, not just the source's vertex latitudes.
function conic(features) {
  const e=Math.sqrt(E2),m=p=>Math.cos(p)/Math.sqrt(1-E2*Math.sin(p)**2);
  const t=p=>Math.tan(Math.PI/4-p/2)/((1-e*Math.sin(p))/(1+e*Math.sin(p)))**(e/2);
  const points=features.flatMap(f=>polygons(f.geometry).flat(2)),centre=points[0][0];
  const unwrap=x=>centre+((x-centre+540)%360)-180;
  const lons=points.map(p=>unwrap(p[0])),lats=points.map(p=>p[1]*radians);
  const lat0=(Math.min(...lats)+Math.max(...lats))/2,lon0=(Math.min(...lons)+Math.max(...lons))/2,n=Math.sin(lat0);
  if(Math.abs(n)<1e-4||Math.max(...lons)-Math.min(...lons)>25||Math.max(...lats)>=89*radians)throw new Error('UNSUPPORTED_COMPLETE_CHART');
  const F=m(lat0)/(n*t(lat0)**n),rho0=A*F*t(lat0)**n;
  const projected=features.map(f=>({...f,geometry:transform(f.geometry,([x,y])=>{
    const rho=A*F*t(y*radians)**n,theta=n*(unwrap(x)-lon0)*radians;
    return [rho*Math.sin(theta),rho0-rho*Math.cos(theta)];
  })}));
  const all=projected.flatMap(f=>polygons(f.geometry).flat(2));
  const b=[Math.min(...all.map(p=>p[0])),Math.min(...all.map(p=>p[1])),Math.max(...all.map(p=>p[0])),Math.max(...all.map(p=>p[1]))];
  const inverse=q=>{let phi=Math.PI/2-2*Math.atan(q);for(let k=0;k<15;k++)phi=Math.PI/2-2*Math.atan(q*((1-e*Math.sin(phi))/(1+e*Math.sin(phi)))**(e/2));return phi;};
  const dx=Math.max(b[0],0,-b[2]),dy=Math.max(b[1]-rho0,0,rho0-b[3]);
  const radii=[Math.hypot(dx,dy),Math.max(...[b[0],b[2]].flatMap(x=>[b[1],b[3]].map(y=>Math.hypot(x,y-rho0))))];
  const range=radii.map(r=>inverse((Math.sign(n)*r/(A*F))**(1/n))).sort((a,b)=>a-b);
  const scales=[...range,...(lat0>=range[0]&&lat0<=range[1]?[lat0]:[])].map(phi=>Math.abs(n*F*t(phi)**n/m(phi)));
  const scaleMin=Math.min(...scales)*(1-1e-12),scaleMax=Math.max(...scales)*(1+1e-12),shift=[(b[0]+b[2])/2,(b[1]+b[3])/2];
  return {features:projected.map(f=>({...f,geometry:transform(f.geometry,p=>[p[0]-shift[0],p[1]-shift[1]])})),
    projection:{unit:'metre',id:'WGS84-ellipsoidal-tangent-conic-v1',scaleMin,scaleMax,relativeErrorBound:Math.max(Math.abs(scaleMin-1),Math.abs(scaleMax-1)),lon0,lat0Degrees:lat0/radians,
      inverseLatitudeBoundsDegrees:range.map(p=>p/radians),scope:'complete source geometry and complete inverse bounding rectangle'}};
}

export function loadSamples(root,{full=false}={}) {
  root=path.resolve(root);
  const lockFile=path.join(root,LOCK_PATH),rawFile=path.join(root,RAW_PATH),rawPin=pinFile(rawFile),lock=JSON.parse(fs.readFileSync(lockFile,'utf8'));
  const pinned=lock.lineageInputs.find(p=>p.repositoryPath===RAW_PATH);
  if(!pinned||pinned.sha256!==rawPin.sha256||pinned.byteLength!==rawPin.byteLength)throw new Error('SOURCE_PIN_MISMATCH');
  const raw=JSON.parse(fs.readFileSync(rawFile,'utf8'));
  const samples=(full?largeWitnesses:smallWitnesses).map(([name,ids])=>{
    const original=ids.map(id=>{const matches=raw.features.filter(f=>String(f.properties.ne_id)===id);if(matches.length!==1)throw new Error('SOURCE_IDENTITY_MISSING_OR_DUPLICATED');return structuredClone(matches[0]);});
    const chart=(full?conic:affine)(original);
    return {name,original,rawSource:rawPin,projection:chart.projection,parents:chart.features.map(f=>({key:`${f.properties.adm0_a3}:${f.properties.ne_id}`,sourceCountryId:f.properties.adm0_a3,
      administrativeParent:{kind:'administrative-region',identity:{sourceCountryId:f.properties.adm0_a3,sourceVersion:lock.sourceVersion,level:1,sourceFeatureId:String(f.properties.ne_id)}},
      previousGeometryParent:{kind:'source-sample-only',migrationEvidence:false},geometry:f.geometry}))};
  });
  return {samples,sourceInputs:[rawPin,pinFile(lockFile)]};
}
export function reportTarget(root,argument,{directory=false}={}) {
  const reports=path.join(root,'.reports'),output=path.resolve(root,argument??''),rel=path.relative(reports,output);
  if(!argument||!rel||rel.startsWith('..')||path.isAbsolute(rel)||fs.existsSync(output))throw new Error('NEW_REPORT_PATH_REQUIRED');
  fs.mkdirSync(directory?output:path.dirname(output),{recursive:true});
  const physical=path.relative(fs.realpathSync(reports),fs.realpathSync(directory?output:path.dirname(output)));
  if(physical.startsWith('..')||path.isAbsolute(physical))throw new Error('REPORT_PATH_ESCAPE');
  return output;
}
export function measuredGeneration(sample,candidate,implementation) {
  const stages=[],start=performance.now(),result=generatePartition(sample.parents,{candidate,implementation,onStage:s=>stages.push(s)});
  return {result,stages,elapsedMs:performance.now()-start,sourceCode:pinFile(fileURLToPath(new URL('./partition-prototype.mjs',import.meta.url)))};
}
function prepareNegativeFixtures(samples,experiments) {
  const byName=name=>samples.find(s=>s.name===name),good=s=>experiments.find(e=>e.sample===s.name&&e.result.candidate==='grid').result.cells;
  const piran=byName('SVN-Piran'),cells=good(piran),cases=[];
  const capture=(name,s,c)=>{try{auditPartition(s.parents,c);cases.push({name,rejected:false});}catch(e){cases.push({name,rejected:true,error:e.message});}};
  capture('missing-cell',piran,cells.slice(1));
  capture('overlap',piran,[...structuredClone(cells),{...structuredClone(cells[0]),ordinal:cells.length}]);
  const moved=structuredClone(cells);moved[0].geometry.coordinates=moved[0].geometry.coordinates.map(r=>r.map(([x,y])=>[x+100000,y]));capture('cross-border',piran,moved);
  const wrong=structuredClone(cells);wrong[0].previousGeometryParent={kind:'substituted'};capture('parent-substitution',piran,wrong);
  const islands=byName('KOR-Incheon-components');capture('component-loss',islands,[{...structuredClone(good(islands)[0]),geometry:{type:'Polygon',coordinates:structuredClone(polygons(islands.parents[0].geometry)[0])}}]);
  const holes=byName('ESB-Dhekelia-hole');capture('hole-loss',holes,[{...structuredClone(good(holes)[0]),geometry:{type:'Polygon',coordinates:[structuredClone(polygons(holes.parents[0].geometry)[0][0])]}}]);
  const shape=(a,b,c,d)=>({type:'Polygon',coordinates:[[[a,b],[c,b],[c,d],[a,d],[a,b]]]}),parent={...piran.parents[0],geometry:shape(0,0,10000,5000)};
  const patch=[[0,0,10000,10],[0,10,5000,5000],[5000,10,10000,5000]].map((b,ordinal)=>({...cells[0],ordinal,geometry:shape(...b)}));
  const rebuilt=reconstructBoundaryCells([parent],patch);
  return {cases,reconstruction:{input:patch,parents:[parent],result:rebuilt,metrics:rebuilt.cells.map(c=>shapeMetrics(c.geometry))},
    verification:'Fixtures for real Vitest assertions; these preparation observations do not grant acceptance'};
}
function main() {
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),output=reportTarget(root,process.argv[2]),loaded=loadSamples(root),experiments=[],comparisons=[];
  for(const sample of loaded.samples)for(const candidate of CANDIDATES) {
    const before=measuredGeneration(sample,candidate,'reference-v2'),after=measuredGeneration(sample,candidate,'indexed-reconstruction');
    experiments.push({sample:sample.name,projection:sample.projection,result:after.result,elapsedMs:after.elapsedMs});
    comparisons.push({sample:sample.name,candidate,before:{stages:before.stages,elapsedMs:before.elapsedMs,cells:before.result.cells.length,slivers:before.result.slivers},
      after:{stages:after.stages,elapsedMs:after.elapsedMs,cells:after.result.cells.length,slivers:after.result.slivers}});
  }
  const preservation=prepareNegativeFixtures(loaded.samples,experiments);
  fs.writeFileSync(output,gzipSync(JSON.stringify({version:1,taskId:'15-13',sourceInputs:loaded.sourceInputs,experiments,comparisons,preservation,
    verification:'preparation only; controller owns Vitest',baseline:'reference-v2 lattice/polygonizer/merge; both variants use the current independent auditor'})),{flag:'wx'});
  process.stdout.write(JSON.stringify({output,comparisons})+'\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main();
