# 프로젝트 용량 분석 — 2026-10-28

측정 시각: 2026-10-28 15:26 KST. 대상: `D:\gen`.

총 **352,609,891,649 바이트 = 328.39 GiB**, 파일 **2,545,321개**, 디렉터리 **495,306개**다. 읽기 오류는 없었다. 파일의 논리 크기를 합산했으며 junction·symlink 대상은 중복 집계하지 않았다. 실제 디스크 할당량과는 차이가 있을 수 있고 실행 중 빌드 파일은 변할 수 있다. 이 보고서는 측정 후 추가했다. 기존 프로젝트 데이터의 수정·삭제는 하지 않았다.

## 용량 분포

| 경로 | GiB | 전체 비중 | 사용 목적 |
| --- | ---: | ---: | --- |
| `reports` | 292.80 | 89.16% | 과거 검증용 데이터 복제본, 실행·감사 증거, rollback 자료, 현재 접수 기록 |
| `.tmp` | 16.32 | 4.97% | 이전 패키지·독립 복원 프로젝트, 회귀 테스트, 임시 빌드 |
| `data` | 11.28 | 3.44% | 현재 영토 catalog와 topology, 지도 원본, 과거 후보·실험·staging |
| `.git` | 6.31 | 1.92% | Git 이력 및 LFS object 사본 |
| `.next`, `.next-e2e`, `.next-e2e-review-g` | 1.00 | 0.30% | 개발·production·E2E 빌드 결과와 캐시 |
| `node_modules` | 0.54 | 0.16% | 설치된 실행·개발 의존성 |
| `public` | 0.10 | 0.03% | 지도 asset·글꼴·기존 catalog 전달 파일 |

`src`와 `scripts`의 합은 **5.70 MiB**다. `checkpoints`는 **4.91 MiB**, `screenshots`는 **26.96 MiB**, `test-results`는 45바이트다. 이들의 정리는 전체 용량에 거의 영향을 주지 않는다.

## 가장 큰 원인: 과거 실패 검증용 전체 복사본

`reports/prompt15/orchestration`가 **254.59 GiB**다. 특히 2026-10-12 실행의 rounds `0014-B`, `0015-B`, `0018-B`, `0019-B`에 있는 음성 테스트 fixture 13개 트리의 현재 합계는 **228,404,043,989바이트 = 212.72 GiB**, 파일 **1,470,724개**다. 전체 프로젝트의 약 **64.78%**다.

검증 스크립트 `reports/prompt15/orchestration/20261012T174318-KST-e35a6937/rounds/0015-B/verification/cli-negatives/run-prompt15-r37-cli-negatives.mjs`의 48번째 줄은 각 테스트마다 `fs.cpSync(base, d, {recursive:true, ...})`로 기준 데이터를 복사한다. 그 뒤 일부 파일만 바꿔 ID 중복·변조·누락 등을 검사한다. 작은 결과 보고서뿐 아니라 지도 원본·mesh·world·PBF를 사례마다 반복 저장한 구조다.

| 대표 경로: 위 실행의 `rounds/` 아래 | GiB |
| --- | ---: |
| `0014-B/implementation/negative-fixtures` | 38.48 |
| `0015-B/verification/cli-negatives/negative-fixtures` | 38.48 |
| `0018-B/implementation/negative-fixtures` | 38.48 |
| `0019-B/verification/negative-fixtures-resumed-v9` | 31.88 |
| `0018-B/implementation/role-negative-fixtures` | 22.23 |
| `0019-B/verification/role-negative-fixtures` | 22.23 |

13개 트리의 정확한 전체 경로·바이트·파일 수는 동봉한 `inventory.json`에 있다. 이 수치는 10월 14일 보고서를 단순 재사용한 것이 아니라 이번 전체 스캔과 필요한 하위 폴더 재측정으로 대조했다.

그 외 `reports/prompt15/review-c-r3`~`review-c-r6`은 합계 **25.18 GiB**다. 과거 검증·후보·반복 실행 자료로, 현재 게임 입력과 구분하여 보관 여부를 정할 수 있다. `reports/maintenance/20261014-prompt14-rollback`에도 **2.10 GiB**가 남아 있다.

## 데이터 11.28 GiB의 구성

| 항목 | GiB | 판단 |
| --- | ---: | --- |
| Prompt 15 숨김 staging 12개 | 5.29 | 성공 시 정식 경로로 전환하는 생성기의 잔여 산출물. 생성 작업 종료·참조 여부 확인 후 정리 후보 |
| 과거 `data/catalogs/prompt15/catalog-v2-d8ac…` | 2.09 | review가 FAIL이고 productionCutover=false인 과거 후보 |
| sliver draft 15-19·20·21 | 1.20 | 현재 Prompt 16 기본 데이터가 아닌 실험 출력. 이력 보관 후 정리 후보 |
| 현재 Prompt 16 고정 데이터 세 종류 | 1.06 | 실행 필수. 보존 |
| 이전 15-19 catalog 세 종류·15-20 topology | 0.98 | 재생성·provenance 이력. 삭제하면 과거 재현 경로가 끊길 수 있음 |

현재 필수 세 종류의 정확한 경로와 크기는 다음과 같다.

- `data/derived/prompt15/15-19-operational-catalog-v3-ae59d85d8dedbafc44f6`: **220,492,138바이트** — cell ID·geometry·metrics.
- `data/derived/prompt15/15-20-topology-membership-v1-22406931e1665b6ede05`: **391,814,685바이트** — 인접성·행정 membership·이전 부모 mapping.
- `data/derived/prompt15/15-21-world-delivery-v1-56fc6c79c216e6bd1a11`: **524,081,048바이트** — 지도 tile·exact detail·metadata.

합계는 **1,136,387,871바이트**다. `src/lib/world/operational-catalog.server.ts:10`에 이 경로들이 명시적으로 고정되어 있다. 기존 Prompt 14 catalog·consumer·public asset은 초기 seed와 이전 상태 지원에서 참조되며, `data/raw` 원본 일부도 지역명 resolver가 읽는다.

staging 중 **2,267,384,470바이트 / 1,683개 파일**은 이미 Git 추적 대상이다. `.gitignore`에 포함되어도 기존 추적은 사라지지 않는다. staging 전체를 단순 미추적 캐시로 취급하면 안 된다. 실행 중 생성기 여부는 확인하지 못했으므로 정리 시 확인해야 한다.

## 임시 이전 사본과 Git 저장 공간

`.tmp/prompt15-transfer-20261019`는 **11.13 GiB**다. PC 이전용 bundle·압축본·다운로드 확인본·독립 복원 프로젝트가 반복 보관되어 있다. `independent/root`는 현재 개발 루트와 별개인 검증용 복원 사본이다. 최종 이전 패키지와 검증 기록 한 벌을 보관하면 중복 해제본과 옛 release를 정리할 수 있다.

보관 후보인 `.tmp/prompt15-relocation/release-final`의 압축본 `prompt15-transfer-objects-001.tar.gz`는 336,123,565바이트, `manifest.json`은 20,612,766바이트다. `SHA256SUMS.txt`·검증·게시 기록도 함께 보존한다. 원격 다운로드 가능 여부는 이번 조사에서 검증하지 않았다.

`.git/lfs`는 **3.03 GiB**, Git object/pack은 약 **3.28 GiB**다. 작업 폴더 데이터와 별도 사본이므로 작업 파일을 삭제해도 이 공간은 함께 줄어들지 않는다. Git/LFS 정리는 원격 보존·복구 가능성을 확인한 뒤 별도 작업으로 다룬다.

## 정리 순서와 보존 범위

1. 과거 음성 테스트 복제본 **212.72 GiB**부터 검토한다. 판정·명령·종료 코드·입력 hash·변경 증거·재현 방법과 기준 데이터 한 벌을 남긴 뒤 전체 복사본을 축소하거나 별도 저장소로 옮긴다. 과거 payload를 제거하면 해당 실행의 완전한 재개 가능성도 바뀌므로 기록에 반영한다.
2. 이전 패키지 중복 사본 **11.13 GiB**와 과거 review 자료 **25.18 GiB**는 필요한 최종 패키지·기록을 보관한 뒤 정리한다.
3. staging **5.29 GiB**, 실패한 옛 catalog **2.09 GiB**, 미승인 draft **1.20 GiB**는 실행 중 작업·Git 추적·재생성 이력 참조를 확인하여 정리한다.
4. `.next*` 합계 **1.00 GiB**는 관련 서버·테스트를 중지한 뒤 지우면 재생성할 수 있다. 현재 개발에 필요한 `node_modules`는 유지해도 용량 부담이 작다.

`reports` 전체를 삭제하면 안 된다. 현재 코드가 아래 기록을 직접 읽는다.

- `reports/prompt15/15-21-final-join/20261027T122926152KST-receipt-intake/final-admission.json`
- `reports/prompt15/15-21-final-join/20261027T122926152KST-receipt-intake/admitted/verdict.json`
- `reports/prompt14/14-08-immutable-catalog-checkpoint.json`

`data`·`public`도 전체 삭제 대상이 아니다. junction을 따라가 연결 대상까지 삭제하지 않도록 실제 정리 시 경로를 구분해야 한다.
