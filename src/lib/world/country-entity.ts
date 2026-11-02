import {COUNTRY_ID_PATTERN, type ActiveCountryId} from "./country-id";
import {createCountryNames, type CountryNames} from "./country-names";
import {
  createCountryPresentationOverride,
  type CountryPresentationOverride,
} from "./country-presentation-override";

export const COUNTRY_POLITICAL_STATUSES = [
  "sovereign",
  "dependent",
  "disputed",
  "unrecognized",
] as const;

export type CountryPoliticalStatus = (typeof COUNTRY_POLITICAL_STATUSES)[number];

export type CountryEntity = Readonly<{
  id: ActiveCountryId;
  names: CountryNames;
  politicalStatus: CountryPoliticalStatus;
  presentationOverride: CountryPresentationOverride | null;
  moduleVersions: Readonly<Record<string, number>>;
}>;

const countryEntityKeys = [
  "id",
  "moduleVersions",
  "names",
  "politicalStatus",
  "presentationOverride",
] as const;

const assertExactKeys = (value: object, expectedKeys: readonly string[], context: string) => {
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${context} contains unknown or missing fields`);
  }
};

const readActiveCountryId = (value: unknown): ActiveCountryId => {
  if (typeof value !== "string" || !COUNTRY_ID_PATTERN.test(value)) {
    throw new Error(
      "CountryEntity.id must be exactly 3 uppercase alphanumeric characters and start with a letter",
    );
  }
  return value as ActiveCountryId;
};

const readModuleVersions = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CountryEntity.moduleVersions must be an object record");
  }
  const moduleVersions: Record<string, number> = {};
  for (const [moduleName, version] of Object.entries(value)) {
    if (moduleName.trim().length === 0 || !Number.isSafeInteger(version) || version < 0) {
      throw new Error(`Invalid module version for ${moduleName || "<empty>"}`);
    }
    moduleVersions[moduleName] = version;
  }
  return Object.freeze(moduleVersions);
};

export function createCountryEntity(value: unknown): CountryEntity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CountryEntity must be an object");
  }
  assertExactKeys(value, countryEntityKeys, "CountryEntity");
  const input = value as Record<(typeof countryEntityKeys)[number], unknown>;
  if (
    typeof input.politicalStatus !== "string" ||
    !COUNTRY_POLITICAL_STATUSES.includes(input.politicalStatus as CountryPoliticalStatus)
  ) {
    throw new Error("CountryEntity.politicalStatus is invalid");
  }

  return Object.freeze({
    id: readActiveCountryId(input.id),
    names: createCountryNames(input.names),
    politicalStatus: input.politicalStatus as CountryPoliticalStatus,
    presentationOverride:
      input.presentationOverride === null
        ? null
        : createCountryPresentationOverride(input.presentationOverride),
    moduleVersions: readModuleVersions(input.moduleVersions),
  });
}
