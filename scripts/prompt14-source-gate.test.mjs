import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {buildDerived, normalizeCollection, verifyRepair, REPAIR_POLICY} from "./prompt14-repair.mjs";
import {diagnoseRejectedFeature} from "./prompt14-topology-diagnosis.mjs";
import {selectGameInputs,writeAtomicDerived,validateP0CountryOwnership} from "./prompt14-game-selection.mjs";
import turfValid from "@turf/boolean-valid";
import {verifySharedP0,measureBoundaryChange,validatePartialOccupationReadiness,buildSharedP0,validateDerivedGameLock,prepareTopologyP1,estimateComponentAtoms,planSourceComponentGroups,verifySourceComponentGroups} from "./prompt14-shared-topology.mjs";
import {hasSourceBoundaryContact,sourceBoundaryDistance,certifyResidualBoundary} from "./prompt14-game-selection.mjs";

import {
  benchmarkDeterministicDelivery,
  calculateProductionCoverage,
  evaluateHardGate,
  exitCodeForHardGate,
  resolveAdmin1Parents,
  runContainmentPolicyFixtures,
  sha256,
  summarizePackageVersions,
  validateCaps,
  validateBoundarySourceLockSchema,
  validateCanonicalProvenance,
  validatePolygonFeatureCollection,
  validateSourceLock,
  validateSourceLockManifestSchema,
  assertReportStatusConsistent,
  CANONICAL_P0_VALIDATOR_POLICY,
} from "./prompt14-source-gate.mjs";

const clockwiseSquare = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
const polygonFeature = (id = "AAA", coordinates = clockwiseSquare) => ({type: "Feature", properties: {countryId: id}, geometry: {type: "Polygon", coordinates: [coordinates]}});
const collection = (features) => ({type: "FeatureCollection", features});

test("independent boundary thinning detects both overlap and gap instead of accepting valid polygons",()=>{
  const left=polygonFeature("AAA",[[0,0],[1.0001,0],[1.0001,1],[0,1],[0,0]]);
  const right=polygonFeature("BBB",[[1,0],[2,0],[2,1],[1,1],[1,0]]);
  assert.equal(validateP0CountryOwnership(collection([left,right])).pass,false);
  const gap=polygonFeature("AAA",[[0,0],[.9999,0],[.9999,1],[0,1],[0,0]]);
  assert.ok(measureBoundaryChange(left.geometry,gap.geometry).sampledMaximumBoundaryDisplacementDegrees>0);
});

test("derived P0 rejects hole/island deletion, displaced boundary and non-deterministic bytes",()=>{
  const f=polygonFeature("AAA");f.geometry.coordinates.push([[.2,.2],[.8,.2],[.8,.8],[.2,.8],[.2,.2]]);
  const source=normalizeCollection(collection([f]),CANONICAL_P0_VALIDATOR_POLICY),bytes=Buffer.from("same");
  const deleted=normalizeCollection(collection([polygonFeature("AAA")]),CANONICAL_P0_VALIDATOR_POLICY);
  assert.equal(verifySharedP0(source,deleted,bytes,bytes).pass,false);
  assert.equal(verifySharedP0(source,source,bytes,Buffer.from("different")).pass,false);
  const displaced=structuredClone(source);displaced.features[0].geometry.coordinates[0][0][0]-=.01;
  assert.equal(verifySharedP0(source,displaced,bytes,bytes).pass,false);
  const island=structuredClone(source);island.features[0].geometry={type:"MultiPolygon",coordinates:[f.geometry.coordinates,[[[2,2],[2.01,2],[2.01,2.01],[2,2.01],[2,2]]]]};
  assert.equal(verifySharedP0(normalizeCollection(island,CANONICAL_P0_VALIDATOR_POLICY),source,bytes,bytes).pass,false);
});

test("required major countries cannot silently fall back or lose source administrative identities",()=>{
  const complete=["USA","CHN","KOR","GBR","FRA"].map(countryId=>({countryId,selection:"aligned-P1",originalP1FeatureCount:10,selectedFeatureCount:10,maintainedP1SourceFeatureIds:Array.from({length:10},(_,i)=>String(i))}));
  assert.equal(validatePartialOccupationReadiness(complete).pass,true);
  assert.equal(validatePartialOccupationReadiness(complete.map(c=>c.countryId==="USA"?{...c,selection:"P0-fallback",selectedFeatureCount:1}:c)).pass,false);
  assert.equal(validatePartialOccupationReadiness(complete.map(c=>c.countryId==="KOR"?{...c,selectedFeatureCount:2}:c)).pass,false);
});

test("only a complete source-backed disconnected island may supplement actual P1 territories",()=>{
  const a=polygonFeature("AAA"),b=polygonFeature("AAA",[[1,0],[1,1],[2,1],[2,0],[1,0]]);a.properties.ne_id="left";b.properties.ne_id="right";
  const base=polygonFeature("AAA",[[0,0],[2,0],[2,1],[0,1],[0,0]]);base.geometry={type:"MultiPolygon",coordinates:[base.geometry.coordinates,[[[5,5],[5.001,5],[5.001,5.001],[5,5.001],[5,5]]]]};
  const p0=normalizeCollection(collection([base]),CANONICAL_P0_VALIDATOR_POLICY),parents={entries:[{normalizedParentCountryId:"AAA"},{normalizedParentCountryId:"AAA"}]};
  const result=selectGameInputs(p0,collection([a,b]),parents,[{id:"AAA"}],{AAA:["pinned-source-feature"]});
  assert.equal(result.countries[0].selection,"aligned-P1",result.countries[0].reason);assert.equal(result.countries[0].selectedFeatureCount,3);
  assert.deepEqual(result.countries[0].maintainedP1SourceFeatureIds,["left","right"]);assert.equal(result.countries[0].sourceComponentFallbacks.length,1);assert.equal(result.countries[0].after.pass,true);
  assert.equal(selectGameInputs(p0,collection([a,b]),parents,[{id:"AAA"}]).countries[0].selection,"P0-fallback");
});

test("multi-adjacent residual is split by the actual shared administrative border",()=>{
  const p0=normalizeCollection(collection([polygonFeature("AAA",[[0,0],[2,0],[2,1.000001],[0,1.000001],[0,0]])]),CANONICAL_P0_VALIDATOR_POLICY);
  const a=polygonFeature("AAA"),b=polygonFeature("AAA",[[1,0],[1,1],[2,1],[2,0],[1,0]]);a.properties.ne_id="left";b.properties.ne_id="right";
  const result=selectGameInputs(p0,collection([a,b]),{entries:[{normalizedParentCountryId:"AAA"},{normalizedParentCountryId:"AAA"}]},[{id:"AAA"}]);
  assert.equal(result.countries[0].selection,"aligned-P1",result.countries[0].reason);
  assert.equal(result.countries[0].selectedFeatureCount,2);assert.equal(result.countries[0].after.pass,true);
});

test("shared P0 generation rejects a changed pinned raw input before publishing anything",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"prompt14-shared-source-"));
  try{fs.mkdirSync(path.join(root,"data/raw"),{recursive:true});fs.writeFileSync(path.join(root,"data/raw/ne_10m_admin_0_countries.geojson"),"{}");assert.throws(()=>buildSharedP0(root),/hash mismatch/);assert.equal(fs.existsSync(path.join(root,"data/derived")),false);}finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("a declared derived provenance cannot pass with missing originals or forged artifact hashes",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"prompt14-derived-lock-"));
  try{
    const lock={schemaVersion:"prompt14-derived-game-input-lock-v1",boundaryKind:"project-game-seed-derived-2020",legalEvidenceStatus:"not-required",release:"v5.1.2",sourceVersion:"fixture",license:"public domain",attribution:"fixture",acquiredFrom:"https://example.invalid",lineageInputs:[],artifacts:[{repositoryPath:"missing.geojson",sha256:"0".repeat(64),byteLength:2}]};
    const result=validateDerivedGameLock(lock,root);assert.equal(result.pass,false);assert.ok(result.errors.some(e=>e.includes("connection")));assert.ok(result.errors.some(e=>e.includes("artifact")));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("source precision contact requires shared segment extent, not nearest point proximity",()=>{
  const coast=polygonFeature().geometry;
  const parallel=polygonFeature("AAA",[[.2,1.0000005],[.8,1.0000005],[.8,1.1],[.2,1.1],[.2,1.0000005]]).geometry;
  assert.equal(hasSourceBoundaryContact(parallel,coast),true);
  const remote=polygonFeature("AAA",[[.2,1.0001],[.8,1.0001],[.8,1.1],[.2,1.1],[.2,1.0001]]).geometry;
  assert.equal(hasSourceBoundaryContact(remote,coast),false);
});

test("indexed residual boundary distance preserves exact and out-of-envelope rejection distances",()=>{
  const g=polygonFeature().geometry;assert.equal(sourceBoundaryDistance([.5,.0005],g),.0005);assert.equal(sourceBoundaryDistance([3,0],g),2);assert.equal(sourceBoundaryDistance([0,0],g),0);
});

test("nearby residual vertices do not conceal an unsupported long boundary bridge",()=>{
 const bridge=polygonFeature("AAA",[[0,0],[10,0],[10,.000001],[0,.000001],[0,0]]).geometry;
 const target={type:"MultiPolygon",coordinates:[[[[0,0],[.001,0],[.001,.001],[0,.001],[0,0]]],[[[9.999,0],[10,0],[10,.001],[9.999,.001],[9.999,0]]]]};
 assert.equal(sourceBoundaryDistance([0,0],target),0);assert.equal(sourceBoundaryDistance([10,0],target),0);assert.equal(certifyResidualBoundary(bridge,target).pass,false);
});

test("exact source self-touch can be noded with unchanged identity/area/boundary; bow-tie cannot",()=>{
  const touch=polygonFeature("AAA",[[0,0],[2,0],[1,1],[2,2],[0,2],[1,1],[0,0]]);
  const result=prepareTopologyP1(collection([touch]));assert.equal(result.repairs.length,1);assert.equal(result.identityPreserved,true);assert.equal(result.repairs[0].areaDeltaDegreesSquared,0);assert.equal(result.repairs[0].boundary.continuousMaximumCertified,true);
  const crossing=polygonFeature("AAA",[[0,0],[1,1],[0,1],[1,0],[0,0]]);const refused=prepareTopologyP1(collection([crossing]));assert.equal(refused.repairs.length,0);assert.equal(refused.unresolved.length,1);
});

test("feature count cannot conceal a component atom cap overflow",()=>{
  const f=polygonFeature();f.geometry={type:"MultiPolygon",coordinates:Array.from({length:6001},(_,i)=>[[[i*2,0],[i*2+1,0],[i*2+1,1],[i*2,1],[i*2,0]]])};
  const estimate=estimateComponentAtoms(collection([f]));assert.equal(estimate.sourceFeatureTerritoryEstimate,1);assert.equal(estimate.totalAtoms,6001);assert.equal(validateCaps(estimate,30005).pass,false);
});

test("explicit MultiPolygon grouping keeps every component of one source feature and rejects cross-P1 merges",()=>{
  const a=polygonFeature("AAA"),b=polygonFeature("AAA",[[2,0],[2,1],[3,1],[3,0],[2,0]]);a.properties.sourceFeatureId="A";b.properties.sourceFeatureId="B";
  a.geometry={type:"MultiPolygon",coordinates:[a.geometry.coordinates,[[[4,0],[4,1],[5,1],[5,0],[4,0]]]]};
  const input=collection([a,b]),plan=planSourceComponentGroups(input),result=verifySourceComponentGroups(input,plan);
  assert.equal(result.pass,true);assert.equal(result.rawComponentAtomCandidates,3);assert.equal(result.projectedAtoms,2);assert.equal(result.everyComponentPreserved,true);assert.equal(result.protectedBoundaryCrossings,0);
  assert.deepEqual(plan,planSourceComponentGroups(structuredClone(input)));
  const crossed=structuredClone(plan);crossed.groups[0].members.push(...crossed.groups[1].members);crossed.groups.pop();assert.equal(verifySourceComponentGroups(input,crossed).pass,false);
  const lost=structuredClone(plan);lost.groups[0].members.pop();assert.equal(verifySourceComponentGroups(input,lost).pass,false);
});

test("P0 ownership rejects neighboring overlap even when each country polygon is valid",()=>{
 const a=polygonFeature("AAA"),b=polygonFeature("BBB",[[0.5,0],[0.5,1],[1.5,1],[1.5,0],[0.5,0]]);
 const result=validateP0CountryOwnership(collection([a,b]));
 assert.equal(result.pass,false);assert.equal(result.overlapPairCount,1);assert.equal(result.overlaps[0].overlapAreaDegreesSquared,0.5);
 const touch=polygonFeature("BBB",[[1,1],[1,2],[2,2],[2,1],[1,1]]);
 assert.equal(validateP0CountryOwnership(collection([a,touch])).pass,true);
});

test("P0 metadata omissions and duplicate P1 identities cannot become fallback passes",()=>{
 const p0=normalizeCollection(collection([polygonFeature()]),CANONICAL_P0_VALIDATOR_POLICY);
 assert.throws(()=>selectGameInputs(p0,collection([]),{entries:[]},[{id:"AAA"},{id:"BBB"}]),/sets differ/);
 const source=collection([polygonFeature(),polygonFeature()]);
 assert.throws(()=>selectGameInputs(p0,source,{entries:[{normalizedParentCountryId:"AAA"},{normalizedParentCountryId:"AAA"}]},[{id:"AAA"}]),/duplicate P1 identity/);
});

test("seed USA point-touch components pass independent OGC validity despite Turf rejection",()=>{
  const seed=JSON.parse(fs.readFileSync("public/data/maps/countries-10m.geojson","utf8"));
  const usa=seed.features.find(f=>f.properties.countryId==="USA");
  const fixture={...usa,geometry:{type:"MultiPolygon",coordinates:[usa.geometry.coordinates[22],usa.geometry.coordinates[23]]}};
  assert.equal(turfValid(fixture),false);
  assert.equal(validatePolygonFeatureCollection(collection([fixture]),"USA-point-touch",CANONICAL_P0_VALIDATOR_POLICY).pass,true);
});

test("game P0 contract passes without legal proof but rejects missing lineage, wrong hashes or failed replay",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"prompt14-game-contract-"));
 try {
  const bytes=Buffer.from(JSON.stringify(collection([polygonFeature()])));
  const pins=["code","current","metadata","raw"].map(role=>({role,repositoryPath:role+".geojson",sha256:sha256(bytes)}));
  for(const pin of pins)fs.writeFileSync(path.join(root,pin.repositoryPath),bytes);
  const lock={sourceId:"p0",release:"v1",sourceVersion:"1",license:"MIT",attribution:"fixture",acquiredFrom:"https://fixture.example/v1/raw.geojson",repositoryPath:"current.geojson",sha256:sha256(bytes),byteLength:bytes.length,geometryTypes:["Polygon"],coveredCountryIds:["AAA"],boundaryKind:"project-game-seed-2020",operationalOnly:false};
  const policy={gameStartDate:"2020-01-01",boundaryClaim:"project-game-seed-country-boundaries",pinnedInputs:pins};
  const provenance={sourceId:"p0",gameStartDate:policy.gameStartDate,boundaryClaim:policy.boundaryClaim,legalEvidenceStatus:"not-required",lineageInputs:pins.map(p=>({...p,byteLength:bytes.length}))};
  const replay={pass:true,...Object.fromEntries(pins.map(p=>[p.role,{sha256:p.sha256,byteLength:bytes.length}]))};
  assert.equal(validateCanonicalProvenance(provenance,[lock],root,policy,replay).pass,true);
  assert.equal(validateCanonicalProvenance({...provenance,legalEvidenceStatus:"verified"},[lock],root,policy,replay).pass,false);
  assert.equal(validateCanonicalProvenance({...provenance,lineageInputs:provenance.lineageInputs.slice(1)},[lock],root,policy,replay).pass,false);
  assert.equal(validateCanonicalProvenance(provenance,[{...lock,sha256:"0".repeat(64)}],root,policy,replay).pass,false);
  assert.equal(validateCanonicalProvenance(provenance,[lock],root,policy,{...replay,pass:false}).pass,false);
  assert.equal(validateCanonicalProvenance(provenance,[lock],root,policy,null).pass,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("unsafe P1 uses whole-country P0 with exact coverage and explicit identity exclusions",()=>{
 const p0=normalizeCollection(collection([polygonFeature()]),CANONICAL_P0_VALIDATOR_POLICY);
 const invalid=collection([polygonFeature("AAA",[[0,0],[1,1],[0,1],[1,0],[0,0]])]);
 const parents={entries:[{normalizedParentCountryId:"AAA",excluded:false}]};
 const result=selectGameInputs(p0,invalid,parents,[{id:"AAA"}]);
 assert.equal(result.pass,true);assert.deepEqual(result.fallbackCountries,["AAA"]);
 assert.equal(result.collection.features.length,1);assert.deepEqual(result.collection.features[0].geometry,p0.features[0].geometry);
 assert.equal(result.countries[0].after.gapArea,0);assert.equal(result.countries[0].excludedP1SourceFeatureIds.length,1);
 assert.match(result.countries[0].reason,/invalid original P1/);
});

test("real missing area is not silently accepted or filled; two selections are deterministic",()=>{
 const p0=normalizeCollection(collection([polygonFeature()]),CANONICAL_P0_VALIDATOR_POLICY);
 const small=collection([polygonFeature("AAA",[[0,0],[0,0.5],[0.5,0.5],[0.5,0],[0,0]])]);
 const parents={entries:[{normalizedParentCountryId:"AAA",excluded:false}]};
 const first=selectGameInputs(p0,small,parents,[{id:"AAA"}]),second=selectGameInputs(p0,small,parents,[{id:"AAA"}]);
 assert.equal(first.countries[0].before.pass,false);assert.equal(first.countries[0].selection,"P0-fallback");
 assert.match(first.countries[0].reason,/exceeds/);assert.deepEqual(first,second);
});

test("atomic derived publication cannot write outside the dedicated input directory",()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"prompt14-atomic-"));
 try {
  const bytes=Buffer.from("{}\n");
  assert.throws(()=>writeAtomicDerived(root,"public/runtime.geojson",bytes),/outside/);
  const evidence=writeAtomicDerived(root,"data/derived/prompt14/fixture.geojson",bytes);
  assert.equal(evidence.sha256,sha256(bytes));assert.deepEqual(fs.readFileSync(path.join(root,evidence.repositoryPath)),bytes);
  assert.deepEqual(fs.readdirSync(path.join(root,"data/derived/prompt14")),["fixture.geojson"]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("lossless duplicate normalization preserves boundary and feature identity", () => {
  const source = collection([polygonFeature("AAA",[clockwiseSquare[0],...clockwiseSquare])]);
  const repaired = normalizeCollection(source);
  const bytes = Buffer.from(JSON.stringify(repaired));
  const result = verifyRepair(source,repaired,bytes,bytes);
  assert.equal(result.pass,true);
  assert.equal(result.boundaryDisplacement,0);
  assert.equal(result.maximumAreaDeltaDegreesSquared,0);
  assert.equal(source.features[0].geometry.coordinates[0].length,6);
  assert.equal(REPAIR_POLICY.boundaryDisplacementTolerance,0);
});

test("repair rejects changed coverage even when output polygons are valid", () => {
  const source = collection([polygonFeature()]);
  const changed = collection([polygonFeature("AAA",[[0,0],[0,1],[2,1],[2,0],[0,0]])]);
  const bytes = Buffer.from(JSON.stringify(changed));
  assert.equal(verifyRepair(source,changed,bytes,bytes).pass,false);
  assert.equal(verifyRepair(source,collection([]),bytes,bytes).pass,false);
});

test("repair non-determinism and unrepairable topology remain blocked", () => {
  const source = collection([polygonFeature()]);
  assert.equal(verifyRepair(source,source,Buffer.from("a"),Buffer.from("b")).pass,false);
  const bad = collection([polygonFeature("AAA",[[0,0],[1,1],[0,1],[1,0],[0,0]])]);
  const result = normalizeCollection(bad), bytes = Buffer.from(JSON.stringify(result));
  assert.equal(verifyRepair(bad,result,bytes,bytes).pass,false);
});

test("derived generation refuses original hash mismatch before writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),"prompt14-repair-"));
  try {
    fs.writeFileSync(path.join(root,"input.geojson"),JSON.stringify(collection([polygonFeature()])));
    assert.throws(()=>buildDerived(root,"input.geojson","0".repeat(64)),/source digest mismatch/);
    assert.equal(fs.existsSync(path.join(root,"data/derived")),false);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test("diagnosis distinguishes repeated ring defects from component area overlap", () => {
  const repeated=polygonFeature("AAA",[[0,0],[0,2],[1,1],[2,2],[1,1],[2,0],[0,0]]);
  assert.equal(diagnoseRejectedFeature(repeated).classification,"ring-spike-or-puncture-defect");
  const overlap={type:"Feature",properties:{},geometry:{type:"MultiPolygon",coordinates:[[clockwiseSquare],[[[0.5,0.5],[0.5,1.5],[1.5,1.5],[1.5,0.5],[0.5,0.5]]]]}};
  const result=diagnoseRejectedFeature(overlap);
  assert.equal(result.classification,"component-overlap-or-shared-edge-defect");
  assert.ok(result.intersectionAreaDegreesSquared>0);
});


test("missing source file produces a failed lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt14-missing-"));
  try {
    const result = validateSourceLock({sourceId: "x", release: "1", sourceVersion: "1", license: "MIT", attribution: "x", acquiredFrom: "https://authority.example/releases/1/source.geojson", repositoryPath: "missing.geojson", sha256: "0".repeat(64), byteLength: 1, geometryTypes: ["Polygon"], coveredCountryIds: ["AAA"], boundaryKind: "administrative-operational", operationalOnly: true}, root);
    assert.equal(result.pass, false);
    assert.equal(result.fileExists, false);
    assert.equal(exitCodeForHardGate(evaluateHardGate({requiredSource: result})), 2);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("source SHA-256 mismatch produces a failed lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt14-sha-"));
  try {
    fs.writeFileSync(path.join(root, "source.geojson"), "{}");
    const result = validateSourceLock({sourceId: "x", release: "1", sourceVersion: "1", license: "MIT", attribution: "x", acquiredFrom: "https://authority.example/releases/1/source.geojson", repositoryPath: "source.geojson", sha256: "0".repeat(64), byteLength: 2, geometryTypes: ["Polygon"], coveredCountryIds: ["AAA"], boundaryKind: "administrative-operational", operationalOnly: true}, root);
    assert.equal(result.pass, false);
    assert.equal(result.bytesMatch, false);
    assert.equal(exitCodeForHardGate(evaluateHardGate({sourceHash: result})), 2);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("wrong geometry type and open ring are rejected", () => {
  const wrong = validatePolygonFeatureCollection(collection([{type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: [[0, 0], [1, 1]]}}]));
  const open = validatePolygonFeatureCollection(collection([polygonFeature("AAA", [[0, 0], [0, 1], [1, 1], [1, 0]])]));
  assert.equal(wrong.pass, false);
  assert.equal(open.pass, false);
});

test("self-intersecting polygon is rejected", () => {
  const bowTie = [[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]];
  const result = validatePolygonFeatureCollection(collection([polygonFeature("AAA", bowTie)]));
  assert.equal(result.pass, false);
  assert.match(result.errors.join("\n"), /degenerate|boolean-valid|OGC/);
});

test("a hole outside its exterior and overlapping MultiPolygon components are rejected", () => {
  const outsideHole = collection([{type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [
    [[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]],
    [[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]],
  ]}}]);
  const overlappingComponents = collection([{type: "Feature", properties: {}, geometry: {type: "MultiPolygon", coordinates: [
    [[ [0, 0], [0, 2], [2, 2], [2, 0], [0, 0] ]],
    [[ [1, 1], [1, 3], [3, 3], [3, 1], [1, 1] ]],
  ]}}]);
  const holeResult = validatePolygonFeatureCollection(outsideHole);
  const componentResult = validatePolygonFeatureCollection(overlappingComponents);
  assert.equal(holeResult.pass, false);
  assert.match(holeResult.errors.join("\n"), /hole is not contained/);
  assert.equal(componentResult.pass, false);
});

test("unknown Admin-1 parent is unresolved", () => {
  const source = collection([{type: "Feature", properties: {ne_id: 1, adm0_a3: "ZZZ", sov_a3: "ZZZ", gu_a3: "ZZZ"}, geometry: {type: "Polygon", coordinates: [clockwiseSquare]}}]);
  const result = resolveAdmin1Parents(source, ["AAA"], [{id: "AAA", flagCode: "AA"}]);
  assert.equal(result.allResolved, false);
  assert.equal(result.unresolved.length, 1);
});

test("production coverage rejects a missing and zero-atom country", () => {
  const p0 = collection([polygonFeature("AAA")]);
  const resolution = {entries: [], allResolved: true};
  const result = calculateProductionCoverage(p0, resolution, [{pass: true}], ["AAA", "BBB"]);
  assert.equal(result.fullCoverage, false);
  assert.deepEqual(result.missingCountries.map((entry) => entry.countryId), ["BBB"]);
  assert.deepEqual(result.zeroAtomCountries.map((entry) => entry.countryId), ["BBB"]);
});

test("production coverage uses the explicit production set and rejects duplicate or unknown P0 IDs", () => {
  const p0 = collection([polygonFeature("AAA"), polygonFeature("AAA"), polygonFeature("CCC")]);
  const resolution = {entries: [], allResolved: true};
  const result = calculateProductionCoverage(p0, resolution, [{pass: true}], ["AAA", "BBB"]);
  assert.equal(result.fullCoverage, false);
  assert.deepEqual(result.canonicalProductionCountryIds, ["AAA", "BBB"]);
  assert.deepEqual(result.duplicateP0CountryIds, ["AAA"]);
  assert.deepEqual(result.unknownP0CountryIds, ["CCC"]);
});

test("cap overflow is rejected", () => {
  const result = validateCaps({totalAtoms: 2, countries: [{countryId: "AAA", atomCount: 2}]}, 10, {worldAtoms: 1, countryAtoms: 1, authoritativeVertices: 5});
  assert.equal(result.pass, false);
});

test("source lock rejects missing required fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt14-lock-"));
  try {
    const bytes = Buffer.from("{}");
    fs.writeFileSync(path.join(root, "source.geojson"), bytes);
    const result = validateSourceLock({repositoryPath: "source.geojson", sha256: sha256(bytes), byteLength: bytes.length}, root);
    assert.equal(result.pass, false);
    assert.ok(result.missingFields.includes("release"));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("source lock rejects unknown boundary kinds and semantic operationalOnly mismatches", () => {
  const base = {sourceId: "p0", release: "2020", sourceVersion: "1", license: "public-domain", attribution: "authority", acquiredFrom: "https://authority.example/releases/2020/source.geojson", repositoryPath: "source.geojson", sha256: "0".repeat(64), byteLength: 1, geometryTypes: ["Polygon"], coveredCountryIds: ["AAA"]};
  assert.equal(validateBoundarySourceLockSchema({...base, boundaryKind: "legal-canonical", operationalOnly: false}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, boundaryKind: "project-game-seed-2020", operationalOnly: true}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, boundaryKind: "administrative-operational", operationalOnly: false}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, boundaryKind: "project-game-seed-2020", operationalOnly: false}, process.cwd()).pass, true);
});

test("source lock rejects floating identities and non-canonical arrays", () => {
  const base = {sourceId: "p0", release: "v5.1.2", sourceVersion: "f1890d9f152c896d250a77557a5751a93d494776", license: "public-domain", attribution: "authority", acquiredFrom: "https://authority.example/blob/f1890d9f152c896d250a77557a5751a93d494776/source.geojson", repositoryPath: "source.geojson", sha256: "0".repeat(64), byteLength: 1, geometryTypes: ["Polygon", "MultiPolygon"], coveredCountryIds: ["AAA", "BBB"], boundaryKind: "project-game-seed-2020", operationalOnly: false};
  assert.equal(validateBoundarySourceLockSchema({...base, release: "latest"}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, sourceVersion: "main"}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, acquiredFrom: "https://authority.example/main/source.geojson"}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, geometryTypes: ["MultiPolygon", "Polygon"]}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, coveredCountryIds: ["BBB", "AAA"]}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema(base, process.cwd()).pass, true);
});

test("source-lock v2 enforces game contract fields, sorted lineage and no fake verified legal evidence", () => {
 const provenance={sourceId:"p0",gameStartDate:"2020-01-01",boundaryClaim:"project-game-seed-country-boundaries",legalEvidenceStatus:"not-required",lineageInputs:[{role:"code",repositoryPath:"a",sha256:"0".repeat(64),byteLength:1}]};
 const manifest={schemaVersion:"prompt14-production-polygon-source-lock-v2",canonicalProvenance:provenance,sources:[{sourceId:"aaa"},{sourceId:"bbb"}]};
 assert.equal(validateSourceLockManifestSchema(manifest).pass,true);
 assert.equal(validateSourceLockManifestSchema({...manifest,schemaVersion:"prompt14-production-polygon-source-lock-v1"}).pass,false);
 assert.equal(validateSourceLockManifestSchema({...manifest,canonicalProvenance:{...provenance,legalEvidenceStatus:"verified"}}).pass,false);
 assert.equal(validateSourceLockManifestSchema({...manifest,canonicalProvenance:{...provenance,lineageInputs:[]}}).pass,false);
 assert.equal(validateSourceLockManifestSchema({...manifest,unexpected:true}).pass,false);
 assert.equal(validateSourceLockManifestSchema({...manifest,sources:[{sourceId:"bbb"},{sourceId:"aaa"}]}).pass,false);
});

test("delivery direct dependency version mismatch is rejected", () => {
  const result = summarizePackageVersions({dependencies: {"polygon-clipping": "0.15.7"}, devDependencies: {"geojson-vt": "4.0.2", "@maplibre/vt-pbf": "4.3.2", "@turf/boolean-valid": "7.4.0"}});
  assert.equal(result.pass, false);
});

test("delivery lockfile version mismatch is rejected", () => {
  const manifest = {dependencies: {"polygon-clipping": "0.15.7"}, devDependencies: {"geojson-vt": "4.0.3", "@maplibre/vt-pbf": "4.3.2", "@turf/boolean-valid": "7.4.0"}};
  const lockPackages = {"": {dependencies: manifest.dependencies, devDependencies: manifest.devDependencies}};
  const installed = {};
  for (const [name, version, license] of [["geojson-vt", "4.0.2", "ISC"], ["@maplibre/vt-pbf", "4.3.2", "MIT"], ["@turf/boolean-valid", "7.4.0", "MIT"]]) {
    lockPackages[`node_modules/${name}`] = {version, license, integrity: "sha512-test"};
    installed[name] = {version: name === "geojson-vt" ? "4.0.3" : version, license};
  }
  lockPackages["node_modules/polygon-clipping"] = {version: "0.15.7", license: "MIT", integrity: "sha512-test"};
  installed["polygon-clipping"] = {version: "0.15.7", license: "MIT"};
  assert.equal(summarizePackageVersions(manifest, {packages: lockPackages}, installed).pass, false);
});

test("containment policy rejects gap, overlap, and cross-border fixtures", () => {
  const result = runContainmentPolicyFixtures();
  assert.equal(result.pass, true);
  assert.equal(result.cases.success.pass, true);
  assert.equal(result.cases.gap.pass, false);
  assert.equal(result.cases.overlap.pass, false);
  assert.equal(result.cases.crossBorder.pass, false);
});

test("independent delivery generations are deterministic", () => {
  const result = benchmarkDeterministicDelivery(collection([{type: "Feature", properties: {ne_id: 1, adm0_a3: "AAA"}, geometry: {type: "Polygon", coordinates: [clockwiseSquare]}}]), 1);
  assert.equal(result.pass, true);
  assert.equal(result.byteIdentical, true);
  assert.equal(result.first.manifestRoot, result.second.manifestRoot);
});

test("hardGate.pass is exactly the AND and status contradictions are rejected", () => {
  const success = evaluateHardGate({a: {pass: true}, b: {pass: true}});
  const failure = evaluateHardGate({a: {pass: true}, b: {pass: false, error: "blocked"}});
  assert.equal(success.pass, true);
  assert.equal(failure.pass, false);
  assert.deepEqual(failure.firstBlockingCondition, {gate: "b", reason: "blocked"});
  assert.doesNotThrow(() => assertReportStatusConsistent("blocked", failure));
  assert.throws(() => assertReportStatusConsistent("pass", failure));
  assert.equal(exitCodeForHardGate(success), 0);
  assert.equal(exitCodeForHardGate(failure), 2);
});
