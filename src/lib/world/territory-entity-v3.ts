import type {ActiveCountryId, CountryId} from "./country-id";
import type {TerritoryId} from "./territory-id";
import {readCatalogTerritoryId} from "./world-geometry-catalog-ref";
import {assertWorldV3Keys, readWorldV3CountryId, readWorldV3Record} from "./world-v3-validation";

export type TerritoryEntityV3 = Readonly<{
  id: TerritoryId;
  sourceCountryId: CountryId;
  ownerCountryId: ActiveCountryId | null;
  controllerCountryId: ActiveCountryId | null;
}>;

export function createTerritoryEntityV3(value: unknown): TerritoryEntityV3 {
  const input = readWorldV3Record(value, "TerritoryEntityV3");
  assertWorldV3Keys(input, ["id", "sourceCountryId", "ownerCountryId", "controllerCountryId"], "TerritoryEntityV3");
  const ownerCountryId = input.ownerCountryId === null ? null :
    readWorldV3CountryId(input.ownerCountryId, "ownerCountryId") as ActiveCountryId;
  const controllerCountryId = input.controllerCountryId === null ? null :
    readWorldV3CountryId(input.controllerCountryId, "controllerCountryId") as ActiveCountryId;
  if (ownerCountryId !== null && controllerCountryId === null) {
    throw new Error("An owned territory must have an active controller");
  }
  return Object.freeze({id: readCatalogTerritoryId(input.id),
    sourceCountryId: readWorldV3CountryId(input.sourceCountryId, "sourceCountryId"),
    ownerCountryId, controllerCountryId});
}
