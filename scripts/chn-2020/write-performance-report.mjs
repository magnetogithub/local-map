import fs from 'node:fs';
import {createHash} from 'node:crypto';

const root='reports/chn-perf-20261030',read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const pin=p=>{const b=fs.readFileSync(p);return{path:p,sha256:createHash('sha256').update(b).digest('hex'),byteLength:b.length};};
const requireProof=(value,message)=>{if(!value)throw Error(message);};
const baseline=read(`${root}/baseline-interaction.json`),optimized=read(`${root}/optimized-interaction.json`);
const visual=read(`${root}/visual-comparison.json`),play=read(`${root}/browser-play/verification.json`);
const beforePlay=read('reports/chn-2020/browser-play-candidate/verification.json');
const build=read(`${root}/build-summary.json`),cleanup=read(`${root}/qa-cleanup.json`),preservation=read(`${root}/user-game-checkpoint.json`);
const unlocked=read(`${root}/user-game-unlocked.json`),boot=read(`${root}/final-boot.json`);
const pointer=pin('data/runtime/operational-catalog/current.json');
for(const r of [baseline,optimized,visual,play,build,cleanup,preservation])requireProof(r.pass===true,'REQUIRED_PERFORMANCE_PROOF_FAILED');
requireProof(unlocked.pass&&unlocked.mutationsLocked===false&&boot.pass&&boot.catalogVersion===optimized.catalogVersion,'NORMAL_APP_OR_GAME_CONTINUITY_FAILED');
requireProof(baseline.pointer.sha256===pointer.sha256&&optimized.pointer.sha256===pointer.sha256,'GAME_CATALOG_CHANGED');
requireProof(baseline.code[0].sha256===optimized.code[0].sha256,'BENCHMARK_WORKFLOW_CHANGED');
requireProof(JSON.stringify(baseline.conditions.viewport)===JSON.stringify(optimized.conditions.viewport)&&baseline.hardware.webgl.renderer===optimized.hardware.webgl.renderer,'MEASUREMENT_CONDITIONS_CHANGED');
for(const artifact of optimized.code){const actual=pin(artifact.path);requireProof(actual.sha256===artifact.sha256&&actual.byteLength===artifact.byteLength,`MEASURED_CODE_CHANGED:${artifact.path}`);}
requireProof(optimized.fullChinaRequests.length===0&&optimized.stableScope.sameCellIds&&optimized.stableScope.sameEdgeIds&&optimized.stableScope.sourceWritesBefore===optimized.stableScope.sourceWritesAfter,'UNBOUNDED_OR_REPEATED_EXACT_DETAIL');
requireProof(play.turns.length===2&&play.turns.every(t=>t.changedCellIds.length&&t.ownershipPreserved&&t.currentControlAdjacency&&t.front.sourceIds.count&&t.front.renderedIds.count&&t.areaKm2<=2800),'REAL_UI_OCCUPATION_REGRESSION');
requireProof(play.conditions.externalAiCalls===0&&play.externalRequests.length===0,'EXTERNAL_AI_OR_NETWORK_CALL');
const phases=optimized.phases.map(after=>{const before=baseline.phases.find(p=>p.name===after.name);requireProof(before,'MISSING_BASELINE_PHASE');return{name:after.name,before:{durationMs:before.durationMs,frameP95Ms:before.frames.p95Ms,longTaskMs:before.longTasks.totalWithinPhaseMs,jsHeapAfter:before.heapAfter?.usedJSHeapSize},after:{durationMs:after.durationMs,frameP95Ms:after.frames.p95Ms,longTaskMs:after.longTasks.totalWithinPhaseMs,jsHeapAfter:after.heapAfter?.usedJSHeapSize},durationRatio:before.durationMs/after.durationMs,frameP95Ratio:before.frames.p95Ms/after.frames.p95Ms};});
const report={schemaVersion:'chn-runtime-performance-fix-v1',pass:true,createdAt:new Date().toISOString(),timezone:'Asia/Seoul',url:'http://127.0.0.1:3002',catalogVersion:optimized.catalogVersion,
  evidence:Object.fromEntries(['baseline-interaction.json','optimized-interaction.json','visual-comparison.json','browser-play/verification.json','build-summary.json','qa-cleanup.json','user-game-checkpoint.json'].map(p=>[p,pin(`${root}/${p}`)])),
  activePointer:pointer,catalogChanged:false,geometryTopologyAndMilitaryRulesChanged:false,existingSessionsCheckpointed:preservation.sessionCount,
  changes:['Compose occupation, hover and selection tints in one fill pass instead of four. The eight flag combinations retain the original ordered RGB alpha composition.',
    'Ordinary country selection uses the already verified vector partition. Optional exact inspection loads only complete viewport cells and their incident edges in debug mode at zoom 7 or above.',
    'Debounce settled viewport requests; abort obsolete camera/selection work; skip identical cell/edge source publication and state replay.',
    'Bound private parsed cell/edge caches; memoize successful immutable PBF indexing without removing response digest validation.',
    'Avoid duplicate hover callbacks and heavy glyph-source retiling on zoom. Retain exact fractional label thresholds and point collision behavior; numeric source-local IDs survive the real renderer worker.'],
  conditions:{...optimized.conditions,hardware:optimized.hardware,limitation:'One paired synthetic trajectory per final code version, with HTTP cache disabled and OS/server caches retained. SwiftShader is software rendering; these absolute frame intervals are not a hardware-GPU FPS guarantee.'},
  phases,fullChinaRequests:{before:baseline.fullChinaRequests.length,after:optimized.fullChinaRequests.length},stableViewportReuse:optimized.stableScope,
  visual:{pass:true,labelPixelComparison:visual.regions,screenshot:pin(`${root}/optimized-china.png`),review:'Root inspected the final screenshot; country names, selection tint, coast and ordinary hidden micro lines remain visible as intended.'},
  actualUiTurns:play.turns.map((t,i)=>({condition:t.condition,changedCells:t.changedCellIds.length,areaKm2:t.areaKm2,ownerPreserved:t.ownershipPreserved,currentControlAdjacency:t.currentControlAdjacency,beforeCommitMs:beforePlay.turns[i].committedMs,commitMs:t.committedMs,beforeRenderedMs:beforePlay.turns[i].renderedMs,renderedMs:t.renderedMs,goldFrontFeatures:t.front.renderedIds.count})),
  build,sourceCode:[...optimized.code,pin('src/lib/map/operational-fill-paint.ts')],
  limits:['Global software-renderer frame time is still substantial. No constant 60 FPS claim is made.',
    'The first enlarged debug viewport can still decode several national topology shards from the immutable catalog. It is excluded from ordinary selection and retained results make identical viewport queries warm.',
    'First-turn UI/compile latency did not improve consistently; the measured first turn remains about 1.5 seconds. External AI inference was not invoked or benchmarked.',
    'Administrative source vintage, unresolved macro parents, large western county units and documented residual geometry retain the previous implementation limits.'],
  externalAiCalls:0,remoteDeployment:false,push:false};
report.gameContinuity={unlocked:pin(`${root}/user-game-unlocked.json`),finalBoot:pin(`${root}/final-boot.json`),catalogUnchanged:true,newGameRequired:false};
fs.writeFileSync(`${root}/performance-report.json`,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({pass:true,url:report.url,catalogChanged:false,phases:phases.length,report:`${root}/performance-report.json`}));
