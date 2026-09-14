import {describe, expect, it} from "vitest";

import type {PolygonGeometry} from "@/lib/map/country-label-layout";
import {
  WORLD_STATE_SCHEMA_VERSION,
  type CountryEntity,
  type WorldState,
} from "@/lib/world/world-state";

import {
  applyTerritoryReplaceCommand,
  normalizePolygonGeometry,
  safeParseTerritoryReplaceCommand,
  territoryReplaceCommandSchema,
  type TerritoryReplaceCommand,
} from "./territory-replace";

const polygon = (coordinates: unknown): unknown => ({type: "Polygon", coordinates});

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
  geometry: polygon([[[0, 0], [3, 0], [3, 3], [0, 0]]]) as PolygonGeometry,
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

const state = (...countries: CountryEntity[]): WorldState => ({
  schemaVersion: WORLD_STATE_SCHEMA_VERSION,
  revision: 4,
  countriesById: Object.fromEntries(countries.map((entity) => [entity.id, entity])),
  countryOrder: countries.map((entity) => entity.id),
});

const command = (geometry: unknown, countryId = "AAA") => ({
  commandId: `replace-${countryId}`,
  type: "territory.replace",
  expectedRevision: 4,
  payload: {countryId, geometry},
  issuedAt: "2026-08-31T09:00:00+09:00",
  source: "unit-test",
});

describe("9-13 territory.replace schema", () => {
  it("normalizes exterior and hole winding to the right-hand rule", () => {
    const geometry = polygon([
      [[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]],
      [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
    ]);

    expect(normalizePolygonGeometry(geometry)).toEqual({
      type: "Polygon",
      coordinates: [
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
        [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
      ],
    });
  });

  it("produces identical canonical output for rotated starts and reversed winding", () => {
    const first = polygon([
      [[4, 4], [4, 0], [0, 0], [0, 4], [4, 4]],
      [[3, 3], [1, 3], [1, 1], [3, 1], [3, 3]],
    ]);
    const second = polygon([
      [[0, 4], [0, 0], [4, 0], [4, 4], [0, 4]],
      [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]],
    ]);

    expect(normalizePolygonGeometry(first)).toEqual(normalizePolygonGeometry(second));
    expect(normalizePolygonGeometry(first)).toEqual(normalizePolygonGeometry(first));
  });

  it("sorts MultiPolygon components deterministically", () => {
    const left = [[[0, 0], [2, 0], [2, 2], [0, 0]]];
    const right = [[[10, 10], [12, 10], [12, 12], [10, 10]]];
    const forward = {type: "MultiPolygon", coordinates: [left, right]};
    const reverse = {type: "MultiPolygon", coordinates: [right, left]};

    expect(normalizePolygonGeometry(forward)).toEqual(normalizePolygonGeometry(reverse));
  });

  it("sorts holes deterministically regardless of input order", () => {
    const exterior = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const leftHole = [[1, 1], [1, 3], [3, 3], [3, 1], [1, 1]];
    const rightHole = [[6, 6], [8, 6], [8, 8], [6, 8], [6, 6]];

    expect(normalizePolygonGeometry(polygon([exterior, leftHole, rightHole]))).toEqual(
      normalizePolygonGeometry(polygon([exterior, rightHole, leftHole])),
    );
  });

  it.each([
    ["bow tie", polygon([[[0, 0], [3, 3], [0, 3], [3, 0], [0, 0]]])],
    ["non-adjacent touch", polygon([[[0, 0], [3, 0], [1, 1], [3, 3], [1, 1], [0, 3], [0, 0]]])],
  ])("rejects self-intersection: %s", (_name, geometry) => {
    expect(territoryReplaceCommandSchema.safeParse(command(geometry)).success).toBe(false);
  });

  it.each([
    ["empty Polygon", polygon([])],
    ["empty MultiPolygon", {type: "MultiPolygon", coordinates: []}],
  ])("rejects empty geometry: %s", (_name, geometry) => {
    expect(territoryReplaceCommandSchema.safeParse(command(geometry)).success).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a non-finite coordinate: %s",
    (coordinate) => {
      const geometry = polygon([[[0, 0], [2, 0], [2, coordinate], [0, 0]]]);
      expect(territoryReplaceCommandSchema.safeParse(command(geometry)).success).toBe(false);
    },
  );

  it.each([
    ["open ring", polygon([[[0, 0], [2, 0], [2, 2], [0, 2]]])],
    ["zero area", polygon([[[0, 0], [1, 0], [2, 0], [0, 0]]])],
    ["hole outside exterior", polygon([
      [[0, 0], [4, 0], [4, 4], [0, 0]],
      [[10, 10], [11, 10], [11, 11], [10, 10]],
    ])],
  ])("rejects an invalid polygon relation: %s", (_name, geometry) => {
    expect(territoryReplaceCommandSchema.safeParse(command(geometry)).success).toBe(false);
  });

  it("replaces only the requested country's complete geometry with the normalized result", () => {
    const original = country("AAA");
    const other = country("BBB");
    const current = state(original, other);
    const inputGeometry = polygon([[[0, 0], [0, 5], [6, 5], [6, 0], [0, 0]]]);
    const next = applyTerritoryReplaceCommand(current, command(inputGeometry));

    expect(next.countriesById.AAA.geometry).toEqual({
      type: "Polygon",
      coordinates: [[[0, 0], [6, 0], [6, 5], [0, 5], [0, 0]]],
    });
    expect(next.countriesById.AAA.geometry).not.toBe(original.geometry);
    expect(next.countriesById.AAA.names).toBe(original.names);
    expect(next.countriesById.BBB).toBe(other);
    expect(next.countryOrder).toBe(current.countryOrder);
    expect(next.revision).toBe(current.revision + 1);
  });

  it("rejects an unknown country without mutating state", () => {
    const current = state(country("AAA"));
    const geometryBefore = current.countriesById.AAA.geometry;
    const result = safeParseTerritoryReplaceCommand(
      command(polygon([[[0, 0], [2, 0], [2, 2], [0, 0]]]), "MISSING"),
      current,
    );

    expect(result.success).toBe(false);
    expect(current.revision).toBe(4);
    expect(current.countriesById.AAA.geometry).toBe(geometryBefore);
  });

  it("rejects unknown geometry and payload fields", () => {
    const geometry = {
      type: "Polygon",
      coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]],
      bbox: [0, 0, 2, 2],
    };
    expect(territoryReplaceCommandSchema.safeParse(command(geometry)).success).toBe(false);
    expect(
      territoryReplaceCommandSchema.safeParse({
        ...command(polygon([[[0, 0], [2, 0], [2, 2], [0, 0]]])),
        payload: {
          ...command(polygon([[[0, 0], [2, 0], [2, 2], [0, 0]]])).payload,
          merge: true,
        },
      }).success,
    ).toBe(false);
  });

  it("revalidates cast input before applying geometry", () => {
    const invalid = command(polygon([])) as unknown as TerritoryReplaceCommand;

    expect(() => applyTerritoryReplaceCommand(state(country("AAA")), invalid)).toThrow();
  });
});
