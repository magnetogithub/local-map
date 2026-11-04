# 국가별 metadata 인계 계약 v1

20-07의 산출물이다. 국가 자료 작업자는 아래 입력을 준비하고, 메인 작업자는 독립적으로 검증한 catalog/source 근거를 주입한다. 공통 [State·province 계약](state-province-contract-v1.md)의 schema와 의미 검증을 그대로 사용한다. 국가별 schema 복제, builder·loader 호출, 새 국가 geometry 생성이나 발행은 포함하지 않는다.

## 기준선과 제출 단위

매번 `data/runtime/operational-catalog/current.json`에서 시작한다. pointer bytes, 실제 artifact-index와 descriptor의 byte identity를 확인하고 **전체 catalogRef 5필드**를 고정한다. 버전 문자열만 같아서는 같은 기준선이 아니다. [20-01 baseline](../../reports/maintenance/prompt20-baseline.json)은 입력 탐색의 참고이며 새 실행의 pointer를 대신하지 않는다.

20-07 확인 시점의 활성 catalog는 `catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee`이며 descriptor는 247개국·8,004 cells를 등록한다. 이 값들은 관측 기록이고 허용 국가/합격 개수가 아니다. 생산 metadataRef는 이 태스크에서 생성하거나 선택하지 않는다.

제출 metadata는 공통 `GeographyMetadata` 형식의 **국가별 준비 입력**이다. `countries`는 대상국 한 항목, `provinces`는 그 국가의 기존 catalog cell 전체, `states`와 `sourceRegions`는 그 국가의 검증된 레코드다. fine 셀만 제출하고 기존 coarse/residual 셀을 누락하면 거부한다. 같은 provenance를 공유할 수 있지만 다른 국가의 entity는 포함하지 않는다.

`CountryId`는 실제 catalog의 `sourceCountryId`를 사용한다. 국가명이나 ISO 별칭에서 새 identity를 만들지 않는다. helper는 주입된 catalog의 국가와 영토 분류를 검사하며 KOR/PRK/CHN 허용 목록을 갖지 않는다. 아직 catalog에 없는 CountryId는 거부한다. 새 국가 identity나 geometry의 등록이 필요하면 메인 작업자가 별도 증분 통합 작업을 마친 후 갱신된 기준선으로 입력을 다시 준비한다.

## 국가 자료 작업자가 제출할 내용

모든 필드는 [공통 schema](../../src/lib/geography/state-province-contract.ts)에 정의돼 있다. 아래 표는 기존 필드와 제출 근거를 연결한다. nullable 필드는 생략하지 않고 null로 작성한다.

| 제출 항목 | 공통 필드와 필요한 근거 |
| --- | --- |
| 카탈로그 기준 | `catalogRef`: catalogVersion, geometryRoot, topologyRoot, renderArtifactRoot, manifestPath 전체. pointer/index/descriptor와 기존 국가 metadata의 실제 bytes를 pin |
| 원본 채택 자료 | 원본 파일·source-lock·행정 계층·국가 crosswalk를 `provenance.inputs`에 `{path, sha256, byteLength}`로 등록. 채택한 source-lock에는 출처, 버전/시점, 라이선스·재배포 판단의 근거를 보존 |
| 생성 근거 | `provenance.scenarioDate`, `method`, `code`, `limitations`. 실행마다 달라지는 현재 시각은 넣지 않음. evidence가 참조하는 모든 파일을 inputs/code에 등록 |
| 원본 identity | `Source`: sourceId, sourceFeatureId, sourceVersion, artifact, temporalStatus, temporalNotes. 원본 국가 코드와 catalog CountryId 연결은 독립 crosswalk로 확인 |
| State 부모 | stateId와 catalogParentKey는 검증된 기존 행정 parentKey. `parentSources`에 raw source와 runtime 부모의 crosswalk 제출. runtime sourceFeatureId가 synthetic이면 raw ID와 구분 |
| Province | provinceId는 현재 TerritoryId 그대로. sourceCountryId, names, precision, geometryStatus, sources, evidence, parentEvidence 제출 |
| 확정/미확정 부모 | 확정은 `parentStatus: verified`, stateId, unassignedReason:null. 미확정은 `parentStatus: unassigned`, stateId:null, 구체적 unassignedReason과 parentEvidence |
| 원본과 현재 셀 연결 | `sourceMemberships`: sourceCountryId, Source, 그 원본에 연결된 **알려진 현재 provinceIds 전체**. 기존 고정 sourceTrace/병합 입력에서 확인하고 locator와 방법 기록 |
| 이름 묶음 | `sourceRegions`: createSourceRegionId(countryId, sourceId, sourceFeatureId), Source, names, provinceIds, coverage, evidence. 한 원본의 여러 셀은 같은 그룹, 다른 동명 원본은 별도 그룹 |
| 이름 | displayName·displayBasis·displayEvidence, sourceName, nameKo, nameEn, aliases. source/검증 번역/derived/null을 구분하고 별칭에도 언어와 근거 기록 |
| 범위 | coverage의 status, knownProvinceCount, expectedProvinceCount, evidence, limitations. complete/예상 전체를 주장하면 독립 coverageWitnesses 제출 |
| 국가 요약 | counts는 `countGeographyCountry`로 파생. sourceFeatureCount와 officialSubdivisionCount는 서로 다른 단위이며 모르면 null, 알면 각각 evidence 제출. nameSupport/parentSupport는 실제 레코드로 집계 |

원본 feature와 현재 province 연결은 셀 중심점 근사·이름 유사도로 새로 추정하지 않는다. 소규모 병합 전 ID를 복구하거나 ordinal을 ID로 사용하지 않는다. `previousParentOrdinal`·seedParentIds는 초기 게임 상태 상속 근거이며 공식 부모/도시명 근거가 아니다. CHN 표시용 경계나 renderProvinceId도 공식 소속을 인증하지 않는다.

### 이름·범위의 품질

- 모든 province에는 비어 있지 않은 displayName이 필요하다. 원본 이름이 없는 조각은 기존 ID 등을 활용한 derived 표시명과 근거를 제공한다. 공식 지명을 만들어 붙이지 않는다.
- 검증한 한국어 번역이 없으면 nameKo:null이다. 영어 fallback을 한국어 fact로 복사하지 않는다. 공간 지시어를 공식 별칭으로 등록하지 않는다.
- 한 원본 이름을 검색할 수 있다는 것과 그 지역 전체 셀 범위를 지원한다는 것은 다르다. `sourceMemberships`의 알려진 셀 전체 열거도 공식 지리 범위의 complete를 보장하지 않는다.
- partial/unsupported에는 limitations가 필요하다. 전체를 모르면 expectedProvinceCount:null이다. 독립 검증이 없으면 complete로 올리지 않는다.
- fine은 실제 원본 연결을 갖는다. residual은 source-free와 null 부모를 보존한다. coarse에 이름 metadata를 붙이는 것으로 fine이 되지 않는다.
- Source의 scenario-verified/source-vintage-only/unknown과 게임 geometry의 source-exact/game-adjusted/source-free를 구분한다. 게임에 맞게 보정했다는 사실이 역사적 행정 사실의 증명은 아니다.

## 실행 가능한 검증 helper

[country-metadata-input.ts](../../src/lib/geography/country-metadata-input.ts)의 공개 함수는 다음과 같다.

```ts
validateCountryMetadataInput(sourceCountryId: unknown, value: unknown,
  context: GeographyAdmissionContext): GeographyResult<CountryMetadataPreparation>
```

`value`에는 국가별 공통 metadata를 전달한다. 객체를 ID 순서로 정렬하고 집계한 뒤 `sealGeographyMetadata(body)`로 봉인한다. 이때 metadataRef는 **국가 준비 입력의 content hash**다. 전체 catalog용 metadataRef나 활성 consumer 참조로 사용하지 않는다. 준비 입력을 production manifest로 발행하지 않는다.

`context`는 메인 작업자가 확인한 **전체** catalog와 독립 근거다.

| context 필드 | 신뢰 경계 |
| --- | --- |
| catalog, countryIds, cells, administrativeParents | 고정 catalog의 metadata-only view. 모든 국가의 원래 ordinal을 유지. 제출 metadata에서 역으로 만들어 신뢰하지 않음 |
| parentSources | 고정 원본 계층과 catalog 부모를 검증한 crosswalk. 이름이나 seed 관계로 생성하지 않음 |
| sourceMemberships | 독립 확인한 국가별 원본 identity와 기존 셀 전체 연결. 다른 국가의 source를 가져와 국가 코드만 바꿔 제출하면 불일치 |
| coverageWitnesses | raw·계층·현재 셀 연결에서 별도 검증한 target 집합과 evidence. 제출 coverage 플래그나 제출 그룹 목록에서 생성하지 않음 |

helper는 catalog의 대상국 ID 집합, 그 국가의 원본/부모 근거와 witness를 선택하고 공통 `validateGeographyMetadata`를 호출한다. parent ordinal은 전역 배열의 인덱스이므로 부모 배열을 재번호화하지 않는다. witness는 제출 레코드가 아니라 독립적으로 admission된 source/parent identity로 선택한다. 누락한 레코드의 증거까지 함께 빠져서 통과하는 것을 막는다.

```ts
import {validateCountryMetadataInput} from './src/lib/geography/country-metadata-input';

// preparedCountry: 공통 schema로 봉인한 국가별 입력
// verifiedFullContext: 메인 작업자가 catalog와 offline 증거를 독립 검증한 결과
const checked = validateCountryMetadataInput(countryId, preparedCountry, verifiedFullContext);
if (!checked.ok) {
  console.error(checked.diagnostics); // code, path, message, remedy
} else {
  const preparation = checked.value;
  // scope === 'country-preparation'; metadata는 재귀적으로 freeze됨
  // 메인 통합 작업에 전달하고 전체 snapshot 검증을 별도로 수행한다.
}
```

성공은 이 context에 대한 공통 계약 일치를 뜻한다. 함수는 파일을 읽거나 실제 bytes의 hash, 라이선스, 번역의 진위, polygon 정합을 재검증하지 않는다. 입력/근거의 bytes는 주입 전에 `verifyGeographyArtifact` 등으로 검사하고 원본 국가 crosswalk와 사실은 offline 검증한다. schema에 맞게 만든 자기 선언만으로 채택을 완료하지 않는다.

실패는 공통 진단을 그대로 반환하며 자동 수리하지 않는다. 대표적으로 미등록 국가/다른 catalog는 GEOGRAPHY_CATALOG, 누락·중복·다른 국가 셀은 GEOGRAPHY_MEMBERSHIP, 잘못된 부모는 GEOGRAPHY_PARENT, 원본 연결 불일치는 GEOGRAPHY_SOURCE, 거짓 complete는 GEOGRAPHY_COVERAGE다. content hash가 바뀐 입력은 GEOGRAPHY_METADATA로 거부한다.

### 작은 fixture로 실행

[전용 fixture](../../src/lib/test-only/country-metadata-handoff-fixture.ts)는 기존 공통 fixture의 fictional AAA/BBB를 두 국가 준비 입력으로 나눈다. 5개 셀, 다른 국가의 동명 지역, 두 셀에 연결된 원본, 미확정 부모, coarse/residual과 부분 범위를 재사용한다. 실제 원본을 복제하거나 source-lock·채택/PASS 국가 파일을 만들지 않는다. A builder와 B loader 없이 실행된다.

저장소 루트에서 다음 명령을 실행한다.

```powershell
node node_modules/vitest/vitest.mjs run src/lib/geography/country-metadata-input.test.ts src/lib/geography/state-province-contract.test.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js src/lib/geography/country-metadata-input.ts src/lib/geography/country-metadata-input.test.ts src/lib/test-only/country-metadata-handoff-fixture.ts
```

전용 테스트는 같은 helper로 두 가상 국가를 검사하고 국가·catalog 5필드·부모·원본 연결·셀 누락/중복·거짓 complete를 거부한다. 단일국 준비 입력이 전체 catalog 검증을 통과하지 못하는 경계와 메모리상의 전체 재조립도 확인한다. 마지막 재조립 검사는 생산 builder/consumer의 일치를 검증했다는 의미가 아니다. 실제 실행 결과와 기준선 identity는 [20-07 실행 기록](../../reports/maintenance/prompt20-07-country-handoff.json)에 남긴다.

## 파일 소유권과 최신 기준선 통합

| 담당 | 수정·제출 범위 |
| --- | --- |
| 국가 자료 작업자 | 대상국의 raw/source-lock/계층/이름/crosswalk/고정 셀 연결과 offline 검증 근거. 준비 metadata와 위 품질 정보. 다른 국가 자료·활성 pointer·공유 schema를 수정하지 않음 |
| C / 20-07 | 본 문서, country-metadata-input.ts와 전용 test/fixture, 20-07 실행 기록. 공통 schema를 import하며 복제하지 않음 |
| A / 20-03·04 | metadata builder, 국가 adapter, 정적 이름/별칭과 불변 출력. C helper는 A 내부 구현을 의존하지 않음 |
| B / 20-05·06 | loader/index/region/API/model/prepared 연결. C helper는 B 내부 구현을 의존하지 않음 |
| 메인 / 20-08 | 최신 current 재확인, 독립 입력 admission, 국가별 준비 입력 검사, 전체 metadata 조립과 공통 의미 검증, 실제 manifest/loader/API 연결 |

전체 metadata는 최신 catalog의 **모든 국가·모든 province**와 대조해야 한다. 국가 준비 입력의 seal을 그대로 재사용하지 않고, 조립한 전체 body의 provenance와 entity 순서/집계를 확정하여 metadataRef를 다시 계산한다. global admission도 그 ref에 고정하고 metadata/admission을 서로 다른 artifact bytes로 pin한다. 기존 manifest·artifact 검증을 수행한 후 신뢰하는 selector에 연결한다. 실행 중 pointer가 바뀌었다면 stale 기준선을 조용히 최신으로 해석하지 않고 영향을 받는 입력을 재검증한다.

실제 metadata와 consumer 일치는 20-08에서 검증했다. 현재 fine 3개 국가와 coarse 244개 국가 전부의 준비 입력이 이 helper를 통과했으며, 전체 생산 loader/API와 같은 catalog에 연결됨을 확인했다. [생산 연결](production-geography-integration-v1.md)과 [최종 통합 기록](../../reports/maintenance/prompt20-completion.md)을 참조한다. 국가별 준비 입력의 ref를 전체 생산 ref로 사용하지 않으며, 새 국가 추가 CLI가 완성됐다는 의미도 아니다. 활성 geometry/topology, 운영 membership, ID/seed lineage, 현재 owner/controller와 사용자 게임을 변경하지 않는다.

현재 geometry 생성기의 KOR/PRK 제한과 일부 packager·발행 검증의 국가 전제는 별도 구현 제약이다. metadata helper가 다른 catalog 국가를 지원한다는 이유로 이 제한을 삭제하지 않는다. 실제 대상국 미세화는 [국가 지정형 개발 지침](../../prompts/COUNTRY_MICRO_BOUNDARY_GUIDE.txt)을 따라 원본 조사·채택과 증분 통합부터 수행한다.

## 입력이 바뀌었을 때 재검증

| 변경 | 필요한 재검증 |
| --- | --- |
| 이름·번역·별칭 | fact/alias evidence, display basis, 공통 이름/요약 검증, seal/metadataRef. 다음 통합에서 실제 검색·동명 후보 및 metadata cache 분리 확인. ID와 geometry는 유지 |
| 원본 bytes·sourceVersion·국가 crosswalk | input pin, 시점/라이선스 근거, 원본 identity와 국가/셀 연결, source group·집계·영향받는 coverage, metadataRef |
| 행정 계층·부모 근거 | 기존 parentKey와 국가 일치, raw/runtime crosswalk, verified/null 부모, State 파생 membership, parentSupport·coverage |
| 셀 병합·원본/셀 연결 | 최신 존재 ID 전집합과 국가 분류, 전체 알려진 source membership, source group·coverage witness·집계. 옛 ID를 복구하지 않음 |
| coverage witness·전체 개수 근거 | 독립 target 집합, known/expected·complete/partial/unsupported·limitations, evidence, 별도 원본/공식 개수 |
| current/catalogRef 변경 | pointer/index/descriptor와 전체 5필드 재확인, 국가별 준비 입력을 새 catalog로 검증, 전체 metadata 조립·artifact identity·실제 consumer 회귀 검증 |
| 공통 schema 변경 | A/B/C 계약 변경 조정, 전용/공통 fixture와 생산 입력 재검증. 국가별 schema를 갈라서 우회하지 않음 |

20-07의 완료 범위는 위 준비 계약과 독립 실행 helper다. 이후 20-08에서 현재 자료를 합류했고 20-09에서 결과를 인계했다. 실제 다음 국가 자료 수집·geometry 생성·최신 catalog 발행은 별도 후속 작업이다.
