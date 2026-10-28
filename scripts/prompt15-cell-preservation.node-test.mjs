import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {cellPreservationGate,nodePreservingCellRings,originalGridFaceOwner,exactRingSign,mergePrecisionFragileCells,certifiedSourceGapFace,positiveIntersectionSupport,buildPreservedCellTopology,arrangePreservingCellFaces,arrangeCountrySourceFaces,orderedSourceRingCertificate,componentBoundaryCorrespondence,certifySourceConstraint} from './prompt15-cell-preservation.mjs';
import {geometryHash,union,intersection,overlayArea,partitionCoverage} from './prompt15-preservation-audit-core.mjs';
import {polygons,generateAtoms,digest,jsonBytes} from './prompt14-catalog-core.mjs';
import {auditCountryResult} from './prompt15-world-catalog.mjs';
import {generateCountryCells,stableCellId} from './prompt15-cell-core.mjs';
import {validateIsolatedCells} from './prompt15-isolated-cell-regeneration.mjs';
const review='reports/prompt15/15-22-component-review/20261027-components-7262c972ca',fc=features=>({type:'FeatureCollection',features}),box=(w,s,e,n)=>({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]}),parent=(geometry,country='TST',id='parent')=>({type:'Feature',properties:{countryId:country,sourceFeatureId:id},geometry});
function cell(p,geometry,index=0){return {type:'Feature',properties:{parentKey:`${p.properties.countryId}:${p.properties.sourceFeatureId}`,parentHash:geometryHash(p.geometry),sourceComponentHash:geometryHash({type:'Polygon',coordinates:polygons(p.geometry)[index]}),componentIndex:index,sourceFeatureId:`cell-${index}-${geometryHash(geometry)}`},geometry};}
for(const country of ['CIV','FRA','GBR','MYS','UKR','VNM'])test(`actual ${country} witness: original positive coordinates survive noding; old loss/split is rejected`,()=>{
 const a=JSON.parse(fs.readFileSync(`${review}/${country}-analysis.json`)),p=parent({type:'MultiPolygon',coordinates:a.sourceComponents.map(c=>c.geometry.coordinates)},country,a.parentKey.slice(4)),cells=a.sourceComponents.map(c=>cell(p,c.geometry,c.index));
 assert.ok(a.sourceComponents.every(c=>c.exact.positive));assert.equal(cellPreservationGate([p],cells).pass,true);
 const noded=nodePreservingCellRings(fc([p]),fc(cells));assert.equal(cellPreservationGate([p],noded.selected.features).pass,true);for(const [i,c] of cells.entries())assert.equal(geometryHash(noded.selected.features[i].geometry),geometryHash(c.geometry));
 const old=a.finalComponents.map(c=>cell(p,c.geometry,c.contributingCells[0].componentIndex));assert.equal(cellPreservationGate([p],old).pass,false);
});
test('tiny positive island loss and wrong component lineage fail regardless of area allowance',()=>{
 const a=box(0,0,1,1),b=box(100,10,100+1e-12,10+1e-12),p=parent({type:'MultiPolygon',coordinates:[a.coordinates,b.coordinates]});assert.notEqual(exactRingSign(b.coordinates[0]),0);assert.equal(cellPreservationGate([p],[cell(p,a)]).pass,false);const cells=[cell(p,a),cell(p,b,1)];cells[1].properties.sourceComponentHash='wrong';assert.equal(cellPreservationGate([p],cells).pass,false);
});
test('source interior connection loss, artificial bridge, wrong merge and hole fill fail',()=>{
 const left=box(-1,-1,0,1),right=box(1,-1,2,1),bridge=box(-.1,-1e-13,1.1,1e-13),joined=union([left,right,bridge]),connected=parent(joined);assert.equal(cellPreservationGate([connected],[cell(connected,left),cell(connected,right)]).pass,false);
 const separate=parent({type:'MultiPolygon',coordinates:[left.coordinates,right.coordinates]});assert.equal(cellPreservationGate([separate],[cell(separate,joined)]).pass,false);
 const outer=box(0,0,4,4),hole=box(1,1,2,2),p=parent({type:'Polygon',coordinates:[outer.coordinates[0],hole.coordinates[0].slice().reverse()]});assert.equal(cellPreservationGate([p],[cell(p,outer)]).pass,false);
});
test('normal split and legitimate source point contact survive common noding',()=>{
 const a=box(0,0,1,1),b=box(1,1,2,2),p=parent({type:'MultiPolygon',coordinates:[a.coordinates,b.coordinates]}),cells=[cell(p,box(0,0,.5,1)),cell(p,box(.5,0,1,1)),cell(p,b,1)],noded=nodePreservingCellRings(fc([p]),fc(cells));assert.equal(cellPreservationGate([p],noded.selected.features).pass,true);
});
test('full-face protected/grid ownership requires unique actual containment, never nearest or ID order',()=>{
 const p=parent(box(0,0,2,2)),f=cell(p,box(0,0,1,1));f.properties.oldTerritoryId='old';f.properties.gridBounds=[0,0,1,1];const parents=new Map([['TST:parent',p]]),old=new Map([['old',box(0,0,2,2)]]);
 assert.equal(originalGridFaceOwner(box(.1,.1,.2,.2),[f],parents,old).owner,0);assert.equal(originalGridFaceOwner(box(1.1,.1,1.2,.2),[f],parents,old),null);assert.equal(originalGridFaceOwner(box(.1,.1,.2,.2),[f,{...f}],parents,old),null);assert.equal(originalGridFaceOwner(box(.1,.1,.2,.2),[f],parents,new Map([['old',box(5,5,6,6)]])),null);
});
test('world country gate cannot admit a result without actual component evidence',()=>{
 const r={validity:{pass:true},coverage:[],parents:[],countryCoverage:{pass:true,outOfCountryArea:0,tolerance:1e-9},cells:[],numericalNoding:{maximumNodedSegmentDisplacement:0},metrics:{numericalProtectedFragmentsSkipped:0}};assert.equal(auditCountryResult(r).checks.actualComponentPreservation,false);
});
test('missing or geometrically wrong protected parent cannot receive a cell',()=>{
 const p=parent(box(0,0,1,1)),f=cell(p,p.geometry);f.properties.oldTerritoryId='wrong';assert.equal(cellPreservationGate([p],[f],new Map()).pass,false);assert.equal(cellPreservationGate([p],[f],new Map([['wrong',box(5,5,6,6)]])).pass,false);assert.equal(cellPreservationGate([p],[f],new Map([['wrong',p.geometry]])).pass,true);
});
test('complete normal generation and independent local topology exclude point-only adjacency',()=>{
 const a=box(0,0,.01,.01),b=box(.01,.01,.02,.02),p=parent({type:'MultiPolygon',coordinates:[a.coordinates,b.coordinates]}),sources={selected:fc([p]),p0:fc([{...p,properties:{countryId:'TST'}}]),sourceVersion:'unit-test',land:new Map([['TST',[]]]),oldTerritories:new Map([['TST',[{id:'old',geometry:p.geometry,sourceFeatureIds:[]}]]]),protectOldBoundaries:true},r=generateCountryCells(sources,'TST',{id:'unit',baseKm:24,refineKm:null});
 assert.equal(r.preservation.pass,true);assert.equal(r.cells.length,2);assert.ok(Object.values(r.topology.adjacency).every(v=>!v.length));assert.equal(validateIsolatedCells(r,sources).status,'PASS');
});
test('counterbalanced component merge/split cannot hide behind equal parent component counts',()=>{
 const a=box(0,0,1,1),b=box(1+1e-12,0,2,1),c=box(10,0,11,1),p=parent({type:'MultiPolygon',coordinates:[a.coordinates,b.coordinates,c.coordinates]}),f=union([a,box(.99,.5-1e-13,1+1e-12,.5+1e-13)]),cells=[cell(p,f),cell(p,b,1),cell(p,box(10,0,10.5-1e-13,1),2),cell(p,box(10.5+1e-13,0,11,1),2)],gate=cellPreservationGate([p],cells);assert.equal(gate.coverage[0].expectedShape.components,gate.coverage[0].actualShape.components);assert.equal(gate.pass,false);assert.ok(gate.errors.some(e=>e.kind==='individual-source-component-conservation'));
});
test('fragile cell unions require same owner/component, actual positive edge and exact area preservation',()=>{
 const main=box(0,0,.01,.01),tiny=box(.01,0,.01+1e-14,.01),p=parent(union([main,tiny])),a=cell(p,main),b=cell(p,tiny);a.properties.oldTerritoryId=b.properties.oldTerritoryId='old';const merge=features=>mergePrecisionFragileCells(features,1e12,f=>geometryHash(f.geometry)),accepted=merge([a,b]);assert.equal(accepted.features.length,1);assert.equal(accepted.repairs[0].exactAreaEquality,true);assert.ok(accepted.repairs[0].sharedBoundaryLengthDegrees>0);
 for(const key of ['parentKey','sourceComponentHash','componentIndex','oldTerritoryId']){const changed=structuredClone(b);changed.properties[key]='wrong';assert.equal(merge([a,changed]).features.length,2);}
 const separated=cell(p,box(.0101,0,.0101+1e-14,.01));separated.properties.oldTerritoryId='old';assert.equal(merge([a,separated]).features.length,2);
 const point=cell(p,box(.01,.01,.01+1e-14,.0101));point.properties.oldTerritoryId='old';assert.equal(merge([a,point]).features.length,2);
});
test('actual thin VNM source face has positive JSTS support even when polygon-clipping silently omits it',()=>{
 const source=JSON.parse(fs.readFileSync(`${review}/VNM-analysis.json`)).sourceComponents[0].geometry,face={type:'Polygon',coordinates:[[[105.392255,9.586831],[105.462586,9.587451],[105.419198055893,9.587068515386582],[105.392255,9.586831]]]};assert.ok(overlayArea(face)>0);assert.equal(overlayArea(intersection(face,source)),0);assert.equal(positiveIntersectionSupport(face,source),true);assert.equal(positiveIntersectionSupport(box(0,0,1,1),box(1,0,2,1)),false);assert.equal(positiveIntersectionSupport(box(0,0,1,1),box(1,1,2,2)),false);
});
test('new positive source-face cells require unique whole source/old/envelope ownership and the frozen gap bound',()=>{
 const p=parent(box(0,0,1,1)),parents=new Map([['TST:parent',p]]),olds=new Map([['old',p.geometry]]),face=box(.1,.1,.1+1e-7,.1+1e-7),make=(geometry,parentMap=parents,oldMap=olds,envelope=p.geometry)=>certifiedSourceGapFace(geometry,parentMap,oldMap,envelope,true,f=>geometryHash(f.geometry)),proof=make(face);assert.ok(proof);assert.equal(proof.feature.properties.oldTerritoryId,'old');assert.equal(proof.proof.wholeSourceAndOldAndEnvelopeContainment,true);assert.equal(make(box(.1,.1,.11,.11)),null);assert.equal(make(face,new Map([...parents,['TST:other',parent(p.geometry,'TST','other')]])),null);assert.equal(make(face,parents,new Map([...olds,['other',p.geometry]])),null);assert.equal(make(face,parents,olds,box(2,2,3,3)),null);
 const hole=box(.05,.05,.2,.2),holed=parent({type:'Polygon',coordinates:[p.geometry.coordinates[0],hole.coordinates[0].slice().reverse()]});assert.equal(make(face,new Map([['TST:parent',holed]])),null);
 const separate=parent({type:'MultiPolygon',coordinates:[box(0,0,.1,.1).coordinates,box(.2,0,.3,.1).coordinates]}),bridge=box(.09,.05,.21,.05+1e-13);assert.equal(make(bridge,new Map([['TST:parent',separate]])),null);
});
test('topology numerical representation independently certifies both original and computed coasts without widening bounds',()=>{
 const source=box(0,0,.01,.01),geometry={type:'Polygon',coordinates:[[[0,0],[.01,0],[.01,.01],[.005,.01000000000005],[0,.01],[0,0]]]},atoms=generateAtoms({selected:fc([{type:'Feature',properties:{countryId:'TST',sourceCountryId:'TST',sourceFeatureId:'cell',inputRole:'P1'},geometry}]),lock:{sourceVersion:'unit'}}),topology=buildPreservedCellTopology(atoms,fc([{type:'Feature',properties:{countryId:'TST'},geometry:source}]));assert.ok(topology.evidence.fixedEnvelopeCertificate);assert.equal(topology.evidence.fixedEnvelopeCertificate.sourceToRepresentation.pass,true);assert.equal(topology.evidence.fixedEnvelopeCertificate.representationToSource.pass,true);assert.equal(topology.evidence.fixedEnvelopeCertificate.distanceBoundDegrees,1e-12);
});
test('source corner coverage above the frozen interval bound is rejected even when component counts and area pass',()=>{
 const source={type:'Polygon',coordinates:[[[0,0],[1e-11,0],[1e-11,1e-13],[0,0]]]},geometry={type:'Polygon',coordinates:[[[2e-12,0],[1e-11,0],[1e-11,1e-13],[2e-12,2e-14],[2e-12,0]]]},atoms=generateAtoms({selected:fc([{type:'Feature',properties:{countryId:'TST',sourceCountryId:'TST',sourceFeatureId:'cut',inputRole:'P1'},geometry}]),lock:{sourceVersion:'unit'}});assert.throws(()=>buildPreservedCellTopology(atoms,fc([{type:'Feature',properties:{countryId:'TST'},geometry:source}])),/boundary certificate|envelope preservation/);
});
test('an original positive interior source face is restored from unique source ownership, while true empty holes remain empty',()=>{
 const envelope=box(.09,.09,.21,.21),admin=parent(box(.1,.1,.2,.2),'TST','admin'),residual=parent({type:'Polygon',coordinates:[envelope.coordinates[0],admin.geometry.coordinates[0].slice().reverse()]},'TST','residual');admin.properties.inputRole='P1';residual.properties.inputRole='P0R';const missingCorner={type:'Polygon',coordinates:[[[.1,.1],[.2,.1],[.2,.2-1e-7],[.2-1e-7,.2],[.1,.2],[.1,.1]]]},parents=new Map([['TST:admin',admin],['TST:residual',residual]]),olds=new Map([['old',envelope]]),cells=[cell(admin,missingCorner),cell(residual,residual.geometry)];for(const c of cells)Object.assign(c.properties,{countryId:'TST',sourceCountryId:'TST',oldTerritoryId:'old',inputRole:'P1',refined:true});
 const arranged=arrangePreservingCellFaces(fc([{type:'Feature',properties:{countryId:'TST'},geometry:envelope}]),fc(cells),()=>{},null,undefined,undefined,(geometry,refined)=>certifiedSourceGapFace(geometry,parents,olds,envelope,refined,f=>geometryHash(f.geometry)));assert.equal(arranged.selected.features.length,3);assert.ok(arranged.evidence.sourceFaceProofs.some(p=>p.kind==='source-certified-positive-gap-face-cell'));assert.equal(cellPreservationGate([admin,residual],arranged.selected.features,olds).pass,true);
});

const actualFraFixture=()=>{
 const bytes=fs.readFileSync('reports/prompt15/15-22-component-repair/20261027-fra-min-6321fa9879/local-candidate-input.json');
 assert.equal(bytes.length,38022);assert.equal(digest(bytes),'f47408eddb48dbd1aee1181ee460a606a0cba8131d226238793443a6eca25ec3');
 const input=JSON.parse(bytes),parents=new Map(input.parents.features.map(f=>[`FRA:${f.properties.sourceFeatureId}`,f])),olds=new Map(input.oldTerritories.map(t=>[t.id,t.geometry])),idFor=f=>stableCellId({candidateId:input.candidate.id,parentKey:f.properties.parentKey,parentHash:f.properties.parentHash,geometry:f.geometry});return {input,parents,olds,idFor};
};
test('actual FRA scale:null saved input reproduces the same unowned face before the source-constraint repair',()=>{
 const {input,parents,olds,idFor}=actualFraFixture();
 assert.throws(()=>arrangePreservingCellFaces(input.p0,input.selected,()=>{},null,g=>originalGridFaceOwner(g,input.selected.features,parents,olds),undefined,(g,refined)=>certifiedSourceGapFace(g,parents,olds,input.p0.features[0].geometry,refined,idFor)),e=>{
  assert.match(e.message,/no unique oriented\/source-constrained owner/);assert.equal(geometryHash(e.evidence.geometry),geometryHash(input.expectedFailure.geometry));assert.deepEqual(e.evidence.owners,[]);assert.deepEqual(e.evidence.countrySides,[0]);return true;
 });
});
test('actual FRA scale:null production arrangement preserves both original components and uniquely owns the real failed face',()=>{
 const {input,parents,olds,idFor}=actualFraFixture(),result=arrangeCountrySourceFaces(input.p0,input.selected,parents,olds,idFor),hash=geometryHash(input.expectedFailure.geometry),assignments=result.evidence.faceAssignments.filter(a=>a.geometryHash===hash);
 assert.equal(assignments.length,1);assert.equal(new Set(result.evidence.faceAssignments.map(a=>a.geometryHash)).size,result.evidence.faceCount);
 const target=result.selected.features[assignments[0].owner];assert.equal(target.properties.parentKey,'FRA:1159315647');assert.equal(target.properties.oldTerritoryId,input.oldTerritories[0].id);assert.equal(target.properties.componentIndex,2);assert.equal(positiveIntersectionSupport(target.geometry,input.parents.features[0].geometry),true);
 const proof=result.evidence.sourceFaceProofs.find(p=>p.geometryHash===hash);assert.equal(proof.wholeOriginalDoubleContainment,false);assert.equal(proof.containmentModel,'common-noded-immutable-boundaries-with-independent-fixed-bound-certificates');
 assert.ok(result.evidence.sourceConstraintCertificates.every(c=>c.sameComponentAndHoleCounts&&c.allOriginalVertices&&c.ringCertificates.every(r=>r.pass&&r.sourceIntervalGaps===0)));
 for(const index of [2,5]){const source={type:'Polygon',coordinates:polygons(input.parents.features[0].geometry)[index]},cells=result.selected.features.filter(f=>f.properties.componentIndex===index);assert.equal(partitionCoverage(source,cells.map(f=>f.geometry)).pass,true);assert.equal(componentBoundaryCorrespondence(source,cells).pass,true);assert.ok(cells.every(f=>positiveIntersectionSupport(f.geometry,source)));}
 // The local fixture intentionally includes two of this parent's six complete
 // original components. It must never count as the entire parent/country.
 assert.equal(cellPreservationGate(input.parents.features,result.selected.features,olds).pass,false);
});
test('source constraint repair rejects wrong protected ownership, missing real boundary/cell and forged representations',()=>{
 const {input,parents,olds,idFor}=actualFraFixture(),run=(selected,oldMap)=>arrangeCountrySourceFaces(input.p0,selected,parents,oldMap,idFor);
 assert.throws(()=>run(input.selected,new Map([[input.oldTerritories[0].id,box(0,0,1,1)]])),/no unique oriented\/source-constrained owner/);
 assert.throws(()=>run(fc(input.selected.features.filter((_,i)=>i!==1)),olds),/no unique oriented\/source-constrained owner/);
 assert.throws(()=>certifiedSourceGapFace(box(.1,.1,.1+1e-7,.1+1e-7),parents,olds,box(0,0,1,1),true,idFor,{parents:new Map(),olds:new Map()}),/Uncertified/);
 assert.throws(()=>arrangeCountrySourceFaces(input.p0,input.selected,parents,olds,idFor,()=>{},1e12),/explicit source-double model/);
});
test('ordered immutable source certificates reject vertex loss, backtracking and displacements without changing bounds',()=>{
 const source=[[0,0],[1,0],[1,1],[0,0]],good=[[0,0],[.2,1e-14],[.8,0],[1,0],[1,1],[0,0]];assert.equal(orderedSourceRingCertificate(source,good).pass,true);
 for(const bad of [[[0,0],[1,1],[0,0]],[[0,0],[.8,0],[.2,0],[1,0],[1,1],[0,0]],[[0,0],[.2,2e-12],[1,0],[1,1],[0,0]]])assert.equal(orderedSourceRingCertificate(source,bad).pass,false);
});

let savedFraCertificateData;
function savedFraCertificates(){
 if(savedFraCertificateData)return savedFraCertificateData;
 const root='reports/prompt15/15-22-component-repair/20261027-fra-min-6321fa9879',bytes=fs.readFileSync(root+'/FRA-once/03-noded-rings-before-face-extraction.json');
 assert.equal(bytes.length,17449015);assert.equal(digest(bytes),'6c769f9ea9c156a0b0135cd1f0eda112c291e2ee68898205a358d39c52caeab8');
 return savedFraCertificateData={stage:JSON.parse(bytes),original:JSON.parse(fs.readFileSync('data/derived/prompt14/shared-game-p0.geojson')).features.find(f=>f.properties.countryId==='FRA').geometry,checkpoint:JSON.parse(fs.readFileSync(root+'/checkpoint.json'))};
}
test('source certificate actual stored FRA: original positional FAIL becomes bijective component/ring PASS without noding',()=>{
 const {stage,original,checkpoint}=savedFraCertificates(),represented=stage.nodedCountry.features[0].geometry;
 assert.equal(polygons(original).every((p,i)=>p.length===polygons(represented)[i].length),false);
 const baseline=JSON.parse(fs.readFileSync('reports/prompt15/15-22-component-repair/20261027-fra-certificate-04f645783c/before-fix/certificates.json'))[0];assert.equal(baseline.status,'FAIL');assert.equal(baseline.error.evidence.sameComponentAndHoleCounts,false);
 const result=certifySourceConstraint(original,represented,{kind:'country'},'P0',0,stage.sourceRingCertificates);
 assert.equal(result.correspondence.length,21);assert.equal(result.correspondence.reduce((n,c)=>n+c.rings.length,0),22);
 for(const expected of checkpoint.correspondence){const actual=result.correspondence.find(c=>c.originalComponentIndex===expected.originalIndex);assert.equal(actual.representedComponentIndex,expected.representedIndex);assert.equal(actual.originalComponentHash,expected.originalComponentHash);assert.equal(actual.representedComponentHash,expected.representedComponentHash);assert.equal(actual.originalHoleCount,actual.representedHoleCount);}
});
test('source certificate all 231 stored FRA source constraints use the same production certificate',()=>{
 const {stage}=savedFraCertificates();assert.equal(stage.sourceConstraints.original.features.length,231);
 for(const [i,f] of stage.sourceConstraints.original.features.entries()){const target=stage.sourceConstraints.noded.features[i];assert.deepEqual(target.properties,f.properties);const result=certifySourceConstraint(f.geometry,target.geometry,f.properties,'SOURCE',i,stage.sourceRingCertificates);assert.equal(result.correspondence.length,polygons(f.geometry).length);}
});
test('source certificate stored local minimum retains all original component/ring proofs without replaying noding',()=>{
 const root='reports/prompt15/15-22-component-repair/20261027-fra-min-6321fa9879',input=JSON.parse(fs.readFileSync(root+'/local-candidate-input.json')),saved=JSON.parse(fs.readFileSync(root+'/local-final/noded-selected.json')).evidence;
 assert.equal(certifySourceConstraint(input.p0.features[0].geometry,saved.nodedCountry.features[0].geometry,{kind:'country'},'P0',0,saved.sourceRingCertificates).correspondence.length,2);
 for(const [i,f] of saved.sourceConstraints.original.features.entries())certifySourceConstraint(f.geometry,saved.sourceConstraints.noded.features[i].geometry,f.properties,'SOURCE',i,saved.sourceRingCertificates);
});
// Synthetic certificates are generated only from declared source-to-ring
// pairs. No generation, noding, polygonization or ownership function is called.
function sourceCertificateFixture(){
 const outer=box(0,0,4,4).coordinates[0],h1=box(.5,.5,1,1).coordinates[0].slice().reverse(),h2=box(2,2,3,3).coordinates[0].slice().reverse(),a=[outer,h1,h2],b=box(10,0,14,4).coordinates,original={type:'MultiPolygon',coordinates:[a,b]},extended=[[[0,0],[2,0],[4,0],[4,4],[0,4],[0,0]],h1,h2],representedByOriginal=[extended,b],represented={type:'MultiPolygon',coordinates:[b,[extended[0],h2,h1]]},certificates=[];
 for(const [componentIndex,p] of polygons(original).entries())for(const [ringIndex,source] of p.entries()){const target=representedByOriginal[componentIndex][ringIndex];certificates.push({role:'SOURCE',featureIndex:0,componentIndex,ringIndex,...orderedSourceRingCertificate(source,target),originalRingHash:digest(jsonBytes(source)),representedRingHash:digest(jsonBytes(target)),originalGeometryHash:geometryHash(original)});}
 const run=(target=represented,records=certificates)=>certifySourceConstraint(original,target,{kind:'unit'},'SOURCE',0,records);return {original,represented,certificates,run};
}
test('source certificate component and hole permutation preserves unique shell/hole lineage with inserted vertices',()=>{
 const {run}=sourceCertificateFixture(),result=run();assert.deepEqual(result.correspondence.map(c=>c.representedComponentIndex),[1,0]);assert.deepEqual(result.correspondence[0].rings.map(r=>r.representedRingIndex),[0,2,1]);assert.notEqual(result.originalGeometryHash,result.representedGeometryHash);assert.ok(result.correspondence.every(c=>c.rings.every(r=>r.boundary.pass&&r.boundary.sourceIntervalGaps===0)));assert.equal(result.distanceBoundDegrees,1e-12);assert.equal(result.intervalBoundDegrees,Math.SQRT2*1e-12+1e-15);
});
test('source certificate rejects missing and duplicated components even when total component counts agree',()=>{
 const {represented,run}=sourceCertificateFixture();assert.throws(()=>run({type:'Polygon',coordinates:represented.coordinates[0]}));assert.throws(()=>run({type:'MultiPolygon',coordinates:[represented.coordinates[0],represented.coordinates[0]]}));
});
test('source certificate rejects moving holes between components despite identical full vertex set and aggregate counts',()=>{
 const {represented,run}=sourceCertificateFixture(),bad=structuredClone(represented),hole=bad.coordinates[1].pop();bad.coordinates[0].push(hole);
 const vertices=g=>polygons(g).flat(2).map(p=>JSON.stringify(p)).sort();assert.deepEqual(vertices(bad),vertices(represented));assert.equal(polygons(bad).reduce((n,p)=>n+p.length-1,0),2);assert.throws(()=>run(bad));
});
test('source certificate rejects ambiguous correspondence, wrong lineage and source/represented hash evidence',()=>{
 const {original,represented,certificates,run}=sourceCertificateFixture();
 for(const change of [r=>r[0].role='wrong',r=>r[0].componentIndex=1,r=>r[0].ringIndex=1,r=>r[0].originalRingHash='wrong',r=>r[0].representedRingHash='wrong',r=>r[0].originalGeometryHash='wrong',r=>r[0].pass=false,r=>r[0].sourceIntervalGaps=1]){const records=structuredClone(certificates);change(records);assert.throws(()=>run(represented,records));}
 const plain={type:'MultiPolygon',coordinates:[original.coordinates[1],box(20,0,24,4).coordinates]},records=polygons(plain).map((p,i)=>({role:'SOURCE',featureIndex:0,componentIndex:i,ringIndex:0,...orderedSourceRingCertificate(p[0],p[0])}));
 assert.throws(()=>certifySourceConstraint(plain,{type:'MultiPolygon',coordinates:[plain.coordinates[0],plain.coordinates[0]]},{kind:'unit'},'SOURCE',0,records),e=>e.evidence.reason==='ambiguous-component-ring-correspondence');
 const ambiguousHoles=structuredClone(represented);ambiguousHoles.coordinates[1][1]=ambiguousHoles.coordinates[1][2];assert.throws(()=>run(ambiguousHoles),e=>e.evidence.reason==='ambiguous-hole-ring-correspondence');
});
test('source certificate rejects actual vertex, ring order and displacement violations despite claimed PASS records',()=>{
 const {represented,certificates,run}=sourceCertificateFixture();
 const missing=structuredClone(represented);missing.coordinates[1][0].splice(2,1);assert.throws(()=>run(missing));
 const displaced=structuredClone(represented);displaced.coordinates[1][0][1][1]=2e-12;assert.throws(()=>run(displaced));
 const reversed=structuredClone(represented);reversed.coordinates[1][1].reverse();assert.throws(()=>run(reversed));
 const falseRecord=structuredClone(certificates);falseRecord[0].maximumDistance=1e-13;assert.throws(()=>run(represented,falseRecord));
 const missingHole=structuredClone(represented);missingHole.coordinates[1].pop();assert.throws(()=>run(missingHole));
});

function actualTinyPositiveFace(){const f=JSON.parse(fs.readFileSync('reports/prompt15/15-22-component-repair/20261028-positive-face-70656bae65/fixture.json')),parents=new Map(f.parents.features.map(p=>[`FRA:${p.properties.sourceFeatureId}`,p])),olds=new Map(f.oldTerritories.map(p=>[p.id,p.geometry])),idFor=feature=>stableCellId({candidateId:f.candidate.id,parentKey:feature.properties.parentKey,parentHash:feature.properties.parentHash,geometry:feature.geometry});return {f,parents,olds,idFor};}
test('actual microscopic FRA face has stable production ownership, geometry hash and cell identity in all six representations',()=>{
 const {f,parents,olds,idFor}=actualTinyPositiveFace(),points=f.geometry.coordinates[0].slice(0,-1),ids=new Set(),hashes=new Set();
 for(const reverse of [false,true])for(let start=0;start<3;start++){const p=reverse?points.slice().reverse():points,r=[...p.slice(start),...p.slice(0,start)],geometry={type:'Polygon',coordinates:[[...r,r[0]]]},source=certifiedSourceGapFace(geometry,parents,olds,f.country.geometry,true,idFor);assert.ok(source);assert.equal(source.feature.properties.parentKey,f.expected.parentKey);assert.equal(source.feature.properties.componentIndex,f.expected.componentIndex);assert.equal(source.feature.properties.oldTerritoryId,f.expected.oldTerritoryId);assert.equal(source.feature.properties.sourceTiny,false);assert.equal(source.proof.areaDegrees2,5.877816005970817e-21);assert.equal(source.proof.wholeOriginalDoubleContainment,true);ids.add(source.feature.properties.sourceFeatureId);hashes.add(geometryHash(source.feature.geometry));}
 assert.equal(ids.size,1);assert.equal(hashes.size,1);
});
test('microscopic source-face recovery still rejects wrong, ambiguous and over-bound owners without relaxed thresholds',()=>{
 const {f,parents,olds,idFor}=actualTinyPositiveFace(),target=parents.get(f.expected.parentKey),wrong=structuredClone(target);wrong.geometry=box(0,0,1,1);const changed=new Map(parents);changed.set(f.expected.parentKey,wrong);assert.equal(certifiedSourceGapFace(f.geometry,changed,olds,f.country.geometry,true,idFor),null);
 const duplicate=new Map(parents);duplicate.set('FRA:duplicate',{...target,properties:{...target.properties,sourceFeatureId:'duplicate'}});assert.equal(certifiedSourceGapFace(f.geometry,duplicate,olds,f.country.geometry,true,idFor),null);
 const duplicateOld=new Map(olds);duplicateOld.set('duplicate',olds.get(f.expected.oldTerritoryId));assert.equal(certifiedSourceGapFace(f.geometry,parents,duplicateOld,f.country.geometry,true,idFor),null);
 const p=parent(box(0,0,1,1)),pm=new Map([['TST:parent',p]]),om=new Map([['old',p.geometry]]),width=1e-12*1024,height=2**-10,view=new DataView(new ArrayBuffer(8));view.setFloat64(0,width);view.setBigUint64(0,view.getBigUint64(0)+1n);assert.ok(certifiedSourceGapFace(box(0,0,width,height),pm,om,p.geometry,true,g=>stableCellId({candidateId:'unit',parentKey:g.properties.parentKey,parentHash:g.properties.parentHash,geometry:g.geometry})));assert.equal(certifiedSourceGapFace(box(0,0,view.getFloat64(0),height),pm,om,p.geometry,true,idFor),null);
});
