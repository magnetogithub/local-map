import {describe, expect, it} from "vitest";

import {deriveTerritoryId, type TerritoryId} from "./territory-id";
import {
  createTerritoryOrder,
  mergeTerritoryOrder,
  partitionTerritoryOrder,
} from "./territory-order";

const seed = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "v1", sourceFeatureId});

describe("10-15 deterministic territoryOrder", () => {
  it("rejects prefix-only and malformed encoded TerritoryIds", () => {
    expect(() => createTerritoryOrder(["territory:unknown:1:x" as TerritoryId])).toThrowError(
      expect.objectContaining({code: "invalid-territory-order-id"}),
    );
    expect(() =>
      createTerritoryOrder(["territory:seed:2:x1:y" as TerritoryId]),
    ).toThrowError(expect.objectContaining({code: "invalid-territory-order-id"}));
  });

  const ALPHA = seed("alpha");
  const BETA = seed("beta");
  const GAMMA = seed("gamma");

  it("does not depend on geometry feature input order", () => {
    const features = [
      {id: GAMMA, geometry: {type: "Polygon"}},
      {id: ALPHA, geometry: {type: "Polygon"}},
      {id: BETA, geometry: {type: "MultiPolygon"}},
    ];

    expect(createTerritoryOrder(features.map(({id}) => id))).toEqual(
      createTerritoryOrder([...features].reverse().map(({id}) => id)),
    );
  });

  it("partitions deterministically regardless of result feature order", () => {
    const WEST = deriveTerritoryId({
      kind: "partition",
      sourceTerritoryId: ALPHA,
      partitionKey: "west",
    });
    const EAST = deriveTerritoryId({
      kind: "partition",
      sourceTerritoryId: ALPHA,
      partitionKey: "east",
    });
    const order = createTerritoryOrder([BETA, ALPHA]);

    const forward = partitionTerritoryOrder(order, ALPHA, [WEST, EAST]);
    const reverse = partitionTerritoryOrder(order, ALPHA, [EAST, WEST]);

    expect(forward).toEqual(reverse);
    expect(forward).toEqual(createTerritoryOrder([BETA, EAST, WEST]));
    expect(Object.isFrozen(forward)).toBe(true);
  });

  it("merges deterministically regardless of source order", () => {
    const merged = seed("alpha-beta-merged");
    const order = createTerritoryOrder([GAMMA, ALPHA, BETA]);

    expect(mergeTerritoryOrder(order, [ALPHA, BETA], merged)).toEqual(
      mergeTerritoryOrder(order, [BETA, ALPHA], merged),
    );
    expect(mergeTerritoryOrder(order, [ALPHA, BETA], merged)).toEqual(
      createTerritoryOrder([GAMMA, merged]),
    );
  });

  it("allows a merge to retain one source TerritoryId deterministically", () => {
    expect(mergeTerritoryOrder(createTerritoryOrder([ALPHA, BETA]), [BETA, ALPHA], ALPHA)).toEqual([
      ALPHA,
    ]);
  });

  it("rejects missing sources, duplicate outputs, and unrelated ID collisions", () => {
    const order = createTerritoryOrder([ALPHA, BETA, GAMMA]);
    const child = deriveTerritoryId({
      kind: "partition",
      sourceTerritoryId: ALPHA,
      partitionKey: "child",
    });

    expect(() => partitionTerritoryOrder(order, seed("missing"), [child, seed("other")])).toThrow(
      /missing source/,
    );
    expect(() => partitionTerritoryOrder(order, ALPHA, [child, child])).toThrowError(
      expect.objectContaining({code: "duplicate-territory-order-id"}),
    );
    expect(() => partitionTerritoryOrder(order, ALPHA, [child, BETA])).toThrowError(
      expect.objectContaining({code: "territory-order-id-collision"}),
    );
    expect(() => mergeTerritoryOrder(order, [ALPHA, BETA], GAMMA)).toThrowError(
      expect.objectContaining({code: "territory-order-id-collision"}),
    );
  });
});
