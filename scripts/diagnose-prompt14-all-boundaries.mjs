import fs from 'node:fs';
import {generateAtoms,jsonBytes} from './prompt14-catalog-core.mjs';
import {diagnoseAllBoundaries} from './prompt14-boundary-diagnostics.mjs';
const history='data/derived/prompt14/history/review-c-v1',read=p=>JSON.parse(fs.readFileSync(`${history}/${p}`,'utf8'));
const atoms=generateAtoms({selected:read('data/derived/prompt14/selected-game-input.geojson'),lock:read('data/source-locks/prompt14-derived-game-input-lock.json')});
const result=diagnoseAllBoundaries(atoms,read('data/derived/prompt14/shared-game-p0.geojson'),console.log);
fs.writeFileSync('reports/prompt14/14-02-full-boundary-diagnosis.json',jsonBytes(result));
console.log(JSON.stringify({observations:result.observationCount,classifications:result.classifications,countries:Object.keys(result.byCountry).length}));
