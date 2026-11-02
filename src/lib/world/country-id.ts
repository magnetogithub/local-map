import {createImmutableReadonlySet} from "./immutable-readonly-set";

declare const countryIdStatusBrand: unique symbol;

export type CountryIdStatus = "active" | "retired";

export type CountryId<Status extends CountryIdStatus = CountryIdStatus> = string & {
  readonly [countryIdStatusBrand]: Status;
};

export type ActiveCountryId = CountryId<"active">;
export type RetiredCountryId = CountryId<"retired">;

export type CountryIdRegistry = Readonly<{
  activeCountryIds: ReadonlySet<ActiveCountryId>;
  retiredCountryIds: ReadonlySet<RetiredCountryId>;
}>;

export type CountryIdRegistryInput = Readonly<{
  activeCountryIds: Iterable<unknown>;
  retiredCountryIds: Iterable<unknown>;
}>;

export type CountryIdErrorCode =
  | "invalid-country-id"
  | "duplicate-country-id"
  | "country-id-lifecycle-conflict"
  | "country-id-active"
  | "country-id-retired"
  | "country-id-exhausted";

export const COUNTRY_ID_PATTERN = /^[A-Z][A-Z0-9]{2}$/;

export class CountryIdError extends Error {
  readonly code: CountryIdErrorCode;

  constructor(code: CountryIdErrorCode, message: string) {
    super(message);
    this.name = "CountryIdError";
    this.code = code;
  }
}

function readCountryId(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new CountryIdError("invalid-country-id", `${context} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CountryIdError("invalid-country-id", `${context} must be a non-empty string`);
  }
  if (value !== trimmed) {
    throw new CountryIdError(
      "invalid-country-id",
      `${context} must not contain surrounding whitespace`,
    );
  }
  if (!COUNTRY_ID_PATTERN.test(value)) {
    throw new CountryIdError(
      "invalid-country-id",
      `${context} must be exactly 3 uppercase alphanumeric characters and start with a letter`,
    );
  }
  return value;
}

function collectCountryIds<Status extends CountryIdStatus>(
  values: Iterable<unknown>,
  status: Status,
): Set<CountryId<Status>> {
  const countryIds = new Set<CountryId<Status>>();
  for (const value of values) {
    const countryId = readCountryId(value, `${status} CountryId`) as CountryId<Status>;
    if (countryIds.has(countryId)) {
      throw new CountryIdError(
        "duplicate-country-id",
        `Duplicate ${status} CountryId: ${countryId}`,
      );
    }
    countryIds.add(countryId);
  }
  return countryIds;
}

export function createCountryIdRegistry(input: CountryIdRegistryInput): CountryIdRegistry {
  const activeCountryIds = collectCountryIds(input.activeCountryIds, "active");
  const retiredCountryIds = collectCountryIds(input.retiredCountryIds, "retired");

  for (const activeCountryId of activeCountryIds) {
    if (retiredCountryIds.has(activeCountryId as unknown as RetiredCountryId)) {
      throw new CountryIdError(
        "country-id-lifecycle-conflict",
        `CountryId cannot be both active and retired: ${activeCountryId}`,
      );
    }
  }

  return Object.freeze({
    activeCountryIds: createImmutableReadonlySet(activeCountryIds),
    retiredCountryIds: createImmutableReadonlySet(retiredCountryIds),
  });
}

export function issueCountryId(
  value: unknown,
  registry: CountryIdRegistry,
): ActiveCountryId {
  const countryId = readCountryId(value, "CountryId");

  if (registry.activeCountryIds.has(countryId as ActiveCountryId)) {
    throw new CountryIdError("country-id-active", `CountryId is already active: ${countryId}`);
  }
  if (registry.retiredCountryIds.has(countryId as RetiredCountryId)) {
    throw new CountryIdError(
      "country-id-retired",
      `CountryId is retired and cannot be reissued: ${countryId}`,
    );
  }

  return countryId as ActiveCountryId;
}

/**
 * Allocates a stable three-character tag for a country without a predefined tag.
 * D01..DZZ is reserved for generated countries; active, retired, and caller-reserved
 * values are all skipped so a historical tag is never silently reused.
 */
export function allocateDynamicCountryId(
  registry: CountryIdRegistry,
  reservedCountryIds: Iterable<string> = [],
): ActiveCountryId {
  const unavailable = new Set<string>([
    ...registry.activeCountryIds,
    ...registry.retiredCountryIds,
    ...reservedCountryIds,
  ]);

  for (let sequence = 1; sequence < 36 ** 2; sequence += 1) {
    const candidate = `D${sequence.toString(36).toUpperCase().padStart(2, "0")}`;
    if (!unavailable.has(candidate)) return issueCountryId(candidate, registry);
  }

  throw new CountryIdError(
    "country-id-exhausted",
    "No generated CountryId remains in the D01-DZZ namespace",
  );
}

export function retireCountryId(countryId: ActiveCountryId): RetiredCountryId {
  return countryId as unknown as RetiredCountryId;
}
