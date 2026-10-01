import {describe, expect, it} from "vitest";

import {
  WORLD_STATE_SCHEMA_VERSION,
  countryEntityGeometryHash,
  countryEntityLabelCacheKey,
  type CountryEntity,
  type WorldState,
} from "@/lib/test-only/legacy-v1/world-state";

import {
  applyCountryRenameCommand,
  countryRenameCommandSchema,
  safeParseCountryRenameCommand,
  type CountryRenameChanges,
  type CountryRenameCommand,
} from "@/lib/test-only/legacy-v1/country-rename";

const country = (id: string): CountryEntity => ({
  id,
  iso3: id,
  names: {
    shortKo: `${id} 단축명`,
    officialKo: `${id} 공식명`,
    mapKo: `${id} 지도명`,
    english: `${id} English`,
    searchAliases: [id, `${id} alias`],
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

const state = (...countries: CountryEntity[]): WorldState => ({
  schemaVersion: WORLD_STATE_SCHEMA_VERSION,
  revision: 9,
  countriesById: Object.fromEntries(countries.map((entity) => [entity.id, entity])),
  countryOrder: countries.map((entity) => entity.id),
});

const command = (changes: CountryRenameChanges, countryId = "AAA"): CountryRenameCommand => ({
  commandId: `rename-${countryId}`,
  type: "country.rename",
  expectedRevision: 9,
  payload: {countryId, changes},
  issuedAt: "2026-08-31T09:00:00+09:00",
  source: "unit-test",
});

describe("9-12 country.rename schema", () => {
  it.each([
    ["shortKo", {shortKo: "새 단축명"}, "shortKo", "새 단축명", false],
    ["officialKo", {officialKo: "새 공식명"}, "officialKo", "새 공식명", false],
    ["mapKo", {mapKo: "새 지도명"}, "mapKo", "새 지도명", true],
    ["english", {english: "New English Name"}, "english", "New English Name", false],
    ["aliases", {aliases: ["새 별칭"]}, "searchAliases", ["새 별칭"], false],
  ] as const)(
    "changes only the explicit %s field while preserving geometry",
    (_caseName, changes, storedField, expectedValue, shouldChangeLabelKey) => {
      const original = country("AAA");
      const current = state(original, country("BBB"));
      const geometryHashBefore = countryEntityGeometryHash(original);
      const labelKeyBefore = countryEntityLabelCacheKey(original);
      const next = applyCountryRenameCommand(
        current,
        command(changes as CountryRenameChanges),
      );
      const renamed = next.countriesById.AAA;

      expect(renamed.names[storedField]).toEqual(expectedValue);
      for (const field of Object.keys(original.names) as Array<keyof typeof original.names>) {
        if (field !== storedField) expect(renamed.names[field]).toEqual(original.names[field]);
      }
      expect(renamed.geometry).toBe(original.geometry);
      expect(countryEntityGeometryHash(renamed)).toBe(geometryHashBefore);
      expect(countryEntityLabelCacheKey(renamed) === labelKeyBefore).toBe(!shouldChangeLabelKey);
      expect(next.countriesById.BBB).toBe(current.countriesById.BBB);
      expect(next.countryOrder).toBe(current.countryOrder);
      expect(next.revision).toBe(current.revision + 1);
    },
  );

  it("applies multiple explicit fields without changing unspecified names", () => {
    const original = country("AAA");
    const next = applyCountryRenameCommand(
      state(original),
      command({shortKo: "복합 단축명", english: "Combined Name", aliases: []}),
    );

    expect(next.countriesById.AAA.names).toEqual({
      ...original.names,
      shortKo: "복합 단축명",
      english: "Combined Name",
      searchAliases: [],
    });
  });

  it("rejects an empty changes object", () => {
    expect(countryRenameCommandSchema.safeParse(command({} as CountryRenameChanges)).success).toBe(
      false,
    );
  });

  it.each(["shortKo", "officialKo", "mapKo", "english"] as const)(
    "rejects an empty %s value",
    (field) => {
      expect(
        countryRenameCommandSchema.safeParse(command({[field]: "   "} as CountryRenameChanges))
          .success,
      ).toBe(false);
    },
  );

  it("rejects an empty alias value", () => {
    expect(countryRenameCommandSchema.safeParse(command({aliases: ["valid", " "]})).success).toBe(
      false,
    );
  });

  it("rejects unknown change fields such as geometry", () => {
    expect(
      countryRenameCommandSchema.safeParse(
        command({geometry: {type: "Polygon", coordinates: []}} as unknown as CountryRenameChanges),
      ).success,
    ).toBe(false);
  });

  it("rejects an unknown country without mutating state", () => {
    const current = state(country("AAA"));
    const result = safeParseCountryRenameCommand(command({shortKo: "새 이름"}, "MISSING"), current);

    expect(result.success).toBe(false);
    expect(current.revision).toBe(9);
    expect(current.countriesById.AAA.names.shortKo).toBe("AAA 단축명");
  });

  it("revalidates cast input before applying a rename", () => {
    const invalid = command({mapKo: ""}) as CountryRenameCommand;

    expect(() => applyCountryRenameCommand(state(country("AAA")), invalid)).toThrow();
  });
});
