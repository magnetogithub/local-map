# 16-02 cell 초기화·기존 상태 이전

Prompt 16의 16-02 범위를 구현했다. 16-01에서 고정한 15-19/15-20/15-21
산출물과 `catalog-v3-56fc6c79c216e6bd1a11`을 사용한다. 이전 게임의
`catalog-v1-73e30c25c9637d6376cb65afa82483c6`에서 새 catalog로의 연결만
지원한다. 원본 데이터·승인 산출물·기존 감사 판정은 변경하지 않는다.

## 초기화와 상태 이전

- `src/lib/world/operational-state-migration.ts`의
  `createOperationalStateMigration(sourceContract, operationalCatalog)`:
  previous-parent index의 전체 대응을 읽고 부모 누락·중복·cell 중복·국가
  provenance·전체 catalog coverage를 확인한다. geometry/topology를 새로
  생성하거나 상세 polygon을 읽지 않는다.
- 반환된 `migrate(pair, 'initial')`은 새 게임을 revision 0으로 초기화한다.
  기본 `migrate(pair)`는 world와 simulation revision을 각각 한 번 올리는
  전환 후보를 만든다. 원본 pair는 변경하지 않는다.
- 모든 cell은 이전 부모의 **현재 owner/controller**를 각각 상속한다.
  sourceCountryId는 provenance로 유지한다. 점령 상태, 소유권 양도,
  owner가 null인 통제 상태도 그대로 이전한다.
- 기존 territorial authority의 모든 부모 ID를 전체 cell membership으로
  확장한다. 저장된 scope는 512개에서 자르지 않는다. 새 권한 발급과
  행동의 기존 512개 제한은 그대로 유지한다.
- 기존 queued action은 자연어와 국가 참조만 가진다. 텍스트를 추측해서
  고치지 않고 날짜·뉴스·사실·상황·후속 일정·history metadata와 함께
  보존한다. 지원하지 않는 구조화 필드나 해석할 수 없는 참조는 실패한다.

## 후속 작업에서 사용할 인터페이스

- `src/lib/world/operational-game.server.ts`의
  `createProductionOperationalGame(playerCountryId?)`는 실제 새 게임의
  `{pair, catalog, descriptor}`를 반환한다. 기존 승인 seed와 고정 catalog를
  연결하고 923,443개 cell의 불변 초기 world를 재사용한다.
- `prepareProductionOperationalTransition(currentPair)`는 기존 runtime에
  전달할 `{expected, next, catalog, initialSeed}`를 준비한다.
  `runtime.transitionCatalog(candidate)`를 호출하면 revision과 두 상태를
  모두 검증한 뒤 한 번의 store 알림으로 전환한다. 준비 중 실패,
  잘못된 참조, stale snapshot/revision은 부분 반영하지 않는다.
- `migration.territoryIds(previousIds)`는 지도·도구가 보관한 이전 territory
  참조를 전체 새 membership으로 바꾼다. 한 부모를 임의의 단일 cell로
  대체하지 않는다.
- `migrateOperationalRegionReference(countryId, ref, sourceIndex, targetIndex)`는
  기존 행정 identity를 조회한 뒤 같은 subdivision identity의 새 ref와
  전체 membership을 반환한다. 이름 추측이나 행동 cap을 적용하지 않는다.
- `runtime.getCatalogForSnapshot(world)`와 `getCatalogRef()`로 복원된
  snapshot에 맞는 catalog를 선택한다. runtime은 이전·새 contract를
  유지하며 기존 history entry/plan/hash와 undo/redo pointer를 삭제하거나
  새로 작성하지 않는다. undo/redo가 이전 버전으로 돌아가면 그 버전의
  world·simulation·catalog ref를 함께 복원한다. `restart()`는 전환된
  초기 seed를 사용한다.

## 확인 결과

- 타입 검사: `node node_modules/typescript/bin/tsc --noEmit` 통과.
- 변경 TypeScript 파일의 ESLint 통과.
- 상태 이전·원자적 실패·authority·기존 runtime·application runtime:
  4개 파일 43개 테스트 통과.
- 실제 고정 데이터의 초기화 테스트 1개 통과: 923,443개 cell,
  KOR/PRK/SVN/CHN의 부모 상태 상속, 국가 색상/이름 보존, catalog 일치,
  상세 geometry 미로딩을 확인했다.
- 추가한 5개 작은 상태 테스트도 최종 수정 후 재실행해 통과했다.
  전환 이전/이후의 history를 넘는 undo/redo와 실패 시 catalog 등록
  rollback을 포함한다.

실제 데이터 테스트 실행 예:

```powershell
node --max-old-space-size=8192 node_modules/vitest/vitest.mjs run src/lib/world/operational-game.server.test.ts src/lib/world/operational-state-migration.test.ts
```

## 남은 연결

현재 화면은 기존 catalog-v1 지도 consumer와 일치하는 기존 bootstrap을
사용한다. 16-04의 v3 asset/protocol consumer와 16-08의 실제 화면 합류에서
위 새 게임 factory와 전환 인터페이스를 사용해야 한다. 구버전 snapshot을
표시할 때도 해당 버전 asset을 유지해야 하며, 이 작업에서 기존 asset을
삭제하거나 덮어쓰지 않았다.

cell 점령 commit은 16-03, 점령색·전선 projection은 16-05, provider 연결은
16-07/16-08 범위다. production build와 로컬 화면의 대표 부분 점령 확인은
16-09에 남아 있다. 외부 API 호출이나 사용자 직접 플레이를 완료했다고
기록하지 않는다.
