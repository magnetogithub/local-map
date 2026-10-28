import assert from 'node:assert/strict';
import test from 'node:test';
import {auditCountryResult} from './prompt15-world-catalog.mjs';

const passingResult=()=>({
 validity:{pass:true},
 preservation:{pass:true,errors:[],correspondence:[{exactPositive:true,sourceFeatureIds:['source-1'],coverage:{pass:true},boundaryCertificate:{pass:true}}]},
 sourceComponents:[{}],
 coverage:[{pass:true}],
 parents:[{parentKey:'TST:admin-1'}],
 countryCoverage:{pass:true,outOfCountryArea:0,tolerance:1e-9},
 cells:[{
  oldTerritoryId:'territory-old-1',
  adminId:'admin-1',
  parentSourceFeatureId:'admin-1',
  refined:false,
  diameterUpperBoundKm:8,
  areaKm2:40,
  geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]},
 }],
 numericalNoding:{maximumNodedSegmentDisplacement:0},
 numericalProtectedFragmentRepairs:[],
 numericalCellRepairs:[],
 metrics:{numericalProtectedFragmentsSkipped:0,sliverEvaluation:{legacy:{count:{ratio:0},area:{ratio:0}},errors:[]}},
});

test('15-19 country gate accepts complete evidence and rejects protected-parent or cross-border regressions',()=>{
 const accepted=auditCountryResult(passingResult());
 assert.equal(accepted.status,'pass');
 assert.ok(Object.values(accepted.checks).every(Boolean));

 const missingProtectedParent=passingResult();
 missingProtectedParent.cells[0].oldTerritoryId='protected-overlay-split';
 assert.equal(auditCountryResult(missingProtectedParent).status,'fail');

 const crossingBorder=passingResult();
 crossingBorder.countryCoverage.outOfCountryArea=2e-9;
 assert.equal(auditCountryResult(crossingBorder).status,'fail');

 const disconnected=passingResult();
 disconnected.cells[0].geometry={type:'MultiPolygon',coordinates:[[[[0,0],[1,0],[1,1],[0,1],[0,0]]],[[[2,0],[3,0],[3,1],[2,1],[2,0]]]]};
 assert.equal(auditCountryResult(disconnected).status,'fail');
 const badSlivers=passingResult();badSlivers.metrics.sliverEvaluation.legacy.count.ratio=.36;assert.equal(auditCountryResult(badSlivers).checks.sliverCount,false);
 const badArea=passingResult();badArea.metrics.sliverEvaluation.legacy.area.ratio=.011;assert.equal(auditCountryResult(badArea).checks.sliverArea,false);
 const absent=passingResult();delete absent.metrics.sliverEvaluation;assert.equal(auditCountryResult(absent).status,'fail');
});
