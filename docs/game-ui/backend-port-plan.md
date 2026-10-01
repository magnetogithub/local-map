# Game UI authoritative backend port plan

Status: Prompt 13 handoff contract (2026-10-01)

## Boundary rule

`GameScreen` remains the composition root for the map, one turn controller, one overlay,
and the major-event acknowledgement queue. A follow-up implementation replaces the
projection feeding an existing view model or supplies a nullable command port. It must not
change the overlay reducer, panel components, map ownership, or atomic turn publication
path.

Read models and port names are defined in `src/lib/game-ui/contracts.ts`. `WorldStateV2`
and `SimulationStateV1` remain authoritative for country identity, territory, date, event
history, and committed turn state. Missing domain data stays `null`/empty with
`dataAvailable: false`; no country-code table or UI-side calculation may fill it.

## Domain handoff matrix

| Domain | Implemented UI and current projection | Required authoritative backend/domain | Connection port |
| --- | --- | --- | --- |
| Politics | `PoliticsOverlay` shows regime, leader, domestic situation, and committed domestic events. `createPoliticsProjection` currently supplies null political fields and real simulation events. | A versioned political-state read model keyed by active `CountryId` and compatible with the committed world/simulation revision. It owns regime, leader, and domestic situation. | Implement `PoliticsViewPort.read(countryId)` and inject its `PoliticsViewModel`; keep `PoliticsOverlay` unchanged. |
| Economy | `EconomyOverlay` shows summary plus production, finance, and trade metric slots. `createEconomyProjection` supplies honest unavailable values and committed economic events. | A versioned economic snapshot keyed by active `CountryId`, with typed metric key, numeric value, unit, availability, and source revision. | Implement `EconomyViewPort.read(countryId)`. The port returns the existing `EconomyViewModel`; no formatting or calculation moves into the component. |
| Population | The HUD and Economy overlay share `EconomyViewModel.population`; both currently render `—`/connection-pending. | An authoritative demographic snapshot aligned to the same world and simulation revision as the economy read. Population must be nullable and must include no UI estimate. | Populate `EconomyViewPort.read(countryId).population`; `createGameHudProjection` continues to consume that same economy model so there is one source. |
| Relationships | `CountryOverlay` and `DiplomacyOverlay` show explicit player→foreign and foreign→player scores; `createRelationshipProjection` currently returns unknown values. | A directional relationship domain keyed by ordered country pair and revision. Scores must be integers in `[-100, 100]` and pass `assertRelationshipScore`. | Implement `RelationshipViewPort.read(playerCountryId, foreignCountryId)` and supply the resulting `BilateralRelationshipViewModel` to country/diplomacy projections. |
| War | `WarsOverlay` has list/detail/legend/map-toggle UI. The map reserves `war-areas` and `war-fronts`; `createWarsProjection` currently returns an empty unavailable collection. No aggregate troop or strength field exists. | A war aggregate with stable war IDs, participants, dates, status, related events, plus separately versioned front/occupation geometry. Geometry publication must use the existing map adapter rather than remounting the map. | Implement `WarsViewPort.read()` for `WarsViewModel`; connect typed war-layer data through the existing `WorldMap` UI-settings/map-source boundary. Do not add exact aggregate military-strength fields. |
| Diplomacy | `DiplomacyOverlay` already owns target selection, transcript rendering, intent selection, abort lifecycle, and disconnected/error states. Production currently supplies an empty transcript and disables send. | An authenticated diplomacy service that validates active country IDs, persists conversations server-side, returns ordered typed messages, supports cancellation/idempotency, and never fabricates a reply client-side. | Supply `DiplomacyViewPort.read(counterpartId)` and a nullable `DiplomacyChannelPort.send(request, signal)`. Keep the port `null` until the service is authoritative. |
| Save | `SaveOverlay` shows player/date/turn and explicitly reports that nothing was saved. There is no browser persistence or download path. | A server save service that atomically stores canonical world plus simulation snapshots, checks both revisions, identifies the player, and returns a durable save ID/time. | Supply nullable `GameSavePort.save(request, signal)`. The request carries player country, world revision, simulation revision, date, and turn; success UI may be enabled only after a non-null port resolves. |

## Wiring sequence for a follow-up prompt

1. Implement the backend/domain adapter against the port above.
2. Construct it at the server/client composition boundary without serializing secrets.
3. Replace only the corresponding projection call or nullable command handler in
   `GameScreen`.
4. Preserve null/loading/error states and validate revision/country identity at the port.
5. Re-run Prompt 11 incremental-map and Prompt 12 atomic turn/undo/redo regressions.

## Explicit non-ports

- UI settings stay ephemeral React state; they are not save data.
- Draft diplomacy text and streaming turn drafts are not committed domain state.
- The major-event queue remains a presentation of committed simulation events; the
  simulation event log is authoritative.
- Test fixtures and `src/lib/test-only` adapters are never valid production providers.
