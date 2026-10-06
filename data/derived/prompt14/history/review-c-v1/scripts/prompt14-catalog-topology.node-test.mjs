import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {generateAtoms,normalizeGeometry} from './prompt14-catalog-core.mjs';
import {buildCatalogTopology} from './prompt14-catalog-topology.mjs';
import {buildCatalogArtifacts,compareCatalogDirectories,verifyCatalogArtifactBytes} from './prompt14-catalog-artifacts.mjs';
import {validateCaps} from './prompt14-source-gate.mjs';

const polygon=(x0,y0,x1,y1)=>({type:'Polygon',coordinates:[[[x0,y0],[x1,y0],[x1,y1],[x0,y1],[x0,y0]]]});
const feature=(country,id,geometry)=>({type:'Feature',properties:{countryId:country,sourceCountryId:country,sourceFeatureId:id,inputRole:'P1'},geometry});
const p0Feature=(country,geometry)=>({type:'Feature',properties:{countryId:country},geometry});
function fixture(){
  const selected={type:'FeatureCollection',features:[feature('AAA','a',polygon(0,0,10,10)),feature('AAA','b',polygon(10,0,20,10)),feature('BBB','c',polygon(20,0,30,10))]};
  return {lock:{sourceVersion:'pinned',license:'fixture',attribution:'fixture'},selected,
    p0:{type:'FeatureCollection',features:[p0Feature('AAA',polygon(0,0,20,10)),p0Feature('BBB',polygon(20,0,30,10))]}};
}
test('noding identifies administrative/country/coast boundaries and symmetric adjacency',()=>{
  const inputs=fixture(),atoms=generateAtoms(inputs),topology=buildCatalogTopology(atoms,inputs.p0);
  assert.equal(topology.evidence.completeBoundaryCoverage,true);assert.equal(topology.evidence.adjacencyPairs,2);
  assert.deepEqual(new Set(topology.edges.map(e=>e.boundaryClass)),new Set(['administrative','country','coast']));
  assert.equal(topology.edges.filter(e=>e.boundaryClass==='country').length,1);
  assert.equal(topology.edges.filter(e=>e.boundaryClass==='administrative').length,1);
});
test('partial shared segments are noded without point-only adjacency',()=>{
  const inputs=fixture();inputs.selected.features=[feature('AAA','a',polygon(0,0,10,10)),feature('AAA','b',polygon(10,0,20,5)),feature('AAA','c',polygon(10,5,20,10))];inputs.p0.features=[p0Feature('AAA',polygon(0,0,20,10))];
  const topology=buildCatalogTopology(generateAtoms(inputs),inputs.p0);
  assert.equal(topology.evidence.adjacencyPairs,3);assert.equal(topology.edges.filter(e=>e.boundaryClass==='administrative').length,3);
});
test('a tiny area gap cannot be reclassified as coast or hidden by an area tolerance',()=>{
  const inputs=fixture();inputs.selected.features[1].geometry=polygon(10.00000001,0,20,10);
  assert.throws(()=>buildCatalogTopology(generateAtoms(inputs),inputs.p0),/boundary certification failed/);
});
test('overlapping polygons with ambiguous sides fail instead of picking an owner',()=>{
  const inputs=fixture();inputs.selected.features.push(feature('AAA','duplicate',polygon(0,0,10,10)));
  assert.throws(()=>buildCatalogTopology(generateAtoms(inputs),inputs.p0),/boundary certification failed/);
});
test('hole coastline remains present and is not assigned to an invented territory',()=>{
  const geometry=normalizeGeometry({type:'Polygon',coordinates:[polygon(0,0,20,20).coordinates[0],polygon(5,5,10,10).coordinates[0]]});
  const inputs={lock:{sourceVersion:'pinned'},selected:{type:'FeatureCollection',features:[feature('AAA','a',geometry)]},p0:{type:'FeatureCollection',features:[p0Feature('AAA',geometry)]}};
  const topology=buildCatalogTopology(generateAtoms(inputs),inputs.p0);
  assert.equal(topology.edges.length,2);assert.equal(topology.evidence.adjacencyPairs,0);assert.equal(topology.evidence.coastSegments,8);
});
test('world/country/vertex hard caps fail independently',()=>{
  for(const [total,count,vertices]of [[6001,1,4],[1,513,4],[1,1,2000001]])assert.equal(validateCaps({totalAtoms:total,countries:[{countryId:'AAA',atomCount:count}]},vertices).pass,false);
});
test('vector artifacts replay byte-identically and retain canonical feature IDs; tampering fails',()=>{
  fs.mkdirSync('.tmp/prompt14-catalog',{recursive:true});const dir=fs.mkdtempSync(path.resolve('.tmp/prompt14-catalog/fixture-'));
  const inputs=fixture(),atoms=generateAtoms(inputs),options={atoms,inputs,validation:{pass:true},generatorFiles:[],maxZoom:6};
  const first=buildCatalogArtifacts({...options,output:path.join(dir,'first')}),second=buildCatalogArtifacts({...options,output:path.join(dir,'second')});
  assert.deepEqual(first,second);assert.equal(first.renderArtifactCount,5461);assert.equal(first.decodedCanonicalFeatureIds.territories,3);
  assert.equal(compareCatalogDirectories(path.join(dir,'first'),path.join(dir,'second')).pass,true);
  const tile=path.join(dir,'first',`public/data/territory-catalog/${first.ref.catalogVersion}/tiles/0/0/0.pbf`);fs.appendFileSync(tile,'tamper');
  assert.throws(()=>verifyCatalogArtifactBytes(path.join(dir,'first')),/bytes mismatch/);
});
