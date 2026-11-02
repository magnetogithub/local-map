import {describe, expect, it} from "vitest";

import {createWorldMapRuntimeProjection} from "@/lib/projection/world-map-runtime-projection";
import {createInitialSimulationState} from "@/lib/simulation/initial-simulation-state";
import {testWorldState} from "@/stores/world-state-store-v2-fixture";
import {createGameHudProjection} from "./game-hud-projection";

describe("13-11 game HUD projection", () => {
  it("uses current canonical country and simulation values", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const simulation = createInitialSimulationState(world, "AAA");
    const projection = createGameHudProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      playerCountryId: simulation.playerCountryId,
      simulation,
      phase: "idle",
    });
    expect(projection.playerCountry).toMatchObject({
      countryId: "AAA",
      nameKo: world.countriesById.AAA.names.shortKo,
      code: "AAA",
    });
    expect(projection.playerCountry.mapColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(projection).toMatchObject({
      currentDate: "2020-01-01",
      turnNumber: 0,
      queuedActionCount: 0,
      unacknowledgedMajorEventCount: 0,
    });
  });

  it("keeps unavailable metrics null instead of inventing zeroes", () => {
    const world = testWorldState(["AAA"]);
    const projection = createGameHudProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      playerCountryId: world.countryOrder[0],
      simulation: null,
      phase: "idle",
    });
    expect(projection).toMatchObject({
      dataAvailable: false,
      currentDate: null,
      turnNumber: null,
      population: null,
      queuedActionCount: null,
      unacknowledgedMajorEventCount: null,
      ongoingWarCount: null,
    });
  });

  it("reads population from the same economy view model used by the overlay", () => {
    const world = testWorldState(["AAA"]);
    const projection = createGameHudProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      playerCountryId: world.countryOrder[0],
      simulation: createInitialSimulationState(world, "AAA"),
      phase: "idle",
      economy: {population: 12_345},
    });
    expect(projection.population).toBe(12_345);
  });

  it("uses the live unacknowledged major-event queue count when supplied", () => {
    const world = testWorldState(["AAA"]);
    const projection = createGameHudProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      playerCountryId: world.countryOrder[0],
      simulation: createInitialSimulationState(world, "AAA"),
      phase: "committed",
      unacknowledgedMajorEventCount: 2,
    });
    expect(projection.unacknowledgedMajorEventCount).toBe(2);
  });
});

