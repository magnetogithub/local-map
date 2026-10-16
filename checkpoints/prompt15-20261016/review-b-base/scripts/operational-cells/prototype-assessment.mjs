import {geometryMetrics} from './metric-chart.mjs';
import {policy} from './policy-validation.mjs';
export function assessPhysical(result,projection) {
  const metrics=result.cells.map(c=>({ordinal:c.ordinal,...geometryMetrics(c.geometry,projection)}));
  const area=metrics.reduce((n,c)=>n+c.areaLowerKm2,0),small=metrics.filter(c=>c.areaLowerKm2<policy.physical.sliverAreaBelowKm2);
  const measured={cells:metrics.length,maxDiameterKm:Math.max(...metrics.map(c=>c.diameterUpperKm)),maxAreaKm2:Math.max(...metrics.map(c=>c.areaUpperKm2)),
    maxAspectRatio:Math.max(...metrics.map(c=>c.aspectUpper)),sliverCountFraction:small.length/metrics.length,
    sliverAreaFraction:small.reduce((n,c)=>n+c.areaUpperKm2,0)/area};
  const failures=[];
  if(!metrics.length) failures.push('empty.cells');
  if(measured.maxDiameterKm>policy.physical.border.maxDiameterKm) failures.push('diameter');
  if(measured.maxAreaKm2>policy.physical.border.maxAreaKm2) failures.push('area');
  if(measured.maxAspectRatio>policy.physical.maxAspectRatio) failures.push('aspect');
  if(measured.sliverCountFraction>policy.physical.maxSliverCountFraction) failures.push('sliver.count');
  if(measured.sliverAreaFraction>policy.physical.maxSliverAreaFraction) failures.push('sliver.area');
  if(projection.relativeErrorBound>policy.physical.maxMetricRelativeError) failures.push('metric.error');
  return {status:failures.length?'rejected':'eligible',failures,measured,
    scope:'geometry only; stage counts, full scope experiments, world cost and policy selection remain dependent tasks'};
}
