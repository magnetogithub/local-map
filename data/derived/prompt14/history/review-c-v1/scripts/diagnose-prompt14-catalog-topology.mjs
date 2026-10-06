import fs from 'node:fs';
import {buildCatalogTopology} from './prompt14-catalog-topology.mjs';
const {atoms}=JSON.parse(fs.readFileSync('.tmp/prompt14-catalog/atoms-first/atoms.json','utf8'));
const p0=JSON.parse(fs.readFileSync('data/derived/prompt14/shared-game-p0.geojson','utf8'));
try {const result=buildCatalogTopology(atoms,p0,console.log);console.log(JSON.stringify(result.evidence));}
catch(error){fs.writeFileSync('.tmp/prompt14-catalog/topology-failure.json',JSON.stringify(error.evidence,null,2));console.error(error.message);process.exitCode=1;}
