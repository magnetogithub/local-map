import {useMemo, type ComponentProps} from "react";
import {act, cleanup, render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {useStore} from "zustand";

import {createCountryViewProjection, createDiplomacyChannelProjection} from "@/lib/game-ui/country-view-projection";
import {readCatalogConsumerMetadata} from "@/lib/map/catalog-consumer-contract";
import {createCatalogMapConsumerProjection} from "@/lib/projection/catalog-map-consumer-projection";
import {createCatalogRuntime} from "@/lib/simulation/catalog-runtime";
import {createCatalogTurnPlan} from "@/lib/simulation/catalog-turn-plan";
import {initialTurnClientState} from "@/lib/simulation/client/turn-state-machine";
import {createSimulationStateV2} from "@/lib/simulation/simulation-state-v2";
import type {ActiveCountryId, RetiredCountryId} from "@/lib/world/country-id";
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from "@/lib/world/world-geometry-catalog-ref";
import {createWorldStateV3} from "@/lib/world/world-state-v3";
import {useGameSetupStore} from "@/stores/game-setup-store";
import {GameScreenContent} from "./CatalogGameScreen";

vi.mock("@/components/map/CatalogWorldMap", () => ({CatalogWorldMap: () => null}));

type TurnController = ComponentProps<typeof GameScreenContent>["turnController"];
type LifecycleEffect = "countries.merged" | "country.dissolved";

/** Three validated cells exercise the production V3/V2 planner without loading world assets. */
function fixture() {
  const countryIds = ["AAA", "BBB", "CCC"] as const;
  const territoryIds = countryIds.map((_, index) =>
    readCatalogTerritoryId(`territory:catalog:${(index + 1).toString(16).padStart(64, "0")}`));
  const catalog = createWorldGeometryCatalogContract({
    ref: {
      catalogVersion: "f02-country-lifecycle-v1",
      geometryRoot: "1".repeat(64),
      topologyRoot: "2".repeat(64),
      renderArtifactRoot: "3".repeat(64),
      manifestPath: "/data/territory-catalog/f02-country-lifecycle-v1/manifest.json",
    },
    territoryOrder: territoryIds,
    territoriesById: Object.fromEntries(territoryIds.map((id, index) =>
      [id, {id, sourceCountryId: countryIds[index]}])),
  });
  const world = createWorldStateV3({
    schemaVersion: 3,
    seedVersion: "f02-seed-v1",
    policyVersion: "f02-policy-v1",
    revision: 0,
    countryOrder: countryIds,
    countriesById: Object.fromEntries(countryIds.map((id, index) => [id, {
      id,
      names: {shortKo: id, officialKo: id, mapKo: id, english: id, searchAliases: []},
      politicalStatus: "sovereign",
      presentationOverride: null,
      moduleVersions: {core: 1, names: 1},
      mapColor: ["#334455", "#556677", "#778899"][index],
    }])),
    retiredCountryIds: new Set(),
    catalogRef: catalog.ref,
    territoryOrder: territoryIds,
    territoriesById: Object.fromEntries(territoryIds.map((id, index) => [id, {
      id,
      sourceCountryId: countryIds[index],
      ownerCountryId: countryIds[index],
      controllerCountryId: countryIds[index],
    }])),
  }, catalog);
  const treaty = {
    eventId: "event.treaty",
    date: "2020-01-01",
    title: "기존 국가 승계 합의",
    publicNarrative: "참여국은 합병과 국가 승계 조건에 합의했습니다.",
    actorCountryIds: [...countryIds],
    relatedFactIds: [],
    relatedSituationIds: [],
    causes: [],
    outcomeCategory: "treaty",
    significance: "notable",
  };
  const simulation = createSimulationStateV2({
    schemaVersion: 2,
    revision: 0,
    currentDate: "2020-01-01",
    turnNumber: 0,
    playerCountryId: "AAA",
    queuedActions: [],
    factsById: {},
    factOrder: [],
    situationsById: {},
    situationOrder: [],
    scheduledConsequences: [],
    eventLog: [treaty],
    history: {lastCommittedTurnId: null, committedTurnCount: 0},
    territorialControlAuthoritiesById: {},
    territorialControlAuthorityOrder: [],
    countryPresentationAuthoritiesById: {},
    countryPresentationAuthorityOrder: [],
  }, world);
  const metadata = readCatalogConsumerMetadata({
    schemaVersion: "catalog-consumer-metadata-v1",
    catalogRef: catalog.ref,
    territories: territoryIds.map((id, index) => ({
      id,
      sourceCountryId: countryIds[index],
      bbox: [index * 2, 0, index * 2 + 1, 1],
      area: 1,
      anchor: [index * 2 + 0.5, 0.5],
    })),
    countries: countryIds.map((countryId, index) => ({
      countryId,
      iso3: countryId,
      flagCode: countryId,
      region: "Fixture",
      label: {territoryId: territoryIds[index], anchor: [index * 2 + 0.5, 0.5]},
      capital: null,
    })),
  }, catalog.ref);
  const runtime = createCatalogRuntime({
    world,
    simulation,
    revisions: {worldRevision: world.revision, simulationRevision: simulation.revision},
  }, catalog);
  const initialProjection = createCatalogMapConsumerProjection(world, metadata);
  const store = useGameSetupStore.getState();
  store.setCountrySearchProjection(initialProjection.search);
  store.setCountryPanelProjection(initialProjection.panel);
  store.syncSimulationPlayerCountry(simulation.playerCountryId);

  return {runtime, catalog, metadata, territoryIds, treaty};
}

type Fixture = ReturnType<typeof fixture>;

function FixtureGame({fixture: f}: {fixture: Fixture}) {
  const snapshot = useStore(f.runtime.store, state => state);
  const projection = useMemo(() =>
    createCatalogMapConsumerProjection(snapshot.world, f.metadata), [f.metadata, snapshot.world]);
  const controller: TurnController = {
    snapshot,
    actionDraft: "",
    setActionDraft: vi.fn(),
    queuedActions: snapshot.simulation.queuedActions,
    turn: initialTurnClientState(),
    report: null,
    lifecycleNotice: null,
    running: false,
    canQueue: false,
    canUndo: f.runtime.canUndo(),
    canRedo: f.runtime.canRedo(),
    queueAction: vi.fn(),
    cancelAction: vi.fn(),
    advance: vi.fn(async () => undefined),
    advanceToDate: vi.fn(async () => undefined),
    stop: vi.fn(),
    retry: vi.fn(async () => undefined),
    undo: () => {f.runtime.undo();},
    redo: () => {f.runtime.redo();},
  };
  // Keep setup-store projections/player deliberately behind the atomic pair, as during sync effects.
  return <GameScreenContent world={snapshot.world} mapProjection={projection}
    turnController={controller} counts={{}} map={<div>지도</div>}/>;
}

function retireCountry(f: Fixture, type: LifecycleEffect, countryId = "BBB", successorCountryId = "CCC") {
  const pair = f.runtime.getSnapshot();
  const effect = type === "countries.merged"
    ? {effectId: "effect.lifecycle", causedByEventId: "event.lifecycle", type,
      initiatorCountryId: successorCountryId, absorbedCountryIds: [countryId]}
    : {effectId: "effect.lifecycle", causedByEventId: "event.lifecycle", type, countryId, successorCountryId};
  const plan = createCatalogTurnPlan({
    turnId: "turn.lifecycle",
    simulation: pair.simulation,
    world: pair.world,
    catalog: f.catalog,
    resolution: {
      contractVersion: "turn-resolution.v1",
      baseSimulationRevision: pair.simulation.revision,
      baseWorldRevision: pair.world.revision,
      period: {startDate: pair.simulation.currentDate, endDate: "2020-01-02"},
      playerActionOutcomes: [],
      events: [{...f.treaty, eventId: "event.lifecycle", date: "2020-01-02",
        title: "국가 승계 확정", causes: [{kind: "authoritative-event", id: f.treaty.eventId}]}],
      factMutations: [],
      situationMutations: [],
      scheduledConsequences: [],
      worldEffects: [effect],
      advisorSummary: "합의된 국가 승계를 반영했습니다.",
      unresolvedQuestions: [],
    },
  });
  return f.runtime.commit(plan);
}

async function openCountry(user: ReturnType<typeof userEvent.setup>, countryId: string, diplomacy = false) {
  await user.selectOptions(screen.getByLabelText("지도 국가 선택"), countryId);
  expect(screen.getByTestId("country-overlay")).toHaveTextContent(countryId);
  if (diplomacy) {
    await user.click(screen.getByRole("button", {name: "외교 채널 열기"}));
    expect(screen.getByTestId("diplomacy-overlay")).toHaveTextContent(countryId);
  }
}

beforeEach(() => useGameSetupStore.getState().resetGameSetup());
afterEach(() => {
  cleanup();
  useGameSetupStore.getState().resetGameSetup();
});

describe("F02 country lifecycle render safety", () => {
  it.each([
    ["countries.merged", false],
    ["countries.merged", true],
    ["country.dissolved", false],
    ["country.dissolved", true],
  ] as const)("closes a retired target for %s (diplomacy=%s), including undo/redo", async (type, diplomacy) => {
    const user = userEvent.setup(), f = fixture();
    render(<FixtureGame fixture={f}/>);
    await openCountry(user, "BBB", diplomacy);

    act(() => {retireCountry(f, type);});
    const committed = f.runtime.getSnapshot();
    expect(committed.world.countriesById.BBB).toBeUndefined();
    expect(committed.world.retiredCountryIds.has("BBB" as RetiredCountryId)).toBe(true);
    expect(committed.world.territoriesById[f.territoryIds[1]]).toMatchObject({ownerCountryId: "CCC", controllerCountryId: "CCC"});
    expect(screen.queryByTestId("game-panel")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("지도 국가 선택")).queryByRole("option", {name: /BBB/})).not.toBeInTheDocument();
    expect(useGameSetupStore.getState().selectedCountryId).toBeNull();

    // A late selection still accepted by the stale search projection must not reopen a retired target.
    act(() => useGameSetupStore.getState().selectCountry("BBB"));
    expect(screen.queryByTestId("game-panel")).not.toBeInTheDocument();
    expect(useGameSetupStore.getState().selectedCountryId).toBeNull();

    act(() => {f.runtime.undo();});
    expect(f.runtime.getSnapshot().world.countriesById.BBB).toBeDefined();
    expect(within(screen.getByLabelText("지도 국가 선택")).getByRole("option", {name: /BBB/})).toBeInTheDocument();
    await openCountry(user, "BBB", diplomacy);

    act(() => {f.runtime.redo();});
    expect(screen.queryByTestId("game-panel")).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("지도 국가 선택")).queryByRole("option", {name: /BBB/})).not.toBeInTheDocument();
    expect(screen.getByLabelText("게임 현황")).toHaveTextContent("2020-01-02");
    expect(f.runtime.getSubscriberFailures()).toEqual([]);
  });

  it.each(["countries.merged", "country.dissolved"] as const)(
    "uses the simulation player before setup-store sync and closes self diplomacy after %s", async type => {
      const user = userEvent.setup(), f = fixture();
      render(<FixtureGame fixture={f}/>);
      await openCountry(user, "BBB", true);

      act(() => {retireCountry(f, type, "AAA", "BBB");});
      expect(useGameSetupStore.getState().playerCountryId).toBe("AAA");
      expect(f.runtime.getSnapshot().simulation.playerCountryId).toBe("BBB");
      expect(within(screen.getByLabelText("게임 현황")).getByRole("button", {name: "BBB 플레이 국가, 정치 열기"})).toBeInTheDocument();
      expect(screen.queryByTestId("game-panel")).not.toBeInTheDocument();
      expect(within(screen.getByLabelText("지도 국가 선택")).getByRole("option", {name: "BBB · BBB · 플레이 국가"})).toBeInTheDocument();

      await user.click(screen.getByRole("button", {name: "정치"}));
      expect(screen.getByTestId("game-panel")).toHaveTextContent("BBB");
      act(() => {f.runtime.undo();});
      expect(screen.getByTestId("game-panel")).toHaveTextContent("AAA");
      await user.click(screen.getByRole("button", {name: "경제"}));
      expect(screen.getByTestId("game-panel")).toHaveTextContent("AAA");
      act(() => {f.runtime.redo();});
      expect(screen.getByTestId("game-panel")).toHaveTextContent("BBB");
      expect(f.runtime.getSubscriberFailures()).toEqual([]);
    },
  );

  it("keeps domain projections rejecting a retired country and diplomacy counterpart", () => {
    const f = fixture(), pair = retireCountry(f, "country.dissolved");
    const projection = createCatalogMapConsumerProjection(pair.world, f.metadata);
    const input = {world: pair.world, mapProjection: projection, playerCountryId: pair.simulation.playerCountryId};
    expect(() => createCountryViewProjection({...input, countryId: "BBB" as ActiveCountryId,
      simulation: pair.simulation, countryPanelProjection: projection.panel})).toThrow("Country view target is not active: BBB");
    expect(() => createDiplomacyChannelProjection({...input, counterpartCountryId: "BBB" as ActiveCountryId}))
      .toThrow("Management projection country is not active: BBB");
  });

  it("uses the snapshot player even when the previous setup player is still active", async () => {
    const user = userEvent.setup(), f = fixture();
    render(<FixtureGame fixture={f}/>);

    act(() => {f.runtime.selectPlayer("BBB");});
    expect(useGameSetupStore.getState().playerCountryId).toBe("AAA");
    expect(f.runtime.getSnapshot().world.countriesById.AAA).toBeDefined();
    expect(within(screen.getByLabelText("게임 현황")).getByRole("button", {name: "BBB 플레이 국가, 정치 열기"})).toBeInTheDocument();
    await openCountry(user, "AAA");
    expect(screen.getByTestId("country-overlay")).toHaveTextContent("BBB → AAA");
    await user.click(screen.getByRole("button", {name: "외교 채널 열기"}));
    const targets = screen.getByLabelText("외교 대상 국가");
    expect(within(targets).getByRole("button", {name: /AAA/})).toBeInTheDocument();
    expect(within(targets).queryByRole("button", {name: /BBB/})).not.toBeInTheDocument();
  });
});
