# 병렬 작업의 파일 소유권 v1

이 문서는 프롬프트 21-03의 공통 인터페이스다. 작업 경로·실행별 출력 규칙은 [작업 공간 배치 v1](workspace-layout-v1.md)을 함께 적용한다. 두 문서가 포함된 **21-03 공통 커밋**을 A·B·C 분기의 출발점으로 사용한다. 해당 커밋은 실행 완료 기록으로 연결하며 문서에 자기 자신의 commit hash를 삽입하지 않는다.

구현·입력 기준선 B0는 `b0d0c32327ceba4b57e4bda01c895a4a898631f3`이다. [21-02 검증 기록](../../reports/maintenance/prompt21-baseline-commit.json)은 B0의 파일 복원·줄바꿈·LFS 검증 범위를 설명한다. 공통 인터페이스 커밋은 B0와 그 기록을 포함해야 한다. 현재 대상국은 `countryId: null`이며 국가 선정·조사·다운로드·후보 생성은 시작하지 않는다.

## 담당 역할과 실제 수정 경로

담당은 사람 수가 아니라 변경 책임이다. 한 사람이 여러 역할을 맡아도 작업별 역할과 수정 파일을 기록한다. 표의 기존 입력 경로는 현행 구조를 설명하며, 새 국가·실행별 경로는 배치 문서에서 정한 규칙을 따른다.

| 역할 | 소유하는 경로·변경 | 다른 역할과의 경계 |
| --- | --- | --- |
| 메인 공통 담당 | `src/lib/geography/`의 schema·검증·loader·조회·국가 입력 helper, `scripts/geography/`의 공통 생산·검증 코드 | 국가 준비자는 기존 공통 계약을 호출하고 공통 코드 변경은 재현 자료와 함께 제안한다. 국가별 schema 사본을 만들지 않는다. |
| 메인 공통 담당 | `src/lib/world/`의 catalog·identity·world 상태, `src/lib/simulation/`의 frontier·runtime·서버, `src/app/api/`의 공통 API, `src/components/`의 공통 UI | 국가 준비 파일에서 게임 상태·ID·원자적 commit·undo/redo 동작을 수정하지 않는다. |
| 메인 공통 담당 | `src/lib/simulation/server/simulation-instruction.ts`, `simulation-tools.ts`, provider·context 검증 코드 | 공통 GPT 지시·tool schema·실행 경계는 한 담당자가 반영한다. 국가 자료의 명칭·계층 근거와 분리한다. |
| 메인 공통 담당 | `.gitattributes`, `.gitignore`, `package.json`, `package-lock.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, `vitest.setup.ts`, `scripts/geography/tsconfig.json` | A·B·C가 같은 설정 파일을 동시에 편집하지 않는다. 설정 변경 요청은 공통 담당자가 순서대로 반영한다. Next 관련 코드 수정 전에 설치된 Next 문서를 확인한다. |
| 국가 준비 담당 | 자기 국가의 조사 근거, 원본 참조·고정 입력, 정규화·계층·이름·별칭 자료, 입력 pin, 후보와 전용 검증 증거 | 기존 `data/raw/prompt19/<CountryId>/`, `data/source-locks/prompt19/`, `scripts/prompt19/<CountryId>/` 또는 CHN 전용 경로의 자료는 소유 국가를 확인한다. 타국 파일과 기존 고정 입력을 덮어쓰지 않는다. 새 작업 경로는 배치 문서에 따른다. |
| 메인 공통 담당 | `scripts/geography/country-adapters.ts`, `data/geography/names/verified-name-facts-v1.json`, `data/geography/names/source-name-overrides-v1.json` 등 여러 국가가 소비하는 단일 파일 | 국가 준비자는 자기 국가의 근거를 별도 제출한다. 공통 담당자가 검토·합류하고 관련 검증을 수행한다. 국가마다 이 파일들을 동시에 수정하지 않는다. |
| 통합 담당 | `data/runtime/operational-catalog/current.json`, `data/runtime/geography/current.json`의 최종 선택 | 활성 포인터의 단일 작성자다. 국가 준비자와 A·B·C 분기는 포인터를 읽어 기준을 기록한다. 실제 발행·활성 전환은 후속 통합 범위다. |
| 통합 담당 | `data/derived/prompt19/`의 최종 mixed-world 조립, `data/derived/geography/`의 전체 metadata 발행, 공유 국경·전역 ordinal·membership·seed lineage·render 자료의 통합 순서 | 국가별 후보 출력과 최종 활성 산출물을 구분한다. 국가 준비용 명령이 전역 산출물을 쓰면 실행 가능한 준비 명령에서 제외하고 일반화 과제로 인계한다. |
| 통합 담당 | CHN 표시 자료의 최종 조립·선택, `src/lib/map/chn-province-presentation.server.ts`, `chn-boundary-display-lod.server.ts`가 소비하는 자료의 연결 | 표시 자료로 공식 State 부모·province membership을 인증하지 않는다. 공통 표시 코드 수정은 메인 공통 담당자와 합류 순서를 정한다. |

공통 경로의 대표 구현은 [State·province 계약](../../src/lib/geography/state-province-contract.ts), [국가 입력 검증](../../src/lib/geography/country-metadata-input.ts), [현재 입력 읽기](../../scripts/geography/current-input.ts), [운영 catalog loader](../../src/lib/world/operational-catalog.server.ts), [생산 geography loader](../../src/lib/geography/production-geography.server.ts)다. 국가 준비자는 이 계약·helper를 재사용하며 최종 catalog 조립기를 국가 인자만 바꿔 쓰는 범용 생성기로 간주하지 않는다.

## 반드시 보존할 공통 계약

- State의 `stateId`는 기존 행정 부모 identity, province의 `provinceId`는 기존 `TerritoryId`다. 이름이 같아도 서로 다른 ID의 객체와 mutable 상태는 독립적이다. 검색용 이름 묶음은 실제 entity를 합치지 않는다.
- `sourceCountryId`, 검증된 공식 부모, 현재 `ownerCountryId`·`controllerCountryId`를 구분한다. 이름·source feature ID·ordinal을 새 province ID로 대체하지 않는다.
- 공식 부모 미확정은 `stateId: null`과 품질·근거를 유지한다. partial·unsupported coverage, coarse·residual·source-free 상태를 준비 단계에서 임의 보완하지 않는다.
- 기존 geometry·topology·전역 ordinal·행정 membership·seed lineage를 유지한다. 부분 점령은 검증된 선택 집합, 원자적 commit, undo/redo, 선택 밖 객체 보존을 따른다.
- 활성 catalog는 포인터뿐 아니라 실제 index·descriptor와 대조한다. `catalogVersion`, `geometryRoot`, `topologyRoot`, `renderArtifactRoot`, `manifestPath` 전체와 `metadataRef`·manifest·schema를 기록한다. 국가 수나 미확정 부모 수는 과거 보고서의 고정 기대값으로 복사하지 않는다.

국가별 metadata 제출은 [기존 인계 계약](../geography/country-metadata-handoff-v1.md)을 따른다. `validateCountryMetadataInput`의 성공은 주입된 기존 catalog·독립 근거에 대한 준비 입력 검증이다. 미래 국가 형상 생성·전체 production 발행의 성공을 뜻하지 않는다. 새 영토 ID가 아직 없어도 원본·계층·이름 자료를 준비할 수 있으며, 그 단계에서는 미래 ID를 발급하지 않는다.

## A·B·C 분기의 파일 소유권

21-03의 공통 문서를 먼저 커밋한 뒤 다음 파일 경계로 분기한다. 아래의 후속 문서·helper는 각 태스크의 산출물 예약 경로이며, 이 문서의 존재가 해당 태스크 실행 완료를 뜻하지 않는다.

| 분기 | 소유 파일·산출물 | 다른 분기를 기다리지 않고 할 일 |
| --- | --- | --- |
| A / 21-04 작업 공간 | `docs/development/workspace-layout-v1.md`의 실제 설정·재현·로컬 설치 절차, `.tmp/prompt21/workspace-layout.json`, 필요할 때만 `scripts/workspaces/`의 작은 setup·실행 helper | B0와 공통 인터페이스 커밋을 포함한 국가 준비용 브랜치·작업트리, 독립 의존성·임시·cache·Next 경로를 준비한다. 공통 경로·규칙을 바꿀 때는 공통 담당자에게 합류를 요청한다. |
| B / 21-05 검증 기준 | `docs/development/verification-baseline-v1.md`, `src/lib/world/operational-mixed-membership.test.ts`의 최소 fixture 보완, 관련 검증 helper·테스트의 필요한 변경 | 21-01에서 재현한 기존 실패 4개의 경계-index fixture를 수정한다. 기존 [audit.cjs](../../reports/province-independence-parallelism-20261103/audit.cjs)를 재사용하고 실행별 출력·누락 실패 집계를 최소 보완한다. 운영 loader의 검증을 완화하지 않는다. |
| C / 21-06 인계·동기화 | `docs/development/country-workspace-handoff-v1.md`, 필요한 작은 인계 검증 helper와 재현 자료 | 기존 국가 metadata 인계 계약에 작업 공간·base commit·dependency pin·관련 메인 변경의 감지·동기화·재검증·수락 절차를 연결한다. 공통 geography schema를 복제하지 않는다. |
| 공통 담당 / 합류 | 이 `workspace-ownership-v1.md`, 배치 문서의 공통 인터페이스, 공용 설정·schema·registry 변경 | A·B·C가 요청한 공통 변경을 순차 반영하고 새 기준 commit을 알린다. 같은 파일의 동시 편집을 피하도록 범위를 먼저 정한다. |
| 통합 담당 / 21-07 이후 | A·B·C 합류, 실제 동시 검증·재검증 인계 실험, 전체 완료 근거 | 세 분기의 산출물과 최신 기준을 확인한 뒤 실험한다. 실제 국가 추가·전역 조립·활성 전환은 후속 프롬프트에서 처리한다. |

선택적 helper의 예약 파일명은 배치 문서의 분기 표를 따른다. A의 `setup-country-prep.mjs`·`run-verification.mjs`, B의 `audit-current-frontiers.cjs`, C의 `validate-country-handoff.cjs`를 구분하며, 필요하지 않은 helper는 만들지 않는다. 한 helper를 여러 분기가 수정해야 하면 공통 담당자가 단독 소유한다. 설치·cache를 제어하는 A helper와 fixture·전선 성공 집계를 담당하는 B helper를 합친 새 오케스트레이터는 만들지 않는다.

## 변경 요청과 최신 메인 합류

공통 파일 변경 제안에는 대상 경로, 변경 이유·영향, 재현 명령, 실패·성공 근거, 소비하는 schema·코드·입력 pin을 기록한다. 국가 담당자는 자기 준비 브랜치에서 공통 변경이 필요한 이유를 인계하고, 공통 담당자가 공통 커밋으로 반영한다. 합류 순서는 일반적인 merge·rebase 또는 필요한 공통 커밋 반영으로 정하며 다른 작업자의 브랜치·변경을 강제로 덮어쓰지 않는다.

관련 메인 변경이 들어오면 준비 담당자가 마지막으로 검증한 base와 최신 메인 사이의 **실제로 소비하는 파일·입력** 차이를 먼저 확인한다. schema·helper·catalog/metadata 참조·입출력 pin이 바뀌면 기존 검증 근거를 재검증 필요 상태로 표시하고 동기화 후 다시 검증한다. 원본 bytes와 관계없는 문서 변경은 영향 판단 근거를 남겨 유효한 준비 자료를 재사용한다. 구체적인 수락·거부 절차는 C의 인계 문서에서 확정한다.

통합 담당자는 최신 메인과 활성 두 포인터를 다시 읽고 국가별 인계를 순차 수락한다. 공통 base가 같더라도 각 브랜치의 준비 변경과 검증 상태를 별도로 확인한다. 두 국가가 같은 전역 catalog·이름 registry·공유 국경 파일을 동시에 발행하지 않는다.

## 로컬 자원과 Git 경계

작업트리는 파일 트리와 전용 브랜치를 나누지만 Git 객체·refs·LFS 저장소 일부를 공유한다. 같은 브랜치의 중복 checkout, 공유 refs의 강제 변경, 타 작업트리의 삭제·clean·prune를 작업 분리 수단으로 사용하지 않는다. 실행 중인 서버·게임·checkpoint를 보존한다.

의존성은 각 작업트리별로 분리하고, `.tmp`·`.next-*` 출력은 실행별로 분리한다. writable junction·symlink로 공유하지 않는다. 절대 경로·PID·포트·설치 상태는 로컬 `.tmp` 기록에만 두고, 버전 관리하는 인계에는 상대 경로와 byte pin·재현 명령을 남긴다. 비밀 설정값과 게임 snapshot은 인계·Git에 포함하지 않는다.

LFS cache는 사용자 지시에 따라 **실제 필요한 복원 실패가 생겼을 때만** 해당 객체를 검증된 기존 실체 파일에서 복구한다. 21-02에서는 실제 실패한 3개만 복구했고 나머지 역사적 14개는 보류했다. 이 관측값은 이후 실행의 누락 판정을 대신하지 않으며, 선제 전체 복구나 일괄 재다운로드를 하지 않는다.

## 21-03의 적용 범위

이 인터페이스를 공유하면 A는 작업 공간·도구 경로, B는 fixture·검증, C는 인계·재검증을 서로 다른 파일에서 시작할 수 있다. 이번 단계는 담당과 경로를 확정한다. 작업트리 생성·설치·실제 cache 격리 검증은 A와 21-07, 기존 fixture 실패 수정·세 나라 실제 전선 검증은 B에서 실행한 근거로 판정한다.
