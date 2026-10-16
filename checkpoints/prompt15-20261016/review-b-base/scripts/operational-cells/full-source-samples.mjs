import fs from 'node:fs';
import path from 'node:path';
import clipping from 'polygon-clipping';
import {RAW_PATH,LOCK_PATH,pinFile} from './source-samples.mjs';
import {projectFeatures,unwrap} from './metric-chart.mjs';
import {polygons,area} from './partition-prototype.mjs';

// Complete fixed source identities, never a window selected after a failure.
export const FULL_SOURCE_WITNESSES=Object.freeze([
  {name:'KOR-PRK-Kangwon',ids:['1159312111','1159315279'],actor:'KOR',tags:['KOR-PRK']},
  {name:'KOR-PRK-Hwanghae',ids:['1159312027','1159315273'],actor:'KOR',tags:['KOR-PRK']},
  {name:'ECU-PER-Loja-Piura',ids:['1159309975','1159307897'],actor:'PER',tags:['other-continent-land-neighbours']},
  {name:'MNG-Sukhbaatar',ids:['1159315437'],tags:['large-inland-country']},
  {name:'NOR-Troms',ids:['1159309663'],tags:['high-latitude']},
  {name:'FJI-Northern-antimeridian',ids:['1159313293'],tags:['antimeridian','island-hole']},
  {name:'LUX-Grevenmacher',ids:['1159310953'],tags:['small-country']},
]);
export function loadFullSourceSamples(root) {
  const source=path.join(root,RAW_PATH),lockFile=path.join(root,LOCK_PATH),rawPin=pinFile(source),lock=JSON.parse(fs.readFileSync(lockFile,'utf8'));
  const expected=lock.lineageInputs.find(p=>p.repositoryPath===RAW_PATH);
  if(!expected||rawPin.sha256!==expected.sha256||rawPin.byteLength!==expected.byteLength) throw new Error('SOURCE_PIN_MISMATCH');
  const raw=JSON.parse(fs.readFileSync(source,'utf8'));
  return {inputs:[rawPin,pinFile(lockFile)],samples:FULL_SOURCE_WITNESSES.map(w=>{
    const original=w.ids.map(id=>{
      const matches=raw.features.filter(f=>String(f.properties.ne_id)===id);
      if(matches.length!==1) throw new Error('SOURCE_IDENTITY_MISSING_OR_DUPLICATED');
      return structuredClone(matches[0]);
    });
    const rawProjected=projectFeatures(original);
    // Reconnect the exact vertical file seam in unwrapped source coordinates
    // BEFORE nonlinear projection. Joining almost-collinear projected chords
    // would manufacture floating micro-holes along that artificial seam.
    const joinedSources=original.map(f=>{
      const sourcePolygons=polygons(f.geometry),centre=sourcePolygons[0][0][0][0];
      if(!sourcePolygons.flat(2).some(p=>Math.abs(p[0])===180)) return f;
      const unwrapped=sourcePolygons.map(p=>p.map(r=>r.map(([x,y])=>[unwrap(x,centre),y])));
      return {...f,geometry:{type:'MultiPolygon',coordinates:clipping.union(...unwrapped.map(p=>[p]))}};
    });
    const projected=projectFeatures(joinedSources),correspondence=[];
    const parents=projected.features.map((f,i)=>{
      const fragments=polygons(rawProjected.features[i].geometry),isDateline=polygons(original[i].geometry).flat(2).some(p=>Math.abs(p[0])===180);
      // The raw file cuts an island at +/-180. Reconnect ONLY these same-ID
      // fragments; every fragment retains positive coverage and its raw index.
      const joined=polygons(f.geometry);
      correspondence.push({sourceFeatureId:String(f.properties.ne_id),rawComponentCount:fragments.length,
        protectedComponentCount:joined.length,datelineFileSeamReconnected:isDateline,
        fragments:fragments.map((p,index)=>({index,areaM2:area([p]),geometry:{type:'Polygon',coordinates:p}}))});
      return {key:`${f.properties.adm0_a3}:${f.properties.ne_id}`,sourceCountryId:f.properties.adm0_a3,
        administrativeParent:{kind:'administrative-region',identity:{sourceCountryId:f.properties.adm0_a3,sourceVersion:lock.sourceVersion,level:1,sourceFeatureId:String(f.properties.ne_id)}},
        previousGeometryParent:{kind:'source-sample-only',migrationEvidence:false},geometry:{type:'MultiPolygon',coordinates:joined}};
    });
    return {...w,original,parents,projection:projected.projection,correspondence,rawSource:rawPin,
      scope:'complete source geometry; no bounding-window clip, omitted remainder, or production restoration claim'};
  })};
}
