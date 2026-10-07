import test from 'node:test';
import assert from 'node:assert/strict';
import {validateArchive,validateMembership,validateRealization} from './prompt15-r3-validation.mjs';
import {validatePositiveGeometry} from './prompt15-r3-validity.mjs';
import {readJSON} from './prompt15-cell-core.mjs';
import {withIndexedPolygonLocation} from './prompt15-r3-indexed-location.mjs';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import {partitionCountry} from './prompt15-r3-input.mjs';
const base='reports/prompt15/review-c-r3/first';
const input=readJSON(`${base}/inputs/ALD.json`),summary=readJSON(`${base}/mesh/ALD/summary.json`),cells=summary.chunks.flatMap(c=>readJSON(`${base}/${c.path}`)),old=readJSON(`${base}/old-protected.geojson`).features.filter(f=>f.properties.sourceCountryId==='ALD'),sourceVersion=readJSON('data/source-locks/prompt14-derived-game-input-lock.json').sourceVersion;
const shift=g=>({...g,coordinates:g.coordinates.map(function move(a){return typeof a[0]==='number'?[a[0]+.01,a[1]]:a.map(move);})});
test('all upstream identities, names, original polygons and holes survive; deletion rejected',()=>{
 const raw=readJSON(`${base}/source-original.geojson`),records=readJSON(`${base}/source-records.json`);
 assert.equal(validateArchive(raw,records).pass,true);
 assert.equal(validateArchive(raw,records.slice(1)).pass,false);
});
test('actual ALD cells preserve protected parents and active geometry; moving an outside component inside rejected',()=>{
 assert.equal(validateRealization(input,cells,old,sourceVersion).pass,true);
 const moved=structuredClone(input),record=moved.gameRegions.find(r=>r.active),outside=readJSON(`${base}/inputs/FSM.json`).gameRegions.find(r=>r.components.some(c=>c.status==='outside-game'));
 assert.ok(outside,'actual FSM original outside component exists');
 const raw=readJSON(`${base}/source-original.geojson`).features.find(f=>String(f.properties.ne_id)===outside.id),index=outside.components.find(c=>c.status==='outside-game').index;
 const component=raw.geometry.type==='Polygon'?raw.geometry.coordinates:raw.geometry.coordinates[index],target=cells[0].metrics.centroid,origin=component[0][0],relocated=component.map(r=>r.map(p=>[p[0]-origin[0]+target[0],p[1]-origin[1]+target[1]]));
 record.geometry={type:'MultiPolygon',coordinates:[...(record.geometry.type==='Polygon'?[record.geometry.coordinates]:record.geometry.coordinates),relocated]};
 const rejected=validateRealization(moved,cells,old,sourceVersion);assert.equal(rejected.pass,false);assert.ok(rejected.errors.includes('active-game-union'));
});
test('actual protected-parent boundary intrusion rejected',()=>{
 const changed=structuredClone(cells);changed[0].geometry=shift(changed[0].geometry);
 const rejected=validateRealization(input,changed,old,sourceVersion);assert.equal(rejected.pass,false);assert.ok(rejected.errors.includes('protected-parent-crossing'));
});
test('missing active membership and residual disguised as admin rejected',()=>{
 const catalog=cells,members=input.gameRegions.map(r=>({countryId:'ALD',adminId:r.id,active:r.active,gameGeometryHash:r.gameGeometryHash,sourceGeometryHash:r.sourceGeometryHash,cellOrdinals:catalog.flatMap((c,i)=>c.adminId===r.id?[i+1]:[])})),residual=[{sourceCountryId:'ALD',administrativeIdentity:null,cellOrdinals:catalog.flatMap((c,i)=>c.adminId===null?[i+1]:[])}];
 assert.equal(validateMembership(catalog,members,residual,input.gameRegions).pass,true);
 const missing=structuredClone(members);missing.find(m=>m.cellOrdinals.length).cellOrdinals.pop();const rejected=validateMembership(catalog,missing,residual,input.gameRegions);assert.equal(rejected.pass,false);assert.ok(rejected.errors.includes('active-membership-omission'));
 assert.ok(residual[0].cellOrdinals.length);const falseAdmin=structuredClone(residual);falseAdmin[0].administrativeIdentity=members[0].adminId;const falseClaim=validateMembership(catalog,members,falseAdmin,input.gameRegions);assert.equal(falseClaim.pass,false);assert.ok(falseClaim.errors.includes('residual-false-administration'));
});
test('strict positive microscopic rings retained; zero area, self intersection and escaped holes rejected',()=>{
 const polygon=r=>({type:'Polygon',coordinates:[r]}),tiny=polygon([[120,30],[120+1e-10,30],[120+1e-10,30+1e-10],[120,30+1e-10],[120,30]]);
 assert.equal(validatePositiveGeometry([tiny]).pass,true);
 assert.equal(validatePositiveGeometry([polygon([[0,0],[1,0],[2,0],[0,0]])]).pass,false);
 assert.equal(validatePositiveGeometry([polygon([[0,0],[2,2],[0,2],[2,0],[0,0]])]).pass,false);
 assert.equal(validatePositiveGeometry([{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]],[[2,2],[2,3],[3,3],[3,2],[2,2]]]}]).pass,false);
});
test('indexed polygon scan preserves real Antarctica/Canada and exact boundary/hole semantics; scope restored',()=>{
 const features=readJSON(`${base}/fixed-p0.geojson`).features.filter(f=>['ATA','CAN'].includes(f.properties.countryId)),reader=new GeoJSONReader(),locator=new PointLocator(),original=PointLocator.prototype.locateInPolygon;
 for(const f of features){const g=reader.read(f.geometry),points=g.getCoordinates().filter((_,i)=>i%1000===0).map(c=>new Coordinate(c.x,c.y));points.push(new Coordinate(0,0),new Coordinate(-180,-90),new Coordinate(-90,60));const expected=points.map(p=>locator.locate(p,g)),actual=withIndexedPolygonLocation(()=>points.map(p=>locator.locate(p,g)));assert.deepEqual(actual,expected);assert.equal(PointLocator.prototype.locateInPolygon,original);}
 assert.throws(()=>withIndexedPolygonLocation(()=>{throw Error('fixture');}),/fixture/);assert.equal(PointLocator.prototype.locateInPolygon,original);
});
test('an identity wholly outside fixed P0 remains inactive with null game geometry and empty membership',()=>{
 const csi=readJSON(`${base}/inputs/CSI.json`),region=csi.gameRegions[0],index=region.components.find(c=>c.status==='outside-game').index,feature=readJSON(`${base}/source-original.geojson`).features.find(f=>String(f.properties.ne_id)===region.id),geometry={type:'Polygon',coordinates:feature.geometry.coordinates[index]},outsideIdentity={...feature,geometry},original=JSON.stringify(outsideIdentity),parents=readJSON(`${base}/old-protected.geojson`).features.filter(f=>f.properties.sourceCountryId==='CSI');
 const result=partitionCountry(csi.envelope,[outsideIdentity],parents);assert.equal(result.unresolved.length,0);assert.equal(result.coverage.pass,true);assert.equal(result.gameRegions[0].active,false);assert.equal(result.gameRegions[0].geometry,null);assert.ok(result.partitions.every(p=>p.adminId===null));assert.equal(JSON.stringify(outsideIdentity),original);
});
