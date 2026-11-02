import {describe, expect, it} from "vitest";

import {
  WORLD_STATE_SCHEMA_VERSION,
  type CountryEntity,
  type WorldState,
} from "@/lib/test-only/legacy-v1/world-state";

import {
  countryCreateCommandSchema,
  parseCountryCreateCommand,
  safeParseCountryCreateCommand,
  type CountryCreateCommand,
} from "@/lib/test-only/legacy-v1/country-create";

const country = (id = "NEW"): CountryEntity => ({
  id,
  iso3: id,
  names: {
    shortKo: "새 국가",
    officialKo: "새 국가 공화국",
    mapKo: "새 국가",
    english: "New Country",
    searchAliases: [id, "New Country"],
  },
  geometry: {
    type: "Polygon",
    coordinates: [[[0, 0], [4, 0], [4, 3], [0, 0]]],
  },
  mapColor: "#123456",
  playable: true,
  unitType: "sovereign-country",
  capital: null,
  presentation: {
    flagCode: "NC",
    region: "Test Region",
    center: [2, 1],
    defaultZoom: 4,
    labelRank: 3,
  },
});

const state = (...countries: CountryEntity[]): WorldState => ({
  schemaVersion: WORLD_STATE_SCHEMA_VERSION,
  revision: 7,
  countriesById: Object.fromEntries(countries.map((entity) => [entity.id, entity])),
  countryOrder: countries.map((entity) => entity.id),
});

const command = (entity = country()): CountryCreateCommand => ({
  commandId: "create-new-country",
  type: "country.create",
  expectedRevision: 7,
  payload: {country: entity},
  issuedAt: "2026-08-31T09:00:00+09:00",
  source: "unit-test",
});

describe("9-10 country.create schema", () => {
  it("accepts a complete CountryEntity without initial presentation", () => {
    const parsed = parseCountryCreateCommand(command(), state());

    expect(parsed.type).toBe("country.create");
    expect(parsed.payload.country).toEqual(country());
    expect(parsed.payload.initialPresentation).toBeUndefined();
  });

  it("accepts and preserves optional initial presentation", () => {
    const input = command();
    input.payload = {
      ...input.payload,
      initialPresentation: {
        flagCode: "NP",
        region: "Initial Region",
        center: [3, 2] as [number, number],
        defaultZoom: 5,
        labelRank: 2,
      },
    };

    expect(parseCountryCreateCommand(input, state()).payload.initialPresentation).toEqual(
      input.payload.initialPresentation,
    );
  });

  it("rejects an existing id without changing or overwriting the current state", () => {
    const existing = country("EXISTING");
    const current = state(existing);
    const countriesBefore = current.countriesById;
    const entityBefore = current.countriesById.EXISTING;

    expect(() => parseCountryCreateCommand(command(country("EXISTING")), current)).toThrow(
      /already exists/i,
    );
    expect(current.countriesById).toBe(countriesBefore);
    expect(current.countriesById.EXISTING).toBe(entityBefore);
    expect(current.countriesById.EXISTING).toEqual(existing);
  });

  it.each([
    ["empty polygon", {type: "Polygon", coordinates: []}],
    ["open ring", {type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2]]]}],
    ["non-finite coordinate", {type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, Number.NaN], [0, 0]]]}],
    ["zero-area ring", {type: "Polygon", coordinates: [[[0, 0], [1, 0], [2, 0], [0, 0]]]}],
    ["unsupported geometry", {type: "LineString", coordinates: [[0, 0], [1, 1]]}],
  ])("rejects malformed geometry: %s", (_name, geometry) => {
    const invalid = {...country(), geometry};
    expect(safeParseCountryCreateCommand(command(invalid as CountryEntity), state()).success).toBe(
      false,
    );
  });

  it.each(["shortKo", "officialKo", "mapKo", "english"] as const)(
    "rejects an empty %s name",
    (nameField) => {
      const valid = country();
      const invalid = {
        ...valid,
        names: {...valid.names, [nameField]: "   "},
      };

      expect(safeParseCountryCreateCommand(command(invalid), state()).success).toBe(false);
    },
  );

  it("rejects an unsupported unitType even when TypeScript is bypassed", () => {
    const invalid = {
      ...country(),
      unitType: "empire",
    } as unknown as CountryEntity;

    expect(safeParseCountryCreateCommand(command(invalid), state()).success).toBe(false);
  });

  it("requires the complete entity and rejects unknown payload fields", () => {
    const missingMapColor = {...country()} as Partial<CountryEntity>;
    delete missingMapColor.mapColor;

    expect(countryCreateCommandSchema.safeParse(command(missingMapColor as CountryEntity)).success).toBe(
      false,
    );
    expect(
      countryCreateCommandSchema.safeParse({
        ...command(),
        payload: {...command().payload, overwrite: true},
      }).success,
    ).toBe(false);
  });

  it("exposes collision failure through the context-aware safe parser", () => {
    const existing = country("EXISTING");
    const result = safeParseCountryCreateCommand(command(existing), state(existing));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["payload", "country", "id"]);
    }
  });
});
