import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import DistanceOp from 'jsts/org/locationtech/jts/operation/distance/DistanceOp.js';
import {polygons,normalizeGeometry,jsonBytes,digest} from './prompt14-catalog-core.mjs';
import {fileIdentity,readJSON} from './prompt15-cell-core.mjs';
const revision=process.argv[2]??'v2';
if(!/^v[1-9][0-9]*$/.test(revision))throw Error('Invalid revision');
const dir='reports/prompt15',prefix=`${dir}/world-preflight/${revision}`,reader=new GeoJSONReader();
const write=(name,value)=>{const p=`${dir}/${name}`;fs.writeFileSync(p,jsonBytes(value));return fileIdentity(p);};
const first=readJSON(`${prefix}/first/summary.json`),second=readJSON(`${prefix}/second/summary.json`);
const executionInputs=['scripts/review-prompt15-c.mjs','scripts/prompt15-world-preflight.node-test.mjs',...first.inputs.map(x=>x.path)].map(fileIdentity);
const checks=[];
for(const args of [['--test','scripts/prompt15-world-preflight.node-test.mjs'],['node_modules/eslint/bin/eslint.js','.'],['node_modules/typescript/bin/tsc','--noEmit']]){
 console.log(`Checking node ${args.join(' ')}`);const start=performance.now(),r=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:32*1024**2});
 checks.push({command:`node ${args.join(' ')}`,exitCode:r.status,status:r.status===0?'pass':'fail',elapsedMs:performance.now()-start,stdout:r.stdout,stderr:r.stderr,error:r.error?.message??null});
}
const hashFailures=[];
const verify=a=>{const b=fileIdentity(a.path);if(a.sha256!==b.sha256||a.byteLength!==b.byteLength)hashFailures.push(a.path);};
for(const run of [first,second])for(const a of [...run.inputs,...run.artifacts])verify(a);
for(const a of executionInputs)verify(a);
// The old build is reused only if EVERY recorded application/build input still
// matches its current bytes, and its captured build really returned exit code 0.
const previous=readJSON(`${dir}/15-03-validation.json`),previousInputs=readJSON(`${dir}/15-03-validation-inputs.json`);
const productionInputs=previousInputs.filter(x=>x.path.startsWith('src')||['package.json','package-lock.json','tsconfig.json','next.config.ts'].includes(x.path));
for(const a of productionInputs)verify(a);
const build=previous.checks.find(x=>x.command.includes('next/dist/bin/next build'));
checks.push({command:build.command,status:build.status,exitCode:build.exitCode,evidenceReuse:fileIdentity(`${dir}/15-03-validation.json`),inputEvidence:fileIdentity(`${dir}/15-03-validation-inputs.json`),verifiedProductionInputs:productionInputs.length,scope:'Previous checkpoint fresh production build, reused after current SHA/length verification of the full recorded application source tree and build config. No Next/application code changed in 15-4.'});
const normalized=x=>({...x,artifacts:x.artifacts.map(a=>({...a,path:a.path.replace(/\/(first|second)\//,'/<run>/')}))});
const summaryBytesEqual=jsonBytes(normalized(first)).equals(jsonBytes(normalized(second)));
const countryEvidence=first.artifacts.map(a=>{const b=second.artifacts.find(x=>x.path.split('/').at(-1)===a.path.split('/').at(-1));return {country:a.path.split('/').at(-1).slice(0,3),first:a,second:b,bytesEqual:!!b&&fs.readFileSync(a.path).equals(fs.readFileSync(b.path))};});
const raw=readJSON('data/derived/prompt14/shared-admin1-input.geojson'),p0=readJSON('data/derived/prompt14/shared-game-p0.geojson');
const contradictions=[];
for(const c of first.countries.filter(c=>c.completelyOutsideSourceComponents.length))for(const part of c.completelyOutsideSourceComponents){
 const source=raw.features.find(f=>String(f.properties.ne_id)===part.sourceId),envelope=p0.features.find(f=>f.properties.countryId===c.countryId);
 const geometry=normalizeGeometry({type:'Polygon',coordinates:polygons(source.geometry)[part.index]}),a=reader.read(geometry),b=reader.read(envelope.geometry);
 const intersection=OverlayOp.intersection(a,b),distance=DistanceOp.distance(a,b);
 contradictions.push({country:c.countryId,...part,sourceHashMatches:digest(jsonBytes(geometry))===part.hash,independentIntersectionAreaDegreesSquared:intersection.getArea(),independentSourceAreaDegreesSquared:a.getArea(),minimumSeparationDegrees:distance,
  provenDisjoint:intersection.getArea()===0&&a.getArea()>0&&distance>first.policy.numerical.maximumNumericalDisplacementDegrees,
  implication:'Any new cell confined to the fixed P0 has zero positive-area coverage of this pinned source component. A tiny-source exception permits keeping it unsplit, not removing it.'});
}
const independentRecheckPassed=summaryBytesEqual&&countryEvidence.every(c=>c.bytesEqual)&&contradictions.length>0&&contradictions.every(c=>c.sourceHashMatches&&c.provenDisjoint)&&!hashFailures.length;
const recheck=write('15-04-independent-recheck.json',{status:independentRecheckPassed?'pass':'fail',meaning:'Reproduces the input-gate failure; it does not approve a world catalog',summaryBytesEqual,countryEvidence,contradictions,hashFailures,inputs:executionInputs,command:`node scripts/review-prompt15-c.mjs ${revision}`,tools:{node:process.version,jsts:readJSON('node_modules/jsts/package.json').version}});
const validation=write('15-04-validation.json',{status:checks.every(x=>x.status==='pass')&&independentRecheckPassed?'pass':'fail',checks,independentRecheck:recheck,inputs:executionInputs,outputs:[fileIdentity(`${prefix}/first/summary.json`),fileIdentity(`${prefix}/second/summary.json`)],scope:'Validation of failure detection and fixed-input diagnostic evidence; no global mesh/runtime/API/E2E claims'});
const criteria={reviewB:readJSON(`${dir}/15-REVIEW-B.json`).status==='pass',svn193Preserved:first.countries.find(c=>c.countryId==='SVN').identities.pass&&first.countries.find(c=>c.countryId==='SVN').identities.sourceCount===193,
 allAdministrativeIdentitiesRestored:first.countries.every(c=>c.identities.pass),allRecoveryCountriesApproved:!first.blockedCountries.length,oldProtectedGeometryCovered:first.countries.every(c=>c.oldCoverage.pass),
 independentInputAudit:independentRecheckPassed,validation:checks.every(x=>x.status==='pass'),globalOperationalGeometryGenerated:false,globalTopologyValidated:false,globalMembershipValidated:false,actualWorldBudgetsValidated:false,independentCatalogAndRenderBytes:false};
const review=write('15-REVIEW-C.json',{review:'C',checkpoint:'15-4',status:'fail',criteria,predecessor:fileIdentity(`${dir}/15-REVIEW-B.json`),inputPreflight:[fileIdentity(`${prefix}/first/summary.json`),fileIdentity(`${prefix}/second/summary.json`)],independentRecheck:recheck,validation,
 failureReasons:[{kind:'source-recovery-gate',countries:first.blockedCountries,missingSourceIdentities:first.countries.reduce((n,c)=>n+c.identities.missing.length,0)},{kind:'fixed-envelope-vs-source-component-contradiction',count:contradictions.length,evidence:recheck}],
 skipped:[{task:'Global mesh/common topology/catalog/membership/render generation and world byte-budget measurement',reason:'Required restored administrative input gate fails. A whole-country fallback or deletion of disjoint source components would violate the requested generation invariants.'}],
 productionCutover:false,immutableCatalogCreated:false,resumeAt:'15-4 source restoration; do not advance to 15-5 or 15-6',requiredDecision:'No automatic policy relaxation. Resolve the recorded input contradictions within the fixed-P0/component-preservation contract, or explicitly revise that contract before generating an approvable new catalog.'});
const rows=first.countries.filter(c=>!c.generationAllowed).map(c=>`| ${c.countryId} | ${c.identities.sourceCount} | ${c.recoveryReplay?.identities.retainedCount??0} | ${c.failedRecovery.join(', ')} | ${c.completelyOutsideSourceComponents.length} |`).join('\n');
fs.writeFileSync(`${dir}/15-04-README.md`,[
 '# Prompt 15 — 15-4 실행 결과','',
 '**REVIEW C: fail. 15-4는 완료되지 않았다.** 전 세계 생성 입력을 검사한 결과 12개 국가의 행정구역 복구가 고정 정책을 충족하지 못했다. 기존 source/catalog/runtime bytes를 유지하고, 부적합 입력으로 새 catalog를 생성하거나 게시하지 않았다.','',
 `247개 국가의 원본 identity 집합과 기존 ${first.count.oldProtectedTerritories}개 territory 보호 경계를 현재 bytes로 검사했다. 원본 identity는 기존에 유지된 merged map-unit 5개까지 포함하여 ${first.count.sourceIdentities}개다. 현재 승인된 partition과 SVN/DNK 통과 복구 후보를 합쳐도 ${first.count.sourceIdentities-first.count.retainedIdentities}개 identity가 아직 복구되지 않는다. SVN의 193개는 보존된다. 기존 모든 territory의 국가별 union은 고정 P0 coverage를 통과했다. 이 보호 입력 검사는 새 cell mapping이나 migration 구현의 검증은 아니다.`,'',
 '| 국가 | 원본 identity | 실패 복구 후보의 보존 identity | 실패 항목 | P0와 완전히 분리된 원본 component |','|---|---:|---:|---|---:|',rows,'',
 '각 실패 복구 후보는 이름/identity 자체는 유지할 수 있지만 geometry 보존 기준을 만족하지 못한다. 단일 국가 fallback으로 그 차이를 감추지 않는다. 현재 immutable partition에서 빠진 identity와 복구 후보의 identity를 구별해 기록했다. [국가별 source correspondence](world-preflight/v2/first/)에는 원본 component/hash/면적/외부 차집합, 변경 geometry, 경계 변위의 구체적인 witness를 기록했다.','',
 `완전히 P0 밖에 있는 원본 component ${contradictions.length}개를 별도 JSTS intersection과 최소 거리 계산으로 재검증했다. CSI 원본은 21개 component이지만 20개가 현재 고정 P0와 양의 면적 교집합이 없다. 고정 P0 안의 cell만으로 이 component를 보존하는 것은 불가능하다. sourceTiny(1km²·8km 이하) 판정은 미분할 허용 정책이며 삭제 권한이 아니다. [독립 재검증](15-04-independent-recheck.json)의 거리·면적·hash가 근거다.`,'',
 'ALD/CHL 등의 gap 보정은 0.1% 면적 상한을 넘고, 실제 경계에서 허용된 0.0015070710678118655도보다 먼 구체적인 점/선분이 있다. 원본 P1의 경계를 그대로 두면 P0를 덮지 못하고, 억지로 확장하면 고정된 보정 한도를 위반한다. coverage tolerance 또는 mesh 해상도를 바꾸어 해결할 문제로 처리하지 않았다.','',
 '두 개의 별도 Node 프로세스가 입력 검사를 재실행했다. 12개 상세 correspondence 파일의 bytes가 일치했고, summary도 출력 경로만 정규화하면 일치했다. 이것은 실패 재현 증거이며 catalog/topology/render 독립 생성 성공은 아니다. 초기 audit에서 기존 merged map-unit identity 5개를 추가 identity로 잘못 분류한 결과와 generator를 보존했다. 현재 audit은 고정된 기존 parent normalization 및 기존 selected identity를 근거로 이들을 유지한다. 새로운 정치적 소유권을 결정하지 않는다.','',
 '[검증 로그](15-04-validation.json): Node 테스트 4개(193개 count로 source 누락 감추기, tiny 섬 삭제, hole/차집합 보존, 실제 CSI 충돌), 전체 ESLint, TypeScript를 실행했다. 이전 15-3의 새 production build 로그는 전체 기록된 application/config input hash와 길이가 같음을 확인한 후 재사용했다. 이번 단계의 새 build, live API, browser E2E는 수행하지 않았다. 테스트 성공은 실패 탐지가 올바르다는 뜻이며 REVIEW C 통과를 뜻하지 않는다.','',
 '세계 mesh/common arrangement·topology·membership·LOD/PBF 및 actual world budget 검사는 입력 gate 실패로 실행하지 않았다. 따라서 새 immutable version/artifact index, 기존 territory→새 cell geometry mapping, 실제 전 세계 생성 bytes는 없다. 15-3의 비용 추정치를 15-4의 실측값으로 재사용하지 않았다.','',
 '재개 위치: **15-4의 source restoration**. 고정 P0를 유지하면서 원본 component를 보존할 수 없는 기록된 source 충돌을 먼저 해결해야 한다. 외곽이나 component 보존 계약을 변경하는 정책 선택은 현재 요청에 포함된 고정 요구사항을 바꾸므로 자동으로 수행하지 않는다. 충돌을 해결한 후 보호 경계를 포함하는 전 세계 공통 arrangement, cell 생성, coverage/topology/membership/actual byte 비용과 두 번의 catalog/render 생성 비교를 수행한다. REVIEW C가 fail인 상태에서 15-5/15-6으로 진행하지 않는다.','',
 '실행 명령: `node scripts/prompt15-world-preflight.mjs first`, `node scripts/prompt15-world-preflight.mjs second`, `node scripts/review-prompt15-c.mjs`. 입력/산출물 SHA-256·byte length와 도구 버전은 summary/execution-inputs 및 REVIEW C가 연결하는 JSON에 기록했다. preflight 두 명령의 exit code 1은 발견된 실제 gate 실패다. 기존 결과가 있으면 덮어쓰기를 거부하므로 재실행은 새 workspace/명시적인 새 revision으로 보존해야 한다.','',
 ].join('\n').replaceAll('world-preflight/v2/first/',`world-preflight/${revision}/first/`)
 .replaceAll('node scripts/prompt15-world-preflight.mjs first`',`node scripts/prompt15-world-preflight.mjs first ${revision}\``)
 .replaceAll('node scripts/prompt15-world-preflight.mjs second`',`node scripts/prompt15-world-preflight.mjs second ${revision}\``)
 .replaceAll('node scripts/review-prompt15-c.mjs`',`node scripts/review-prompt15-c.mjs ${revision}\``));
write('15-04-final-artifacts.json',{checkpoint:'15-4',status:'fail',review,evidence:[fileIdentity(`${dir}/15-04-README.md`),recheck,validation,...first.artifacts],resumeAt:'15-4 source restoration'});
console.log(JSON.stringify({status:'fail',inputAudit:first.status,blocked:first.blockedCountries,independentRecheckPassed,validation:checks.map(x=>({command:x.command,status:x.status})),contradictions:contradictions.length}));
process.exitCode=1;
