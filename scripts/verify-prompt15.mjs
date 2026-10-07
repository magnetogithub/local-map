// Captures offline validation and checkpoint evidence. No production writes.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {digest,jsonBytes} from './prompt14-catalog-core.mjs';
const dir='reports/prompt15',read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const identity=p=>{const b=fs.readFileSync(p);return {path:p,sha256:digest(b),byteLength:b.length};};
const write=(name,data)=>{const p=`${dir}/${name}`;fs.writeFileSync(p,jsonBytes(data));return identity(p);};
const checks=[
 ['node-tests',['node','--test','scripts/prompt15-recovery.node-test.mjs']],
 ['vitest',['node','node_modules/vitest/vitest.mjs','run','scripts/prompt15-runtime-audit.test.ts','src/lib/simulation/catalog-border-lookup.test.ts','src/lib/simulation/catalog-region-integration.test.ts','src/lib/simulation/server/provider-route.test.ts']],
 ['type',['node','node_modules/typescript/bin/tsc','--noEmit']],
 ['lint',['node','node_modules/eslint/bin/eslint.js','.']],
];
const results=[];
for(const [name,command]of checks){
 console.log(`Verifying ${name}`);
 const start=performance.now(),r=spawnSync(process.execPath,command.slice(1),{encoding:'utf8',maxBuffer:32*1024*1024});
 results.push({name,command:command.join(' '),status:r.status===0?'pass':'fail',exitCode:r.status,elapsedMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr,error:r.error?.message??null});
}
const build=read(`${dir}/15-build-execution.json`);
if (build.inputs.some(a=>identity(a.path).sha256!==a.sha256||identity(a.path).byteLength!==a.byteLength)) throw Error('Build inputs changed: rerun isolated build');
results.push(build);
const outputs=['15-01-baseline.json','15-01-artifact-byte-audit.json','15-01-runtime-audit.json','15-02-recovery.json','15-02-svn-gap.geojson','candidates/SVN-first.json','candidates/SVN-second.json'];
const validation=write('15-validation.json',{status:results.every(c=>c.status==='pass')?'pass':'fail',tools:{node:process.version,next:read('node_modules/next/package.json').version,typescript:read('node_modules/typescript/package.json').version,vitest:read('node_modules/vitest/package.json').version},
 inputs:['src/app/api/simulation/turn/route.ts','src/lib/simulation/server/simulation-turn-handler.ts'].map(identity).concat(fs.readdirSync('scripts').filter(n=>n.startsWith('prompt15-')||n==='audit-prompt15.mjs'||n==='verify-prompt15.mjs').map(n=>identity(`scripts/${n}`))),outputs:outputs.map(n=>identity(`${dir}/${n}`)),checks:results,
 liveAPI:'Not executed in checkpoint A',browserE2E:'Not executed in checkpoint A; no runtime UI changes',scope:'15-1/15-2 only; no production cutover'});
const review=read(`${dir}/15-REVIEW-A.json`);
review.investigationStatus=Object.values(review.criteria).every(Boolean)?'pass':'fail';
review.validation=validation;
review.status=review.investigationStatus==='pass'&&results.every(r=>r.status==='pass')?'pass':'fail';
review.failureReasons=results.filter(r=>r.status!=='pass').map(r=>({check:r.name,reason:r.reason??r.stderr??r.stdout}));
review.resumeAt=review.status==='pass'?'15-3':'Resolve existing production build failure before completing REVIEW A; investigation outputs for 15-1/15-2 are complete';
review.evidence=outputs.filter(n=>!n.startsWith('candidates/')).map(n=>identity(`${dir}/${n}`));
write('15-REVIEW-A.json',review);
const baseline=read(`${dir}/15-01-baseline.json`),recovery=read(`${dir}/15-02-recovery.json`);
const rows=recovery.allFallbackRecoveryPlan.map(o=>`| ${o.countryId} | ${o.sourceIdentityCount} | ${o.status} | ${o.rolloutBlock?'차단':'원본 P0 예외 조사'} |`).join('\n');
const checksText=results.map(r=>`- ${r.name}: **${r.status}** (${r.command})`).join('\n');
fs.writeFileSync(`${dir}/README.md`,[
 '# Prompt 15 — 15-1 / 15-2 실행 결과','',
 `요청 범위 15-1/15-2의 감사와 복구 후보 검증을 완료했다. REVIEW A 상태는 ${review.status}다. Prompt 15 전체 완료나 production 배포를 의미하지 않는다.`,'',
 `247개 국가의 원본 행정 identity ${baseline.findings.sourceAdministrativeIdentities}개와 catalog territory ${baseline.findings.catalogTerritories}개를 대조했다. 원본 identity ${baseline.findings.lostAdministrativeIdentities}개가 catalog에서 소실됐다. 15개 fallback 중 P1 원본이 없는 CNM 1개와 원본을 배제한 14개를 구분했다. 행정구역 내부에 여러 territory가 있는 사례는 0개다.`, '',
 '실제 production border tool은 북한 접경의 강원도와 황해북도 전체 territory 2개를 반환했다. 이름·source identity·geometry·효과 대상은 `15-01-runtime-audit.json`과 `15-01-baseline.json`에서 확인할 수 있다.','',
 '슬로베니아의 고정 원본 193개 → P0-fallback 1개를 과거 입력 bytes와 실제 선택 함수로 재현했다. gap은 (16.295367, 46.524448), (16.310663, 46.530985), (16.301527, 46.527081)의 좁은 양의 면적 삼각형이다. source mismatch는 1e-12 이내의 부동소수점 동치가 아니다.','',
 '직접 원인은 분할 후 누적 면적을 고려하지 않은 작은 face 생략이다. 공유 경계로 분할된 두 face의 면적은 각각 약 1.298493e-9, 1.925507e-9 degrees²다. 각각은 원본 residual 수 1로 나눈 threshold 2.365767e-9 이하라 모두 버려지지만, 합 3.224000e-9는 국가 coverage tolerance를 넘는다. 최종 coverage 실패를 catch가 국가 전체 fallback으로 바꾼다. 실제 split 함수의 출력과 생략 판정은 `15-02-recovery.json`의 `cause.splitSkipProof`에 기록했다.','',
 '공통 arrangement와 원본 공유 경계 terminal의 좌우 source identity로 두 face를 보존한 슬로베니아 후보는 193개 identity, component/hole, 유효 geometry, coverage, topology, 연속 경계 변위, 기존 0.1% adjustment bound를 모두 통과했다. tolerance를 늘리지 않았다. 두 독립 Node 프로세스의 후보 전체 bytes가 동일하다. 후보는 배포 자산이 아니다.','',
 `복구 후보 gapArea는 ${recovery.recovery.coverage.gapArea}, 고정 tolerance는 ${recovery.recovery.coverage.tolerance} degrees²다. 덴마크 후보도 통과했다. 다른 fallback은 국가별 geometry와 검사 실패를 저장했으며, ${recovery.rolloutBlocks.length}개는 복구/예외 증명 전 rollout을 차단한다.`, '',
 '| 국가 | 고정 P1 identity | 후보 검증 | rollout |','|---|---:|---|---|',rows,'',
 'pass 후보도 15-4의 전 세계 공통 arrangement, 국가 간 경계, membership, 독립 생성, delivery gate를 추가로 통과해야 한다. blocked 후보는 면적/변위 상한 초과 또는 component/hole 차이의 실제 source geometry를 조사해야 한다. CNM에는 없는 행정 identity를 만들지 않는다. source 기반 예외가 입증되지 않은 다른 단일 identity 후보도 차단한다.','',
 '기존 source lock, 원본/derived polygon, frozen catalog와 게시 assets, 모든 기존 Prompt 14 보고서의 hash·byte length를 대조했고 보존했다. 신규 operational cell, runtime cutting, migration, production cutover는 이번 checkpoint 범위에 없다.','',
 '현재 catalog consumer는 행정 edge minzoom=4, 국가 경계/점령 전선은 별도 layer로 처리한다 (`src/lib/map/catalog-map-consumer.ts`). 현재 provider는 ordinary iteration 8, tool call 12, output 8000 tokens, timeout 120000ms, retry 1, submit 및 repair 슬롯 예약을 사용한다. region record/lookup/aggregate의 512 제한과 8 region reference 제한은 후속 mesh에서 다시 측정해야 한다.','',
 '검증 결과:', '',checksText,'',
 `기존 build 실패를 해결하기 위해 createSimulationTurnPost를 src/lib/simulation/server/simulation-turn-handler.ts로 옮겼다. route.ts는 허용된 runtime/POST만 export한다. 기존 provider route 테스트로 동작을 검증했다. 현재 소스의 격리 production build 상태는 ${build.status}다. 실행 결과와 입력/output hash는 15-build-execution.json에 기록했다. 과거 실패 증거 15-build-route-type.txt는 보존했다.`,'',
 '실제 API 요청 및 browser E2E는 실행하지 않았다. 현재 asset 크기·hash, offline 초기화 시간/메모리는 감사에 기록했다. browser render, 연속 진격과 부분 점령 성능/시각 증거는 15-7/15-8에서 수행해야 한다. 기존 Prompt 14의 과거 성공 보고서를 이번 검증 증거로 사용하지 않았다.','',
 '재실행: `node scripts/audit-prompt15.mjs baseline` → `node node_modules/vitest/vitest.mjs run scripts/prompt15-runtime-audit.test.ts` → `node scripts/audit-prompt15.mjs recovery` → `node scripts/verify-prompt15.mjs`. build 검증은 격리 workspace에서 따로 실행하고 실제 결과를 `15-build-execution.json`에 기록한다.','',
 `재개 위치: ${review.resumeAt}. 이번 요청은 REVIEW A까지다. 다음 구간은 15-3의 해상도/예산 실험이다. 전 세계 복구 차단 국가들은 15-4 이전에 해결해야 한다.`,'',
 ].join('\n'));
console.log(JSON.stringify({checkpointInvestigation:{'15-1':baseline.status,'15-2':recovery.status},review:review.status,checks:results.map(r=>({name:r.name,status:r.status}))}));
