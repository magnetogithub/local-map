import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {validateDerivedGameLock} from './prompt14-shared-topology.mjs';
import {validateSourceLock} from './prompt14-source-gate.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),sha=b=>createHash('sha256').update(b).digest('hex');
const freeze=read('data/catalogs/prompt14/frozen-catalog-ref.json'),root='reports/prompt14/final-validation';
const result={status:'pass',frozenRef:freeze.ref,sourceLock:null,upstreamSources:[],verifiedArtifacts:0,checkpoints:[],errors:[]};
const verify=(path,hash,byteLength)=>{try{const bytes=fs.readFileSync(path);if(sha(bytes)!==hash||(byteLength!==undefined&&bytes.length!==byteLength))throw Error(`Identity mismatch: ${path}`);result.verifiedArtifacts++;}catch(e){result.errors.push(e.message);}};
verify(freeze.artifactIndex.path,freeze.artifactIndex.sha256,freeze.artifactIndex.byteLength);
for(const a of read(freeze.artifactIndex.path).artifacts)verify(a.path.startsWith('build-only/')?path.join(path.dirname(freeze.artifactIndex.path),a.path):a.path,a.sha256,a.byteLength);
verify(`data/catalogs/prompt14/${freeze.ref.catalogVersion}/migration-pair.json`,freeze.pairSha256);
verify(`data/catalogs/prompt14/${freeze.ref.catalogVersion}/migration-mapping.json`,freeze.mappingSha256);
verify('data/source-locks/prompt14-derived-game-input-lock.json',freeze.sourceLockSha256);
const lock=read('data/source-locks/prompt14-derived-game-input-lock.json');result.sourceLock={...validateDerivedGameLock(lock,process.cwd()),license:lock.license,attribution:lock.attribution,lineageInputs:lock.lineageInputs.length};
if(!result.sourceLock.pass)result.errors.push(...result.sourceLock.errors);
const manifest=read('data/source-locks/prompt14-production-polygon-sources.json');
for(const source of manifest.sources??[]){const check=validateSourceLock(source,process.cwd());result.upstreamSources.push({path:source.repositoryPath,license:source.license,pass:check.pass,error:check.error});if(!check.pass)result.errors.push(check.error);}
for(const name of ['14-01-baseline-runtime-data-audit','14-02-source-generation-delivery-decision','14-05-schema-migration-checkpoint','14-08-immutable-catalog-checkpoint','14-14-occupation-checkpoint','14-17-country-color-checkpoint']){
  const path=`reports/prompt14/${name}.json`,bytes=fs.readFileSync(path),checkpoint=JSON.parse(bytes);result.checkpoints.push({path,status:checkpoint.status,sha256:sha(bytes),byteLength:bytes.length});if(checkpoint.status!=='pass')result.errors.push(`Checkpoint not pass: ${path}`);
}
result.status=result.errors.length?'fail':'pass';fs.mkdirSync(root,{recursive:true});fs.writeFileSync(`${root}/source-audit.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result));if(result.status!=='pass')process.exitCode=1;
