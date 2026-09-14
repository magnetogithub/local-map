import {describe, expect, expectTypeOf, it} from "vitest";

import type {ActiveCountryId} from "./country-id";
import {
  createTerritoryIdRegistry,
  deriveTerritoryId,
  issueTerritoryId,
  type TerritoryId,
} from "./territory-id";

describe("10-10 TerritoryId contract", () => {
  const seedInput = {
    kind: "seed" as const,
    seedVersion: "natural-earth-v1",
    sourceFeatureId: "feature-123",
  };

  it("derives the same TerritoryId from the same seed input", () => {
    const first = deriveTerritoryId(seedInput);
    const second = deriveTerritoryId({...seedInput});

    expect(first).toBe(second);
    expectTypeOf(first).toEqualTypeOf<TerritoryId>();
    expectTypeOf<TerritoryId>().not.toEqualTypeOf<ActiveCountryId>();
  });

  it("derives the same TerritoryId from the same partition input", () => {
    const sourceTerritoryId = deriveTerritoryId(seedInput);
    const input = {
      kind: "partition" as const,
      sourceTerritoryId,
      partitionKey: "west-of-canonical-edge-7",
    };

    expect(deriveTerritoryId(input)).toBe(deriveTerritoryId({...input}));
  });

  it("uses length-prefixed components to prevent delimiter collisions", () => {
    expect(
      deriveTerritoryId({kind: "seed", seedVersion: "a", sourceFeatureId: "b:c"}),
    ).not.toBe(
      deriveTerritoryId({kind: "seed", seedVersion: "a:b", sourceFeatureId: "c"}),
    );
  });

  it("keeps seed and partition namespaces distinct", () => {
    const sourceTerritoryId = deriveTerritoryId(seedInput);
    const partitionId = deriveTerritoryId({
      kind: "partition",
      sourceTerritoryId,
      partitionKey: "feature-123",
    });

    expect(partitionId).not.toBe(sourceTerritoryId);
  });

  it("rejects issuing an ID that already exists in the registry", () => {
    const territoryId = deriveTerritoryId(seedInput);
    const registry = createTerritoryIdRegistry({territoryIds: [territoryId]});

    expect(() => issueTerritoryId(seedInput, registry)).toThrowError(
      expect.objectContaining({code: "territory-id-collision"}),
    );
  });

  it("rejects duplicate registry IDs", () => {
    const territoryId = deriveTerritoryId(seedInput);

    expect(() =>
      createTerritoryIdRegistry({territoryIds: [territoryId, territoryId]}),
    ).toThrowError(expect.objectContaining({code: "duplicate-territory-id"}));
  });

  it.each([
    {kind: "seed", seedVersion: " ", sourceFeatureId: "feature-123"},
    {kind: "seed", seedVersion: "v1", sourceFeatureId: " feature-123"},
    {kind: "partition", sourceTerritoryId: "invalid", partitionKey: "west"},
    {
      kind: "partition",
      sourceTerritoryId: "territory:seed:2:v11:x",
      partitionKey: "west ",
    },
  ])("rejects non-canonical derivation input %#", (input) => {
    expect(() => deriveTerritoryId(input)).toThrowError(
      expect.objectContaining({code: "invalid-territory-id"}),
    );
  });

  it.each([
    "territory:seed:2:v1",
    "territory:seed:x:v12:id",
    "territory:seed:2:v12:idtrailing",
    "territory:unknown:2:v12:id",
    "territory:partition:1:x1:y",
  ])("rejects a malformed canonical TerritoryId: %s", (territoryId) => {
    expect(() => createTerritoryIdRegistry({territoryIds: [territoryId]})).toThrowError(
      expect.objectContaining({code: "invalid-territory-id"}),
    );
  });

  it("does not expose mutable registry storage that can bypass collision checks", () => {
    const territoryId = deriveTerritoryId(seedInput);
    const registry = createTerritoryIdRegistry({territoryIds: [territoryId]});
    const mutation = registry.territoryIds as unknown as {
      delete?: (value: TerritoryId) => boolean;
      clear?: () => void;
    };

    mutation.delete?.(territoryId);
    mutation.clear?.();

    expect("add" in registry.territoryIds).toBe(false);
    expect("delete" in registry.territoryIds).toBe(false);
    expect(() => issueTerritoryId(seedInput, registry)).toThrowError(
      expect.objectContaining({code: "territory-id-collision"}),
    );
  });

  it("copies the registry source iterable", () => {
    const territoryId = deriveTerritoryId(seedInput);
    const source = new Set([territoryId]);
    const registry = createTerritoryIdRegistry({territoryIds: source});

    source.clear();

    expect([...registry.territoryIds]).toEqual([territoryId]);
  });
});
