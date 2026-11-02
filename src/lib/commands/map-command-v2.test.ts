import {describe, expect, it} from "vitest";

import {
  mapCommandV2AuditMetadataSchema,
  mapCommandV2EnvelopeSchema,
  mapCommandV2PolicyReferenceSchema,
  parseMapCommandV2Envelope,
  safeParseMapCommandV2Envelope,
} from "./map-command-v2";

const command = () => ({
  commandId: "command-v2-1",
  type: "country.create",
  expectedRevision: 7,
  payload: {countryId: "AAA"},
});

describe("10-31 MapCommand v2 envelope", () => {
  it("parses exactly commandId, type, expectedRevision, and payload", () => {
    const parsed = parseMapCommandV2Envelope(command());

    expect(parsed).toEqual(command());
    expect(Object.keys(parsed).sort()).toEqual([
      "commandId",
      "expectedRevision",
      "payload",
      "type",
    ]);
  });

  it.each(["commandId", "type", "expectedRevision", "payload"])(
    "rejects a missing envelope field: %s",
    (field) => {
      expect(
        mapCommandV2EnvelopeSchema.safeParse(
          Object.fromEntries(Object.entries(command()).filter(([key]) => key !== field)),
        ).success,
      ).toBe(false);
    },
  );

  it("rejects unknown envelope fields including embedded audit and policy metadata", () => {
    for (const extra of [
      {issuedAt: "2026-09-01T00:00:00Z"},
      {source: "unit-test"},
      {auditMetadata: {source: "unit-test"}},
      {policyVersion: "geometry-v1"},
      {geometryPolicy: {coordinatePrecision: 6}},
    ]) {
      expect(safeParseMapCommandV2Envelope({...command(), ...extra}).success).toBe(false);
    }
  });

  it("reserves audit and geometry-policy fields outside the general payload", () => {
    for (const reservedField of [
      "issuedAt",
      "source",
      "auditMetadata",
      "policyVersion",
      "geometryPolicy",
    ]) {
      expect(
        safeParseMapCommandV2Envelope({
          ...command(),
          payload: {...command().payload, [reservedField]: "embedded"},
        }).success,
      ).toBe(false);
    }
  });

  it("validates audit metadata and policy references through separate schemas", () => {
    expect(
      mapCommandV2AuditMetadataSchema.parse({
        issuedAt: "2026-09-01T00:00:00Z",
        source: "unit-test",
      }),
    ).toEqual({issuedAt: "2026-09-01T00:00:00Z", source: "unit-test"});
    expect(mapCommandV2PolicyReferenceSchema.parse({policyVersion: "geometry-v1"})).toEqual({
      policyVersion: "geometry-v1",
    });
  });

  it.each(["", " ", " command"])("rejects a non-canonical commandId: %j", (commandId) => {
    expect(safeParseMapCommandV2Envelope({...command(), commandId}).success).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "7"])(
    "rejects an invalid expectedRevision: %j",
    (expectedRevision) => {
      expect(safeParseMapCommandV2Envelope({...command(), expectedRevision}).success).toBe(false);
    },
  );

  it("rejects an envelope whose required fields are entirely inherited", () => {
    const input = Object.create(command()) as ReturnType<typeof command>;
    const prototypeBefore = Object.getPrototypeOf(input);

    expect(Object.keys(input)).toHaveLength(0);
    expect(mapCommandV2EnvelopeSchema.safeParse(input).success).toBe(false);
    expect(() => parseMapCommandV2Envelope(input)).toThrow();
    expect(Object.getPrototypeOf(input)).toBe(prototypeBefore);
  });

  it("rejects an envelope that mixes own and inherited required fields", () => {
    const prototype = {
      expectedRevision: 0,
      payload: {countryId: "AAA"},
    };
    const input = Object.assign(Object.create(prototype), {
      commandId: "mixed-command",
      type: "country.delete",
    });

    expect(Object.keys(input).sort()).toEqual(["commandId", "type"]);
    expect(mapCommandV2EnvelopeSchema.safeParse(input).success).toBe(false);
  });

  it("rejects class instances and built-in exotic objects even with own command fields", () => {
    class CommandInstance {
      commandId = "class-command";
      type = "country.delete";
      expectedRevision = 0;
      payload = {countryId: "AAA"};
    }

    const exoticInputs = [
      new CommandInstance(),
      Object.assign(new Date(0), command()),
      Object.assign(new Map(), command()),
      Object.assign(new Set(), command()),
      Object.assign(new Uint8Array(0), command()),
    ];

    for (const input of exoticInputs) {
      expect(mapCommandV2EnvelopeSchema.safeParse(input).success).toBe(false);
    }
  });

  it("rejects accessors without executing their getters", () => {
    let commandIdGetterCalls = 0;
    const input = {
      type: "country.delete",
      expectedRevision: 0,
      payload: {countryId: "AAA"},
    } as Record<string, unknown>;
    Object.defineProperty(input, "commandId", {
      enumerable: true,
      get() {
        commandIdGetterCalls += 1;
        return "accessor-command";
      },
    });

    expect(mapCommandV2EnvelopeSchema.safeParse(input).success).toBe(false);
    expect(commandIdGetterCalls).toBe(0);
  });

  it("rejects symbol and non-enumerable fields", () => {
    const withSymbol = command() as ReturnType<typeof command> & {[key: symbol]: unknown};
    withSymbol[Symbol("hidden-command-data")] = true;
    expect(mapCommandV2EnvelopeSchema.safeParse(withSymbol).success).toBe(false);

    const withHiddenUnknown = command() as ReturnType<typeof command> & {hidden?: unknown};
    Object.defineProperty(withHiddenUnknown, "hidden", {value: true, enumerable: false});
    expect(mapCommandV2EnvelopeSchema.safeParse(withHiddenUnknown).success).toBe(false);

    const withHiddenRequired = {
      type: "country.delete",
      expectedRevision: 0,
      payload: {countryId: "AAA"},
    } as Record<string, unknown>;
    Object.defineProperty(withHiddenRequired, "commandId", {
      value: "hidden-required",
      enumerable: false,
    });
    expect(mapCommandV2EnvelopeSchema.safeParse(withHiddenRequired).success).toBe(false);
  });

  it("rejects circular data without mutating it", () => {
    const circular: {self?: unknown} = {};
    circular.self = circular;
    const input = {...command(), payload: {value: circular}};

    expect(mapCommandV2EnvelopeSchema.safeParse(input).success).toBe(false);
    expect(circular.self).toBe(circular);
  });

  it("accepts a null-prototype plain record under policy A", () => {
    const payload = Object.assign(Object.create(null), command().payload);
    const input = Object.assign(Object.create(null), {...command(), payload});

    expect(mapCommandV2EnvelopeSchema.safeParse(input).success).toBe(true);
  });
});
