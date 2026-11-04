# 현재 카탈로그 metadata builder — 20-03

[공통 계약 v1](state-province-contract-v1.md)을 사용하는 A 분기의 offline producer다. 실제 current 포인터에서 입력을 찾으며, 활성 카탈로그나 사용자 게임을 변경하지 않는다. 이번 입력은 소규모 셀 병합 후 `catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee`다. 실행 결과의 정확한 artifact pin은 [20-03 인계 기록](../../reports/maintenance/prompt20-03-metadata.json)에 남긴다.

## 실행

저장소 루트에서 실행한다. TypeScript와 나머지 의존성은 기존 설치본을 사용하며 다운로드하지 않는다.

```powershell
node --max-old-space-size=8192 scripts/geography/build-current-metadata.cjs
```

표준 출력은 manifest의 `{path,sha256,byteLength}`, metadataRef, 전체 catalogRef, 실제 집계, 출력 크기와 generation-report 경로다. current를 갱신하는 옵션은 없다. 재실행은 동일한 bytes의 기존 불변 파일을 재사용하고, 다른 bytes로 덮어쓰려 하면 실패한다. CLI는 잘못된 입력을 자동 보정하거나 임의의 PASS 파일을 받지 않는다.

```powershell
node --max-old-space-size=8192 scripts/geography/build-current-metadata.cjs --verify data/derived/geography/<contentRoot>/manifest.json
```

`--verify`는 manifest·payload의 byte pin과 snapshot을 검사한 뒤 현재 입력에서 source/parent/group membership을 독립적으로 재구성해 대조한다. producer adapter를 import하지 않는다. 별도 파일을 써서 PASS를 수동 선언하는 명령이 아니다.

## 출력과 압축 규약

```text
data/derived/geography/<metadataRef.contentRoot>/
  manifest.json
  metadata.json.gz
  admission.json.gz
  generation-report.json
```

공통 schema와 manifest 필드는 20-02 그대로 사용한다. Artifact.path는 실제 저장 파일을 가리킨다. 반복되는 근거가 많은 metadata/admission은 gzip level 9로 저장한다. 원문은 공통 `geographyArtifactBytes(value)`가 만드는 canonical UTF-8 JSON + LF다.

loader가 읽을 순서는 **저장된 gzip bytes의 sha256/byteLength 검증 → `.json.gz` 압축 해제 → JSON parse → 공통 schema/ref/contentRoot 검증**이다. 압축 해제한 bytes를 manifest의 파일 hash와 비교하지 않는다. metadataRef는 기존 계약대로 metadataRef를 제외한 **압축 전 body**의 canonical hash이며, artifact 파일 hash와 다르다. loader의 `readArtifact`는 저장 bytes를 반환하고 decode는 그 뒤 수행한다. producer verifier는 압축 해제 크기를 128 MiB로 제한한다.

20-05 당시 loader는 UTF-8 JSON만 읽었다. 20-08에서 gzip 저장 byte 검증 후 128 MiB 제한 해제를 연결했고, 이 producer 산출물의 실제 loader/API 검증을 마쳤다. [생산 연결 문서](production-geography-integration-v1.md)를 참조한다. 20-03 보고서는 당시 producer 단계의 범위를 유지한다.

Node·zlib·플랫폼과 압축 profile은 provenance.method에 포함한다. 같은 입력과 도구 환경의 gzip bytes가 결정적이며 다른 도구 환경도 같은 출력 경로를 재사용한다고 가정하지 않는다. manifest는 metadata/admission이 검증되고 불변 파일로 쓰인 다음 마지막에 작성한다. 완성된 metadata를 runtime에서 선택하는 registry나 current 포인터는 이 태스크에서 만들지 않는다.

## 입력과 연결

`current-input.ts`는 다음 경로를 읽고 각 파일의 실제 byte identity를 고정한다.

1. `data/runtime/operational-catalog/current.json` → artifact index → descriptor·manifest·detail index·parents·모든 국가 metadata·provenance.
2. provenance가 지정한 **현재 joined-world-input**의 records와 feature properties. 원본 source identity를 잃은 delivery polygon을 지명 근거로 사용하지 않는다.
3. 실제 fine 국가별 source-lock, raw/normalized features, hierarchy와 그 근거 artifact. 국가 허용 목록에 특정 세 국가를 하드코딩하지 않고 현재 fineCountries에서 수집한다. 현재 adapter는 한 pinned fine source와 members/assignments 계층 형태를 지원하며 다른 형식은 구체적 오류로 거부한다.
4. coarse 국가의 기존 Natural Earth parent identity와 `prompt14-derived-game-input-lock.json`에 고정된 admin1 원본.
5. builder/adapter/verifier, 공통 계약과 hash 구현, package lock의 코드 identity.

large JSON은 offline에서 properties를 추출하기 위해 읽는다. geometry를 재생성·보정·교차 계산하지 않고 metadata에 polygon을 넣지 않는다. 모든 cell/edge ID·ordinal·운영 행정 membership·seed lineage는 입력으로 보존한다. 부모의 start/count를 연속 ordinal 구간으로 해석하지 않는다.

KOR의 publisher hierarchy facts, PRK의 native ADM1 identity, CHN의 native ADM1 identity와 exact source crosswalk를 구별한다. synthetic runtime sourceFeatureId를 raw feature ID로 복사하지 않는다. coarse의 국가 분류는 현재 catalog를 따른다. 원본 ISO 표기만으로 새 CountryId를 만들거나 게임 국가 분류를 수정하지 않는다.

## 생성된 의미와 한계

현재 결과는 247개국의 8,004 Province, 4,201 State, 7,399 SourceRegion이다. State는 검증된 기존 부모 59개(fine 국가)와 기존 coarse 행정 부모 4,142개를 재사용한다. 도시·광역 단위를 새 게임 영토로 생성하지 않는다.

| 분류 | province 수 | 의미 |
| --- | ---: | --- |
| fine | 3,793 | 원본 하위 feature와 현재 cell의 고정 연결 |
| coarse | 4,169 | 244개국의 기존 해상도 유지; 이 중 source-free 27개 포함 |
| residual | 42 | fine 국가에서 원본 하위 지역을 배정하지 못한 조각 |
| source-backed 합계 | 7,935 | fine source 3,793 + 기존 coarse parent source 4,142 |
| source-free 합계 | 69 | 공식 지명 없이 derived display 제공 |
| state 미확정 | 1,436 | CHN의 미확정 fine source cell을 포함; source-free와 다른 집계 |

Fine 국가별 원본 feature 수와 province 수는 다르다. KOR 228개 원본 → 289 source-backed cells + 33 residual, PRK 179개 원본 → 192 + 2, CHN 2,864개 원본 중 2,850개가 현재 셀에 연결 → 3,312 + 7이다. 원본 feature 하나의 모든 현재 셀을 같은 SourceRegion에 넣는다. 동명 원본을 합치지 않는다.

CHN의 State 미확정 1,374 cells(원본 연결 1,367 + source-free 7), KOR 33, PRK 2와 coarse 국가의 27개를 null로 보존한다. CHN의 1,201 미확정 원본 feature 수와 셀 수를 혼동하지 않는다. 14개 CHN 원본 feature는 현재 셀이 없으며 generation-report에 원본 ID를 남긴다. 기존 sourceTrace의 envelope 밖 한계를 임의 셀 생성으로 해소하지 않는다. 소규모 병합의 현재 recipient ID·source identity·보정 근거를 보존하고 제거된 옛 ID를 복원하지 않는다.

기본 이름은 pinned 원본의 실제 이름이다. 원본 문자의 의미를 유지하며 canonical whitespace만 정리한다. 원본에 명시된 기존 언어 필드만 사용하고 한국어 필드의 영어 fallback은 null로 둔다. source-free 조각은 `<CountryId> fragment <기존 ID 앞 12자리>`라는 게임 표시명을 갖고 sourceName/nameKo/nameEn은 null이다. seed 부모의 옛 도시 이름을 공식 지명으로 상속하지 않는다. 새 한영 별칭 수집·번역 확장은 20-04에서 수행한다.

이번 producer는 모든 State/SourceRegion에 `expectedProvinceCount:null`, coverage `partial`(fine) 또는 `unsupported`(coarse)를 사용하고 `coverageWitnesses:[]`를 출력한다. **알려진 현재 멤버의 전체 열거**는 검증하지만 별도 지리 범위 증거 없이 complete를 발급하지 않는다. geometryStatus의 game-adjusted는 기존 게임 partition의 원본과의 관계를 나타내며 이번 작업에서 좌표를 수정했다는 뜻이 아니다. source-exact나 정확한 2020 행정 사실을 인증하지 않는다.

## 검증과 소유권

`verify-metadata.ts`는 raw/normalized identity, 기존 운영 parent, 현재 province/source country, 모든 원본 그룹의 알려진 집합, fine/coarse/residual 구분, source-free 이름, 국가 집계를 대조하고 20-02 공통 validator를 실행한다. 입력 파일과 active pointer는 생성 직전에 다시 hash 검사한다. 출력 변경은 producer가 새로 만든 불변 geography 디렉터리에 한정된다.

```powershell
node node_modules/vitest/vitest.mjs run scripts/geography/metadata-builder.test.ts src/lib/geography/state-province-contract.test.ts
node node_modules/typescript/bin/tsc --noEmit -p scripts/geography/tsconfig.json
node node_modules/eslint/bin/eslint.js scripts/geography
```

이 분기의 파일은 `scripts/geography/`, 새 `data/derived/geography/`, 본 문서와 20-03 인계 기록이다. 공통 schema·fixture, runtime loader/index/API, 기존 catalog/current·source-lock·CHN 표시 자료·사용자 게임은 수정하지 않는다. B/C는 manifest와 기존 공통 계약을 사용하고 A의 생성기를 runtime 요청에서 호출하지 않는다.
