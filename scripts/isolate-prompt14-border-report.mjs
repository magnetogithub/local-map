import fs from 'node:fs';
const p='scripts/validate-border-recomputation.mjs';let s=fs.readFileSync(p,'utf8');
s=s.replace('fs.mkdirSync(path.join(root,"reports"),{recursive:true});fs.writeFileSync(path.join(root,"reports/fix07-border-recomputation.json"),', 'const reportPath=process.env.PAX_BORDER_RECOMPUTATION_REPORT??path.join(root,"reports/fix07-border-recomputation.json");fs.mkdirSync(path.dirname(reportPath),{recursive:true});fs.writeFileSync(reportPath,');
fs.writeFileSync(p,s);
