# 16-03 실제 cell 점령·commit·history·undo/redo

16-02의 새 world·simulation pair와 기존 authoritative territorial planner를
연결했다. 기존 15-21 고정 catalog를 사용하며, geometry·원본 데이터·승인
산출물은 변경하지 않았다.

## 동작

- `createCatalogTurnPlan` → `runtime.commit(plan)`이 선택된 실제 cell만
  변경한다. 점령은 owner를 유지하고 controller만 바꾼다. 해방은 보존된
  owner에게 통제를 돌린다. 양도는 owner를 바꾸며 기존 `preserve` 또는
  `new-owner` controller 정책을 따른다. sourceCountryId와 행정 membership은
  바뀌지 않는다.
- 턴의 모든 effect가 검증된 뒤 world·simulation을 한 번에 commit한다.
  catalog ref, world/simulation revision, 실제 ID, authority 범위와 관계,
  causal event, hash가 잘못되면 부분 반영·history 추가·변경 알림이 없다.
  기존 production DEBUG 제한도 유지한다.
- 개별 effect뿐 아니라 직접 ID 목록과 지역 참조가 섞인 전체 요청에도
  기존 512-cell 제한을 적용한다. 낮은 수준의 command batch도 같은
  aggregate 한도를 검사한다. 초과 목록을 임의로 자르지 않는다.
- 함께 추가된 전선 검증 인터페이스를 사용한다. 새 catalog의 영토 effect는
  `frontierScope`와 host `frontier` resolver를 통해 선택을 확인한 뒤 기존
  command에 실제 cell ID를 전달한다. 이 작업에서 scope 검증을 우회하지 않는다.
- 기존 atomic history가 commit 전후 pair를 보관하고 undo/redo가 상태와
  권한·뉴스·날짜를 복원한다. 복원 revision은 계속 증가한다. 16-02에서
  연결한 snapshot별 catalog 선택도 유지한다.

## 지도 분기에서 사용할 인터페이스

`src/lib/simulation/catalog-runtime.ts`:

```ts
const unsubscribe = runtime.subscribeChanges(change => {
  // change.next: 이번에 함께 공개된 world·simulation pair
  // change.stateChange: OperationalStateChange | null
  // change.changedCountryIds: 국가 entity 또는 cell 소유/통제 변경에 관련된 국가
  // change.requiresFullRefresh: restart 또는 catalog 변경 시 true
});
const latest = runtime.getLastChange();
```

- `kind`는 `commit`, `undo`, `redo`, `restart`, `catalog-transition`,
  `pending-actions`, `player`를 구분한다.
- 같은 catalog에서 `stateChange`는 기존 16-01 타입을 사용한다.
  `{catalogRef, baseWorldRevision, worldRevision, cells}`이며 각 cell은
  `{id, before, after}`다. 점령·해방·양도와 undo/redo 모두 같은 형식이다.
- delta는 provider나 plan의 요약을 믿지 않고 실제 authoritative snapshot을
  비교해 만든다. 변경 목록과 항목은 불변이며 정렬되고, 누락·임의 절단이 없다.
  국가 색상/이름 변경은 `changedCountryIds`와 `change.next.world`를 사용한다.
- catalog가 바뀌거나 새 게임으로 돌아가면 `stateChange`는 null이고
  `requiresFullRefresh`는 true다. 해당 snapshot의 catalog ref로 bootstrap한다.
- 준비한 delta는 pair publication과 함께 공개한다. 실패한 commit은 delta를
  공개하지 않으며, renderer subscriber 예외는 authoritative commit을
  되돌리거나 다른 subscriber 전달을 막지 않는다.

`src/lib/world/operational-state-change.ts`의 `createOperationalStateChange`
함수도 순수 snapshot 비교 함수로 사용할 수 있다. 지도 geometry나 tile을
만들지 않는다. 16-05에서는 전달받은 변경 cell과 관련 edge만 갱신하면 된다.

## 확인

작은 고정 입력으로 부분 점령·후속 변경·해방·양도 두 방식·권한 및 revision
실패·잘못된 tail·hash 변조·aggregate cap·undo/redo의 delta·subscriber 예외를
확인했다. 실제 고정 데이터의 전체 world에서도 `near` 접경 선택을 commit해
선택 cell의 controller만 바뀌고 같은 행정 부모의 나머지는 PRK 통제로 남는
것과 undo/redo delta를 확인했다. 외부 API를 호출하지 않았다.

- `node node_modules/typescript/bin/tsc --noEmit` 통과.
- 변경한 TypeScript 파일의 ESLint와 `git diff --check` 통과.
- 관련 runtime·territorial planner·지역 조회·migration 테스트:
  7개 파일, 54개 테스트 통과.
- 실제 923,443-cell 새 게임 초기화 및 접경 commit·undo/redo:
  1개 파일, 2개 테스트 통과.
- 마지막 국가 변경 알림 보완 후 관련 runtime·migration 20개를
  재실행해 통과했다.

실제 데이터 확인 명령:

```powershell
node --max-old-space-size=8192 node_modules/vitest/vitest.mjs run src/lib/world/operational-game.server.test.ts
```

## 남은 연결

16-05의 점령색·전선 layer는 이 delta 인터페이스를 사용할 수 있다.
실제 화면·턴 controller 합류는 16-08, production build와 대표 요청의
브라우저 확인은 16-09 범위다. 이번 상태 검사를 화면 확인이나 사용자
직접 플레이 완료로 기록하지 않는다.
