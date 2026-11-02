import {describe, expect, it} from "vitest";

import {
  initializeIncrementalTopology,
  recalculateTopologyIncrementally,
} from "./incremental-topology";
import {createTerritoryEntity, type TerritoryEntity} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";

const rectangle = (name: string, minX: number, maxX: number) => createTerritoryEntity({
  id: deriveTerritoryId({kind: "seed", seedVersion: "direct-access-v1", sourceFeatureId: name}),
  ownerCountryId: null,
  geometry: {type: "Polygon", coordinates: [[
    [minX, 0], [maxX, 0], [maxX, 1], [minX, 1], [minX, 0],
  ]]},
  properties: {},
});

const measuredTerritory = (
  territory: TerritoryEntity,
  onRead: () => void,
): TerritoryEntity => ({
  id: territory.id,
  ownerCountryId: territory.ownerCountryId,
  get geometry() {
    onRead();
    return territory.geometry;
  },
  properties: territory.properties,
});

describe("10-54 direct geometry access boundary", () => {
  it("reads exactly changed A and direct B, never non-direct C", () => {
    const a = rectangle("a", 0, 1);
    const b = rectangle("b", 1, 2);
    const c = rectangle("c", 2, 3);
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b, [c.id]: c});
    const reads = new Map<string, number>();
    const measured = (territory: TerritoryEntity) => measuredTerritory(territory, () =>
      reads.set(territory.id, (reads.get(territory.id) ?? 0) + 1)
    );
    const result = recalculateTopologyIncrementally(
      before.topology,
      before.bboxIndex,
      {
        [a.id]: measured(rectangle("a", -0.25, 0.75)),
        [b.id]: measured(b),
        [c.id]: measuredTerritory(c, () => {
          throw new Error("non-direct C geometry was read");
        }),
      },
      [a.id],
    );

    expect(result.recomputedTerritoryIds).toEqual([a.id, b.id].sort());
    expect([...reads.keys()].sort()).toEqual(result.recomputedTerritoryIds);
    expect(reads.get(a.id)).toBeGreaterThan(0);
    expect(reads.get(b.id)).toBeGreaterThan(0);
  });

  it("does not read C-D-E in a long chain", () => {
    const values = ["a", "b", "c", "d", "e"].map((name, index) =>
      rectangle(name, index, index + 1)
    );
    const [a, b, c, d, e] = values;
    const before = initializeIncrementalTopology(Object.fromEntries(values.map((value) => [value.id, value])));
    const forbiddenReads = new Map<string, number>();
    const forbidden = (territory: TerritoryEntity) => measuredTerritory(territory, () =>
      forbiddenReads.set(territory.id, (forbiddenReads.get(territory.id) ?? 0) + 1)
    );
    const result = recalculateTopologyIncrementally(
      before.topology,
      before.bboxIndex,
      {
        [a.id]: rectangle("a", -0.1, 0.9),
        [b.id]: b,
        [c.id]: forbidden(c),
        [d.id]: forbidden(d),
        [e.id]: forbidden(e),
      },
      [a.id],
    );

    expect(result.recomputedTerritoryIds).toEqual([a.id, b.id].sort());
    expect([...forbiddenReads.values()].reduce((sum, count) => sum + count, 0)).toBe(0);
  });

  it("keeps non-direct getters isolated for deletion and creation", () => {
    const a = rectangle("a", 0, 1);
    const b = rectangle("b", 1, 2);
    const c = rectangle("c", 2, 3);
    const before = initializeIncrementalTopology({[a.id]: a, [b.id]: b, [c.id]: c});
    const throwingC = measuredTerritory(c, () => {
      throw new Error("C geometry must remain isolated");
    });
    const deleted = recalculateTopologyIncrementally(
      before.topology,
      before.bboxIndex,
      {[b.id]: b, [c.id]: throwingC},
      [a.id],
    );
    const newA = rectangle("new-a", 0, 1);
    const withoutA = initializeIncrementalTopology({[b.id]: b, [c.id]: c});
    const created = recalculateTopologyIncrementally(
      withoutA.topology,
      withoutA.bboxIndex,
      {[newA.id]: newA, [b.id]: b, [c.id]: throwingC},
      [newA.id],
    );

    expect(deleted.recomputedTerritoryIds).toEqual([a.id, b.id].sort());
    expect(created.recomputedTerritoryIds).toEqual([newA.id, b.id].sort());
  });

  it("performs zero geometry reads and preserves references for empty changes", () => {
    const a = rectangle("a", 0, 1);
    const before = initializeIncrementalTopology({[a.id]: a});
    const guarded = measuredTerritory(a, () => {
      throw new Error("empty changes must not read geometry");
    });
    const result = recalculateTopologyIncrementally(
      before.topology,
      before.bboxIndex,
      {[a.id]: guarded},
      [],
    );

    expect(result.topology).toBe(before.topology);
    expect(result.bboxIndex).toBe(before.bboxIndex);
    expect(result.recomputedTerritoryIds).toEqual([]);
  });
});
