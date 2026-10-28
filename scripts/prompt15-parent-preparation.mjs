import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {normalizeGeometry,polygons,digest,jsonBytes} from './prompt14-catalog-core.mjs';
import {overlay} from './prompt15-world-preflight.mjs';
import {certifyPreparedIntersection} from './prompt15-exact-support.mjs';

// Both admission adapters call this same one-parent path. A lossy native
// overlay is quarantined before gridding; rational evidence is not a cell or
// a license to silently replace the approved input by the computed result.
export function prepareAdministrativeParent(source,country,identity={}){
 const reader=new GeoJSONReader();
 for(const [name,g] of [['approved-source',source],['fixed-country',country]]){
  const normalized=normalizeGeometry(g);if(!new IsValidOp(reader.read(normalized)).isValid())throw Error(`Invalid parent preparation ${name}`);
 }
 const result=overlay('intersection',source,country),certificate=certifyPreparedIntersection(source,country,result.geometry),hash=g=>digest(jsonBytes(g));
 if(!certificate.pass)throw Object.assign(Error('Prepared parent has positive support loss or unsupported output; no lossy geometry admitted'),{code:'PREPARED_PARENT_SUPPORT_MISMATCH',evidence:{identity,sourceGeometryHash:hash(source),countryGeometryHash:hash(country),intersectionGeometryHash:hash(result.geometry),intersectionAlgorithm:result.algorithm,stage:'intersection-before-normalization',certificate,approvedInputDefectClaim:false,admitted:false}});
 if(!polygons(result.geometry).length)return null;
 return normalizeGeometry(result.geometry);
}
