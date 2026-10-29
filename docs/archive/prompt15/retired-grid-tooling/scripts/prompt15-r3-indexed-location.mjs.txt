import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import IndexedPointInAreaLocator from 'jsts/org/locationtech/jts/algorithm/locate/IndexedPointInAreaLocator.js';
// Both implementations use JSTS RayCrossingCounter. Replace only the polygon
// scan, keeping PointLocator's collection/boundary-rule semantics. The override
// is scoped to a synchronous offline operation and always restored.
export function withIndexedPolygonLocation(operation){
 const original=PointLocator.prototype.locateInPolygon,cache=new WeakMap();
 PointLocator.prototype.locateInPolygon=function(point,polygon){
  if(polygon.isEmpty()||!polygon.getEnvelopeInternal().intersects(point))return 2;
  let entry=cache.get(polygon);if(!entry){entry={large:polygon.getNumPoints()>256,locator:null};cache.set(polygon,entry);}
  if(!entry.large)return original.call(this,point,polygon);
  entry.locator??=new IndexedPointInAreaLocator(polygon);return entry.locator.locate(point);
 };
 try{return operation();}finally{PointLocator.prototype.locateInPolygon=original;}
}
