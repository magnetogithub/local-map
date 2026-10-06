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
const validatedWorlds=new WeakSet<object>();
export function isValidatedWorldStateV3(state:WorldStateV3,catalog:WorldGeometryCatalogContract):boolean{
  assertWorldGeometryCatalogRefMatches(state.catalogRef,catalog.ref);return validatedWorlds.has(state);
}

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
  const state=readWorldStateV3(value, createWorldGeometryCatalogContract(catalog), false);validatedWorlds.add(state);return state;
}

export function deserializeWorldStateV3(value: unknown, catalog: WorldGeometryCatalogContract): WorldStateV3 {
  const state=readWorldStateV3(value, createWorldGeometryCatalogContract(catalog), true);validatedWorlds.add(state);return state;
}

/** Validated immutable delta: untouched records, orders and catalog identity remain shared. */
export function transitionWorldStateV3(base:WorldStateV3,catalog:WorldGeometryCatalogContract,changes:Readonly<{
  territories?:Readonly<Record<string,TerritoryEntityV3>>;countries?:Readonly<Record<string,CountryEntityV3|null>>;
}>,revision=base.revision+1):WorldStateV3{
  if(!isValidatedWorldStateV3(base,catalog))base=createWorldStateV3(base,catalog);
  if(!Number.isSafeInteger(revision)||revision<0)throw Error('Invalid world revision');
  let countries=base.countriesById,territories=base.territoriesById,order=base.countryOrder,retired=base.retiredCountryIds;
  if(changes.countries&&Object.keys(changes.countries).length){const next={...countries},removed:string[]=[];
    for(const [id,value]of Object.entries(changes.countries)){if(!Object.hasOwn(countries,id))throw Error('Country transition requires an existing active identity');
      if(value===null){delete next[id];removed.push(id);}else{const country=createCountryEntityV3(value);if(country.id!==id)throw Error('Country transition key mismatch');next[id]=country;}}
    countries=Object.freeze(next);if(removed.length){order=Object.freeze(order.filter(id=>!removed.includes(id)));retired=createImmutableReadonlySet([...retired,...removed].sort() as RetiredCountryId[]);}
  }
  if(changes.territories&&Object.keys(changes.territories).length){const next={...territories};for(const [id,value]of Object.entries(changes.territories)){
    const t=createTerritoryEntityV3(value);if(t.id!==id||!Object.hasOwn(base.territoriesById,id)||t.sourceCountryId!==base.territoriesById[id].sourceCountryId)throw Error('Invalid immutable territory transition');next[id]=t;}territories=Object.freeze(next);}
  const checkIds=changes.countries&&Object.values(changes.countries).some(c=>c===null)?base.territoryOrder:Object.keys(changes.territories??{});
  for(const id of checkIds){const t=territories[id];for(const country of [t.ownerCountryId,t.controllerCountryId])if(country!==null&&!Object.hasOwn(countries,country))throw Error('Territory transition references inactive country');}
  const state=Object.freeze({...base,revision,countriesById:countries,countryOrder:order,retiredCountryIds:retired,territoriesById:territories});validatedWorlds.add(state);return state;
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
