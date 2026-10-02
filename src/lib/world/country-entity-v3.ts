import {createCountryEntity, type CountryEntity} from "./country-entity";
import {assertWorldV3DataTree, assertWorldV3Keys, readWorldV3Record} from "./world-v3-validation";

export type CountryEntityV3 = CountryEntity & Readonly<{mapColor: string}>;

export function readCanonicalMapColor(value: unknown): string {
  if (typeof value !== "string" || !/^#[0-9A-F]{6}$/.test(value)) {
    throw new Error("CountryEntityV3.mapColor must be canonical uppercase #RRGGBB");
  }
  return value;
}

export function createCountryEntityV3(value: unknown): CountryEntityV3 {
  assertWorldV3DataTree(value, "CountryEntityV3");
  const input = readWorldV3Record(value, "CountryEntityV3");
  assertWorldV3Keys(input, ["id", "names", "politicalStatus", "presentationOverride", "moduleVersions", "mapColor"], "CountryEntityV3");
  const {mapColor, ...legacyCountry} = input;
  return Object.freeze({...createCountryEntity(legacyCountry), mapColor: readCanonicalMapColor(mapColor)});
}
