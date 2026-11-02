import fs from 'node:fs';
const p='src/lib/simulation/world-effect.ts';const s=fs.readFileSync(p,'utf8').replaceAll('.min(1).max(8).optional()', '.min(1).max(8).nullish()');fs.writeFileSync(p,s);
