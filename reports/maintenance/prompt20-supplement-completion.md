# Prompt 20 보완 완료 기록

2026-11-03, Asia/Seoul. 요청한 네 항목을 완료했다. **관련 184개 테스트 전부 통과, 실패 0개**다. 새 국가나 프롬프트 21은 시작하지 않았다. 이전 단계·최초 검토·모호성 수정의 기록은 그대로 보존한다.

## 항목별 결과

| 보완 | 실제 변경과 검증 | 상태 |
| --- | --- | --- |
| 실데이터 고정값 제거 | 활성 descriptor/행정 부모, provenance/source-lock/raw/계층 crosswalk에서 기대 ID·분류·원본 membership을 재구성. production 통합 검사와 smoke의 영토·국가 집계 및 기록을 동적으로 변경 | 완료 |
| ID 독립성 | 이름이 같은 두 State, 같은 State·같은 이름의 두 Province, 명시적 종류/ID 조회, 한 셀만 점령·undo·redo, 표시/별칭 갱신 후 ID·geometry·state/history 불변 확인 | 완료 |
| 세션 정책 실패 정리 | 기존 2개 검사를 삭제 전제에서 보존 계약의 9개 사례로 개정. 같은 catalog 재사용, 이전 풀 checkpoint/격리, busy/실패/원본 pointer 누락, legacy 거부와 원본 유지 확인 | 완료 |
| 최종 확인·기록 | 두 TypeScript 검사, lint, 전체 관련 묶음, metadata 독립 검증, 새 분리 production build 및 Edge/HTTP smoke, 보존 pin과 whitespace 확인 | 완료 |

## 기준선과 동적 검증

아래 수치는 **이번 실행의 관측 결과**이며 후속 국가의 합격 상수가 아니다. 현재 검사의 기대값은 metadata 자신의 집계를 다시 세는 것으로 만들지 않는다.

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

관측: 국가 247, Province 8004, State 4201, SourceRegion 7399. provenance와 채택 source 근거의 fine 국가: CHN, KOR, PRK; 나머지 coarse 244개국. fine/coarse 국가 집합이 바뀌는 작은 가상 입력도 검사했으며 실제 나라를 새로 세부화하지 않았다.

- Province는 현재 catalog의 TerritoryId 전집합·국가 분류·행정 ordinal과 대조한다. 모든 ID를 paginated kind:province 목록과 inspect로 다시 읽는다.
- State는 현재 administrative 부모의 parentKey 전집합과 raw macro crosswalk를 대조한다.
- SourceRegion은 현재 셀 feature의 native source identity 및 pinned raw/normalized·coarse 원본으로 기대 그룹과 전체 셀 membership을 재구성한다. 독립 verifier도 source/parent/group 연결을 확인한다.
- 기존 누락·중복·국가 오류·잘못된 부모·거짓 complete 음성 검사는 유지한다. 검증기 보조 입력의 누락·중복·분류 오류도 거부한다.
- 20-03/20-04의 이름 갱신 전후 비교와 소규모 병합 ID 사례는 명시적인 두 불변 manifest pin을 사용하는 prompt20-name-release.snapshot.test.ts로 분리했다. 활성 registry를 과거 snapshot으로 간주하지 않는다.

## ID별 독립 실행 근거

stateId는 State identity, provinceId는 기존 TerritoryId 그대로다. 새 sid/pid나 State 소유권 도메인을 만들지 않았다. 작은 fixture의 서로 다른 Province 두 개는 같은 표시 이름과 같은 stateId를 갖지만 별개로 inspect·목록·kind:province 검색이 가능하다. 원본 묶음은 연결된 ID 전체를 반환한다. 서로 다른 native source를 가진 동명 State/SourceRegion은 후보로 남는다.

state-province-identity.test.ts는 가상의 land graph와 기존 실제 selectOperationalFrontier → 권한/전선·revision·512 상한 검사 → createCatalogTurnPlan → runtime.commit/undo/redo를 사용한다. BBB가 AAA의 첫 Province만 점령하면 해당 controller만 BBB로 바뀌고, 같은 State의 둘째 Province 및 나머지 객체는 그대로다. undo/redo delta도 그 첫 ID 하나뿐이다. sourceCountryId·이름·State 연결과 geometry ref는 유지한다. 다른 ID 대체·없는 권한·오래된 revision·상한 증가를 거부한다. 원시 world 객체 수정이나 debug 권한 우회로 성공을 만들지 않았다.

이후 State 표시명과 Province 별칭을 바꾸면 fixture metadataRef만 갱신되고 State/TerritoryId·catalogRef·runtime pair/history는 유지된다. 실제 자료에서도 고정된 이름 전후 release의 identity·membership·coverage와 현재 전체 ID 집합을 대조했다. 기존 모호성 수정의 runtime index·모델 지침·도구 코드는 변경하지 않았다.

## 세션 정책과 발견한 구현 누락

기존 실패는 예전 세션 삭제 전제를 현재 checkpoint/보존 계약으로 바꿔 해결했다. 지원되는 이전 풀은 원래 catalog pointer로 checkpoint한 뒤 버전별로 보관하며 새 catalog 세션으로 조회하면 GAME_CATALOG_PRESERVED로 거부한다. checkpoint 실패·busy·원본 pointer 누락에서는 전환하지 않고 원래 session 참조/lock을 유지한다. 모든 테스트 전역 값과 모듈 캐시는 원래 상태로 복원한다. 실제 checkpoint 파일 왕복과 allocation/pool-preservation 검사도 유지했다.

추가한 두 음성 사례에서 **이전 pool pointer 없이 legacy 게임만 남아 있으면 새 pool을 만들던 누락**을 재현했다. assertSupportedGamePools를 pool 생성 전과 checkpoint 경계에서 호출하는 최소 변경으로 고쳤다. V19/unversioned legacy 입력은 UNSUPPORTED_LEGACY_GAME_POOL_PRESENT로 명시적으로 거부하고 원본 Map과 기존 참조를 유지한다. 테스트 skip·무조건 성공이나 사용자 게임 삭제로 해결하지 않았다. 초기 실패 재현과 수정 후 통과를 새 보완 기록에 구분했다.

## 실행 검사

| 검사 | 결과 |
| --- | --- |
| 관련 테스트 | 20개 파일, 184/184 통과; 기존 실패 테스트도 포함 |
| TypeScript | root tsc --noEmit --incremental false 및 scripts/geography/tsconfig.json 통과; 빌드 임시 include 제거 후 재확인 |
| Lint | 변경 파일과 기존 관련 지리/producer/fixture/API 연결 파일 통과 |
| 현재 metadata 독립 검증 | build-current-metadata.cjs --verify 통과: raw/source/parent/group, exact catalog set, contentRef, 보수적 coverage |
| 새 production build | .next-prompt20-supplement-build, webpack 성공. runtime 가드가 바뀌어 과거 빌드를 재사용하지 않음 |
| 새 HTTP/Edge smoke | 별도 새 서버·session에서 동적 descriptor 기대값, 이름·동명 후보·부분 coverage·prepared ref·revision/history·부팅/KOR 선택/지도 확인; 브라우저 오류 0 |
| 입력 보존 | 기존 298개 입력과 선택된 metadata artifact 3개 hash/길이 일치. registry·전체 refs·ordinal/부모/seed lineage 불변 |
| Whitespace | git diff --check 통과 |

외부 AI 호출은 0회다. 실행 중 dev 서버·사용자 게임은 사용하거나 초기화하지 않았다. 원본 다운로드, 전체 geometry/topology 재생성·전수 공간 감사·push/배포도 하지 않았다. 테스트 명령과 파일별 결과, artifact pin은 [기계 판독 기록](prompt20-supplement-completion.json)에 남긴다.

## 남은 문제와 다음 단계

이번 보완 범위의 미완료 작업과 관련 검사 실패는 없다. 데이터 한계는 그대로다: 부모 null/unassigned 1436개, source-free 69개, fine partial/coarse unsupported coverage 및 독립 complete witness 부재. 알려진 셀 전체 조회는 공식 지리 범위 완전성이나 실행 권한을 뜻하지 않는다. 공간 표현 해석, 부모/이름/범위 근거 보강과 새 국가 채택은 별도 후속이다.

프롬프트 21의 **작업 공간 분리로 넘어갈 검증 기준은 준비됐다.** 현재 구현과 자료가 미커밋 상태이므로 실제 분리 시 이 산출물을 포함한 기준선을 보존·전달해야 한다. 이번에는 프롬프트 21 작성/실행, 새 worktree, commit, 다음 국가 작업을 시작하지 않았다. [공통 계약](../../docs/geography/state-province-contract-v1.md), [실제 조회](../../docs/geography/production-geography-integration-v1.md), [국가별 인계](../../docs/geography/country-metadata-handoff-v1.md)를 그대로 사용한다.
