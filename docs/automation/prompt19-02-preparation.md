# Prompt 19-02 공통 준비 계약

이 문서는 19-02 준비 시점의 v1 절차 기록이다. C 통합 후 현재 상태·v2 잔여 정책·실행 명령은 [19-02 C 결과](../../reports/maintenance/20261029-prompt19-02-C.md)와 `reports/maintenance/prompt19-handoff.json`을 따른다. 기존 국가 단독 clipping CLI는 실패 비교용이며 현재 통합 생성기는 `npm run data:korea`다.

19-01 완료 상태에서 C가 준비한 계약이다. 기준은 `reports/maintenance/prompt19-handoff.json`이며 A/B는 이를 읽고 자기 국가 분기만 수행한다. 이 준비 작업은 실제 미세 자료 확보·국가 후보 생성·최종 연결을 수행하지 않는다.

## 고정 입력과 역할

- 기본 앱은 `catalog-v3-prompt19-coarse-v1`(247개국, 4,231 territories, 15,955 edges)을 유지한다.
- `data/derived/prompt19/baseline-v1/country-envelopes.geojson`: 승인된 Prompt 14 `shared-game-p0.geojson`에서 KOR/PRK를 좌표 변경 없이 추출했다. EPSG:4326, `[경도, 위도]`, 2D이다.
- `coarse-parents.geojson`: 현재 coarse 18개 KOR·11개 PRK 영토와 부모 대응을 그대로 추출했다. `coarseTerritoryId`는 기존 영토 참조이고 `parentKey`는 Natural Earth `ne_id`를 기반으로 한다. 다른 데이터셋의 부모 코드와 같다고 추정하지 않는다.
- `national-boundaries.geojson`: 양국에 접한 국가 경계의 현재 전체 chain이다. KOR–PRK 공유 경계는 3개 chain이다. A/B는 이를 이동·단순화·독립 snap하지 않는다. C만 합류 때 같은 chain에 새 교차점을 node하고 공유 topology를 확정한다.
- 한국의 별도 `country-envelope-residual` 섬 component와 모든 외곽 component·hole을 보존한다. ADM1 대응이 없다고 제거하거나 인근 행정 구역으로 추정하지 않는다.
- 원본·source-lock·Prompt 14·15-18 행정 준비 입력·기존 승인 증거·19-01 coarse 출력은 보존한다. 구 격자 재생성은 금지한다.

## A/B 파일 소유권

| 분기 | 수정·생성 가능 경로 |
| --- | --- |
| A / KOR | `data/raw/prompt19/KOR/**`, `data/source-locks/prompt19/KOR.json`, `data/derived/prompt19/candidates/KOR/**`, `reports/verification/prompt19/KOR/**`, `scripts/prompt19/KOR/**` |
| B / PRK | 같은 경로의 `PRK` 범위 |
| C | 공용 생성기·이 계약·baseline·최종 catalog/전역 ID·공유 경계·runtime·공통 테스트·build·서버·브라우저 |

국가별 adapter는 원본→정규화 GeoJSON과 입력 identity만 준비한다. 공용 생성기를 복제하거나 공유 파일을 수정하지 않는다. 공용 코드 수정이 필요하면 C에 재현 입력과 이유를 인계한다. C 포함 동시 담당자는 최대 3명이다.

## 원본과 정규화 입력

실제 세부 원본과 허가를 확인한 후 `data/source-locks/prompt19/<COUNTRY>.json`을 작성한다. 거짓 placeholder lock을 만들지 않는다. 정확한 기계 schema는 `scripts/prompt19-country-core.mjs`의 `prompt19SourceLockSchema`다.

필수 lock 항목:

- `schemaVersion: "prompt19-country-source-lock-v1"`, `countryId`, `normalizedCrs: "EPSG:4326"`.
- `sources[]`: `sourceId`, 원본 `url`, `version`, `publishedAt`(알 수 없으면 null), `retrievedAt`(ISO datetime), `boundaryBasis`, `adminLevel`, `temporalCoverage`, `scenarioDateCaveat`, `originalCrs`, 원본 `artifact` identity.
- `license`: 이름·URL·attribution과 확인한 `redistributionAllowed: true`. 미확인 허가를 true로 추정하지 않는다.
- `boundaryBasis: "administrative"`는 실제 ADM2 이상인 경우만 허용한다. 명시적으로 확보한 지형 근거를 쓸 때는 `"documented-natural"`, `adminLevel: null`과 feature별 `boundaryEvidenceRef`가 필요하다. 추측한 선·Voronoi·새 격자는 금지한다.
- `normalizedInput`: 국가 raw 경로 안의 정규화 GeoJSON identity.
- `preprocessing`: 변환 설명과 `scripts/prompt19/<COUNTRY>/**`의 adapter 코드 identity 배열. 좌표변환·행정 부모 대응·경계 선택의 이력을 국가 보고서에 남긴다.
- 모든 artifact identity는 `{path, sha256, byteLength}`다. paths는 저장소 상대 forward-slash 경로다. 원본·정규화 데이터는 자기 국가 raw 경로에만 둔다.

정규화 입력은 `FeatureCollection`이며 각 feature는 실제 원본 `Polygon | MultiPolygon`과 다음 properties를 가진다. 필드는 다른 이름으로 바꾸지 않는다.

```json
{
  "countryId": "KOR",
  "sourceId": "source-lock의 sourceId",
  "sourceFeatureId": "원본의 안정된 feature 식별자",
  "sourceParentId": "원본 행정 부모 식별자 또는 null",
  "name": "원본 명칭 또는 null",
  "boundaryEvidenceRef": null
}
```

같은 sourceId/sourceFeatureId를 여러 feature로 쪼개 열거하지 말고 원본 MultiPolygon identity를 유지한다. 공용 생성기가 실제 component·기존 coarse 부모와의 교차 결과를 추적한다. 파일명에 쓰인 `10m`을 10m 공간 해상도로 해석하지 않는다. 현재 로컬 Natural Earth ADM1을 미세 자료로 재분류하지 않는다.

## 공용 후보 생성

입력 확보 후 해당 분기에서 한 번 실행한다. 준비 단계에서는 실행하지 않았다.

```powershell
node scripts/prepare-prompt19-country.mjs KOR
node scripts/prepare-prompt19-country.mjs PRK
```

CLI는 lock·정규화 입력·원본·adapter·공용 코드·baseline의 hash와 byte length를 확인한다. 공용 generator pin이 달라졌으면 C가 계약을 갱신해야 한다. 자기 국가의 새 content-key 출력 디렉터리만 만들고 기존 출력을 덮어쓰지 않는다. runtime 포인터·public·seed는 수정하지 않는다.

공용 처리 규칙:

1. 실제 세부 polygon의 ring 방향·시작점·순서만 정규화한다. 좌표 반올림·단순화·buffer·자동 repair를 하지 않는다.
2. 각 실제 source component와 고정 coarse 부모 polygon을 교차한다. centroid·이름·가까운 이웃으로 행정 귀속을 추정하지 않는다. 새 source가 기존 ADM1을 가로지르면 공통 교차 규칙으로 나누고 원본 부모와 coarse 부모를 모두 기록한다.
3. 연결된 polygon component별 `KOR:cell:<sha256>` 또는 `PRK:cell:<sha256>` local ID를 만든다. hash에는 국가·원본 identity/version·coarse 부모·geometry가 들어간다. 입력 열거 순서는 ID에 영향을 주지 않는다. 최종 TerritoryId·ordinal·catalogRef는 만들지 않는다.
4. 기존 Prompt 14 robust noder를 재사용하여 양의 길이 내부 경계와 양방향 adjacency를 만든다. 점 접촉·바다 건너 인접·self edge는 만들지 않는다. `envelope-contact`는 국가 외곽 접촉을 뜻하며 coastline으로 단정하지 않는다.
5. 누락·중복·외곽 이탈·부모 coverage, 개별 source component의 대응, hole, 행정 부모 내부의 서로 다른 복수 source feature, 전체 boundary pairing을 검사한다. 면적 tolerance만으로 tiny island 누락이나 미접합 선을 통과시키지 않는다.
6. 남은 geometry는 `residuals.geojson` 진단으로만 남긴다. 자동 filler cell이나 구 coarse fallback으로 통과시키지 않는다. 실제 자료가 없는 섬·행정 구역·외곽 불일치는 C에 근거와 위치를 인계한다.

후보 출력은 `data/derived/prompt19/candidates/<COUNTRY>/<content-key>/`다.

| 파일 | 내용 |
| --- | --- |
| `cells.geojson` | local ID, 원본 feature/component·부모 lineage, coarse 부모와 실제 polygon |
| `topology.json` | local edge ID, left/right local ID, 완전한 선 geometry·lengthKm, 양방향 adjacency. boundary 실패 시 null |
| `residuals.geojson` | 외곽 기준의 미충족 영역 진단. 플레이 단위로 사용하지 않음 |
| `validation.json` | 검사별 결과, 부모 membership 명시 배열, source/component 대응, cells/edges/vertices/components/holes/bytes |
| `manifest.json`, `artifact-index.json` | 입력·코드·baseline identity, 후보 status, 출력 identity |

`ready-for-coordinator-integration`은 해당 국가 후보 검사 통과만 뜻한다. 실패는 `needs-source-or-alignment`와 exit code 2로 반환한다. 한 국가의 성공으로 19-02 연결/19-03 통과를 선언하지 않는다. 부모 membership은 명시 ID 배열이며 `start/count`나 국가별 연속 ordinal을 가정하지 않는다.

## C 합류와 남은 검증

C가 양국 후보를 인계받은 뒤 전체 국가 외곽·KOR/PRK 및 CHN/RUS 접경의 공통 noding을 수행하고 새 catalog/version·전역 ID/ordinal·hash·membership을 한 번에 확정한다. 기존 다른 245개국 coarse geometry를 그대로 재사용한다. 기존 `prepare-coarse-operational-world.mjs`는 19-01 전용이므로 fine 후보를 그 파일에 억지로 붙이거나 구 버전을 덮어쓰지 않는다. 최종 mixed catalog transport와 새 seed/API/runtime 연결은 합류 때 C가 구현한다.

저배율은 이어진 국가 면을 표시하고 작은 fine polygon을 개별 cull해서 바다색 구멍을 만들지 않는 정책이 필요하다. 실제 viewport 면적 coverage, 상세 배율, authoritative 변경 geometry·전선, 양방향 부분 점령/연속 진격/undo·redo·성능은 19-02 연결과 19-03의 필수 후속 검사다. 준비 fixture의 성공으로 이를 검증했다고 보고하지 않는다.
