import fs from 'node:fs';
import {jsonBytes,loadLockedInputs} from './prompt14-catalog-core.mjs';
import {verifyLockedSourceWitness} from './prompt14-catalog-source-witness.mjs';
const normalization=JSON.parse(fs.readFileSync('.tmp/prompt14-catalog/atoms-first/normalization-evidence.json','utf8'));
const evidence=verifyLockedSourceWitness(loadLockedInputs(process.cwd()),normalization);
fs.writeFileSync('.tmp/prompt14-catalog/source-witness.json',jsonBytes(evidence));console.log(JSON.stringify(evidence));
