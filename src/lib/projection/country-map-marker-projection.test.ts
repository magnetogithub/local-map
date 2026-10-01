import {describe, expect, it} from "vitest";

import {createCountryEntity} from "../world/country-entity";
import {retireCountryId, type ActiveCountryId} from "../world/country-id";
import type {SeedCountryCapital} from "../world/seed-v1-to-v2";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import {createTopologyState} from "../world/topology-state";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import {
  countDanglingCapitalFeatures,
  createCountryCapitalProjection,
} from "./country-capital-projection";
import {
  createCountryMapMarkerProjection,
  shouldApplyCountryMapMarkerProjection,
  type SmallCountryMarkerSeed,
} from "./country-map-marker-projection";

const activeCountryId = (countryId: "AAA" | "BBB") => countryId as ActiveCountryId;

const rectangle = (x: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[
    [x, 0],
    [x + 2, 0],
    [x + 2, 2],
    [x, 2],
    [x, 0],
  ]],
});

const country = (id: "AAA" | "BBB") => createCountryEntity({
  id: activeCountryId(id),
  names: {
    shortKo: id,
    officialKo: `${id} Republic`,
    mapKo: id,
    english: `${id} Republic`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {capital: 1, core: 1, names: 1},
});

const territoryId = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "11-8-test", sourceFeatureId});

const territory = (
  id: TerritoryId,
  ownerCountryId: "AAA" | "BBB" | null,
  geometry: TerritoryGeometry,
) => createTerritoryEntity({
  id,
  ownerCountryId: ownerCountryId === null ? null : activeCountryId(ownerCountryId),
  geometry,
  properties: {sourceFeatureId: id},
});

const world = (
  revision: number,
  includeAaa: boolean,
): WorldStateV2 => {
  const alpha = territoryId("alpha");
  const beta = territoryId("beta");
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "11-8-test",
    policyVersion: "world-policy-v1",
    revision,
    countriesById: includeAaa
      ? {AAA: country("AAA"), BBB: country("BBB")}
      : {BBB: country("BBB")},
    countryOrder: includeAaa ? [activeCountryId("AAA"), activeCountryId("BBB")] : [activeCountryId("BBB")],
    retiredCountryIds: includeAaa ? [] : [retireCountryId(activeCountryId("AAA"))],
    territoriesById: {
      [alpha]: territory(alpha, includeAaa ? "AAA" : null, rectangle(0)),
      [beta]: territory(beta, "BBB", rectangle(4)),
    },
    territoryOrder: [alpha, beta],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: null,
      presentationRootHash: null,
      territoriesRootHash: null,
      topologyRootHash: null,
    },
  });
};

const capitals: Readonly<Record<string, SeedCountryCapital>> = Object.freeze({
  AAA: Object.freeze({
    countryId: activeCountryId("AAA"),
    nameKo: "Alpha City",
    nameEn: "Alpha City",
    capitalType: "national",
    labelRank: 1,
    coordinates: Object.freeze([1, 1] as const),
  }),
  BBB: Object.freeze({
    countryId: activeCountryId("BBB"),
    nameKo: "Beta City",
    nameEn: "Beta City",
    capitalType: "national",
    labelRank: 1,
    coordinates: Object.freeze([5, 1] as const),
  }),
});

const smallMarkers: Readonly<Record<string, SmallCountryMarkerSeed>> = Object.freeze({
  AAA: Object.freeze({
    countryId: activeCountryId("AAA"),
    nameKo: "Alpha",
    playable: true,
    coordinates: Object.freeze([1, 1] as const),
  }),
  BBB: Object.freeze({
    countryId: activeCountryId("BBB"),
    nameKo: "Beta",
    playable: true,
    coordinates: Object.freeze([5, 1] as const),
  }),
});

const buildMarkerProjection = (state: WorldStateV2) => {
  const capitalProjection = createCountryCapitalProjection(state, capitals);
  return {
    capitalProjection,
    markerProjection: createCountryMapMarkerProjection(state, capitalProjection, smallMarkers),
  };
};

describe("11-8 country map marker projection", () => {
  it("records appliedRevision on capital and marker artifacts", () => {
    const state = world(41, true);
    const {capitalProjection, markerProjection} = buildMarkerProjection(state);

    expect(capitalProjection.appliedRevision).toBe(41);
    expect(markerProjection.appliedRevision).toBe(41);
    expect(markerProjection.capitals.features.every((feature) =>
      feature.properties.countryId === "AAA" || feature.properties.countryId === "BBB"
    )).toBe(true);
    expect(markerProjection.smallCountryMarkers.features.every((feature) =>
      feature.properties.projectionRevision === 41
    )).toBe(true);
  });

  it("removes dissolved country capitals and small markers without dangling territory references", () => {
    const dissolved = world(42, false);
    const {capitalProjection, markerProjection} = buildMarkerProjection(dissolved);

    expect(markerProjection.capitals.features.map((feature) => feature.properties.countryId))
      .toEqual([activeCountryId("BBB")]);
    expect(markerProjection.smallCountryMarkers.features.map((feature) => feature.properties.countryId))
      .toEqual([activeCountryId("BBB")]);
    expect(markerProjection.omittedCapitalCountryIds).toEqual([]);
    expect(countDanglingCapitalFeatures(capitalProjection, dissolved)).toBe(0);
    expect(markerProjection.capitals.features.some((feature) =>
      feature.properties.countryId === "AAA" ||
      dissolved.territoriesById[feature.properties.territoryId]?.ownerCountryId !==
        feature.properties.countryId
    )).toBe(false);
  });

  it("uses committed country names and policy, and rejects stale marker revisions", () => {
    const initial = world(41, true);
    const renamed = createWorldStateV2({
      ...initial,
      revision: 42,
      countriesById: {
        ...initial.countriesById,
        AAA: createCountryEntity({
          ...initial.countriesById.AAA,
          names: {...initial.countriesById.AAA.names, mapKo: "New Alpha"},
          politicalStatus: "dependent",
        }),
      },
    });
    const oldMarkers = buildMarkerProjection(initial).markerProjection;
    const markers = buildMarkerProjection(renamed).markerProjection;
    const alpha = markers.smallCountryMarkers.features.find((feature) => feature.id === "AAA");

    expect(alpha?.properties).toMatchObject({nameKo: "New Alpha", playable: false, projectionRevision: 42});
    expect(shouldApplyCountryMapMarkerProjection(oldMarkers.appliedRevision, markers)).toBe(true);
    expect(shouldApplyCountryMapMarkerProjection(markers.appliedRevision, oldMarkers)).toBe(false);
    expect(shouldApplyCountryMapMarkerProjection(markers.appliedRevision, markers)).toBe(false);
  });
});
