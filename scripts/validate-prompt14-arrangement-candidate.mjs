import fs from 'node:fs';
import {generateAtoms,validateAtoms,jsonBytes} from './prompt14-catalog-core.mjs';
import {buildCatalogTopology} from './prompt14-catalog-topology.mjs';
const candidate=JSON.parse(fs.readFileSync('.tmp/prompt14-review-c/arrangement-world.json','utf8'));
const inputs={...candidate,metadata:JSON.parse(fs.readFileSync('src/data/countries-2020.json','utf8')),lock:JSON.parse(fs.readFileSync('data/source-locks/prompt14-derived-game-input-lock.json','utf8'))};
const atoms=generateAtoms(inputs);
try{const coverage=validateAtoms(atoms,inputs,console.log);console.log('full geometry/area coverage passed');const topology=buildCatalogTopology(atoms,inputs.p0,console.log);
  fs.writeFileSync('.tmp/prompt14-review-c/candidate-validation.json',jsonBytes({coverage,topology:topology.evidence}));console.log(JSON.stringify(topology.evidence));}
catch(error){fs.writeFileSync('.tmp/prompt14-review-c/candidate-validation-failure.json',JSON.stringify({message:error.message,evidence:error.evidence??null}));console.error(error.stack);process.exitCode=1;}
