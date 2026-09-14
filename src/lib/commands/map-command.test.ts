import {describe, expect, it} from "vitest";
import {
  mapCommandEnvelopeSchema,
  parseMapCommand,
  safeParseMapCommand,
  type MapCommand,
} from "./map-command";

const validCommand = () => ({
  commandId: "command-9-9",
  type: "country.rename",
  expectedRevision: 7,
  payload: {countryId: "USA", names: {mapKo: "미합중국"}},
  issuedAt: "2026-08-31T05:40:00.000Z",
  source: "test",
});

describe("9-9 MapCommand envelope schema", () => {
  it("parses the six-field envelope through the runtime schema", () => {
    const parsed = parseMapCommand(validCommand());

    expect(parsed).toEqual(validCommand());
    expect(Object.keys(parsed).sort()).toEqual([
      "commandId",
      "expectedRevision",
      "issuedAt",
      "payload",
      "source",
      "type",
    ]);
  });

  it("rejects unknown envelope fields", () => {
    expect(
      safeParseMapCommand({...validCommand(), unexpected: "must not be stripped"}).success,
    ).toBe(false);
  });

  it.each(["commandId", "type", "expectedRevision", "payload", "issuedAt", "source"])(
    "rejects a missing %s field",
    (field) => {
      const entries = Object.entries(validCommand()).filter(([key]) => key !== field);
      expect(mapCommandEnvelopeSchema.safeParse(Object.fromEntries(entries)).success).toBe(false);
    },
  );

  it.each(["", "   "])("rejects an empty command id: %j", (commandId) => {
    expect(safeParseMapCommand({...validCommand(), commandId}).success).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, "7"])(
    "rejects an invalid expectedRevision: %j",
    (expectedRevision) => {
      expect(safeParseMapCommand({...validCommand(), expectedRevision}).success).toBe(false);
    },
  );

  it("rejects invalid payload, timestamp, type, and source values", () => {
    expect(safeParseMapCommand({...validCommand(), payload: []}).success).toBe(false);
    expect(safeParseMapCommand({...validCommand(), issuedAt: "today"}).success).toBe(false);
    expect(safeParseMapCommand({...validCommand(), type: " "}).success).toBe(false);
    expect(safeParseMapCommand({...validCommand(), source: " "}).success).toBe(false);
  });

  it("does not trust a TypeScript cast without runtime validation", () => {
    const castOnly = {
      ...validCommand(),
      commandId: "",
      expectedRevision: -1,
    } as MapCommand;

    expect(() => parseMapCommand(castOnly)).toThrow();
  });
});
