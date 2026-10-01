# Prompt 13 game runtime audit

Status: historical input audit; superseded by the Prompt 13 final state (2026-10-01)

The lifecycle and coupling sections below record the pre-refactor state inspected in stage
13-1. The completed architecture owns the turn runtime once in `GameScreen`, renders
`GameActionOverlay` directly, and contains no `SimulationPanel` or `.side-stack` production
path. The authoritative data-source handoff is documented in
[`backend-port-plan.md`](./backend-port-plan.md).

## Route and component boundary

`src/app/page.tsx` and `src/app/game/page.tsx` are Server Components. Both render
`WorldAppPage`, which creates the production `WorldStateV2` and serializable map/panel
bootstrap projections on the server. `GameSetupShell` is the first Client Component and
is therefore the browser-side composition root. This matches the installed Next.js 16.3
guidance: route pages stay server-rendered and only the interactive subtree crosses the
`"use client"` boundary. Props crossing that boundary are serialized explicitly (notably
`SerializedWorldStateV2` and the serialized projections).

## Historical pre-refactor ownership audit

| Concern | Authoritative owner | Consumers / projection | Prompt 13 rule |
| --- | --- | --- | --- |
| Countries, territories, topology, revision | `WorldStateV2` inside the `WorldStateStoreController` created once by `GameSetupShell` | map, labels, search, country panel | Never copy into an overlay store. All world mutations continue through command/planner/atomic commit or the simulation publication API. |
| Map instance and source lifetime | `WorldMap` effect and its MapLibre instance | incremental world, marker, and label projections | Keep the map mounted while game overlays change. Do not rebuild sources for menu changes. |
| Setup selection and player country | `useGameSetupStore` | map interaction and country panel | Reuse it for selection. A later overlay reducer may own only which window is open, never country truth. |
| Simulation state and history | `ApplicationTurnRuntime`, backed by `AtomicTurnRuntime` | current date, turn number, queued actions, event log, undo/redo | This ownership was extracted from `SimulationPanel` into one controller/hook; overlays never instantiate a runtime. |
| Turn network lifecycle | Pre-refactor `SimulationPanel`: `AbortController` + `TurnClientState` | streaming phase/draft/error presentation | This lifecycle moved intact to the shared turn controller in stage 13-6. |
| Atomic world publication | `ApplicationTurnRuntime` -> `WorldStateStoreController.publishSimulationSnapshot` | all world projections | Keep preflight, commit, undo, and redo paths; UI must not patch the map or store directly. |
| Player country replacement | `syncSimulationPlayerCountry` after committed world effects | badge, map player filter, turn runtime | Reflect the active replacement immediately and clear stale selected targets. |

## Historical pre-refactor lifecycle

1. A Server Component builds the canonical initial world and serialized projections.
2. `GameSetupShell` creates exactly one `WorldStateStoreController` for the mounted route.
3. The setup store initializes projections and clears legacy browser persistence. `/game`
   redirects to `/` if no in-memory player country is present.
4. `WorldMap` creates one MapLibre map, loads detailed geometry lazily, and applies later
   world/label/marker revisions through its incremental adapters.
5. In the pre-refactor game mode, `SimulationPanel` created an
   `ApplicationTurnRuntime` for the selected player. Queue/cancel operations replaced
   pending actions in that runtime.
6. Advance freezes a request, streams server events, validates a resolution, constructs a
   resolved plan, and commits the simulation/world pair atomically. Stop aborts the active
   request; Retry repeats the last preset; undo/redo publish matching world snapshots.
7. A world revision change regenerates search and country-panel projections; the map
   receives incremental projection changes without being remounted.

## Historical coupling removed

Before the refactor, `SimulationPanel.tsx` combined runtime construction, player lifecycle,
queued action commands, request streaming, Stop/Retry, commit, undo/redo, report projection,
and all JSX. Stage 13-6 extracted those behaviors behind one controller. The old
`SimulationPanel` JSX and `.side-stack` production layout were removed; `GameActionOverlay`
now consumes the shared controller. `CountryPanel` in game mode was replaced by a
map-triggered country overlay while its committed projection remained reusable.

The old game-mode shell also rendered the setup header/footer and gave the map only the
remaining grid column. `GameScreen` now owns the full-viewport map and layers HUD chrome,
edge navigation, one management overlay, transient status, and the event modal above it.

## Final Prompt 13 runtime

`GameScreen` is the sole game composition root. It creates exactly one
`useSimulationTurnController`, dispatches every management view through one
`gameOverlayReducer`, and projects committed major/transformative events into one
`majorEventQueueReducer`. Only the queue head is rendered by `MajorEventModal`; time advance
remains blocked until every pending event is explicitly acknowledged.

`GameActionOverlay` is presentation only: it receives the one controller from
`GameScreen`. All management views share the same overlay union, so opening or toggling a
view replaces or closes the previous view. The map remains mounted while overlays change.

Future work must implement the typed ports in `contracts.ts` and replace only the current
projection/nullable command providers described in `backend-port-plan.md`. It must not
redesign the panels, add another turn controller or overlay store, bypass atomic
publication, or invent fallback domain values.

## Historical responsive constraints resolved

- 1280x720 and 1920x1080 are verified Prompt 13 targets; smaller screens keep the explicit
  unsupported-screen layer.
- The game route no longer reserves header/footer or `.side-stack` space. The map fills the
  viewport and `.game-panel__body` is the single management-overlay scroll owner.
- `WorldMap` remains mounted and observes its container while overlays change.
- Map selection opens the country member of the single overlay union and reconciliation
  closes references to countries retired by a commit.

## Persistence note

The selected player country and game runtime exist only in browser memory for the current
page lifetime. Reloading discards that in-memory selection and returns the user to the
initial setup screen. Production contains no `localStorage`, `sessionStorage`, or IndexedDB
save path; previously removed persistence modules and cleanup functions are not part of the
current runtime.

The runtime exposes serialization-oriented history metadata internally, but the Save UI
remains disabled/backend-pending until an authoritative `GameSavePort` is connected. It
must report success only after the future server save operation succeeds.

