import {describe, expect, it} from "vitest";

import {createWorldMapRuntimeProjection} from "@/lib/projection/world-map-runtime-projection";
import {createCountryCapitalProjection} from "@/lib/projection/country-capital-projection";
import {createCountryPanelProjection, emptyCountryPanelProjection, getCountryPanelView} from "@/lib/projection/country-panel-projection";
import {createInitialSimulationState} from "@/lib/simulation/initial-simulation-state";
import {createProductionCountryPanelPresentationEntries, createProductionInitialWorldStateV2} from "@/lib/world/initial-world-state-v2";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {testWorldState} from "@/stores/world-state-store-v2-fixture";
import {
  createCountryViewProjection,
  createDiplomacyChannelProjection,
  createRelationshipProjection,
} from "./country-view-projection";

describe("13-16 and 13-17 country diplomacy projections", () => {
  it("keeps both relationship directions explicit and unknown", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const relationship = createRelationshipProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      playerCountryId: world.countryOrder[0],
      foreignCountryId: world.countryOrder[1],
    });
    expect(relationship.playerToForeign).toMatchObject({
      fromCountry: {countryId: "AAA"},
      toCountry: {countryId: "BBB"},
      score: null,
      dataAvailable: false,
    });
    expect(relationship.foreignToPlayer).toMatchObject({
      fromCountry: {countryId: "BBB"},
      toCountry: {countryId: "AAA"},
      score: null,
      dataAvailable: false,
    });
  });

  it("branches player and foreign country views without fake wars or relationship values", () => {
    const world = testWorldState(["AAA", "BBB"]);
    const mapProjection = createWorldMapRuntimeProjection(world);
    const simulation = createInitialSimulationState(world, "AAA");
    const countryPanelProjection = {...emptyCountryPanelProjection, revision: world.revision, appliedRevision: world.revision};
    const player = createCountryViewProjection({world, mapProjection, playerCountryId: world.countryOrder[0], countryId: world.countryOrder[0], simulation, countryPanelProjection});
    const foreign = createCountryViewProjection({world, mapProjection, playerCountryId: world.countryOrder[0], countryId: world.countryOrder[1], simulation, countryPanelProjection});
    expect(player).toMatchObject({isPlayerCountry: true, relationship: null, warsDataAvailable: false, relatedWars: []});
    expect(foreign).toMatchObject({isPlayerCountry: false, warsDataAvailable: false, relatedWars: []});
    expect(foreign.relationship?.playerToForeign.score).toBeNull();
    expect(foreign).toMatchObject({capitalKo: null, capitalEn: null, region: null});
  });

  it("reads capital directions and region from the current production country panel projection", () => {
    const initial = createProductionInitialWorldStateV2();
    const world = initial.worldState;
    const countryPanelProjection = createCountryPanelProjection(
      world,
      createCountryCapitalProjection(world, initial.countryCapitalsById),
      createProductionCountryPanelPresentationEntries(),
    );
    const countryId = "KOR" as ActiveCountryId;
    const source = getCountryPanelView(countryPanelProjection, countryId);
    expect(source).not.toBeNull();
    const model = createCountryViewProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      playerCountryId: countryId,
      countryId,
      simulation: createInitialSimulationState(world, countryId),
      countryPanelProjection,
    });
    expect(model.capitalKo).toBe(source?.capitalKo);
    expect(model.capitalEn).toBe(source?.capitalEn);
    expect(model.region).toBe(source?.region);
  }, 60_000);

  it("normalizes current-projection missing capital and region sentinels to null", () => {
    const world = testWorldState(["AAA"]);
    const countryId = world.countryOrder[0];
    const countryPanelProjection = {
      revision: world.revision,
      appliedRevision: world.revision,
      coreById: new Map([[countryId, {countryId, iso3: "AAA"}]]),
      inputById: new Map([[countryId, {
        nameKo: "AAA",
        nameEn: "AAA",
        capitalKo: "??",
        capitalEn: " ",
        flagCode: "AAA",
        region: "",
      }]]),
      playableById: new Map([[countryId, true]]),
    };
    const model = createCountryViewProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      playerCountryId: countryId,
      countryId,
      simulation: createInitialSimulationState(world, countryId),
      countryPanelProjection,
    });
    expect(model).toMatchObject({capitalKo: null, capitalEn: null, region: null});
  });

  it("does not reuse stale presentation revisions or create an unknown country placeholder", () => {
    const world = testWorldState(["AAA"]);
    const staleProjection = {...emptyCountryPanelProjection, revision: world.revision + 1, appliedRevision: world.revision + 1};
    const common = {
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      playerCountryId: world.countryOrder[0],
      simulation: createInitialSimulationState(world, "AAA"),
      countryPanelProjection: staleProjection,
    };
    expect(createCountryViewProjection({...common, countryId: world.countryOrder[0]})).toMatchObject({capitalKo: null, capitalEn: null, region: null});
    expect(() => createCountryViewProjection({...common, countryId: "ZZZ" as ActiveCountryId})).toThrow(/not active/);
  });

  it("creates a disconnected channel with real targets and no transcript", () => {
    const world = testWorldState(["AAA", "BBB", "CCC"]);
    const model = createDiplomacyChannelProjection({
      world,
      mapProjection: createWorldMapRuntimeProjection(world),
      playerCountryId: world.countryOrder[0],
      counterpartCountryId: world.countryOrder[1],
    });
    expect(model.availableCounterparts.map(({countryId}) => countryId)).toEqual(["BBB", "CCC"]);
    expect(model.counterpart?.countryId).toBe("BBB");
    expect(model).toMatchObject({connectionState: "disconnected", canSend: false, transcript: []});
    expect(model.relationship?.playerToForeign.score).toBeNull();
  });
});
