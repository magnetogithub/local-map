# Internal game interface v1 ADR

Status: accepted for implementation

## Context and decision

The `/game` route becomes a map-first, turn-based interface. The existing canonical world
store and atomic turn runtime remain authoritative. HUD and management windows receive
projections through `src/lib/game-ui/contracts.ts`; unavailable domains render honest empty
states instead of inferred or country-coded values.

Only one management overlay is open at a time. A major-event acknowledgement modal is a
separate blocking layer above it. Overlay state is ephemeral browser UI state and is not
added to route history.

## Decision table

The source prompt numbers 18 items under “사용자가 확정한 결정”. To make the requested
20-row acceptance table explicit, D19 and D20 capture the two governing decisions stated
in the prompt objective and absolute principles.

| ID | User decision | Interface consequence | Verification |
| --- | --- | --- | --- |
| D01 | Map occupies the whole game screen. | Map is the viewport background; chrome overlays it. | 1280 and 1920 screenshots. |
| D02 | Management screens open as windows over the map. | Edge menu opens a fixed overlay; map remains mounted. | Overlay integration test. |
| D03 | At most one overlay is open. | Discriminated `GameOverlay` union, not independent booleans. | Reducer test. |
| D04 | Player country appears top-left. | Persistent badge opens Politics. | Accessible-name/component test. |
| D05 | Date appears top-right. | Date/turn/phase cluster reads simulation projection. | HUD test. |
| D06 | Population belongs in the top HUD. | Nullable population slot displays `—` when unavailable. | Null fixture. |
| D07 | Economy has a menu and overlay. | HUD shortcut and Economy overlay share one projection. | Navigation test. |
| D08 | Regime and leader belong in Politics. | Both are nullable typed fields; no invented portrait. | Null fixture. |
| D09 | Do not show exact aggregate military strength. | War contract contains no troop/strength/rank fields. | Contract test/review. |
| D10 | Foreign selection shows each directional opinion in -100..100. | Labels and fields preserve player->foreign and foreign->player direction; each score is nullable and range-checked. | Boundary/direction tests. |
| D11 | Active wars are listed in War. | Nullable-data war list with map-layer action. | Empty and multi-war fixtures. |
| D12 | Country actions use their own menu. | Composer, queue, and time advance use the shared turn controller. | Prompt 12 regression tests. |
| D13 | Recent international events use a news format. | Stable dated feed, filters, details, and related-country navigation. | News projection tests. |
| D14 | Every major/transformative event pauses progress for acknowledgement. | FIFO acknowledgement queue and blocking modal; minor/notable never block. | Severity queue tests. |
| D15 | Diplomacy overlay reserves an API-backed foreign channel. | Nullable `DiplomacyChannelPort`; disconnected send is disabled and produces no fake reply. | Disconnected-port test. |
| D16 | Save is button/status only in this stage. | Clicking announces future server support; no browser persistence/download. | UI test and source guard. |
| D17 | Include war/front map layer controls. | Settings/War expose typed visibility choices; absent war data leaves the slot empty. | Empty-state test. |
| D18 | Real calculations and server saves are later work. | All unavailable values remain null/empty with a reason. | Contract fixtures. |
| D19 | Preserve existing country actions, GPT turns, commits, Stop/Retry, undo/redo. | One extracted controller wraps the existing `ApplicationTurnRuntime`; no alternate mutation path. | Prompt 12 regression suite. |
| D20 | Preserve canonical owners and never manufacture missing domain data. | UI contracts are read models only; `WorldStateV2`/`SimulationStateV1` stay authoritative. | Runtime audit and null fixtures. |

## Interaction model

- Edge-menu activation toggles the selected overlay; activating another replaces it.
- Escape closes the overlay unless the acknowledgement modal is active.
- Map selection opens own-country information for the player, foreign-country information
  for another active country, and closes/retargets safely if a commit retires the target.
- Overlay focus enters its heading/close control and returns to the invoking menu or map
  feature on close. The major modal traps focus and restores it after acknowledgement.
- Turn advance is unavailable while streaming or while acknowledgement items remain.
- Stop cancels only the in-flight request. Failure retains the last committed snapshot;
  Retry rebuilds from that snapshot rather than a partial draft.

## Empty-data policy

Numbers and strings not present in an authoritative source are `null`; collections are
empty and accompanied by `dataAvailable: false` or `unavailableReason`. The visual value is
`—` and the supporting copy is “데이터 연결 예정” (or a domain-specific equivalent).
Unknown relationship scores are never coerced to zero. No random, country-code lookup,
test fixture, generated portrait, or generic action endpoint may masquerade as production
domain data.

The diplomacy channel port is `null` until a dedicated API exists. Draft text may live in
the open overlay only. It is never queued as a country action and never receives a fake
response.

## State topology

```text
Server page -> serialized canonical bootstrap -> GameSetupShell (client composition root)
                                             |-> WorldStateStoreController -> map projections
                                             |-> one turn controller -> simulation projections
                                             `-> GameOverlay reducer -> one ephemeral window

major-event acknowledgement queue ---------------------------------> modal (blocking)
```

## Consequences

The map stays alive through menu changes, authoritative mutations retain Prompt 10-12
validation and atomicity, and later backend work can replace null ports without redesigning
the screen. The tradeoff is that several initially sparse overlays deliberately show normal
empty states.

