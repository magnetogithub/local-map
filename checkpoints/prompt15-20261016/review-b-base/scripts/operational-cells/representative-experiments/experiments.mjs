import {createHash} from 'node:crypto';
import {CANDIDATES,polygons,generatePartition} from '../partition-prototype.mjs';
import {SOURCE_WITNESSES} from '../source-samples.mjs';
import {FULL_SOURCE_WITNESSES,loadFullSourceSamples} from '../full-source-samples.mjs';
import {policy,policyIdentity} from '../policy-validation.mjs';
import {geometryMetrics} from './metric.mjs';
import {compareAdvances} from './graph.mjs';
export const REPRESENTATIVES=FULL_SOURCE_WITNESSES;
export const loadRepresentatives=loadFullSourceSamples;
export {SOURCE_WITNESSES,CANDIDATES};

export function measurePhysical(result,projection,advances){
  const edgeBoundary=new Set(result.edges.filter(e=>e.sides.length===1||e.boundary?.country||e.boundary?.administrative).flatMap(e=>e.sides.map(s=>s.ordinal)));
  const cellMetrics=result.cells.map(c=>({ordinal:c.ordinal,parentKey:c.parentKey,sourceCountryId:c.sourceCountryId,zone:edgeBoundary.has(c.ordinal)?'border':'interior',...geometryMetrics(c.geometry,projection)}));
  const summarize=(cells,label)=>{
    const failures=[],zones={};
    for(const zone of ['border','interior']){const a=cells.filter(c=>c.zone===zone);zones[zone]=a.length?{cells:a.length,maxDiameterKm:Math.max(...a.map(c=>c.diameterUpperKm)),maxAreaKm2:Math.max(...a.map(c=>c.areaUpperKm2)),maxAspectRatio:Math.max(...a.map(c=>c.aspectUpper))}:null;
      if(!a.length)failures.push(`${zone}.no-cell-witness`);else {if(zones[zone].maxDiameterKm>policy.physical[zone].maxDiameterKm)failures.push(`${zone}.diameter`);if(zones[zone].maxDiameterKm/policy.physical.representativeAdvanceWKm>policy.physical.maxDiameterToWRatio)failures.push(`${zone}.diameter/W`);if(zones[zone].maxAreaKm2>policy.physical[zone].maxAreaKm2)failures.push(`${zone}.area`);if(zones[zone].maxAspectRatio>policy.physical.maxAspectRatio)failures.push(`${zone}.aspect`);}}
    const small=cells.filter(c=>c.areaLowerKm2<policy.physical.sliverAreaBelowKm2),total=cells.reduce((s,c)=>s+c.areaLowerKm2,0),slivers={ordinals:small.map(c=>c.ordinal),countFraction:small.length/cells.length,areaFractionUpper:small.reduce((s,c)=>s+c.areaUpperKm2,0)/total};
    if(slivers.countFraction>policy.physical.maxSliverCountFraction)failures.push('sliver.count');if(slivers.areaFractionUpper>policy.physical.maxSliverAreaFraction)failures.push('sliver.area');
    if(projection.relativeErrorBound>policy.physical.maxMetricRelativeError)failures.push('metric.error');
    return {label,zones,slivers,status:failures.length?'rejected':'eligible',failures};
  };
  const perParent=result.parents.map(p=>summarize(cellMetrics.filter(c=>c.parentKey===p.key),p.key));
  const perCountry=[...new Set(result.cells.map(c=>c.sourceCountryId))].sort().map(c=>summarize(cellMetrics.filter(x=>x.sourceCountryId===c),c));
  const stages={border:advances.initial[0].depthStagesWithinW?.length??0,interior:advances.subsequent[0].depthStagesWithinW?.length??0};
  const stageFailures=Object.entries(stages).filter(([,v])=>v<policy.physical.minDistinctDepthStages).map(([k])=>`${k}.depth-stages`);
  const exceptionCandidates=result.parents.flatMap(p=>polygons(p.geometry).flatMap((component,index)=>{
    const geometry={type:'Polygon',coordinates:component},metrics=geometryMetrics(geometry,projection);
    return metrics.areaUpperKm2<=policy.exceptions.maxSourceComponentAreaKm2&&metrics.diameterUpperKm<=policy.exceptions.maxSourceComponentDiameterKm?[{parentKey:p.key,component:index,geometry,geometrySha256:createHash('sha256').update(JSON.stringify(geometry)).digest('hex'),metrics,approved:false,reason:policy.exceptions.eligibleReason}]:[];
  }));
  return {cellMetrics,perParent,perCountry,stages,stageFailures,exceptionCandidates,
    status:[...perParent,...perCountry].some(g=>g.failures.length)||stageFailures.length?'rejected':'eligible',
    exceptionPolicy:'inventory only; approvedGeometryPins remains empty; no geometry dropped or merged'};
}

export function measureExperiment(sample,result){
  const advances=compareAdvances(result,sample.parents,sample.projection,sample.actor),physical=measurePhysical(result,sample.projection,advances);
  if(sample.fullParents)throw new Error('BOUNDED_PARENT_REPLACEMENT_FORBIDDEN');
  physical.completeParentCoverage=true;
  return {name:sample.name,candidate:result.candidate,tags:sample.tags??(sample.name.startsWith('SVN')?['SVN']:['island-hole']),
    policyIdentity,projection:sample.projection,cells:result.cells.length,positiveEdges:result.edges.length,correspondence:result.audit.correspondence,
    physical,advances,candidateEligible:physical.status==='eligible'&&[...advances.initial,...advances.subsequent].every(s=>s.status==='eligible'),
    approval:'none; representative offline evidence only; failures return to policy/candidate checkpoint, not tolerance adjustment'};
}

export function generateSample(sample,candidate){return generatePartition(sample.parents,{candidate});}
