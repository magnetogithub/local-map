# 20-05 버전 고정 loader·조회 인계

공통 [20-02 계약](state-province-contract-v1.md)을 사용하는 서버 전용 구현이다. 생산 metadata 생성·선택은 20-03/04·20-08, 기존 지역 API·모델·prepared context 연결은 20-06의 작업이다. 이 단계는 fixture로 loader와 조회를 검증하며 활성 metadata 포인터를 발행하지 않는다.

20-08에서 실제 생산 registry·gzip 읽기·기존 API와 게임의 선택 경로를 연결했다. 아래 20-05 인계 기록 이후의 현재 선택과 실제 검증은 [생산 연결 문서](production-geography-integration-v1.md)를 참조한다.

## 진입점과 의존성

- `src/lib/geography/state-province-loader.server.ts`: `createGeographyLoader(options)` → 기존 `GeographyLoader(request, dependencies)` 인터페이스. 생산 기본 인스턴스는 `loadGeographySnapshot`이다.
- `src/lib/geography/state-province-index.server.ts`: loader 내부 snapshot index와 host 전용 `readGeographyCountry`, `readAllGeographyMembers`.
- `src/lib/geography/state-province-loader.server.test.ts`: 공통 fixture를 주입하는 정상·오류·pagination·캐시 검사. 큰 집합 검사는 fictional metadata를 600개 알려진 member로 확장하며 생산 자료를 복제하지 않는다.

모듈은 `server-only`다. builder·국가별 adapter·raw geometry를 import하지 않는다. `locateManifest`, `readArtifact`, `catalogView`는 공통 계약대로 주입한다. `catalogView`에는 metadata-only 국가·cell·행정 부모·world contract만 제공한다. `createGeographySnapshot`은 내부 생성 함수이며 공통 semantic validator가 승인하고 freeze한 metadata를 받아야 한다.

```ts
const load = createGeographyLoader();
const result = await load({catalogRef, metadataRef: null}, dependencies);
if (result.status !== 'available') {
  // stale/unavailable 및 구체적 diagnostics를 호출자에게 전달
  return result;
}
const snapshot = result.snapshot;
const found = snapshot.search({
  sourceCountryId: null, kind: 'source-region', query: '지명',
  page: {offset: 0, limit: 32},
});
```

`null` metadataRef는 trusted registry에 해당 catalog의 자료 선택을 요청한다. 명시적 metadataRef는 정확한 release만 허용한다. locator가 불일치 자료를 반환해도 loader가 거부하며 최신 자료로 대체하지 않는다. fixture manifest는 기본 거부한다. 테스트 인스턴스만 `{allowFixture:true}`로 만든다.

## 검증과 오류

1. 요청을 strict parse하여 복사하고 전체 catalogRef를 고정한다.
2. registry가 pin한 manifest 자체의 경로·sha256·byteLength를 검사하고 UTF-8 JSON을 읽는다.
3. manifest schema·purpose·전체 catalogRef·요청 metadataRef를 검사한다.
4. metadata와 admission의 byte identity·schema·참조 연결을 검사한다.
5. 해당 catalog의 metadata-only view와 admission을 공통 `validateGeographyMetadata`에 전달한다. 이 과정에서 contentRoot, ID 전체 집합·원본 국가·부모·원본 묶음·coverage 근거도 검사한다.
6. 승인한 불변 metadata로 snapshot을 만든다. 실패한 snapshot은 캐시하지 않는다.

요청/선택 manifest의 catalog·metadata snapshot 불일치는 `stale`다. 별도 catalog view의 ref 불일치도 `stale`다. 파일 부재·손상, 잘못된 schema·admission·semantic 검증 실패는 `unavailable`이며 공통 진단 코드·path·message·remedy를 제공한다. locator의 명시적 stale/unavailable은 그대로 전달한다. 의존성 예외의 비공개 원문은 응답에 넣지 않는다.

## 조회 의미

`snapshot.search`, `list`, `inspect`, `members`는 기존 공통 타입을 그대로 구현한다. inspect에 `{catalogRef,metadataRef,target:{kind,id}}`를 주면 state·province·source-region ID를 구분해 조회한다. 국가 ID 요약은 `readGeographyCountry(snapshot, sourceCountryId)`로 읽는다. 등록되지 않은 국가·대상 또는 다른 snapshot의 참조는 명시적 오류다.

- 이름 검색은 display/source/ko/en 이름과 별칭을 NFKC·공백 정리·대소문자 정규화한다. 해당 country/kind 범위의 정확히 일치하는 후보를 우선 반환하며, 없으면 부분 문자열 후보를 반환한다. 구두점 제거·유사도 추측·공식 소속 추론은 하지 않는다.
- 동명 후보는 target ID를 유지한다. 같은 source-region에 속하는 여러 province는 하나의 원본 묶음으로 조회한다. kind를 null로 검색하면 state·province·source-region의 서로 다른 identity가 각각 후보가 된다.
- `sourceCountryId`는 원본 분류다. source country로 필터한 결과에서 다른 국가로 소유권이 이전된 셀을 제거하지 않는다.
- 결과는 `kind:id`의 코드 포인트 순서다. membership ID도 문자열 순서다. metadata 입력 순서나 페이지 크기를 바꿔도 같은 snapshot의 순서는 유지된다.
- page는 offset≥0, limit 1~128이다. `totalMatches`는 페이지를 자르기 전 개수다. `truncated`는 해당 페이지가 알려진 결과 전체를 담지 않았다는 뜻이며 앞 페이지가 생략된 경우에도 true다. 범위 밖 offset은 빈 items와 기존 totalMatches를 반환한다.
- 이름 조회는 종류를 알면 `kind`를 명시한다. 광역 구역은 `state`, 도시·시군구 원본은 `source-region`, 개별 게임 셀은 `province`다. 실제 원본 계층을 따르며 이름 접미사만으로 행정 단계를 단정하지 않는다.
- `kind:null` 검색은 일치한 원본 묶음이 해당 셀들을 대표하도록 중복 표현을 정리한다. State는 원본 identity·근거와 알려진 membership이 모두 같은 원본 묶음만 대표한다. 이름이나 알려진 범위가 같아도 원본 identity가 다르면 후보를 유지한다. 종류가 지정된 검색과 list/inspect/members는 모든 해당 객체를 그대로 읽는다.
- search의 `ambiguous`는 위 처리를 마친 전체 검색 후보가 둘 이상인지 나타낸다. `totalMatches`와 pagination도 중복 표현을 정리한 뒤 계산한다. 페이지에 후보가 하나만 나와도 true일 수 있다. list와 명시적 target membership은 동명 선택을 하지 않으므로 false다.
- summary는 이름의 근거, kind·정밀도·형상 상태·부모 상태·coverage·knownProvinceCount를 보존한다. 원본 묶음의 모든 province가 같은 verified State에 속할 때만 단일 stateId/verified를 표기한다. 여러 verified State에 걸친 원본 묶음은 stateId:null/parentStatus:not-applicable, 미확정 부모를 포함하면 unassigned다.
- complete coverage와 검증된 부모가 있는 대상도 materialization은 `requires-validation`이다. partial/unsupported 범위나 미확정 부모는 `unsupported`다. 검색은 실행 권한을 발급하지 않는다.

`readAllGeographyMembers(snapshot, reference)`는 host가 128개씩 읽어 알려진 전체 provinceIds를 얻는 함수다. `knownMembershipComplete:true`는 알려진 집합을 전부 읽었다는 뜻이다. 반환된 `coverage`가 partial/unsupported일 수 있다. 이 함수와 목록 조회에는 행동 실행의 512개 상한을 적용하지 않는다. 기존 행동의 총 512 cells·8 region refs 상한, revision·authority·frontier·원자 commit 검사는 기존 실행 경계에서 계속 적용해야 한다.

## 캐시와 다음 태스크의 읽기 경계

loader 인스턴스는 dependencies 객체별 WeakMap으로 격리한다. 같은 dependencies를 재사용해야 캐시를 재사용한다. 각 캐시는 최대 4개 release, 승인 완료 후 TTL 300,000ms이며 접근 순서로 퇴출한다. 실패는 제거하고 동일 release의 동시 admission은 공유한다. 테스트에서는 `now`를 주입해 만료를 확인할 수 있다.

캐시 key는 **전체 catalogRef+metadataRef**의 `geographySnapshotKey`와 선택 manifest의 path·sha256·byteLength다. 같은 metadataRef라도 admission 또는 manifest가 바뀌면 다시 검증한다. 매 load마다 registry와 작은 manifest는 확인한다. 원본 source/input·polygon은 읽지 않는다.

한 요청/준비된 턴은 최초 available snapshot을 보관해 모든 조회에 전달한다. 다음 작업에서 prepared cache key에도 metadataRef를 포함해야 한다. 캐시 퇴출·만료 또는 이름 release 교체가 이미 보관한 snapshot을 변경하지 않는다. 이전 참조를 새 snapshot에 넘기면 거부한다. 준비된 요청 안에서 metadataRef:null로 매번 다시 load하지 않는다.

현재 owner/controller가 필요하면 전달받은 World V3를 기존 `readOperationalCellState(world, snapshot.catalogRef, provinceId)`로 읽는다. 전체 catalogRef를 대조하며 mutable owner/controller를 정적 metadata나 이름 index에 캐시하지 않는다. 실제 최신 world와 revision을 준비·실행 경계에서 선택하는 연결은 20-06의 책임이다.

## 20-06·20-08 인계

- 20-06은 이 loader와 fixture를 주입해 기존 region API·AI compact 응답·prepared context를 연결한다. 기존 subdivision reference 변환은 공통 계약을 따른다.
- 20-08에서 실제 생성 manifest byte pin을 신뢰 registry에 등록하고 실제 metadata/admission을 주입한다. 임의 경로를 클라이언트에서 받아 trusted locator로 취급하지 않는다.
- 현재 생산 metadataRef는 이 작업에서 선택하지 않았다. 청진·내몽골 등 실제 지명과 전체 생산 ID 집합의 loader 검증은 실제 자료가 합류하는 20-08 항목이다.
- 기존 current catalog, geometry/topology, ID·운영 membership·seed lineage, 사용자 게임, API·모델 파일은 20-05에서 수정하지 않는다.

검증 명령과 실제 결과는 `reports/maintenance/prompt20-05-loader.json`에 기록한다.
