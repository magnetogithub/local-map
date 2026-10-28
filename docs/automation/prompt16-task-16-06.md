# 16-06 현재 전선 기반 범위 선택

16-01의 지정 catalog와 전달받은 `OperationalWorldView`를 사용하는 읽기 전용
선택기를 구현했다. 별도 world 전역 상태나 topology 생성은 추가하지 않았다.

## 후속 연결 인터페이스

`src/lib/simulation/operational-frontier.server.ts`:

```ts
const catalog = loadOperationalCatalog();
const lookup = createOperationalFrontierLookup(
  catalog,
  loadCatalogRegionIndex(catalog.ref),
);
const result = lookup(world, {
  catalogRef: catalog.ref,
  baseWorldRevision: world.revision,
  actorCountryId: 'KOR',
  targetCountryId: 'PRK',
  operation: 'occupy',
  extent: 'near',
});
```

`world`는 매 호출 시 host가 전달하는 현재 authoritative view다. 클라이언트가
보내거나 AI가 생성한 상태로 대체하면 안 된다. `selectOperationalFrontier`는
실패 시 예외를 던지고, `createOperationalFrontierLookup`의 콜백은
`{ok: false, code, message}`로 반환한다.

- `extent`: `near`/`limited`/`deeper`. 기존
  `scripts/prompt15-cell-policy.mjs`를 직접 재사용한다. 깊이 36/120/240km,
  폭 36/96/192km, 면적 상한 2,800/22,000/80,000km², 행동당 최대 512 cell.
- `direction`은 현재 접경의 북/남/동/서 쪽에서 시작할 위치를 선택한다.
  행정구역은 필수가 아니다. 필요하면 `regionQuery` 또는 `reference`로
  전체 membership을 읽고 탐색 범위를 제한한다. 양도는 donor인 actor의
  행정구역을, 점령·해방은 target의 행정구역을 조회한다.
- 점령은 현재 target 소유·통제 cell, 해방은 target이 점령 중인 유소유
  cell, 양도는 actor 소유 cell을 후보로 삼는다. 점령·해방은 actor의 현재
  통제 경계에서, 양도는 recipient인 target의 통제 경계에서 시작한다.
  상세 authority와 해방·양도의 최종 관계 검증은 기존 planner가 담당한다.
- source identity와 현재 소유/통제를 구분한다. 이미 같은 원본 국가
  내부에 형성된 현재 전선을 우선하며, 다음 점령은 actor가 통제 중인
  cell을 재선택하지 않는다.
- 실제 양의 길이 공유 edge를 anchor로 사용하고, 그 주변 corridor에서
  육상 인접 graph의 연결된 한 부분을 결정적으로 탐색한다. 바다·점 접촉·
  떨어진 component로 건너가지 않는다. cap 초과는 부분 ID 반환 없이 실패한다.
- 물리 거리는 기존 centroid 기반 구면 거리 근사다. polygon을 자르지 않으므로
  cell 외곽은 centroid 한도보다 벗어날 수 있다. 응답에 근사 설명과 선택 수·
  면적·graph 깊이·전방 깊이·가로 폭·최대 cell 직경을 포함한다.

성공 응답의 `selection`에는 catalog ref, world revision, actor/target,
operation, 정렬된 `cellIds`, 재실행할 수 있는 정규화된 `scope`, 시작 공유 edge,
`effectTarget: {territoryIds, regionRefs: null}`이 들어 있다. 조회는 권한을 부여하지 않는다.

catalog loader에는 `cellMetrics`와 `sharedBoundary`를 추가했다. 기존 catalog의
물리 metadata와 선택한 edge의 geometry만 필요할 때 읽고, cell polygon이나
전 세계 상세 geometry는 읽지 않는다. 물리 metadata 국가 캐시는 최대 네 개다.

## 남은 연결

16-07에서 provider lookup에 이 콜백과 현재 world를 전달하고, 제출 시
`scope`를 현재 상태에서 다시 선택해 catalog/revision/actor/target/operation 및
**정확한 ID 집합**을 대조해야 한다. 제한된 결과를 도 전체 `regionRefs`로
바꾸는 제출 거부와 aggregate cap·authority 검증 연결도 16-07 범위다.
현재 provider와 실제 게임 턴은 아직 이 선택기로 전환하지 않았다.
전체 게임 연결은 16-08, production build와 화면 확인은 16-09에서 수행한다.

## 수행한 확인

- TypeScript `tsc --noEmit` 통과.
- 새 선택기·실제 지정 catalog·기존 catalog/지역/접경 조회: 5개 파일, 18개 테스트 통과.
- 변경한 TypeScript 파일의 ESLint 통과.
- 실제 한국 접경에서 도 내부 부분 선택·연결성·면적/거리 한도 및 후속 전선 진격을 확인했다.
  슬로베니아에서도 동일 선택기와 기존 193개 행정 identity를 사용했다.
- 잘못된 catalog/revision/ID, 모호한 지역, 원격·점 접촉, cell/면적 상한 초과를 확인했다.
  이번 작업에서 production build, 외부 API 호출, 브라우저 점령 확인은 수행하지 않았다.
