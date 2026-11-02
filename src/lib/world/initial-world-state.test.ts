import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";
import metadata from "@/data/countries-2020.json";
import type {Country} from "@/types/country";
import {
  createInitialWorldState,
  type InitialWorldStateSeed,
  type SeedFeatureCollection,
} from "../test-only/legacy-v1/initial-world-state";
import {
  countryEntityToCountry,
  type CapitalFeature,
  type CountryGeometryFeature,
} from "../test-only/legacy-v1/world-state";

const read = <T,>(file: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), file), "utf8")) as T;

const countryGeometry = read<SeedFeatureCollection<CountryGeometryFeature>>(
  "public/data/maps/countries-10m.geojson",
);
const capitals = read<SeedFeatureCollection<CapitalFeature>>(
  "public/data/maps/capitals-2020.geojson",
);
const seed: InitialWorldStateSeed = {
  metadata: metadata as Country[],
  countryGeometry,
  capitals,
};
const hash = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("9-5 initial WorldState seed", () => {
  it("reproduces the seed-defined country set and metadata order without loss", () => {
    const state = createInitialWorldState(seed);
    const expectedOrder = (metadata as Country[]).map((country) => country.id);

    expect(state.revision).toBe(0);
    expect(state.countryOrder).toEqual(expectedOrder);
    expect(Object.keys(state.countriesById)).toHaveLength((metadata as Country[]).length);
    expect(new Set(state.countryOrder)).toEqual(new Set(Object.keys(state.countriesById)));
    expect(state.countryOrder.map((id) => countryEntityToCountry(state.countriesById[id]))).toEqual(metadata);
    expect(state.countriesById.USA.names.mapKo).toBe("미합중국");
    expect(state.countriesById.CHN.names.mapKo).toBe("중화인민공화국");
  });

  it("is deterministic when geometry and capital feature order changes", () => {
    const reordered = createInitialWorldState({
      ...seed,
      countryGeometry: {...countryGeometry, features: [...countryGeometry.features].reverse()},
      capitals: {...capitals, features: [...capitals.features].reverse()},
    });
    const original = createInitialWorldState(seed);

    expect(reordered).toEqual(original);
    expect(hash(reordered)).toBe(hash(original));
  });

  it("joins capital coordinates by country id and preserves countries without capitals", () => {
    const state = createInitialWorldState(seed);
    const usaCapital = capitals.features.find((feature) => feature.properties.countryId === "USA");
    const noCapital = (metadata as Country[]).find(
      (country) => country.capitalKo === "—" && country.capitalEn === "—",
    );

    expect(state.countriesById.USA.capital?.coordinates).toEqual(usaCapital?.geometry.coordinates);
    expect(noCapital).toBeDefined();
    expect(state.countriesById[noCapital!.id].capital).toBeNull();
  });

  it("rejects duplicate or unowned seed features before state creation", () => {
    const duplicateGeometry = {
      ...countryGeometry,
      features: [...countryGeometry.features, countryGeometry.features[0]],
    };
    const unownedCapital: CapitalFeature = {
      type: "Feature",
      properties: {countryId: "NOT-IN-METADATA"},
      geometry: {type: "Point", coordinates: [0, 0]},
    };

    expect(() => createInitialWorldState({...seed, countryGeometry: duplicateGeometry})).toThrow(
      /duplicate country id/,
    );
    expect(() =>
      createInitialWorldState({
        ...seed,
        capitals: {...capitals, features: [...capitals.features, unownedCapital]},
      }),
    ).toThrow(/Capital without country metadata/);
  });
});
