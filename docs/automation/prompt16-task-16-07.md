# 16-07 provider 조회·제출·범위 검증 연결

16-06의 현재 전선 선택기를 기존 Responses provider의 조회→제출→repair 경로와
host validator/planner에 연결했다. 기존 호출·응답·repair 예산과 외부 API Retry
처리는 유지한다. 새 token, 전역 world 저장소, 데이터 재생성은 추가하지 않았다.

## 조회와 제출

- provider는 `context.regionCatalog`로 지역 index를 읽는다. 구형 catalog 고정을
  제거하고 지정된 operational catalog를 선택할 수 있게 했다.
- operational catalog에는 `find_frontier_territories`를 노출한다. actor/target,
  operation, `near`/`limited`/`deeper`, 선택적 방향·행정 참조/이름과 cap을 받는다.
  catalog ref와 world revision은 host가 붙인다. 기존 source-country 기반
  `find_border_territories`는 이 catalog에서 우회 경로로 사용할 수 없다.
- 응답의 `effectTarget`은 정확히 선택된 `territoryIds`, `regionRefs: null`,
  `frontierScope`를 포함한다. 모델은 이 세 필드를 그대로 제출한다.
- 공통 `operational-frontier-contract.ts`의 schema를 조회·effect·검증에서
  재사용한다. strict function schema에는 nullable 필드를 required로 포함하고
  host 기본값은 JSON Schema에서 제거한다. 좌표나 geometry 입력은 받지 않는다.
- provider 호출마다 성공한 조회 scope를 host 메모리에 보관한다. 제출 scope는
  그 호출에서 실제 반환된 scope와 같아야 한다. 별도 token은 발행하지 않는다.

## host 검증

`validateOperationalFrontierEffects`는 region membership 확장과 상태 변경 전에
실행한다. `validateResolutionAgainstContext`와 `createCatalogTurnPlan` 모두 사용한다.

- catalog ref 전체, world revision, actor/target, operation과 정확한 정렬 ID 집합을
  현재 world에서 다시 선택해 대조한다. provider는 실제 조회 여부도 확인한다.
- operational occupy/liberate/transfer에는 `frontierScope`가 필수다. scope 생략,
  ID 일부만 제출, 추가 ID, 다른 actor/operation, stale revision, 다른 catalog,
  도 전체 `regionRefs` 대체를 거부한다. 행정구역 조회는 계속 사용할 수 있다.
- 여러 영토 effect의 변경 수 합계는 512를 넘을 수 없다. 범위 초과를 여러
  effect로 나누거나 결과를 임의 절단해 성공시키지 않는다.
- authority와 owner/controller 관계는 기존 validator·territorial planner가
  계속 검사한다. DEBUG에서도 범위 검증은 생략하지 않으며 production의 DEBUG
  제한을 유지한다. 실패 시 world/simulation/history를 부분 반영하지 않는다.
- 이전 catalog의 기존 regionRefs 경로는 유지한다. 새 scope 필드를 구형
  catalog 효과에 사용하지 않을 때는 `null`로 제출한다.

## 16-08에서 실제 게임에 연결할 인터페이스

provider의 내부 `SimulationProviderRequest.operationalWorld`에 현재
`OperationalWorldView`를 전달한다. 이 값은 모델 context로 직렬화하지 않는다.

HTTP 경로는 `createSimulationTurnPost`의 **서버 의존성**
`resolveOperationalWorld(request)`로 현재 world를 읽는다. 요청 JSON은 여전히
`{turnId, context}`뿐이며, JSON의 `operationalWorld` 같은 추가 필드는 거부한다.
서버 world가 없거나 catalog/revision이 맞지 않으면 provider 호출 전에 실패한다.

planner에는 같은 현재 world와 재선택 함수를 전달한다.

```ts
const catalog = loadOperationalCatalog();
const regionIndex = loadCatalogRegionIndex(world.catalogRef);
const plan = createCatalogTurnPlan({
  turnId, simulation, world, resolution,
  catalog: catalog.worldContract(),
  regionIndex,
  frontier: {
    world,
    resolve: (current, scope) =>
      selectOperationalFrontier(catalog, current, scope, regionIndex),
  },
});
runtime.commit(plan);
```

`frontier.world`는 planner가 사용하는 현재 world와 같은 snapshot이어야 한다.
provider 결과를 받은 뒤 상태가 바뀌면 이전 revision의 scope를 재사용하지 않는다.
planner는 이 검증용 필드를 command payload에서 제거한 뒤 기존 cell planner에
넘긴다. undo/redo는 기존 authoritative snapshot과 history를 복원한다.

기본 실제 게임 UI와 서버의 world 전달은 아직 전환하지 않았다. operational
요청을 실제 HTTP route에서 실행하려면 16-08에서 현재 게임 상태를 읽는 위
서버 의존성과 commit 경로를 연결해야 한다. 새 게임 UI·지도 통합은 16-08,
production build와 브라우저 플레이 확인은 16-09 범위다.

## 수행한 확인

- `tsc --noEmit` 및 변경 TypeScript 파일의 ESLint 통과.
- 관련 8개 테스트 파일의 78개 테스트 통과(여러 묶음으로 실행).
  기존 provider·Retry·호출 예산, 공통 계약, 실제 catalog 선택, 기존 지역 조회,
  점령 lifecycle과 operational runtime을 포함한다.
- 새 provider 테스트 10개에서 scripted 조회→제출→원자적 commit→undo/redo,
  잘못된 범위 제출 후 기존 예산 내 repair, scope/ID/revision/actor/operation
  음성 검사, aggregate cap, authority·production DEBUG 제한, 해방·양도,
  서버 world 주입과 strict schema를 확인했다.
- 외부 API 호출, production build, 브라우저 플레이 확인은 수행하지 않았다.
