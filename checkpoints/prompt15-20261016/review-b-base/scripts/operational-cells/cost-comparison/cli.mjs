import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {gzipSync,gunzipSync} from 'node:zlib';
import {pinFile,loadSourceSamples} from '../source-samples.mjs';
import {policyIdentity} from '../policy-validation.mjs';
import {MODEL_VERSION,sourceAreas,summarizeCosts,jsonBytes,hash,validateGenerationEvidence} from './analysis.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),reports=path.join(root,'.reports');
const reportPath=p=>{const result=path.resolve(root,p),rel=path.relative(reports,result);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error('CANDIDATE_REPORT_REQUIRED');return result;};
const out=reportPath(process.argv[2]),configFile=reportPath(process.argv[3]);
if(fs.existsSync(out))throw new Error('NEW_CANDIDATE_REPORT_REQUIRED');
fs.mkdirSync(out,{recursive:true});
if(path.relative(fs.realpathSync(reports),fs.realpathSync(out)).startsWith('..'))throw new Error('REPORT_SYMLINK_ESCAPE');
const config=JSON.parse(fs.readFileSync(configFile));
const checked=p=>{const actual=pinFile(p.path);if(actual.sha256!==p.sha256||actual.byteLength!==p.byteLength)throw new Error('INPUT_PIN_MISMATCH: '+p.path);return p.path;};
const contextPath=checked(config.contextIdentity),context=JSON.parse(fs.readFileSync(contextPath));
if(path.resolve(context.candidateRoot)!==root||context.taskId!=='15-16')throw new Error('CANDIDATE_CONTEXT_MISMATCH');
for(const p of config.inputs)checked(p);
for(const p of config.verdicts)if(JSON.parse(fs.readFileSync(checked(p))).verdict!=='pass')throw new Error('DEPENDENCY_NOT_PASSED');
for(const p of config.preservedSource){if(pinFile(path.join(root,p)).sha256!==context.dirtyInventory.currentSource[p])throw new Error('SHARED_SOURCE_CHANGED: '+p);}
for(const d of context.dependencies){const p=pinFile(path.join(root,d.logicalPath));if(p.sha256!==d.identity.sha256||p.byteLength!==d.identity.byteLength)throw new Error('DEPENDENCY_PIN_CHANGED');}
const rawPath=path.join(root,'data/raw/ne_10m_admin_1_states_provinces.geojson'),lockPath=path.join(root,'data/source-locks/prompt14-derived-game-input-lock.json');
const rawPin=pinFile(rawPath),lock=JSON.parse(fs.readFileSync(lockPath)),expected=lock.lineageInputs.find(p=>p.repositoryPath==='data/raw/ne_10m_admin_1_states_provinces.geojson');
if(rawPin.sha256!==expected.sha256||rawPin.byteLength!==expected.byteLength)throw new Error('SOURCE_PIN_CHANGED');
const own=['analysis.mjs','worker.mjs','cli.mjs','price-report.mjs','README.md'].map(p=>pinFile(path.join(root,'scripts/operational-cells/cost-comparison',p)));
const inputs=[config.contextIdentity,pinFile(configFile),...config.inputs,...config.verdicts,...config.preservedSource.map(p=>pinFile(path.join(root,p))),rawPin,pinFile(lockPath),
  ...context.dependencies.map(d=>pinFile(path.join(root,d.logicalPath))),...['polygon-clipping','jsts','zod'].map(p=>pinFile(path.join(root,'node_modules',p,'package.json'))),...own];
const write=(name,value,gzip=false)=>fs.writeFileSync(path.join(out,name),gzip?gzipSync(jsonBytes(value)):JSON.stringify(value,null,2),{flag:'wx'});
const bundle=JSON.parse(gunzipSync(fs.readFileSync(checked(config.experiments)))),fixtureFile=checked(config.identityFixture);
if(bundle.cases.length!==36||bundle.cases.some(c=>c.sample.fullParents||c.sample.name.endsWith('-bounded-chart')||!c.measurement.physical.completeParentCoverage))throw new Error('COMPLETE_REPRESENTATIVE_INPUTS_REQUIRED');
fs.copyFileSync(config.experiments.path,path.join(out,'representative-inputs.json.gz'),fs.constants.COPYFILE_EXCL);
fs.copyFileSync(fixtureFile,path.join(out,'identity-fixture.json'),fs.constants.COPYFILE_EXCL);
const generationParents=Object.fromEntries(loadSourceSamples(root).samples.map(s=>[s.name,s.parents]));write('generation-parents.json',generationParents);
const generationEvidence={version:1,taskId:'15-16',sourceReport:config.experiments,generationRerun:false,
  reason:'REVIEW B-2 forbids rerunning unchanged failed generation inputs. Current 15-14 actual times and cumulative RSS are pinned; a past unit PASS is not measurement evidence.',
  rows:bundle.cases.map(r=>({sample:r.sample.name,candidate:r.result.candidate,...validateGenerationEvidence(r)}))};
write('generation-evidence.json',generationEvidence);
const cases=[],commands=[],started=performance.now();
for(const [index,original]of bundle.cases.entries()){
  const record=generationParents[original.sample.name]?{...original,generationParents:generationParents[original.sample.name]}:original;
  const args=['--expose-gc','--max-old-space-size=1536',path.join(root,'scripts/operational-cells/cost-comparison/worker.mjs'),path.join(out,'identity-fixture.json'),path.join(out,'generation-evidence.json'),String(index)];
  const run=spawnSync(process.execPath,args,{cwd:root,input:JSON.stringify(record),encoding:'utf8',timeout:180000,maxBuffer:256*1024,windowsHide:true});
  commands.push({command:[process.execPath,...args],stdin:{sample:record.sample.name,candidate:record.result.candidate,sha256:hash(jsonBytes(record))},generationRerun:false,exitCode:run.status,error:run.error?.message??null});
  if(run.status!==0){write('commands.json',{version:1,commands});write('failure.json',{index,status:run.status,error:run.error?.message,stderr:run.stderr?.slice(0,256*1024)});throw new Error('BOUNDED_BENCHMARK_FAILED: '+index);}
  cases.push(JSON.parse(run.stdout));
  process.stdout.write(JSON.stringify({case:index+1,sample:record.sample.name,candidate:record.result.candidate,generationMs:Math.round(cases.at(-1).timings.generationMs)})+'\n');
}
const areas=sourceAreas(JSON.parse(fs.readFileSync(rawPath))),comparison=summarizeCosts(cases,areas);
const summary={version:1,taskId:'15-16',modelVersion:MODEL_VERSION,candidateRoot:root,policyIdentity,
  environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,logicalCPUs:os.cpus().length},elapsedMs:performance.now()-started,measuredCases:cases.length,comparison,
  scope:'Bounded representative offline cost experiments using complete parents. No full-world generation, production tool, migration, browser or E2E prerequisite.',
  worldGenerationApproved:false,policySelected:false,runtimeCapChanged:false,
  methodology:{generation:'Current approved 15-14 actual generation/noding/audit times and output hashes, not prior unit PASS. Unchanged failed generation inputs are not rerun. Independent current-candidate encoding/decode subprocess per case, 180-second deadline and 1.5GiB old-space.',
    bytes:'Actual independently decodable Float64/Uint32 arrays, 32-byte fingerprints, boundary flags, three membership CSR indexes, full parent/provenance dictionary, ordinal directory, source trace and shard index, plus gzip. Source geometry not quantized or simplified.',
    identity:'One real 15-15 identity/provenance template with shared immutable parent dictionary; 32-byte cell fingerprint storage already counted in catalog. Sample parents remain sample-only, never production migration evidence.',
    extrapolation:'Actual all-source ADM1 area/perimeter/components/vertices/features; maximal observed boundary residual coefficient after 5km interior area term, across ALL 12 samples. Actual source-complexity scaling and explicit codec layout estimate bytes. These empirical scenarios are not certified global upper bounds; homogeneous tiny-island density is retained as a separate stress case.',
    memory:'Maximum of current 15-14 cumulative OS peak RSS and fresh encoding-process RSS upper-bounds JS heap; reported endpoints follow generation/measurement/packing, not exact generation peaks. World generation memory unproven: streaming independent shards and a resident global shard directory are an explicit estimate assumption.',
    decodeRender:'Measured Node typed-array/JSON decode and complete-sample Float64 position/Uint32 edge staging. Initial-view estimate decodes one largest <=512-cell shard plus directory/provenance, with actual gzip transfer and extrapolated global directory. Browser allocation scenario reserves twice decoded shard/index bytes plus shard staging, not the offline generator RSS. Excludes GPU, triangulation, browser/UI/network latency; no production delivery or frame-time claim.'},
  deferredMetrics:['Actual world build counts/bytes/peak heap/time and protected previous-parent refinement','Production spatial shards/LOD/MVT delivery and browser/GPU performance','Runtime lookup/authority/commit/history/provider budgets'],
  nextCheckpoint:'15-17 owns candidate policy selection. Assess actual geometry and cost failures without changing fixed thresholds. No automatic world rollout, cap change, publication or cutover.',
  verification:'Prepared for the controller-selected Vitest suite; no task PASS or whole-REVIEW approval.'};
write('measurements.json.gz',{version:1,taskId:'15-16',cases},true);write('source-area-scenarios.json',areas);write('summary.json',summary);write('commands.json',{version:1,commands});
for(const p of inputs)checked(p);
inputs.push(...['representative-inputs.json.gz','identity-fixture.json','generation-parents.json','generation-evidence.json'].map(n=>pinFile(path.join(out,n))));
write('input-manifest.json',{version:1,inputs:[...new Map(inputs.map(p=>[p.path,p])).values()]});
process.stdout.write(JSON.stringify({taskId:'15-16',measuredCases:cases.length,out,verification:'pending-controller-vitest'})+'\n');
