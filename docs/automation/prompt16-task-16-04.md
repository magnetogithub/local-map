# 16-04 로컬 지도 asset·v3 protocol·exact detail 연결

Prompt 16의 B 분기 16-04를 구현했다. 데이터는 16-01 loader가 확인한
기존 15-21 `56fc6c79c216e6bd1a11`을 사용한다. 승인 산출물이나 원본
geometry를 변경하지 않았다.

## 로컬 확인

```powershell
npm run dev -- --webpack
```

`http://localhost:3000/api/world/catalog/operational/map`에서
`operational-map-bootstrap-v1`과 catalog ref를 확인한다.
`/api/world/catalog/operational`은 기존 descriptor 응답을 유지한다.

`/data/territory-catalog/catalog-v3-56fc6c79c216e6bd1a11/...` route는
등록된 render asset만 제공한다. gzip은 `application/gzip` payload이며
HTTP `Content-Encoding`은 설정하지 않는다. SHA-256 ETag와 immutable
캐시를 제공하고 build/provenance/접수 기록은 공개하지 않는다.
기존 public v1 asset도 유지한다.

## 후속 작업에서 사용할 인터페이스

- `fetchOperationalVectorDelivery(ref, fetcher?, signal?)` 또는
  `loadOperationalVectorDelivery(bootstrap, ref, fetcher?, signal?)`:
  별도의 v3 schema를 읽는다. 초기 요청은 manifest, tile index,
  detail index, 전체 binary edge incidence이다. 국가 metadata와
  polygon/topology 상세는 필요할 때 읽는다.
- `source`, `protocol`, `loadTile(path, signal?)`:
  기존 `registerCatalogTileProtocol`을 공유한다. 압축 바이트의 hash와
  길이를 확인한 뒤 gzip을 해제하고 MapLibre에 PBF를 전달한다.
  `promoteId`로 문자열 속성을 지정하지 않으며 원본 숫자 feature ID를
  유지한다. `renderRef(layer, ordinal)`은 숫자 feature-state target을 만든다.
- `loadCountry(countryId)`와 `resolveCells([{id, sourceCountryId}])`:
  원본 cell ID ↔ 숫자 ordinal, 행정 parent ordinal, 이전 parent ordinal을
  반환한다. 국가 metadata는 최대 16개를 재사용한다.
- `edgeIncidence(edgeOrdinal)`:
  binary index를 little-endian으로 읽는다. 오른쪽 `0`은 해안이며
  mutable owner/controller는 asset에 포함하지 않는다.
- `loadCountryDetail(countryId)`, `loadCellDetail(cells)`,
  `loadEdgeDetails(edgeOrdinals)`:
  해당 국가 또는 필요한 topology shard만 읽는다. 선택 cell의 결과는
  선택된 숫자 ID만 포함한다. geometry 좌표와 hole은 그대로 유지한다.
  `loadCoverage()`는 overview에서 생략된 ordinal 목록을 필요할 때 읽는다.
- `loadParents()`, `administrativeMembership(parentKey)`:
  원본 행정/이전 parent identity와 전체 membership을 반환한다.
  저장된 membership을 512개로 자르지 않는다. 한국어/영어 이름 조회는
  16-01의 `/api/world/regions`와 `mode: "membership"`을 그대로 사용한다.
- `mountOperationalMapSources({map, protocolApi, catalogRef, ...})` 또는
  `createOperationalMapSources(map, protocolApi, delivery)`:
  실제 MapLibre port에 vector source와 exact cell/edge GeoJSON source를
  등록한다. `showCountryDetail`, `showCellDetail`, `showEdgeDetail`로
  필요한 상세를 반영한다. 늦게 끝난 이전 상세 요청은 최신 선택을
  덮어쓰지 않는다. layer를 제거한 뒤 `dispose()`한다.

공유 decoded asset LRU는 256개/32 MiB 한도다. 상세 객체를 호출자가
변경하더라도 캐시의 원본 바이트는 바뀌지 않는다. 초기 화면에서
전 세계 polygon이나 topology 상세를 내려받지 않는다.

## 확인 결과

- TypeScript `tsc --noEmit` 통과.
- 새 transport/source 테스트 10개와 기존 지도·지역/API 테스트 24개 통과.
- 변경한 지도 TypeScript와 route의 ESLint 통과.
- 실제 Next 개발 서버(Webpack)에서 bootstrap/manifest/tile 200 확인.
  gzip payload의 압축 hash 및 해제 후 PBF 길이를 확인했다.
  내부 provenance 404, 기존 v1 manifest 200을 확인했다.
- 기본 Turbopack 모드에서는 첫 route 컴파일이 지연되어 중단했다.
  위 로컬 HTTP 확인은 Webpack 모드에서 수행했다.

## 남은 연결

16-05에서 전달받은 authoritative 상태 변경에 따른 점령색·전선·경계
layer와 incremental projection을 연결한다. v3 overview의 `territories`는
숫자 cell ordinal, `edges`는 숫자 edge ordinal과 `c`/`a` 속성을 사용한다.
실제 `administrative` layer는 z4 이상이고 합성 cell 격자는 기본 숨김이다.

실제 게임 화면의 새 catalog 전환과 source mount는 16-08에서 연결한다.
이번 작업은 기존 게임 bootstrap을 임의 전환하지 않았다. production
build와 대표 점령의 화면 확인은 16-09에 남아 있다. 외부 API 호출이나
사용자 직접 플레이 확인을 수행했다고 기록하지 않는다.
