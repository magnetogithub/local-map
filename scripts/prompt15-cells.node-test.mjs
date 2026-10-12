import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {physicalAreaKm2,physicalMetrics,latitudeGrid,readJSON,graphSelection} from './prompt15-cell-core.mjs';
const polygon=ring=>({type:'Polygon',coordinates:[ring]});
test('spherical physical measurements handle equator, hole, polar cap and high latitudes',()=>{
 const square=polygon([[0,0],[1,0],[1,1],[0,1],[0,0]]),expected=P.earthRadiusKm**2*Math.PI/180*Math.sin(Math.PI/180);
 assert.ok(Math.abs(physicalAreaKm2(square)-expected)<expected*1e-12);
 const cap=polygon([[-180,-80],[-60,-80],[60,-80],[180,-80],[180,-90],[-180,-90],[-180,-80]]);
 const capExpected=2*Math.PI*P.earthRadiusKm**2*(1-Math.sin(80*Math.PI/180));
 assert.ok(Math.abs(physicalAreaKm2(cap)-capExpected)<capExpected*1e-12);
 const hole={...square,coordinates:[square.coordinates[0],[[.2,.2],[.2,.8],[.8,.8],[.8,.2],[.2,.2]]]};
 assert.ok(physicalAreaKm2(hole)<physicalAreaKm2(square));
 const grid=latitudeGrid(12);for(const latitude of [-89.9,0,80]){const row=Math.floor((latitude+90)/grid.dy),columns=grid.columns(row),south=-90+row*grid.dy,north=south+grid.dy;
  const cell=polygon([[-180,south],[-180+360/columns,south],[-180+360/columns,north],[-180,north],[-180,south]]);
  assert.ok(physicalMetrics(cell).diameterUpperBoundKm<19);
 }
});
function load(country){const d=`reports/prompt15/cell-experiments/adaptive-12-24/${country}/first/`,membership=readJSON(d+'membership.json'),measurements=readJSON(d+'cell-measurements.json');return {cells:measurements,parents:membership,topology:readJSON(d+'topology.json'),summary:readJSON(d+'summary.json')};}
test('real national front uses the cell belonging to the actual source edge; geometry IDs are not enumeration offsets',()=>{
 for(const country of ['KOR','PRK']){const r=load(country),byId=new Map(r.cells.map(c=>[c.id,c]));
  assert.ok(r.summary.behavior.frontierCellIds.length>1);
  for(const id of r.summary.behavior.frontierCellIds){const c=byId.get(id);assert.ok(c.refined);assert.ok(c.diameterUpperBoundKm<=P.boundaryMaximumDiameterKm);}
  const scenario=r.summary.behavior.scenarios.find(s=>s.kind==='national-frontier'&&s.neighbor===(country==='KOR'?'PRK':'KOR'));
  assert.ok(scenario.sameParentOccupiedAndUnoccupied&&scenario.secondTouchesCurrentFront&&scenario.firstSecondDisjoint);
  assert.ok(scenario.ranges.near.ids.every(id=>scenario.ranges.limited.ids.includes(id)));
 }
});
test('graph scope is connected, cap overflow is rejected in full, and per-game controller state stays isolated',()=>{
 const r=load('KAZ'),scenario=r.summary.behavior.scenarios.find(s=>s.kind==='internal-frontier'),occupied=new Set(scenario.initialControlledIds),seeds=r.topology.adjacency[scenario.initialControlledIds[0]];
 const near=graphSelection(r,seeds,scenario.anchor,P.ranges.near,occupied);
 assert.equal(near.status,'pass');assert.ok(near.ids.every(id=>!occupied.has(id)));
 const selected=new Set(near.ids),reachable=new Set([near.ids[0]]),queue=[near.ids[0]];
 while(queue.length)for(const n of r.topology.adjacency[queue.pop()])if(selected.has(n)&&!reachable.has(n)){reachable.add(n);queue.push(n);}
 assert.equal(reachable.size,selected.size);
 const huge=graphSelection(r,seeds,scenario.anchor,{depthKm:5000,widthKm:10000,maximumAreaKm2:1e12},occupied);
 assert.equal(huge.status,'cap-exceeded');assert.ok(huge.count>P.lookupCap);assert.equal(huge.ids.length,huge.count);
 const changed=new Set([...occupied,...near.ids]),next=graphSelection(r,seeds,scenario.anchor,P.ranges.near,changed);
 assert.ok(next.ids.every(id=>!changed.has(id)));
 assert.deepEqual(graphSelection(r,seeds,scenario.anchor,P.ranges.near,occupied).ids,near.ids);
});
test('all selected sample geometry/topology/membership/render bytes reproduce in fresh processes',()=>{
 for(const country of P.representativeCountries){const d=`reports/prompt15/cell-experiments/adaptive-12-24/${country}/`;
  const a=readJSON(d+'first/summary.json'),b=readJSON(d+'second/summary.json');
  assert.equal(a.status,'pass',`${country}: ${JSON.stringify(a.checks)}`);assert.equal(b.status,'pass');
  assert.deepEqual(a.deterministicRoots,b.deterministicRoots);
  for(const name of ['geometry.geojson','topology.json','membership.json','cell-measurements.json'])assert.ok(fs.readFileSync(d+'first/'+name).equals(fs.readFileSync(d+'second/'+name)));
 }
});
