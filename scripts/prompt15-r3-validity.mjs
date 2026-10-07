import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import {polygons,signedArea} from './prompt14-catalog-core.mjs';
const reader=new GeoJSONReader();
export function validatePositiveGeometry(geometries){
 const errors=[];let positiveMicroscopicRings=0;
 for(const [i,g]of geometries.entries()){
  for(const p of polygons(g))for(const [j,ring]of p.entries()){
   if(ring.length<4||ring.some(v=>v.length!==2||!v.every(Number.isFinite)||Math.abs(v[0])>180||Math.abs(v[1])>90)||ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])errors.push({i,kind:'invalid-ring-coordinates'});
   const a=signedArea(ring);if(!(j===0?a>0:a<0))errors.push({i,kind:'zero-area-or-wrong-winding'});
   if(Math.abs(a)>0&&Math.abs(a)<=Number.EPSILON)positiveMicroscopicRings++;
  }
  const op=new IsValidOp(reader.read(g));if(!op.isValid())errors.push({i,kind:'jsts-invalid',reason:String(op.getValidationError())});
 }
 return {pass:!errors.length,errors,positiveMicroscopicRings,policy:'Strict positive translated-origin shoelace and independent JSTS IsValidOp. No positive face deletion. Coverage/displacement tolerances unchanged; Number.EPSILON is not a minimum permitted geographic area.'};
}
