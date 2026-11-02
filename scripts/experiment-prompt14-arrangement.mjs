import fs from 'node:fs';
import {arrangeSourcePartitions} from './prompt14-boundary-arrangement.mjs';
const history='data/derived/prompt14/history/review-c-v1',read=p=>JSON.parse(fs.readFileSync(`${history}/${p}`,'utf8'));
let p0=read('data/derived/prompt14/shared-game-p0.geojson'),selected=read('data/derived/prompt14/selected-game-input.geojson');
const raw=read('data/derived/prompt14/shared-admin1-input.geojson'),country=process.argv[2];
if(country){p0={...p0,features:p0.features.filter(f=>f.properties.countryId===country)};selected={...selected,features:selected.features.filter(f=>f.properties.countryId===country)};}
try{const result=arrangeSourcePartitions(p0,selected,raw,console.log);fs.writeFileSync(`.tmp/prompt14-review-c/arrangement-${country??'world'}.json`,JSON.stringify(result));console.log(JSON.stringify({pass:true,countries:result.p0.features.length,features:result.selected.features.length,changes:result.evidence.changes.length}));}
catch(error){fs.writeFileSync(`.tmp/prompt14-review-c/arrangement-${country??'world'}-failure.json`,JSON.stringify(error.evidence??{message:error.message}));console.error(error.stack);process.exitCode=1;}
