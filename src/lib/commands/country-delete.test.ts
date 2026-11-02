import {describe, expect, it} from "vitest";

import {
  WORLD_STATE_SCHEMA_VERSION,
  type CountryEntity,
  type WorldState,
} from "@/lib/test-only/legacy-v1/world-state";

import {
  countryDeleteCommandSchema,
  parseCountryDeleteCommand,
  safeParseCountryDeleteCommand,
  type CountryDeleteCommand,
} from "@/lib/test-only/legacy-v1/country-delete";

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

const state = (...countries: CountryEntity[]): WorldState => ({
  schemaVersion: WORLD_STATE_SCHEMA_VERSION,
  revision: 3,
  countriesById: Object.fromEntries(countries.map((entity) => [entity.id, entity])),
  countryOrder: countries.map((entity) => entity.id),
});

const command = (
  countryId: string,
  ifLastCountry: "reject" | "allow-empty-world" = "reject",
): CountryDeleteCommand => ({
  commandId: `delete-${countryId}`,
  type: "country.delete",
  expectedRevision: 3,
  payload: {
    countryId,
    policy: {ifMissing: "reject", ifLastCountry},
  },
  issuedAt: "2026-08-31T09:00:00+09:00",
  source: "unit-test",
});

describe("9-11 country.delete schema", () => {
  it("accepts deletion of an existing country when another country remains", () => {
    const input = command("AAA");
    const parsed = parseCountryDeleteCommand(input, state(country("AAA"), country("BBB")));

    expect(parsed).toEqual(input);
    expect(parsed.payload.policy).toEqual({
      ifMissing: "reject",
      ifLastCountry: "reject",
    });
  });

  it.each(["reject", "allow-empty-world"] as const)(
    "rejects an unknown country instead of silently succeeding with %s last-country policy",
    (ifLastCountry) => {
      const current = state(country("AAA"));
      const countriesBefore = current.countriesById;
      const orderBefore = current.countryOrder;

      expect(() => parseCountryDeleteCommand(command("MISSING", ifLastCountry), current)).toThrow(
        /does not exist/i,
      );
      expect(current.countriesById).toBe(countriesBefore);
      expect(current.countryOrder).toBe(orderBefore);
    },
  );

  it("rejects deleting the last country under the reject policy", () => {
    const result = safeParseCountryDeleteCommand(command("ONLY"), state(country("ONLY")));

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual([
        "payload",
        "policy",
        "ifLastCountry",
      ]);
    }
  });

  it("allows deleting the last country only under the explicit allow-empty-world policy", () => {
    const input = command("ONLY", "allow-empty-world");

    expect(parseCountryDeleteCommand(input, state(country("ONLY")))).toEqual(input);
  });

  it("requires an explicit deletion policy", () => {
    const input = command("AAA") as unknown as {
      payload: {countryId: string; policy?: unknown};
    };
    delete input.payload.policy;

    expect(countryDeleteCommandSchema.safeParse(input).success).toBe(false);
  });

  it.each([
    ["silent missing-country success", {ifMissing: "ignore", ifLastCountry: "reject"}],
    ["implicit last-country behavior", {ifMissing: "reject", ifLastCountry: "default"}],
  ])("rejects unsupported policy: %s", (_name, policy) => {
    const input = command("AAA");
    expect(
      countryDeleteCommandSchema.safeParse({
        ...input,
        payload: {...input.payload, policy},
      }).success,
    ).toBe(false);
  });

  it("rejects a blank countryId", () => {
    expect(countryDeleteCommandSchema.safeParse(command("   ")).success).toBe(false);
  });

  it("rejects unknown payload fields", () => {
    const input = command("AAA");
    expect(
      countryDeleteCommandSchema.safeParse({
        ...input,
        payload: {...input.payload, silently: true},
      }).success,
    ).toBe(false);
  });

  it("rejects a non-delete command type", () => {
    expect(
      countryDeleteCommandSchema.safeParse({...command("AAA"), type: "country.create"}).success,
    ).toBe(false);
  });
});
