# 16-05 점령색·전선·경계와 incremental projection

16-04의 v3 delivery/source를 사용하는 B 분기 renderer를 구현했다.
world나 simulation을 별도로 저장하거나 변경하지 않고, 호출자가 전달한
authoritative world와 `OperationalStateChange`를 읽는다. 원본/승인 데이터와
기존 게임 bootstrap은 변경하지 않았다.

## 후속 통합에서 사용할 인터페이스

`src/lib/map/operational-map-consumer.ts`:

```ts
// MapLibre style load 이후 호출한다.
const consumer = await createOperationalMapConsumer({
  map, protocolApi: maplibre, delivery, world,
  onSelect, onHover, onTerritorySelect,
});
await consumer.updateWorld(nextWorld, stateChange);
// undo/redo snapshot도 증가한 runtime revision을 가진 같은 경로로 전달한다.
await consumer.updateWorld(restoredWorld);
consumer.dispose();
```

- `mountOperationalMapConsumer`는 catalog ref에 맞는 v3 delivery fetch까지
  수행한다. `OperationalMapWorld`는 공유 world view에 원본 catalog 순서의
  `territoryOrder`와 국가 `mapColor`를 더한 구조이며 `WorldStateV3`를 받는다.
- `updateWorld(world, change?)`는 Promise다. 연속 호출은 순서대로 적용한다.
  명시적인 delta는 base/next revision, ID 중복, before/after 및 원본 국가를
  확인한다. delta 없는 snapshot은 상태 record를 비교해 변경 cell을 찾는다.
  매 턴의 정상 경로는 runtime이 전달하는 delta를 사용한다.
- `getProjection()`과 `getUpdateStats()`로 적용한 world/revision 및 작은
  갱신 통계를 확인한다. `selectCountry`, `hoverCountry`와 hit callback은
  기존 원본 ID 및 소유 국가 기준의 선택 의미를 유지한다.
- `showCountryDetail`, `showEdgeDetail`, `clearDetail`은 16-04 상세 source를
  사용한다. 선택 국가의 상세를 지워도 상태 변경에 필요한 exact cell과
  현재 exact 전선은 유지한다.

다른 catalog의 snapshot은 기존 지도에 혼합하지 않고 ref 불일치로 실패한다.
16-08은 snapshot의 catalog에 맞는 consumer/asset을 mount해야 한다.

## 표시와 갱신

- fill은 현재 controller의 `mapColor`와 기존 `mapColorPresentation` 정책을
  사용한다. owner와 원본 국가/행정 identity는 유지한다. 소유 국가만 바꾸고
  controller를 보존한 양도는 계속 같은 통제색을 사용한다.
- `right > 0`인 공유 edge 양쪽의 현재 controller가 다를 때만 전선을
  표시한다. 해안이나 같은 controller 사이의 경계는 전선으로 표시하지 않는다.
- 국가/해안선, 실제 행정선, 합성 cell 격자, 동적 전선을 별도 layer로
  구성했다. 행정선은 zoom 4부터 표시하고 합성 격자는 기본 숨김/zoom 8이다.
- overview tile이 로딩되면 해당 숫자 cell/edge ID의 feature-state를
  현재 world에서 읽어 적용한다. 미래에 로딩되는 tile도 최신 상태를 사용한다.
- 변경된 cell은 원본 exact geometry를 추가한다. overview에서 생략된
  작은 cell과 hole을 그대로 사용하며 shape를 키우지 않는다. exact가 있는
  cell/전선은 중복되는 overview 표시를 숨긴다.
- 전체 binary incidence에서 역방향 CSR index를 필요할 때 한 번 만든다.
  이후 delta에서는 변경 cell에 맞닿은 edge만 조회한다. 매번 전 세계
  topology나 tile을 다시 만들지 않는다.
- 변경 cell source와 현재 전선 source는 숫자 ID를 유지하고 `updateData`의
  add/remove로 갱신한다. 기존 source를 재생성하거나 매 턴 전체 GeoJSON을
  `setData`하지 않는다. 색상 변경은 관련 feature-state만 바꾼다.
- geometry 로딩 실패 시 이전 projection을 유지하고 재시도할 수 있다.
  source 쓰기가 실패한 경우에는 remount가 필요하다고 표시한다.
  dispose 후 비동기 결과는 지도에 반영하지 않는다.

## 수행한 확인

- TypeScript `tsc --noEmit` 통과.
- 새 consumer 9개와 v3 transport 10개 테스트 통과. 고정된 작은 graph에서
  부분 점령, 후속 진격, 해방/양도, undo/redo snapshot, controller 색상 변경,
  잘못된 ID/stale delta, 실패 후 재시도, 연속 요청 및 dispose를 확인했다.
- 실제 승인 incidence index의 역방향 조회가 해당 cell의 edge만 반환함을 확인했다.
- 생성된 전체 layer/source를 설치된 MapLibre style validator로 확인했다.
- 기존 지도 consumer·국가 label·지도 설정 테스트 23개 통과.
- 변경 TypeScript 파일의 ESLint 통과.

## 남은 연결

16-08에서 기존 게임 화면/턴 controller에 consumer를 mount하고 실제
authoritative delta와 undo/redo snapshot을 전달한다. 기존 label/날짜/news와
지도 설정도 해당 통합 단계에서 함께 연결한다. production build와 대표
점령의 로컬 화면 확인은 16-09 범위로 남긴다. 이번 작업에서 외부 API를
호출하거나 사용자 직접 플레이 확인을 수행했다고 주장하지 않는다.
