import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {polygons} from './partition-prototype.mjs';

export const RAW_PATH = 'data/raw/ne_10m_admin_1_states_provinces.geojson';
export const LOCK_PATH = 'data/source-locks/prompt14-derived-game-input-lock.json';
export const SOURCE_WITNESSES = Object.freeze([
  {name:'SVN-Piran',ids:['1159310877']},
  {name:'SVN-Piran-Izola-common-boundary',ids:['1159310877','1159310863']},
  {name:'KOR-Incheon-components',ids:['1159312029']},
  {name:'ESB-Dhekelia-hole',ids:['1159315583']},
  {name:'MWI-Likoma-islands',ids:['1159317167']},
]);
export const pinFile = file => {
  const bytes = fs.readFileSync(file);
  return {path:path.resolve(file),sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length};
};
// WGS84 local affine chart. Unlike interpreting degrees as km, x/y use the
// ellipsoidal parallel/meridional radii in metres. The endpoint scale bounds
// bound every intervening source segment (plus latitude zero if in range).
// No simplification, rounding, polygon cutting, or source identity assignment.
export function projectSourceSample(features) {
  const points = features.flatMap(f => polygons(f.geometry).flat(2));
  if (!points.length || points.some(p=>p.some(n=>!Number.isFinite(n)))) throw new Error('INVALID_SOURCE');
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  const xmin=Math.min(...xs),xmax=Math.max(...xs),ymin=Math.min(...ys),ymax=Math.max(...ys);
  if (xmax-xmin>5 || ymax-ymin>5 || ymin<=-89 || ymax>=89) throw new Error('LOCAL_CHART_LIMIT: use a separately validated chart for broad/polar/dateline samples');
  const lon0=(xmin+xmax)/2,lat0=(ymin+ymax)/2,rad=Math.PI/180,a=6378137,e2=6.6943799901413165e-3;
  const radii = lat => {
    const phi=lat*rad,d=1-e2*Math.sin(phi)**2;
    return {x:a/Math.sqrt(d)*Math.cos(phi),y:a*(1-e2)/d**1.5};
  };
  const centre=radii(lat0),samples=[ymin,ymax,...(ymin<=0&&ymax>=0?[0]:[])].map(radii);
  const relativeErrorBound=Math.max(...samples.flatMap(r=>[Math.abs(centre.x/r.x-1),Math.abs(centre.y/r.y-1)]));
  const transform = geometry => ({type:geometry.type,coordinates:geometry.type==='Polygon' ?
    geometry.coordinates.map(r=>r.map(([x,y])=>[(x-lon0)*rad*centre.x,(y-lat0)*rad*centre.y])) :
    geometry.coordinates.map(p=>p.map(r=>r.map(([x,y])=>[(x-lon0)*rad*centre.x,(y-lat0)*rad*centre.y])))});
  return {projection:{id:'WGS84-local-affine-ellipsoidal-v1',unit:'metre',lon0,lat0,
    semimajorAxisMetres:a,eccentricitySquared:e2,relativeErrorBound,
    scope:'small source prototype; broad/polar/dateline charts are not certified by this experiment'},
  features:features.map(f=>({...structuredClone(f),geometry:transform(f.geometry)}))};
}

export function loadSourceSamples(candidateRoot) {
  const root=path.resolve(candidateRoot),lockFile=path.join(root,LOCK_PATH),rawFile=path.join(root,RAW_PATH);
  const lock=JSON.parse(fs.readFileSync(lockFile,'utf8')),rawPin=pinFile(rawFile);
  const expected=lock.lineageInputs.find(p=>p.repositoryPath===RAW_PATH);
  if (!expected || expected.sha256!==rawPin.sha256 || expected.byteLength!==rawPin.byteLength) throw new Error('SOURCE_PIN_MISMATCH');
  const raw=JSON.parse(fs.readFileSync(rawFile,'utf8'));
  return {sourceInputs:[pinFile(lockFile),rawPin],samples:SOURCE_WITNESSES.map(w=>{
    const original=w.ids.map(id=>{
      const found=raw.features.filter(f=>String(f.properties.ne_id)===id);
      if(found.length!==1) throw new Error('SOURCE_IDENTITY_MISSING_OR_DUPLICATED');
      return structuredClone(found[0]);
    });
    const projected=projectSourceSample(original);
    return {name:w.name,rawSource:rawPin,original,projection:projected.projection,
      parents:projected.features.map(f=>({key:`${f.properties.adm0_a3}:${f.properties.ne_id}`,
        sourceCountryId:f.properties.adm0_a3,
        administrativeParent:{kind:'administrative-region',identity:{sourceCountryId:f.properties.adm0_a3,
          sourceVersion:lock.sourceVersion,level:1,sourceFeatureId:String(f.properties.ne_id)}},
        // Explicit absence, never counterfeit old catalog IDs. Callers with an
        // approved protected-refinement input retain its real previous parent.
        previousGeometryParent:{kind:'source-sample-only',migrationEvidence:false},geometry:f.geometry}))};
  })};
}
