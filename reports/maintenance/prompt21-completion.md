# 프롬프트 21 완료와 다음 작업 인계

2026-11-04 기준 **21-01~21-08을 완료**했다. 메인 개발과 국가 원본·계층·이름 자료 준비를 독립적으로 시작할 작업 공간, 검증 기준, 최신 메인 합류 절차를 갖췄다. 태스크 의존관계는 [PROMPT 21의 5절 다이어그램](../../prompts/PROMPT_21_PARALLEL_WORKSPACES_AND_VERIFICATION_BASELINE.txt)을 따른다. 상세 pin·실행 명령·시간·수집 파일은 [기계 판독 완료 기록](prompt21-completion.json)과 [21-07 실행 기록](prompt21-integration-verification.json)에 연결한다.

21-01은 필수 입력과 기존 실패를 구분했고, 21-02는 재현 가능한 B0를 고정했다. 21-03의 소유권·경로 계약을 바탕으로 21-04 작업 공간, 21-05 fixture·전선 검증, 21-06 인계 검사를 준비했다. 21-07에서 합류 검증·실제 동시 실행·관련 변경 재검증을 마쳤으며, 21-08은 그 증거와 후속 경계를 정리한다. 이번 21-08에서 전체 검사나 세 나라 실제 턴을 새로 실행했다고 기록하지 않는다.

## 검증한 기준과 사용 가능한 작업 공간

| 기준 | 실제 commit과 의미 |
| --- | --- |
| B0 | `b0d0c32327ceba4b57e4bda01c895a4a898631f3` — 프롬프트 20 공통 계약·필수 입력과 checkout 바이트 정책. 기존 fixture 실패도 재현하는 기준이다. |
| B1 | `e75977b1db93c6a10c1c1c8a64fd9f2c487e891d` — A·B·C 구현·설치가 합류한 실제 검증 기준. |
| B2 | `ff1f5343badac48a4eda86da6f4dd9cf451b75fd` — B1을 부모로 둔 연습 전용 호환 규칙 변경. 운영 메인에 적용하지 않았다. |
| 21-07 증거 기준 | `1746d29873da009d501453b11f4c1b6a4bffbf0b` — B1 소스와 21-07 보고서를 포함한다. 완료 보고 작성 전 메인·준비 공간에서 확인한 공통 HEAD다. |

| 공간 | 저장소 루트 기준 상대 경로 | 브랜치 |
| --- | --- | --- |
| 메인·통합 | `.` | `main` |
| 국가 준비 | `../local-map-worktrees/country-prep-20261104t011700z` | `country-prep/20261104t011700z` |

두 공간은 공통 코드·lockfile·채택 입력을 재현하며 각자 설치한 `node_modules`를 사용한다. 연습 후 원래 브랜치로 정상 복귀하고 B1 소스와 21-07 보고서 commit으로 연결했다. B2는 `prompt21-exercise/integration-20261104t013843z`, `prompt21-exercise/preparation-20261104t013843z` 브랜치에 보존했다. 최종 완료 보고를 추가하는 commit은 자기 참조를 피하기 위해 최종 응답에서 연결한다.

메인 공통 담당은 schema·loader·API·GPT 지시·설정·의존성·검증과 공용 registry·이름 파일을 소유한다. 국가 담당은 지정한 국가의 조사·원본·정규화·계층·이름·입력 pin·후보·전용 증거만 소유한다. 통합 담당은 공통 변경의 순차 합류, 최종 전역 조립과 두 활성 포인터의 단일 작성자다. 한 사람이 여러 역할을 맡을 수 있다. 상세 경계는 [파일 소유권](../../docs/development/workspace-ownership-v1.md), [경로·재현 절차](../../docs/development/workspace-layout-v1.md), [인계 규칙](../../docs/development/country-workspace-handoff-v1.md)을 따른다.

실행 출력은 각 작업트리의 `.tmp/prompt21/<workspaceKey>/<runId>/{os-temp,vite-cache,logs,results}`와 `.next-prompt21-<workspaceKey>-<runId>`로 분리한다. 국가 지정 후 원본은 `data/raw/country-prep/<CountryId>/<runId>/`, lock은 `data/source-locks/country-prep/<CountryId>/<runId>.json`, 준비 출력은 `data/derived/country-prep/<CountryId>/<runId>/{normalized,hierarchy,names,candidate}/`, 인계는 `reports/country-prep/<CountryId>/<runId>/manifest.json`과 `evidence/`를 사용한다. 현재 `countryId: null`이므로 국가 자료 경로는 아직 생성하지 않았다.

## 실제 변경 파일과 보존한 참조

추가·수정 파일은 다음 그룹이다. 정확한 파일 identity와 commit별 변경은 연결된 JSON 보고서에 남겼다.

- 재현 정책: `.gitattributes`; 프롬프트 20 필수 구현·자료는 기존 commit을 재사용했다. 전역 `core.autocrlf`는 변경하지 않았다.
- 개발 지침: `docs/development/workspace-ownership-v1.md`, `workspace-layout-v1.md`, `verification-baseline-v1.md`, `country-workspace-handoff-v1.md`.
- 실행·검증: `scripts/workspaces/run-verification.mjs`, `audit-current-frontiers.cjs`, `audit-current-frontiers.node-test.cjs`, `validate-country-handoff.cjs`, `validate-country-handoff.node-test.cjs`와 `src/lib/world/operational-mixed-membership.test.ts`의 fixture.
- 완료 근거: `reports/maintenance/prompt21-baseline.json`, `prompt21-baseline-commit.json`, `prompt21-workspace-interface.json`, `prompt21-workspace-setup.json`, `prompt21-country-workspace-handoff.json`, `prompt21-integration-verification.json`, 이번 `prompt21-completion.md`·`prompt21-completion.json`.

활성 포인터뿐 아니라 실제 index·descriptor·metadata manifest와 전체 참조를 대조했다.

| 참조 필드 | 보존한 값 |
| --- | --- |
| `catalogRef.catalogVersion` | `catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee` |
| `catalogRef.geometryRoot` | `49e2b4ca3850f15b5158089636b3b95f05ef997f2792b40d4105f068a48cf7d5` |
| `catalogRef.topologyRoot` | `b054d23bd63b1c5d17afb06ae0abb5b7332530bcddb9e93d7371f16364df86e2` |
| `catalogRef.renderArtifactRoot` | `f209abaa4966270bd04e3294c75eace7a256b36e052a2a9e8a1f78376e5a0423` |
| `catalogRef.manifestPath` | `/data/territory-catalog/catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee/manifest.json` |
| `metadataRef.schemaVersion` | `geography-metadata-ref-v1` |
| `metadataRef.contentRoot` | `d10c6db6e6c56bc2c2c53ee26fb281a042b31d16592d45960814f90028158fbf` |

`data/runtime/operational-catalog/current.json`은 SHA-256 `8021847cf57984fe05a73ec0dd6842462127bb2e9a400af50dc2b8c1ff8d2609`·251바이트, `data/runtime/geography/current.json`은 `c626f8dd1fab13bd23381b9e535509d724085c1141ac535c8281c1fd9af4cae8`·1,218바이트를 유지했다. 21-07 종료 시 채택 입력·producer 코드 pin을 공간마다 307개 확인해 불일치가 없었다. 실제 소비 파일 목록·SHA-256·크기는 이전 보고서와 로컬 증거에 연결돼 있다.

geometry·topology·기존 TerritoryId·ordinal·membership·seed lineage와 활성 포인터를 바꾸지 않았다. 기존 동적 기대값, 동명·다른 ID 독립성, `sourceCountryId`와 owner/controller 구분, null 부모·partial/unsupported·coarse/residual·source-free 상태를 재사용했다. 국가·객체 수는 관측값이며 고정 성공 기준으로 복사하지 않았다. 실제 사용자 게임·checkpoint 내용은 읽지 않았고, 기존 게임 보존은 관련 회귀 검사·정책과 비접근 경계로 확인했다.

## fixture와 세 나라 실제 전선의 근거

21-01에서 `operational-mixed-membership.test.ts`의 6개 중 2개 통과·4개 실패를 재현했다. 선언은 edge 1개인데 `edgeDetails: []`여서 네 검사가 모두 의도한 assertion 이전 `OPERATIONAL_EDGE_INDEX`에서 중단됐다. 21-05에서 실제 edge shard·8바이트 incidence·일치하는 adjacency를 넣고 shared boundary 양성 검사를 보강했다. edge를 0으로 바꾸거나 운영 loader를 완화하지 않았다. 최종 합류 실행에서 같은 파일의 6개가 모두 통과했다.

| 기존 실패 검사명 | 수정 후 의도한 확인 |
| --- | --- |
| `resolves interleaved administrative and previous members independently of interval hints` | interval hint와 독립적인 administrative/previous membership |
| `inherits owner/controller through the coarse previous parent while keeping each new ID` | 새 ID별 독립 상태와 coarse 부모의 owner/controller 상속 |
| `rejects missing or wrong-country coarse seed lineage before creating a game` | 의도한 seed source 불일치 거부 |
| `merges old coarse seed pieces only when their authoritative ownership and control agree` | 합의된 상속 수락·불일치 거부 |

원래 역사적 보고서는 파일·오류·합계만 담았으므로 네 이름의 대응은 동일 소스를 실행한 [21-01 기록](prompt21-baseline.json)으로 복원했다. [검증 기준](../../docs/development/verification-baseline-v1.md)에 수정 전후 명령·결과와 실행별 근거가 있다.

21-05의 실제 활성 catalog에서 **PRK → KOR, KOR → PRK, PRK → CHN**을 각각 새 메모리 게임으로 실행했다. 필수 3턴 중 실행 3·통과 3·실패 0·누락 0이다. 각 턴의 비어 있지 않은 선택과 변경 집합이 같았고 sourceCountryId·법적 owner를 유지하며 controller만 바뀌었다. commit·undo·redo에서 선택 밖 territory와 모든 country의 참조·상태가 보존됐고 authoritative world가 undo=before·redo=committed로 복원됐다. 당시 각 1개 선택은 관측값이다.

21-07은 실제 소비 코드·입력 **5,828개 pin 전부**, 설치 의존성 4개 버전과 전체 참조가 같음을 확인해 위 21-05 성공 근거를 재사용했다. 21-07에 새 실제 턴을 실행한 것으로 집계하지 않는다. 원본은 `.tmp/prompt21/21-05-20261104/frontiers-final.json`, identity 검토는 `.tmp/prompt21/21-07-20261104/baseline/frontier-reuse.json`이다. 전선 선택 실패·빈 선택·실행 누락이 최종 실패에 포함되도록 helper와 별도 Node 집계 검사를 보완했다.

## 합류 검증과 실제 동시 실행

21-07 메인에서 B1의 최종 관련 Vitest 묶음을 **1회** 실행했다. UTC `01:33:00.272~01:36:49.648`, 실제 25파일·239검사 수집, 239통과·실패 0·pending 0·종료 0이다. 실행 명령은 [21-07 보고서](prompt21-integration-verification.json)의 `mergedVerification`, 수집 범위·재현 명령은 [검증 기준](../../docs/development/verification-baseline-v1.md)에 기록했다.

별도 `node --test`로 국가 경로 3개, 전선 실패 집계 8개, 인계 envelope 12개를 모두 통과했다. 루트·geography TypeScript, 수정 관련 6파일 ESLint, `git diff --check`와 양쪽 공간의 실제 metadata 검증도 종료 0이었다. Node 검사는 Vitest 수에 합치지 않았다. 시간·stdout/stderr·자식 temp는 `.tmp/prompt21/21-07-20261104/baseline/`과 준비 공간의 실행별 근거에 남겼다.

대표 동시 실행은 두 공간에서 같은 명령 `node scripts/workspaces/run-verification.mjs --workspace-key parallel --run-id concurrent-20261104t013440z -- src/lib/geography/country-metadata-input.test.ts`를 사용했다. 메인 UTC `01:34:42.846~01:34:45.627`, 준비 `01:34:42.851~01:34:45.721`이며 실제 worker 구간이 **2,776ms** 겹쳤다. 각 공간 1파일·28검사 전부 통과, 부모·worker 모두 종료 0이었다. 성공한 실제 검사 쌍은 1회다.

양쪽의 동일 상대 실행 경로 `.tmp/prompt21/parallel/concurrent-20261104t013440z`와 `.marker.json`에 서로 다른 표식이 유지됐다. root·각 프로젝트의 resolved cacheDir는 각자의 `vite-cache/` 아래, OS 임시는 각자의 `os-temp/`, 결과는 각자의 `results/`였다. 실제 Vitest module-cache 경로 동작이 공간마다 **33회(디렉터리 1·쓰기 16·atomic rename 16)** 관측됐고 결과 쓰기도 확인했다. 도구 동작·작성 프로세스·시간·호출자를 대조해 상대 공간·기본 경로로의 예상 밖 쓰기 0, 두 포인터와 307개 보호 pin 보존을 확인했다. 자세한 실제 하위 경로·writer trace는 `.tmp/prompt21/21-07-20261104/concurrency/{summary,result}.json`에 있다.

`--no-cache`는 Vitest 결과 cache를 끄며 configured Vite cache의 실제 쓰기는 0이었다. 따라서 resolved 경로만으로 persistent Vite cache 쓰기를 입증했다고 해석하지 않는다. 실제 관측한 module-cache·OS temp·result 동작을 격리 근거로 삼았다. 최초 계측 시 Windows preload 경로의 역슬래시가 `NODE_OPTIONS`에서 해석돼 `MODULE_NOT_FOUND`로 **검사 수집 전에** 중단됐다. forward slash로 고친 뒤 위 1회가 성공했다. assertion 실패나 권한 오류로 집계하지 않았다. 이후 기존 실행 부모에 대한 허용 mkdir의 분석만 바로잡았으며 성공 쌍을 다시 실행하지 않았다.

## 실제 관련 변경과 H1·H2 인계 실험

대상 `null`·단계 `unassigned`의 합성 인계 H1은 B1, 실제 소비 의존성 30개와 준비 공간 Node 12개 통과 근거로 양쪽에서 수락됐다. stale ref·schema·wrong-country는 각각 `HANDOFF_STALE_REF`, `HANDOFF_SCHEMA`, `HANDOFF_COUNTRY`로 거부됐다.

준비 연습 브랜치는 B1에 둔 채 통합 연습 브랜치에 실제 B2를 commit했다. `validate-country-handoff.cjs`의 중복 `verification.check` 이름 거부 규칙과 `.node-test.cjs` 회귀 검사, 정확히 두 파일의 pin이 바뀌었다. 고유 검사명을 가진 같은 준비 자료는 계속 유효한 호환 변경이다. 새 B2 capture로 변경하지 않은 H1을 검사해 `HANDOFF_REVALIDATION`을 받았다. ref 문자열만 바꾼 음성 검사와 구별되는 실제 commit·의존 pin 변화다. 중복 이름은 B1에서 수락됐지만 pin을 갱신해도 B2에서 `HANDOFF_EVIDENCE`로 거부돼 규칙 변경도 확인했다.

준비 연습 브랜치를 정상 `git merge --ff-only B2`로 동기화한 뒤 Node 13개를 재실행해 전부 통과했다. 통합 B2에서도 13개와 관련 lint가 통과했다. base·의존 pin·실행 코드·검증 결과를 갱신한 H2가 양쪽에서 수락됐다. 원래 `workspace-state.json` **154바이트**와 SHA-256 `841ebd2a6bb0a9b4b4f1a66e7b0367632abd6538e28a752f730a2bdb58d61909`는 계속 같았다. H1·H2와 Git 근거는 `.tmp/prompt21/exercise/20261104t013843z/` 및 `.tmp/prompt21/21-07-20261104/exercise-{state,git-history}.json`에 보존했다.

최신 합류는 실제 소비 파일과 ref 차이를 먼저 확인한다. 관련 schema·검증·입출력 pin이 바뀌면 정상 동기화 후 영향을 받는 검사를 다시 실행하고 인계를 갱신한다. 관계없는 문서 변경만 있으면 diff·pin을 확인한 `impactReview`로 유효한 준비 자료를 재사용한다. 통합 담당은 매 수락 때 최신 공통 기준과 활성 참조를 다시 확인하며 국가별 합류를 순차 수행한다.

## Git·LFS·설치와 남은 범위

B0는 격리 checkout 6,181파일의 바이트를 `core.autocrlf=true/false` 양쪽에서 확인했다. pin 관련 23개 텍스트 경로의 CRLF/LF를 좁게 고정했으며 실제 export에서 발견한 중첩 tsconfig 영향은 루트 전용 패턴으로 수정했다. [21-02 기록](prompt21-baseline-commit.json)에 실제 바이트 감사가 있다.

사용자의 **문제가 발생하면 그때 필요한 cache만 복구** 지시를 적용했다. 21-02 local LFS checkout의 실제 실패 3개만 검증된 기존 실체에서 복구해 5/5를 확인했다. 21-04 전체 작업트리의 실제 checkout에서는 42개 중 14개가 pointer로 남은 뒤에만 그 14개를 복구해 42/42의 hash·크기를 확인했다. 원격 일괄 다운로드는 없었다. 역사적 `.lfs.txt` 영수증은 일반 blob으로 보존했다. Git/LFS 객체는 worktree 사이 일부 공유된다.

준비 공간은 lockfile로 확인한 520개 고유 npm archive를 개인 설치 cache에 재사용한 후 `npm ci --offline --no-audit --no-fund --cache <개인 경로>`로 530개 패키지를 독립 설치했다. `node_modules` 복사·junction·symlink 공유 없이 lockfile을 보존했다. 설치·cache·TEMP 설정은 해당 자식에 한정했다. 초기 runner의 종료 후 getter와 inline project cache override 문제는 실제 독립 검사에서 발견해 reporter 시점 수집·프로젝트별 override로 수정한 뒤 21-07에 사용했다.

현재 바로 병렬 진행할 수 있는 범위는 메인의 공통 개선과, **실제 대상국 지정 후** 국가 준비 공간의 원본·행정 계층·시점·라이선스 조사 및 정규화·이름 자료 준비다. 아직 `countryId: null`이며 국가 조사·다운로드·후보 생성·발행·활성 전환을 시작하지 않았다. 미래 provinceId나 전역 ordinal도 발급하지 않았다.

KOR/PRK 생성기는 지원 국가·coarse predecessor·고정 출력 제약이 있고 CHN coordinator는 전용 경로를 사용한다. 무인자 metadata 생성은 전체 활성 catalog의 불변 파생물을 만들며 포인터를 쓰지 않지만 국가별 준비 출력 명령은 아니다. mixed-world는 전역 조립기이며 `--no-activate`도 전역 산출물을 쓴다. 국가 adapter·형상/증분 발행 일반화, 공유 국경·전역 ordinal·타일·CHN 표시의 순차 조립·활성 전환, 실제 새 국가 전체 플레이 검증은 후속 범위다. 프롬프트 22나 다음 국가를 자동 실행하지 않았다.

이번 범위의 Next 확인은 각자 설치한 Next의 **설정 메모리 평가**다. 현재 작업에서 build·API·브라우저·dev 서버를 실행한 PASS는 없다. 런타임·빌드 설정을 실제 바꾸면 독립 산출물·포트로 필요한 검증을 추가한다. 사용자 서버를 종료하거나 게임·checkpoint 내용을 수집하지 않았고 외부 AI·유료 API·push·배포도 실행하지 않았다.
