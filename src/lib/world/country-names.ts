export type CountryNames = {
  shortKo: string;
  officialKo: string;
  mapKo: string;
  english: string;
  searchAliases: string[];
};

export type CountryNamesPatch = Partial<CountryNames>;

const countryNameKeys = [
  "english",
  "mapKo",
  "officialKo",
  "searchAliases",
  "shortKo",
] as const;

const readNonEmptyText = (value: unknown, context: string) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value;
};

const assertExactKeys = (value: object, expectedKeys: readonly string[], context: string) => {
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${context} contains unknown or missing fields`);
  }
};

export function createCountryNames(value: unknown): CountryNames {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CountryNames must be an object");
  }
  assertExactKeys(value, countryNameKeys, "CountryNames");
  const input = value as Record<(typeof countryNameKeys)[number], unknown>;
  if (!Array.isArray(input.searchAliases)) {
    throw new Error("CountryNames.searchAliases must be an array");
  }
  const searchAliases = input.searchAliases.map((alias, index) =>
    readNonEmptyText(alias, `CountryNames.searchAliases[${index}]`),
  );
  Object.freeze(searchAliases);

  return Object.freeze({
    shortKo: readNonEmptyText(input.shortKo, "CountryNames.shortKo"),
    officialKo: readNonEmptyText(input.officialKo, "CountryNames.officialKo"),
    mapKo: readNonEmptyText(input.mapKo, "CountryNames.mapKo"),
    english: readNonEmptyText(input.english, "CountryNames.english"),
    searchAliases,
  }) as CountryNames;
}

export function updateCountryNames(
  current: CountryNames,
  patch: CountryNamesPatch,
): CountryNames {
  const unknownKeys = Object.keys(patch).filter(
    (key) => !countryNameKeys.includes(key as (typeof countryNameKeys)[number]),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`CountryNames patch contains unknown fields: ${unknownKeys.join(",")}`);
  }
  return createCountryNames({...current, ...patch});
}

export function replaceCountryNamesModule<Owner extends {names: CountryNames}>(
  owner: Owner,
  names: CountryNames,
): Owner {
  return {...owner, names};
}
