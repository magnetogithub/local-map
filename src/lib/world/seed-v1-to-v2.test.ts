import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

import metadata from "@/data/countries-2020.json";
import type {Country} from "@/types/country";
import {
  migrateWorldSeedV1ToV2,
  type SeedV1CapitalFeature,
  type SeedV1GeometryFeature,
  type SeedV1FeatureCollection,
} from "./seed-v1-to-v2";

const read = <T,>(file: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), file), "utf8")) as T;

const countryGeometry = read<SeedV1FeatureCollection<SeedV1GeometryFeature>>(
  "public/data/maps/countries-10m.geojson",
);
const capitals = read<SeedV1FeatureCollection<SeedV1CapitalFeature>>(
  "public/data/maps/capitals-2020.geojson",
);
const input = () => ({
  metadata: metadata as Country[],
  countryGeometry,
  capitals,
  seedVersion: "natural-earth-2020-v1",
  policyVersion: "world-policy-v1",
});
const hash = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("10-19 seed v1 to v2 migration", () => {
  it("preserves every country and all required names", () => {
    const migrated = migrateWorldSeedV1ToV2(input());
    const expectedIds = new Set((metadata as Country[]).map(({id}) => id));

    expect(migrated.worldState.countryOrder).toHaveLength(expectedIds.size);
    expect(new Set(migrated.worldState.countryOrder)).toEqual(expectedIds);
    for (const country of metadata as Country[]) {
      const migratedCountry = migrated.worldState.countriesById[country.id];
      expect(migratedCountry.names).toMatchObject({
        shortKo: country.nameKo,
        officialKo: country.nameKo,
        mapKo: country.mapLabelKo,
        english: country.nameEn,
      });
      expect(migratedCountry.names.searchAliases).toEqual(
        [...new Set([country.id, country.iso3, country.nameKo, country.mapLabelKo, country.nameEn])],
      );
    }
  });

  it("preserves every geometry in one deterministically derived Territory", () => {
    const migrated = migrateWorldSeedV1ToV2(input());
    const territoriesBySourceId = new Map(
      Object.values(migrated.worldState.territoriesById).map((territory) => [
        territory.properties.sourceFeatureId,
        territory,
      ]),
    );

    expect(migrated.worldState.territoryOrder).toHaveLength(countryGeometry.features.length);
    for (const feature of countryGeometry.features) {
      const countryId = feature.properties.countryId;
      const territory = territoriesBySourceId.get(countryId);
      expect(territory?.ownerCountryId).toBe(countryId);
      expect(territory?.geometry).toEqual(feature.geometry);
    }
  }, 15_000);

  it("preserves every capital in an independent country module without fabricating missing ones", () => {
    const migrated = migrateWorldSeedV1ToV2(input());

    expect(Object.keys(migrated.countryCapitalsById)).toHaveLength(capitals.features.length);
    for (const feature of capitals.features) {
      expect(migrated.countryCapitalsById[feature.properties.countryId]).toEqual({
        countryId: feature.properties.countryId,
        nameKo: feature.properties.nameKo,
        nameEn: feature.properties.nameEn,
        capitalType: feature.properties.capitalType,
        labelRank: feature.properties.labelRank,
        coordinates: feature.geometry.coordinates,
      });
    }
    const countriesWithoutCapital = (metadata as Country[]).filter(
      ({id}) => !capitals.features.some((feature) => feature.properties.countryId === id),
    );
    expect(countriesWithoutCapital).toHaveLength(
      (metadata as Country[]).length - capitals.features.length,
    );
    expect(countriesWithoutCapital.every(({id}) => !migrated.countryCapitalsById[id])).toBe(true);
  });

  it("is deterministic when all three v1 seed collections are reversed", () => {
    const original = migrateWorldSeedV1ToV2(input());
    const reversed = migrateWorldSeedV1ToV2({
      ...input(),
      metadata: [...(metadata as Country[])].reverse(),
      countryGeometry: {...countryGeometry, features: [...countryGeometry.features].reverse()},
      capitals: {...capitals, features: [...capitals.features].reverse()},
    });

    expect(hash(reversed)).toBe(hash(original));
    expect(reversed).toEqual(original);
  }, 15_000);

  it("rejects country, geometry, and capital set loss before creating v2 state", () => {
    expect(() =>
      migrateWorldSeedV1ToV2({...input(), metadata: (metadata as Country[]).slice(1)}),
    ).toThrow(/without country metadata/);
    expect(() =>
      migrateWorldSeedV1ToV2({
        ...input(),
        countryGeometry: {...countryGeometry, features: countryGeometry.features.slice(1)},
      }),
    ).toThrow(/without geometry/);
    expect(() =>
      migrateWorldSeedV1ToV2({
        ...input(),
        capitals: {
          ...capitals,
          features: [
            ...capitals.features,
            {
              ...capitals.features[0],
              properties: {...capitals.features[0].properties, countryId: "UNKNOWN"},
            },
          ],
        },
      }),
    ).toThrow(/Capital without country metadata/);
  });

  it("does not retain mutable metadata, geometry, capital, or collection aliases", () => {
    const source = {
      ...input(),
      metadata: (metadata as Country[]).map((country) => ({...country})),
      countryGeometry: {
        ...countryGeometry,
        features: countryGeometry.features.map((feature) =>
          JSON.parse(JSON.stringify(feature)) as SeedV1GeometryFeature,
        ),
      },
      capitals: {
        ...capitals,
        features: capitals.features.map((feature) =>
          JSON.parse(JSON.stringify(feature)) as SeedV1CapitalFeature,
        ),
      },
    };
    const migrated = migrateWorldSeedV1ToV2(source);
    const countryId = source.metadata[0].id;
    const geometryFeature = source.countryGeometry.features.find(
      (feature) => feature.properties.countryId === countryId,
    )!;
    const capitalFeature = source.capitals.features[0];
    const territory = Object.values(migrated.worldState.territoriesById).find(
      (candidate) => candidate.properties.sourceFeatureId === countryId,
    )!;
    const originalPosition = [...(
      geometryFeature.geometry.type === "Polygon"
        ? geometryFeature.geometry.coordinates[0][0]
        : geometryFeature.geometry.coordinates[0][0][0]
    )];

    source.metadata[0].nameKo = "MUTATED";
    if (geometryFeature.geometry.type === "Polygon") {
      const coordinates = geometryFeature.geometry.coordinates as unknown as number[][][];
      coordinates[0][0][0] = 999;
    } else {
      const coordinates = geometryFeature.geometry.coordinates as unknown as number[][][][];
      coordinates[0][0][0][0] = 999;
    }
    (capitalFeature.properties as {nameKo: string}).nameKo = "MUTATED";
    (capitalFeature.geometry.coordinates as unknown as [number, number])[0] = 999;
    source.countryGeometry.features.reverse();
    source.capitals.features.reverse();

    expect(migrated.worldState.countriesById[countryId].names.shortKo).not.toBe("MUTATED");
    const migratedPosition =
      territory.geometry.type === "Polygon"
        ? territory.geometry.coordinates[0][0]
        : territory.geometry.coordinates[0][0][0];
    expect(migratedPosition).toEqual(originalPosition);
    expect(migrated.countryCapitalsById[capitalFeature.properties.countryId].nameKo).not.toBe(
      "MUTATED",
    );
    expect(migrated.countryCapitalsById[capitalFeature.properties.countryId].coordinates[0]).not.toBe(
      999,
    );
  });
});
