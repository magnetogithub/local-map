import fs from 'node:fs';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import {canonical,digest,jsonBytes,polygons,writeArtifact} from './prompt14-catalog-core.mjs';
import {HISTORY} from './regenerate-prompt14-sources.mjs';
const directory=process.argv[2];
const beforeBytes=fs.readFileSync(`${HISTORY}/data/derived/prompt14/selected-game-input.geojson`),afterBytes=fs.readFileSync(`${directory}/selected-game-input.geojson`);
const before=JSON.parse(beforeBytes),after=JSON.parse(afterBytes),reader=new GeoJSONReader();
const bounds=p=>{const points=p.flat();return [Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];};
const overlap=(p,q)=>{const a=bounds(p),b=bounds(q);if(a[2]<=b[0]||b[2]<=a[0]||a[3]<=b[1]||b[3]<=a[1])return false;
  try{const result=polygonClipping.intersection([p],[q]);return result.length>0&&reader.read({type:'MultiPolygon',coordinates:result}).getArea()>0;}
  catch{return OverlayOp.intersection(reader.read({type:'Polygon',coordinates:p}),reader.read({type:'Polygon',coordinates:q})).getArea()>0;}
};
const match=(old,current)=>{const pairs=old.map((p,i)=>({beforeComponent:i,afterComponents:current.flatMap((q,j)=>overlap(p,q)?[j]:[])}));
  if(pairs.some(p=>p.afterComponents.length!==1)||new Set(pairs.flatMap(p=>p.afterComponents)).size!==current.length||pairs.length!==current.length)throw new Error('No bijective positive-area source component/hole correspondence');return pairs;
};
try{
  if(before.features.length!==after.features.length)throw new Error('Source feature identity count changed');
  const features=before.features.map((f,i)=>{
    const target=after.features[i];if(canonical(f.properties)!==canonical(target.properties))throw new Error('Source feature properties changed');
    const old=polygons(f.geometry),current=polygons(target.geometry),components=match(old,current),holes=[];
    for(const pair of components){const j=pair.afterComponents[0],connections=match(old[pair.beforeComponent].slice(1).map(r=>[r]),current[j].slice(1).map(r=>[r]));
      for(const h of connections)holes.push({beforeComponent:pair.beforeComponent,beforeHole:h.beforeComponent+1,afterComponent:j,afterHole:h.afterComponents[0]+1});}
    return {sourceCountryId:f.properties.countryId,sourceFeatureId:f.properties.sourceFeatureId,components,holes};
  });
  writeArtifact(directory,'component-hole-correspondence.json',jsonBytes({status:'pass',beforeSha256:digest(beforeBytes),afterSha256:digest(afterBytes),method:'Every original and final positive component has exactly one positive-area intersection partner. Hole bijections are checked within that partner, preserving the hole-to-component relationship.',
    features,componentCount:features.reduce((n,f)=>n+f.components.length,0),holeCount:features.reduce((n,f)=>n+f.holes.length,0)}));
  console.log(JSON.stringify({status:'pass',features:features.length}));
}catch(error){writeArtifact(directory,'correspondence-failure.json',jsonBytes({status:'fail',message:error.message}));console.error(error.stack);process.exitCode=1;}
