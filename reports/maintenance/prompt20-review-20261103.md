# 프롬프트 20 전체 검증 및 수동 확인 안내

검증일: 2026-11-03, Asia/Seoul. 대상은 프롬프트 문서와 현재 작업 폴더의 20-01~20-09 구현이다. 기존 완료 보고서를 그대로 승인하지 않고 코드, 생성 자료, 실제 생산 API와 검사 결과를 대조했다. 최초 검증에서는 애플리케이션 코드와 기존 완료 기록을 수정하지 않았다. 이후 사용자 요청으로 적용한 검색 모호성 수정은 아래 후속 결과와 별도 기록으로 구분한다.

## 판정

공통 State/Province/SourceRegion 계약, 현재 카탈로그의 정확한 영토 연결, 이름·별칭, 버전 고정 loader, API/AI 읽기 경로와 국가별 입력 helper는 구현되어 있다. 다만 **새로 확인한 수정 권고 2건과 기존 테스트 실패 1건이 있으므로 무조건적인 전체 PASS로 판정하지 않는다.**

후속 수정: 사용자 요청에 따라 아래 1번 검색 모호성 문제를 해결했다. 종류 지정 지침을 반영했고, 종류 미지정 검색도 같은 원본의 중복 표현을 정리한다. 관련 41개 테스트·타입·lint·새 production build와 별도 production HTTP 검사가 통과했다. 2번 고정 집계와 기존 실패 1건은 남아 있다. 상세 결과는 `prompt20-ambiguity-fix-20261103.json`에 기록한다. 위 검증 본문의 수치와 최초 재현은 수정 전 기록이다.

현재 기준은 catalog `catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee`, metadata `d10c6db6e6c56bc2c2c53ee26fb281a042b31d16592d45960814f90028158fbf`다. 관측 집계는 247개 국가, 8,004개 Province, 4,201개 State, 7,399개 SourceRegion이다. 이 수치는 이번 검증 시점의 기록이며 후속 국가 추가의 합격 상수가 아니다.

## 수정 권고와 기존 실패

### 1. [해결] 종류를 지정하지 않은 검색이 같은 지역을 모호한 동명 후보로 판단한다

- 위치: `src/lib/geography/state-province-index.server.ts:110` 및 다음 줄.
- 수정 전 실제 생산 API에서 `청진`, PRK, `kind:null`은 Province 1개와 SourceRegion 1개를 반환하며 `totalMatches:2, ambiguous:true`가 됐다.
- 수정 전 `태안군`, KOR, `kind:null`은 Province 3개와 그 3개를 묶는 SourceRegion 1개를 반환하며 `totalMatches:4, ambiguous:true`가 됐다.
- `kind:'source-region'`으로 지정하면 청진과 태안군 모두 원본 후보 1개로 정상 조회된다. 태안군의 알려진 셀은 3개다.
- 서로 다른 원본의 실제 동명 지역과, 같은 원본을 나타내는 셀·이름 묶음의 선택을 구분해야 한다. 수정 전에는 단순히 검색 레코드가 두 개 이상이면 모두 ambiguous로 판단했다.
- 영향: GPT가 종류를 아직 모르는 지명을 `kind:null`로 조회하면 불필요한 확인 질문이나 잘못된 후보 선택을 할 수 있다. 원본 하나의 여러 셀을 동명 지역들로 오인하지 말라는 20-04의 취지에도 맞지 않는다.
- 권고: 일반 지명 검색에서 canonical 원본 묶음을 우선하거나, 표현 종류의 선택과 실제 지명 모호성을 별도로 반환한다. Province ID와 원본 membership은 유지한다. 같은 원본의 복수 셀, 동일 범위를 가진 서로 다른 kind, 실제 동명 원본을 구분하는 회귀 사례를 추가한다.
- 반영한 조치: GPT 지침과 도구 설명에 위 종류 지정을 명시했다. 종류 미지정 검색은 같은 원본의 일치한 이름 묶음이 셀을 대표하도록 하고, 원본 identity·근거와 membership이 모두 같은 State/SourceRegion도 한 후보로 정리한다. 서로 다른 원본의 동명 후보와 명시적 province 검색은 유지한다. 청진·태안군은 후보 1개, 중구는 6개로 실제 HTTP 재검증했다. ID·membership·coverage는 변경하지 않았다.

### 2. 실데이터 회귀 검사에 현재 셀 개수와 fine 국가 목록이 고정돼 있다

- 위치: `src/lib/geography/production-geography.integration.test.ts:68`~72, `scripts/geography/smoke-production-geography.mjs:34`, 63~64.
- 생산 통합 검사는 8,004/4,201/7,399/247개와 fine 국가 CHN/KOR/PRK, coarse 244개를 그대로 기대한다. smoke도 8,004개 셀을 기대한다.
- 현재 카탈로그 검사는 통과한다. 그러나 다른 기존 국가의 세부 프로빈스를 정상 추가해 셀 수·fine 국가 집합이 바뀌면 고정 기대값이 실패한다. 실제 새 국가 추가는 이번 검증에서 수행하지 않았다.
- builder는 현재 provenance의 fineCountries를 읽고, 공통 schema와 국가별 helper도 세 나라 허용 목록을 강제하지 않는다. 문제는 이 실데이터 검사 경로의 고정 기준이다.
- 권고: 활성 descriptor의 실제 ID 전집합과 countryOrder, 검증된 source/hierarchy 입력에서 기대 집계를 계산한다. 특정 스냅샷의 숫자를 확인하는 검사는 별도로 고정된 fixture에 둔다. 기록용 관측 수치는 남겨도 된다.
- 후속 국가 작업 전 우선순위: 원본 조사·정규화·이름 자료 준비는 병렬로 가능하다. 최종 통합 전에는 이 검증 기준을 동적으로 바꾸는 편이 좋다. 활성 pointer와 최종 metadata 발행은 통합 담당자가 순서대로 처리한다.

### 3. 기존 세션 정책 테스트 1개가 실패한다

- `src/lib/simulation/server/operational-game-version.test.ts`의 `invalidates sessions retained across a catalog change and rejects their IDs`.
- 실제 오류는 `UNSUPPORTED_LEGACY_GAME_POOL_PRESENT`다. 테스트는 이전 세션 삭제를 기대하지만 현재 구현은 checkpoint/보존 정책을 사용한다.
- HEAD의 기존 코드에도 동일한 거부 경로가 있어, 이번 지명 계약에서 새로 생긴 실패로 분류하지 않는다. 기존 완료 보고서의 실패 공개 내용과도 일치한다.
- allocation, checkpoint, pool preservation 관련 검사는 통과했다. 전체 검사 녹색을 주장하려면 별도 작업으로 테스트 전제를 현재 보존 정책과 정리해야 한다. 테스트 삭제나 사용자 게임 초기화로 해결하지 않는다.

## 실제 확인 결과

| 항목 | 결과 |
| --- | --- |
| 관련 테스트 | 16개 파일, 157개 중 156개 통과 / 기존 실패 1개 |
| 지리 계약·loader·consumer·생성기·별칭·국가 helper | 103개 모두 통과 |
| TypeScript | 루트 및 scripts/geography 양쪽 통과 |
| Lint / whitespace | 변경·신규 관련 파일 검사 및 git diff --check 통과 |
| 현재 metadata offline 검증 | 통과. raw/source/parent/group 연결 및 정확한 catalog ID 집합 확인 |
| 보존된 기준 입력 | 298개 hash/크기 전부 일치 |
| 현재 코드·생산 파일 | 45개 pin, 선택된 metadata artifact 3개 전부 일치 |
| Production build | 기존 성공 산출물 재사용. 관련 입력·출력 12개 pin과 현재 코드 동일성 확인 |
| UI | 기존 성공 smoke의 증거 3개 pin 일치, 초기 화면·KOR 게임 화면 스크린샷 확인. 이번에 브라우저 조작을 다시 수행한 것은 아님 |
| 실제 HTTP | 별도 production 서버에서 새로 확인. 기존 개발 서버·사용자 게임을 사용하지 않음 |
| 잘못된 참조 | 다른 metadataRef 409, 없는 source country 400, 필수 nullable 필드 누락 400 |
| prepared context | 선택된 catalogRef/metadataRef 일치. 조회·prepare 뒤 새 격리 게임의 revision/history 불변 |
| 외부 AI 호출 | 0회. AI 연결 검사는 scripted provider이며 실제 GPT의 판단 품질까지 인증하지 않음 |

검증 중 의존성 파일 누락으로 첫 검사가 중단됐다. 사용자 요청에 따라 `C:\Program Files\nodejs\npm.cmd ci --no-audit --no-fund`로 package-lock 기준 530개 패키지를 복구한 후 필요한 검사를 다시 수행했다. package.json/package-lock.json은 변경하지 않았다. 현재 이 환경의 `npm` 이름은 다른 경로 항목에 가려져 있어 아래 실행 예시는 `npm.cmd`를 사용한다.

## 직접 확인하는 방법

이번 작업은 내부 데이터와 읽기 기반이다. 지도 위 모든 province 라벨이나 새 지명 검색 화면을 추가하지 않았다. 기존 상단 국가 검색창에 도시명이 안 나오는 것만으로 실패라고 판단하지 않는다.

저장소 루트 PowerShell에서 개발 서버가 꺼져 있으면 `npm.cmd run dev`를 실행한다. 다음 명령은 별도 PowerShell에서 실행한다. 개발 서버 주소가 다르면 Base 값을 바꾼다. 이 함수는 지리 조회만 수행하며 사용자 게임 상태를 변경하지 않는다.

```powershell
$GeoRegistry = Get-Content data/runtime/geography/current.json -Raw -Encoding UTF8 | ConvertFrom-Json
$GeoBase = 'http://localhost:3000'
function Read-Geography {
    param($Query = $null, $Country = $null, $Kind = $null,
          $Operation = 'search', $Reference = $null, $Offset = 0, $Limit = 128)
    $body = @{
        mode = 'geography'; catalogRef = $GeoRegistry.catalogRef
        metadataRef = $GeoRegistry.metadataRef
        request = @{
            operation = $Operation; sourceCountryId = $Country
            kind = $Kind; query = $Query; reference = $Reference
            page = @{ offset = $Offset; limit = $Limit }
        }
    } | ConvertTo-Json -Depth 20
    Invoke-RestMethod -Uri "$GeoBase/api/world/regions" -Method Post `
        -ContentType 'application/json; charset=utf-8' `
        -Body ([Text.Encoding]::UTF8.GetBytes($body))
}
$city = Read-Geography -Query '청진' -Country 'PRK' -Kind 'source-region'
$city.value | Select-Object totalMatches, ambiguous, truncated
$city.value.items | Select-Object reference, knownProvinceCount, parentStatus, coverage
```

| 순서 | 직접 확인할 내용 | 기대 결과 |
| --- | --- | --- |
| 1 | 청진 / Chongjin City, PRK, source-region | 각각 후보 1개, 같은 target.id, 알려진 셀 1개, partial |
| 2 | 내몽골 / Inner Mongolia, CHN, state | 각각 같은 state ID, 알려진 셀 48개, partial |
| 3 | 태안군 / Taean-gun, KOR, source-region | 원본 후보 1개, 알려진 셀 3개. 서로 다른 동명 지역 3개로 표시하지 않음 |
| 4 | 중구, KOR, source-region | 서로 다른 원본 후보 6개, ambiguous:true. stateId로 상위 지역을 구분하고 첫 후보를 임의 채택하지 않음 |
| 5 | 태안군 members를 limit:1로 조회 | totalMatches:3, 이번 페이지 1개, truncated:true, coverage는 계속 partial |
| 6 | CHN province 목록에서 parentStatus:unassigned인 항목 | stateId:null 유지. 임의의 성으로 확정하지 않음 |
| 7 | 청진 또는 태안군을 Kind 없이 조회 | 수정 후 각각 원본 후보 1개, ambiguous:false. 태안군의 알려진 셀 3개는 그대로 유지 |
| 8 | KOR/PRK/CHN 확대, 국가 선택, coarse 국가 지도 | 기존 경계·영토 표시가 유지됨. 세부화하지 않은 나라가 fine으로 바뀌었다고 표시하지 않음 |
| 9 | 별도 테스트 게임에서 점령/해방/양도 후 동일 source ID 조회 | 원본 지리 identity·이름·state 분류 유지. 현재 owner/controller만 해당 게임의 상태에서 변함 |
| 10 | 북한 북부 / 휴전선 인근 | 일반 지명 사전에 가짜 State로 등록되지 않음. 정적 이름 검색 0건은 정상이며 공간 의도 처리는 별도 경로에서 판단 |

예시:

```powershell
$english = Read-Geography -Query 'Chongjin City' -Country 'PRK' -Kind 'source-region'
$city.value.items[0].reference.target.id -eq $english.value.items[0].reference.target.id
$taean = Read-Geography -Query '태안군' -Country 'KOR' -Kind 'source-region'
$members = Read-Geography -Operation 'members' -Country 'KOR' `
    -Reference $taean.value.items[0].reference -Limit 1
$members.value | Select-Object totalMatches, truncated, coverage
Read-Geography -Query '태안군' -Country 'KOR' | ConvertTo-Json -Depth 5
```

실제 GPT 수동 플레이에서는 조회 도구의 선택, 동명 후보의 상위 지역 확인, partial 범위의 한계 설명, 원본 국가와 현재 소유국의 구분을 추가로 확인한다. 실행 성공 여부는 권한·전선·영토 효과 한도와 후속 실행 정책도 충족해야 하므로 지명 조회 성공과 별도로 판단한다.

## 현재 한계와 다음 작업

- 부모 미확정 1,436개, source-free 69개, 파생 표시 이름 76개가 남는다. 이름 조회를 연결했다고 공식 부모나 행정 범위가 확정된 것은 아니다.
- 현재 모든 State/SourceRegion의 coverage는 partial 또는 unsupported다. 이들의 legacy 지역 단위 행동 resolve는 GEOGRAPHY_SCOPE_UNSUPPORTED로 제한된다. 명시적인 개별 셀 조회와 지역 전체 실행은 다른 경계다.
- 종전 정산, 조약 양도, REPAIR_FAILED의 전체 해결, 모호한 공간 의도 추론의 완성은 프롬프트 20 범위 밖이다. 앞서 발견했던 게임 진행 오류가 전부 해결되었다고 해석하면 안 된다.
- 검색 모호성 수정은 완료했다. 남은 권고 순서는 실데이터 검사의 고정 집계 제거 → 기존 실패 테스트 정책 정리다. 이후 이름·부모·coverage 근거 보강과 별도 실행 정책 개선을 진행한다.
- 국가별 원본 조사·정규화·이름/계층 자료 준비는 공통 계약으로 병렬 진행할 수 있다. 활성 catalog 및 전체 metadata 선택은 최신 기준선을 재검증하며 순서대로 통합한다.

이번 검증은 전 세계 geometry 재생성·전수 공간 감사나 모든 언어 지명의 사실 검증을 하지 않았다. 사용자 게임을 삭제·초기화하지 않았다. 최초 검증 후 검색 모호성 코드와 지침만 수정했으며 push는 수행하지 않았다. 상세 기계 판독 근거는 `prompt20-review-20261103.json`, 후속 수정 검사는 `prompt20-ambiguity-fix-20261103.json`에 남긴다.
