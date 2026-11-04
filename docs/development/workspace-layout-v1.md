# 작업 공간과 실행 경로 v1

프롬프트 21-03의 공통 경로 인터페이스다. 역할·파일 변경 경계는 [파일 소유권 v1](workspace-ownership-v1.md), 데이터 의미는 [State·province 계약](../geography/state-province-contract-v1.md)과 [기존 국가 인계 계약](../geography/country-metadata-handoff-v1.md)을 따른다. 이 문서의 경로 규칙을 A·B·C가 함께 사용하고, 실제 설치·실행 결과는 각 태스크에서 기록한다.

구현·입력 B0는 `b0d0c32327ceba4b57e4bda01c895a4a898631f3`, 21-02 기록 커밋은 `ee73a89db5cc19e0af6a24c82937b5cff90b362f`다. [B0 검증 기록](../../reports/maintenance/prompt21-baseline-commit.json)은 파일 복원 검증이며 독립 작업트리 설치나 동시 실행 검증이 아니다. A·B·C의 시작점은 B0와 이 두 공통 문서를 포함한 **21-03 공통 커밋**이다. 완료 응답에서 그 커밋을 연결한다.

현재 `countryId: null`이다. 국가 조사·다운로드·정규화·후보 생성은 아직 시작하지 않는다. 아래 `<CountryId>` 경로는 실제 국가 지정과 ID 매핑 확인 후에만 사용하며 `null`을 국가 코드나 디렉터리명으로 쓰지 않는다.

## 작업트리·브랜치와 경로 기준

모든 `data/`, `reports/`, `.tmp/` 상대 경로의 기준은 **해당 작업트리 루트**다. CLI도 그 루트에서 실행한다. `workspaceKey`와 `runId`는 경로에 안전한 영문 소문자·숫자·하이픈만 사용한다. `runId`는 실행마다 고유하게 만들고 기존 경로나 브랜치를 덮어쓰지 않는다.

| 구분 | 예약 경로·이름 | 생성 시 확인 |
| --- | --- | --- |
| 메인 | 현재 저장소와 현재 메인 브랜치 | 기존 변경·서버·게임을 유지한다. |
| 대상국 미지정 준비 공간 | `../local-map-worktrees/country-prep-<runId>/`, 브랜치 `country-prep/<runId>`, `workspaceKey=country-prep-<runId>` | 허용 workspace 안의 형제 디렉터리인지, 기존 폴더·worktree·branch 충돌이 없는지 확인한다. 국가 자료를 넣지 않는다. |
| 국가 지정 후 준비 공간 | `../local-map-worktrees/country-<countrySlug>-<runId>/`, 브랜치 `country-prep/<countrySlug>/<runId>` | `countrySlug`는 확인한 CountryId의 경로용 표기이며 데이터 identity는 원래 CountryId를 유지한다. 국가별 작업트리·브랜치를 분리한다. |
| 실행 루트 | `.tmp/prompt21/<workspaceKey>/<runId>/` | 같은 상대 경로를 두 작업트리에서 사용해도 각자의 실제 디렉터리여야 한다. |
| 로컬 배치 기록 | `.tmp/prompt21/workspace-layout.json` | A가 실제 절대 경로·branch·공통 base·도구 버전·설치 상태·PID·포트를 기록한다. Git에는 포함하지 않는다. |

Git 객체·refs·LFS 저장소는 일부 공유된다. 파일 트리와 브랜치가 분리됐다고 Git 전체가 독립 복제된 것으로 기록하지 않는다. 기존 브랜치 강제 갱신·중복 checkout·작업트리 강제 제거·일괄 clean/prune는 사용하지 않는다. 작업트리 생성은 21-04의 실행 범위다.

## 국가 준비 자료의 쓰기 경계

다음은 **새 준비 자료의 예약 규칙**이다. 현재 생성기가 이 경로를 CLI 인자로 지원한다는 뜻은 아니다. 기존 채택·불변 입력은 원래 경로와 pin을 유지하고, 통합 담당자가 채택 여부를 판단한다.

| 자료 | 국가·실행별 상대 경로 | 의미 |
| --- | --- | --- |
| 원본·출처·라이선스 참고 | `data/raw/country-prep/<CountryId>/<runId>/` | 국가 지정 후 조사·채택한 입력을 보존한다. 기존 대형 입력은 재다운로드하지 않고 추적·LFS 정책과 byte pin을 우선한다. |
| 입력 lock | `data/source-locks/country-prep/<CountryId>/<runId>.json` | 출처·시점·국가 crosswalk와 실제 입력의 상대 경로·SHA-256·byteLength를 기록한다. 기존 공용 lock을 덮어쓰지 않는다. |
| 정규화·계층·이름 | `data/derived/country-prep/<CountryId>/<runId>/{normalized,hierarchy,names}/` | 원본 feature identity를 보존한다. 아직 없는 provinceId·전역 ordinal을 발급하지 않는다. |
| 후보 | `data/derived/country-prep/<CountryId>/<runId>/candidate/` | 지원하는 생성 경로가 있을 때만 사용한다. 현재 고정 KOR/PRK·CHN 도구를 자동으로 이 경로에 연결하지 않는다. |
| 인계·전용 근거 | `reports/country-prep/<CountryId>/<runId>/manifest.json`, 같은 디렉터리의 `evidence/` | 준비 단계·countryId·base와 공통 계약 버전·입출력 pin·실행 명령·검증 결과·한계를 기록한다. 필드·수락 절차는 C가 기존 인계 계약에 연결한다. |
| 개인 경로·실행 로그 | `.tmp/prompt21/<workspaceKey>/<runId>/` | 절대 경로·포트·PID·설치 로그·임시 fixture를 둔다. 인계에는 상대 참조만 남긴다. |

준비 자료는 `data/runtime/*/current.json`에 직접 연결하지 않는다. 전체 catalogRef 5필드와 metadataRef·manifest·schema, 실제 소비 코드·입력 pin을 기록한다. 원본 준비의 완료와 기존 catalog 국가 metadata 검증, 미래 형상 생성·전역 production 채택을 구별한다. 알려진 null 부모·partial/unsupported·coarse/residual 상태를 그대로 인계한다.

## 도구별 쓰기 경로

| 자원 | 경로·설정 계약 | 실제 확인할 근거 |
| --- | --- | --- |
| 의존성 | 작업트리별 `node_modules/`, 동일 `package-lock.json`으로 설치 | 설치된 버전·lockfile pin, 실제 디렉터리와 링크 여부. writable junction/symlink로 공유하지 않는다. |
| npm 설치 캐시·로그 | 실행 루트 아래 `npm-cache/`; npm의 `--cache`로 설치 캐시 지정. 내부 로그는 `npm-cache/_logs/`, stdout/stderr 보관은 `logs/npm/` | 자식 npm의 적용 설정·실제 생성 경로. 설치·LFS 실체화 예상량과 남은 디스크를 먼저 확인한다. |
| OS 임시 파일 | 실행 루트 아래 `os-temp/`; 자식 프로세스에만 `TEMP`, `TMP`, `TMPDIR` 지정 | 도구 import·시작 전에 환경을 적용하고 자식의 `os.tmpdir()` 및 실제 하위 파일 작성 프로세스를 기록한다. OS 기본 경로 추정만으로 격리를 판정하지 않는다. |
| 로그·결과 | 실행 루트 아래 `logs/`, `results/` | 검증별 파일명, 시작·종료 시각·PID·exit code·수집 파일/테스트 수를 기록한다. |
| Vite/Vitest | 실행 루트 아래 `vite-cache/`; Vite 최상위 `cacheDir` 지원 사용 | 루트와 각 프로젝트의 실제 resolved `cacheDir`·생성 파일을 확인한다. A의 필요한 작은 실행 helper에서 적용하며 기존 두 프로젝트·alias 설정을 유지한다. |
| Vitest 결과 캐시·config loader | `--no-cache --configLoader runner` | 결과 캐시를 끄고 bundle loader의 `node_modules/.vite-temp` 쓰기를 피한다. 모든 Vite·OS 임시 쓰기가 없어졌다는 뜻은 아니다. 폐기된 `--cache.dir`는 쓰지 않는다. |
| 선택적 filesystem module cache | 기본 비활성 상태 유지 | 이미 켜는 경우에만 설치된 `fsModuleCachePath` 지원으로 실행 루트 안에 두고 실제 값을 기록한다. |
| TypeScript | `--noEmit --incremental false`, 또는 실행 루트 아래 `--tsBuildInfoFile` | 루트 설정은 incremental이 켜져 있다. `scripts/geography/tsconfig.json`은 이미 꺼져 있다. |
| Next dev/build/start | `PAX_BUILD_DIST_DIR=.next-prompt21-<workspaceKey>-<runId>` | 작업트리 안의 별도 경로인지 실제 distDir를 확인한다. 같은 작업트리의 동시 실행도 서로 다른 출력 경로를 쓴다. |
| Next의 루트 보조 파일 | `next-env.d.ts`, `tsconfig.json` include 변경 | 작업 전 diff를 보존하고 Next가 이번 실행에서 추가한 부분만 추적·필요시 되돌린다. 다른 작업의 include나 설정을 일괄 복원하지 않는다. |
| 서버 | 필요한 경우에만 독립된 로컬 포트·프로세스 | 실제 점유 상태를 확인하고 자신이 시작한 서버만 관리한다. 포트 번호·PID는 로컬 배치 기록에 둔다. |
| 환경 설정 | 작업트리별 로컬 `.env*` | 비밀 값·게임 snapshot을 Git이나 인계 문서에 넣지 않는다. |

설치된 Vitest는 `startVitest(..., viteOverrides)`의 네 번째 인자로 `{root, cacheDir}`를 받는다. A는 반복 재현에 필요할 때만 이 지원이나 실행별 config를 사용하는 작은 helper를 만든다. B/C는 아래 예약된 파일 경계와 동일 실행 루트를 사용한다. 임의의 `VITE_CACHE_DIR` 환경변수가 자동 적용된다고 가정하지 않는다. 기본 캐시인 `node_modules/.vite/vitest/<project hash>`는 이번 실행의 관측 경로와 구분한다.

`next.config.ts`에서 `PAX_E2E_BUILD=1` 분기는 `PAX_BUILD_DIST_DIR`보다 나중에 적용돼 고정 E2E distDir로 덮어쓴다. 일반 격리 실행은 **자식 환경에서** 상속된 `PAX_E2E_BUILD`·`PAX_REVIEW_G_E2E`를 제거한다. E2E 실행이 필요하면 별도 계약과 실제 경로 확인이 필요하다.

`process.env` 또는 셸의 전역 설정을 바꾸는 대신 자식 환경의 복사본을 사용한다. A helper의 적용 순서는 실행 루트 생성 → 자식 `cwd`·환경 구성 → 도구 시작 → 해석된 경로·실제 생성 파일 기록이다. Windows의 기본 `npm` 실행 파일이 잘못 해석되면 설치된 Node 옆의 `npm-cli.js`를 해당 Node로 실행한다. 발견한 절대 실행 경로는 로컬 기록에만 둔다.

## 기존 스크립트의 실제 지원 범위

아래는 코드에서 확인한 I/O다. 명령을 실행해 국가 추가·발행을 검증했다는 뜻은 아니다. 상대 출력 경로가 고정된 도구는 run root 변수를 추가했다고 이동하지 않는다.

| 기존 도구 | 실제 I/O·제약 | 작업 배치 |
| --- | --- | --- |
| `scripts/geography/build-current-metadata.cjs --verify <manifest>` | 현재 채택 catalog·원본·코드와 지정 manifest/payload를 읽어 검증 JSON을 stdout으로 출력한다. | 기존 입력의 읽기 전용 검증으로 재사용한다. |
| 위 CLI 무인자 실행, `scripts/geography/metadata-builder.ts` | 전체 활성 catalog를 읽고 `data/derived/geography/<contentRoot>/`에 metadata/admission/manifest/report를 불변 생성한다. **활성 current 포인터는 쓰지 않는다.** | 공통 생산·통합 담당 경로다. 국가 준비용 독립 출력 명령으로 등록하지 않는다. |
| `src/lib/geography/country-metadata-input.ts` | 전달받은 기존 catalog·독립 context와 국가 metadata를 메모리에서 검사한다. 파일·형상을 생성하지 않는다. | 기존 공통 계약 재사용. 국가 준비 성공을 전체 production 채택으로 표시하지 않는다. |
| `scripts/prepare-prompt19-country.mjs <KOR\|PRK>`와 `scripts/prompt19-country-files.mjs` | KOR/PRK만 지원하고 고정 coarse handoff·predecessor를 요구한다. 후보는 `data/derived/prompt19/candidates/<CountryId>/<key>/`에 고정, 출력 root 인자가 없다. 현재 fine 활성 predecessor와 맞지 않을 수 있다. | 범용 후보 생성기로 쓰지 않는다. 재사용 전 실제 전제와 입력 pin을 검증하고 후속 생성 경로 일반화로 인계한다. |
| `scripts/prompt19/KOR/run-candidate.mjs` | KOR 생성기와 고정 `reports/verification/prompt19/KOR/` 보고서 경로를 감싼다. | 새 국가·실행 루트 전환 기능으로 간주하지 않는다. |
| `scripts/prompt19/PRK/normalize-source.mjs`, `scripts/prompt19/KOR/normalize-adm2-source.mjs` | 채택된 국가 원본·정규화·source-lock·증거 경로가 고정돼 있다. KOR 출력은 기존 파일이 있으면 거부한다. | 새 준비 자료의 독립 경로 지원은 별도 adapter 작업이다. 기존 채택 파일을 덮어쓰지 않는다. |
| `scripts/chn-2020/incremental-coordinator.mjs` | CHN 전용이다. `--geometry`, `--geometry-replay`, `--replay-output` 일부 경로를 지원하지만 고정 pointer receipt·Python 임시 경로도 쓰고 형상이 없으면 Python 생성기를 실행한다. 활성 전환은 하지 않는다. | 국가 ID만 바꾸는 CLI가 아니다. 전역 결합·고정 쓰기 분리와 후속 일반화가 필요하다. |
| `scripts/prepare-prompt19-joined-candidates.mjs`, `scripts/publish-prompt19-joined-candidates.mjs` | KOR/PRK 공동 topology와 고정 후보 경로를 쓴다. `--output-prefix`는 준비 스크립트의 보고서만 옮긴다. publish 스크립트는 후보 증거·공용 보고서를 쓰며 활성 pointer 발행은 아니다. | 통합 담당 소유다. 국가별 병렬 준비 경로에서 제외한다. |
| `scripts/prepare-prompt19-mixed-world.mjs` | 전역 패키징이다. 일반 입력은 기본 활성화, incremental 입력은 `--activate` opt-in이다. `--pointer-output`은 pointer 경로만 옮기며 `--no-activate`도 전역 산출물을 생성한다. `--check-input`은 쓰기 전에 종료한다. | 통합 담당만 실제 전제·명령을 검토한다. 국가 준비 공간에서 실행할 기본 명령이 아니다. |
| `scripts/prompt19-country-files.node-test.mjs` | 별도 `node --test` 파일이다. `cwd` 작업트리의 `.tmp/` 아래 무작위 fixture 디렉터리를 만들며 실행 루트 옵션은 없다. | Vitest와 별도 실행한다. 작업트리별 실제 하위 경로와 프로세스를 기록하며, 지정 run root 안에 생겼다고 주장하지 않는다. |

현재 구조는 독립적인 원본·계층·이름 **자료 준비**를 위한 분리가 가능하다는 기준이다. 범용 국가 후보 생성·공유 국경·전역 ordinal·타일·CHN 표시 조립·활성 전환이 완성됐다는 의미가 아니다. 고정 전역 경로를 쓰는 도구를 임의 `--country`·`--output` 옵션으로 설명하지 않는다.

## 공통 재사용 명령과 후속 분기 계약

작업트리 루트에서 현재 geography pointer가 가리키는 manifest를 읽어 검증하는 기존 명령은 다음과 같다. 이 명령은 metadata를 새로 생성하지 않는다.

```powershell
$geographyRegistry = Get-Content -Raw -Encoding UTF8 -LiteralPath 'data/runtime/geography/current.json' | ConvertFrom-Json
node scripts/geography/build-current-metadata.cjs --verify $geographyRegistry.manifest.path
```

기존 Vitest CLI의 지원 인자는 `node node_modules/vitest/vitest.mjs run <test-file> --configLoader runner --no-cache --reporter=json --outputFile.json=<runRoot>/results/vitest.json`이다. **실제 실행 전 A가 자식 temp와 Vite cacheDir를 적용해야 한다.** 위 표의 기본 캐시 경로와 무작위 임시 경로까지 관측해야 격리 근거가 된다. Node test runner는 `node --test scripts/prompt19-country-files.node-test.mjs`로 별도 수집한다. 검사 묶음·필수 데이터·실패 집계는 B가 `verification-baseline-v1.md`에 확정한다.

선택적 helper의 파일명은 충돌을 피하도록 미리 나눈다. 파일은 실제 반복 작업에 필요할 때 해당 담당자가 구현하고, 21-03에서 빈 파일이나 동작하지 않는 플랫폼을 만들지 않는다.

| 분기 | 문서·선택적 helper 예약 | 공통 입력·로컬 출력 |
| --- | --- | --- |
| A / 21-04 | 이 문서의 실제 설정·재현 절차, 필요시 `scripts/workspaces/setup-country-prep.mjs`, `scripts/workspaces/run-verification.mjs` | 공통 인터페이스 커밋·lockfile·B0 pin → 각 작업트리 및 `.tmp/prompt21/workspace-layout.json`·실행 루트 |
| B / 21-05 | `verification-baseline-v1.md`, fixture 보완, 필요시 `scripts/workspaces/audit-current-frontiers.cjs` | 현재 catalog·검증된 선택/commit/undo/redo 로직 → 실행 루트의 세 나라별 결과·전체 실패 집계 |
| C / 21-06 | `country-workspace-handoff-v1.md`, 필요시 `scripts/workspaces/validate-country-handoff.cjs` | 기존 국가 인계 계약·실제 소비 pin·최신 공통 base → 국가·실행별 인계/재검증 근거 |

기존 파일의 최소 보완이 더 적절하면 새 helper를 생략한다. 예약 이름·공통 설정을 바꿔야 하면 공통 담당자가 순차 합류한다. A/B/C는 다른 분기의 미완성 helper를 필수 의존성으로 삼지 않고 기존 공통 helper·자기 파일부터 작업한다.

## A가 실행할 실제 설정·재현 절차의 범위

21-04에서 디스크·경로/branch 충돌·B0/공통 커밋·입력 pin을 재확인한 뒤 실제 작업트리와 독립 의존성을 준비한다. 현재 사용자 지시는 **실제 LFS 복원 문제가 발생하면 그때 필요한 객체만 복구**하는 것이다. 21-02의 3개 복구·14개 보류 기록을 현재 누락 판단으로 대체하거나 캐시 전체를 미리 채우지 않는다.

그 뒤 위 경로 계약을 적용하고 `.tmp/prompt21/workspace-layout.json`에 실제 root·branch·base·도구/lockfile identity, 자식 temp·해석된 cache·Next output·설치 상태·포트를 기록한다. 이 단계의 설정 성공과 21-07의 두 실제 검사 프로세스가 겹쳐 실행된 성공을 구별한다. 21-07은 입력·포인터 보존, 각자의 실제 쓰기 경로, 수집·종료·결과를 함께 확인해야 한다.

**21-03에서는 작업트리·설치·빌드·국가 자료 생성·cache 복구·동시 검사를 실행하지 않았다.** 다음 담당자는 이 공통 규칙에 실제 재현 절차와 관측 결과를 덧붙여야 한다.
