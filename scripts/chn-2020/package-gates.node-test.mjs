import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

// These fixtures exercise the real packager gate in an isolated workspace. No
// generated catalog or active project pointer is changed by a gate-only run.
const packager=fileURLToPath(new URL('../prepare-prompt19-mixed-world.mjs',import.meta.url));
const project=fileURLToPath(new URL('../../',import.meta.url));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>Buffer.from(`${JSON.stringify(value)}\n`);
const acceptance=()=>Object.fromEntries(['nonTargetPreservation','sourcePins','hierarchy','topology','coverage','residualAudit','reproducibility'].map(k=>[k,true]));

function fixture(){
  const parent=path.join(project,'.tmp');fs.mkdirSync(parent,{recursive:true});
  const root=fs.mkdtempSync(path.join(parent,'chn-package-gates-'));
  const write=(file,value,raw=false)=>{const bytes=raw?Buffer.from(value):json(value),target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);return {path:file,sha256:sha(bytes),byteLength:bytes.length};};
  const pin=file=>{const bytes=fs.readFileSync(path.join(root,file));return {path:file,sha256:sha(bytes),byteLength:bytes.length};};
  const code=['scripts/chn-2020/prepare-china.py','scripts/chn-2020/incremental-coordinator.mjs','scripts/prepare-prompt19-mixed-world.mjs','scripts/prompt14-catalog-core.mjs'].map(file=>write(file,'// gate fixture\n',true));
  for(const file of ['scripts/prepare-prompt19-joined-candidates.mjs','scripts/prompt19-source-arrangement.mjs','scripts/prompt19-joined-topology.mjs'])write(file,'// legacy gate fixture\n',true);
  const sourceLocks=['KOR','PRK','CHN'].map(countryId=>{
    const raw=write(`data/raw/${countryId}/raw.json`,{}),normalized=write(`data/raw/${countryId}/normalized.json`,{type:'FeatureCollection',features:[]});
    const lock={countryId,sources:[{sourceId:`fixture-${countryId}`,adminLevel:2,artifact:raw,license:{name:'fixture public domain',redistributionAllowed:true,attribution:'fixture'}}],normalizedInput:normalized,preprocessing:{code:[code[0]]}};
    return {...write(`data/source-locks/${countryId}.json`,lock),countryId};
  });
  const hierarchy=['KOR','PRK','CHN'].map(countryId=>({...write(`data/source-locks/${countryId}-hierarchy.json`,{countryId}),countryId}));
  const baselineBundle={report:{nationalBoundaryInput:{bundle:{sha256:'a'.repeat(64)}},sourceLockArtifacts:sourceLocks.slice(0,2),hierarchyArtifacts:hierarchy.slice(0,2)}};
  const baselineBundlePin=write('reports/baseline-bundle.json',baselineBundle);
  const nationalProof=write('reports/national-proof.json',{pass:true,after:baselineBundlePin,before:{sha256:'a'.repeat(64)}});
  const baselineRoot='data/derived/baseline';
  const provenance=write(`${baselineRoot}/provenance.json`,{inputRoot:baselineBundlePin.sha256,inputs:[baselineBundlePin],nationalBoundaryVerification:nationalProof,sourceLockArtifacts:sourceLocks.slice(0,2),fineCountries:['KOR','PRK']});
  const index=write(`${baselineRoot}/artifact-index.json`,{artifacts:[{...provenance,path:'provenance.json'}]});
  const pointer={catalogVersion:'baseline-fixture',root:baselineRoot,index:{sha256:index.sha256,byteLength:index.byteLength}};
  const baselinePointer=write('reports/baseline-pointer.json',pointer);write('data/runtime/operational-catalog/current.json',pointer);
  const bundle={features:[],records:[],edges:[],parents:{administrative:[],previous:[]},report:{invalid:[],unresolved:[],topology:{pass:true},sourceLockArtifacts:sourceLocks,hierarchyArtifacts:hierarchy,incremental:{countryId:'CHN',fineCountries:['CHN','KOR','PRK'],baseline:{pointer:baselinePointer,bundle:baselineBundlePin,nationalBoundaryVerification:nationalProof},codeArtifacts:code.slice(0,2)}}};
  let proof;
  const refresh=()=>{const after=write('reports/candidate.json',bundle);proof={pass:true,after,before:baselineBundlePin,baselinePointer,checks:acceptance()};write('reports/proof.json',proof);};
  refresh();
  const run=(args=[])=>spawnSync(process.execPath,[packager,'--input','reports/candidate.json','--check-input',...args],{cwd:root,encoding:'utf8',timeout:30_000,windowsHide:true});
  const verified=(args=[])=>run(['--incremental-verification','reports/proof.json',...args]);
  const cleanup=()=>{const relative=path.relative(parent,root);assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));fs.rmSync(root,{recursive:true,force:true});};
  return {root,bundle,get proof(){return proof;},write,pin,refresh,run,verified,cleanup};
}

test('a valid incremental proof passes without publishing or changing current',()=>{
  const f=fixture();try{const current=fs.readFileSync(path.join(f.root,'data/runtime/operational-catalog/current.json'));const result=f.verified(['--no-activate']);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{pass:true,inputPath:'reports/candidate.json',incremental:true,fineCountries:['CHN','KOR','PRK'],activationRequested:false,publicationGuard:'not-evaluated-by-input-only-check'});assert.ok(current.equals(fs.readFileSync(path.join(f.root,'data/runtime/operational-catalog/current.json'))));assert.deepEqual(fs.readdirSync(path.join(f.root,'data/derived')),['baseline']);}finally{f.cleanup();}
});

test('incremental publication requires a bound independent proof',()=>{
  const f=fixture();try{const result=f.run();assert.notEqual(result.status,0);assert.match(result.stderr,/MISSING_ARGUMENT:--incremental-verification/);}finally{f.cleanup();}
});

test('proof after digest and all acceptance gates are mandatory',()=>{
  for(const mutation of ['digest','residualAudit','nonTargetPreservation','reproducibility']){
    const f=fixture();try{if(mutation==='digest')f.proof.after.sha256='0'.repeat(64);else delete f.proof.checks[mutation];f.write('reports/proof.json',f.proof);const result=f.verified();assert.notEqual(result.status,0);assert.match(result.stderr,mutation==='digest'?/UNVERIFIED_INCREMENTAL_INPUT/:new RegExp(`MISSING_INCREMENTAL_ACCEPTANCE:${mutation}`));}finally{f.cleanup();}
  }
});

test('baseline input and indexed provenance pins cannot be substituted',()=>{
  for(const file of ['reports/baseline-bundle.json','data/derived/baseline/provenance.json']){
    const f=fixture();try{f.write(file,{});const result=f.verified();assert.notEqual(result.status,0);assert.match(result.stderr,/PIN_CHANGED:baseline\.(bundle|provenance)/);}finally{f.cleanup();}
  }
});

test('actual raw source bytes and preprocessing code pins are checked',()=>{
  for(const file of ['data/raw/CHN/raw.json','scripts/chn-2020/prepare-china.py']){
    const f=fixture();try{f.write(file,'changed\n',true);const result=f.verified();assert.notEqual(result.status,0);assert.match(result.stderr,/PIN_CHANGED:(raw:CHN|code:)/);}finally{f.cleanup();}
  }
});

test('unsupported fine country scope and missing inherited source locks are rejected',()=>{
  for(const mutation of ['country','lock']){
    const f=fixture();try{if(mutation==='country')f.bundle.report.incremental.fineCountries.push('JPN');else f.bundle.report.sourceLockArtifacts=f.bundle.report.sourceLockArtifacts.filter(a=>a.countryId!=='PRK');f.refresh();const result=f.verified();assert.notEqual(result.status,0);assert.match(result.stderr,/SOURCE_LOCK_SCOPE/);}finally{f.cleanup();}
  }
});

test('public access without explicit redistribution authorization is rejected',()=>{
  const f=fixture();try{const artifact=f.bundle.report.sourceLockArtifacts.find(a=>a.countryId==='CHN');const lock=JSON.parse(fs.readFileSync(path.join(f.root,artifact.path)));lock.sources[0].license.redistributionAllowed=false;Object.assign(artifact,f.write(artifact.path,lock));f.refresh();const result=f.verified();assert.notEqual(result.status,0);assert.match(result.stderr,/SOURCE_REDISTRIBUTION_NOT_AUTHORIZED/);}finally{f.cleanup();}
});

test('conflicting activation flags are rejected before any publication',()=>{
  const f=fixture();try{const result=f.verified(['--activate','--no-activate']);assert.notEqual(result.status,0);assert.match(result.stderr,/CONFLICTING_ACTIVATION_ARGUMENTS/);}finally{f.cleanup();}
});

function activeFineCountries(f,countryIds){
  const root='data/derived/baseline',file=`${root}/provenance.json`,provenance=JSON.parse(fs.readFileSync(path.join(f.root,file)));
  provenance.fineCountries=countryIds;provenance.sourceLockArtifacts=countryIds.map(id=>f.bundle.report.sourceLockArtifacts.find(a=>a.countryId===id));
  const artifact=f.write(file,provenance),index=f.write(`${root}/artifact-index.json`,{artifacts:[{...artifact,path:'provenance.json'}]});
  const pointer=JSON.parse(fs.readFileSync(path.join(f.root,'data/runtime/operational-catalog/current.json')));pointer.index={sha256:index.sha256,byteLength:index.byteLength};f.write('data/runtime/operational-catalog/current.json',pointer);
}
function legacyCandidate(f){delete f.bundle.report.incremental;f.bundle.report.sourceLockArtifacts=f.bundle.report.sourceLockArtifacts.filter(a=>a.countryId!=='CHN');f.bundle.report.hierarchyArtifacts=f.bundle.report.hierarchyArtifacts.filter(a=>a.countryId!=='CHN');f.refresh();}

test('legacy publication cannot drop an indexed active CHN fine country',()=>{
  const f=fixture();try{
    activeFineCountries(f,['CHN','KOR','PRK']);legacyCandidate(f);
    const before=fs.readFileSync(path.join(f.root,'data/runtime/operational-catalog/current.json'));
    const result=f.run(['--check-activation']);assert.notEqual(result.status,0);assert.match(result.stderr,/ACTIVE_FINE_COUNTRY_WOULD_BE_DROPPED:CHN/);
    assert.ok(before.equals(fs.readFileSync(path.join(f.root,'data/runtime/operational-catalog/current.json'))));
  }finally{f.cleanup();}
});

test('historical no-activate input validation remains allowed with an explicit input-only result',()=>{
  const f=fixture();try{
    activeFineCountries(f,['CHN','KOR','PRK']);legacyCandidate(f);
    const result=f.run(['--no-activate']);assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).publicationGuard,'not-evaluated-by-input-only-check');
  }finally{f.cleanup();}
});

test('a preserving incremental candidate passes the independently indexed active-country guard',()=>{
  const f=fixture();try{
    const result=f.verified(['--check-activation']);assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).publicationGuard.activeFineCountries,['KOR','PRK']);
    assert.deepEqual(JSON.parse(result.stdout).publicationGuard.candidateFineCountries,['CHN','KOR','PRK']);
  }finally{f.cleanup();}
});

test('active provenance must match its immutable artifact-index hash before publication',()=>{
  const f=fixture();try{
    legacyCandidate(f);
    f.write('data/derived/baseline/provenance.json',{fineCountries:[],sourceLockArtifacts:[]});
    const result=f.run(['--check-activation']);assert.notEqual(result.status,0);assert.match(result.stderr,/PIN_CHANGED:active.provenance/);
  }finally{f.cleanup();}
});
