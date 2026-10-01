# GPT turn runtime v1 ADR

Status: accepted for Prompt 12 contract stages 12-1–12-10.

## Decision

Pax Local의 대체역사 진행은 action submission과 time advance를 분리한다. action은 현재 플레이어 국가가 시도할 자연어 의도를 대기열에 저장할 뿐 결과나 날짜를 바꾸지 않는다. time advance가 frozen action set과 simulation/world revision pair를 하나의 판정 요청으로 만든다.

모델의 streaming draft는 임시 표시일 뿐 authoritative state가 아니다. 모델이 제출하는 유일한 effect-bearing 값은 strict `TurnResolutionV1`이다. resolution은 날짜가 있는 사건, 행동 결과, narrative state mutation, semantic world effect를 포함하지만 command ID, expected revision, 신규 최종 CountryId, geometry, planner patch를 포함하지 않는다.

world effect는 이미 일어난 원인 사건을 반드시 참조한다. host만 effect를 기존 typed MapCommand v2 batch로 compile하고 기존 planner에서 전체 dry-run한다. action submission은 불확실한 결과를 판정받는 데 동의하는 행위이므로 valid resolution에 대한 별도 결과별 승인 UI는 두지 않는다. 성공, 부분 성공, 실패, 지연은 모두 정상 판정이다.

turn plan은 simulation next state, world next state, history metadata를 함께 가진다. commit은 두 state와 turn history를 하나의 원자 경계로 게시한다. 어느 검증·compile·dry-run·publish 단계라도 실패하면 날짜, queue, event, narrative state, world state를 모두 보존한다. commit 전 Stop도 동일하게 변경 0건이다.

## Trust boundary

- player text, country names, facts, events, model output은 모두 untrusted data다.
- server/host가 player actor, action ID, revision pair, command ID, 신규 CountryId를 발급한다.
- GPT는 세계 상태를 수정하지 않고 semantic resolution만 제안한다.
- strict schema validation 뒤에도 host가 reference, causality, date/order, current revisions를 다시 검증한다.
- gameplay는 직접 지도 명령, command JSON, effect별 승인·거절 UI를 제공하지 않는다.
- provider credential, raw geometry, undo image, private reasoning은 모델 또는 client boundary를 넘지 않는다.

## Existing runtime reuse

`WorldStateStoreController`가 현재 세계의 소유자다. 기존 Prompt 10 planner와 `commitVerifiedWorldPatch`를 compile/dry-run/commit의 world half로 재사용한다. `command-ui-runtime.ts`는 개발 inspector이며 gameplay 진입점이 아니다. 현재 없는 simulation/world atomic coordinator는 Prompt 12의 후속 단계에서 추가한다.

## External design evidence

Pax Historia의 공개 [Workflow Quickstart](https://www.paxhistoria.co/docs/workflows), [Bundle Quickstart](https://www.paxhistoria.co/docs/bundles), [Jump Forward Agent Memory](https://www.paxhistoria.co/docs/workflows/compression)에서 typed workflow command는 runtime validation을 거치고, tool call 자체는 effect가 아니며 host workflow가 의미를 부여하고, provider credential과 persistence는 trusted host가 소유한다. 이 프로젝트는 공개 원칙만 참고하며 비공개 prompt나 구현을 복제하지 않는다.

공식 [OpenAI Structured Outputs 문서](https://developers.openai.com/api/docs/guides/structured-outputs)는 tool/function과 애플리케이션 기능을 연결할 때 function calling을 사용하고, strict schema의 object는 `additionalProperties: false`를 사용하도록 안내한다. 이 ADR은 root object인 단일 `submit_turn_resolution` 인수 schema를 고정하고 host semantic validation을 별도로 유지한다.

## Consequences

일반 외교·경제·국내 사건은 빈 `worldEffects`로 commit할 수 있다. 합병·분할·양도는 사건이 실제로 성립한 turn에만 compile된다. 모델이 직접 지도를 편집하거나 action 문장을 command로 1:1 번역하는 경로는 없다. undo/redo의 사용자 단위는 내부 command가 아니라 committed turn 전체다.

