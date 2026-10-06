import {describe, expect, expectTypeOf, it} from "vitest";
import {createWorldV3SyntheticFixture} from "../test-only/world-v3-synthetic-fixture";
import {migrateWorldStateV2ToV3} from "../test-only/world-v2-to-v3-migration";
import {
  createWorldStateV3, deserializeWorldStateV3, serializeWorldStateV3,
  worldStateV3ContentHash, type WorldStateV3,
} from "./world-state-v3";
import {createCountryEntityV3} from "./country-entity-v3";
import {createTerritoryEntityV3} from "./territory-entity-v3";
import {createWorldGeometryCatalogContract, createWorldGeometryCatalogRef, readCatalogTerritoryId} from "./world-geometry-catalog-ref";
import {canonicalStringify} from "./canonical-serializer";

const fixture = () => {
  const f = createWorldV3SyntheticFixture();
  const state = migrateWorldStateV2ToV3({legacyWorld: f.legacy, catalog: f.catalog,
    mapping: f.mapping, countryMapColors: f.countryMapColors,
    validateCanonicalCoverage: f.validateCanonicalCoverage});
  return {...f, state, serialized: serializeWorldStateV3(state)};
};

describe("14-3 strict WorldStateV3 contract", () => {
  it("owns mutable country/control state and only an immutable catalog ref", () => {
    const {state, catalog} = fixture();
    expectTypeOf<keyof WorldStateV3>().toEqualTypeOf<
      "schemaVersion" | "seedVersion" | "policyVersion" | "revision" | "countriesById" |
      "countryOrder" | "retiredCountryIds" | "territoriesById" | "territoryOrder" | "catalogRef"
    >();
    expect(state.schemaVersion).toBe(3);
    expect(state.catalogRef).toEqual(catalog.ref);
    expect(state.territoryOrder).toEqual(catalog.territoryOrder);
    for (const territory of Object.values(state.territoriesById)) {
      expect(Object.keys(territory).sort()).toEqual(["controllerCountryId", "id", "ownerCountryId", "sourceCountryId"]);
    }
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.countriesById.AAA.names.searchAliases)).toBe(true);
    expect(Object.isFrozen(state.territoriesById)).toBe(true);
    expect(Object.isFrozen(state.catalogRef)).toBe(true);
    expect("add" in state.retiredCountryIds).toBe(false);
  });

  it("round trips deterministically and snapshots do not retain caller objects", () => {
    const {state, catalog, serialized, targetIds} = fixture();
    const input = JSON.parse(JSON.stringify(serialized));
    const restored = deserializeWorldStateV3(input, catalog);
    input.countriesById.AAA.names.searchAliases.push("mutation");
    input.territoriesById[targetIds[0]].ownerCountryId = null;
    expect(canonicalStringify(serializeWorldStateV3(restored))).toBe(canonicalStringify(serialized));
    expect(worldStateV3ContentHash(restored)).toBe(worldStateV3ContentHash(state));
  });

  it.each([
    ["AAA", "AAA"], ["AAA", "BBB"], [null, "BBB"], [null, null],
  ])("accepts owner=%s controller=%s", (ownerCountryId, controllerCountryId) => {
    const {serialized, targetIds, catalog} = fixture();
    const id = targetIds[0];
    const state = deserializeWorldStateV3({...serialized, territoriesById: {...serialized.territoriesById,
      [id]: {...serialized.territoriesById[id], ownerCountryId, controllerCountryId}}}, catalog);
    expect(state.territoriesById[id]).toMatchObject({ownerCountryId, controllerCountryId});
  });

  it.each([
    ["AAA", null], ["OLD", "AAA"], ["AAA", "OLD"], ["ZZZ", "AAA"], [null, "ZZZ"],
  ])("rejects invalid owner=%s controller=%s", (ownerCountryId, controllerCountryId) => {
    const {serialized, targetIds, catalog} = fixture();
    const id = targetIds[0];
    expect(() => deserializeWorldStateV3({...serialized, retiredCountryIds: ["OLD"],
      territoriesById: {...serialized.territoriesById, [id]: {...serialized.territoriesById[id], ownerCountryId, controllerCountryId}}}, catalog)).toThrow();
  });

  it("keeps sourceCountryId after the source country retires", () => {
    const {serialized, targetIds, catalog} = fixture();
    const state = deserializeWorldStateV3({...serialized, countryOrder: ["BBB"],
      countriesById: {BBB: serialized.countriesById.BBB}, retiredCountryIds: ["AAA"],
      territoriesById: Object.fromEntries(targetIds.map(id => [id, {...serialized.territoriesById[id], ownerCountryId: "BBB", controllerCountryId: "BBB"}]))}, catalog);
    expect(state.territoriesById[targetIds[0]].sourceCountryId).toBe("AAA");
  });

  it.each(["#abcdef", "red", "#FFF", "#GGGGGG", " #ABCDEF", null, 0])("rejects noncanonical color %s", mapColor => {
    const {state} = fixture();
    expect(() => createCountryEntityV3({...state.countriesById.AAA, mapColor})).toThrow(/mapColor/);
  });

  it.each(["geometry", "properties", "bbox", "controllerCountryIds"])("rejects territory field %s", field => {
    const {state, targetIds} = fixture();
    expect(() => createTerritoryEntityV3({...state.territoriesById[targetIds[0]], [field]: null})).toThrow(/fields/);
  });

  it.each(["topology", "geometry", "hashRoots", "extra"])("rejects world field %s", field => {
    const {serialized, catalog} = fixture();
    expect(() => deserializeWorldStateV3({...serialized, [field]: null}, catalog)).toThrow(/fields/);
  });

  it.each(["countryOrder", "territoryOrder", "retiredCountryIds"] as const)("rejects unsorted and duplicate %s", field => {
    const {serialized, catalog} = fixture();
    const order = field === "retiredCountryIds" ? ["OLD", "RET"] : serialized[field];
    expect(() => deserializeWorldStateV3({...serialized, [field]: [...order].reverse()}, catalog)).toThrow(/sorted/);
    expect(() => deserializeWorldStateV3({...serialized, [field]: [order[0], order[0]]}, catalog)).toThrow(/duplicates/);
  });

  it("rejects country, territory and catalog record/order disagreement", () => {
    const {serialized, catalog, targetIds} = fixture();
    expect(() => deserializeWorldStateV3({...serialized, countriesById: {AAA: serialized.countriesById.AAA}}, catalog)).toThrow(/same IDs/);
    expect(() => deserializeWorldStateV3({...serialized, territoriesById: {}}, catalog)).toThrow(/same IDs/);
    expect(() => deserializeWorldStateV3({...serialized, territoryOrder: targetIds.slice(1)}, catalog)).toThrow(/entire catalog/);
    expect(() => createWorldGeometryCatalogContract({...catalog, territoriesById: {}})).toThrow(/same IDs/);
    expect(() => deserializeWorldStateV3({...serialized, countriesById: {...serialized.countriesById,
      AAA: {...serialized.countriesById.AAA, id: "BBB"}}}, catalog)).toThrow(/key/);
    expect(() => deserializeWorldStateV3({...serialized, territoriesById: {...serialized.territoriesById,
      [targetIds[0]]: {...serialized.territoriesById[targetIds[0]], id: targetIds[1]}}}, catalog)).toThrow(/key/);
    expect(() => createWorldGeometryCatalogContract({...catalog, territoriesById: {...catalog.territoriesById,
      [targetIds[0]]: {...catalog.territoriesById[targetIds[0]], id: targetIds[1]}}})).toThrow(/key/);
  });

  it("rejects missing fields, invalid versions/revisions and lifecycle conflicts", () => {
    const {serialized, catalog} = fixture();
    const {catalogRef, ...missing} = serialized;
    void catalogRef;
    expect(() => deserializeWorldStateV3(missing, catalog)).toThrow(/fields/);
    for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      expect(() => deserializeWorldStateV3({...serialized, revision}, catalog)).toThrow(/revision/);
    }
    for (const seedVersion of ["", " version", "한글", "a".repeat(129)]) {
      expect(() => deserializeWorldStateV3({...serialized, seedVersion}, catalog)).toThrow(/version/i);
    }
    expect(() => deserializeWorldStateV3({...serialized, schemaVersion: 2}, catalog)).toThrow(/schemaVersion/);
    expect(() => deserializeWorldStateV3({...serialized, retiredCountryIds: ["AAA"]}, catalog)).toThrow();
    expect(() => createWorldStateV3(serialized, catalog)).toThrow(/readonly set/);
    expect(() => deserializeWorldStateV3({...serialized, retiredCountryIds: new Set()}, catalog)).toThrow(/array/);
  });

  it("rejects prototype keys, inherited/accessor/symbol and nested module fields", () => {
    const {serialized, catalog, state} = fixture();
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() => deserializeWorldStateV3({...serialized,
        countriesById: JSON.parse(`{"${key}":{}}`)}, catalog)).toThrow(/forbidden/);
      expect(() => createCountryEntityV3({...state.countriesById.AAA,
        moduleVersions: JSON.parse(`{"${key}":1}`)})).toThrow(/forbidden/);
    }
    expect(() => deserializeWorldStateV3(Object.create(serialized), catalog)).toThrow(/plain object/);
    const getter = Object.defineProperty({...serialized}, "revision", {enumerable: true, get() {throw new Error("must not execute");}});
    expect(() => deserializeWorldStateV3(getter, catalog)).toThrow(/forbidden/);
    expect(() => deserializeWorldStateV3({...serialized, [Symbol("hidden")]: 1}, catalog)).toThrow(/symbol/);
    expect(() => createCountryEntityV3({...state.countriesById.AAA, names: {...state.countriesById.AAA.names, extra: "no"}})).toThrow(/fields/);
  });

  it("rejects hidden order fields, array accessors/holes and circular country modules", () => {
    const {serialized, catalog, state} = fixture();
    const order = Object.assign([...serialized.countryOrder], {extra: true});
    expect(() => deserializeWorldStateV3({...serialized, countryOrder: order}, catalog)).toThrow(/array field/);
    const getter = Object.defineProperty([...serialized.countryOrder], "0", {enumerable: true, get() {throw new Error("must not execute");}});
    expect(() => deserializeWorldStateV3({...serialized, countryOrder: getter}, catalog)).toThrow(/array field/);
    expect(() => deserializeWorldStateV3({...serialized, countryOrder: new Array(2)}, catalog)).toThrow(/holes/);
    const aliases = Object.assign(["AAA"], {[Symbol("hidden")]: 1});
    expect(() => createCountryEntityV3({...state.countriesById.AAA,
      names: {...state.countriesById.AAA.names, searchAliases: aliases}})).toThrow(/symbol/);
    const modules: Record<string, unknown> = {};
    modules.cycle = modules;
    expect(() => createCountryEntityV3({...state.countriesById.AAA, moduleVersions: modules})).toThrow(/circular/);
  });

  it.each(["catalogVersion", "geometryRoot", "topologyRoot", "renderArtifactRoot", "manifestPath"])("rejects catalog mismatch in %s", field => {
    const {serialized, catalog} = fixture();
    const catalogRef = field === "catalogVersion" ? {...catalog.ref, catalogVersion: "other",
      manifestPath: "/data/catalogs/other/manifest.json"} : {...catalog.ref,
        [field]: field === "manifestPath" ? "/data/catalogs/synthetic-v3/other.json" : "0".repeat(64)};
    expect(() => deserializeWorldStateV3({...serialized, catalogRef}, catalog)).toThrow(/mismatch/);
  });

  it("rejects source-country mismatch and malformed catalog references/IDs", () => {
    const {serialized, targetIds, catalog, legacyIds} = fixture();
    const id = targetIds[0];
    expect(() => deserializeWorldStateV3({...serialized, territoriesById: {...serialized.territoriesById,
      [id]: {...serialized.territoriesById[id], sourceCountryId: "BBB"}}}, catalog)).toThrow(/coverage/);
    for (const path of ["/data/../synthetic-v3/m.json", "/data/synthetic-v3//m.json", "https://example.com/m.json", "/data/unversioned/m.json"]) {
      expect(() => createWorldGeometryCatalogRef({...catalog.ref, manifestPath: path})).toThrow(/manifestPath/);
    }
    expect(() => createWorldGeometryCatalogRef({...catalog.ref, geometryRoot: "A".repeat(64)})).toThrow(/SHA-256/);
    expect(() => createWorldGeometryCatalogRef({...catalog.ref, extra: 1})).toThrow(/fields/);
    for (const invalid of [legacyIds[0], "territory:catalog:" + "A".repeat(64), "territory:catalog:" + "a".repeat(65), "__proto__", "영토"]) {
      expect(() => readCatalogTerritoryId(invalid)).toThrow();
    }
  });

  it("hashes controller, color and catalog roots while excluding revision and geometry", () => {
    const {state, serialized, catalog, targetIds} = fixture();
    const hash = worldStateV3ContentHash(state);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(worldStateV3ContentHash(createWorldStateV3({...state, revision: 8}, catalog))).toBe(hash);
    const changedColor = deserializeWorldStateV3({...serialized, countriesById: {...serialized.countriesById,
      AAA: {...serialized.countriesById.AAA, mapColor: "#FF0000"}}}, catalog);
    expect(worldStateV3ContentHash(changedColor)).not.toBe(hash);
    const id = targetIds[0];
    const occupied = deserializeWorldStateV3({...serialized, territoriesById: {...serialized.territoriesById,
      [id]: {...serialized.territoriesById[id], controllerCountryId: "BBB"}}}, catalog);
    expect(worldStateV3ContentHash(occupied)).not.toBe(hash);
    const nextCatalog = createWorldGeometryCatalogContract({...catalog, ref: {...catalog.ref, geometryRoot: "4".repeat(64)}});
    const next = deserializeWorldStateV3({...serialized, catalogRef: nextCatalog.ref}, nextCatalog);
    expect(worldStateV3ContentHash(next)).not.toBe(hash);
    expect(canonicalStringify(serialized)).not.toContain("coordinates");
  });
});
