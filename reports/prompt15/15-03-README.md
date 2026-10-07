# Prompt 15 — 15-3 실행 결과

REVIEW B: **pass**. 접경 12km / 내륙 24km 격자 후보 adaptive-12-24를 선택했다. 11개 국가에서 실제 source polygon을 분할하고, 선택 후보를 별도 프로세스에서 두 번 생성했다. geometry·topology·membership·measurements bytes와 모든 PBF 타일 SHA/길이 root가 일치했다. 전 세계 생성·runtime 적용은 다음 단계다.

정책과 통과 기준은 첫 실험 전에 [고정](15-03-predeclared-policy.json)했다. 접경은 지름 19km·면적 150km² 이하, 내륙은 36km·600km² 이하이다. 대표 진격 깊이 W=120km에 대한 지름 비율은 0.3 이하이고, limited는 최소 3단계의 graph 깊이를 요구한다. near 깊이/폭은 36/36km, limited는 120/96km, deeper는 240/192km이다. 최대 면적은 각각 2,800/22,000/80,000km²이다. 8,000km² 이상 부모에서 near 점령은 35% 이하, 잔여는 65% 이상이어야 한다. cap 512 초과는 요청 전체를 거절하며 목록을 잘라 성공시키지 않는다.

실제 국경 선분 주변 48km의 보수적 envelope에 닿는 24km 상자를 12km로 세분한다. 해안선 자체는 세분 조건이 아니다. 고위도에서는 위도 띠 내 최대 cos(latitude)로 경도 개수를 정하며 날짜변경선과 극지 행을 명시한다. 물리 면적은 authalic sphere로 계산한다. 측량 수준의 타원체 계산이 아니며 graph 거리·방향 corridor도 정확한 geodesic 점령 띠는 아니다.

| 국가 | 보존 부모 수 | cell 수 | 접경 최대 지름 km | 전체 최대 지름 km | PBF 총 KiB |
|---|---:|---:|---:|---:|---:|
| KOR | 18 | 604 | 16.97 | 33.94 | 298.82 |
| PRK | 11 | 876 | 16.97 | 33.94 | 485.12 |
| SVN | 193 | 793 | 16.97 | 16.97 | 290.15 |
| HRV | 21 | 866 | 16.97 | 29.07 | 402.03 |
| KEN | 8 | 2648 | 16.97 | 33.94 | 1,354.63 |
| TZA | 30 | 3910 | 16.97 | 33.94 | 1,891.46 |
| KAZ | 17 | 9523 | 16.97 | 33.94 | 5,747.3 |
| FIN | 18 | 1875 | 16.97 | 33.94 | 1,157.44 |
| FJI | 5 | 141 | 0 | 33.94 | 79.25 |
| LUX | 3 | 45 | 16.96 | 16.96 | 19.34 |
| ZAF | 9 | 4389 | 16.97 | 33.94 | 2,321.81 |

SVN은 복원된 193개 identity를 그대로 부모로 사용한다. 다른 대륙의 KEN/TZA, 큰 내륙 KAZ, 고위도 FIN, 날짜변경선·섬 FJI, 작은 국가 LUX, HRV/ZAF도 포함했다. 모든 표본은 부모/component 보존·geometry·coverage·양의 길이 adjacency 기준을 통과했다. 점 접촉은 adjacency가 아니다. sliver는 버리지 않고 목록과 면적을 보존했다. tiny 예외는 source component 면적 1km²·지름 8km 이하로만 정의하고 국가명 예외를 두지 않았다. [예외 목록과 계약](15-03-downstream-contract.json)의 각 measurement 파일에서 개별 cell을 확인할 수 있다.

uniform-12는 표본 해상도/행동을 통과했지만 전 세계 비용 추정이 예산을 넘었다(약 155만 cell). uniform-24는 비용을 통과했지만 10개 국가에서 접경 지름/면적 기준을 실패했다. 선택 후보의 다음 값은 **표본 기반 전 세계 추정**이며 실제 전 세계 bytes나 브라우저 초기 heap 측정값이 아니다.

| 비용 | 전 세계 추정 | 사전 예산 |
|---|---:|---:|
| clientInitialHeapBytes | 985,017,862 | 1,073,741,824 |
| initialConstructionMs | 2,487 | 20,000 |
| initialMetadataBytes | 191,795,030 | 230,686,720 |
| initialStateBytes | 244,760,630 | 335,544,320 |
| renderBytes | 457,893,260 | 536,870,912 |
| serverInitialHeapBytes | 1,477,526,793 | 1,610,612,736 |
| worldCells | 724,382 | 1,000,000 |
| worldEdges | 1,952,097 | 4,000,000 |
| worldVertices | 11,569,563 | 24,000,000 |

추정은 물리 면적·부모 둘레·국경 세분 띠의 보수적 식과 표본 밀도 외삽 중 큰 값을 사용한다. bytes/vertices/edges는 관측된 최악의 cell당 비용을 적용했다. 새 Node 프로세스에서 현재 state/metadata 형태를 파싱·보존한 heap proxy에 client 2배/server 3배 여유를 적용했다. client 약 939MiB로 예산 여유가 작다. 전 세계 실제 생성과 runtime projection/validation/브라우저에서 비용이 증가하면 정책을 다시 검토해야 한다.

현재 전선에서 첫 near·두 번째 near를 실제 양의 길이 graph로 선택했다. KOR/PRK를 비롯한 각 표본의 모든 인접 국가 방향을 검사했다. 큰 부모 안의 점령/미점령 공존과 두 번째 선택의 분리·현재 전선 접촉을 확인했다. [요약 예시](15-03-frontier-examples.json) 및 국가별 summary의 실제 ID 목록이 근거다. 이것은 offline geometry/graph 실험이며 gameplay screenshot이나 production tool/API 성공 증거는 아니다.

ID는 정책·후보·고정 source 부모/hash·canonical geometry로 만든 SHA-256이다. owner/controller·locale·실행 순서에 의존하지 않는다. PBF에는 고정 catalog 순서에 연결된 정수 ID를 넣어 긴 SHA 반복 비용을 줄였다. 15-4/15-5에서 metadata·topology·tile 간 ordinal 매핑 계약을 구현해야 한다. 행정 identity와 synthetic cell을 혼동하지 않는다. 기존 512개 region record 제한은 큰 부모의 전체 membership을 수용하지 못한다. 전체 membership용 compact index/페이지 계약과 per-action 512 cap을 별도로 구현해야 한다.

[검증 로그](15-03-validation.json): Node 물리/실제 접경/연속 전선/cap/독립 bytes 테스트, 관련 Vitest 회귀 테스트, TypeScript, 전체 ESLint, 격리된 새 production build를 실행했다. [REVIEW B](15-REVIEW-B.json)는 정책 결과뿐 아니라 이 검증의 상태도 반영한다. 모든 입력/output SHA와 byte length는 [정책 결정](15-03-policy-decision.json), 국가별 summary/render-index 및 execution JSON에 기록했다. 초기 실패는 implementation-attempt 파일과 초기 execution 기록에 남아 있다. 후속 graph 검증 및 Windows 상대 tile 경로 root 수정은 별도 [재검증](15-03-experiment-rechecks.json)에 기록했다. 실제 PBF bytes는 바뀌지 않았다.

재실행: `node scripts/audit-prompt15-cells.mjs first`, `node scripts/audit-prompt15-cells.mjs second adaptive-12-24`, `node scripts/recheck-prompt15-cell-experiments.mjs`, `node scripts/audit-prompt15-cells.mjs review`, `node scripts/verify-prompt15-cells.mjs`. first는 새 실험 시작 snapshot을 기록하므로 기존 결과와 provenance를 보존한 별도 작업 환경에서 재실행해야 한다.

재개 위치는 **15-4**다. 아직 미해결인 stage A의 12개 source-backed fallback 복구 차단 조건을 유지한다. 모든 국가의 복원 행정 경계와 기존 territory를 protected overlay로 공통 세분하고 실제 world bytes/coverage/topology/membership/tiles를 독립 생성해 검증해야 한다. 생산 catalog 변경·migration·tool-loop token 비용·live API·browser E2E·runtime 점령/undo/redo·cutover는 이번 단계에서 수행하지 않았다. 기존 source/catalog/reports와 작업 시작 시 수정된 application 파일의 hash는 보존 검사를 통과했다.

현재 요청의 재검증: `node scripts/verify-prompt15-cells.mjs`와 `node scripts/review-prompt15-b.mjs`를 새로 실행했다. Node 검사, 관련 Vitest, 타입, 린트, 격리 production build가 모두 통과했다. 독립 검토는 11개 국가의 현재 물리 측정·membership·연속 진격 및 PBF 950개 hash/길이를 확인했다. [독립 검토 보고서](15-review-b-recheck.json)에 명령·입력 hash·상태를 기록했다. 기존 생성 근거와 사전 고정 정책을 보존했으며 이번 재검증에서 전체 후보를 다시 생성하지 않았다.
