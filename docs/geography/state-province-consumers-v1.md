# 20-06 지역 API·모델 읽기·prepared snapshot 인계

20-05 loader의 승인된 snapshot을 기존 지역 조회와 연결했다. 20-06의 소비 경계에 더해 20-08에서 실제 manifest 선택·gzip 운송·지명 검증을 연결했다. 현재 생산 선택과 실행 결과는 [20-08 연결 문서](production-geography-integration-v1.md)를 참조한다.

## 공통 조회와 HTTP

`state-province-read.ts`의 `geographyReadRequestSchema`와 `executeGeographyRead`를 HTTP와 AI 도구가 함께 사용한다. 모든 필드가 필수이며 사용하지 않는 query/reference/kind는 규칙에 따라 null이다.

```json
{
  "operation": "search",
  "sourceCountryId": "PRK",
  "kind": "source-region",
  "query": "청진",
  "reference": null,
  "page": {"offset": 0, "limit": 32}
}
```

이 예시는 요청 형식이며 실제 생산 지명 지원을 인증하지 않는다. sourceCountryId는 원본 분류다. 현재 actor/owner/controller 필터로 해석하지 않는다. country 또는 kind 전체는 null이다. page는 offset≥0, limit 1~128이다.

지명 검색에서는 광역 구역은 `kind:'state'`, 도시·시군구 원본은 `kind:'source-region'`, 개별 게임 셀은 `kind:'province'`를 명시한다. 원본 계층을 모를 때만 `kind:null`로 조회한다. 종류 미지정 검색은 같은 원본의 셀·이름 묶음을 canonical 후보로 정리하고 나서 ambiguity와 pagination을 계산한다. 서로 다른 원본의 동명 후보는 유지한다. 이름 suffix만으로 계층을 확정하거나 후보 첫 항목을 임의 채택하지 않는다.

| operation | query | reference | kind | 결과 |
| --- | --- | --- | --- | --- |
| search | 필수 문자열 | null | 종류 또는 null | 동명·부분 페이지 상태를 포함한 GeographySummary 페이지 |
| list | null | null | 종류 또는 null | 필터된 summary 페이지 |
| inspect | null | 버전 고정 GeographyReference | null | summary |
| members | null | 버전 고정 GeographyReference | null | ID 페이지·coverage·같은 target summary |

`POST /api/world/regions`의 새 요청은 `{mode:'geography', catalogRef, metadataRef:ref|null, request:위_요청}`이다. 응답은 공통 `{ok,value}` 또는 `{ok:false,diagnostics}`와 `countryIdSemantics:'source'`다. names의 근거, reference.target.kind, 부모 상태, precision/geometryStatus, coverage, materialization, pagination·ambiguity를 유지한다. members가 알려진 모든 셀을 반환해도 coverage를 complete로 바꾸지 않는다.

HTTP body 상한은 4,096 bytes, 응답은 no-store다. 잘못된 입력·다른 source country의 target은 400, loader stale은 409, unavailable은 503이다. 클라이언트는 artifact 경로를 지정할 수 없다.

기존 `{countryId,operation,query|reference,mode:'action'|'membership'}` 요청은 유지한다. 선택적 metadataRef를 명시하면 같은 snapshot의 legacy adapter를 사용한다. 현재 operational catalog는 metadataRef 생략 시 생산 registry의 adapter를 사용하고, 이전 catalog는 기존 조회를 유지한다. 기존 compact 응답에는 `geography:summary|null`, `materialization`, `countryIdSemantics`를 함께 실으며, 이름 조회에 무조건 materializable:true를 붙이지 않는다.

테스트·합류 연결점은 `createRegionPost({loadGeography,loadIndex})`다. 실제 route.ts는 이 factory의 기본 인스턴스다. 기본 `loadRegionGeography`는 20-08에서 고정 registry/실제 loader에 연결됐다. fixture나 임의 client 파일을 생산 자료로 선택하지 않는다. 선택 실패는 stale/unavailable로 응답한다.

## 기존 subdivision reference와의 연결

`attachGeographyRegionIndex(index,snapshot,links)`의 link는 `{stateId,reference:기존_RegionReference}`다. 전체 catalogRef, 원본 국가, 모든 State의 crosswalk, 해당 State의 알려진 province 집합과 기존 territoryIds의 정확한 일치를 검사한다. 중복·누락·다른 국가·다른 membership은 거부한다.

`createOperationalRegionIndex(catalog,snapshot?)`는 기존 parentKey에서 기존 ref 생성 결과를 찾아 link를 만든다. stateId/raw sourceFeatureId/provinceId를 subdivisionId로 대입하지 않는다. Province와 SourceRegion은 새 GeographyReference로 읽는다. State의 `legacyReference(stateId)`와 기존 ref의 `summary(reference)`는 index.geography에 보관한다.

연결된 기존 search/list/lookup도 metadata의 이름과 aliases를 읽는다. 한국어 fact가 없는 legacy nameKo 표시 fallback은 별도 names.nameKo:null과 displayBasis를 보존한다. 기존 120자 이름·16 aliases 제약을 넘으면 구체적인 GEOGRAPHY_LEGACY_NAME_LIMIT 오류를 내고 자르지 않는다. 완전성이 지원되지 않는 State는 읽기 membership을 제공하지만 기존 action resolve에서 GEOGRAPHY_SCOPE_UNSUPPORTED를 반환한다.

이름 lookup은 권한을 발급하지 않는다. 새 metadata 참조를 worldEffects에 직접 넣는 형식을 추가하지 않았다. 기존 512 cells·8 region refs, 점령·해방·양도 권한, 현재 controller frontier, revision·원자 commit·undo/redo 검증은 유지한다. “북한 북부”, “휴전선 인근”은 기존 공간 해석 경로를 사용하며 공식 이름 사전에 추가하지 않았다.

## AI 도구와 모델 경계

metadata snapshot이 있는 요청의 manifest에 read-only `read_geography`를 추가한다. 함수 parameters는 위 공통 요청을 사용하며 모든 object는 additionalProperties:false, 모든 nullable 필드도 required다. 버전 참조·ID 형식·페이지 상한을 host schema로 다시 검사한다. 기존 frontier 도구의 nullable 필드도 host에서 필수로 맞췄다.

`context.geography`는 `{catalogRef,metadataRef}`이며 regionCatalog 전체와 같아야 한다. 기존 초기 context에 없는 이름도 read_geography가 pinned index에서 찾는다. 모델 지침은 동명 후보 선택, coverage 해석, 원본 국가와 현재 소유/actor 구별, 기존 subdivision reference와의 구별을 명시한다.

`OpenAIResponsesSimulationProvider`는 시작할 때 한 번 snapshot을 얻어 model context·모든 도구·resolution validator에 전달한다. host가 준비한 geographySnapshot/preparedRegionIndex가 있으면 그것을 사용하고, 없으면 주입한 loadGeography로 context의 정확한 ref를 읽는다. 이후 별칭 release가 바뀌어도 같은 요청은 재선택하지 않는다. 불일치는 도구 호출·resolution 채택 전에 거부한다.

`SimulationProviderRequest.geographySnapshot`, `preparedRegionIndex`는 서버 객체다. HTTP 요청 envelope는 이 필드를 받지 않는다. owner/controller는 기존 operationalWorld 경계에서 현재 revision과 전체 catalogRef를 검사한다. 정적 metadata에 mutable 상태를 저장하지 않는다.

## Prepared context

`createOperationalGameSession`은 기본적으로 전달받은 regionIndex.geography를 사용한다. 합류 시 async loader를 실행한 상위 코드가 `prepareGeography:()=>({snapshot,regionIndex})`로 이미 준비된 서버 객체를 공급할 수도 있다.

prepared cache는 base pair·targetDate와 **전체 catalogRef+metadataRef의 geographySnapshotKey**를 함께 사용한다. 새 prepare 요청은 새 release를 선택할 수 있고, 이미 준비한 턴의 검증·provider·계획은 보관한 snapshot/index를 사용한다. 새 prepare가 이전 준비를 대체하거나 world/simulation이 바뀌면 이전 context는 거부한다. 반환 context를 JSON으로 복사하며 비교용 canonical 값과 서버 객체는 private으로 유지한다.

기존 session을 삭제하거나 초기화하는 작업은 하지 않았다. 이름 갱신과 snapshot 선택은 게임 state/history를 변경하지 않는다.

## 검증과 생산 연결

`state-province-consumer.test.ts`는 공통 fixture를 실제 loader에 주입한다. 지역 HTTP factory와 AI 도구의 동일 결과, 누락된 지명 검색, 한 페이지의 실제 동명 모호성, partial/unsupported 범위, stale·잘못된 국가·누락된 nullable 필드, legacy crosswalk를 확인한다. `/api/simulation/turn` handler와 scripted transport를 함께 사용해 모델 도구 출력·resolution validation을 통과한다. prepared session 검사는 별칭 갱신 중 강한 snapshot 참조와 새 metadata cache key, world/history 불변을 확인한다. 외부 AI 호출은 0회다.

20-08은 생산 gzip의 byte identity 검증 → 크기 제한 gunzip → UTF-8 JSON → 공통 schema/semantic 검증과 trusted registry를 연결했다. 실제 청진·내몽골 및 전체 생산 membership/API/provider 결과는 [통합 기록](production-geography-integration-v1.md)에 정리했다. 20-06 보고서의 fixture 단계 기록은 당시 범위를 유지한다.

검증 명령·production build/HTTP smoke·기존 회귀 실패와 보존 근거는 `reports/maintenance/prompt20-06-consumers.json`에 기록한다.
