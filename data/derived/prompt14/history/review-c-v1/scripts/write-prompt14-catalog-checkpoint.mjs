import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {canonical,digest,loadLockedInputs} from './prompt14-catalog-core.mjs';
import {verifyLockedSourceWitness} from './prompt14-catalog-source-witness.mjs';

const root=process.cwd(),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const baseline=read('.tmp/prompt14-catalog/baseline.json'),inputs=loadLockedInputs(root);
const first='.tmp/prompt14-catalog/atoms-final-first',second='.tmp/prompt14-catalog/atoms-final-second';
const atomArtifacts=read(`${first}/artifact-index.json`);
for(const name of ['atoms.json','normalization-evidence.json','artifact-index.json'])if(!fs.readFileSync(`${first}/${name}`).equals(fs.readFileSync(`${second}/${name}`)))throw new Error(`Independent normalization bytes differ: ${name}`);
const failureFirst='.tmp/prompt14-catalog/catalog-first/generation-failure.json',failureSecond='.tmp/prompt14-catalog/catalog-second/generation-failure.json';
const failureBytes=fs.readFileSync(failureFirst);if(!failureBytes.equals(fs.readFileSync(failureSecond)))throw new Error('Independent production failure evidence differs');
const failure=read(failureFirst),normalization=read(`${first}/normalization-evidence.json`);
if(failure.status!=='fail'||!failure.evidence?.errorCount||normalization.pass!==true)throw new Error('Unexpected checkpoint state');
const witness=verifyLockedSourceWitness(inputs,normalization);if(!witness.exceedsNumericalContactTolerance)throw new Error('Source mismatch witness no longer holds; reinvestigate');
const preserved=Object.entries(baseline.hashes).map(([repositoryPath,before])=>{const bytes=fs.readFileSync(repositoryPath);const after={sha256:digest(bytes),byteLength:bytes.length};return {repositoryPath,before,after,preserved:canonical(before)===canonical(after)};});
if(preserved.some(f=>!f.preserved))throw new Error('Pre-existing dirty file bytes changed');
const changedFiles=[
  '.github/workflows/prompt14-catalog.yml',
  'scripts/prompt14-catalog-core.mjs','scripts/prompt14-catalog-core.node-test.mjs',
  'scripts/generate-prompt14-atoms.mjs','scripts/prompt14-catalog-topology.mjs',
  'scripts/prompt14-catalog-topology.node-test.mjs','scripts/prompt14-catalog-artifacts.mjs',
  'scripts/generate-prompt14-catalog.mjs','scripts/prompt14-catalog-source-witness.mjs',
  'scripts/diagnose-prompt14-catalog-source.mjs','scripts/diagnose-prompt14-catalog-topology.mjs',
  'scripts/write-prompt14-catalog-checkpoint.mjs',
].map(repositoryPath=>{const bytes=fs.readFileSync(repositoryPath);return {repositoryPath,change:'added',sha256:digest(bytes),byteLength:bytes.length};});
const check=(command,exitCode,result)=>({command,exitCode,result});
const report={
  schemaVersion:'prompt14-immutable-catalog-checkpoint-v1',status:'fail',review:'C',reviewPassed:false,
  generatedAt:new Date().toISOString(),requestedTasks:['14-6','14-7','14-8'],
  requestInterpretation:'16-6 was interpreted as 14-6 from the approved 14-5 predecessor and the requested 14-8 endpoint.',
  stages:{
    '14-6':{status:'pass',scope:'Coordinate/ring/component normalization and canonical atom identity; exact source-feature membership retained. Full area coverage passes the locked numerical tolerance. Absolute continuity is checked in 14-7.',
      atoms:normalization.atomCount,rawComponentCandidates:normalization.rawComponentAtomCandidates,countries:normalization.countryCount,vertices:normalization.authoritativeVertices,
      independentGeneration:{pass:true,byteIdentical:true,directories:[first,second],artifacts:atomArtifacts},validation:normalization},
    '14-7':{status:'fail',implementation:'Stable IDs/provenance, exact robust topology, symmetric adjacency, domain-separated roots, versioned two-layer PBF tiles z0..6, byte verification and Windows CI are implemented. Production source boundary gate fails before emitting a catalog.',
      productionGate:{status:'fail',message:failure.message,evidence:failure.evidence,independentReproduction:{byteIdentical:true,sha256:digest(failureBytes),byteLength:failureBytes.length,paths:[failureFirst,failureSecond]}},
      countsInterpretation:'2048 unmatched/ambiguous segment observations and 1096 P0-only observations are raw exact-noding results; they are not asserted to be 3144 distinct geometric defects. Some are floating-point collinearity. The independently verified AFG witness is beyond the locked 1e-12 numerical boundary-contact tolerance.',
      confirmedOriginalInputWitness:witness,
      fixtureValidation:{pass:true,tests:12,zooms:[0,1,2,3,4,5,6],tilesPerIndependentRun:5461,runs:2,checks:['exact shared/T-junction noding','country/administrative/coast classes','symmetric adjacency','hole coastline retention','tiny gap rejection','ambiguous side rejection','caps','PBF canonical feature ID decoding','all artifact hashes/byte lengths','byte-identical replay','tamper rejection','build-only/public separation'],scope:'Test fixtures only; not production readiness.'}},
    '14-8':{status:'blocked',reason:'A valid production catalog is required before real V2-to-V3 migration, final root comparison or freeze. The 14-7 hard gate failed.',
      productionCatalogRegeneration:'attempted twice; both stop at the same source boundary gate',actualCatalogMigrationDryRun:'not run',
      mappingVerification:'not run',ownerControllerColorVerification:'not run on a production catalog',productionRoots:null,frozenCatalogVersion:null,freezeCompleted:false},
  },
  baseline:{startedAt:baseline.startedAt,startHead:baseline.startHead??baseline.head,currentHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),preExistingDirtyStatus:baseline.status,preservedFiles:preserved},
  changes:{addedFiles:changedFiles,checkpoint:'reports/prompt14/14-08-immutable-catalog-checkpoint.json',modifiedPreExistingFiles:[],productionCutover:false},
  sourceLock:{path:'data/source-locks/prompt14-derived-game-input-lock.json',sha256:digest(fs.readFileSync('data/source-locks/prompt14-derived-game-input-lock.json')),validation:inputs.lockValidation,
    verifiedFileCount:inputs.lock.lineageInputs.length+inputs.lock.artifacts.length+1,sourceVersion:inputs.lock.sourceVersion,license:inputs.lock.license,attribution:inputs.lock.attribution,
    prerequisiteReports:['reports/prompt14/14-02-source-generation-delivery-decision.json','reports/prompt14/14-05-schema-migration-checkpoint.json']},
  checks:[
    check(`node scripts/generate-prompt14-atoms.mjs ${first}`,0,'4231 atoms / 8156 components / 1272489 vertices; full 247-country validity and approved area coverage pass'),
    check(`node scripts/generate-prompt14-atoms.mjs ${second}`,0,'Independent normalized artifact bytes match'),
    check('node --test scripts/prompt14-catalog-core.node-test.mjs scripts/prompt14-catalog-topology.node-test.mjs',0,'12 tests pass; includes two complete fixture tile builds z0..6'),
    check('node --max-old-space-size=8192 scripts/generate-prompt14-catalog.mjs .tmp/prompt14-catalog/catalog-first',1,'Expected source boundary hard gate failure; no production artifacts emitted'),
    check('node --max-old-space-size=8192 scripts/generate-prompt14-catalog.mjs .tmp/prompt14-catalog/catalog-second',1,'Same source boundary failure independently reproduced byte-identically'),
    check('node scripts/diagnose-prompt14-catalog-source.mjs',0,'Independent JSTS point-to-boundary check confirms witness in original locked source bytes'),
    check('npx.cmd tsc --noEmit',0,'Typecheck passes'),
    check('npx.cmd eslint scripts/prompt14-catalog-*.mjs scripts/generate-prompt14-atoms.mjs scripts/generate-prompt14-catalog.mjs scripts/diagnose-prompt14-catalog-*.mjs scripts/write-prompt14-catalog-checkpoint.mjs',0,'New generator/test/diagnostic scripts lint clean'),
    check('git diff --check',0,'Whitespace checks pass'),
    check('node scripts/write-prompt14-catalog-checkpoint.mjs',0,'Byte comparisons, all 20 source-lock connections and all pre-existing dirty file hashes verified'),
  ],
  limitations:['Existing area-equality tolerance can admit a narrow gap without providing a complete boundary pairing certificate.','No production geometry/topology/render root or version was fabricated or frozen.','Actual migration and map smoke cannot be substituted by fixture success.','No browser/runtime schema cutover or public catalog publication occurred.'],
  next:{task:'14-2',action:'Revisit the shared P0/P1 alignment/selection policy with the recorded source witness. Generate a coherent full boundary arrangement, preserve all source identities/components/holes or explicitly document eligible whole-country fallback, and revalidate/relock source inputs. Add complete boundary continuity certification beside area totals. Then rerun 14-6 through 14-8 and obtain REVIEW C before 14-9.',
    prohibitedShortcuts:['increase the coverage/contact tolerance to hide the mismatch','snap or round locked geometry in 14-6/14-7','label unmatched interior lines as coast','drop source components or merge source identities to fit caps','publish an invalid catalog or perform a production migration'],resumeRequires:'Revalidated source decision and matching locked bytes; successful full production boundary gate.'},
};
fs.mkdirSync('reports/prompt14',{recursive:true});fs.writeFileSync('reports/prompt14/14-08-immutable-catalog-checkpoint.json',`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({status:report.status,stages:Object.fromEntries(Object.entries(report.stages).map(([k,v])=>[k,v.status])),preExistingFilesPreserved:preserved.length,sourceLockFilesVerified:report.sourceLock.verifiedFileCount,nextTask:report.next.task}));
