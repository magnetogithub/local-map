# Prompt 20 완료 기록 — 20-09

## 재개 후 추가 보완 — 2026-11-03

[최신 재개 기록](prompt20-supplement-resume-20261103.md): residual-only fine 국가의 검증 경계까지 보완했고, 관련 185개 검사가 모두 통과했다. 타입·lint·metadata 독립 검증과 입력 보존을 재확인했다. 아래 184개 및 20-09의 검사 결과는 당시 이력으로 보존한다.

## 최신 보완 상태 — 2026-11-03

[Prompt 20 보완 완료 기록](prompt20-supplement-completion.md): 네 보완 항목 완료, 관련 184개 테스트 전부 통과, 기존 세션 정책 실패 해결. ID별 점령·undo/redo 독립성, metadata 독립 검증, 새 production build와 Edge smoke를 확인했다. 프롬프트 21의 작업 공간 분리로 넘어갈 검증 기준은 준비됐으며 실제 분리는 실행하지 않았다.

아래 20-09의 최초 결과(154개 통과/기존 실패 1개)와 당시 후속 제안은 **보완 전 이력으로 보존**한다. 최신 상태와 남은 데이터 한계는 위 보완 기록을 따른다.

2026-11-03, Asia/Seoul. 20-01~20-08의 기준선·계약·실제 자료·조회 연결을 확인하고 20-09 인계를 완료했다. **최종 테스트 154개 통과 / 1개 기존 실패**이며 전체 테스트가 녹색이라는 뜻은 아니다. 이번 단계는 문서·결과 기록만 변경했고 runtime 코드를 추가 수정하지 않았다.

## 완료 범위와 기준

| 개체 | 현재 수 | 역할 |
| --- | ---: | --- |
| State | 4,201 | 기존 검증된 운영 광역 부모; 새 행정 영토를 생성하지 않음 |
| Province | 8,004 | 소규모 셀 병합 이후 기존 TerritoryId 하나와 정확히 일치 |
| SourceRegion | 7,399 | 같은 원본 feature에 연결된 여러 셀의 이름 묶음; 동명 원본끼리 합치지 않음 |
| 국가 | 247 | fine CHN/KOR/PRK + coarse 244개국, 동일 schema/helper로 검증 |

선택된 [생산 registry](../../data/runtime/geography/current.json)의 전체 참조다. metadata 선택은 operational catalog current와 별개다.

```json
{
  "catalogRef": {
    "catalogVersion": "catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee",
    "geometryRoot": "49e2b4ca3850f15b5158089636b3b95f05ef997f2792b40d4105f068a48cf7d5",
    "manifestPath": "/data/territory-catalog/catalog-v3-prompt19-incremental-CHN-eade6105593ceeb7beee/manifest.json",
    "renderArtifactRoot": "f209abaa4966270bd04e3294c75eace7a256b36e052a2a9e8a1f78376e5a0423",
    "topologyRoot": "b054d23bd63b1c5d17afb06ae0abb5b7332530bcddb9e93d7371f16364df86e2"
  },
  "metadataRef": {
    "contentRoot": "d10c6db6e6c56bc2c2c53ee26fb281a042b31d16592d45960814f90028158fbf",
    "schemaVersion": "geography-metadata-ref-v1"
  }
}
```

기존 catalog-region/operational-region adapter, 지역 API, AI read_geography와 prepared context를 공통 metadata에 연결했다. 저장 gzip의 hash·길이 → 128 MiB 제한 해제 → schema/contentRef → 독립 admission/실제 catalog membership을 검사한다. 틀린 참조는 거부하고 prepared 요청은 한 snapshot/index만 사용한다. 임의 클라이언트 경로와 runtime builder 실행은 받지 않는다.

## 생성·조회·국가별 인계

실제 생성은 20-04에서 아래 첫 명령으로 수행했다. 20-09에서는 기존 불변 출력을 보존하고 재생성하지 않았다. 두 번째 명령은 선택된 출력의 offline 재검증 방법이며 geometry 생성이나 활성 pointer 변경을 하지 않는다.

```powershell
node --max-old-space-size=8192 scripts/geography/build-current-metadata.cjs
$geography = Get-Content data/runtime/geography/current.json -Raw | ConvertFrom-Json
node --max-old-space-size=8192 scripts/geography/build-current-metadata.cjs --verify $geography.manifest.path
```

서버에서는 loadProductionGeography({catalogRef,metadataRef:null})로 선택된 snapshot을 읽거나 정확한 metadataRef를 지정한다. HTTP는 POST /api/world/regions의 {mode:'geography',catalogRef,metadataRef,request}로 search/list/inspect/members를 요청한다. nullable 필드도 필수이며 전체 예제와 반환 품질 정보는 [생산 연결 문서](../../docs/geography/production-geography-integration-v1.md)를 따른다. 현재 operational catalog의 기존 region 요청도 동일한 canonical state adapter를 사용한다.

국가 자료 작업자는 [국가별 준비 계약](../../docs/geography/country-metadata-handoff-v1.md)에 따라 기존 sourceCountryId, 고정 원본/이름 근거, 기존 parentKey 또는 null, 모든 현재 셀 연결과 coverage를 제출한다. validateCountryMetadataInput은 전체 catalog의 독립 evidence로 국가 준비 입력을 검증한다. 준비 입력의 ref를 전체 생산 ref로 사용하지 않는다. 현재 247개 국가 입력을 모두 통과시켰지만 새 국가 추가·발행 CLI의 완성을 뜻하지 않는다.

## 검사와 보존

| 검사 | 20-09 결과 |
| --- | --- |
| 계약·생성기·별칭·국가 helper·실제 loader/API/scripted provider 및 기존 region/게임 경계 | 15개 파일, 154/155개 통과; 지리/producer 103개 전부 통과 |
| 타입 | root tsc --noEmit --incremental false 및 scripts/geography/tsconfig.json 모두 통과 |
| Lint | 변경된 TS/TSX 파일, 새 지리 모듈·공통 fixture·route handler·생성기/검증기 전부 통과 |
| Production build | 20-08의 .next-prompt20-08-build / webpack 성공 결과 재사용; 코드·입력 동일성 및 3개 route의 metadata tracing 확인 |
| 앱/HTTP smoke | 20-08의 별도 생산 서버·Edge 성공 결과 재사용; 부팅·KOR 선택·기존 지도·생산 API·prepared ref 확인, 증거/스크린샷 pin 일치 |
| 보존 | 기준 입력 298개 hash/크기 재확인, 코드/생산 산출물 45개와 빌드 입력·파일 12개 동일; whitespace 검사 통과 |

실제 청진/Chongjin City는 원본 1개·알려진 셀 1개, 내몽골/Inner Mongolia는 state 1개·알려진 셀 48개로 조회된다. 중구의 6개 동명 후보, 태안군의 원본 하나/셀 3개, 공백·NFKC·대소문자, 잘못된 ref/sourceCountryId, 부분 coverage, alias cache 분리와 prepared 중 버전 전환을 확인했다. 점령/소유·통제 변경 이후에도 원본 identity와 이름은 유지된다.

기존 catalogRef·영토 ID·geometry/topology·운영 부모·seed lineage를 변경하지 않았다. alias 이전/현재 metadata의 identity·membership·coverage도 동일하다. 상태 변경 검사는 별도 immutable World/격리된 runtime에서 수행했고 실제 사용자 게임과 실행 중 dev 서버는 사용·초기화하지 않았다. 소유/통제·revision·history를 정적 metadata에 넣지 않는다. 영토 효과 합계 512개 제한, 권한·현재 전선·원자적 commit·undo/redo는 유지한다. 외부 AI 호출은 **0회**다.

기존 실패 1개: [operational-game-version.test.ts](../../src/lib/simulation/server/operational-game-version.test.ts)의 “invalidates sessions retained across a catalog change and rejects their IDs”가 UNSUPPORTED_LEGACY_GAME_POOL_PRESENT로 실패했다. 이전/legacy 세션을 삭제해야 한다는 테스트 전제가 현재 보존·checkpoint 정책과 충돌한다. [20-06 기록](prompt20-06-consumers.json)에도 같은 실패가 있고 테스트 bytes도 그대로다. 현재 allocation·pool preservation·checkpoint 테스트는 통과했다. 이 범위 밖 테스트를 삭제·완화하거나 사용자 게임 삭제 동작으로 바꾸지 않았다. 별도 후속에서 테스트 계약을 현재 보존 정책과 조정해야 한다.

## 남은 데이터와 후속 범위

- 미확정 부모 1,436개는 null/unassigned다. 파생 표시 이름 76개 중 source-free는 69개이며 공식 지명을 만들지 않는다.
- 실제 fine state/원본 coverage는 partial, coarse는 unsupported다. 독립 complete witness가 없고 expectedProvinceCount는 null이다. 알려진 membership 전체 열거와 공식 지리 범위의 완전성을 구별한다. 이 불완전 범위의 legacy 행동 materialization은 unsupported로 남긴다.
- 청진·내몽골 별칭은 표기를 연결한다. 2020 공식 범위, 미확정 부모, CHN의 현재 셀이 없는 원본 feature 14개를 해결한 것으로 주장하지 않는다.
- ‘북한 북부’, ‘휴전선 인근’, 현재 전선은 별도 공간 해석/실행 정책의 후속 대상이다. 새 국가 원본 채택·미세 경계 생성·범용 발행 도구, 새 검색 UI나 모든 셀 라벨은 구현하지 않았다.
- 다음 국가 작업은 [국가 지정형 개발 지침](../../prompts/COUNTRY_MICRO_BOUNDARY_GUIDE.txt)의 원본·계층·시점·라이선스 조사와 위 준비 계약부터 시작한다. 이번 종료 이후 자동으로 시작하지 않는다.

검사 명령·파일별 결과·재사용 근거는 [20-09 기계 판독 기록](prompt20-09-handoff.json), 실제 자료 합류 근거는 [20-08 기록](prompt20-08-integration.json), schema/근거 의미는 [공통 계약](../../docs/geography/state-province-contract-v1.md), 생성 입력은 [producer 문서](../../docs/geography/current-metadata-builder-v1.md)를 참조한다. 전체 저장소 테스트, geometry 재생성/전수 공간 감사와 성능 benchmark는 실행하지 않았다.
