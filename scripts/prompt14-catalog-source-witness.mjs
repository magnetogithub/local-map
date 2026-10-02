import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import DistanceOp from 'jsts/org/locationtech/jts/operation/distance/DistanceOp.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import {canonical,polygons} from './prompt14-catalog-core.mjs';

/** Independent point/boundary check on the original locked bytes, before normalization. */
export function verifyLockedSourceWitness(inputs,normalizationEvidence){
  const segment=[[69.905445,34.035848],[69.916021,34.038879]];
  const point=segment[0].map((v,i)=>(v+segment[1][i])/2),reader=new GeoJSONReader();
  const feature=inputs.selected.features.find(f=>f.properties.sourceCountryId==='AFG'&&polygons(f.geometry).some(p=>p.some(r=>r.slice(1).some((b,i)=>canonical([r[i],b])===canonical(segment)||canonical([b,r[i]])===canonical(segment)))));
  if(!feature)throw new Error('Pinned source witness not found in the original selected input');
  const p0=reader.read(inputs.p0.features.find(f=>f.properties.countryId==='AFG').geometry);
  const distance=DistanceOp.distance(reader.read({type:'Point',coordinates:point}),p0.getBoundary());
  const location=new PointLocator().locate(new Coordinate(...point),p0);
  return {sourceCountryId:'AFG',sourceFeatureId:feature.properties.sourceFeatureId,inputRole:feature.properties.inputRole,
    segment,midpoint:point,presentInOriginalLockedInput:true,distanceToLockedP0BoundaryDegrees:distance,
    pointLocation:location===0?'interior':location===1?'boundary':'exterior',numericalBoundaryContactToleranceDegrees:1e-12,
    exceedsNumericalContactTolerance:distance>1e-12,areaCoverageGate:normalizationEvidence.coverage.find(c=>c.countryId==='AFG'),
    interpretation:'Area totals within the approved tolerance do not certify a shared boundary. This witness exists before 14-6 normalization; coordinate preservation cannot make it an exact P0 edge.'};
}
