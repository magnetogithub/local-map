import {describe, expect, it} from "vitest";

import {createTerritoryEntity} from "./territory-entity";
import {deriveTerritoryId} from "./territory-id";
import {
  createTerritoryBBoxIndex,
  queryTerritoryBBoxCandidates,
  updateTerritoryBBoxIndex,
} from "./territory-bbox-index";

const territory = (name: string, minX: number, maxX: number) => createTerritoryEntity({
  id: deriveTerritoryId({kind: "seed", seedVersion: "bbox-v1", sourceFeatureId: name}),
  ownerCountryId: null,
  geometry: {type: "Polygon", coordinates: [[
    [minX, 0], [maxX, 0], [maxX, 1], [minX, 1], [minX, 0],
  ]]},
  properties: {},
});

describe("10-47 Territory bbox index", () => {
  it("returns deterministic overlap candidates and only replaces changed bboxes", () => {
    const alpha = territory("alpha", 0, 1);
    const beta = territory("beta", 0.5, 1.5);
    const gamma = territory("gamma", 10, 11);
    const before = createTerritoryBBoxIndex({[alpha.id]: alpha, [beta.id]: beta, [gamma.id]: gamma});
    const movedAlpha = territory("alpha", 9.5, 10.5);
    const after = updateTerritoryBBoxIndex(
      before,
      {[alpha.id]: movedAlpha, [beta.id]: beta, [gamma.id]: gamma},
      [alpha.id],
    );

    expect(queryTerritoryBBoxCandidates(before, alpha.id)).toEqual([beta.id]);
    expect(queryTerritoryBBoxCandidates(after, alpha.id)).toEqual([gamma.id]);
    expect(after.bboxByTerritoryId[beta.id]).toBe(before.bboxByTerritoryId[beta.id]);
    expect(after.bboxByTerritoryId[gamma.id]).toBe(before.bboxByTerritoryId[gamma.id]);
  });
});
