import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

import {createCountryEntity} from "../world/country-entity";
import type {ActiveCountryId} from "../world/country-id";
import {createTopologyState} from "../world/topology-state";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import {
  applyGlyphResult,
  countSettledLabelProblems,
  createLabelCache,
  createLabelProjection,
  isStaleLabelResult,
  readOrComputeGlyph,
  runPureGlyphWorker,
  serializeLabelProjection,
  deserializeLabelProjection,
} from "./label-projection-checkpoint";
import {labelRuntimeCacheKeys,projectLabelMapSources,shouldApplyLabelMapSources,type LabelSeedCache} from "./country-label-runtime-projection";

const activeCountryId = (countryId: "AAA" | "BBB") => countryId as ActiveCountryId;

const rectangle = (x: number, width = 2): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[
    [x, 0],
    [x + width, 0],
    [x + width, 2],
    [x, 2],
    [x, 0],
  ]],
});

const country = (id: "AAA" | "BBB", mapKo: string = id) => createCountryEntity({
  id: activeCountryId(id),
  names: {
    shortKo: mapKo,
    officialKo: `${mapKo} Republic`,
    mapKo,
    english: `${id} Republic`,
    searchAliases: [id, mapKo],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const territory = (sourceFeatureId: string, ownerCountryId: "AAA" | "BBB", geometry: TerritoryGeometry) => {
  const id = deriveTerritoryId({
    kind: "seed",
    seedVersion: "10-106-test",
    sourceFeatureId,
  });
  return createTerritoryEntity({
    id,
    ownerCountryId,
    geometry,
    properties: {sourceFeatureId},
  });
};

const world = (
  revision: number,
  geometry = rectangle(0),
  mapKo = "알파",
): WorldStateV2 => {
  const alpha = territory("alpha", "AAA", geometry);
  const beta = territory("beta", "BBB", rectangle(4));
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "10-106-test",
    policyVersion: "world-policy-v1",
    revision,
    countriesById: {
      AAA: country("AAA", mapKo),
      BBB: country("BBB", "베타"),
    },
    countryOrder: [activeCountryId("AAA"), activeCountryId("BBB")],
    retiredCountryIds: [],
    territoriesById: {[alpha.id]: alpha, [beta.id]: beta},
    territoryOrder: [alpha.id, beta.id],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: null,
      presentationRootHash: null,
      territoriesRootHash: null,
      topologyRootHash: null,
    },
  });
};

describe("10-100~10-106 label projection checkpoint", () => {
  it("reuses geometry and text hashes for structurally shared territories",()=>{
    const beforeState=world(40);
    const before=createLabelProjection(beforeState);
    const afterState=Object.freeze({...beforeState,revision:41}) as WorldStateV2;
    const after=createLabelProjection(afterState,{}, {state:beforeState,projection:before});

    expect(after.jobs[0].hashes).toBe(before.jobs[0].hashes);
    expect(after.jobs[1].hashes).toBe(before.jobs[1].hashes);
    expect(after.jobs.every(job=>job.revision===41)).toBe(true);
  });

  it("creates representative point labels from Territory geometry without manual coordinate tables", () => {
    const projection = createLabelProjection(world(40));
    const alphaJob = projection.jobs.find(({countryId}) => countryId === "AAA");

    expect(alphaJob?.anchor).toEqual([1, 1]);
    expect(alphaJob?.hashes.territoryGeometryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(alphaJob?.hashes.textHash).toMatch(/^[a-f0-9]{64}$/);
    expect([...projection.pointFallbacksByLabelId.values()]
      .every(({geometry}) => geometry.type === "Point")).toBe(true);
  });

  it("defines stale-resistant jobs using revision and module hashes, not countryId alone", () => {
    const before = createLabelProjection(world(40));
    const renamed = createLabelProjection(world(41, rectangle(0), "알파-개명"));
    const beforeJob = before.jobs.find(({countryId}) => countryId === "AAA")!;
    const renamedJob = renamed.jobs.find(({countryId}) => countryId === "AAA")!;
    const staleResult = runPureGlyphWorker(beforeJob);

    expect(beforeJob.countryId).toBe(renamedJob.countryId);
    expect(beforeJob.hashes.textHash).not.toBe(renamedJob.hashes.textHash);
    expect(isStaleLabelResult(renamed, staleResult)).toBe(true);
  });

  it("keeps the pure glyph worker free of DOM and MapLibre imports", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/lib/projection/label-projection-checkpoint.ts"),
      "utf8",
    );

    expect(source).not.toContain("maplibre-gl");
    expect(source).not.toContain("document.");
    expect(source).not.toContain("window.");
  });

  it("caches by geometry, text, font, and policy hashes so only changed modules miss", () => {
    const projection = createLabelProjection(world(40));
    const alphaJob = projection.jobs.find(({countryId}) => countryId === "AAA")!;
    const betaJob = projection.jobs.find(({countryId}) => countryId === "BBB")!;
    const first = readOrComputeGlyph(createLabelCache(), alphaJob);
    const second = readOrComputeGlyph(first.cache, alphaJob);
    const third = readOrComputeGlyph(second.cache, betaJob);

    expect(first.cache.misses).toBe(1);
    expect(second.cache.hits).toBe(1);
    expect(third.cache.misses).toBe(2);
  });

  it("uses viewport and selection priority without making settled output order-dependent", () => {
    const selected = createLabelProjection(world(40), {
      selectedCountryId: activeCountryId("BBB"),
      viewportCenter: [4, 1],
    });
    const reversedResults = [...selected.jobs].reverse().map(runPureGlyphWorker);
    const settled = reversedResults.reduce(applyGlyphResult, selected);

    expect(selected.jobs[0].countryId).toBe("BBB");
    expect(settled.settled).toBe(true);
    expect([...settled.glyphsByLabelId.keys()].sort())
      .toEqual(selected.jobs.map(({jobId}) => jobId).sort());
    expect(countSettledLabelProblems(settled)).toBe(0);
  });

  it("discards stale split-to-undo style results and replaces point fallback with glyph atomically", () => {
    const original = createLabelProjection(world(40));
    const split = createLabelProjection(world(41, rectangle(0, 3)));
    const undone = createLabelProjection(world(42));
    const staleSplitResult = runPureGlyphWorker(split.jobs.find(({countryId}) => countryId === "AAA")!);
    const acceptedResult = runPureGlyphWorker(undone.jobs.find(({countryId}) => countryId === "AAA")!);

    expect(applyGlyphResult(undone, staleSplitResult)).toBe(undone);
    const updated = applyGlyphResult(undone, acceptedResult);

    expect(original.jobs.find(({countryId}) => countryId === "AAA")?.hashes.territoryGeometryHash)
      .toBe(undone.jobs.find(({countryId}) => countryId === "AAA")?.hashes.territoryGeometryHash);
    expect(updated.pointFallbacksByLabelId.has(acceptedResult.jobId)).toBe(false);
    expect(updated.glyphsByLabelId.has(acceptedResult.jobId)).toBe(true);
    expect([...updated.pointFallbacksByLabelId.keys()].filter((key) =>
      updated.glyphsByLabelId.has(key),
    )).toHaveLength(0);
  });
});

describe("11-9 label runtime projection", () => {
  const seed:LabelSeedCache={
    placements:{type:"FeatureCollection",features:[
      {type:"Feature",properties:{countryId:"AAA",mapLabelKo:"알파",placementMode:"small-country-point",minZoom:1,angle:70,fontSizeWorldUnits:1,targetTextWidthWorld:3,area:4},geometry:{type:"Point",coordinates:[1,1]}},
      {type:"Feature",properties:{countryId:"BBB",mapLabelKo:"베타",placementMode:"small-country-point",minZoom:1,angle:80,fontSizeWorldUnits:1.5,targetTextWidthWorld:4,area:4},geometry:{type:"Point",coordinates:[5,1]}},
    ]},
    fills:{type:"FeatureCollection",features:[
      {type:"Feature",properties:{countryId:"AAA",role:"fill"},geometry:{type:"Polygon",coordinates:[]}},
      {type:"Feature",properties:{countryId:"BBB",role:"fill"},geometry:{type:"Polygon",coordinates:[]}},
    ]},
    outlines:{type:"FeatureCollection",features:[]},
  };

  it("reuses a valid curved glyph seed without a point-label placement", () => {
    const initial=createLabelProjection(world(40));
    const glyphOnlySeed:LabelSeedCache={
      placements:{type:"FeatureCollection",features:[]},
      fills:{type:"FeatureCollection",features:[seed.fills.features[0]]},
      outlines:{type:"FeatureCollection",features:[]},
    };
    const sources=projectLabelMapSources(initial,initial,glyphOnlySeed);
    expect(sources.fills.features.map(feature=>feature.properties.countryId)).toEqual(["AAA"]);
    expect(sources.fills.features[0].properties.projectionRevision).toBe(40);
    expect(sources.placements.features.find(feature=>feature.properties.countryId==="AAA")).toBeUndefined();
  });

  it("keeps geometry cache keys on rename while replacing only text and glyph output", () => {
    const initial=createLabelProjection(world(40));
    const renamed=createLabelProjection(world(41,rectangle(0),"새 알파"));
    const before=initial.jobs.find(job=>job.countryId==="AAA")!;
    const after=renamed.jobs.find(job=>job.countryId==="AAA")!;
    const sources=projectLabelMapSources(renamed,initial,seed);
    expect(labelRuntimeCacheKeys(after).geometry).toBe(labelRuntimeCacheKeys(before).geometry);
    expect(labelRuntimeCacheKeys(after).text).not.toBe(labelRuntimeCacheKeys(before).text);
    expect(sources.placements.features.find(feature=>feature.properties.countryId==="AAA")?.properties.mapLabelKo).toBe("새 알파");
    expect(sources.placements.features.find(feature=>feature.properties.countryId==="AAA")?.geometry).toBe(seed.placements.features[0].geometry);
    expect(sources.fills.features.map(feature=>feature.properties.countryId)).toEqual(["BBB"]);
    expect(sources.appliedRevision).toBe(41);
  });

  it("invalidates geometry placement only when territory geometry changes", () => {
    const initial=createLabelProjection(world(40));
    const changed=createLabelProjection(world(41,rectangle(0,3)));
    const before=initial.jobs.find(job=>job.countryId==="AAA")!;
    const after=changed.jobs.find(job=>job.countryId==="AAA")!;
    const sources=projectLabelMapSources(changed,initial,seed);
    expect(labelRuntimeCacheKeys(after).geometry).not.toBe(labelRuntimeCacheKeys(before).geometry);
    expect(labelRuntimeCacheKeys(after).text).toBe(labelRuntimeCacheKeys(before).text);
    expect(sources.placements.features.find(feature=>feature.properties.countryId==="AAA")?.geometry.coordinates).toEqual(after.anchor);
    expect(sources.fills.features.map(feature=>feature.properties.countryId)).toEqual(["BBB"]);
  });

  it("centers and rotates a merged-country fallback from all source-country labels", () => {
    const beforeState=world(40);
    const before=createLabelProjection(beforeState);
    const territories=Object.fromEntries(beforeState.territoryOrder.map((territoryId) => {
      const current=beforeState.territoriesById[territoryId];
      return [territoryId,createTerritoryEntity({...current,ownerCountryId:activeCountryId("AAA")})];
    }));
    const afterState=createWorldStateV2({
      ...beforeState,
      revision:41,
      countriesById:{AAA:country("AAA","연합국")},
      countryOrder:[activeCountryId("AAA")],
      retiredCountryIds:new Set(["BBB" as never]),
      territoriesById:territories,
    });
    const after=createLabelProjection(afterState,{}, {state:beforeState,projection:before});
    const sources=projectLabelMapSources(after,before,seed);
    const merged=sources.placements.features.find(feature=>feature.properties.countryId==="AAA");

    expect(merged?.geometry.coordinates).toEqual([3,1]);
    expect(merged?.properties.angle).toBeCloseTo(75,5);
    expect(merged?.properties.fontSizeWorldUnits).toBe(1.5);
    expect(merged?.properties.mapLabelKo).toBe("연합국");
  });

  it("rejects stale worker results and stale rendered revisions", () => {
    const initial=createLabelProjection(world(40));
    const current=deserializeLabelProjection(serializeLabelProjection(createLabelProjection(world(41))));
    const stale=runPureGlyphWorker(initial.jobs[0]);
    expect(applyGlyphResult(current,stale)).toBe(current);
    const sources=projectLabelMapSources(current,initial,seed);
    expect(shouldApplyLabelMapSources(41,sources)).toBe(false);
    expect(shouldApplyLabelMapSources(40,sources)).toBe(true);
  });
});
