import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {fileIdentity,readJSON} from './prompt15-cell-core.mjs';
import {jsonBytes} from './prompt14-catalog-core.mjs';
const dir='reports/prompt15';
const write=(name,value)=>{const p=`${dir}/${name}`;fs.writeFileSync(p,jsonBytes(value));return fileIdentity(p);};
const checks=[];
const executionInputs=fs.readdirSync('src',{recursive:true}).filter(n=>fs.statSync(path.join('src',n)).isFile()).map(n=>fileIdentity(path.join('src',n))).concat(['package.json','package-lock.json','tsconfig.json','next.config.ts','scripts/verify-prompt15-cells.mjs'].map(fileIdentity));
const priorPath=`${dir}/15-03-first-validation-attempt.json`;
const prior=process.argv.includes('--reuse-regression')?readJSON(priorPath):null;
for(const args of [
 ['--test','scripts/prompt15-cells.node-test.mjs'],
 ['node_modules/vitest/vitest.mjs','run','src/lib/simulation/catalog-border-lookup.test.ts','src/lib/simulation/catalog-region-integration.test.ts','src/lib/simulation/server/provider-route.test.ts'],
 ['node_modules/typescript/bin/tsc','--noEmit'],
 ['node_modules/eslint/bin/eslint.js','.'],
]){
 if(prior&&args[0]==='node_modules/vitest/vitest.mjs'){
  const evidence=prior.checks.find(c=>c.command===`node ${args.join(' ')}`);
  if(evidence?.status!=='pass')throw Error('No passing same-turn regression evidence');
  checks.push({...evidence,evidenceReuse:fileIdentity(priorPath),scope:'Reuse same-turn regression execution; no application files changed between runs. Offline validator/build fixture corrected.'});
  continue;
 }
 console.log(`Checking node ${args.join(' ')}`);
 const start=performance.now(),r=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:32*1024**2});
 checks.push({command:`node ${args.join(' ')}`,status:r.status===0?'pass':'fail',exitCode:r.status,elapsedMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr,error:r.error?.message??null});
}
const scratch=path.resolve('.tmp/prompt15-cell-build');
if(!scratch.startsWith(path.resolve('.tmp')+path.sep)||fs.existsSync(scratch))throw Error('Build scratch is unsafe or already exists');
fs.mkdirSync(scratch,{recursive:true});
const links=['node_modules','data','public','scripts','reports'];
try{
 fs.cpSync('src',path.join(scratch,'src'),{recursive:true});
 for(const name of ['package.json','package-lock.json','tsconfig.json','next-env.d.ts','next.config.ts','postcss.config.mjs','vitest.config.ts','vitest.setup.ts'])if(fs.existsSync(name))fs.copyFileSync(name,path.join(scratch,name));
 for(const name of links)fs.symlinkSync(path.resolve(name),path.join(scratch,name),'junction');
 const args=['node_modules/next/dist/bin/next','build',scratch,'--webpack'];
 console.log('Checking isolated production build');
 const start=performance.now(),r=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:32*1024**2});
 checks.push({command:`node ${args.join(' ')}`,status:r.status===0?'pass':'fail',exitCode:r.status,elapsedMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr,error:r.error?.message??null,scope:'Fresh copied current application sources; shared immutable dependencies/data/public. No application code changed in 15-3.'});
}finally{
 for(const name of links){const p=path.join(scratch,name);if(fs.existsSync(p)){if(!fs.lstatSync(p).isSymbolicLink())throw Error(`Unexpected non-link: ${p}`);fs.rmdirSync(p);}}
 if(path.resolve(scratch)!==path.resolve('.tmp/prompt15-cell-build'))throw Error('Unsafe cleanup');
 fs.rmSync(scratch,{recursive:true});
}
for(const a of executionInputs){const b=fileIdentity(a.path);if(a.sha256!==b.sha256)throw Error(`Inputs changed during validation: ${a.path}`);}
write('15-03-validation-inputs.json',executionInputs);
const decision=readJSON(`${dir}/15-03-policy-decision.json`);
const review=readJSON(`${dir}/15-REVIEW-B.json`);
const selected=decision.comparisons.find(x=>x.candidate.id===decision.selectedCandidate);
if(!fs.readFileSync(`${dir}/15-03-predeclared-policy.json`).equals(jsonBytes(P)))throw Error('Predeclared thresholds differ');
for(const a of [review.checkpoint,...decision.inputs,...decision.independence.flatMap(x=>[x.first,x.second])]){const b=fileIdentity(a.path);if(a.sha256!==b.sha256||a.byteLength!==b.byteLength)throw Error(`Stale evidence ${a.path}`);}
const samples=P.representativeCountries.map(c=>readJSON(`${dir}/cell-experiments/${decision.selectedCandidate}/${c}/first/summary.json`));
const membershipLimits=samples.map(s=>({country:s.countryId,maximumParentCells:Math.max(...readJSON(`${dir}/cell-experiments/${decision.selectedCandidate}/${s.countryId}/first/membership.json`).map(p=>p.cellCount))}));
const contracts=write('15-03-downstream-contract.json',{
 status:'policy-fixed-implementation-deferred',membershipLimits,
 administrativeMembership:'Complete immutable membership has no per-action 512 limit. 15-5 must use bounded pages or a compact uint32 ordinal/offset index with full-union validation; never truncate a parent to fit the old region record.',
 actionMembership:{maximumCells:P.lookupCap,overflow:P.capOverflow},
 renderIds:'Positive numeric PBF feature IDs map bijectively to fixed immutable catalog-order ordinals. Canonical territory SHA IDs stay in metadata. Explicit promoteId:null and generateId:false. Validate ordinal mapping across metadata, topology, tiles and migration before cutover.',
 stableIds:P.stableIds,provenance:P.provenance,
 sourceAdapter:'Legacy topology generation uses the P1 inputRole adapter internally; syntheticOperational cells remain distinct from real administrative identities. It is not a production catalog authoring contract.',
 provider:'Measured near JSON bytes are a transport proxy only. Actual tokenizer, total tool-loop budget and strict submit enforcement must be measured in 15-5. Cell and byte caps do not prove token budgets.',
 migration:'15-4 must include old territory boundaries as protected overlay and common refinement. Per-parent sampling here does not prove global cross-country pairing or old-to-new migration coverage.',
 exceptions:samples.map(s=>({country:s.countryId,tinySourceComponents:s.metrics.sourceTinyParentComponents,sliverCount:s.metrics.sliverCount,measurementArtifact:fileIdentity(`${dir}/cell-experiments/${decision.selectedCandidate}/${s.countryId}/first/cell-measurements.json`)})),
});
const validation=write('15-03-validation.json',{status:checks.every(x=>x.status==='pass')?'pass':'fail',checks,tools:{node:process.version,next:readJSON('node_modules/next/package.json').version,typescript:readJSON('node_modules/typescript/package.json').version,vitest:readJSON('node_modules/vitest/package.json').version},inputs:[fileIdentity('scripts/verify-prompt15-cells.mjs'),fileIdentity('scripts/prompt15-cells.node-test.mjs'),...decision.inputs],outputs:[review.checkpoint,contracts,...decision.independence.flatMap(x=>[x.first,x.second])],scope:'15-3 offline policy experiment. Live API, browser E2E, global generation and production cutover deferred.'});
review.validation=validation;review.status=decision.status==='pass'&&checks.every(x=>x.status==='pass')?'pass':'fail';review.resumeAt=review.status==='pass'?'15-4':'15-3';
write('15-REVIEW-B.json',review);
const fmt=n=>Number(n).toLocaleString('en-US',{maximumFractionDigits:2});
const rows=samples.map(s=>`| ${s.countryId} | ${s.metrics.parentCount} | ${s.metrics.cellCount} | ${fmt(s.maxBorderDiameterKm)} | ${fmt(s.metrics.maxDiameterKm)} | ${fmt(s.render.totalBytes/1024)} |`).join('\n');
const costRows=Object.entries(selected.worldProjection.costs).map(([k,v])=>`| ${k} | ${fmt(v)} | ${fmt(P.budgets[k])} |`).join('\n');
const scenarios=samples.filter(s=>['PRK','KOR','KEN','TZA','KAZ'].includes(s.countryId)).flatMap(s=>s.behavior.scenarios.map(x=>({country:s.countryId,kind:x.kind,neighbor:x.neighbor??null,parentKey:x.parentKey??null,near:{count:x.ranges.near.count,areaKm2:x.ranges.near.areaKm2,parentAreaFractions:x.ranges.near.parentAreaFractions},limited:{count:x.ranges.limited.count,tiers:x.ranges.limited.tiers,status:x.ranges.limited.status},deeper:{count:x.ranges.deeper.count,status:x.ranges.deeper.status},second:x.second?{count:x.second.count,disjoint:x.firstSecondDisjoint,currentFront:x.secondTouchesCurrentFront}:null})));
write('15-03-frontier-examples.json',scenarios);
fs.writeFileSync(`${dir}/15-03-README.md`,[
 '# Prompt 15 — 15-3 실행 결과','',
 `REVIEW B: **${review.status}**. 접경 12km / 내륙 24km 격자 후보 adaptive-12-24를 선택했다. 11개 국가에서 실제 source polygon을 분할하고, 선택 후보를 별도 프로세스에서 두 번 생성했다. geometry·topology·membership·measurements bytes와 모든 PBF 타일 SHA/길이 root가 일치했다. 전 세계 생성·runtime 적용은 다음 단계다.`,'',
 '정책과 통과 기준은 첫 실험 전에 [고정](15-03-predeclared-policy.json)했다. 접경은 지름 19km·면적 150km² 이하, 내륙은 36km·600km² 이하이다. 대표 진격 깊이 W=120km에 대한 지름 비율은 0.3 이하이고, limited는 최소 3단계의 graph 깊이를 요구한다. near 깊이/폭은 36/36km, limited는 120/96km, deeper는 240/192km이다. 최대 면적은 각각 2,800/22,000/80,000km²이다. 8,000km² 이상 부모에서 near 점령은 35% 이하, 잔여는 65% 이상이어야 한다. cap 512 초과는 요청 전체를 거절하며 목록을 잘라 성공시키지 않는다.','',
 '실제 국경 선분 주변 48km의 보수적 envelope에 닿는 24km 상자를 12km로 세분한다. 해안선 자체는 세분 조건이 아니다. 고위도에서는 위도 띠 내 최대 cos(latitude)로 경도 개수를 정하며 날짜변경선과 극지 행을 명시한다. 물리 면적은 authalic sphere로 계산한다. 측량 수준의 타원체 계산이 아니며 graph 거리·방향 corridor도 정확한 geodesic 점령 띠는 아니다.','',
 '| 국가 | 보존 부모 수 | cell 수 | 접경 최대 지름 km | 전체 최대 지름 km | PBF 총 KiB |',
 '|---|---:|---:|---:|---:|---:|',rows,'',
 'SVN은 복원된 193개 identity를 그대로 부모로 사용한다. 다른 대륙의 KEN/TZA, 큰 내륙 KAZ, 고위도 FIN, 날짜변경선·섬 FJI, 작은 국가 LUX, HRV/ZAF도 포함했다. 모든 표본은 부모/component 보존·geometry·coverage·양의 길이 adjacency 기준을 통과했다. 점 접촉은 adjacency가 아니다. sliver는 버리지 않고 목록과 면적을 보존했다. tiny 예외는 source component 면적 1km²·지름 8km 이하로만 정의하고 국가명 예외를 두지 않았다. [예외 목록과 계약](15-03-downstream-contract.json)의 각 measurement 파일에서 개별 cell을 확인할 수 있다.','',
 'uniform-12는 표본 해상도/행동을 통과했지만 전 세계 비용 추정이 예산을 넘었다(약 155만 cell). uniform-24는 비용을 통과했지만 10개 국가에서 접경 지름/면적 기준을 실패했다. 선택 후보의 다음 값은 **표본 기반 전 세계 추정**이며 실제 전 세계 bytes나 브라우저 초기 heap 측정값이 아니다.','',
 '| 비용 | 전 세계 추정 | 사전 예산 |','|---|---:|---:|',costRows,'',
 '추정은 물리 면적·부모 둘레·국경 세분 띠의 보수적 식과 표본 밀도 외삽 중 큰 값을 사용한다. bytes/vertices/edges는 관측된 최악의 cell당 비용을 적용했다. 새 Node 프로세스에서 현재 state/metadata 형태를 파싱·보존한 heap proxy에 client 2배/server 3배 여유를 적용했다. client 약 939MiB로 예산 여유가 작다. 전 세계 실제 생성과 runtime projection/validation/브라우저에서 비용이 증가하면 정책을 다시 검토해야 한다.','',
 '현재 전선에서 첫 near·두 번째 near를 실제 양의 길이 graph로 선택했다. KOR/PRK를 비롯한 각 표본의 모든 인접 국가 방향을 검사했다. 큰 부모 안의 점령/미점령 공존과 두 번째 선택의 분리·현재 전선 접촉을 확인했다. [요약 예시](15-03-frontier-examples.json) 및 국가별 summary의 실제 ID 목록이 근거다. 이것은 offline geometry/graph 실험이며 gameplay screenshot이나 production tool/API 성공 증거는 아니다.','',
 'ID는 정책·후보·고정 source 부모/hash·canonical geometry로 만든 SHA-256이다. owner/controller·locale·실행 순서에 의존하지 않는다. PBF에는 고정 catalog 순서에 연결된 정수 ID를 넣어 긴 SHA 반복 비용을 줄였다. 15-4/15-5에서 metadata·topology·tile 간 ordinal 매핑 계약을 구현해야 한다. 행정 identity와 synthetic cell을 혼동하지 않는다. 기존 512개 region record 제한은 큰 부모의 전체 membership을 수용하지 못한다. 전체 membership용 compact index/페이지 계약과 per-action 512 cap을 별도로 구현해야 한다.','',
 '[검증 로그](15-03-validation.json): Node 물리/실제 접경/연속 전선/cap/독립 bytes 테스트, 관련 Vitest 회귀 테스트, TypeScript, 전체 ESLint, 격리된 새 production build를 실행했다. [REVIEW B](15-REVIEW-B.json)는 정책 결과뿐 아니라 이 검증의 상태도 반영한다. 모든 입력/output SHA와 byte length는 [정책 결정](15-03-policy-decision.json), 국가별 summary/render-index 및 execution JSON에 기록했다. 초기 실패는 implementation-attempt 파일과 초기 execution 기록에 남아 있다. 후속 graph 검증 및 Windows 상대 tile 경로 root 수정은 별도 [재검증](15-03-experiment-rechecks.json)에 기록했다. 실제 PBF bytes는 바뀌지 않았다.','',
 '재실행: `node scripts/audit-prompt15-cells.mjs first`, `node scripts/audit-prompt15-cells.mjs second adaptive-12-24`, `node scripts/recheck-prompt15-cell-experiments.mjs`, `node scripts/audit-prompt15-cells.mjs review`, `node scripts/verify-prompt15-cells.mjs`. first는 새 실험 시작 snapshot을 기록하므로 기존 결과와 provenance를 보존한 별도 작업 환경에서 재실행해야 한다.','',
 '재개 위치는 **15-4**다. 아직 미해결인 stage A의 12개 source-backed fallback 복구 차단 조건을 유지한다. 모든 국가의 복원 행정 경계와 기존 territory를 protected overlay로 공통 세분하고 실제 world bytes/coverage/topology/membership/tiles를 독립 생성해 검증해야 한다. 생산 catalog 변경·migration·tool-loop token 비용·live API·browser E2E·runtime 점령/undo/redo·cutover는 이번 단계에서 수행하지 않았다. 기존 source/catalog/reports와 작업 시작 시 수정된 application 파일의 hash는 보존 검사를 통과했다.','',
 ].join('\n'));
console.log(JSON.stringify({status:review.status,checks:checks.map(x=>({command:x.command,status:x.status})),resumeAt:review.resumeAt}));
if(review.status!=='pass')process.exitCode=1;
