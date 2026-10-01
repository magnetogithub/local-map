import type {CountryDeleteV2Command} from "../commands/country-delete-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import type {ActiveCountryId, RetiredCountryId} from "../world/country-id";
import {removeCountryFromOrder} from "../world/country-order";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {createImmutableReadonlySet} from "../world/immutable-readonly-set";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type CountryDeletePatch = Readonly<{kind:"country.delete";countryId:ActiveCountryId}>;
export function planCountryDelete(state:WorldStateV2,command:CountryDeleteV2Command,context:PlannerContext):PlanResult<CountryDeletePatch>{return dryRunPlanner(state,command,context,()=>{
  const countryId=command.payload.countryId as ActiveCountryId;
  if(!state.countriesById[countryId]) return planningError(state.retiredCountryIds.has(countryId as unknown as RetiredCountryId)?"country-id-retired":"country-not-found",command.commandId,`CountryId is not active: ${countryId}`);
  if(Object.values(state.territoriesById).some(t=>t.ownerCountryId===countryId)) return planningError("country-has-territories",command.commandId,`Country still owns Territories: ${countryId}`);
  if(state.countryOrder.length<=1) return planningError("last-country-delete",command.commandId,"country.delete cannot delete the last active Country");
  const countriesById=Object.freeze(Object.fromEntries(Object.entries(state.countriesById).filter(([id])=>id!==countryId)));
  const records=(hash:(c:WorldStateV2["countriesById"][string])=>string)=>Object.fromEntries(Object.entries(countriesById).sort().map(([id,c])=>[id,hash(c)]));
  return successfulPlan({commandId:command.commandId,baseRevision:state.revision,nextState:Object.freeze({...state,revision:state.revision+1,countriesById,countryOrder:removeCountryFromOrder(state.countryOrder,countryId),retiredCountryIds:createImmutableReadonlySet([...state.retiredCountryIds,countryId as unknown as RetiredCountryId]),hashRoots:Object.freeze({...state.hashRoots,countriesRootHash:buildDomainRootHash("countries",records(countryCoreLeafHash)),presentationRootHash:buildDomainRootHash("presentation",records(c=>countryPresentationLeafHash(c,state.policyVersion)))})}),patch:Object.freeze({kind:"country.delete",countryId})});
});}
