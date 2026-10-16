import {createHash} from 'node:crypto';
import {policy,policyIdentity} from '../policy-validation.mjs';
import {REPRESENTATIVES,SOURCE_WITNESSES,CANDIDATES} from '../representative-experiments/experiments.mjs';
import {summarizeCosts,hash,jsonBytes,validateGenerationEvidence} from '../cost-comparison/analysis.mjs';
import {verifyCellIdentity,CELL_CANONICALIZATION_VERSION} from '../../../src/lib/operational-cells/identity.ts';

const check=(condition,message)=>{if(!condition)throw new Error(message);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const SUMMARY_VERSION='prompt15-current-policy-selection-v3';
export const canonicalWitness=name=>name.replace(/-bounded-chart$/,'');
export const expectedSamples=Object.freeze([...REPRESENTATIVES,...SOURCE_WITNESSES].map(w=>canonicalWitness(w.name)));
export function verifyPinnedBytes(bytes,pin){
  check(bytes.length===pin.byteLength&&createHash('sha256').update(bytes).digest('hex')===pin.sha256,'EVIDENCE_IDENTITY_MISMATCH: '+pin.path);
  return bytes;
}
function completeCases(cases,name,candidate){
  check(cases.length===expectedSamples.length*CANDIDATES.length,'INCOMPLETE_WITNESS_MATRIX');
  for(const n of expectedSamples)for(const c of CANDIDATES)
    check(cases.filter(r=>canonicalWitness(name(r))===n&&candidate(r)===c).length===1,'MISSING_OR_DUPLICATE_WITNESS: '+n+'/'+c);
}
const finite=n=>Number.isFinite(n)&&n>=0;
function physicalFailures(record){
  const p=record.measurement.physical,failures=[...(p.coverageFailures??[]),...(p.stageFailures??[])];
  if(record.sample.fullParents||p.completeParentCoverage!==true)failures.push('incomplete-parent-resolution');
  for(const group of [...p.perParent,...p.perCountry]){
    failures.push(...group.failures.map(f=>group.label+':'+f));
    for(const zone of ['border','interior']){
      const v=group.zones[zone],limit=policy.physical[zone];
      if(!v){failures.push(group.label+':'+zone+'.missing');continue;}
      if(!finite(v.maxDiameterKm)||v.maxDiameterKm>limit.maxDiameterKm||v.maxDiameterKm/policy.physical.representativeAdvanceWKm>policy.physical.maxDiameterToWRatio)failures.push(group.label+':'+zone+'.diameter');
      if(!finite(v.maxAreaKm2)||v.maxAreaKm2>limit.maxAreaKm2)failures.push(group.label+':'+zone+'.area');
      if(!finite(v.maxAspectRatio)||v.maxAspectRatio>policy.physical.maxAspectRatio)failures.push(group.label+':'+zone+'.aspect');
    }
    for(const [field,limit]of [['countFraction',policy.physical.maxSliverCountFraction],['areaFractionUpper',policy.physical.maxSliverAreaFraction]])
      if(!finite(group.slivers[field])||group.slivers[field]>limit)failures.push(group.label+':sliver.'+field);
  }
  for(const zone of ['border','interior'])if(!finite(p.stages[zone])||p.stages[zone]<policy.physical.minDistinctDepthStages)failures.push(zone+'.depth-stages');
  if(!finite(record.sample.projection.relativeErrorBound)||record.sample.projection.relativeErrorBound>policy.physical.maxMetricRelativeError)failures.push('metric.error');
  if(p.status!=='eligible')failures.push('upstream.physical-rejected');
  return [...new Set(failures)].sort();
}
// Retain upstream status and exact failures, and independently check numerical
// limits. A claimed eligible label cannot promote over-wide or near-whole land.
function scopeNumericalFailures(s){
  const limit=policy.extent[s.extent],f=[];
  if(!limit)return ['unknown-extent'];
  for(const [key,bound,kind]of [['depthLowerKm',limit.minDepthKm,'min'],['depthUpperKm',limit.maxDepthKm,'max'],
    ['widthLowerKm',limit.minWidthKm,'min'],['widthUpperKm',limit.maxWidthKm,'max'],['areaUpperKm2',limit.maxAreaKm2,'max']])
    if(!finite(s[key])||(kind==='min'?s[key]<bound:s[key]>bound))f.push(key);
  if(s.connected!==true)f.push('positive-land-connected');
  if(!s.selected.length||s.selected.length>policy.budget.aggregateChangedCells)f.push('aggregate.cap');
  if(!s.perAdmin?.length)f.push('missing-admin-scope');
  for(const a of s.perAdmin??[]){
    if(!finite(a.areaFractionUpper)||a.areaFractionUpper>limit.maxAdminAreaFraction)f.push(a.parentKey+':admin.area-fraction');
    if(!finite(a.retainedInteriorFractionLower)||a.retainedInteriorFractionLower<limit.minRetainedInteriorFraction)f.push(a.parentKey+':admin.retained-interior');
    if(a.selectedCells>=a.totalCells)f.push(a.parentKey+':admin.whole-membership');
  }
  return [...new Set(f)].sort();
}
const scopeRecord=(s,phase)=>({phase,extent:s.extent,status:s.status,failures:s.failures,
  numericalFailures:scopeNumericalFailures(s),selectedCells:s.selected.length,
  depthKm:[s.depthLowerKm??null,s.depthUpperKm??null],widthKm:[s.widthLowerKm??null,s.widthUpperKm??null],
  areaUpperKm2:s.areaUpperKm2??null,perAdmin:s.perAdmin??[],connected:s.connected??false,
  approximation:s.approximation??null,depthStagesWithinW:s.depthStagesWithinW??[]});

/** Choose only among qualifying current measurements. The ranking does not
 * change any gate: lower maximum budget utilization, then catalog bytes, then
 * exact candidate name. No historical error or particular candidate is required. */
export function chooseEligiblePolicy(candidates){
  return [...candidates].filter(c=>c.eligible).sort((a,b)=>
    a.maxBudgetUtilization-b.maxBudgetUtilization||a.catalogBytes-b.catalogBytes||(a.candidate<b.candidate?-1:a.candidate>b.candidate?1:0))[0]?.candidate??null;
}
export function buildPolicyHandoff({experiments,measurements,costSummary,areas,identityFixture,identitySummary,diagnostics}){
  completeCases(experiments.cases,r=>r.sample.name,r=>r.result.candidate);
  completeCases(measurements.cases,r=>r.sample,r=>r.candidate);
  check(same(costSummary.policyIdentity,policyIdentity),'COST_POLICY_MISMATCH');
  verifyCellIdentity(identityFixture.example,identityFixture.face,identityFixture.provenance);
  check(identitySummary.canonicalizationVersion===CELL_CANONICALIZATION_VERSION&&identitySummary.fixtureId===identityFixture.example.id,'IDENTITY_FIXTURE_MISMATCH');
  const comparisons=summarizeCosts(measurements.cases,areas);
  check(same(comparisons,costSummary.comparison),'COST_EVIDENCE_MISMATCH');
  const witnesses=experiments.cases.map((r,index)=>{
    const {sample,result,measurement:m}=r;
    check(same(m.policyIdentity,policyIdentity)&&same(result.policyIdentity,policyIdentity),'EXPERIMENT_POLICY_MISMATCH');
    const cost=measurements.cases.find(c=>canonicalWitness(c.sample)===canonicalWitness(sample.name)&&c.candidate===result.candidate);
    check(cost.regenerationSha256===hash(jsonBytes(result)),'REGENERATION_EVIDENCE_MISMATCH');
    const generation=validateGenerationEvidence(r);
    check(cost.generationEvidence?.resultSha256===generation.resultSha256&&
      cost.generationEvidence.generationMs===generation.generationMs&&cost.timings.generationMs===generation.generationMs&&
      cost.generationEvidence.regenerationPerformedHere===false,'GENERATION_EVIDENCE_MISMATCH');
    check(cost.encoding.counts.cells===result.cells.length&&cost.upstreamPhysical===m.physical.status&&cost.upstreamEligible===m.candidateEligible,'REPRESENTATIVE_COST_MISMATCH');
    const scopes=[...m.advances.initial.map(s=>scopeRecord(s,'initial')),...m.advances.subsequent.map(s=>scopeRecord(s,'subsequent'))];
    check(same(scopes.map(s=>({extent:s.extent,status:s.status,failures:s.failures})),cost.advanceFailures),'ADVANCE_EVIDENCE_MISMATCH');
    const failures=physicalFailures(r);
    return {name:sample.name,candidate:result.candidate,tags:m.tags,sourceIds:sample.ids,experimentPointer:`cases[${index}]`,
      sourceCorrespondence:result.audit.correspondence,regenerationSha256:cost.regenerationSha256,lattice:result.lattice,projection:sample.projection,
      physical:{status:m.physical.status,failures,groups:[...m.physical.perParent,...m.physical.perCountry],stages:m.physical.stages,
        completeParentCoverage:!sample.fullParents&&m.physical.completeParentCoverage===true},scopes,
      cost:{encoding:cost.encoding,timings:cost.timings,memory:cost.memory,generationEvidence:cost.generationEvidence},
      eligible:!failures.length&&scopes.every(s=>s.status==='eligible'&&!s.failures.length&&!s.numericalFailures.length)};
  });
  const coverage=Object.fromEntries(policy.requiredWitnesses.map(tag=>[tag,[...new Set(witnesses.filter(w=>w.tags.includes(tag)).map(w=>w.name))].sort()]));
  check(Object.values(coverage).every(a=>a.length),'MISSING_REQUIRED_WITNESS_TAG');
  const candidates=comparisons.map(cost=>{
    const cases=witnesses.filter(w=>w.candidate===cost.candidate);
    const physical=cases.filter(w=>w.physical.failures.length).map(w=>({sample:w.name,failures:w.physical.failures}));
    const scope=cases.flatMap(w=>w.scopes.filter(s=>s.status!=='eligible'||s.failures.length||s.numericalFailures.length).map(s=>({sample:w.name,...s})));
    const exceeded=cost.budgetChecks.filter(b=>b.status==='exceeds'),caps=cost.nearCapChecks.filter(b=>b.status==='exceeds');
    const originalRejections=(diagnostics.records??[]).filter(r=>r.candidate===cost.candidate&&r.status==='generation-rejected').map(r=>({sample:r.sample?.name??r.sample,error:r.error}));
    const eligible=!physical.length&&!scope.length&&!exceeded.length&&!caps.length&&!originalRejections.length;
    return {candidate:cost.candidate,eligible,decision:eligible?'eligible-for-review':'rejected',physicalFailures:physical,scopeFailures:scope,
      exceededBudgets:exceeded,capFailures:caps,originalRejections,projections:cost.projections,
      maxMeasuredNearCells:cost.maxMeasuredNearCells,maxBudgetUtilization:Math.max(...cost.budgetChecks.map(b=>b.ratio)),
      catalogBytes:cost.projections.catalogBytes.estimate,
      costOnlyWorldCellCeiling:cost.capCandidate.costOnlyWorldCellCeiling,
      returnTo:{policy:'15-12 frozen criteria '+policyIdentity.sha256,generator:'15-13 complete-parent partition design',
        experiments:['15-14 full geometry and initial/subsequent graph witnesses','15-15 ID/provenance for changed immutable inputs','15-16 measured costs','15-17 selection'],
        action:'Repair reported full-parent/sliver/aspect/depth/retained-interior failures and measured generation cost; regenerate affected evidence. Never substitute bounded charts, widen limits or choose a rejected fallback.'}};
  });
  const selectedPolicy=chooseEligiblePolicy(candidates);
  const exceptions=experiments.cases.flatMap(r=>r.measurement.physical.exceptionCandidates.map(e=>{
    check(hash(jsonBytes(e.geometry))===e.geometrySha256&&e.approved===false,'INVALID_EXCEPTION_EVIDENCE');
    return {sample:r.sample.name,candidate:r.result.candidate,...e};
  }));
  return {version:1,taskId:'15-17',summaryVersion:SUMMARY_VERSION,policyIdentity,
    status:selectedPolicy?'policy-selected-for-review':'blocked-no-eligible-generation-policy',selectedPolicy,
    selectionMethod:'All fixed geometry/scope/identity/budget gates first; lowest maximum budget utilization, catalog bytes, then exact candidate name.',
    criteria:{physical:policy.physical,extent:policy.extent,largeAdministrativeWitness:policy.largeAdministrativeWitness,exceptions:policy.exceptions,budget:policy.budget},
    witnesses,candidates,coverage,fixedSourceWitnesses:SOURCE_WITNESSES,
    exceptionGeometry:{approved:[],inventory:exceptions,policy:'Source geometry inventory only. No threshold waiver, omitted component or whole-country exception.'},
    identity:{canonicalizationVersion:CELL_CANONICALIZATION_VERSION,fixtureId:identityFixture.example.id,generation:identityFixture.provenance.generation,
      source:identityFixture.provenance.source,envelope:identityFixture.provenance.envelope,previousGeometry:identityFixture.provenance.previousGeometry,
      limitation:'An ID fixture does not certify protected old-parent coverage or restored administrative geometry.'},
    cap:{aggregateChangedCells:policy.budget.aggregateChangedCells,generationCeilings:policy.budget,runtimeChangeAuthorized:false,membershipTruncationAllowed:false,wholeSelectionRequired:true},
    failureCheckpoint:{task:'15-13',criteriaTask:'15-12',criteriaIdentity:policyIdentity,
      retainedPolicy:'Keep approved existing catalog and deployment; rejected candidates are never fallback policies.',
      resume:'Repair the responsible prototype/scope/cost checkpoint, regenerate affected 15-14/15-15/15-16 evidence and reselect in 15-17 before independent REVIEW B. No world generation or publication.'},
    methodology:costSummary.methodology,limitations:costSummary.deferredMetrics,
    worldGenerationApproved:false,reviewBApproved:false,productionPublished:false};
}
export function requireSelectedPolicy(handoff,candidate){
  const record=handoff.candidates.find(c=>c.candidate===candidate);
  check(record?.eligible===true&&handoff.selectedPolicy===candidate,'POLICY_SELECTION_REJECTED: '+candidate);
  return record;
}
