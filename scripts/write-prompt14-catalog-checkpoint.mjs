import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {assertBuildOutput,canonical,digest,jsonBytes,loadLockedInputs} from './prompt14-catalog-core.mjs';
import {compareCatalogDirectories,verifyCatalogArtifactBytes} from './prompt14-catalog-artifacts.mjs';
import {HISTORY} from './regenerate-prompt14-sources.mjs';

const option=(key,fallback)=>{const i=process.argv.indexOf(key);return i<0?fallback:process.argv[i+1];};
const first=option('--first','.tmp/prompt14-review-c/catalog-first'),second=option('--second','.tmp/prompt14-review-c/catalog-second');
const sourceFirst=option('--source-first','.tmp/prompt14-review-c/source-first'),sourceSecond=option('--source-second','.tmp/prompt14-review-c/source-second');
const output=option('--output','reports/prompt14/14-08-immutable-catalog-checkpoint.json');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),file=p=>{const b=fs.readFileSync(p);return {path:p,sha256:digest(b),byteLength:b.length};};
const checksPath=option('--checks',null),checks=checksPath?read(checksPath):[];
const stages={'14-2':{status:'blocked'},'14-6':{status:'blocked'},'14-7':{status:'blocked'},'14-8':{status:'blocked'}};
const report={schemaVersion:'prompt14-immutable-catalog-checkpoint-v2',review:'C',status:'blocked',reviewPassed:false,stages,
  executionInputs:{first,second,sourceFirst,sourceSecond,checksPath},checks,history:{directory:HISTORY,snapshot:file(`${HISTORY}/snapshot.json`),priorCheckpoint:`${HISTORY}/reports/prompt14/14-08-immutable-catalog-checkpoint.json`},
  fullDiagnosis:{artifact:file('reports/prompt14/14-02-full-boundary-diagnosis.json'),countsAreDistinctDefectCounts:false},
  productionStoreOrBootstrapWrites:false,implementedAfter14_8:false};
report.resume={workflow:'.github/workflows/prompt14-catalog.yml',emptySourceDirectoriesRequired:true,emptyCatalogDirectoriesRequired:true,
  sourceCommand:'node --max-old-space-size=8192 scripts/regenerate-prompt14-sources.mjs <empty-source-directory>',
  componentHoleProofCommand:'node scripts/verify-prompt14-source-correspondence.mjs <source-directory>',
  catalogCommand:'node --max-old-space-size=8192 scripts/generate-prompt14-catalog.mjs <empty-catalog-directory> --sources <source-directory>',
  migrationCommand:'PROMPT14_CATALOG_OUTPUT=<catalog-directory> NODE_OPTIONS=--max-old-space-size=8192 npx.cmd vitest run src/lib/test-only/production-catalog-migration.test.ts',
  checkpointCommand:'node scripts/write-prompt14-catalog-checkpoint.mjs --first <catalog-first> --second <catalog-second> --source-first <source-first> --source-second <source-second> --checks <command-results.json> --freeze',
  nextImplementationRequiresSeparateTask:'14-9 and production cutover were not executed'};
try{
  const inputs=loadLockedInputs(process.cwd());
  report.sourceLock={...file('data/source-locks/prompt14-derived-game-input-lock.json'),validation:inputs.lockValidation,sourceVersion:inputs.lock.sourceVersion,verifiedConnections:inputs.lock.lineageInputs.length+inputs.lock.artifacts.length+1};
  const source=read(`${sourceFirst}/source-evidence.json`),otherSource=read(`${sourceSecond}/source-evidence.json`);
  if(source.status!=='pass'||otherSource.status!=='pass')throw new Error('Full source generation did not pass');
  const sourceNames=['source-evidence.json','component-hole-correspondence.json',...source.sourceArtifacts.map(a=>a.path)];
  for(const name of sourceNames)if(!fs.readFileSync(`${sourceFirst}/${name}`).equals(fs.readFileSync(`${sourceSecond}/${name}`)))throw new Error(`Independent source bytes differ: ${name}`);
  if(!fs.readFileSync(`${sourceFirst}/source-evidence.json`).equals(fs.readFileSync('reports/prompt14/14-02-source-arrangement-evidence.json')))throw new Error('Current source lock proof differs from independent raw replay');
  if(!source.validation.pass||!source.topology.completeBoundaryCoverage||source.topology.p0OnlySegments||source.topology.ambiguousSides||source.topology.unpairedInteriorBoundaries||source.arrangement.unresolved.length)throw new Error('Source geometry/topology has unresolved boundaries');
  const diagnosis=read('reports/prompt14/14-02-full-boundary-diagnosis.json');
  report.fullDiagnosis={...report.fullDiagnosis,observations:diagnosis.observationCount,uniqueObservations:diagnosis.uniqueObservationCount,duplicateObservations:diagnosis.duplicateObservations,uniqueObservedPhysicalSegments:diagnosis.uniqueObservedPhysicalSegments,
    classifications:diagnosis.classifications,countries:Object.keys(diagnosis.byCountry).length,classificationScope:'Initial input observations, not distinct defect counts. Every source/noded segment is recorded. Numeric candidates are closed only under the common-node <=1e-12 trace certificate; actual residual faces receive separately bounded source-side alignment.',
    actualResidualFaces:source.arrangement.changes.length,numericalNodeTraceCount:source.arrangement.common.traceNodeCount,maximumNumericalNodeDisplacement:source.arrangement.common.maximumNodedSegmentDisplacement,remainingUnexplainedSegments:0};
  const resolution=read('reports/prompt14/14-02-boundary-observation-resolution.json');
  if(resolution.status!=='pass'||!resolution.allObservedSegmentsResolved||resolution.observationCount!==diagnosis.observationCount||resolution.remainingUnexplained||resolution.originalDiagnosisSha256!==report.fullDiagnosis.artifact.sha256||resolution.sourceEvidenceSha256!==file('reports/prompt14/14-02-source-arrangement-evidence.json').sha256)throw new Error('Full observation resolution does not bind the current input/proof');
  report.fullDiagnosis.finalObservationResolution={artifact:file('reports/prompt14/14-02-boundary-observation-resolution.json'),classifications:resolution.classifications,allObservedSegmentsResolved:true};
  const tails=read('reports/prompt14/14-02-construction-tail-proof.json');
  if(tails.status!=='pass'||tails.sourceInputDanglingSegments!==0||tails.constructionExtensionTailSegments!==source.arrangement.failures.dangles||tails.sourceEvidenceSha256!==file('reports/prompt14/14-02-source-arrangement-evidence.json').sha256)throw new Error('Source construction has an unexplained dangling boundary');
  report.fullDiagnosis.constructionTailProof={artifact:file('reports/prompt14/14-02-construction-tail-proof.json'),sourceInputDanglingSegments:0,constructionExtensionTailSegments:tails.constructionExtensionTailSegments,explanation:tails.explanation};
  stages['14-2']={status:'pass',independentRawReplay:{byteIdentical:true,directories:[sourceFirst,sourceSecond],artifacts:sourceNames.map(p=>file(`${sourceFirst}/${p}`))},sourceChangeEvidence:file('reports/prompt14/14-02-source-arrangement-evidence.json'),policy:source.policy,
    featureContinuousChangeCertificate:source.featureChange.pass,legacyComparison:source.legacyChange.pass,identitiesComponentsHoles:source.sourceIdentityAndComponentHolePreservation,fallbackCountries:source.fallbackCountries,noNewFallback:source.noNewWholeCountryFallback};
  stages['14-6']={status:'pass',validation:source.validation};
  const compared=compareCatalogDirectories(first,second),verified=verifyCatalogArtifactBytes(first),build=read(`${first}/build-evidence.json`);
  if(build.status!=='pass'||!build.topology.completeBoundaryCoverage||build.topology.p0OnlySegments||build.topology.ambiguousSides||build.topology.unpairedInteriorBoundaries||build.renderArtifactCount!==5461)throw new Error('Actual complete catalog validation failed');
  stages['14-7']={status:'pass',independentGeneration:compared,verified,buildEvidence:file(`${first}/build-evidence.json`),topology:build.topology,renderArtifactCount:build.renderArtifactCount,tileCountsByZoom:build.tileCountsByZoom,renderBytes:build.renderBytes};
  const migration=read(`${first}/migration-evidence.json`),otherMigration=read(`${second}/migration-evidence.json`);
  for(const p of ['migration-mapping.json','migration-pair.json','migration-evidence.json'])if(!fs.readFileSync(`${first}/${p}`).equals(fs.readFileSync(`${second}/${p}`)))throw new Error(`Independent actual migration differs: ${p}`);
  if(migration.status!=='pass'||otherMigration.status!=='pass'||canonical(migration.catalogRef)!==canonical(verified.ref)||migration.sourceLockSha256!==report.sourceLock.sha256||migration.countries!==247||migration.targetTerritories!==source.validation.atomCount)throw new Error('Migration proof binds a different source/catalog');
  for(const key of ['actualGeometryMatchedLockedAtoms','canonicalSeedCoverageValidated','ownerPreserved','controllerInitializedToOwner','rgbPreserved','canonicalOrderComplete','emptyAuthorities','inputImmutability','deterministicMigration','pairRoundTrip'])if(migration[key]!==true)throw new Error(`Actual migration gate failed: ${key}`);
  if(!migration.coverage.pass||!migration.legacyToDerived.pass||!migration.topology.completeBoundaryCoverage||migration.productionStoreOrBootstrapWrites!==false)throw new Error('Actual geometric migration proof or isolation failed');
  for(const name of ['missing legacy','duplicate legacy','duplicate target','incomplete same-country coverage','empty targets','unknown target','many-to-one','cross-border targets','stale root'])if(!migration.negativeChecks.includes(name))throw new Error(`Required actual mapping rejection was not tested: ${name}`);
  if(file(`${first}/migration-mapping.json`).sha256!==migration.mappingSha256||file(`${first}/migration-pair.json`).sha256!==migration.pairSha256)throw new Error('Mapping/pair byte hash mismatch');
  stages['14-8']={status:'pass',mapping:file(`${first}/migration-mapping.json`),pair:file(`${first}/migration-pair.json`),migrationEvidence:file(`${first}/migration-evidence.json`),migration,
    independentActualMigration:true,frozenCatalogVersion:verified.ref.catalogVersion,catalogRef:verified.ref,freezeCompleted:true};
  if(checks.some(c=>c.exitCode!==0))throw new Error('A required final validation command failed');
  const baseline=read(`${HISTORY}/snapshot.json`);
  const trackedDirty=new Set(baseline.status.split('\n').filter(line=>line&&!line.startsWith('?? ')).map(line=>line.slice(3)));
  const immutable=Object.entries(baseline.hashes).filter(([p])=>p.startsWith('src/')&&trackedDirty.has(p)||p.startsWith('public/')||p.startsWith('data/raw/')||p.startsWith('prompts/')||['package.json','package-lock.json','data/source-locks/prompt14-production-polygon-sources.json'].includes(p));
  report.originalInputPreservation=immutable.map(([p,before])=>{const after=file(p);return {path:p,before,after,preserved:before.sha256===after.sha256&&before.byteLength===after.byteLength};});
  if(report.originalInputPreservation.some(p=>!p.preserved))throw new Error('An immutable original/package/production file changed');
  report.status='pass';report.reviewPassed=true;report.catalogRef=verified.ref;
  const retained=option('--retain',null);
  if(retained){
    assertBuildOutput(process.cwd(),path.resolve(retained));
    if(!fs.existsSync(retained)){fs.mkdirSync(path.dirname(retained),{recursive:true});fs.cpSync(first,retained,{recursive:true,force:false,errorOnExist:true});}
    const retainedComparison=compareCatalogDirectories(first,retained);
    for(const p of ['migration-mapping.json','migration-pair.json','migration-evidence.json'])if(!fs.readFileSync(`${first}/${p}`).equals(fs.readFileSync(`${retained}/${p}`)))throw new Error('Retained migration bytes differ');
    report.retainedArtifacts={directory:retained,comparison:retainedComparison,artifactIndex:file(`${retained}/artifact-index.json`),fullGeometryAndTopologyBuildOnly:true,deliveryPreparedInBuildStorage:true,activeProductionPublication:false};
  }
  if(process.argv.includes('--freeze')){
    const freeze=option('--freeze-output','data/catalogs/prompt14/frozen-catalog-ref.json');
    if(fs.existsSync(freeze)){
      const previous=read(freeze);
      if(canonical(previous.ref)!==canonical(verified.ref)||previous.sourceLockSha256!==report.sourceLock.sha256||previous.mappingSha256!==migration.mappingSha256||previous.pairSha256!==migration.pairSha256||previous.artifactIndex.sha256!==file(`${first}/artifact-index.json`).sha256)throw new Error('Frozen catalog reference cannot be overwritten by a different version/root/source/migration; provide a new explicit freeze path');
    }else{fs.mkdirSync(path.dirname(freeze),{recursive:true});fs.writeFileSync(freeze,jsonBytes({status:'pass',review:'C',ref:verified.ref,sourceLockSha256:report.sourceLock.sha256,artifactIndex:file(`${retained??first}/artifact-index.json`),mappingSha256:migration.mappingSha256,pairSha256:migration.pairSha256,productionCutover:false}));}
    report.freeze=file(freeze);
  }
}catch(error){
  const failure=[`${first}/generation-failure.json`,`${second}/generation-failure.json`,`${sourceFirst}/source-failure.json`,`${sourceSecond}/source-failure.json`].filter(p=>fs.existsSync(p));
  report.failure={message:error.message,artifacts:failure.map(p=>({artifact:file(p),result:read(p)}))};
  report.status=error.code==='ENOENT'&&!failure.length?'blocked':'fail';report.reviewPassed=false;
  if(stages['14-8'].status==='pass'){stages['14-8'].status=report.status;stages['14-8'].freezeCompleted=false;}
  const pending=Object.values(stages).find(s=>s.status==='blocked');if(pending)pending.status=report.status;
}
const baseline=read(`${HISTORY}/snapshot.json`);
const changed=execFileSync('git',['status','--porcelain=v1','--untracked-files=all'],{encoding:'utf8',maxBuffer:32*1024*1024}).trimEnd().split('\n').map(line=>line.slice(3).replace(/^"|"$/g,''));
report.preExistingDirtyStatus=baseline.status;
report.changedFiles=changed.filter(p=>p&&p!==output&&fs.existsSync(p)&&fs.statSync(p).isFile()).map(file).filter(f=>!baseline.hashes[f.path]||baseline.hashes[f.path].sha256!==f.sha256||baseline.hashes[f.path].byteLength!==f.byteLength);
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,jsonBytes(report));
console.log(JSON.stringify({status:report.status,reviewPassed:report.reviewPassed,stages:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,v.status])),output}));
if(!report.reviewPassed)process.exitCode=report.status==='blocked'?2:1;
