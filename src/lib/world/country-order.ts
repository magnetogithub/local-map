import type {ActiveCountryId} from "./country-id";

export type CountryOrder = readonly ActiveCountryId[];

export type CountryOrderErrorCode =
  | "invalid-country-order-id"
  | "duplicate-country-order-id"
  | "missing-country-order-id";

export class CountryOrderError extends Error {
  readonly code: CountryOrderErrorCode;

  constructor(code: CountryOrderErrorCode, message: string) {
    super(message);
    this.name = "CountryOrderError";
    this.code = code;
  }
}

const compareCanonicalIds = (left: ActiveCountryId, right: ActiveCountryId) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const readActiveCountryId = (value: ActiveCountryId): ActiveCountryId => {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new CountryOrderError(
      "invalid-country-order-id",
      "countryOrder values must be canonical active CountryIds",
    );
  }
  return value;
};

export function createCountryOrder(activeCountryIds: Iterable<ActiveCountryId>): CountryOrder {
  const uniqueIds = new Set<ActiveCountryId>();
  for (const value of activeCountryIds) {
    const countryId = readActiveCountryId(value);
    if (uniqueIds.has(countryId)) {
      throw new CountryOrderError(
        "duplicate-country-order-id",
        `Duplicate countryOrder id: ${countryId}`,
      );
    }
    uniqueIds.add(countryId);
  }
  return Object.freeze([...uniqueIds].sort(compareCanonicalIds));
}

export function addCountryToOrder(
  countryOrder: CountryOrder,
  countryId: ActiveCountryId,
): CountryOrder {
  const canonicalOrder = createCountryOrder(countryOrder);
  const canonicalId = readActiveCountryId(countryId);
  if (canonicalOrder.includes(canonicalId)) {
    throw new CountryOrderError(
      "duplicate-country-order-id",
      `Country is already present in countryOrder: ${canonicalId}`,
    );
  }
  return createCountryOrder([...canonicalOrder, canonicalId]);
}

export function removeCountryFromOrder(
  countryOrder: CountryOrder,
  countryId: ActiveCountryId,
): CountryOrder {
  const canonicalOrder = createCountryOrder(countryOrder);
  const canonicalId = readActiveCountryId(countryId);
  if (!canonicalOrder.includes(canonicalId)) {
    throw new CountryOrderError(
      "missing-country-order-id",
      `Country is absent from countryOrder: ${canonicalId}`,
    );
  }
  return createCountryOrder(canonicalOrder.filter((id) => id !== canonicalId));
}
