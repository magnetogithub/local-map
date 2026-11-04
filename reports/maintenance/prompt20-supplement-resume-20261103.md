# Prompt 20 보완 재개 — residual-only fine 국가의 검증 기준

2026-11-03, Asia/Seoul. 진행 보고 요청 이후 이어서 현재 완료 조건을 다시 대조했고, 보완 1의 경계 사례를 추가로 수정했다. 관련 **185/185개 테스트 전부 통과**다. 앞선 [보완 완료 기록](prompt20-supplement-completion.md)의 184개 검사와 원래 증거는 수정하지 않았다.

## 추가로 확인하고 고친 부분

채택된 fine 국가라도 현재 게임 셀이 전부 residual일 수 있다. 기존 활성 통합 검사는 precision:fine인 셀이 있는 국가만 모아 독립 fineProfiles 집합과 대조했으므로, 이런 입력은 유효한 provenance와 맞아도 검사에서 빠졌다. 작은 가상 BBB 입력으로 이 실패를 재현했다. 실제 국가를 생성하거나 활성화하지 않았다.

관측용 국가 분류를 observedGeographyCountryPartition으로 분리해 production 통합 검사와 회귀 검사가 같은 비교 코드를 사용하게 했다. fine 및 residual Province는 fine 국가에 속하고, coarse Province는 coarse 국가에 속한다. 기대 국가 집합은 계속 독립 provenance·source-lock·raw/계층 profile에서 가져온다. 개별 셀의 정확한 precision·ID·부모·source membership 대조는 그대로 유지한다.

새 회귀 검사는 fine 국가의 모든 현재 셀이 residual/source-free/null 부모여도 fine 집합에 남는 것을 확인한다. 이 셀들을 coarse로 잘못 분류하면 fine/coarse 집합 비교가 모두 다르게 나오는 것도 확인한다. 따라서 고정값 제거를 단순 로드 성공이나 자기 집계 확인으로 약화하지 않았다.

## 검사 결과

- 최초 회귀 재현: 3개 중 1개 실패. residual-only fine 국가가 빈 fine 집합으로 관측되는 문제를 확인했다.
- 수정 후 관련 전체 범위: 20개 파일, 185/185개 통과. 기존 세션 정책·allocation·checkpoint·pool preservation 및 ID별 점령/undo/redo 검사를 모두 포함했다.
- root와 scripts/geography TypeScript 검사, 변경 파일 lint, git diff --check 통과. 첫 타입 검사에서 발견한 fixture ID Set의 브랜드 타입을 명시한 뒤 두 타입 검사를 다시 통과시켰다.
- 현재 metadata 독립 CLI 검증을 다시 수행했다. catalog Province 집합, 국가 분류, raw/source/parent/group 연결, contentRef와 보수적 coverage 검사 모두 통과했다.
- 생산 코드·입력이 바뀌지 않아 직전 .next-prompt20-supplement-build와 별도 Edge/HTTP smoke의 성공 결과를 재사용했다. 빌드·trace·smoke 증거 8개 pin과 생산 소스 동일성을 대조했다. 새 서버나 사용자 게임을 사용하지 않았다.

재개 시점의 실제 관측은 국가 247, Province 8004, State 4201, SourceRegion 7399다. 이 숫자는 합격 상수가 아니다. catalog/metadata의 전체 참조는 다음과 같다.

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

## 보존·남은 범위

재개 후 변경은 검증 코드 세 파일뿐이다. 기존 geometry/topology·TerritoryId·ordinal·운영 부모·seed lineage, 실제 게임 상태, canonical 이름 후보 정리와 모든 정적 metadata를 바꾸지 않았다. 고정 입력 298개와 선택된 metadata artifact 3개의 hash/길이가 일치한다. 기존 보완 MD/JSON, 최초 검토 및 모호성 수정의 기록은 보존하고, prompt20-completion.md에는 이번 최신 결과 링크만 앞에 추가했다.

원래 네 보완 항목과 이번 경계 사례 확인을 마쳤다. 미확정 부모·이름·부분 coverage의 데이터 한계는 기존 기록과 같다. 프롬프트 21 작업 공간 분리의 검증 기준은 준비됐으나, 실제 분리·새 국가 채택은 시작하지 않았다. 현재 미커밋 산출물을 포함한 기준선을 보존해 다음 단계에 전달해야 한다. 명령·파일별 결과·동일성 근거는 [기계 판독 기록](prompt20-supplement-resume-20261103.json)에 정리했다.
