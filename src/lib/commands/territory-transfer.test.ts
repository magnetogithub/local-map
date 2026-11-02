import {describe, expect, it} from "vitest";

import type {PolygonGeometry} from "@/lib/map/country-label-layout";
import {
  WORLD_STATE_SCHEMA_VERSION,
  type CountryEntity,
  type WorldState,
} from "@/lib/test-only/legacy-v1/world-state";

import {
  MAX_TRANSFER_AREA_TOLERANCE,
  applyTerritoryTransferCommand,
  planTerritoryTransfer,
  polygonGeometryArea,
  safeParseTerritoryTransferCommand,
  territoryTransferCommandSchema,
  type TerritoryTransferCommand,
} from "@/lib/test-only/legacy-v1/territory-transfer";

const rectangle = (left: number, bottom: number, right: number, top: number): PolygonGeometry => ({
  type: "Polygon",
  coordinates: [[[left, bottom], [right, bottom], [right, top], [left, top], [left, bottom]]],
});

const country = (id: string, geometry: PolygonGeometry): CountryEntity => ({
  id,
  iso3: id,
  names: {
    shortKo: id,
    officialKo: id,
    mapKo: id,
    english: id,
    searchAliases: [id],
  },
  geometry,
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

const state = (fromGeometry = rectangle(0, 0, 10, 10), toGeometry = rectangle(10, 0, 20, 10)): WorldState => ({
  schemaVersion: WORLD_STATE_SCHEMA_VERSION,
  revision: 6,
  countriesById: {
    FROM: country("FROM", fromGeometry),
    TO: country("TO", toGeometry),
    OTHER: country("OTHER", rectangle(30, 0, 35, 5)),
  },
  countryOrder: ["FROM", "TO", "OTHER"],
});

const command = (transferGeometry: unknown, from = "FROM", to = "TO") => ({
  commandId: "transfer-territory",
  type: "territory.transfer",
  expectedRevision: 6,
  payload: {
    from,
    to,
    transferGeometry,
    policy: {operation: "difference-union", areaTolerance: 1e-9},
  },
  issuedAt: "2026-08-31T09:00:00+09:00",
  source: "unit-test",
});

describe("9-14 territory.transfer schema", () => {
  it("plans difference from source and union into target without area loss or duplication", () => {
    const plan = planTerritoryTransfer(state(), command(rectangle(8, 0, 10, 10)));

    expect(plan.fromGeometry).toEqual(rectangle(0, 0, 8, 10));
    expect(plan.toGeometry).toEqual(rectangle(8, 0, 20, 10));
    expect(plan.measurements).toMatchObject({
      transferArea: 20,
      sourceOverlapArea: 20,
      transferOutsideSourceArea: 0,
      targetCollisionArea: 0,
      sourceRemovedArea: 20,
      targetAddedArea: 20,
      totalAreaError: 0,
      sourceRemovalError: 0,
      targetAdditionError: 0,
    });
  });

  it("applies both geometry updates atomically with one revision increment", () => {
    const current = state();
    const otherBefore = current.countriesById.OTHER;
    const fromNamesBefore = current.countriesById.FROM.names;
    const toNamesBefore = current.countriesById.TO.names;
    const next = applyTerritoryTransferCommand(current, command(rectangle(8, 0, 10, 10)));

    expect(next.revision).toBe(current.revision + 1);
    expect(next.countriesById.FROM.geometry).toEqual(rectangle(0, 0, 8, 10));
    expect(next.countriesById.TO.geometry).toEqual(rectangle(8, 0, 20, 10));
    expect(next.countriesById.FROM.names).toBe(fromNamesBefore);
    expect(next.countriesById.TO.names).toBe(toNamesBefore);
    expect(next.countriesById.OTHER).toBe(otherBefore);
    expect(next.countryOrder).toBe(current.countryOrder);
  });

  it("produces deterministic plans for equivalent transfer winding and starts", () => {
    const forward = rectangle(8, 0, 10, 10);
    const reversed = {
      type: "Polygon",
      coordinates: [[[10, 10], [10, 0], [8, 0], [8, 10], [10, 10]]],
    };

    const first = planTerritoryTransfer(state(), command(forward));
    const second = planTerritoryTransfer(state(), command(reversed));
    expect(second.fromGeometry).toEqual(first.fromGeometry);
    expect(second.toGeometry).toEqual(first.toGeometry);
    expect(second.measurements).toEqual(first.measurements);
  });

  it("rejects transfer geometry that does not overlap the source", () => {
    expect(
      safeParseTerritoryTransferCommand(command(rectangle(21, 0, 22, 2)), state()).success,
    ).toBe(false);
  });

  it("rejects transfer geometry extending outside the source beyond tolerance", () => {
    expect(
      safeParseTerritoryTransferCommand(command(rectangle(9, 0, 11, 10)), state()).success,
    ).toBe(false);
  });

  it("rejects transfer geometry that collides with the target", () => {
    const current = state(rectangle(0, 0, 10, 10), rectangle(4, 4, 6, 6));
    expect(
      safeParseTerritoryTransferCommand(command(rectangle(4, 4, 6, 6)), current).success,
    ).toBe(false);
  });

  it("rejects a transfer that would leave the source with empty geometry", () => {
    expect(
      safeParseTerritoryTransferCommand(command(rectangle(0, 0, 10, 10)), state()).success,
    ).toBe(false);
  });

  it("rejects identical source and target ids", () => {
    expect(
      safeParseTerritoryTransferCommand(command(rectangle(8, 0, 10, 10), "FROM", "FROM"), state())
        .success,
    ).toBe(false);
  });

  it.each([
    ["missing source", "MISSING", "TO"],
    ["missing target", "FROM", "MISSING"],
  ])("rejects %s", (_name, from, to) => {
    expect(
      safeParseTerritoryTransferCommand(command(rectangle(8, 0, 10, 10), from, to), state())
        .success,
    ).toBe(false);
  });

  it.each([
    ["unsupported operation", {operation: "copy-union", areaTolerance: 1e-9}],
    ["zero tolerance", {operation: "difference-union", areaTolerance: 0}],
    [
      "excessive tolerance",
      {operation: "difference-union", areaTolerance: MAX_TRANSFER_AREA_TOLERANCE * 2},
    ],
  ])("rejects invalid boolean-operation policy: %s", (_name, policy) => {
    const input = command(rectangle(8, 0, 10, 10));
    expect(
      territoryTransferCommandSchema.safeParse({
        ...input,
        payload: {...input.payload, policy},
      }).success,
    ).toBe(false);
  });

  it("rejects malformed transfer geometry and unknown payload fields", () => {
    const malformed = {type: "Polygon", coordinates: []};
    expect(territoryTransferCommandSchema.safeParse(command(malformed)).success).toBe(false);
    const input = command(rectangle(8, 0, 10, 10));
    expect(
      territoryTransferCommandSchema.safeParse({
        ...input,
        payload: {...input.payload, copy: true},
      }).success,
    ).toBe(false);
  });

  it("reports conserved total source and target area within policy tolerance", () => {
    const current = state();
    const plan = planTerritoryTransfer(current, command(rectangle(8, 0, 10, 10)));
    const before =
      polygonGeometryArea(current.countriesById.FROM.geometry) +
      polygonGeometryArea(current.countriesById.TO.geometry);
    const after = polygonGeometryArea(plan.fromGeometry) + polygonGeometryArea(plan.toGeometry);

    expect(Math.abs(before - after)).toBeLessThanOrEqual(plan.command.payload.policy.areaTolerance);
  });

  it("revalidates cast input before applying a transfer", () => {
    const invalid = command(rectangle(21, 0, 22, 2)) as unknown as TerritoryTransferCommand;

    expect(() => applyTerritoryTransferCommand(state(), invalid)).toThrow();
  });
});
