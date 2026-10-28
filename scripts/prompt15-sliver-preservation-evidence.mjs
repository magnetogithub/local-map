import fs from 'node:fs';
import path from 'node:path';
import {createRequire,builtinModules} from 'node:module';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {dependencySpecifiers} from './prompt15-sliver-delivery-adapter.mjs';
import {digest,jsonBytes,hashCanonical} from './prompt14-catalog-core.mjs';
export const BASE='reports/prompt15/15-22-sliver-adoption-audit/20261028-e16a54f859dcfd8e75f4';
export const A='data/derived/prompt15/15-18-administrative-input-v1-161260049c9100b09cb5';
export const W='data/derived/prompt15/15-19-sliver-adoption-draft-v1-fcc161d97b12c27cd745';
export const I='data/derived/prompt15/15-20-sliver-adoption-indices-draft-v1-6f885f0ba9e50a6b70bb';
export const D='data/derived/prompt15/15-21-sliver-adoption-delivery-draft-v1-e16a54f859dcfd8e75f4';
export const CLOSE='reports/prompt15/15-22-sliver-closeout/20261028-closeout-d017f7145d';
export const SVN='reports/prompt15/15-22-svn-evidence/20261027-svn-5a227ccf63/prepared-evidence-map.json';
export const REVIEW='reports/prompt15/15-22-component-review/20261027-components-7262c972ca';
export const PINS=[{path:`${A}/artifact-index.json`,sha256:'bb977fd802809430ee07b240cb68aa61299701f30a762c987d1890767d226256',byteLength:1981},{path:`${W}/artifact-index.json`,sha256:'a32a1687a0988eabd48175ccd394c800005bc652be085927854124d4e0f046af',byteLength:165354},{path:`${I}/artifact-index.json`,sha256:'cc77ef54ae5b7751c32a8afd1a7776029a2d931d4e53b99b135caf4cf89eae75',byteLength:79999},{path:`${D}/artifact-index.json`,sha256:'b53aa240276b6678faf75bcf8ebfd83ef595c904b4d7d5dcc82a712a65fce3f5',byteLength:790056}];
export const RECEIPTS=['reports/prompt15/15-20-sliver-adoption-verification/20261028-independent/verification.json','reports/prompt15/15-21-sliver-adoption-verification/20261028-delivery-2a97a1a4cf-independent/verification.json','reports/prompt15/15-21-sliver-adoption-verification/20261028-delivery-2a97a1a4cf-independent/verifier-execution.json'];
export const RULES=['scripts/prompt15-cell-policy.mjs','docs/automation/prompt15-sliver-evaluation-v2.json','docs/automation/prompt15-numerical-deferral.json',`${CLOSE}/adoption-manifest.json`,`${CLOSE}/numerical-deferral-supplement.json`,'reports/prompt15/15-20-sliver-adoption/20261028-indices-6084b5f890/ledger-reference-reconciliation.json','reports/prompt15/15-20-sliver-adoption/20261028-indices-6084b5f890/numerical-debt-carryforward.json','reports/prompt15/15-21-sliver-adoption/20261028-delivery-2a97a1a4cf/handoff.json',`${REVIEW}/summary.json`,'reports/prompt15/15-22-component-repair/20261028-parent-support-aae81f14ea/summary.json','reports/prompt15/15-22-component-repair/20261028-parent-guard-d1b641a516/summary.json',SVN];
export const assert=(c,m)=>{if(!c)throw Error(m);};
export const same=(a,b)=>digest(jsonBytes(a))===digest(jsonBytes(b));
export const samePin=(a,b)=>a?.sha256===b?.sha256&&a?.byteLength===b?.byteLength;
export const id=p=>{const b=fs.readFileSync(p);return {path:p.replaceAll('\\','/'),sha256:digest(b),byteLength:b.length};};
export const root=(domain,pins)=>hashCanonical(domain,pins.slice().sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0));
export const write=(dir,name,value)=>{const file=path.resolve(dir,name);assert(file.startsWith(path.resolve(dir)+path.sep),'Output escape');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,jsonBytes(value),{flag:'wx'});};
export function openInputs(){
 const used=new Map(),indexes=new Map();
 const bytes=(p,pin)=>{const b=fs.readFileSync(p),actual={path:p.replaceAll('\\','/'),sha256:digest(b),byteLength:b.length};assert(!pin||samePin(actual,pin),`Input identity changed: ${p}`);assert(!used.has(actual.path)||samePin(used.get(actual.path),actual),`Input mutated: ${p}`);used.set(actual.path,actual);return b;};
 const read=(p,pin)=>JSON.parse(bytes(p,pin));
 for(const pin of PINS){const index=read(pin.path,pin),map=new Map();for(const d of index.artifacts){assert(!map.has(d.path)&&!d.path.includes('..')&&!path.isAbsolute(d.path),'Invalid index path');map.set(d.path,d);}indexes.set(path.posix.dirname(pin.path),map);}
 const indexed=(r,n,raw=false)=>{const pin=indexes.get(r)?.get(n);assert(pin,`Unindexed input ${r}/${n}`);const b=bytes(`${r}/${n}`,pin);return raw?b:JSON.parse(n.endsWith('.gz')?gunzipSync(b,{maxOutputLength:768*1024**2}):b);};
 const stable=()=>[...used.values()].filter(p=>{try{return !samePin(id(p.path),p);}catch{return true;}});
 return {used,indexes,bytes,read,indexed,stable};
}
export function currentCodePins(){
 const found=new Map(),builtins=new Set(builtinModules.flatMap(n=>[n,`node:${n}`]));
 const visit=p=>{p=p.replaceAll('\\','/');if(found.has(p))return;found.set(p,id(p));if(!/\.(?:mjs|cjs|js)$/.test(p))return;const req=createRequire(path.resolve(p));for(const {spec,esm} of dependencySpecifiers(fs.readFileSync(p,'utf8'))){if(builtins.has(spec)||spec.startsWith('node:'))continue;const resolved=spec.startsWith('.')?req.resolve(spec):esm?fileURLToPath(import.meta.resolve(spec)):req.resolve(spec);visit(path.relative(process.cwd(),resolved));}};
 for(const p of ['scripts/prompt15-sliver-preservation-audit.mjs','scripts/prompt15-sliver-preservation-audit.node-test.mjs','scripts/prompt15-preservation-audit.node-test.mjs','scripts/prompt15-sliver.node-test.mjs'])visit(p);
 for(const p of ['package.json','package-lock.json','node_modules/jsts/package.json','node_modules/polygon-clipping/package.json','node_modules/acorn/package.json'])found.set(p,id(p));
 return [...found.values()].sort((a,b)=>a.path<b.path?-1:1);
}
export function checkReady(ready){
 assert(ready.status==='READY_FOR_FIVE_COUNTRY_BATCHES','Not a frozen ready record');
 for(const p of [...ready.commonInputs,...ready.rules,...ready.code,...ready.assignments.map(a=>a.file)])assert(samePin(id(p.path),p),`Common pin changed: ${p.path}`);
 assert(root('sliver-audit-common-input-v1',ready.commonInputs)===ready.commonInputRoot&&root('sliver-audit-rules-v1',ready.rules)===ready.ruleRoot&&root('sliver-audit-code-v1',ready.code)===ready.auditCodeRoot,'Ready root mismatch');
}
// Historical replay code pins are receipt claims, never requirements on today's helper bytes.
// Replays are not rerun: their immutable outputs, native executions and all data inputs are checked.
export function preparedSources(inputs,provenance,shared,traces){
 const byId=new Map(shared.map(f=>[String(f.properties.ne_id),f]));
 const receipt=inputs.read(SVN),approval=provenance.restoration15_09;
 assert(samePin(receipt.provenance,id(`${A}/provenance.json`))&&receipt.countryId==='SVN'&&receipt.entries.length===2&&approval.status==='pass'&&Object.values(approval.checks).every(v=>v===true),'SVN evidence map provenance');
 const outputs=[],pids=new Set(),paths=new Set(),historicalCode=[];
 for(const entry of receipt.entries){const expected=approval.evidence[entry.name];assert(expected&&samePin(entry.actual,expected)&&samePin(entry.approvedPin,expected)&&entry.logicalPath===expected.path&&!paths.has(entry.actual.path),'SVN approved v2 pin correspondence');paths.add(entry.actual.path);
  const candidate=inputs.read(entry.actual.path,entry.actual),execution=inputs.read(entry.origin.execution.path,entry.origin.execution),command=inputs.read(entry.origin.command.path,entry.origin.command);inputs.bytes(entry.origin.wrapper.path,entry.origin.wrapper);
  assert(command.exitCode===0&&command.signal===null&&!command.error&&command.started&&command.finished&&execution.expectedExitCode===0&&execution.inputsUnchanged===true&&same(execution.inputsBefore,execution.inputsAfter)&&!pids.has(execution.pid)&&samePin(execution.output,entry.actual),'SVN complete independent native replay');pids.add(execution.pid);
  for(const pin of execution.inputsBefore){if(/^(scripts\/|node_modules\/)/.test(pin.path)&&/\.(?:mjs|js)$/.test(pin.path)){historicalCode.push(pin);continue;}inputs.bytes(pin.path,pin);}
  assert(candidate.status==='pass'&&candidate.evidence.policy.version===approval.policyVersion&&candidate.evidence.policy.taskId==='15-08'&&candidate.geometrySha256===approval.geometrySha256&&digest(jsonBytes(candidate.selected))===approval.geometrySha256&&Object.values(candidate.checks).every(x=>x===true)&&Object.keys(approval.checks).every(k=>candidate.checks[k]===true)&&candidate.sourceIdentityCount===approval.sourceIdentityCount&&candidate.selected.features.length===approval.sourceIdentityCount,'SVN v2 prepared result policy/checks');outputs.push(candidate);
 }
 assert(same(outputs[0],outputs[1])&&pids.size===2,'SVN replay outputs differ');
 for(const f of outputs[0].selected.features)byId.set(String(f.properties.sourceFeatureId),f);
 for(const trace of traces){const f=byId.get(trace.source.identity);assert(f&&digest(jsonBytes(f.geometry))===trace.source.preparedGeometrySha256,`Prepared lineage mismatch ${trace.source.identity}`);}
 return {byId,historicalCode,receipt:inputs.used.get(SVN)};
}
