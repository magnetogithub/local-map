# 국가 준비 작업 공간과 최신 메인 합류 v1

프롬프트 21-06의 C 산출물이다. [국가 metadata 인계 계약](../geography/country-metadata-handoff-v1.md)의 데이터·품질·독립 근거 검증에 작업 공간과 버전 합류 절차를 연결한다. 지리 schema와 `validateCountryMetadataInput`을 그대로 재사용한다. 파일 소유권은 [공통 역할](workspace-ownership-v1.md), 상대 경로와 실행별 쓰기는 [작업 공간 배치](workspace-layout-v1.md)를 따른다.

출발점은 B0 `b0d0c32327ceba4b57e4bda01c895a4a898631f3`와 21-03 공통 커밋 `72325dfc547ef31178c78f49ebe45f94397d567e`다. 이것은 이후 모든 인계에 고정할 최신 메인 값이 아니다. 준비할 때 검증한 commit과 통합할 때 최신 commit을 별도로 기록한다. 현재 대상국은 `null`이며 원본 조사·다운로드·정규화·후보 생성은 시작하지 않았다.

## 준비 단계와 수락의 의미

| `stage` | `countryId`와 제출 범위 | 수락 후 남은 일 |
| --- | --- | --- |
| `unassigned` | `null`만 허용. 원본은 `unresearched`, 국가 입력·출력은 빈 목록. 작업 공간·공통 의존성만 확인 | 실제 CountryId 지정, 원본·계층·시점·라이선스 조사와 채택 |
| `source-preparation` | 실제 CountryId. 원본·source-lock·검증한 계층·이름·별칭·준비 출력과 검사 근거 | 필요시 국가 adapter/후보 생성 일반화, 새 영토 연결, 기존 catalog metadata 검증 |
| `country-metadata-preparation` | 실제 CountryId. 기존 catalog 대상국의 전체 셀에 대한 공통 metadata와 독립 admission 근거 | 최신 전체 catalog 재조립·검증, manifest/consumer 연결과 별도 활성 전환 |

`source-preparation`은 미래 TerritoryId 없이 가능하다. 원본 feature ID는 원본 identity로 보존하며 미래 `provinceId`, state identity, 전역 ordinal을 임의 발급하지 않는다. 기존 metadata helper는 **현재 등록된 catalog 셀 전집합**을 검사한다. 미래 국가 형상 후보를 그 helper의 현재 셀처럼 제출하지 않는다. 아직 catalog에 없는 국가 identity는 별도 등록·통합이 필요하다.

어느 단계의 작업 공간 수락도 production 발행·채택 성공을 뜻하지 않는다. 국가 준비 metadata의 자체 `metadataRef`와 인계에 기록하는 **활성 전체 metadataRef**를 구분한다. 전체 production ref에 단일국 준비 hash를 넣지 않는다.

## 제출 manifest

국가 지정 후 `reports/country-prep/<CountryId>/<runId>/manifest.json`에 제출하며 전용 근거는 같은 디렉터리의 `evidence/`에 둔다. 대상 미지정 예제·합성 실험은 `.tmp/prompt21/<workspaceKey>/<runId>/`에 둔다. `null`을 국가 폴더명으로 만들지 않는다. 모든 artifact는 기존 `GeographyArtifact`의 `{path, sha256, byteLength}`다. 경로 기준은 해당 checkout 루트이며 실제 bytes를 검사한다. 절대 경로·비밀 설정·게임 snapshot을 넣지 않는다.

| 필드 | 작성·검토 규칙 |
| --- | --- |
| `schemaVersion`, `countryId`, `stage` | `country-workspace-handoff-v1`과 위 단계. 통합 담당자가 독립 선택한 expected CountryId와 일치해야 한다. 준비자가 적은 국가명이나 ISO 별칭에서 추정하지 않는다. |
| `baseCommit` | 준비 자료의 공통 코드·입력을 마지막으로 검증한 실제 commit. 전체 hash를 사용한다. 최신 HEAD와 다르다는 이유만으로 자동 거부하지 않는다. |
| `contracts` | workspace·ownership·layout 계약 버전과 공통 geography schema 버전. capture가 읽은 값을 복사하며 국가별 schema를 만들지 않는다. |
| `catalogRef`, `metadataRef` | 현재 pointer와 실제 index·descriptor·manifest에서 읽은 전체 catalogRef 5필드, 활성 metadataRef의 schemaVersion·contentRoot. 버전 문자열만 비교하지 않는다. |
| `dependencies` | 실제 소비하는 공통 검증 코드·직접/전이 의존 코드·lockfile·공통 입력과 활성 참조 파일의 상대 경로·byte pin. 통합 담당자가 별도로 검토한 목록과 일치해야 한다. 제출자가 임의로 관련 파일을 빼서 stale 감지를 피할 수 없다. |
| `inputs`, `outputs` | 실제 존재하는 원본·정규화·계층·이름·준비 metadata·후보 등 artifact pin. 계획한 미래 파일을 존재하는 출력처럼 적지 않는다. source-lock과 계층 근거도 해당 pin 목록에 연결한다. |
| `producer` | 실제 생성/준비 `command`와 사용 코드 `codeCommit`. 미지정 단계에서는 둘 다 `null`. 수동 조사도 재현 방법과 근거 저장 명령을 남긴다. |
| `source` | `status`, `publisher`, `directReference`, `asOf`, `license`, `sourceLock`, `hierarchyEvidence`. 미조사 상태는 `unresearched`와 nullable 필드의 명시적 `null`, 빈 계층 근거로 표시한다. 조사한 원본의 배포자·직접 참조·고정 시점·라이선스·국가 crosswalk·계층 확인 방법은 source-lock과 근거 본문에 보존한다. |
| `ownership` | `ownedPaths`는 자기 국가 자료·출력·인계의 상대 경로. `sharedChanges`는 공통 담당에게 요청한 변경, `nonTargetImpact`는 타국 영향 검토 결과. 공통 schema/registry·전역 조립·활성 포인터를 국가 소유로 선언하지 않는다. |
| `quality` | `names`, `parents`, `coverage`의 `unknown/verified/partial/unsupported`와 `limitations`. 실제 지리 레코드의 detailed evidence·coverage는 기존 공통 schema를 따른다. wrapper의 요약 플래그가 공식 범위나 부모를 인증하지 않는다. |
| `verification` | 검사별 `check`, 실제 `command`, `cwd: "."`, `codeCommit`, `status`, `exitCode`, 소비 `dependencies`, 결과 `artifacts`, 미실행·실패·생략 `reason`. 결과 파일에 명령·수집 파일/검사 수·시작/종료·실패 내용을 보존한다. 필수 검사는 실제 실행·성공해야 하며 `failed/skipped/not-run`을 성공으로 바꾸지 않는다. |
| `revalidation.nextChecks` | 후속 통합에서 다시 확인할 검사를 구체적으로 열거한다. 관련 입력·검증 규칙 변경이 있으면 영향받는 검사를 여기에 남긴다. |
| `impactReview` | base가 최신 commit과 다를 때 `{reviewedCommit, reason, evidence}`. 실제 `git diff`와 소비 파일 비교 결과를 pin한 근거로 남긴다. 관련 의존 pin 변경은 이 검토로 우회할 수 없다. 같은 commit이면 `null` 가능. |

`country-metadata-preparation`에는 `check: "country-metadata-input"`의 성공 근거가 필요하다. 이 근거는 기존 `validateCountryMetadataInput(countryId, metadata, independentlyVerifiedContext)`를 실제 호출한 결과를 담아야 한다. 전체 catalog·부모·source membership·coverage witness를 제출 metadata에서 역으로 생성하지 않는다. 국가 간 동명 객체·독립 ID, null 부모와 partial/unsupported, coarse/residual·source-free를 유지한다.

작은 CLI의 수락 정책은 실제 국가의 `verification`에 제출한 검사 **전부**가 `passed`여야 한다. 이전 실패·생략·미실행은 삭제하지 않고 결과 artifact 본문이나 별도 검사 이력에 보존한다. 현재 준비 범위에 필수인 검사의 미완료를 이 이력으로 옮겨 수락을 우회하지 않는다. 아직 수행할 수 없는 후보 생성·전체 통합 검사는 이유와 함께 `revalidation.nextChecks`에 남긴다. 대상 미지정 단계는 이유를 적은 명시적 미실행 기록을 허용하며 실제 검사 실패를 성공으로 수락하지 않는다.

## 반복 가능한 인계 검사

[작은 CLI](../../scripts/workspaces/validate-country-handoff.cjs)는 작업 공간 envelope를 검사한다. artifact·CountryId·catalogRef·metadataRef는 기존 공통 schema를 import한다. 생성 명령이나 검증 명령을 대신 실행하지 않으며, metadata 내용·번역·라이선스·polygon의 사실성을 인증하지 않는다. 통합 담당자는 기존 국가 입력 helper와 독립 원본 근거를 함께 검사한다.

통합 담당자가 최신 메인 checkout에서 아래 순서로 실행한다. `dependencies.json`은 **준비자가 제출한 목록과 독립적으로 검토한**, 추가 소비 경로의 JSON 문자열 배열이다. CLI가 기본으로 포함하는 공통 validator 의존성 외에도 실제 사용한 adapter·입력 helper·검사 코드·fixture·source-lock·계층 입력·추가 설정을 빠짐없이 지정한다. 필요 없는 전역 생성기를 실행하지 않는다.

```powershell
# 해당 checkout 루트에서 실행. 출력 경로는 매 실행 새 runId로 정한다.
$handoffRun = '.tmp/prompt21/main/<runId>'
New-Item -ItemType Directory -Path $handoffRun -ErrorAction Stop
# $handoffRun/dependencies.json에 통합 담당자가 검토한 추가 경로 배열을 저장한다.
node scripts/workspaces/validate-country-handoff.cjs capture --dependencies "$handoffRun/dependencies.json" |
    Set-Content -Encoding utf8 -LiteralPath "$handoffRun/latest-baseline.json"
if ($LASTEXITCODE -ne 0) { throw 'Baseline capture failed' }

node scripts/workspaces/validate-country-handoff.cjs check `
    --manifest 'reports/country-prep/<CountryId>/<runId>/manifest.json' `
    --baseline "$handoffRun/latest-baseline.json" --country '<CountryId>' |
    Set-Content -Encoding utf8 -LiteralPath "$handoffRun/handoff-result.json"
if ($LASTEXITCODE -ne 0) { throw 'Handoff rejected; inspect diagnostics' }
```

미지정 인계에는 로컬 manifest 경로와 `--country null`을 사용한다. capture·check는 상대 경로 입력을 읽고 JSON을 stdout으로 반환한다. 위 redirection 외에 국가 자료·게임·포인터를 쓰지 않는다. BOM이 있는 PowerShell UTF-8 JSON도 읽을 수 있어야 한다. 공유 writable node_modules·cache를 만들지 않는다.

capture는 최신 checkout의 HEAD, 공통 계약 버전, 두 활성 포인터와 실제 index/descriptor/metadata manifest의 pin·참조를 고정한다. check는 baseline을 다시 현재 파일과 비교하므로 과거 baseline 파일을 그대로 제출해 최신 검사를 우회할 수 없다. 인계 base와 최신 HEAD가 다르면 정상 Git ancestry와 영향 검토를 확인하고 **실제 의존 pin**으로 재사용 여부를 판단한다. base 이후 관계없는 변경은 허용할 수 있으나 관련 의존 파일·참조·schema 변경은 재검증이 필요하다.

검사 성공은 `accepted-unassigned`, `accepted-source-preparation`, `accepted-country-metadata-preparation` 중 해당 단계로 표시한다. 거부는 0이 아닌 종료 코드와 진단을 반환한다. wrong-country, stale ref/schema/dependency, 존재하지 않거나 bytes가 다른 입력·출력·검증 근거, 필수 검사의 실패·생략을 자동 수락하지 않는다. 결과 artifact의 존재만으로 내용의 진실성을 증명할 수 없으므로 통합 담당자가 명령·pin·국가·수집 결과와 본문을 검토한다.

## 메인이 바뀔 때 동기화와 재검증

1. 준비 담당자는 마지막 검증 base와 최신 공통 변경을 `git diff <base>..<latest> -- <consumed-paths>`로 비교한다. 작업 공간의 미커밋 변경과 활성 참조 bytes도 확인한다. sourceLock·원본·이름·계층 준비 자료와 그 자료를 검사한 코드·입력·결과 근거를 구분한다.
2. 관련 공통 commit을 자기 브랜치에 정상 merge·rebase·선택 반영한다. 진행 중인 변경을 보존하고 충돌은 공통 담당자와 해결한다. 다른 브랜치 강제 갱신·reset·clean·worktree 제거를 동기화 수단으로 쓰지 않는다.
3. schema·검증 코드·adapter·lockfile·catalog/metadataRef·입출력 pin이 바뀌면 기존 검증은 **재검증 필요**다. 기존 성공 로그를 지우거나 새 규칙의 성공으로 재표시하지 않는다. 원본 bytes가 그대로여도 새 규칙으로 영향받는 검사와 기존 국가 metadata 검증을 다시 실행한다. 실패·생략은 이유와 함께 보존한다.
4. 바뀌지 않은 원본·계층·이름 자료는 byte pin을 확인해 재사용한다. 관계없는 문서 변경만 있으면 최신 diff와 소비 pin 일치를 `impactReview` 근거로 기록하고 유효한 기존 결과를 재사용한다. 관련 pin이 바뀌었는데 ref 문자열이나 base만 최신으로 바꾸는 행위는 재검증이 아니다.
5. 새 검사 결과가 소비한 코드 commit·입력/출력 pin을 기록한 H2를 제출한다. `baseCommit`, dependency pins, 생성 코드 commit과 검증 결과를 각자의 실제 실행 기준으로 갱신한다. H1과 H2 및 보존한 원본 hash를 연결해 변경과 재사용 근거를 설명한다.
6. 통합 담당자는 **그 시점 최신 메인**에서 capture와 check, 기존 국가 metadata·독립 근거 검사를 수행한다. 수락 중 포인터나 소비 파일이 바뀌면 중단하고 새 baseline으로 재검사한다. 통합 담당자만 전체 metadata/catalog 조립과 활성 선택을 순차 반영한다.

두 국가가 같은 옛 기준에서 준비됐어도 하나를 통합한 뒤 다른 국가를 **바뀐 최신 기준**에서 다시 확인한다. 공통 source-lock·이름 registry·공유 국경·전역 ordinal을 병렬 작성하지 않는다. 국가 담당자가 요청한 공통 수정은 경로·이유·재현 명령·영향·code/input pin과 함께 공통 담당자에게 인계한다.

| 변경 대상 | 유지 가능한 준비 자료 | 다시 확인할 근거 |
| --- | --- | --- |
| 관계없는 문서·타국 전용 파일 | 동일 bytes의 원본·계층·이름과 유효한 결과 | 최신 diff·실제 소비 pin·타국 영향 없음의 검토 |
| 공통 validator·schema·의존 패키지·검증 입력 | 동일 bytes인 원본 준비 자료 | 새 코드/입력으로 관련 검사 실행, contracts/dependencies·결과 pin |
| 원본·시점·license·국가 crosswalk·계층 | 변경 영향이 없는 나머지 원본 | source-lock, 국가/원본 identity, verified/null 부모, 이름/coverage 및 후속 연결 |
| catalog/metadataRef·현재 셀 전집합 | 근거가 여전히 유효한 원본·계층·이름 | 전체 ref, 기존 TerritoryId·국가 분류, 전체 알려진 membership, metadata seal과 통합 검사 |
| 준비 출력·명령·evidence bytes | 영향 없는 원본 | 새 출력 pin·실제 생성 코드/검증 명령·실패/생략·최신 수락 |

## 21-07에 넘기는 확인 절차

이번 단계의 단일 checkout 회귀 검사는 envelope의 정상 수락과 wrong-country·stale·근거 누락 거부를 확인한다. **실제 두 작업 공간 동시 실행과 관련 공통 변경의 Git 동기화 연습은 21-07에서 수행한다.** A/21-04 작업 공간이나 B/21-05 fixture 완료를 이 문서만으로 인정하지 않는다.

21-07에서는 합류 B1으로 H1과 독립 baseline을 만들고 위 CLI로 수락한다. 통합 측 전용 연습 브랜치의 B2에서 H1이 실제 소비하는 작은 호환 입력/검증 변경 하나를 commit한다. 새 baseline으로 H1을 검사해 dependency 차이에 따른 재검증 필요를 확인한다. 준비 브랜치에 B2를 정상 반영하고 같은 준비 bytes로 관련 검사를 다시 실행해 H2를 수락한다. H1 거부/H2 수락·동기화 전후 commit·실제 명령·결과·원본 hash 보존을 남긴다. ref 문자열만 바꾼 음성 fixture 검사는 이 실제 연습을 대신하지 않는다.

합성 fixture는 실행별 `.tmp`에 두고 실제 활성 포인터·catalog·국가 원본을 바꾸지 않는다. 최종 수락 후에도 실제 새 국가 후보 생성·전역 조립·production 발행·활성 전환은 후속 범위다. 현재 KOR/PRK 고정 생성기와 CHN 전용 도구를 범용 `--country` CLI로 취급하지 않는다.

21-06의 실제 실행·미실행·보호 입력 보존 근거는 [완료 기록](../../reports/maintenance/prompt21-country-workspace-handoff.json)에 기록한다.
