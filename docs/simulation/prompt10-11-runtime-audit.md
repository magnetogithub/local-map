# Prompt 10·11 runtime audit

Prompt 12의 시뮬레이션 계약이 기존 세계 runtime을 재사용하기 위한 감사 결과다. `production`은 현재 gameplay import graph에서 사용되는 경로이고, `development`는 command inspector/demo 전용 경로다.

| 책임 | 현재 소유자 / 진입점 | 구분 | Prompt 12 결정 |
| --- | --- | --- | --- |
| authoritative world state | `WorldStateStoreController` in `src/stores/world-state-store.ts` | production | 그대로 재사용한다. AI 전용 world store를 만들지 않는다. |
| player country | `useGameSetupStore().playerCountryId` | production | action actor는 이 값에서 host가 주입한다. 모델 입력을 신뢰하지 않는다. |
| command parsing / planning | `planRuntimeCommand` and Prompt 10 planners | production-capable pure domain | semantic effect compiler의 유일한 planner target으로 재사용한다. |
| command JSON inspector | `parseRuntimeCommand`, `dryRunWorldCommand`, `applyWorldCommand` in `command-ui-runtime.ts` | development/demo | gameplay 자연어 입력 경로로 노출하지 않는다. 내부 compiler는 JSON 문자열 UI를 우회해 typed command를 planner에 전달한다. |
| verified world commit | `commitVerifiedWorldPatch` | production | 완성된 turn plan의 world half를 게시할 때 재사용한다. 단독으로 turn을 commit하지 않는다. |
| world history | `recordHistoryEntry`, `undoHistory`, `redoHistory` | production-capable pure domain | turn history가 내부 world patch를 포함하도록 감싼다. command 단위 undo를 gameplay에 노출하지 않는다. |
| world persistence | `serializeWorldStateV2` / `deserializeWorldStateV2`; game setup storage는 player country만 저장 | production | Prompt 12 후속 단계에서 simulation + turn history persistence를 별도로 추가해야 한다. |
| projections | `GameSetupShell`이 committed `WorldStateV2` identity/revision을 구독해 map, label, search, panel projection을 재생성 | production | atomic turn publish 뒤의 단일 world revision만 보게 한다. |
| atomic turn coordination | 없음. 현재 원자성은 world patch 하나에 한정 | missing | simulation state, world state, history를 함께 publish하고 rollback하는 coordinator가 필요하다. |

재사용 경계는 `semantic WorldEffect -> host compiler -> typed MapCommand v2 batch -> existing planner dry-run -> atomic turn coordinator`다. 모델이나 gameplay UI가 `MapCommand`를 직접 만들거나 실행하는 새 executor는 허용하지 않는다.

