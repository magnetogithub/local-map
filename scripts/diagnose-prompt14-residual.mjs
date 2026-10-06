import fs from 'node:fs';
import {polygons} from './prompt14-catalog-core.mjs';
const raw=JSON.parse(fs.readFileSync('data/derived/prompt14/shared-admin1-input.geojson','utf8'));
const failure=JSON.parse(fs.readFileSync(`.tmp/prompt14-review-c/arrangement-${process.argv[2]??'GBR'}-failure.json`,'utf8')),face=failure.unresolved[Number(process.argv[3]??0)];
const features=face.contacts.map(id=>raw.features.find(f=>String(f.properties.ne_id??f.properties.NE_ID)===id));
const pts=polygons(face.geometry).flat(2),box=[Math.min(...pts.map(p=>p[0])),Math.min(...pts.map(p=>p[1])),Math.max(...pts.map(p=>p[0])),Math.max(...pts.map(p=>p[1]))],key=(a,b)=>JSON.stringify([a,b].sort((a,b)=>a[0]-b[0]||a[1]-b[1]));
const sets=features.map(f=>{const map=new Map();for(const p of polygons(f.geometry))for(const r of p)for(let i=1;i<r.length;i++)map.set(key(r[i-1],r[i]),[r[i-1],r[i]]);return map;});
const local=e=>e.some(p=>p[0]>=box[0]-.002&&p[0]<=box[2]+.002&&p[1]>=box[1]-.002&&p[1]<=box[3]+.002);
console.log(JSON.stringify({face,features:features.map(f=>({id:f.properties.ne_id??f.properties.NE_ID,name:f.properties.name})),shared:[...sets[0]].filter(([k,e])=>sets[1].has(k)&&local(e)).map(([,e])=>e),local:sets.map(s=>[...s.values()].filter(local))}));
