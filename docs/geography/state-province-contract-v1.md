# State·province 공통 지리 metadata 계약 v1

20-02의 확정 계약이다. 생산 metadata 생성은 20-03/04, loader·API 연결은 20-05/06, 국가 인계 helper는 20-07, 실제 데이터 합류는 20-08에서 수행한다.

20-09까지 연결·검증한 현재 결과는 [완료 기록](../../reports/maintenance/prompt20-completion.md), 실제 서버/API 조회는 [생산 연결 문서](production-geography-integration-v1.md)를 참조한다. 아래 schema의 identity·근거·미확정 상태 의미는 그대로 유지한다.

기준은 [20-01 baseline](../../reports/maintenance/prompt20-baseline.json)의 **소규모 셀 병합 이후** `catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee`다. 전체 247개국·8,004 cells, CHN 3,319 cells다. 이 수치는 조사 결과이며 schema의 허용 국가나 합격 개수로 하드코딩하지 않는다. 새 실행은 항상 `data/runtime/operational-catalog/current.json`과 전체 catalogRef를 재확인한다.

## 공통 파일과 의존성

| 파일 | 공개 계약 |
| --- | --- |
| [state-province-contract.ts](../../src/lib/geography/state-province-contract.ts) | Zod strict schema와 추론 타입, ID·이름 정규화·content sealing·국가 집계 |
| [state-province-validation.ts](../../src/lib/geography/state-province-validation.ts) | `GeographyAdmissionContext`, 공통 의미 검증, 진단 코드 |
| [state-province-io.ts](../../src/lib/geography/state-province-io.ts) | manifest·admission·새 reference·compact summary schema, loader·snapshot 입출력 타입 |
| [state-province-contract-fixture.ts](../../src/lib/test-only/state-province-contract-fixture.ts) | A/B/C가 독립적으로 사용하는 작은 메모리 fixture |
| [state-province-contract.test.ts](../../src/lib/geography/state-province-contract.test.ts) | 계약의 양성·음성 검증 |

기존 `CountryId`, `TerritoryId`, `WorldGeometryCatalogRef`, `OperationalCell`, `OperationalAdministrativeParent`를 재사용한다. 공통 모듈은 builder, runtime loader, polygon, mutable world를 import하지 않는다. hash는 기존 browser-safe canonical serializer와 SHA-256을 사용한다.

## Envelope와 identity

`GeographyMetadata`의 필드는 전부 필수다. 명시된 nullable 항목은 `null`로 저장한다. strict schema는 owner/controller, geometry 등 임의의 추가 필드를 거부한다.

| 필드 | 형식과 의미 |
| --- | --- |
| `schemaVersion` | `state-province-metadata-v1` |
| `catalogRef` | 기존 5필드 전체: `catalogVersion`, `geometryRoot`, `topologyRoot`, `renderArtifactRoot`, `manifestPath` |
| `metadataRef` | `{schemaVersion: 'geography-metadata-ref-v1', contentRoot: SHA256}` |
| `provenance` | `scenarioDate`(ISO 일자), `method`, `inputs: Artifact[]`, `code: Artifact[]`, `limitations: string[]` |
| `states` | 검증된 기존 행정 부모에 대응하는 State 배열 |
| `provinces` | 현재 catalog의 모든 TerritoryId와 정확히 일치하는 Province 배열 |
| `sourceRegions` | 원본 identity 하나의 알려진 현재 province 전체를 묶는 배열 |
| `countries` | catalog의 국가 집합과 정확히 일치하는 요약 배열 |

`Artifact`는 `{path, sha256, byteLength}`다. path는 traversal·URL·드라이브 경로가 없는 저장소 상대 경로, sha256은 소문자 64자리다. `Evidence`는 `{artifact, locator, method}`이며 고정 파일 안에서 조사할 위치와 검증 방법을 남긴다. 모든 레코드의 source·이름·coverage 근거 artifact는 provenance의 inputs/code에 등록한다. 중복 경로는 허용하지 않는다. 별도 admission artifact의 byte pin은 manifest가 보유한다.

`Source`는 `{sourceId, sourceFeatureId, sourceVersion, artifact, temporalStatus, temporalNotes}`다. `temporalStatus`는 `scenario-verified | source-vintage-only | unknown`이다. 연도나 행정 사실이 불확실하면 notes에 한계를 남긴다. 게임의 형상 보정은 원본 시점의 행정 사실을 인증하지 않는다.

`sealGeographyMetadata(body)`는 body를 strict parse하고 **metadataRef를 제외한 body 전체**의 canonical UTF-8 JSON을 SHA-256으로 해시한다. 이 hash에는 LF가 없다. body에는 catalogRef, 모든 이름·별칭·집합·원본·생성 근거가 포함된다. 생성 시각처럼 매번 달라지는 값은 넣지 않는다. 배열 순서는 hash에 영향을 준다. producer는 entity ID와 source identity 기준으로 정렬하고 같은 입력에 같은 순서를 사용한다. 객체 키 순서는 canonical serializer가 정한다.

저장 artifact bytes는 `geographyArtifactBytes(value)`, 즉 canonical JSON + LF다. 따라서 파일의 sha256과 `metadataRef.contentRoot`는 서로 다른 값이다. 자기 참조 hash는 만들지 않는다. 이름·별칭만 수정해도 metadataRef는 바뀌지만 기존 영토 ID와 catalogRef는 그대로다.

## State, Province, 원본 이름 묶음

| 레코드 | 필드 |
| --- | --- |
| State | `kind: 'state'`, `stateId`, `catalogParentKey`, `sourceCountryId`, `source`, `names`, `coverage`, `evidence` |
| Province 공통 | `kind: 'province'`, `provinceId`, `sourceCountryId`, `names`, `precision`, `geometryStatus`, `sources`, `evidence`, `parentEvidence` |
| Province 확정 부모 | `parentStatus: 'verified'`, `stateId: StateId`, `unassignedReason: null` |
| Province 미확정 부모 | `parentStatus: 'unassigned'`, `stateId: null`, `unassignedReason: string` |
| SourceRegion | `kind: 'source-region'`, `sourceRegionId`, `sourceCountryId`, `source`, `names`, `provinceIds`, `coverage`, `evidence` |

- `ProvinceId`는 기존 `TerritoryId`와 같은 타입·문자열이다. cell ordinal이나 표시 이름으로 새 ID를 발급하지 않는다.
- `StateId`는 현재 검증된 **행정 parentKey를 그대로 재사용**한다. `stateId === catalogParentKey`를 검사한다. 해당 부모의 kind가 `administrative`이고 source country와 원본 crosswalk가 일치해야 한다. residual 부모를 State로 승격하지 않는다.
- raw ADM1 sourceFeatureId와 runtime 부모의 sourceFeatureId를 구별한다. 특히 KOR/PRK의 synthetic runtime identity를 원본 feature ID로 오인하지 않는다. `parentSources` crosswalk가 원본 identity를 명시한다.
- State의 province 목록은 저장하지 않는다. **Province.stateId가 metadata 내부의 유일한 소속 필드**이고, State membership은 여기서 파생한다. 그 필드도 기존 catalog 행정 membership과 대조한다. metadata가 운영 membership을 변경할 권한을 갖지 않는다.
- 기존 administrative 부모의 source crosswalk가 검증됐다면 이를 버리고 null로 바꾸지 않는다. source 근거가 부족한 administrative 부모는 명시적 unassigned로 보존할 수 있다. parentKey/seed 관계만으로 공식 소속을 확정하지 않는다.
- `precision`은 `fine | coarse | residual`이다. fine은 source가 필요하다. residual은 source-free이며 부모가 null이다. coarse metadata를 추가해도 fine이 되지 않는다.
- `geometryStatus`는 `source-exact | game-adjusted | source-free`다. sources가 없으면 source-free다. 게임 보정은 evidence에 남긴다. 원본 이름을 유지하는 것과 원본 polygon 전체와 일치하는 것은 별개다.
- `sourceRegionId = createSourceRegionId(sourceCountryId, sourceId, sourceFeatureId)`다. namespace `geography-source-region-v1`의 canonical object를 hash한 `source-region:<sha256>` 형식이다. 이름·ordinal·owner/controller·metadata release version은 ID 입력이 아니다. sourceVersion은 Source와 metadataRef에서 검증한다.
- 원본 지역의 여러 셀을 한 SourceRegion에 모두 연결한다. 동명 원본끼리 합치지 않는다. province의 source마다 그룹이 있어야 하고, admission의 알려진 source membership을 누락하거나 임의의 coarse/residual로 바꾸지 못한다. State와 SourceRegion의 중첩은 정상이다.
- `previousParentOrdinal`, `oldTerritoryId`, `seedParentIds`는 초기 게임 상태 상속용이다. 도시 이름·공식 state의 근거로 사용하지 않는다. CHN `renderProvinceId`와 표시용 경계도 공식 소속 증거가 아니다.

## 이름과 번역

`Names`의 필드는 `displayName`, `displayBasis`, `displayEvidence`, `sourceName`, `nameKo`, `nameEn`, `aliases`다.

- `displayName`은 비어 있지 않아야 한다. `displayBasis`는 `source | verified-translation | derived`다. source/translation이면 같은 값·basis의 이름 fact가 있어야 한다. source가 없는 조각은 상위 표시명과 짧은 기존 ID 등으로 derived display를 만들고 근거를 남긴다.
- `sourceName`, `nameKo`, `nameEn`은 `null` 또는 `{value, basis: 'source' | 'verified-translation', evidence}`다. sourceName의 basis는 source여야 한다. 영어 display fallback을 nameKo에 복사해 번역 완료로 표시하지 않는다. 검증한 한국어 이름이 없으면 null이다.
- alias는 `{value, language: 'ko' | 'en' | 'und', basis: 'source' | 'verified-alias', evidence}`다. 이름/별칭의 증거는 원본 또는 검증된 번역 자료를 가리킨다. schema 자체가 번역의 진위를 증명하지는 않는다.
- `normalizeGeographyName`은 NFKC → 양끝 공백 제거 → 내부 공백 연속을 공백 하나로 → en-US 소문자화 순서다. 구두점 제거·임의 음역·유사도 기반 행정 소속 배정은 하지 않는다.
- 이름의 전역 유일성은 요구하지 않는다. 동명 후보를 country/state/source identity와 함께 반환한다. “현재 전선”, “북한 북부”, “휴전선 인근” 같은 공간 지시는 공식 이름으로 추가하지 않는다.

## 범위와 국가별 집계

`Coverage`는 `{status, knownProvinceCount, expectedProvinceCount, evidence, limitations}`다.

| 값 | 의미와 검증 |
| --- | --- |
| `complete` | 독립적으로 검증한 해당 원본 target의 전체 게임 셀 집합과 실제 membership이 같음. 별도 witness와 evidence가 필수 |
| `partial` | 알려진 membership은 제공하지만 원본 지역 전체를 보장하지 못함. limitations 필수 |
| `unsupported` | 원본 지역 전체 범위를 지원하지 못함. expectedProvinceCount는 null, limitations 필수. 알려진 기존 셀은 보존 |

`knownProvinceCount`는 State의 파생 membership 또는 SourceRegion.provinceIds 길이다. 예상 전체를 모르면 `expectedProvinceCount: null`이다. 숫자를 제시하려면 해당 target의 독립 검증 집합이 있어야 한다. witness는 현재 catalog와 같은 국가의 기존 셀만 포함한다. complete는 그 집합과 정확히 일치해야 하고, 부분 범위의 알려진 셀은 해당 target 집합의 부분집합이어야 한다.

`GeographyCoverageWitness = {target: {kind: 'state' | 'source-region', id}, provinceIds, evidence}`다. 생성기가 자신의 `coverage.status`를 다시 읽어 witness를 만들면 안 된다. 고정 raw·계층·현재 셀 연결을 조사한 offline verifier의 결과를 사용한다. validator는 **admission된 근거의 내부 일치**를 검증한다. 원본 사실, 라이선스, polygon 정합을 다시 증명하거나 문서의 증거 문자열만으로 행정 사실을 인증하지 않는다. 독립 검증 근거가 없으면 partial/unsupported와 null을 사용한다.

국가 레코드는 `sourceCountryId`, `counts`, `sourceFeatureCount`, `sourceFeatureCountEvidence`, `officialSubdivisionCount`, `officialSubdivisionCountEvidence`, `nameSupport`, `parentSupport`다.

`counts`는 `provinces, states, sourceRegions, fine, coarse, residual, unassignedParents, derivedDisplays, sourceNamed`이며 `countGeographyCountry`로 파생해 재검증한다. sourceFeatureCount와 officialSubdivisionCount는 다른 단위다. 모르면 null, 알면 각각의 별도 evidence가 필요하다. `nameSupport: source-and-derived | derived-only`는 sourceName 유무의 지원 요약이다. `parentSupport: complete | partial | unsupported`는 모든/일부/어떤 셀도 부모가 검증되지 않았는지에 관한 집계이며 **지리 범위의 완전성을 뜻하지 않는다**.

현재 데이터의 주요 한계는 baseline에 보존한다. CHN hierarchy의 1,201개 미확정 원본 feature와 실제 미확정 셀 수는 다르다. 원본 2,864개 중 14개는 기존 sourceTrace에서 고정 게임 envelope 밖으로 기록돼 있다. 소규모 병합의 recipient source identity와 보정 근거를 보존하며 옛 ID를 복구하지 않는다. KOR 228/229 차이와 PRK·CHN의 시점 한계도 complete 행정 사실로 덮지 않는다.

## Builder 출력과 loader 주입

20-03의 권장 불변 출력 디렉터리는 `data/derived/geography/<contentRoot>/`다. 구현할 때 실제 위치와 생성 명령을 기록한다. 이 문서는 실행 가능한 생성 CLI를 만들거나 실행했다고 주장하지 않는다.

```text
manifest.json  {schemaVersion:'state-province-manifest-v1', purpose,
                catalogRef, metadataRef, metadata:Artifact, admission:Artifact}
metadata.json  GeographyMetadata
admission.json {schemaVersion:'geography-admission-v1', catalogRef, metadataRef,
                parentSources, sourceMemberships, coverageWitnesses}
```

`purpose`는 `production | fixture`다. fixture를 생산 파일로 받는 것은 기본적으로 거부한다. metadata/admission은 서로 다른 artifact이며 manifest를 통해 정확한 bytes에 고정된다. admission은 metadata와 같은 전체 catalogRef·metadataRef를 가져야 한다.

admission의 `parentSources` 항목은 `{parentKey, source}`, `sourceMemberships` 항목은 `{sourceCountryId, source, provinceIds}`다. 전자는 검증된 행정 원본 crosswalk, 후자는 원본 identity별 **알려진 현재 셀 전체**다. sourceMemberships의 완전한 열거와 원본 지리 범위의 complete는 별개다. runtime은 raw polygon을 다시 읽지 않는다.

`validateGeographyMetadata(value, context, expectedMetadataRef?)`에 주입하는 context는 다음으로 구성한다.

1. `catalog: WorldGeometryCatalogContract`, `countryIds`, 기존 `cells`, `administrativeParents`: 현재 카탈로그의 metadata-only view.
2. admission의 `parentSources`, `sourceMemberships`, `coverageWitnesses`: 고정 artifact 검증을 거친 offline 증거.

생산 loader는 신뢰하는 registry/설정이 반환한 manifest byte pin을 먼저 검사한다. schema에 맞는 임의 manifest를 읽는 것만으로 생산 채택이 이뤄지지 않는다. metadata/admission bytes와 ref를 검사한 후 공통 semantic validator를 호출한다. `verifyGeographyArtifact`는 실제 bytes의 sha256/byteLength를 확인한다. `validateGeographyManifest`, `validateGeographyAdmissionEvidence`는 schema와 참조 연결을 검사한다. 이것들은 파일을 읽거나 current를 바꾸지 않는다.

`GeographyLoader(request, dependencies)`의 request는 `{catalogRef, metadataRef: ref | null}`이다. dependencies는 `locateManifest(request)`, `readArtifact(artifact)`, `catalogView(ref)`를 주입한다. locator는 `{status:'available', manifest:Artifact}` 또는 `{status:'unavailable'|'stale', diagnostics}`를 반환한다. loader는 `{status:'available', snapshot}` 또는 명시적 stale/unavailable을 반환한다. 특정 metadataRef 요청 실패를 조용히 최신 자료로 치환하지 않는다. B는 A의 builder를 import하거나 직접 실행하지 않는다.

## 읽기·pagination·prepared snapshot

새 `GeographyReference`는 `{catalogRef, metadataRef, target:{kind, id}}`다. kind는 state/province/source-region이다. `GeographySnapshot`은 metadata와 고정된 ref를 가지며 `search`, `list`, `inspect`, `members`를 제공하는 **인터페이스**다. 실제 index/loader 구현은 20-05의 소유다.

- search 입력: `sourceCountryId: CountryId | null`, `kind: kind | null`, `query`(1~120자), `page:{offset,limit}`. null은 원본 국가/종류 전체 검색이다. 현재 소유국 필터로 바꿔 해석하지 않는다. list는 query를 제외한 입력이다.
- inspect는 같은 snapshot의 reference를 받는다. members는 reference와 page를 받아 province ID의 전체 알려진 membership을 pagination으로 읽는다. offset은 0 이상, limit는 1~128이다.
- `GeographyPage<T>`는 `catalogRef, metadataRef, items, totalMatches, offset, limit, truncated, ambiguous`를 반환한다. ambiguous는 페이지 크기가 아니라 전체 후보의 동명/식별 모호성이다. membership 페이지에서 후보 모호성은 false다. 잘린 페이지와 지리 coverage partial을 혼동하지 않는다.
- compact `GeographySummary`는 `reference, sourceCountryId, names, stateId, parentStatus, precision, geometryStatus, coverage, knownProvinceCount, materialization`을 보존한다. 비해당 parentStatus는 not-applicable, 비해당 precision/geometryStatus/coverage는 null이다. Province의 source 정밀도는 precision/geometryStatus로 읽고 State/SourceRegion의 지리 범위는 coverage로 읽는다.
- materialization은 `{status:'requires-validation'|'unsupported', reason}`다. 이름 검색만으로 materializable true나 행동 권한을 발급하지 않는다. partial/unsupported 정보를 compact 과정에서 지우지 않는다.
- 읽기 pagination은 기존 행동 실행의 **총 512 cells·8 region refs 제한**과 별개다. 기존 planner 권한·revision·frontier·원자 commit 검사를 유지한다.

`geographySnapshotKey`는 전체 catalogRef와 metadataRef를 canonical hash한다. 기본 cache 상한은 `GEOGRAPHY_CACHE_LIMITS = {maxEntries:4, ttlMs:300000}`이며 B가 유한한 상한과 만료를 구현한다. prepared turn은 최초 채택한 snapshot을 강하게 참조하고 해당 metadataRef를 prepared-context 캐시 키에 포함해야 한다. cache 만료나 alias 갱신 중에도 같은 prepared 요청의 도구·model view·host 검증은 같은 snapshot을 쓴다. stale 참조는 오류로 반환한다.

이름 metadata는 sourceCountryId만 보유한다. 현재 owner/controller는 전달받은 최신 World V3에서 기존 read/validation 경계로 읽는다. 소유권 이전 후에도 정적 검색 identity와 sourceCountryId는 보존한다.

## 기존 RegionRecord와 subdivision reference

기존 `RegionReference = {catalogId, sourceVersion, subdivisionId}`를 그대로 유지한다. operational region의 sourceVersion은 geometryRoot이며 metadataRef가 아니다.

| 변환 | 규칙 |
| --- | --- |
| 기존 state급 참조 → 새 State | 전체 catalogRef를 검증하고 기존 operational region adapter가 만든 ref를 lookup해 catalogParentKey와 대조한 뒤 새 metadataRef에 고정한 reference를 반환 |
| 새 State → 기존 RegionRecord | 기존 부모의 ref 생성 경로와 정확한 operational membership을 사용. stateId/raw sourceFeatureId를 subdivisionId로 직접 대입하지 않음 |
| Province/SourceRegion → 기존 region | 기존 canonical subdivision ref가 없는 대상이다. 새 GeographyReference와 조회 경로를 사용. 임의 subdivisionId 생성 금지 |
| 이름/품질 projection | RegionRecord.nameKo 필수값에 display fallback을 넣더라도 검증된 한국어 fact로 되돌리지 않음. 새 names/coverage/parentStatus/kind/metadataRef는 별도 응답에 보존 |

기존 RegionRecord의 필드는 ref, parentCountryId, nameKo, nameEn, aliases, territoryIds, provenanceIds다. parentCountryId는 sourceCountryId로 명시적으로 대응하고 mutable owner로 해석하지 않는다. 기존 120자 이름·128자 subdivision ID 같은 제한에 맞지 않는 변환은 구체적인 오류로 반환한다. canonical identity나 이름을 조용히 잘라 맞추지 않는다. 변환 구현과 API strict schema·모델 function schema의 동시 갱신은 20-06에서 수행한다.

## 진단과 보완

공통 validator는 `{ok:true,value}` 또는 `{ok:false,diagnostics:[{code,path,message,remedy}]}`를 반환한다. 첫 실패의 구체적 위치를 보고하고 입력을 자동 보정하지 않는다. 성공한 metadata 객체는 재귀적으로 freeze한다.

| code | 의미 | 보완 |
| --- | --- | --- |
| GEOGRAPHY_SCHEMA | 필수/추가 필드, 타입, 경로, enum 오류 | repair-input: 공통 schema에 맞춰 producer 입력 수정 |
| GEOGRAPHY_CATALOG | 전체 ref·국가·기하 catalog 분류 불일치 | rebuild-for-catalog: 현재 기준으로 증분 재연결 |
| GEOGRAPHY_METADATA | contentRoot·요청 snapshot·artifact bytes 불일치 | pin-metadata: 올바른 불변 자료 선택; 임의 최신 fallback 금지 |
| GEOGRAPHY_NAME | 이름 근거/언어/표시 basis 오류 | repair-input: source·검증 번역·derived·null 구분 |
| GEOGRAPHY_PARENT | residual 승격, 국가/부모 충돌, 근거 없는 State | repair-input: 기존 부모 및 검증 crosswalk 확인; 불확정은 null |
| GEOGRAPHY_SOURCE | source/group 누락·분할·오류, 근거 없는 원본 | supply-evidence: 고정 identity와 전체 알려진 연결 제출 |
| GEOGRAPHY_MEMBERSHIP | province 누락·중복, 국가 요약 불일치 | repair-input: 현재 ID 집합과 파생 집계 재검증 |
| GEOGRAPHY_COVERAGE | 거짓 complete, target/evidence/개수 불일치 | supply-evidence: 독립 target 집합 보완 또는 partial/unsupported·null 사용 |

## 분기별 파일 소유권과 fixture 실행

| 담당 | 소유 범위 | 공유 계약 사용 |
| --- | --- | --- |
| 공통 20-02 | `src/lib/geography/state-province-{contract,validation,io}.ts`, 공통 fixture/test, 본 문서 | 계약 변경은 소비 분기와 함께 조정 |
| A 20-03/04 | `scripts/geography/` builder/adapter, 정적 이름 자료, 새 `data/derived/geography/` 출력, A 전용 테스트 | 공통 schema·sealer·validator·manifest 사용. runtime index/API 수정 금지 |
| B 20-05/06 | `src/lib/geography/`의 별도 loader/index/adapter 파일과 전용 테스트, 기존 region/API/model/prepared 연결 | 공통 fixture와 주입 인터페이스 사용. A builder·작성 중 artifact 수정 금지 |
| C 20-07 | `docs/geography/country-metadata-handoff-v1.md`, 별도 country-input helper와 C 전용 fixture/test | 공통 schema/validator 사용. A/B 내부 구현 의존 금지 |
| 20-08 합류 담당 | 실제 생산 output 선택·loader 연결과 공유 설정 | 최신 pointer 재확인 후 증분 통합 |

current.json, raw/source-lock, geometry/topology/ordinal/seed lineage, 국가 경계·CHN 표시 자료, 기존 save·사용자 게임은 이번 공통 작업의 수정 대상이 아니다. metadata 입력은 소규모 병합 후 현재 ID를 사용한다.

`createStateProvinceContractFixture()`는 fictional AAA/BBB, 5 cells, 2 동명 states, 3 source groups, 두 셀에 연결된 원본 한 개, null 부모, coarse/residual, game-adjusted 상태와 번역 부재, 전후 소유·통제 상태를 제공한다. `files: Map<path, Uint8Array>`에 독립 metadata/admission/manifest bytes가 있다. B는 이를 readArtifact/locator에 주입하고, C는 metadata/context를 직접 검사한다. fixture는 생산 catalog나 PASS 국가 자료가 아니다.

```powershell
node node_modules/vitest/vitest.mjs run src/lib/geography/state-province-contract.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js src/lib/geography src/lib/test-only/state-province-contract-fixture.ts
```

20-02에는 공통 계약과 fixture만 연결했다. 실제 metadataRef, 생산 builder/loader/API, 활성 포인터 발행 또는 새 국가 추가가 완료됐다는 의미가 아니다.
