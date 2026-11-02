import fs from 'node:fs';
const p='e2e/prompt14-benchmark.spec.ts';let s=fs.readFileSync(p,'utf8');
s=s.replace("fs.mkdirSync('reports/prompt14/final-validation/performance',{recursive:true});fs.writeFileSync('reports/prompt14/final-validation/performance/browser.json',", "const output=process.env.PROMPT14_PERFORMANCE_OUTPUT??'reports/prompt14/final-validation/performance';fs.mkdirSync(output,{recursive:true});fs.writeFileSync(`${output}/browser.json`,");
fs.writeFileSync(p,s);
