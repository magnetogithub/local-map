import {describe, expect, expectTypeOf, it} from "vitest";

import {deriveTerritoryId} from "./territory-id";
import {
  createTopologyState,
  type TopologyEdge,
  type TopologyState,
} from "./topology-state";

const territory = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "v1", sourceFeatureId});

describe("10-17 TopologyState", () => {
  const ALPHA = territory("alpha");
  const BETA = territory("beta");
  const [FIRST, SECOND] = [ALPHA, BETA].sort();
  const internalEdge = {
    id: "topology-edge:alpha-beta",
    territoryIds: [FIRST, SECOND],
    classification: "internal",
    coordinates: [
      [1, 0],
      [1, 1],
    ],
  };

  it("stores each canonical edge once and derives symmetric neighbors", () => {
    const topology = createTopologyState([
      internalEdge,
      {
        id: "topology-edge:alpha-coast",
        territoryIds: [ALPHA, null],
        classification: "coast",
        coordinates: [
          [0, 0],
          [0, 1],
        ],
      },
    ]);

    expect(Object.keys(topology.edgesById)).toHaveLength(2);
    expect(topology.neighborTerritoryIdsById[ALPHA]).toEqual([BETA]);
    expect(topology.neighborTerritoryIdsById[BETA]).toEqual([ALPHA]);
    expect(Object.isFrozen(topology)).toBe(true);
    expectTypeOf<keyof TopologyState>().toEqualTypeOf<
      "edgesById" | "neighborTerritoryIdsById"
    >();
  });

  it("keeps country ownership out of canonical edges", () => {
    expectTypeOf<keyof TopologyEdge>().not.toEqualTypeOf<"countryId" | "ownerCountryId">();
    expect(() => createTopologyState([{...internalEdge, ownerCountryId: "AAA"}])).toThrow(
      /unknown or missing/,
    );
  });

  it("rejects duplicate IDs and duplicate semantic edges", () => {
    expect(() => createTopologyState([internalEdge, internalEdge])).toThrowError(
      expect.objectContaining({code: "duplicate-topology-edge"}),
    );
    expect(() =>
      createTopologyState([
        internalEdge,
        {...internalEdge, id: "topology-edge:duplicate-alpha-beta"},
      ]),
    ).toThrowError(expect.objectContaining({code: "duplicate-topology-edge"}));
  });

  it("rejects the same semantic edge when its coordinate direction is reversed", () => {
    expect(() =>
      createTopologyState([
        internalEdge,
        {
          ...internalEdge,
          id: "topology-edge:reverse-alpha-beta",
          coordinates: [...internalEdge.coordinates].reverse(),
        },
      ]),
    ).toThrowError(expect.objectContaining({code: "duplicate-topology-edge"}));
  });

  it("deep-copies edge coordinate input", () => {
    const coordinates = [[1, 0], [1, 1]];
    const topology = createTopologyState([{...internalEdge, coordinates}]);

    coordinates[0][0] = 99;

    expect(topology.edgesById[internalEdge.id].coordinates[0]).toEqual([1, 0]);
  });

  it("rejects reverse-owned internal edges instead of storing both directions", () => {
    expect(() =>
      createTopologyState([
        {...internalEdge, territoryIds: [SECOND, FIRST]},
      ]),
    ).toThrowError(expect.objectContaining({code: "noncanonical-topology-edge"}));
  });

  it("enforces coast/internal side classification", () => {
    expect(() =>
      createTopologyState([
        {...internalEdge, classification: "coast"},
      ]),
    ).toThrow(/coast.*null/);
    expect(() =>
      createTopologyState([
        {...internalEdge, territoryIds: [ALPHA, null]},
      ]),
    ).toThrow(/internal.*two/);
  });
});
