import {describe, expect, it} from "vitest";
import {
  WORLD_STATE_SCHEMA_VERSION,
  assertWorldState,
  type CountryEntity,
  type WorldState,
} from "../test-only/legacy-v1/world-state";

const country = (id: string): CountryEntity => ({
  id,
  iso3: id,
  names: {
    shortKo: id,
    officialKo: id,
    mapKo: id,
    english: id,
    searchAliases: [id],
  },
  geometry: {
    type: "Polygon",
    coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]],
  },
  mapColor: "#ffffff",
  playable: true,
  unitType: "sovereign-country",
  capital: null,
  presentation: {
    flagCode: id,
    region: "Test",
    center: [1, 1],
    defaultZoom: 4,
    labelRank: 1,
  },
});

const validState = (): WorldState => ({
  schemaVersion: WORLD_STATE_SCHEMA_VERSION,
  revision: 0,
  countriesById: {AAA: country("AAA"), BBB: country("BBB")},
  countryOrder: ["AAA", "BBB"],
});

describe("9-4 WorldState invariants", () => {
  it("accepts the canonical four-field state shape", () => {
    const state = validState();
    expect(() => assertWorldState(state)).not.toThrow();
    expect(Object.keys(state).sort()).toEqual([
      "countriesById",
      "countryOrder",
      "revision",
      "schemaVersion",
    ]);
  });

  it("rejects an empty country id", () => {
    const state = validState() as unknown as Record<string, unknown>;
    state.countriesById = {"": country("")};
    state.countryOrder = [""];
    expect(() => assertWorldState(state)).toThrow(/non-empty country id/);
  });

  it("rejects a duplicate id in countryOrder", () => {
    const state = validState();
    state.countryOrder = ["AAA", "AAA"];
    expect(() => assertWorldState(state)).toThrow(/Duplicate country id/);
  });

  it("rejects an entity whose id differs from its record key", () => {
    const state = validState();
    state.countriesById.AAA = country("WRONG");
    expect(() => assertWorldState(state)).toThrow(/does not match its key/);
  });

  it.each([
    ["empty polygon", {type: "Polygon", coordinates: []}],
    ["open ring", {type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]]}],
    ["non-finite coordinate", {type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, Number.NaN], [0, 0]]]}],
    ["zero-area ring", {type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]]}],
    ["empty multipolygon", {type: "MultiPolygon", coordinates: []}],
  ])("rejects malformed geometry: %s", (_name, geometry) => {
    const state = validState();
    state.countriesById.AAA = {...state.countriesById.AAA, geometry} as CountryEntity;
    expect(() => assertWorldState(state)).toThrow(/geometry|coordinates|ring|position|area/i);
  });
});
