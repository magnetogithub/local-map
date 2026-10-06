import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const path='reports/prompt14/final-validation/baseline.json',baseline=JSON.parse(fs.readFileSync(path,'utf8'));
for(const file of ['eslint.config.mjs','vitest.config.ts']){
  let original=fs.readFileSync(file,'utf8');
  if(file==='eslint.config.mjs')original=original.split('\r\n').filter(line=>!line.includes('Generated verification bundles')
    &&!['".tmp/**"','"reports/**"','"test-results/**"','"playwright-report/**"'].some(value=>line.trim().startsWith(value))).join('\r\n');
  else original=original.replace(', ".tmp/**", "reports/**", "test-results/**", "playwright-report/**"','');
  const head=execFileSync('git',['show',`${baseline.head}:${file}`],{encoding:'utf8'});
  if(original.replaceAll('\r\n','\n')!==head)throw Error(`Starting config reconstruction differs from clean HEAD: ${file}`);
  baseline.hashes[file]=createHash('sha256').update(original).digest('hex');
}
baseline.supplement='Config starting hashes reconstructed by reversing only final-run additions, verifying normalized text against clean starting HEAD and preserving CRLF. Initial capture attempt failed because Git stores LF; neither config was dirty at task start.';
fs.writeFileSync(path,JSON.stringify(baseline,null,2));console.log('Verified config starting hashes');
