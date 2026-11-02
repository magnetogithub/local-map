import type {CountryEstablishV2Command} from "../commands/country-establish-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity, type CountryEntity} from "../world/country-entity";
import {allocateDynamicCountryId, issueCountryId, type ActiveCountryId, type RetiredCountryId} from "../world/country-id";
import {addCountryToOrder} from "../world/country-order";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import type {TerritoryEntity} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type CountryEstablishPatch = Readonly<{kind: "country.establish"; countryId: ActiveCountryId; territoryIds: readonly TerritoryId[]}>;
const countryRecord = (countries: Readonly<Record<string, CountryEntity>>, hash: (c: CountryEntity) => string) => Object.fromEntries(Object.entries(countries).sort().map(([id,c]) => [id,hash(c)]));
const territoryRecord = (territories: Readonly<Record<string, TerritoryEntity>>) => Object.fromEntries(Object.entries(territories).sort().flatMap(([id,t]) => [[`geometry:${id}`,territoryGeometryLeafHash(t,{coordinatePrecision:6,exteriorRingWinding:"counterclockwise"})],[`ownership:${id}`,territoryOwnershipLeafHash(t)]]));

export function planCountryEstablish(state: WorldStateV2, command: CountryEstablishV2Command, context: PlannerContext): PlanResult<CountryEstablishPatch> {
  return dryRunPlanner(state, command, context, () => {
    const requested = command.payload.country.id;
    if (requested !== undefined && Object.hasOwn(state.countriesById, requested)) return planningError("country-id-active", command.commandId, `CountryId is already active: ${requested}`);
    if (requested !== undefined && state.retiredCountryIds.has(requested as RetiredCountryId)) return planningError("country-id-retired", command.commandId, `CountryId is retired: ${requested}`);
    const seen = new Set<string>();
    for (const territoryId of command.payload.territoryIds) {
      if (seen.has(territoryId)) return planningError("territory-id-duplicate", command.commandId, `TerritoryId is duplicated: ${territoryId}`); seen.add(territoryId);
      const territory = state.territoriesById[territoryId];
      if (!territory) return planningError("territory-not-found", command.commandId, `TerritoryId is not active: ${territoryId}`);
      if (territory.ownerCountryId !== null) return planningError("territory-already-owned", command.commandId, `Territory is already owned: ${territoryId}`);
    }
    const registry = {activeCountryIds:new Set(Object.keys(state.countriesById) as ActiveCountryId[]), retiredCountryIds:state.retiredCountryIds};
    const countryId = requested === undefined ? allocateDynamicCountryId(registry) : issueCountryId(requested, registry);
    const country = createCountryEntity({...command.payload.country,id:countryId});
    const countriesById = Object.freeze({...state.countriesById,[countryId]:country});
    const selected = new Set<string>(command.payload.territoryIds);
    const territoriesById = Object.freeze(Object.fromEntries(state.territoryOrder.map(id => { const t=state.territoriesById[id]; return [id,selected.has(id)?Object.freeze({...t,ownerCountryId:countryId}):t]; }))) as Readonly<Record<string,TerritoryEntity>>;
    const hashRoots = Object.freeze({...state.hashRoots,countriesRootHash:buildDomainRootHash("countries",countryRecord(countriesById,countryCoreLeafHash)),presentationRootHash:buildDomainRootHash("presentation",countryRecord(countriesById,c=>countryPresentationLeafHash(c,state.policyVersion))),territoriesRootHash:buildDomainRootHash("territories",territoryRecord(territoriesById))});
    return successfulPlan({commandId:command.commandId,baseRevision:state.revision,nextState:Object.freeze({...state,revision:state.revision+1,countriesById,countryOrder:addCountryToOrder(state.countryOrder,countryId),territoriesById,hashRoots}),patch:Object.freeze({kind:"country.establish",countryId,territoryIds:Object.freeze([...command.payload.territoryIds])})});
  });
}
