import type {CountryRenameV2Command} from "../commands/country-rename-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity, type CountryEntity} from "../world/country-entity";
import type {ActiveCountryId, RetiredCountryId} from "../world/country-id";
import {buildDomainRootHash} from "../world/domain-hash-root";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type CountryRenamePatch = Readonly<{kind: "country.rename"; countryId: ActiveCountryId; changedFields: readonly string[]}>;
const root = (countries: WorldStateV2["countriesById"]) => buildDomainRootHash("countries", Object.fromEntries(Object.entries(countries).sort().map(([id, country]) => [id, countryCoreLeafHash(country)])));

export function planCountryRename(state: WorldStateV2, command: CountryRenameV2Command, context: PlannerContext): PlanResult<CountryRenamePatch> {
  return dryRunPlanner(state, command, context, () => {
    const countryId = command.payload.countryId as ActiveCountryId;
    const current = state.countriesById[countryId];
    if (!current) return planningError(state.retiredCountryIds.has(countryId as unknown as RetiredCountryId) ? "country-id-retired" : "country-not-found", command.commandId, `CountryId is not active: ${countryId}`);
    const changedFields = Object.keys(command.payload.changes).sort();
    const country = createCountryEntity({...current, names: {...current.names, ...command.payload.changes}, moduleVersions: {...current.moduleVersions, names: (current.moduleVersions.names ?? 0) + 1}});
    const countriesById = Object.freeze({...state.countriesById, [countryId]: country}) as Readonly<Record<string, CountryEntity>>;
    return successfulPlan({commandId: command.commandId, baseRevision: state.revision, nextState: Object.freeze({...state, revision: state.revision + 1, countriesById, hashRoots: Object.freeze({...state.hashRoots, countriesRootHash: root(countriesById)})}), patch: Object.freeze({kind: "country.rename", countryId, changedFields: Object.freeze(changedFields)})});
  });
}
