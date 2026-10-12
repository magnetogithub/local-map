import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import {normalizeGeometry,hashCanonical,polygons} from './prompt14-catalog-core.mjs';
import {physicalMetrics} from './prompt15-cell-core.mjs';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
const reader=new GeoJSONReader(),writer=new GeoJSONWriter();
// Retain a positive clipped face that would collapse under the existing numeric
// noder by joining it across a REAL positive-length shared edge to a cell of the
// SAME immutable administrative/protected partition and original component.
// No source/admin ownership is inferred or moved, and no area is discarded.
export function mergeCollapsedCells(features,badIds){
 const index=new STRtree(),geometries=new Map(),removed=new Set(),replacements=new Map(),evidence=[];
 features.forEach(f=>{const g=reader.read(f.geometry);geometries.set(f,g);index.insert(g.getEnvelopeInternal(),f);});
 for(const id of badIds){const bad=features.find(f=>f.properties.sourceFeatureId===id);if(!bad||removed.has(bad))continue;const g=geometries.get(bad),candidates=[];
  for(const it=index.query(g.getEnvelopeInternal()).iterator();it.hasNext();){const neighbor=it.next();if(neighbor===bad||removed.has(neighbor)||badIds.has(neighbor.properties.sourceFeatureId)||neighbor.properties.countryId!==bad.properties.countryId||neighbor.properties.parentSourceFeatureId!==bad.properties.parentSourceFeatureId||neighbor.properties.parentHash!==bad.properties.parentHash||neighbor.properties.componentIndex!==bad.properties.componentIndex)continue;
   const boundary=OverlayOp.intersection(g.getBoundary(),geometries.get(neighbor).getBoundary()),sharedLengthDegrees=boundary.getLength();if(!(sharedLengthDegrees>0))continue;
   const union=normalizeGeometry(writer.write(UnaryUnionOp.union(reader.read({type:'GeometryCollection',geometries:[bad.geometry,neighbor.geometry]}))));if(polygons(union).length!==1)continue;const m=physicalMetrics(union),refined=bad.properties.refined||neighbor.properties.refined;
   if(m.diameterUpperBoundKm>(refined?P.boundaryMaximumDiameterKm:P.interiorMaximumDiameterKm)||m.areaKm2>(refined?P.boundaryMaximumAreaKm2:P.interiorMaximumAreaKm2))continue;candidates.push({neighbor,union,m,refined,sharedLengthDegrees});
  }
  candidates.sort((a,b)=>b.sharedLengthDegrees-a.sharedLengthDegrees);if(!candidates.length||(candidates[1]&&candidates[0].sharedLengthDegrees===candidates[1].sharedLengthDegrees))throw Error('Collapsed positive operational face has no unique safe same-partition shared-edge merge');
  const chosen=candidates[0],merged={...chosen.neighbor,properties:{...chosen.neighbor.properties,refined:chosen.refined},geometry:chosen.union};merged.properties.sourceFeatureId=hashCanonical('prompt15-operational-cell.v1',{policy:P.version,candidate:'adaptive-12-24',parentKey:merged.properties.parentKey,parentHash:merged.properties.parentHash,geometry:merged.geometry});
  removed.add(bad);removed.add(chosen.neighbor);replacements.set(chosen.neighbor,merged);evidence.push({collapsedCellHash:id,neighborCellHash:chosen.neighbor.properties.sourceFeatureId,mergedCellHash:merged.properties.sourceFeatureId,parentSourceFeatureId:bad.properties.parentSourceFeatureId,componentIndex:bad.properties.componentIndex,sharedLengthDegrees:chosen.sharedLengthDegrees,candidateSharedLengths:candidates.map(c=>c.sharedLengthDegrees),rawPositiveArea:g.getArea(),mergedArea:reader.read(chosen.union).getArea(),reason:'Prevent positive clipped-face loss under fixed 1e-12 numerical representation; exact set union within the same administrative identity, old protected parent and component, preserving the original physical bounds'});
 }
 return {features:features.flatMap(f=>replacements.has(f)?[replacements.get(f)]:removed.has(f)?[]:[f]),evidence};
}
