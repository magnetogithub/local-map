import fs from "node:fs";
import path from "node:path";
import {describe, expect, it, vi} from "vitest";
import metadata from "@/data/countries-2020.json";
import {createWorldV3SyntheticFixture} from "./world-v3-synthetic-fixture";
import {migrateWorldStateV2ToV3} from "./world-v2-to-v3-migration";
import {createWorldStateV2, serializeWorldStateV2} from "../world/world-state-v2";
import {serializeWorldStateV3, worldStateV3ContentHash} from "../world/world-state-v3";
import {createCountryEntity} from "../world/country-entity";
import {canonicalStringify} from "../world/canonical-serializer";
import {createWorldGeometryCatalogContract} from "../world/world-geometry-catalog-ref";

const fixture = () => {
  const f = createWorldV3SyntheticFixture();
  return {...f, input: {legacyWorld: f.legacy, catalog: f.catalog, mapping: f.mapping,
    countryMapColors: f.countryMapColors, validateCanonicalCoverage: f.validateCanonicalCoverage}};
};

describe("14-3 test-only V2 to V3 migration", () => {
  it("migrates one-to-many, preserving country identity, owner, controller, colors and revision", () => {
    const {input, legacy, catalog, legacyIds, targetIds} = fixture();
    const state = migrateWorldStateV2ToV3(input);
    expect(state.territoryOrder).toEqual(catalog.territoryOrder);
    expect(state.territoryOrder.some(id => legacyIds.includes(id))).toBe(false);
    expect(state.revision).toBe(legacy.revision);
    expect(state.seedVersion).toBe(legacy.seedVersion);
    expect(state.policyVersion).toBe(legacy.policyVersion);
    for (const id of legacy.countryOrder) {
      const {mapColor, ...country} = state.countriesById[id];
      expect(country).toEqual(legacy.countriesById[id]);
      expect(mapColor).toBe(input.countryMapColors[id as keyof typeof input.countryMapColors].toUpperCase());
    }
    for (const id of targetIds.slice(0, 2)) {
      expect(state.territoriesById[id]).toMatchObject({sourceCountryId: "AAA", ownerCountryId: "AAA", controllerCountryId: "AAA"});
    }
    expect(state.territoriesById[targetIds[2]].ownerCountryId).toBe("BBB");
  });

  it("preserves null ownership and transferred ownership without guessing original source country", () => {
    const {input, legacyIds, targetIds} = fixture();
    for (const ownerCountryId of [null, input.legacyWorld.countriesById.BBB.id]) {
      const legacyWorld = createWorldStateV2({...input.legacyWorld, territoriesById: {...input.legacyWorld.territoriesById,
        [legacyIds[0]]: {...input.legacyWorld.territoriesById[legacyIds[0]], ownerCountryId}}});
      const state = migrateWorldStateV2ToV3({...input, legacyWorld});
      for (const id of targetIds.slice(0, 2)) {
        expect(state.territoriesById[id]).toMatchObject({sourceCountryId: "AAA", ownerCountryId, controllerCountryId: ownerCountryId});
      }
    }
  });

  it("preserves retired country registry and provenance after dissolution", () => {
    const {input, legacyIds, targetIds} = fixture();
    const legacyWorld = createWorldStateV2({...input.legacyWorld, countryOrder: [input.legacyWorld.countriesById.BBB.id],
      countriesById: {BBB: input.legacyWorld.countriesById.BBB}, retiredCountryIds: ["AAA" as never, "OLD" as never],
      territoriesById: {...input.legacyWorld.territoriesById, [legacyIds[0]]: {...input.legacyWorld.territoriesById[legacyIds[0]], ownerCountryId: input.legacyWorld.countriesById.BBB.id}}});
    const state = migrateWorldStateV2ToV3({...input, legacyWorld, countryMapColors: {BBB: input.countryMapColors.BBB}});
    expect([...state.retiredCountryIds]).toEqual(["AAA", "OLD"]);
    expect(state.territoriesById[targetIds[0]].sourceCountryId).toBe("AAA");
    expect(state.territoriesById[targetIds[0]].controllerCountryId).toBe("BBB");
  });

  it("preserves every real 2020 seed color's RGB value", () => {
    const {input} = fixture();
    const seedCountries = metadata.map(country => createCountryEntity({id: country.id,
      names: {shortKo: country.nameKo, officialKo: country.nameKo, mapKo: country.mapLabelKo,
        english: country.nameEn, searchAliases: [country.id]}, politicalStatus: "sovereign",
      presentationOverride: null, moduleVersions: {core: 1, names: 1}}));
    const countriesById = {...input.legacyWorld.countriesById, ...Object.fromEntries(seedCountries.map(country => [country.id, country]))};
    const legacyWorld = createWorldStateV2({...input.legacyWorld, countriesById,
      countryOrder: Object.values(countriesById).map(country => country.id)});
    const colors = {...input.countryMapColors, ...Object.fromEntries(metadata.map(country => [country.id, country.mapColor]))};
    const migrated = migrateWorldStateV2ToV3({...input, legacyWorld, countryMapColors: colors});
    for (const country of metadata) expect(migrated.countriesById[country.id].mapColor).toBe(country.mapColor.toUpperCase());
    expect(metadata.length).toBeGreaterThan(200);
  });

  it("canonicalizes entry ordering and generates identical bytes/hash twice", () => {
    const {input} = fixture();
    const first = migrateWorldStateV2ToV3(input);
    const second = migrateWorldStateV2ToV3({...input, mapping: [...input.mapping].reverse()});
    expect(canonicalStringify(serializeWorldStateV3(first))).toBe(canonicalStringify(serializeWorldStateV3(second)));
    expect(worldStateV3ContentHash(first)).toBe(worldStateV3ContentHash(second));
  });

  it("rejects missing, duplicate, unknown and empty legacy entries", () => {
    const {input} = fixture();
    expect(() => migrateWorldStateV2ToV3({...input, mapping: input.mapping.slice(1)})).toThrow(/missing legacy/);
    expect(() => migrateWorldStateV2ToV3({...input, mapping: [...input.mapping, input.mapping[0]]})).toThrow(/Duplicate legacy/);
    expect(() => migrateWorldStateV2ToV3({...input, mapping: [...input.mapping, {...input.mapping[0], legacyTerritoryId: "territory:seed:1:x1:y"}]})).toThrow(/Unknown legacy/);
    expect(() => migrateWorldStateV2ToV3({...input, mapping: [{...input.mapping[0], targetTerritoryIds: []}, input.mapping[1]]})).toThrow(/empty/);
  });

  it("rejects missing, duplicate, unknown and unsorted targets", () => {
    const {input, targetIds} = fixture();
    expect(() => migrateWorldStateV2ToV3({...input, mapping: [{...input.mapping[0], targetTerritoryIds: [targetIds[0]]}, input.mapping[1]]})).toThrow(/missing catalog/);
    expect(() => migrateWorldStateV2ToV3({...input, mapping: [{...input.mapping[0], targetTerritoryIds: [targetIds[0], targetIds[0]]}, input.mapping[1]]})).toThrow(/duplicates/);
    expect(() => migrateWorldStateV2ToV3({...input, mapping: [{...input.mapping[0], targetTerritoryIds: [...input.mapping[0].targetTerritoryIds].reverse()}, input.mapping[1]]})).toThrow(/sorted/);
    expect(() => migrateWorldStateV2ToV3({...input, mapping: [{...input.mapping[0], targetTerritoryIds: [`territory:catalog:${"0".repeat(64)}`]}, input.mapping[1]]})).toThrow(/Unknown target/);
  });

  it("rejects many-to-one and many-to-many mappings", () => {
    const {input, targetIds} = fixture();
    for (const targets of [[targetIds[1]], [targetIds[1], targetIds[2]]]) {
      expect(() => migrateWorldStateV2ToV3({...input, mapping: [input.mapping[0], {...input.mapping[1], targetTerritoryIds: targets}]})).toThrow(/many-to-one/);
    }
  });

  it("requires coverage proof and rejects source-country mismatch", () => {
    const {input} = fixture();
    expect(() => migrateWorldStateV2ToV3({...input, validateCanonicalCoverage: undefined as never})).toThrow(/required/);
    expect(() => migrateWorldStateV2ToV3({...input, validateCanonicalCoverage: () => ({sourceCountryId: "BBB" as never})})).toThrow(/source-country/);
  });

  it("checks actual synthetic coverage, including same-country targets outside the legacy partition", () => {
    const {input, targetIds} = fixture();
    // All target IDs exist, and sources match: ID checks alone would accept this.
    const catalog = createWorldGeometryCatalogContract({...input.catalog, territoriesById: Object.fromEntries(targetIds.map(id => [id, {id, sourceCountryId: "AAA"}]))});
    const mapping = [
      {...input.mapping[0], targetTerritoryIds: [targetIds[0], targetIds[2]]},
      {...input.mapping[1], targetTerritoryIds: [targetIds[1]]},
    ];
    expect(() => migrateWorldStateV2ToV3({...input, catalog, mapping})).toThrow(/gap, overlap or outside/);
    expect(() => input.validateCanonicalCoverage({...input.mapping[0], targetTerritoryIds: [targetIds[0]], catalogRef: input.catalog.ref})).toThrow(/incomplete/);
    expect(() => migrateWorldStateV2ToV3({...input, catalog: {...input.catalog, ref: {...input.catalog.ref, geometryRoot: "0".repeat(64)}}})).toThrow(/Stale/);
  });

  it.each([{}, {AAA: "#abcdef"}, {AAA: "#abcdef", BBB: "#ffffff", OLD: "#ffffff"},
    {AAA: "red", BBB: "#ffffff"}, {AAA: " #ABCDEF", BBB: "#ffffff"}])("rejects incomplete, extra or invalid colors %s", countryMapColors => {
    const {input} = fixture();
    expect(() => migrateWorldStateV2ToV3({...input, countryMapColors: countryMapColors as Record<string, string>})).toThrow();
  });

  it("rejects schema extras and attempts to supply an overlapping V2 controller", () => {
    const {input, legacyIds} = fixture();
    expect(() => migrateWorldStateV2ToV3({...input, mapping: [{...input.mapping[0], extra: 1}, input.mapping[1]]})).toThrow(/fields/);
    expect(() => migrateWorldStateV2ToV3({...input, extra: 1} as typeof input)).toThrow(/fields/);
    const invalidLegacy = {...input.legacyWorld, territoriesById: {...input.legacyWorld.territoriesById,
      [legacyIds[0]]: {...input.legacyWorld.territoriesById[legacyIds[0]], controllerCountryId: "BBB"}}};
    expect(() => migrateWorldStateV2ToV3({...input, legacyWorld: invalidLegacy})).toThrow(/controller/);
  });

  it("leaves the original world and mapping unchanged on late validation failure", () => {
    const {input} = fixture();
    const beforeWorld = canonicalStringify(serializeWorldStateV2(input.legacyWorld));
    const beforeMapping = canonicalStringify(input.mapping);
    const validateCanonicalCoverage = vi.fn(input.validateCanonicalCoverage)
      .mockImplementationOnce(input.validateCanonicalCoverage)
      .mockImplementationOnce(() => {throw new Error("late coverage failure");});
    expect(() => migrateWorldStateV2ToV3({...input, validateCanonicalCoverage})).toThrow(/late coverage/);
    expect(validateCanonicalCoverage).toHaveBeenCalledTimes(2);
    expect(canonicalStringify(serializeWorldStateV2(input.legacyWorld))).toBe(beforeWorld);
    expect(canonicalStringify(input.mapping)).toBe(beforeMapping);
  });

  it("keeps synthetic assets and migration out of production consumers after the approved V3 cutover", () => {
    function files(directory: string): string[] {
      return fs.readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
        if (entry.name === "test-only") return [];
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return files(file);
        return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name) ? [file] : [];
      });
    }
    const violations = files(path.join(process.cwd(), "src")).filter(file => {
      return [...fs.readFileSync(file, "utf8").matchAll(/(?:from\s*|import\s*\()["']([^"']+)["']/g)]
        .some(([, specifier]) => /world-v2-to-v3-migration|world-v3-synthetic-fixture|\/test-only\//.test(specifier));
    });
    expect(violations).toEqual([]);
  });
});
