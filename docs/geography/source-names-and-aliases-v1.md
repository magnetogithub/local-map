# 원본 이름·한영 표기·별칭 — 20-04

20-03의 Province/State/SourceRegion identity와 membership을 유지하면서 정적 이름 자료를 보강한다. 생산 파일 위치와 검증 결과는 [20-04 인계 기록](../../reports/maintenance/prompt20-04-names.json)을 따른다. 20-03의 불변 산출물은 보존한다. 활성 geometry catalog는 소규모 셀 병합 후 버전 `catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee`다.

## 이름을 추가하는 근거

| 자료 | 적용 방식 |
| --- | --- |
| 기존 Natural Earth admin1 원본 | 이미 등록된 coarse source identity에서 name_alt, name_local, gn_name, gns_name, woe_name을 읽는다. 원본의 pipe 구분자만 분리한다. postal 코드나 위치 설명을 지명으로 추정하지 않는다. |
| 기존 한국 publisher hierarchy facts | 검증된 원본 sourceFeatureId → matchedPublisherChildId 교차표로 원본 228개에 대응하는 native/name 필드를 연결한다. 동명 지역의 이름으로 첫 행을 선택하지 않는다. |
| [verified-name-facts-v1.json](../../data/geography/names/verified-name-facts-v1.json) | 청진·내몽골의 표기 근거를 reviewed factual snapshot으로 고정한다. 원문 기사·지도·사진을 복제하지 않는다. |
| [source-name-overrides-v1.json](../../data/geography/names/source-name-overrides-v1.json) | country/sourceId/sourceFeatureId/sourceVersion 전체와 expectedSourceName이 일치하는 두 개의 명시적 이름 crosswalk만 적용한다. |

한국 publisher의 현재 parent 필드는 이름 보강에 사용하지 않는다. 군위처럼 2020 시나리오 부모가 별도로 복원된 항목은 기존 hierarchy의 소속을 그대로 유지한다. 모든 언어 fact와 별칭은 pin된 원본·기존 교차표 또는 검토된 facts/override 파일을 evidence로 가진다.

## 청진과 내몽골

| 대상 | 원본 identity와 표기 | 현재 알려진 집합 |
| --- | --- | --- |
| 청진 | PRK `geoboundaries-gbOpen-PRK-ADM2-82179303` / `82179303B21659587132529`. 원본 `Chongjin City` 유지. nameKo `청진시`, nameEn `Chongjin City`, aliases `청진`, `Chongjin`. | 기존 SourceRegion 하나에 현재 Province 1개. State는 기존 함경북도 부모. coverage partial, expectedProvinceCount null. |
| 내몽골 | CHN `geoBoundaries-3_0_0-CHN-ADM1` / `CHN-ADM1-3_0_0-B18`. 원본 `Inner Mongolia` 유지. nameKo `내몽골 자치구`, nameEn `Inner Mongolia`. `내몽골`, `Inner Mongol`, `Inner Mongolia Autonomous Region`, `Nei Mongol`, `Nèiměnggǔ`, `Neimenggu` 별칭. | 기존 State `fine-macro:CHN:macro:CHN:CN-15`의 알려진 Province 48개. coverage partial, expectedProvinceCount null. |

한국어 청진시 표기는 [한국학중앙연구원 한국민족문화대백과사전](https://encykorea.aks.ac.kr/Article/E0056774), 영어 표기는 [WFP·FAO·UNICEF 보고서의 Mission Details, 인쇄 5쪽](https://cdn.wfp.org/wfp.org/publications/english_rfsa.pdf)에서 확인했다. `청진`과 `Chongjin`은 해당 도시 이름의 검토된 짧은 표기다. 기사에 있는 역사적 지리 서술이나 보고서 작성 시점의 범위를 현재 게임 polygon으로 채택하지 않는다.

내몽골의 기본 한영 표기와 여러 이명은 고정된 [Natural Earth 원본](https://github.com/nvkelso/natural-earth-vector/blob/f1890d9f152c896d250a77557a5751a93d494776/geojson/ne_10m_admin_1_states_provinces.geojson)의 ne_id `1159312757` 필드에서 확인했다. `Neimenggu`와 `Inner Mongolia`의 병용은 [중국 상무부 공개 자료](https://cacs.mofcom.gov.cn/cacscms/article/ckys?articleId=39597&type=1)에서 확인했다. 두 배포본의 서로 다른 행정 코드나 polygon은 이름 연결만으로 합치지 않는다.

청진을 찾는다는 사실은 **원본 도시 개체와 알려진 현재 셀 집합을 찾았다는 뜻**이다. 2020의 법적 도시 범위 전체나 보정 전 원본 polygon 전체가 같다는 증거는 없다. 내몽골의 48개 알려진 셀과 CHN의 부모 미확정 1,374개 셀도 서로 다른 집합이다. 별칭 추가로 미확정 셀을 내몽골에 배정하지 않는다. coverage와 null 부모는 20-03과 같다.

## Adapter와 정규화

- `scripts/geography/name-enrichment.ts`는 facts/override schema, 검토된 표기의 적용, publisher 이름 적용, alias evidence 병합을 제공한다.
- SourceName과 displayName은 기존 원본 값을 유지한다. 검증한 번역만 nameKo/nameEn에 기록한다. 영어 fallback을 한국어 fact로 복사하지 않는다. source-free 조각의 derived display와 null 언어 fact도 유지한다.
- alias 중복은 공통 `normalizeGeographyName`의 공백·NFKC·대소문자 규칙으로 판별한다. 중복 표기의 evidence는 합친다. 구두점·발음·악센트를 일괄 제거하지 않는다. `Nèiměnggǔ`와 `Neimenggu`는 각각의 근거로 명시적으로 등록한다.
- 같은 이름의 다른 원본 feature를 합치지 않는다. sourceCountryId, 원본 identity, State와 전체 provinceIds를 보존한다. 하나의 원본이 여러 셀로 나뉘어도 SourceRegion 하나가 전체 알려진 셀을 담는다.
- “북한 북부”, “휴전선 인근”, “현재 전선” 같은 공간 의도는 표기 목록에 추가하지 않는다.

## 전용 검증

`verify-name-metadata.ts`는 producer 이름 함수에 의존하지 않고 실제 원본 필드·publisher 교차표·curated facts를 읽어 다음을 검사한다.

1. 모든 sourceName 보존, 언어 필드와 별칭의 허용 값, 이름별 근거 pin.
2. curated target 두 개가 실제 현재 원본 identity에 적용됐는지 여부.
3. source-free 조각에 공식 이름·별칭이 생기지 않았는지 여부.
4. `findStaticNameCandidates`로 모든 정규화된 후보와 전체 known membership을 반환하는 정적 출력 검사. 이 함수는 B의 runtime index나 API가 아니다.

```powershell
node node_modules/vitest/vitest.mjs run scripts/geography/metadata-builder.test.ts scripts/geography/name-enrichment.test.ts src/lib/geography/state-province-contract.test.ts
node node_modules/typescript/bin/tsc --noEmit -p scripts/geography/tsconfig.json
node node_modules/eslint/bin/eslint.js scripts/geography
node --max-old-space-size=8192 scripts/geography/build-current-metadata.cjs
node --max-old-space-size=8192 scripts/geography/build-current-metadata.cjs --verify data/derived/geography/<contentRoot>/manifest.json
```

생성된 validation.names의 aliasCount와 언어별 record 수는 State·Province·SourceRegion의 **레코드 내 항목 수**다. 고유 지명 수나 공식 행정구역 개수로 해석하지 않는다.

20-04 결과 기록은 실제 청진/내몽골 한영 조회, 공백·NFKC·대소문자, 동명 후보, 한 원본의 여러 셀, 공간 의도 미등록, 20-03 대비 ID·membership·coverage 보존을 검증해 남겼다. gzip 저장 bytes의 pin 검증·decode 순서는 [producer 문서](current-metadata-builder-v1.md)를 따른다. 실제 B loader/API/model의 반환 결과와 활성 manifest 선택은 [20-08 생산 연결](production-geography-integration-v1.md)에서 합류했고 [20-09 통합 기록](../../reports/maintenance/prompt20-completion.md)에 최종 검사를 정리했다. 20-04 당시 runtime 검색 index/API는 수정하지 않았다.
