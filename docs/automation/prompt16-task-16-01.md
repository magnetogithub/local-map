# 16-01 공통 catalog 연결

Prompt 16의 16-01 범위만 구현했다. 기본 데이터는 프롬프트에 지정된
15-19 `ae59d85d8dedbafc44f6`, 15-20 `22406931e1665b6ede05`,
15-21 `56fc6c79c216e6bd1a11`이다. 기존 최종 접수 기록이 가리키는
`admitted/verdict.json`과 manifest/source index의 연결을 사용한다.
기존 미해결 감사·수치 보류·sliver 판정을 변경하지 않는다.

## 후속 작업에서 사용할 인터페이스

- `src/lib/world/operational-catalog.server.ts`의 `loadOperationalCatalog()`:
  같은 인스턴스를 재사용하는 서버 loader. `ref`는 기존
  `WorldGeometryCatalogRef` 형식을 유지하며, 추가 membership/order root는
  `descriptor.indexRoots`로 제공한다.
- `loadCountry(countryId)`와 `cell(idOrOrdinal)`:
  원본 cell ID, 전역 양의 ordinal, 원본 국가, 행정 부모 ordinal,
  이전 geometry 부모 ordinal을 조회한다. 아직 읽지 않은 ID/ordinal을
  국가 없이 조회하면 전체 국가 **metadata**를 한 번 읽는다.
- `administrativeParents`, `administrativeMembership(parentKey)`:
  행정 identity와 residual을 구분하고 저장된 membership 전체를 반환한다.
- `previousParents`, `previousMembership(oldTerritoryId)`:
  이전 부모 → 모든 cell 대응. 상태 이전에서는 해당 이전 부모의 현재
  owner/controller를 사용해야 한다. loader 자체에는 mutable world가 없다.
- `neighbors(cellOrdinal)`, `edgeIncidence(edgeOrdinal)`, `edge(edgeOrdinal)`:
  기존 양의 길이 인접 graph, left/right incidence, 원본 edge ID와 길이·분류.
  오른쪽 ordinal `0`은 해안이다. topology shard는 필요할 때 읽으며 최대
  네 개를 캐시한다. 거리와 인접성은 새 geometry로 계산하지 않는다.
- `worldContract()`:
  16-02에서 사용할 전체 catalog contract. 국가 metadata로 원본 순서를
  복원하고 기존 catalog-order root와 맞춘다. 상세 polygon은 읽지 않는다.
- `loadCatalogRegionIndex(ref)`:
  해당 catalog의 한국어/영어 이름·별칭 검색, `listCountry`,
  `lookup(countryId, regionRef)`를 제공한다. `lookup`은 전체 membership을
  반환하고 `resolve`는 기존 512개 행동 제한을 유지한다. ref를 생략하면
  현재 게임의 기존 catalog를 사용한다.
- `src/lib/world/operational-catalog.ts`:
  A/B/C가 전달할 `OperationalWorldView`, `OperationalSelection`,
  `OperationalStateChange`와 cell/edge descriptor 타입.
  현재 상태는 전달받은 world에서 읽고 catalog ref를 맞춘다.

## 서버에서 확인

`npm run dev` 실행 후 `GET /api/world/catalog/operational`에서 새 descriptor와
catalog ref를 확인한다. 이 ref를 `POST /api/world/regions`에 전달한다.
예를 들어 `countryId: "PRK", operation: "occupy", query: "강원"`으로
지역 참조를 찾은 뒤 `query` 대신 반환된 `reference`와
`mode: "membership"`을 보내면 전체 cell 집합을 읽는다.
mode를 생략하거나 `"action"`으로 지정하면 기존 행동 크기 제한을 적용한다.
membership 조회는 권한 부여나 상태 변경을 수행하지 않는다.

## 남은 연결

16-02의 상태 초기화·이전, 16-04의 asset route와 v3 지도 consumer,
16-06의 현재 전선 기반 범위 선택이 이 기반을 사용한다.
`ref.manifestPath`는 16-04가 제공할 버전별 asset 주소이며 이 작업에서는
해당 asset route를 추가하지 않는다. 기존 게임/지도 bootstrap은 유지된다.
provider의 catalog 선택 및 실제 턴 통합은 16-07/16-08에 남아 있다.
production build와 직접 플레이 확인을 포함하는 최종 확인은 16-09 범위다.

## 수행한 확인

- `node node_modules/typescript/bin/tsc --noEmit`
- 새 loader·API와 기존 지역 조회 테스트: 3개 파일, 10개 테스트 통과.
- 변경한 TypeScript 파일의 ESLint 확인.

실제 외부 API 호출, production build, 게임 화면의 부분 점령 확인은
이번 공통 기반 작업에서 수행하지 않았다.
