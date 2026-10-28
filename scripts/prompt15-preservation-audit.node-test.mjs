import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {hashCanonical,digest,jsonBytes} from './prompt14-catalog-core.mjs';
import {AUDIT_VERSION,AUDIT_LIMITS,auditCountryData,auditIdentitySet,auditMembership,partitionCoverage,physicalMetrics,geometryHash,boundarySegments,boundaryMatch,uncoveredBoundary,joinCountryAudits,overlayArea,overlayPolygons,difference,intersection,union,planarArea,previousRepairLedgerRoot,validatePreviousMetricEvidence,certifyPreviousDifferenceLocations} from './prompt15-preservation-audit-core.mjs';
import {boundaryIndex as oldBoundaryIndex,boundaryMatch as oldBoundaryMatch,planarArea as indexedArea} from './prompt15-world-indices-core.mjs';
import {selectCountries,assembleCountryAuditInput,resolvePreparedSources,runAudit,DELIVERY_ROOT,ADMIN_ROOT} from './prompt15-preservation-audit.mjs';
import {WORLD_ROOT} from './prompt15-world-delivery-core.mjs';

const box=(w,s,e,n)=>({type:'Polygon',coordinates:[[[w,s],[e,s],[e,n],[w,n],[w,s]]]});
function fixture(){
  const cells=[box(0,0,.05,.05),box(.05,0,.1,.05)].map((geometry,i)=>({id:`cell-${i+1}`,ordinal:i+1,sourceCountryId:'TST',parentKey:`TST:${i?'b':'a'}`,adminId:i?'b':'a',oldTerritoryId:'old',refined:false,sourceTiny:false,componentIndex:0,geometry})),envelope=box(0,0,.1,.05),groups=new Map();
  for(const cell of cells)for(let i=1;i<cell.geometry.coordinates[0].length;i++){
    let a=cell.geometry.coordinates[0][i-1],b=cell.geometry.coordinates[0][i];if(a[0]>b[0]||a[0]===b[0]&&a[1]>b[1])[a,b]=[b,a];const key=JSON.stringify([a,b]),group=groups.get(key)??{a,b,owners:[]};group.owners.push(cell.ordinal);groups.set(key,group);
  }
  for(const cell of cells)cell.sourceComponentHash=geometryHash(cell.geometry);
  const edges=[...groups.values()].map((group,i)=>{
    const [left,right=0]=group.owners,boundaryClass=right?'administrative':'coast',flags={positiveAdjacency:Boolean(right),country:false,administrative:Boolean(right),residual:false,previous:!right},geometry={type:'LineString',coordinates:[group.a,group.b]};
    return {ordinal:i+1,left,right,boundaryClass,flags,geometry,id:`edge:operational:${hashCanonical('prompt15-task-15-20-edge.v1',{leftCellId:cells[left-1].id,rightCellId:right?cells[right-1].id:null,boundaryClass,flags,geometry})}`};
  });
  return {countryId:'TST',envelope,cells,expectedCells:cells.map(cell=>({...cell,geometryHash:geometryHash(cell.geometry),areaKm2:physicalMetrics(cell.geometry).areaKm2,diameterKm:physicalMetrics(cell.geometry).diameterKm})),parents:cells.map(cell=>({parentKey:cell.parentKey,adminId:cell.adminId,geometry:cell.geometry})),previousParents:[{oldTerritoryId:'old',geometry:envelope}],sourceIdentities:['a','b'],administrativeMembership:[{parentKey:'TST:a',cellOrdinals:[1]},{parentKey:'TST:b',cellOrdinals:[2]}],previousMembership:[{oldTerritoryId:'old',cellOrdinals:[1,2]}],incidentEdges:edges,cellMeta:ordinal=>cells[ordinal-1],adjacency:new Map([[1,[2]],[2,[1]]]),tinySourceComponents:new Set()};
}

test('15-22 accepts a real partition with complete administrative/old membership and boundary incidence',()=>{
  const result=auditCountryData(fixture());assert.equal(result.status,'PASS',JSON.stringify(result.errors));assert.equal(result.counts.cells,2);assert.equal(result.counts.ownedEdges,7);
});
test('15-22 rejects the 193-count disguise: one original source ID omitted and another duplicated',()=>{
  const expected=Array.from({length:193},(_,i)=>String(i)),actual=expected.slice();assert.equal(auditIdentitySet(expected,actual).pass,true);actual[192]='191';const result=auditIdentitySet(expected,actual);assert.equal(result.pass,false);assert.deepEqual(result.missing,['192']);assert.deepEqual(result.duplicates,['191']);
  const input=fixture();input.parents[1]={...input.parents[1],adminId:'a'};assert.ok(auditCountryData(input).errors.some(error=>error.code==='source-identity-preservation'));
});
test('15-22 rejects shared memberships, missing parents, substituted old parents and 512 truncation',()=>{
  const input=fixture();input.administrativeMembership[1].cellOrdinals=[1];assert.ok(auditCountryData(input).errors.some(error=>error.code==='administrative-membership'));
  const cells=Array.from({length:513},(_,i)=>({ordinal:i+1,parentKey:'p'})),parents=[{parentKey:'p'}],entries=[{parentKey:'p',cellOrdinals:cells.map(c=>c.ordinal)}];assert.equal(auditMembership(cells,parents,entries,c=>c.parentKey,p=>p.parentKey).pass,true);entries[0].cellOrdinals.pop();assert.equal(auditMembership(cells,parents,entries,c=>c.parentKey,p=>p.parentKey).pass,false);
  const old=fixture();old.previousMembership[0].oldTerritoryId='another';assert.ok(auditCountryData(old).errors.some(error=>error.code==='previous-membership'));
});
test('15-22 physical gate rejects a whole administrative polygon substituted as one operational cell',()=>{
  const input=fixture();input.cells[0]={...input.cells[0],geometry:box(0,0,1,1)};const result=auditCountryData(input);assert.ok(result.errors.some(error=>error.code==='physical-resolution'));assert.ok(result.errors.some(error=>error.code==='source-cell-geometry-changed'));assert.ok(result.errors.some(error=>error.code==='parent-geometry-conservation'));
});
test('15-22 measures gaps, overlaps, cross-border faces, missing islands and filled holes',()=>{
  const parent=box(0,0,1,1);assert.equal(partitionCoverage(parent,[box(0,0,.5,1),box(.5,0,1,1)]).pass,true);
  assert.equal(partitionCoverage(parent,[box(0,0,.4,1),box(.5,0,1,1)]).checks.gap,false);
  assert.equal(partitionCoverage(parent,[box(0,0,.6,1),box(.5,0,1,1)]).checks.overlap,false);
  assert.equal(partitionCoverage(parent,[box(0,0,1.1,1)]).checks.outside,false);
  const island=box(3,3,3.000001,3.000001),multi={type:'MultiPolygon',coordinates:[parent.coordinates,island.coordinates]};assert.equal(partitionCoverage(multi,[parent]).checks.components,false);
  const hole=box(.2,.2,.8,.8).coordinates[0].slice().reverse(),holed={type:'Polygon',coordinates:[parent.coordinates[0],hole]};assert.equal(partitionCoverage(holed,[holed]).pass,true);assert.equal(partitionCoverage(holed,[parent]).checks.holes,false);
});
test('15-22 topology rejects point-only or remote contacts, fake edges, missing boundaries and adjacency',()=>{
  const segments=boundarySegments(box(0,0,1,1));assert.equal(boundaryMatch([1,1],[2,2],segments),false);assert.equal(boundaryMatch([2,0],[2,1],segments),false);assert.equal(boundaryMatch([0,0],[1,0],segments),true);assert.equal(uncoveredBoundary(segments).count,3);
  const input=fixture();input.incidentEdges=input.incidentEdges.slice(1);assert.ok(auditCountryData(input).errors.some(error=>error.code==='missing-cell-boundary'));
  const adjacency=fixture();adjacency.adjacency.set(1,[]);assert.ok(auditCountryData(adjacency).errors.some(error=>error.code==='adjacency-edge-mismatch'));
  const moved=fixture();moved.incidentEdges[0]={...moved.incidentEdges[0],geometry:{type:'LineString',coordinates:[[10,10],[11,11]]}};assert.ok(auditCountryData(moved).errors.some(error=>error.code==='nonpositive-or-nonshared-edge'));
});
test('15-22 source component exceptions cannot be fabricated by labeling a small cell sourceTiny',()=>{
  const input=fixture();input.cells[0].sourceTiny=true;assert.ok(auditCountryData(input).errors.some(error=>error.code==='unproven-tiny-source-exception'));
  const dateline=boundarySegments(box(179,70,180,71));assert.equal(boundaryMatch([-180,70],[-180,71],dateline),true);
  assert.equal(boundaryMatch([179,70],[180,70],dateline),true);assert.equal(boundaryMatch([-179,70],[-178,70],dateline),false);
  assert.ok(Math.abs(physicalMetrics(box(0,0,1,1)).areaKm2-12363.718145180046)<1e-5);assert.ok(physicalMetrics(box(0,70,1,71)).areaKm2<physicalMetrics(box(0,0,1,1)).areaKm2);
});

test('15-22 explicit selection produces disjoint 50/50/50/50/47 batches and no default world run',()=>{
  const order=Array.from({length:247},(_,i)=>String(i).padStart(3,'0')),batches=Array.from({length:5},(_,i)=>selectCountries(order,i+1));assert.deepEqual(batches.map(batch=>batch.length),[50,50,50,50,47]);assert.deepEqual(batches.flat(),order);
  assert.throws(()=>selectCountries(order,0));assert.throws(()=>selectCountries(order,6));assert.throws(()=>selectCountries([...order.slice(0,246),'000'],1));
  const command=spawnSync(process.execPath,['scripts/prompt15-preservation-audit.mjs'],{encoding:'utf8'});assert.equal(command.status,1);assert.match(command.stderr,/Required --out/);assert.equal(command.stdout,'');
});

test('15-22 final join rejects missing/duplicate countries and missing/shared edge or cell ordinals',()=>{
  const order=['AAA','BBB'],reports=order.map((countryId,i)=>({schemaVersion:AUDIT_VERSION,countryId,status:'PASS',errors:[],checks:{identities:{pass:true},membership:{pass:true},previousMembership:{pass:true},countryCoverage:{pass:true},parentCoverage:[{pass:true}],previousCoverage:[{pass:true}]},counts:{cells:1,ownedEdges:1,vertices:4,administrativeParents:1,residualParents:0,previousParents:1},cellOrdinals:[i+1],ownedEdgeOrdinals:[i+1]})),expected={cells:2,edges:2};assert.equal(joinCountryAudits(order,reports,expected).status,'PASS');
  assert.equal(joinCountryAudits(order,reports.slice(0,1),expected).status,'FAIL');assert.equal(joinCountryAudits(order,[reports[0],reports[0]],expected).status,'FAIL');
  const duplicate=structuredClone(reports);duplicate[1].ownedEdgeOrdinals=[1];assert.equal(joinCountryAudits(order,duplicate,expected).status,'FAIL');
  const outside=structuredClone(reports);outside[1].cellOrdinals=[3];assert.equal(joinCountryAudits(order,outside,expected).status,'FAIL');
  const fail=structuredClone(reports);fail[1].status='FAIL';assert.equal(joinCountryAudits(order,fail,expected).status,'FAIL');
  const disguised=structuredClone(reports);disguised[1].checks.parentCoverage[0].pass=false;assert.equal(joinCountryAudits(order,disguised,expected).status,'FAIL');
});

function adapterFixture(){
  const fixtureInput=fixture(),{cells}=fixtureInput,adminParents=cells.map((cell,i)=>({sourceCountryId:'TST',parentKey:cell.parentKey,adminId:cell.adminId,parentGeometryHash:geometryHash(cell.geometry),start:i,count:1})),previousParents=[{sourceCountryId:'TST',oldTerritoryId:'old',start:0,count:2}];
  const entries=cells.map(cell=>{const result={...cell,areaKm2:physicalMetrics(cell.geometry).areaKm2,diameterKm:physicalMetrics(cell.geometry).diameterKm};delete result.geometry;delete result.ordinal;return result;}),metadata={countryId:'TST',columns:['cellOrdinal','cellId','administrativeOrdinal','previousParentOrdinal'],rows:cells.map((cell,i)=>[cell.ordinal,cell.id,i+1,1])},payloads=new Map([
    [`${WORLD_ROOT}/countries/TST/catalog.json.gz`,{entries}],
    [`${WORLD_ROOT}/countries/TST/geometry.geojson.gz`,{features:cells.map(cell=>({geometry:cell.geometry,properties:{cellId:cell.id}}))}],
    [`${DELIVERY_ROOT}/detail/countries/TST.geojson.gz`,{features:cells.map(cell=>({id:cell.ordinal,geometry:cell.geometry,properties:{}}))}],
    [`${DELIVERY_ROOT}/metadata/countries/TST.json.gz`,metadata],
  ]);
  const context={envelopeById:new Map([['TST',fixtureInput.envelope]]),restored:cells.map(cell=>({properties:{sourceCountryId:'TST',sourceFeatureId:cell.adminId},geometry:cell.geometry})),residuals:[],traces:cells.map(cell=>({sourceCountryId:'TST',source:{identity:cell.adminId,geometrySha256:digest(jsonBytes(cell.geometry)),preparedGeometrySha256:digest(jsonBytes(cell.geometry)),shape:{components:1,holes:0}},result:{geometrySha256:digest(jsonBytes(cell.geometry)),shape:{components:1,holes:0}},components:[{resultComponentIndex:0,resultGeometrySha256:geometryHash(cell.geometry),resultHoles:0,sourceHoles:0}]})),rawById:new Map(cells.map(cell=>[cell.adminId,{geometry:cell.geometry}])),preparedById:new Map(cells.map(cell=>[cell.adminId,{geometry:cell.geometry}])),admin:{parents:adminParents,cellOrdinals:[1,2]},previous:{parents:previousParents,cellOrdinals:[1,2]},protected:[{properties:{sourceCountryId:'TST',territoryId:'old'},geometry:fixtureInput.envelope}],protectedTraces:[{previousTerritoryId:'old',geometrySha256:digest(jsonBytes(fixtureInput.envelope)),shape:{components:1,holes:0}}],deliveryParents:{administrative:adminParents,previous:previousParents},ordinalById:new Map(cells.map(cell=>[cell.id,cell.ordinal])),cellMeta:fixtureInput.cellMeta,edgeFiles:new Map([['TST','test-cache']]),edgePins:new Map([['TST',{}]]),adjacency:fixtureInput.adjacency};
  const inputs={read:(root,name)=>structuredClone(payloads.get(`${root}/${name}`)),readFile:()=>Buffer.from(fixtureInput.incidentEdges.map(edge=>JSON.stringify(edge)).join('\n'))};
  return {inputs,context,metadata};
}
test('15-22 assembles raw-source lineage and delivered cell rows, rejecting altered metadata before auditing',()=>{
  const {inputs,context,metadata}=adapterFixture();
  assert.equal(auditCountryData(assembleCountryAuditInput(inputs,context,'TST')).status,'PASS');
  metadata.rows[0][2]=2;assert.throws(()=>assembleCountryAuditInput(inputs,context,'TST'),/ordinal\/parent/);metadata.rows[0][2]=1;
  context.traces[0].source.geometrySha256='wrong';assert.throws(()=>assembleCountryAuditInput(inputs,context,'TST'),/lineage changed/);
});

function approvedRestorationFixture(){
  const adapter=adapterFixture(),features=[...adapter.context.preparedById].map(([id,f])=>({...f,properties:{sourceFeatureId:id,sourceCountryId:'TST'}})),selected={type:'FeatureCollection',features};
  const candidate={status:'pass',countryId:'TST',sourceIdentityCount:features.length,selected,geometrySha256:digest(jsonBytes(selected)),topologySha256:'approved-topology',checks:{identity:true,coverage:true},evidence:{policy:{version:'prompt15-administrative-restoration-policy-v2',taskId:'15-08'},unresolved:[]}};
  const bytes=jsonBytes(candidate),first={path:'reports/prompt15/candidates/test-first.json',sha256:digest(bytes),byteLength:bytes.length},second={...first,path:'reports/prompt15/candidates/test-second.json'};
  const provenance={inputs:[first,second],restoration15_09:{status:'pass',policyVersion:'prompt15-administrative-restoration-policy-v2',checks:{identity:true,coverage:true},sourceIdentityCount:features.length,geometrySha256:candidate.geometrySha256,topologySha256:candidate.topologySha256,evidence:{first,second}}};
  const payloads=new Map([[first.path,bytes],[second.path,bytes]]),inputs={readFile:(file,pin)=>{const b=payloads.get(file);if(!b)throw Error(`Missing ${file}`);assert.equal(digest(b),pin.sha256,'Input identity changed');assert.equal(b.length,pin.byteLength);return b;}};
  const shared=features.map((f,i)=>({properties:{ne_id:f.properties.sourceFeatureId},geometry:box(i+1,1,i+1.05,1.05)}));
  return {...adapter,sourceInputs:inputs,shared,provenance,payloads};
}
test('15-22 accepts independently pinned approved restored prepared sources and verifies full raw/restored lineage',()=>{
  const f=approvedRestorationFixture();f.context.preparedById=resolvePreparedSources(f.sourceInputs,f.provenance,f.shared,f.context.traces);
  assert.equal(auditCountryData(assembleCountryAuditInput(f.inputs,f.context,'TST')).status,'PASS');
});
test('15-22 rejects unapproved/tampered prepared hashes and blocks missing or circular restoration evidence',()=>{
  const f=approvedRestorationFixture();f.context.traces[0].source.preparedGeometrySha256='unapproved';assert.throws(()=>resolvePreparedSources(f.sourceInputs,f.provenance,f.shared,f.context.traces),/approved prepared source hash/);
  const tampered=approvedRestorationFixture();tampered.payloads.set(tampered.provenance.inputs[0].path,Buffer.from('{}'));assert.throws(()=>resolvePreparedSources(tampered.sourceInputs,tampered.provenance,tampered.shared,tampered.context.traces),/BLOCKED.*Input identity changed/);
  const missing=approvedRestorationFixture();missing.provenance.inputs=[];assert.throws(()=>resolvePreparedSources(missing.sourceInputs,missing.provenance,missing.shared,missing.context.traces),/BLOCKED.*test-first.json/);
  const circular=approvedRestorationFixture();circular.provenance.restoration15_09.evidence.first.path=`${ADMIN_ROOT}/administrative-restoration.geojson`;assert.throws(()=>resolvePreparedSources(circular.sourceInputs,circular.provenance,circular.shared,circular.context.traces),/BLOCKED.*independent input pin/);
});

function relocatedRestorationFixture(){
  const f=approvedRestorationFixture(),seen=new Set(),put=(file,value)=>{const bytes=Buffer.isBuffer(value)?value:jsonBytes(value);f.payloads.set(file,bytes);return {path:file,sha256:digest(bytes),byteLength:bytes.length};};
  const candidate=JSON.parse(f.payloads.get(f.provenance.inputs[0].path));candidate.countryId='SVN';for(const feature of candidate.selected.features)feature.properties.sourceCountryId='SVN';candidate.geometrySha256=digest(jsonBytes(candidate.selected));f.provenance.restoration15_09.geometrySha256=candidate.geometrySha256;
  for(const trace of f.context.traces)trace.sourceCountryId='SVN';
  for(const name of ['first','second']){const old=f.provenance.restoration15_09.evidence[name],pin=put(old.path,candidate);Object.assign(old,pin);}
  f.provenance.dependencies={node:process.version,jsts:'2.12.1',polygonClipping:'0.15.7'};
  const files=['scripts/prompt15-recovery-candidate.mjs','package-lock.json','data/derived/prompt14/shared-game-p0.geojson','data/derived/prompt14/shared-admin1-input.geojson','data/raw/ne_10m_admin_1_states_provinces.geojson','src/data/countries-2020.json','data/source-locks/prompt14-derived-game-input-lock.json'];
  const pins=files.map(file=>put(file,{fixture:file}));f.provenance.inputs.push(...pins);
  const wrapper=put('reports/prompt15/fixtures/replay.mjs',Buffer.from('fixture wrapper')),entries=[];
  for(const [i,name] of ['first','second'].entries()){
    const actual=put(`reports/prompt15/fixtures/relocated-${name}.json`,candidate),approved=f.provenance.restoration15_09.evidence[name];
    const execution={label:name,pid:100+i,started:'2026-10-27T00:00:01Z',finished:'2026-10-27T00:00:02Z',inputsUnchanged:true,error:null,expectedExitCode:0,output:actual,inputsBefore:pins,inputsAfter:pins,versions:{node:process.version,packages:[{name:'jsts',version:'2.12.1'},{name:'polygon-clipping',version:'0.15.7'}]}};
    const command={exitCode:0,signal:null,started:'2026-10-27T00:00:00Z',finished:'2026-10-27T00:00:03Z',args:[wrapper.path,name]};
    entries.push({name,logicalPath:approved.path,approvedPin:approved,actual,origin:{kind:'new-independent-replay',wrapper,execution:put(`reports/prompt15/fixtures/${name}-execution.json`,execution),command:put(`reports/prompt15/fixtures/${name}-command.json`,command)}});
  }
  const map={schemaVersion:'prompt15-prepared-source-evidence-map-v1',countryId:'SVN',provenance:put(`${ADMIN_ROOT}/provenance.json`,f.provenance),entries},mapPath='reports/prompt15/fixtures/evidence-map.json';put(mapPath,map);
  f.sourceInputs.preparedEvidenceMap=mapPath;const read=f.sourceInputs.readFile;f.sourceInputs.readFile=(file,pin)=>{seen.add(file);const bytes=f.payloads.get(file);if(!pin)return bytes;return read(file,pin);};
  const commit=()=>put(mapPath,map),editExecution=(name,edit)=>{const entry=entries.find(e=>e.name===name),execution=JSON.parse(f.payloads.get(entry.origin.execution.path));edit(execution);entry.origin.execution=put(entry.origin.execution.path,execution);commit();};
  return {...f,map,mapPath,entries,seen,put,commit,editExecution};
}
test('15-22 explicit evidence map admits exact relocated bytes and records map, receipts, wrapper and replay inputs',()=>{
  const f=relocatedRestorationFixture();const prepared=resolvePreparedSources(f.sourceInputs,f.provenance,f.shared,f.context.traces);
  for(const trace of f.context.traces)assert.equal(digest(jsonBytes(prepared.get(trace.source.identity).geometry)),trace.source.preparedGeometrySha256);
  for(const file of [f.mapPath,f.entries[0].actual.path,f.entries[1].actual.path,f.entries[0].origin.execution.path,f.entries[1].origin.command.path,'scripts/prompt15-recovery-candidate.mjs'])assert.ok(f.seen.has(file),file);
  assert.throws(()=>runAudit({country:'ARE',preparedEvidenceMap:f.mapPath}),/restricted to --country SVN/);
  assert.throws(()=>runAudit({batch:1,preparedEvidenceMap:f.mapPath}),/restricted to --country SVN/);
});
test('15-22 relocated evidence rejects wrong hashes, v1 policy, missing required checks and circular sources',()=>{
  const bad=relocatedRestorationFixture();bad.entries[0].actual.sha256='wrong';bad.commit();assert.throws(()=>resolvePreparedSources(bad.sourceInputs,bad.provenance,bad.shared,bad.context.traces),/BLOCKED.*logical pin/);
  const wrongBytes=relocatedRestorationFixture();wrongBytes.payloads.set(wrongBytes.entries[0].actual.path,Buffer.from('{}'));assert.throws(()=>resolvePreparedSources(wrongBytes.sourceInputs,wrongBytes.provenance,wrongBytes.shared,wrongBytes.context.traces),/BLOCKED.*Input identity changed/);
  for(const change of [c=>{c.evidence.policy.version='prompt15-administrative-recovery-diagnostic-v1';},c=>{delete c.checks.coverage;}]){
    const f=approvedRestorationFixture();const candidate=JSON.parse(f.payloads.get(f.provenance.inputs[0].path));change(candidate);const bytes=jsonBytes(candidate);for(const name of ['first','second']){const pin=f.provenance.restoration15_09.evidence[name];f.payloads.set(pin.path,bytes);pin.sha256=digest(bytes);pin.byteLength=bytes.length;}
    assert.throws(()=>resolvePreparedSources(f.sourceInputs,f.provenance,f.shared,f.context.traces),/BLOCKED.*checks\/policy/);
  }
  const cycle=relocatedRestorationFixture();cycle.entries[0].actual.path=`${ADMIN_ROOT}/administrative-restoration.geojson`;cycle.commit();assert.throws(()=>resolvePreparedSources(cycle.sourceInputs,cycle.provenance,cycle.shared,cycle.context.traces),/BLOCKED.*independent path/);
});
test('15-22 relocated evidence rejects incomplete, unsuccessful and duplicated independent replay receipts',()=>{
  for(const edit of [f=>{f.map.entries.pop();f.commit();},f=>f.editExecution('second',e=>{e.pid=100;}),f=>f.editExecution('first',e=>{e.inputsUnchanged=false;}),f=>f.editExecution('first',e=>{e.inputsAfter=[];}),f=>f.editExecution('first',e=>{e.inputsBefore=e.inputsBefore.filter(p=>p.path!=='scripts/prompt15-recovery-candidate.mjs');e.inputsAfter=e.inputsBefore;}),f=>{const entry=f.entries[0],command=JSON.parse(f.payloads.get(entry.origin.command.path));command.exitCode=1;entry.origin.command=f.put(entry.origin.command.path,command);f.commit();},f=>{f.entries[1].actual=f.entries[0].actual;f.commit();}]){
    const f=relocatedRestorationFixture();edit(f);assert.throws(()=>resolvePreparedSources(f.sourceInputs,f.provenance,f.shared,f.context.traces),/BLOCKED/);
  }
});
test('15-22 accepts a normal island inside a hole while rejecting actual fill with unchanged component/hole counts',()=>{
  const outer=box(0,0,10,10),hole=box(2,2,8,8).coordinates[0].slice().reverse(),shell={type:'Polygon',coordinates:[outer.coordinates[0],hole]},island=box(3,3,4,4),parent={type:'MultiPolygon',coordinates:[shell.coordinates,island.coordinates]};
  assert.equal(partitionCoverage(parent,[parent]).pass,true);assert.equal(partitionCoverage(parent,[shell,island]).pass,true);
  const enlargedIsland=box(3,3,5,5),filled=partitionCoverage(parent,[shell,enlargedIsland]);assert.deepEqual(filled.actualShape,filled.expectedShape);assert.equal(filled.checks.holes,false);assert.equal(filled.filledHoles[0].filledArea,3);assert.equal(filled.filledHoles[0].excludedHoleArea,35);
  assert.equal(partitionCoverage(parent,[outer]).checks.holes,false);
});
test('15-22 computed empty/lower dimensional overlays have zero area and collections retain every positive polygon',()=>{
  const empty={type:'Polygon',coordinates:[]},collection={type:'GeometryCollection',geometries:[]},line={type:'LineString',coordinates:[[0,0],[1,0]]},point={type:'Point',coordinates:[0,0]},a=box(0,0,1,1),b=box(2,0,4,1);
  for(const geometry of [empty,{type:'Polygon',coordinates:[[]]},{type:'MultiPolygon',coordinates:[]},{type:'MultiPolygon',coordinates:[[[]]]},collection,line,point,{type:'MultiLineString',coordinates:[line.coordinates]},{type:'MultiPoint',coordinates:[point.coordinates]}])assert.equal(overlayArea(geometry),0);
  const mixed={type:'GeometryCollection',geometries:[line,a,{type:'GeometryCollection',geometries:[point,b,empty]}]};assert.equal(overlayArea(mixed),3);assert.equal(overlayPolygons(mixed).length,2);assert.equal(overlayArea(intersection(mixed,a)),1);assert.equal(overlayArea(difference(mixed,a)),2);
  assert.equal(overlayArea(intersection(a,box(1,0,2,1))),0);assert.equal(overlayArea(intersection(a,box(1,1,2,2))),0);assert.equal(overlayArea(difference(a,a)),0);
  const missing=partitionCoverage(a,[]);assert.equal(missing.pass,false);assert.equal(missing.checks.nonempty,false);assert.equal(missing.gapArea,1);
  assert.throws(()=>overlayArea({type:'GeometryCollection'}));assert.throws(()=>overlayArea({type:'Polygon',coordinates:[[],[[0,0],[1,0],[0,1],[0,0]]]}));
});
test('15-22 real source/cell emptiness, degeneracy and malformed structures remain rejected',()=>{
  const invalid=[{type:'Polygon',coordinates:[]},{type:'MultiPolygon',coordinates:[]},{type:'GeometryCollection',geometries:[]},{type:'Polygon',coordinates:[[[0,0],[1,0],[2,0],[0,0]]]},{type:'Polygon',coordinates:[[]]},{type:'Polygon',coordinates:null}];
  for(const geometry of invalid){assert.throws(()=>partitionCoverage(geometry,[box(0,0,1,1)]));assert.throws(()=>partitionCoverage(box(0,0,1,1),[geometry]));const input=fixture();input.cells[0].geometry=geometry;assert.equal(auditCountryData(input).status,'FAIL');}
});

function numericalPreviousFixture(){
  const parent=box(-50,-80,50,80),parts=[{type:'Polygon',coordinates:[[[-50,-80],[50,-80],[50+8e-13,-40],[50,0],[50-8e-13,40],[50,80],[-50,80],[-50,-80]]]}],sourceArea=indexedArea(parent),sumArea=parts.reduce((n,g)=>n+planarArea(g),0),ledger=[];
  const evidence={countryId:'TST',oldTerritoryId:'old',ledger,ledgerRoot:previousRepairLedgerRoot(ledger),descriptor:{sourceCountryId:'TST',oldTerritoryId:'old',geometryHash:geometryHash(parent),sourceGeometryArea:sourceArea,numericalRepairAreaDelta:0,expectedCellUnionArea:sourceArea,cellUnionArea:sumArea,areaDifference:Math.abs(sumArea-sourceArea),tolerance:AUDIT_LIMITS.previousCoverageAbsolute,unionPass:true},approval:{status:'pass',checks:{globalNoding:true,previousGeometryParentUnion:true},independent:{status:'pass',checks:{parentUnions:true,sourceCorrespondence:true,sourceComponentLineage:true,boundaryCorrespondence:true,repairEvidence:true,completeByteReplay:true}},policy:{previousAreaAbsoluteTolerance:2e-11,coordinateToleranceDegrees:1e-12,fixedGridCoverageToleranceDegrees:AUDIT_LIMITS.boundaryGapDegrees,numericalRepairBoundaryToleranceDegrees:2e-6}},generation:{status:'pass',checks:{numericalNoding:true,protectedFragmentConservation:true},maximumNodedSegmentDisplacement:7e-13},boundaryRepairs:[]};
  return {parent,parts,sumArea,evidence,options:{absolute:2e-11,relative:0,previousEvidence:evidence}};
}
test('15-22 previous metric uses the approved area sum and separately certifies every numerical gap/outside location',()=>{
  const f=numericalPreviousFixture(),strict=partitionCoverage(f.parent,f.parts,{absolute:2e-11,relative:0}),result=partitionCoverage(f.parent,f.parts,f.options);
  assert.equal(strict.pass,false);assert.ok(strict.gapArea>2e-11&&strict.outsideArea>2e-11);assert.equal(result.pass,true);assert.equal(result.previousAreaMetric.pass,true);assert.equal(result.previousAreaMetric.tolerance,2e-11);assert.equal(result.previousBoundaryCertificate.gap.pass,true);assert.equal(result.previousBoundaryCertificate.outside.pass,true);assert.ok(result.previousBoundaryCertificate.gap.maximumOrdinaryDistanceDegrees<=1e-12);
  assert.equal(partitionCoverage(f.parent,[f.parent],f.options).pass,true);
});
test('15-22 zero net area cannot excuse actual gaps/outside or missing source/noding evidence',()=>{
  const f=numericalPreviousFixture(),moved=[box(-49.99,-80,50.01,80)];f.evidence.descriptor.cellUnionArea=planarArea(moved[0]);f.evidence.descriptor.areaDifference=Math.abs(f.evidence.descriptor.cellUnionArea-indexedArea(f.parent));
  const result=partitionCoverage(f.parent,moved,f.options);assert.equal(result.previousAreaMetric.areaDifference,0);assert.equal(result.pass,false);assert.equal(result.checks.gap,false);assert.equal(result.checks.outside,false);assert.ok(result.previousBoundaryCertificate.gap.failures.length);
  const missing=numericalPreviousFixture();assert.equal(partitionCoverage(missing.parent,missing.parts,{absolute:2e-11,relative:0}).pass,false);delete missing.evidence.approval.independent;assert.throws(()=>partitionCoverage(missing.parent,missing.parts,missing.options),/approved source\/noding/);
});
test('15-22 previous repair accounting rejects wrong parent/hash/area/sign, duplicate and tampered ledger evidence',()=>{
  const repair={countryId:'TST',ledger:'protected',kind:'collapsed-protected-fragment-union',area:1e-13,geometryHash:'a'.repeat(64),beforeGeometryHash:'b'.repeat(64),afterGeometryHash:'c'.repeat(64),sourceOldTerritoryId:'other',assignedOldTerritoryId:'old'};
  const fixtureWithRepair=()=>{const f=numericalPreviousFixture();f.evidence.ledger=[{...repair}];f.evidence.ledgerRoot=previousRepairLedgerRoot(f.evidence.ledger);f.evidence.descriptor.numericalRepairAreaDelta=repair.area;f.evidence.descriptor.expectedCellUnionArea=indexedArea(f.parent)+repair.area;f.evidence.descriptor.areaDifference=Math.abs(f.sumArea-f.evidence.descriptor.expectedCellUnionArea);return f;};
  const good=fixtureWithRepair();assert.equal(validatePreviousMetricEvidence(good.parent,good.sumArea,good.evidence).pass,true);
  for(const change of [f=>{f.evidence.descriptor.oldTerritoryId='wrong';},f=>{f.evidence.descriptor.geometryHash='wrong';},f=>{f.evidence.descriptor.sourceGeometryArea+=1;},f=>{f.evidence.descriptor.numericalRepairAreaDelta=-repair.area;},f=>{f.evidence.ledger[0].geometryHash='d'.repeat(64);},f=>{f.evidence.ledger[0].area*=2;f.evidence.ledgerRoot=previousRepairLedgerRoot(f.evidence.ledger);},f=>{f.evidence.ledger[0].sourceOldTerritoryId='old';f.evidence.ledger[0].assignedOldTerritoryId='other';f.evidence.ledgerRoot=previousRepairLedgerRoot(f.evidence.ledger);},f=>{f.evidence.ledger.push({...f.evidence.ledger[0]});f.evidence.ledgerRoot=previousRepairLedgerRoot(f.evidence.ledger);}]){const f=fixtureWithRepair();change(f);assert.throws(()=>validatePreviousMetricEvidence(f.parent,f.sumArea,f.evidence),/Invalid approved previous-area evidence/);}
});
test('15-22 approved repair locations require exact local segment, component chain, parent, geometry hash and area',()=>{
  const f=numericalPreviousFixture(),parent=box(0,0,2,1),other=box(2,0,3,1),a=[2-1e-6,1],b=[2,1-1e-6],gap={type:'Polygon',coordinates:[[a,b,[2,1],a]]},empty={type:'MultiPolygon',coordinates:[]};
  const repair={countryId:'TST',ledger:'protected',kind:'collapsed-protected-fragment-union',area:5e-13,geometryHash:'a'.repeat(64),beforeGeometryHash:'b'.repeat(64),afterGeometryHash:'c'.repeat(64),sourceOldTerritoryId:'other',assignedOldTerritoryId:'old'};
  const protectedSources=[{properties:{sourceCountryId:'TST',territoryId:'old'},geometry:parent},{properties:{sourceCountryId:'TST',territoryId:'other'},geometry:other}],index=oldBoundaryIndex({type:'FeatureCollection',features:protectedSources},x=>x.properties.territoryId),options={distanceTolerance:2e-6,gapTolerance:2e-6},source=oldBoundaryMatch(a,b,'other',index,options),assigned=oldBoundaryMatch(a,b,'old',index,options);
  const witness={kind:'protected-fragment-transfer-boundary',segment:[a,b],owner:1,otherOwner:2,ownerOldTerritoryId:'old',assignedOldTerritoryId:'old',sourceOldTerritoryId:'other',ownerSourceComponentHash:repair.afterGeometryHash,oppositeSourceComponentHash:'d'.repeat(64),repairGeometryHash:repair.geometryHash,repairAfterGeometryHash:repair.afterGeometryHash,repairArea:repair.area,lineage:'owner-component-chain',assignedPass:true,maximumDistanceDegrees:Math.max(source.maximumDistance,assigned.maximumDistance),sourceGapDegrees:source.gapDegrees,assignedGapDegrees:assigned.gapDegrees,ownerCell:{ordinal:1,sourceCountryId:'TST',oldTerritoryId:'old',sourceComponentHash:repair.afterGeometryHash},oppositeCell:{ordinal:2,sourceCountryId:'TST',oldTerritoryId:'other',sourceComponentHash:'d'.repeat(64)},protectedSources};
  f.evidence.ledger=[repair];f.evidence.boundaryRepairs=[witness];assert.equal(certifyPreviousDifferenceLocations(parent,gap,empty,f.evidence).gap.repaired,1);assert.equal(certifyPreviousDifferenceLocations(parent,gap,empty,{...f.evidence,boundaryRepairs:[]}).gap.pass,false);
  for(const change of [w=>{w.repairArea*=2;},w=>{w.repairGeometryHash='e'.repeat(64);},w=>{w.ownerCell.oldTerritoryId='wrong';},w=>{w.ownerCell.sourceComponentHash='wrong';},w=>{w.lineage='unproven';},w=>{w.segment=[[0,0],[1,0]];}]){const bad=structuredClone(witness);change(bad);assert.throws(()=>certifyPreviousDifferenceLocations(parent,gap,empty,{...f.evidence,boundaryRepairs:[bad]}),/Invalid previous-boundary repair/);}
});
test('15-22 previous numerical model never overrides positive component loss or actual hole fill',()=>{
  const f=numericalPreviousFixture(),tiny=box(70,0,70.0000001,.0000001),multi={type:'MultiPolygon',coordinates:[f.parent.coordinates,tiny.coordinates]};assert.equal(partitionCoverage(multi,[f.parent],f.options).checks.components,false);assert.equal(partitionCoverage(multi,[f.parent],f.options).pass,false);
  const hole=box(0,0,.0000001,.0000001).coordinates[0].slice().reverse(),holed={type:'Polygon',coordinates:[f.parent.coordinates[0],hole]};assert.equal(partitionCoverage(holed,[f.parent],f.options).checks.holes,false);assert.equal(partitionCoverage(holed,[f.parent],f.options).pass,false);
});

const corridorParent=()=>({type:'Polygon',coordinates:[[[-1,-1],[0,-1],[0,-1e-13],[1,-1e-13],[1,-1],[2,-1],[2,1],[1,1],[1,1e-13],[0,1e-13],[0,1],[-1,1],[-1,-1]]]});
test('15-22 rejects a positive island far below area tolerance even when all area gates pass',()=>{
  const main=box(0,0,1,1),tiny=box(100,10,100+1e-12,10+1e-12),parent={type:'MultiPolygon',coordinates:[main.coordinates,tiny.coordinates]};assert.ok(planarArea(tiny)>0&&planarArea(tiny)<1e-20);
  const r=partitionCoverage(parent,[main]);assert.equal(r.checks.gap,true);assert.equal(r.checks.outside,true);assert.equal(r.expectedShape.components,2);assert.equal(r.supportedComponents,1);assert.equal(r.checks.components,false);assert.equal(r.pass,false);
});
test('15-22 rejects merging separate polygons or creating a narrow false land connection',()=>{
  const left=box(0,0,1,1),right=box(1+1e-12,0,2,1),parent={type:'MultiPolygon',coordinates:[left.coordinates,right.coordinates]},merged=partitionCoverage(parent,[box(0,0,2,1)]);
  assert.equal(merged.checks.outside,true);assert.equal(merged.supportedComponents,2);assert.equal(merged.actualShape.components,1);assert.equal(merged.checks.components,false);assert.equal(merged.pass,false);
  const lobes={type:'MultiPolygon',coordinates:[box(-1,-1,0,1).coordinates,box(1,-1,2,1).coordinates]},bridge=partitionCoverage(lobes,[corridorParent()]);assert.equal(bridge.checks.outside,true);assert.equal(bridge.checks.components,false);assert.equal(bridge.pass,false);
});
test('15-22 rejects loss of a real positive-area corridor below the coverage area tolerance',()=>{
  const r=partitionCoverage(corridorParent(),[box(-1,-1,0,1),box(1,-1,2,1)]);assert.ok(r.gapArea>0&&r.gapArea<r.tolerance);assert.equal(r.expectedShape.components,1);assert.equal(r.actualShape.components,2);assert.equal(r.checks.components,false);assert.equal(r.pass,false);
});
test('15-22 point contact cannot replace the interior connection of a source polygon',()=>{
  const left=union([box(-1,-1,0,1),{type:'Polygon',coordinates:[[[0,-1e-13],[.5,0],[0,1e-13],[0,-1e-13]]]}]),right=union([box(1,-1,2,1),{type:'Polygon',coordinates:[[[.5,0],[1,-1e-13],[1,1e-13],[.5,0]]]}]),r=partitionCoverage(corridorParent(),[left,right]);
  assert.equal(overlayArea(intersection(left,right)),0);assert.equal(r.checks.gap,true);assert.equal(r.actualShape.components,2);assert.equal(r.checks.components,false);assert.equal(r.pass,false);
});
test('15-22 wrong-parent or wrong-hash repair evidence cannot justify component loss',()=>{
  const parent={type:'MultiPolygon',coordinates:[box(0,0,1,1).coordinates,box(100,10,100+1e-12,10+1e-12).coordinates]};
  for(const previousEvidence of [{countryId:'WRONG',oldTerritoryId:'wrong',descriptor:{geometryHash:'wrong'},ledger:[]},{countryId:'TST',oldTerritoryId:'old',descriptor:{geometryHash:geometryHash(parent)},ledger:[{kind:'collapsed-component-ledger',lostGeometryHash:'wrong',area:1e-24,parentKey:'wrong'}]}]){
    const r=partitionCoverage(parent,[box(0,0,1,1)],{absolute:2e-11,relative:0,previousEvidence});assert.equal(r.checks.components,false);assert.equal(r.pass,false);assert.equal(r.previousAreaMetric,undefined);
  }
});
test('15-22 normal cell partitions retain every component, including legitimate point-touch polygons',()=>{
  const a=box(0,0,1,1),b=box(1,1,2,2),parent={type:'MultiPolygon',coordinates:[a.coordinates,b.coordinates]},r=partitionCoverage(parent,[box(0,0,.5,1),box(.5,0,1,1),box(1,1,1.5,2),box(1.5,1,2,2)]);
  assert.equal(r.pass,true);assert.equal(r.expectedShape.components,2);assert.equal(r.supportedComponents,2);assert.equal(r.actualShape.components,2);
});
