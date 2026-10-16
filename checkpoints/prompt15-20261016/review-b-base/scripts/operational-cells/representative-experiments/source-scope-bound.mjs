import {polygons} from '../partition-prototype.mjs';
import {geometryMetrics} from '../metric-chart.mjs';
import {scopeDepthFeasibility} from '../scope-feasibility.mjs';
import {policy} from '../policy-validation.mjs';

/** Necessary bounds only. A large bound is NOT a successful selection.
 * The existing estimator uses point/segment lower bounds; those cannot exceed
 * the complete source diameter. For a single simple hole-free source polygon
 * we additionally bound even the intrinsic land path: each point can reach a
 * visible source vertex by an internal segment <= diameter; two such vertices
 * connect by the shorter source-boundary arc <= perimeter/2. Thus ANY pair
 * has a land path <= 2*diameter + perimeter/2. This is conservative for nonconvex
 * polygons too and does not confuse Euclidean and land-connected distance.
 * Multipart/hole sources receive no such intrinsic certificate here.
 */
export function assessCompleteSourceScope(parents,projection,extent){
  if(!Object.hasOwn(policy.extent,extent))throw new Error('INVALID_EXTENT');
  const estimator=scopeDepthFeasibility(parents,projection,extent);
  const scaleMin=projection.scaleMin??1-projection.relativeErrorBound;
  const scaleMax=projection.scaleMax??1+projection.relativeErrorBound;
  const metric={...projection,scaleMin,scaleMax};
  const geometry={type:'MultiPolygon',coordinates:parents.flatMap(p=>polygons(p.geometry))};
  const measured=geometryMetrics(geometry,metric),simple=geometry.coordinates.length===1&&geometry.coordinates[0].length===1;
  let landPathUpperKm=null,perimeterUpperKm=null;
  if(simple){
    const ring=geometry.coordinates[0][0];
    perimeterUpperKm=ring.slice(1).reduce((s,b,i)=>s+Math.hypot(b[0]-ring[i][0],b[1]-ring[i][1]),0)/scaleMin/1000;
    // Fixed floating arithmetic upper inflation, never a scoring tolerance.
    landPathUpperKm=(2*measured.diameterUpperKm+perimeterUpperKm/2)*(1+64*Number.EPSILON);
  }
  const intrinsicInfeasible=landPathUpperKm!==null&&landPathUpperKm<policy.extent[extent].minDepthKm;
  return {version:1,extent,status:intrinsicInfeasible?'infeasible':'not-proven',minimumDepthKm:policy.extent[extent].minDepthKm,
    estimator,sourceMetrics:measured,perimeterUpperKm,landPathUpperKm,
    certificate:simple?'single-simple-hole-free-polygon: 2*diameter+perimeter/2':'intrinsic land-path certificate not supplied for multipart/hole geometry',
    failures:intrinsicInfeasible?['MINIMUM_DEPTH_EXCEEDS_COMPLETE_SOURCE_LAND_PATH_UPPER_BOUND']:[],
    scope:'Necessary complete-source feasibility only; no scope IDs, exception, policy selection or REVIEW approval.'};
}
