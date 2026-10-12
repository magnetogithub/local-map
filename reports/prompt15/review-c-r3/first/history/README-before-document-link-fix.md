# PROMPT 15 — 15-4 REVIEW C revision r3

REVIEW C: **FAIL**. 범위는 REVIEW C까지이며 production cutover와 15-5/15-6 실행은 하지 않았습니다. 새 immutable 후보는 `catalog-v2-d8acba55778c3e3eb65e368aeb8afd85`입니다. 실패 후보도 실제 bytes와 artifact index를 보존하며 승인된 catalog로 취급하지 않습니다.

원본 4,596 identity의 source bytes·이름·polygon·component·hole·provenance를 원본 계층에 보관합니다. 게임 계층은 고정 P0 안으로 clipping하고, 원본↔게임 component 관계와 hash, 제거 면적, 추가 정합 면적·변위, residual 및 사유를 별도로 기록합니다. 활성 geometry 보존과 원본 보관의 무손실성을 구별합니다. 완전 외부 identity 처리도 실제 외부 component를 사용한 비활성 fixture로 검사했습니다.

| 국가 | 원본 identity | 활성/비활성 | 내부/부분/외부 component | clipping 제거 km² | residual km² | unresolved |
|---|---:|---:|---:|---:|---:|---:|
| ALD | 11 | 11/0 | 17/0/0 | 0.00000000 | 455.13493042 | 0 |
| CHL | 16 | 16/0 | 170/8/0 | 0.00090397 | 1404.26922858 | 0 |
| CSI | 1 | 1/0 | 1/0/20 | 0.83333585 | 0.00000000 | 0 |
| CYP | 5 | 5/0 | 5/3/0 | 341.01678191 | 0.00013293 | 0 |
| FSM | 4 | 4/0 | 20/0/1 | 44.57666638 | 0.00000000 | 0 |
| IMN | 1 | 1/0 | 1/0/1 | 2.45618854 | 0.00000000 | 0 |
| PAN | 12 | 12/0 | 21/6/1 | 0.91216779 | 0.00008638 | 0 |
| PHL | 118 | 118/0 | 160/38/2 | 66.63378545 | 204.94222381 | 0 |
| SGS | 1 | 1/0 | 12/0/5 | 36.46231243 | 0.00000000 | 0 |
| SVN | 193 | 193/0 | 187/6/0 | 0.00877938 | 0.00003358 | 0 |
| TON | 5 | 5/0 | 10/0/1 | 15.05821190 | 0.00000000 | 0 |
| URY | 19 | 19/0 | 11/8/0 | 0.00052309 | 2.82802594 | 0 |
| WLF | 3 | 3/0 | 1/2/1 | 30.07099838 | 0.00021480 | 0 |

기존 원본/게임 component·hole 수 동일 조건은 명시적으로 대체했습니다. 원본 계층에서 수와 bytes를 보존하고, 게임 계층에서는 고정 P0 교집합과 관계 기록을 검사합니다. REVIEW B 해상도·범위·sliver·메모리·bytes 기준은 변경하지 않았습니다. 원본 identity 삭제나 외부 component 이동을 허용하는 변경이 아닙니다.

최종 operational 생성기는 기존 source 경계 보정/접촉 기반 행정 귀속 루틴을 호출하지 않습니다. 기존 territory protected overlay로 나눈 고정 게임 geometry를 같은 24/12km grid와 교차하고 1e-12 수치 noding을 수행합니다. 고정 수치 표현에서 붕괴하는 양의 cell은 동일 행정 identity·부모·component 안의 실제 공유 경계와 면적 보존이 증명되는 경우에만 합칠 수 있습니다. 증명할 수 없는 cell은 원래 양의 geometry를 진단 후보에 보존하고 numericRepresentation 검사에서 실패시킵니다. 원본 입력과 clipping geometry의 union, 기존 부모, 실제 membership, stable ID 및 모든 PBF ordinal을 독립 검증하며, 검증 예외도 국가별 실패 증거로 기록합니다.

전 세계 실제 cell/vertex/edge: 509,778/4,374,708/2,163,071. 실제 tile bytes: 365,134,376. cell geometry/vertex 좌표 JSON/topology/metadata/state의 byte length, 프로세스 최대 RSS 및 생성 시간은 [검토 JSON](15-REVIEW-C.json)과 국가별 summary에 있습니다. 추정치나 표본값을 전 세계 성공으로 표시하지 않았습니다.

두 독립 생성의 전체 10,213 indexed artifact bytes 및 roots 비교: **pass**. 원본·활성 게임 geometry/membership 독립 검증: **fail/fail**. 테스트·타입·린트·격리 build: **pass**. 초기 전체 회귀 테스트의 병렬 시간 제한 실패와 제한 변경 없이 수행한 7개 묶음/45개 테스트의 성공 재실행을 모두 보존했습니다.

실패 gate: worldCatalogs, independentSourceGeometryMembershipValidation, initialTimeAndMemory. 국가별 유지된 실패 조건과 실제 수치는 [검토 JSON](15-REVIEW-C.json), 전체 topology 오류와 누락 source 경계는 [topology 검사](first/world/topology-validation.json), 실제 PBF 누락 ordinal은 [render 검사](first/world/render-ordinal-validation.json)에 있습니다. 실패를 숨기거나 원본 이동·허위 행정 귀속으로 통과시키지 않았습니다.

이전 REVIEW C 실패 보고서는 원래 위치에 그대로 있습니다. 입력 생성의 산술 판정 실패(절대 좌표 shoelace/Number.EPSILON)는 엄격한 양의 면적 계산과 독립 JSTS 검사로 재검사했으며, 면적·변위 허용치를 늘리지 않았습니다. 초기 입력·source-repair 생성·미완료 실행·최대 RSS 재검사 자료는 history에 보존했습니다. 두 실행 모두 동일한 버전 고정 계약과 수치·물리 한도를 적용했습니다. 생성 도중 추가된 붕괴 진단 처리는 실패 국가에 재실행했고, 국가별 실행의 초기 generator SHA와 전체 명령·시간·RSS를 보존했습니다. 최종 산출물의 동일성은 전 세계 실제 bytes 비교 결과로 판정합니다.

REVIEW B의 1% sliver 면적 한도는 SOURCE-tiny cell의 면적도 포함하는 고정 조건입니다. CSI/VAT처럼 P0 전체가 tiny인 경우 원본과 P0를 보존하면 이 비율이 100%가 되므로 해당 조건은 실패로 남깁니다. tiny 예외는 비SOURCE sliver 개수에만 적용하며, 면적 한도를 변경하지 않습니다. 범위·폭·깊이·512 전체 거부 정책은 고정 B 정책을 그대로 참조합니다. 초기 메모리/시간 측정은 전체 실제 offline Node metadata/state/ID-map 구성 측정이며 browser 또는 production tool 성공을 주장하지 않습니다.

[변경 계약](first/contract.json) · [원본↔게임 geometry 관계](first/geometry-correspondence.json) · [독립 bytes 비교](independence.json) · [배포 보존 검사](protected-inputs-and-deployment.json) · [최종 검증](validation-final.json) · [immutable 후보 artifact index](../../../../data/catalogs/prompt15/catalog-v2-d8acba55778c3e3eb65e368aeb8afd85/artifact-index.json)
