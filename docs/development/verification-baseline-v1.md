# 검증 기준 v1

프롬프트 21-05의 검증 명령·필수 입력·성공 집계 기준이다. 역할과 경로는 [파일 소유권](workspace-ownership-v1.md)과 [작업 공간 배치](workspace-layout-v1.md)를 따른다. 모든 명령의 실행 위치는 **검사할 작업트리 루트**다. 현재 `countryId: null`이며 아래 KOR·PRK·CHN은 기존 활성 자료의 회귀 검사 대상이다. 새 국가 조사·다운로드·후보 생성·발행은 시작하지 않는다.

21-05에서는 membership fixture와 실제 카탈로그의 세 전선 턴을 실행한다. A·B·C가 합류한 최종 관련 묶음과 두 작업 공간의 동시 실행은 21-07에서 검증한다. 아래 재현 명령이 존재한다는 이유만으로 실행 완료를 판정하지 않는다. 실제 수집 파일·테스트 이름·종료 코드·결과와 소비한 코드·입력 pin을 함께 확인한다.

## 활성 입력과 과거 snapshot의 구분

활성 카탈로그는 `data/runtime/operational-catalog/current.json`에서 선택하고 실제 `artifact-index.json`·`catalog.json`·`manifest.json`·`detail-index.json`과 대조한다. `catalogVersion`, `geometryRoot`, `topologyRoot`, `renderArtifactRoot`, `manifestPath` **다섯 필드 전체**가 identity다. geography는 `data/runtime/geography/current.json`의 `metadataRef`·manifest pin과 실제 metadata/admission payload를 확인한다. manifest 경로만 일치하는 상태를 성공으로 삼지 않는다.

기존 [현재 기대값 helper](../../src/lib/test-only/current-geography-expectations.ts)는 [현재 채택 입력 reader](../../scripts/geography/current-input.ts)가 고정한 catalog·raw source·hierarchy crosswalk에서 국가 집합, fine/coarse/residual 분류, 정확한 province ID와 State·원본 연결을 유도한다. 제출된 metadata의 집계값을 정답으로 복사하지 않는다. residual만 남은 국가도 fine profile 국가 집합에 포함하며 [해당 회귀 검사](../../src/lib/geography/current-geography-expectations.test.ts)를 유지한다.

[생산 통합 검사](../../src/lib/geography/production-geography.integration.test.ts)는 이 동적 기대값과 독립 verifier를 재사용한다. 동일 이름·다른 ID의 객체, `provinceId = TerritoryId`, `stateId: null`인 미확정 부모, partial/unsupported coverage, source-free·coarse/residual 자료를 그대로 검증한다. [개별 ID·부분 점령 검사](../../src/lib/geography/state-province-identity.test.ts)는 실제 entity를 이름으로 합치지 않는지와 선택 밖 객체 보존을 확인한다.

반면 [이름 릴리스 snapshot 검사](../../src/lib/geography/prompt20-name-release.snapshot.test.ts)는 [20-03](../../reports/maintenance/prompt20-03-metadata.json)과 [20-04](../../reports/maintenance/prompt20-04-names.json)가 고정한 과거 두 릴리스만 읽는다. 그 고정 ID·개수·병합 예시는 현재 활성 카탈로그의 기대값이 아니다. [최신 Prompt20 보완 결과](../../reports/maintenance/prompt20-supplement-resume-20261103.json)의 20파일·185검사도 당시 관측 결과이며 이후 실행의 고정 통과 수로 사용하지 않는다.

## 일곱 검증 묶음

| 묶음 | 실제 검사 범위 | 필수 입력·예상 성격 |
| --- | --- | --- |
| Prompt20 공통 계약 | `src/lib/geography`, `scripts/geography`, `catalog-region.test.ts`, `catalog-region-integration.test.ts`, `operational-region.test.ts`, `operational-territorial-runtime.test.ts`, `src/lib/simulation/server` | 합성 schema/음성 검사와 실제 채택 원본·metadata 통합 검사. 청진·내몽골 조회, 불완전 소속 표시, 원본 연결·null 부모와 최신 게임 보존 정책을 포함한다. |
| 기존 객체·membership·점령 | `src/lib/world/world-state-v3.test.ts`, `operational-catalog-runtime.test.ts`, `operational-mixed-membership.test.ts`, `operational-game.server.test.ts`, `src/lib/simulation/prompt19-mixed-frontier.test.ts` | 합성 world/경계 fixture와 실제 활성 catalog·canonical coarse seed. membership/seed lineage 양성·음성 본문에 도달해야 한다. |
| 실제 전선·이력 세 턴 | `scripts/workspaces/audit-current-frontiers.cjs` | 현재 활성 catalog에서 PRK → KOR, KOR → PRK, PRK → CHN을 각각 새 메모리 게임에서 선택 → 계획 검증 → 원자적 commit → undo → redo한다. 세 target의 레코드와 세 턴의 실행·통과가 모두 필요하다. |
| 게임 보존·이력 | `src/lib/geography/state-province-identity.test.ts`, `src/lib/simulation/server/operational-game-version.test.ts`, `operational-game-pool-preservation.test.ts` | 개별 ID·부분 점령·undo/redo, 구버전 게임 거부, pool·checkpoint·기존 객체 보존. 서버 검사는 네 pool global과 mock/module 상태를 테스트 경계에서 복원한다. |
| 국가 준비 경로 | `scripts/prompt19-country-files.node-test.mjs`, `src/lib/geography/country-metadata-input.test.ts` 및 위 생산 통합 검사 | Node 경로 검사와 공통 `validateCountryMetadataInput`을 별도 실행한다. 현재 경로 helper/후보 생성기는 KOR·PRK 전용이며 고정 coarse predecessor·출력 경로 제약이 있다. 검사 성공은 범용 국가 생성이나 신규 형상 채택 성공이 아니다. |
| 실제 활성 metadata | `scripts/geography/build-current-metadata.cjs --verify <현재 manifest>` | catalog/index/descriptor/provenance와 채택 raw·normalized·hierarchy·name 입력/코드 pin, manifest·metadata/admission을 읽는 독립 오프라인 검증. 출력은 stdout이며 활성 포인터를 쓰지 않는다. |
| 정적 검사 | 루트 TypeScript, `scripts/geography` TypeScript, 수정 코드 ESLint, `git diff --check` | run-local build-info 또는 `--incremental false`; 실제 수정 파일에 lint 적용. 문서·fixture·검증 helper 범위에서 build/API/browser는 재실행 필수가 아니며 런타임·빌드 설정까지 바꾸면 관련 검증을 추가한다. |

## 재현 명령과 출력

실행마다 고유한 `$verificationRunRoot`를 정한다. 다음은 직접 실행 가능한 기존 CLI이며 `.tmp` 상대 경로는 현재 작업트리 기준이다. 새 실행에서 이전 결과를 덮어쓰지 않는다. 설치된 lockfile 기반 의존성을 사용하며, `npm` 실행 파일 해석이 잘못되면 아래처럼 Node로 도구 entry point를 직접 실행한다.

```powershell
$verificationRunRoot = '.tmp/prompt21/main/21-05-<고유-run-id>'
New-Item -ItemType Directory -Force -Path "$verificationRunRoot/results", "$verificationRunRoot/logs" | Out-Null
```

`--configLoader runner --no-cache`는 config bundle 임시 쓰기와 Vitest 결과 캐시를 제어한다. Vite cacheDir와 OS temp까지 실행별로 격리했다는 뜻은 아니다. 직접 CLI는 기존 config의 작업트리별 기본 cache 경로를 쓰므로 동시에 같은 작업트리에서 실행하지 않는다. run-local `TEMP`·`TMP`·`TMPDIR`, 실제 resolved cacheDir·writer 경로는 배치 문서의 A 실행 절차를 적용하고 관측한다. 21-07의 격리 판정은 그 실제 근거로 한다.

fixture만 수집하는 명령은 다음과 같다.

```powershell
node node_modules/vitest/vitest.mjs run src/lib/world/operational-mixed-membership.test.ts --configLoader runner --no-cache --reporter=verbose --reporter=json --outputFile.json="$verificationRunRoot/results/membership.json"
```

21-07의 관련 합류 묶음은 최신 Prompt20 묶음에 기존 객체·membership·점령 대상을 합쳐 실행한다. 겹치는 파일은 Vitest가 한 번 수집하며 테스트 수는 생성된 JSON에서 읽는다.

```powershell
$verificationTests = @(
  'src/lib/geography', 'scripts/geography',
  'src/lib/simulation/catalog-region.test.ts',
  'src/lib/simulation/catalog-region-integration.test.ts',
  'src/lib/simulation/operational-region.test.ts',
  'src/lib/simulation/operational-territorial-runtime.test.ts',
  'src/lib/simulation/server',
  'src/lib/world/world-state-v3.test.ts',
  'src/lib/world/operational-catalog-runtime.test.ts',
  'src/lib/world/operational-mixed-membership.test.ts',
  'src/lib/world/operational-game.server.test.ts',
  'src/lib/simulation/prompt19-mixed-frontier.test.ts'
)
node node_modules/vitest/vitest.mjs run @verificationTests --configLoader runner --no-cache --reporter=default --reporter=json --outputFile.json="$verificationRunRoot/results/related.json"
```

Node test runner 파일은 Vitest `scripts/**/*.test.{mjs,ts}` 패턴에 포함되지 않는다. 과거 명령 끝에 `.node-test.mjs`를 붙인 기록을 Node 검사 실행 근거로 사용하지 않는다. 아래 명령은 세 경로 검사를 별도 수집한다. 이 스크립트가 만드는 fixture는 작업트리 `.tmp/prompt19-path-fixtures-*`와 `.tmp/prompt19-own-output-*` 아래 무작위 디렉터리다. 실행 루트 인자가 없으므로 모두 `$verificationRunRoot` 안에 생성됐다고 기록하지 않는다.

```powershell
node --test scripts/prompt19-country-files.node-test.mjs
node --test scripts/workspaces/audit-current-frontiers.node-test.cjs
```

두 번째 파일은 필수 세 턴의 누락·실패·중복을 성공으로 세지 않는 집계 회귀 검사다. `.node-test.cjs`도 Vitest 수집 대상이 아니므로 위 별도 명령을 사용한다.

활성 metadata 검증은 실행 시점 registry에서 manifest 경로를 읽는다. 무인자 CLI는 metadata 생성 경로이므로 이 검증 명령으로 대체하지 않는다.

```powershell
$verificationGeographyRegistry = Get-Content -Raw -Encoding UTF8 -LiteralPath 'data/runtime/geography/current.json' | ConvertFrom-Json
node --max-old-space-size=8192 scripts/geography/build-current-metadata.cjs --verify $verificationGeographyRegistry.manifest.path
```

정적 검사는 다음과 같다. 새 helper가 추가됐으면 해당 경로도 lint 인자에 포함한다.

```powershell
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/typescript/bin/tsc --noEmit -p scripts/geography/tsconfig.json
node node_modules/eslint/bin/eslint.js src/lib/world/operational-mixed-membership.test.ts scripts/workspaces/audit-current-frontiers.cjs scripts/workspaces/audit-current-frontiers.node-test.cjs
git diff --check
```

각 프로세스의 명령·실행 위치·시작/종료 시각·종료 코드·실제 수집 파일/검사명·통과/실패/skip 수를 로컬 실행 결과에 보관한다. 수집 전 cache/temp 권한 오류는 환경 실패로 따로 기록한다. 수집 완료 뒤 assertion 실패와 섞지 않으며, 오류 코드·실제 경로·발생 단계·단독 재현 결과를 남긴다. skip·빈 결과·실행 누락은 통과가 아니다.

## 실제 전선 세 턴의 성공 기준

전용 helper는 [기존 감사](../../reports/province-independence-parallelism-20261103/audit.cjs)의 선택·계획·runtime 경로를 재사용한다. 기존 감사의 `선택 실패 → continue` 경로는 상위 check 실패 수에 누락될 수 있으므로 기존 PASS 개수만 읽어 성공을 판정하지 않는다. 기존 감사 보고서·evidence는 보존하고 새 결과는 `.tmp/prompt21/`의 새 실행 경로에 쓴다.

```powershell
node scripts/workspaces/audit-current-frontiers.cjs --output "$verificationRunRoot/results/frontiers.json"
```

helper는 작업트리 루트에서 실행하고 아직 존재하지 않는 `.tmp/prompt21/` 아래 JSON 출력 파일을 지정한다. 실행 중 실제 읽은 코드·seed·catalog 파일의 SHA-256·byteLength를 수집하고 전체 catalogRef·metadataRef를 기록한다. 이전 출력은 덮어쓰지 않는다.

필수 턴은 `(actor, target) = (PRK, KOR), (KOR, PRK), (PRK, CHN)`이다. 각 턴은 독립 메모리 게임에서 시작하고 실제 전선 선택기·검증된 turn plan·원자적 runtime·이력을 사용한다. 필수 target KOR·PRK·CHN 레코드가 각각 한 개 존재하고 아래를 모두 통과해야 한다.

- 선택 집합이 비어 있지 않고 실제 변경 ID·delta 집합과 정확히 같다. 현재의 한 셀 선택 결과를 고정 기대값으로 삼지 않는다.
- 점령 뒤 선택 셀의 `sourceCountryId`와 법적 owner가 유지되고 controller만 공격국으로 바뀐다.
- commit·undo·redo 각 단계에서 선택 밖 모든 객체의 참조와 상태가 보존된다.
- undo는 점령 전 world, redo는 점령 후 world를 기존 authoritative hash와 상태 검사로 복원한다.
- actor·target·선택/변경 ID·delta·이력 검사 결과·전체 catalogRef와 코드/입력 pin을 기록한다.

선택 실패·빈 선택·commit 실패·예외·레코드/실행 누락은 실패로 합산해 helper를 비정상 종료한다. 세 턴 중 일부만 성공한 결과는 전체 성공이 아니다. 게임 변경은 메모리에만 한정하고 활성 catalog/geography·실제 사용자 게임/checkpoint는 보존한다.

## 입력의 출처와 복구

필수 입력은 다음 연결에서 찾는다. [21-01 입력 목록](../../reports/maintenance/prompt21-baseline.json)의 `newWorktreeInputs`와 [21-02 byte 복원 기록](../../reports/maintenance/prompt21-baseline-commit.json)을 기준으로 실제 현재 파일을 재확인한다. 과거 목록이 현재 누락 여부를 대신하지 않는다.

| 입력 | 출처·검증 연결 | 누락 시 처리 |
| --- | --- | --- |
| 운영 catalog와 detail/topology 자료 | 활성 operational pointer → byte-pinned artifact index → descriptor·manifest·detail-index 및 각 shard | 해당 기준 commit의 추적 파일을 별도 checkout에서 복원하고 index의 SHA-256·byteLength와 비교한다. 활성 자료를 재생성하거나 coarse로 되돌리지 않는다. |
| 현재 metadata와 원본·계층·명칭 | geography pointer/manifest의 metadata·admission, catalog provenance의 joined bundle·source lock·hierarchy, lock이 가리키는 raw/normalized/ADM 원본, `data/geography/names/` | `readCurrentGeographyInput`과 독립 verifier가 소비 pin을 확인한다. 필요한 LFS 실체가 없으면 실제 실패한 객체만 기존 검증된 checkout bytes 또는 기존 승인된 원본에서 복구하고 pin을 재검증한다. |
| 운영 새 게임의 canonical coarse seed | `data/catalogs/prompt14/frozen-catalog-ref.json`, 승인 artifact index/build-only catalog·topology·migration-pair, `reports/prompt14/14-08-immutable-catalog-checkpoint.json`, consumer approval, `public/data/territory-catalog/<version>/` | `prepareProductionCatalogSeed`와 consumer bootstrap이 승인 hash·초기 revision/date를 검사한다. 공개 타일도 bootstrap이 확인하므로 metadata 몇 파일만 복사한 축소 checkout으로 대신하지 않는다. 사용자 game snapshot은 복구 입력이 아니다. |
| 기존 server/provider subdivision 검사 | `public/data/simulation/china-admin1-v1.geojson`, `usa-admin1-v1.geojson` | 기존 loader가 읽는 추적 자료를 기준 commit에서 복원한다. 현재 geography의 세분 province 자료와 역할을 혼동하지 않는다. |
| 과거 이름 릴리스 두 snapshot | 20-03/20-04 보고서의 manifest pin과 그 metadata payload | 현재 registry 산출물로 교체하지 않는다. 각 과거 pin에 해당하는 추적 파일·LFS 실체를 복원한다. |
| 합성 검사 fixture·Node 경로 fixture | 버전 관리하는 test/helper 코드; Node runner는 `.tmp` 안에 작은 JSON/junction 자료를 직접 생성 | 생성 비용은 소규모 임시 fixture다. production 원본을 빈 파일로 흉내 내지 않는다. |

21-01의 감사 대상 필수 closure에는 `ignoredRequired: []`가 기록돼 있다. 이 기준의 채택 자료·canonical seed·과거 snapshot은 추적 파일이며 `node_modules`는 각 작업트리에서 동일 lockfile로 설치하는 로컬 전제다. `.tmp`, `.next-*`, 로그, 게임 checkpoint는 ignored 로컬 출력이다. 과거 임시 로그가 없으면 보고서의 기록과 새 실행을 구별하며 가짜 PASS 파일을 만들지 않는다.

새 실행에서 추가 ignored 입력을 실제로 요구하면 그 경로·생성기/승인 원본·필요 byte pin·복구 대상·예상 디스크/시간 비용을 먼저 기록한다. 원본이 없으면 미실행/환경 실패로 남긴다. LFS cache 전체 복원·새 원본 다운로드·전역 geometry/topology 재생성은 검증의 기본 복구 절차가 아니다. [작업 공간 배치](workspace-layout-v1.md)의 실제 필요 객체만 복구하는 정책을 따른다.

## 21-05의 실행 기록

2026-11-04에 현재 메인 작업트리에서 fixture 수정 전/후 검사를 실행했다. 검증 당시 base HEAD는 `72325dfc547ef31178c78f49ebe45f94397d567e`이며 그 위의 이번 fixture/helper 변경 bytes는 실행 루트의 `source-pins.json`으로 식별한다. 새 문서와 두 검증 helper에는 명시적인 LF 속성을 적용해 checkout 간 bytes를 유지한다. 기존 fixture는 edge 1개를 선언하면서 `edgeDetails: []`를 제공해 로더의 `OPERATIONAL_EDGE_INDEX`에서 중단됐다. nonzero edge를 유지하고 실제 edge shard·index pin·incidence·adjacency를 일치시키는 최소 자료를 추가했다. 양성 membership 검사에 `sharedBoundary(1, 2)`의 실제 edge/좌표 assertion도 추가했다. 운영 loader나 원래 음성 assertion의 예외 조건은 변경하지 않았다.

| 과거 실패와 현재 재현한 검사명 | 수정 전 | 수정 후 도달한 검사·결과 |
| --- | --- | --- |
| `resolves interleaved administrative and previous members independently of interval hints` | `OPERATIONAL_EDGE_INDEX` | interval hint와 무관한 administrative/previous 집합 및 실제 shared boundary 검증 통과 |
| `inherits owner/controller through the coarse previous parent while keeping each new ID` | `OPERATIONAL_EDGE_INDEX` | 개별 새 ID·owner/controller 상속·원본 객체 보존 통과 |
| `rejects missing or wrong-country coarse seed lineage before creating a game` | `OPERATIONAL_EDGE_INDEX` | 의도한 `OPERATIONAL_SEED_SOURCE_MISMATCH` 음성 assertion 통과 |
| `merges old coarse seed pieces only when their authoritative ownership and control agree` | `OPERATIONAL_EDGE_INDEX` | 합의된 상속 양성 및 `OPERATIONAL_SEED_CONSENSUS_MISMATCH` 음성 assertion 통과 |

과거 보고서는 파일·오류·합계만 저장했으므로 네 검사명과 과거 실패의 대응은 [21-01](../../reports/maintenance/prompt21-baseline.json)의 동일 소스 재현으로 복원한 관계다. 새 실행은 수정 전 1파일/6검사 중 2통과·4실패·종료 1, 수정 후 1파일/6검사 모두 통과·종료 0이다. 기존 lineage/중복 부모 음성 검사 두 개도 계속 통과했다. 실행별 근거는 `.tmp/prompt21/21-05-20261104/fixture/`의 `before-results.json`, `after-results.json`, `before-execution.json`, `after-execution.json`, 두 verbose 로그다. 자식 OS temp를 fixture 실행 아래로 지정했으며 동시 실행이나 Vite cache 격리를 증명한 기록은 아니다.

실제 전선 검사는 `node scripts/workspaces/audit-current-frontiers.cjs --output .tmp/prompt21/21-05-20261104/frontiers-final.json`으로 실행했다. 필수 3턴 중 실행 3·통과 3·실패 0이며 누락/중복 target이 없다. 이번 관측에서는 세 턴이 각각 1개를 선택하고 같은 1개만 변경했다. 이 수를 이후 선택의 고정 기대값으로 사용하지 않는다.

| actor → target | commit·undo·redo | 선택 밖 territory·모든 country의 참조/상태 | authoritative world 복원 |
| --- | --- | --- | --- |
| PRK → KOR | 통과 | 세 단계 모두 보존 | undo=before, redo=committed |
| KOR → PRK | 통과 | 세 단계 모두 보존 | undo=before, redo=committed |
| PRK → CHN | 통과 | 세 단계 모두 보존 | undo=before, redo=committed |

`frontiers-final.json`에는 각 actor/target·선택/변경 ID·delta·단계별 상태·이력 결과·전체 catalogRef·metadataRef와 실제 소비한 5,828개 파일 pin이 있다. `changedInputs: []`이며 기존 감사 파일도 pin에 포함해 보존을 확인했다. 최초 helper 실행 `frontiers.json`은 추가한 simulation hash 비교에서 revision을 포함하는 기존 계약을 놓쳐 실패했다. 당시에도 world hash 복원 검사는 통과했다. simulation 내용은 원래 revision으로 정규화해 비교하고 undo/redo revision은 별도로 단조 증가를 검사하도록 helper만 수정한 뒤 재실행해 통과했다. 게임 runtime은 변경하지 않았다.

| 추가 실행 | 실제 결과 | 로컬 근거 |
| --- | --- | --- |
| 필수 턴 실패 집계 Node 검사 | 8검사 모두 통과·종료 0 | `required-turn-accounting/output.log` |
| 국가 경로 Node 검사 | 3검사 모두 통과·종료 0 | `country-files/output.log` |
| 현재 metadata 독립 CLI | `validated-metadata-only`, `validated-static-names`, 8개 공통 검증 true·종료 0 | `metadata/output.log` |
| 루트 TypeScript | 종료 0 | `tsc-root/output.log` |
| scripts/geography TypeScript | 종료 0 | `tsc-geography/output.log` |
| fixture·전선 helper·집계 회귀 검사 ESLint | 종료 0 | `lint/output.log` |

위 추가 실행의 근거는 모두 `.tmp/prompt21/21-05-20261104/` 아래다. 각 하위 디렉터리의 `execution.json`과 전체 `checks.json`에 실제 명령·시각·종료 코드·로그 위치를 기록했다. 실행 위치는 메인 작업트리 루트이며 자식별 OS temp를 지정했다. 이 결과는 같은 작업트리의 대상 검증 결과이며 독립 작업트리 동시 실행을 검증한 기록은 아니다.

최종 관련 묶음과 두 공간 동시 실행은 21-07에서 수행한 기록으로만 완료를 판정한다.
