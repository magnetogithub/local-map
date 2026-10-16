import {polygons} from './partition-prototype.mjs';
import {geometryMetrics} from './metric-chart.mjs';
import {policy} from './policy-validation.mjs';

/** Necessary physical bound, not a selection or policy approval. Every cell
 * and every point of an internal controller frontier is inside the complete
 * source geometry. Its point-to-frontier depth cannot exceed the diameter of
 * that geometry. More subdivisions cannot increase this physical bound.
 * A sufficiently large diameter only means this test cannot reject the scope;
 * actual connected IDs, width, area, inland retention and caps remain required.
 * No source/witness is enlarged, discarded, exempted or moved. */
export function scopeDepthFeasibility(parents,projection,extent) {
  const limit=policy.extent[extent];
  if(!limit)throw new Error('INVALID_EXTENT');
  if(!parents.length)throw new Error('MISSING_SOURCE_GEOMETRY');
  const scaleMin=projection.scaleMin??1-projection.relativeErrorBound;
  const scaleMax=projection.scaleMax??1+projection.relativeErrorBound;
  if(!(scaleMin>0)||!(scaleMax>=scaleMin)||!Number.isFinite(scaleMax))throw new Error('INVALID_METRIC_BOUNDS');
  const geometry={type:'MultiPolygon',coordinates:parents.flatMap(p=>polygons(p.geometry))};
  const metrics=geometryMetrics(geometry,{...projection,scaleMin,scaleMax});
  const possible=metrics.diameterUpperKm>=limit.minDepthKm;
  return {version:1,extent,status:possible?'not-proven':'infeasible',
    minimumDepthKm:limit.minDepthKm,sourceDiameterUpperKm:metrics.diameterUpperKm,
    failures:possible?[]:['MINIMUM_DEPTH_EXCEEDS_COMPLETE_SOURCE_DIAMETER'],
    sourceIdentities:parents.map(p=>p.administrativeParent.identity),
    scope:'necessary geometry bound only; not a successful scope selection or REVIEW approval'};
}
