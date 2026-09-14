import {
  createCountryIdRegistry,
  retireCountryId,
  type ActiveCountryId,
  type CountryIdRegistry,
  type RetiredCountryId,
} from "./country-id";

export type RetiredCountryIdRegistryErrorCode =
  | "country-id-not-active"
  | "country-id-already-retired"
  | "country-id-not-retired";

export class RetiredCountryIdRegistryError extends Error {
  readonly code: RetiredCountryIdRegistryErrorCode;

  constructor(code: RetiredCountryIdRegistryErrorCode, message: string) {
    super(message);
    this.name = "RetiredCountryIdRegistryError";
    this.code = code;
  }
}

export type ConfirmedCountryIdDeletion = Readonly<{
  countryId: RetiredCountryId;
  registry: CountryIdRegistry;
}>;

export type CountryIdUndoRestoration = Readonly<{
  countryId: ActiveCountryId;
  registry: CountryIdRegistry;
}>;

export function confirmCountryIdDeletion(
  countryId: ActiveCountryId,
  registry: CountryIdRegistry,
): ConfirmedCountryIdDeletion {
  if (registry.retiredCountryIds.has(countryId as unknown as RetiredCountryId)) {
    throw new RetiredCountryIdRegistryError(
      "country-id-already-retired",
      `CountryId is already retired: ${countryId}`,
    );
  }
  if (!registry.activeCountryIds.has(countryId)) {
    throw new RetiredCountryIdRegistryError(
      "country-id-not-active",
      `CountryId is not active and cannot be deleted: ${countryId}`,
    );
  }

  const retiredCountryId = retireCountryId(countryId);
  const nextRegistry = createCountryIdRegistry({
    activeCountryIds: [...registry.activeCountryIds].filter((id) => id !== countryId),
    retiredCountryIds: [...registry.retiredCountryIds, retiredCountryId],
  });
  return Object.freeze({countryId: retiredCountryId, registry: nextRegistry});
}

export function restoreCountryIdForUndo(
  countryId: RetiredCountryId,
  registry: CountryIdRegistry,
): CountryIdUndoRestoration {
  if (!registry.retiredCountryIds.has(countryId)) {
    throw new RetiredCountryIdRegistryError(
      "country-id-not-retired",
      `CountryId is not retired and cannot be restored by undo: ${countryId}`,
    );
  }

  const activeCountryId = countryId as unknown as ActiveCountryId;
  const nextRegistry = createCountryIdRegistry({
    activeCountryIds: [...registry.activeCountryIds, activeCountryId],
    retiredCountryIds: [...registry.retiredCountryIds].filter((id) => id !== countryId),
  });
  return Object.freeze({countryId: activeCountryId, registry: nextRegistry});
}
