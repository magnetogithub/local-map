import {createCountryEntityV3, type CountryEntityV3} from "./country-entity-v3";
import {createCountryIdRegistry, type ActiveCountryId, type RetiredCountryId} from "./country-id";
import {createTerritoryEntityV3, type TerritoryEntityV3} from "./territory-entity-v3";
import type {TerritoryId} from "./territory-id";
import {createImmutableReadonlySet} from "./immutable-readonly-set";
import {canonicalSerialize} from "./canonical-serializer";
import {sha256Hex} from "./sha256";
import {
  assertWorldGeometryCatalogRefMatches, createWorldGeometryCatalogContract,
  createWorldGeometryCatalogRef, readCatalogTerritoryId,
  type WorldGeometryCatalogContract, type WorldGeometryCatalogRef,
} from "./world-geometry-catalog-ref";
import {
  assertWorldV3Keys, assertWorldV3RecordOrder, readWorldV3CountryId,
  readWorldV3Order, readWorldV3Record, readWorldV3Version,
} from "./world-v3-validation";

export const WORLD_STATE_V3_SCHEMA_VERSION = 3 as const;

export type WorldStateV3 = Readonly<{
  schemaVersion: typeof WORLD_STATE_V3_SCHEMA_VERSION;
  seedVersion: string;
  policyVersion: string;
  revision: number;
  countriesById: Readonly<Record<string, CountryEntityV3>>;
  countryOrder: readonly ActiveCountryId[];
  retiredCountryIds: ReadonlySet<RetiredCountryId>;
  territoriesById: Readonly<Record<string, TerritoryEntityV3>>;
  territoryOrder: readonly TerritoryId[];
  catalogRef: WorldGeometryCatalogRef;
}>;

export type SerializedWorldStateV3 = Omit<WorldStateV3, "retiredCountryIds"> & Readonly<{
  retiredCountryIds: readonly RetiredCountryId[];
}>;

function readWorldStateV3(value: unknown, catalog: WorldGeometryCatalogContract, serialized: boolean): WorldStateV3 {
  const input = readWorldV3Record(value, "WorldStateV3");
  assertWorldV3Keys(input, ["schemaVersion", "seedVersion", "policyVersion", "revision", "countriesById", "countryOrder", "retiredCountryIds", "territoriesById", "territoryOrder", "catalogRef"], "WorldStateV3");
  if (input.schemaVersion !== WORLD_STATE_V3_SCHEMA_VERSION) throw new Error("WorldStateV3.schemaVersion must be 3");
  if (typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new Error("WorldStateV3.revision must be a non-negative safe integer");
  }
  const catalogRef = createWorldGeometryCatalogRef(input.catalogRef);
  assertWorldGeometryCatalogRefMatches(catalogRef, catalog.ref);
  const countryOrder = readWorldV3Order(input.countryOrder, readWorldV3CountryId, "countryOrder") as readonly ActiveCountryId[];
  const retiredInput = input.retiredCountryIds;
  if (!serialized && !(retiredInput instanceof Set) &&
    (!retiredInput || typeof retiredInput !== "object" ||
      typeof (retiredInput as ReadonlySet<unknown>)[Symbol.iterator] !== "function" ||
      typeof (retiredInput as ReadonlySet<unknown>).has !== "function")) {
    throw new Error("WorldStateV3.retiredCountryIds must be a readonly set");
  }
  const retiredOrder = readWorldV3Order(serialized ? retiredInput : [...retiredInput as ReadonlySet<unknown>], readWorldV3CountryId, "retiredCountryIds") as readonly RetiredCountryId[];
  createCountryIdRegistry({activeCountryIds: countryOrder, retiredCountryIds: retiredOrder});
  const countries = readWorldV3Record(input.countriesById, "countriesById");
  assertWorldV3RecordOrder(countries, countryOrder, "countriesById");
  const countriesById: Record<string, CountryEntityV3> = {};
  for (const id of countryOrder) {
    const country = createCountryEntityV3(countries[id]);
    if (country.id !== id) throw new Error("Country record key must match entity id");
    countriesById[id] = country;
  }
  const territoryOrder = readWorldV3Order(input.territoryOrder, readCatalogTerritoryId, "territoryOrder");
  if (territoryOrder.length !== catalog.territoryOrder.length ||
    territoryOrder.some((id, index) => id !== catalog.territoryOrder[index])) {
    throw new Error("WorldStateV3.territoryOrder must equal the entire catalog order");
  }
  const territories = readWorldV3Record(input.territoriesById, "territoriesById");
  assertWorldV3RecordOrder(territories, territoryOrder, "territoriesById");
  const territoriesById: Record<string, TerritoryEntityV3> = {};
  for (const id of territoryOrder) {
    const territory = createTerritoryEntityV3(territories[id]);
    if (territory.id !== id) throw new Error("Territory record key must match entity id");
    if (territory.sourceCountryId !== catalog.territoriesById[id].sourceCountryId) {
      throw new Error("Territory source-country coverage does not match the catalog");
    }
    for (const field of ["ownerCountryId", "controllerCountryId"] as const) {
      const countryId = territory[field];
      if (countryId !== null && !Object.hasOwn(countriesById, countryId)) {
        throw new Error(`Territory ${field} must reference an active country: ${countryId}`);
      }
    }
    territoriesById[id] = territory;
  }
  return Object.freeze({schemaVersion: WORLD_STATE_V3_SCHEMA_VERSION,
    seedVersion: readWorldV3Version(input.seedVersion, "seedVersion"),
    policyVersion: readWorldV3Version(input.policyVersion, "policyVersion"), revision: input.revision,
    countriesById: Object.freeze(countriesById), countryOrder,
    retiredCountryIds: createImmutableReadonlySet(retiredOrder),
    territoriesById: Object.freeze(territoriesById), territoryOrder, catalogRef});
}

/** No production bootstrap uses V3 until catalog/consumer readiness and atomic cutover. */
export function createWorldStateV3(value: unknown, catalog: WorldGeometryCatalogContract): WorldStateV3 {
  return readWorldStateV3(value, createWorldGeometryCatalogContract(catalog), false);
}

export function deserializeWorldStateV3(value: unknown, catalog: WorldGeometryCatalogContract): WorldStateV3 {
  return readWorldStateV3(value, createWorldGeometryCatalogContract(catalog), true);
}

export function serializeWorldStateV3(state: WorldStateV3): SerializedWorldStateV3 {
  return Object.freeze({...state, retiredCountryIds: Object.freeze([...state.retiredCountryIds])});
}

/** Explicit offline hash; immutable geometry bytes and bookkeeping revision are excluded. */
export function worldStateV3ContentHash(state: WorldStateV3): string {
  const {revision, ...content} = serializeWorldStateV3(state);
  void revision;
  return sha256Hex(canonicalSerialize({namespace: "world-content-v3", content}));
}
