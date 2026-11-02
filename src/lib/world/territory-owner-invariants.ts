import type {CountryIdRegistry, RetiredCountryId} from "./country-id";
import type {TerritoryEntity} from "./territory-entity";

export type TerritoryOwnerReferenceErrorCode =
  | "unknown-territory-owner"
  | "retired-territory-owner";

export class TerritoryOwnerReferenceError extends Error {
  readonly code: TerritoryOwnerReferenceErrorCode;
  readonly territoryId: TerritoryEntity["id"];
  readonly ownerCountryId: NonNullable<TerritoryEntity["ownerCountryId"]>;

  constructor(
    code: TerritoryOwnerReferenceErrorCode,
    territory: TerritoryEntity,
    message: string,
  ) {
    super(message);
    this.name = "TerritoryOwnerReferenceError";
    this.code = code;
    this.territoryId = territory.id;
    this.ownerCountryId = territory.ownerCountryId as NonNullable<
      TerritoryEntity["ownerCountryId"]
    >;
  }
}

export function assertTerritoryOwnerReferences(
  territories: Iterable<TerritoryEntity>,
  countryIdRegistry: CountryIdRegistry,
): void {
  for (const territory of territories) {
    const ownerCountryId = territory.ownerCountryId;
    if (ownerCountryId === null || countryIdRegistry.activeCountryIds.has(ownerCountryId)) {
      continue;
    }
    if (
      countryIdRegistry.retiredCountryIds.has(ownerCountryId as unknown as RetiredCountryId)
    ) {
      throw new TerritoryOwnerReferenceError(
        "retired-territory-owner",
        territory,
        `Territory ${territory.id} references retired owner ${ownerCountryId}`,
      );
    }
    throw new TerritoryOwnerReferenceError(
      "unknown-territory-owner",
      territory,
      `Territory ${territory.id} references unknown owner ${ownerCountryId}`,
    );
  }
}
