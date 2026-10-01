import type {CountryCreateV2Command} from "../commands/country-create-v2";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {
  allocateDynamicCountryId,
  issueCountryId,
  type ActiveCountryId,
  type RetiredCountryId,
} from "../world/country-id";
import {addCountryToOrder} from "../world/country-order";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type CountryCreatePatch = Readonly<{
  kind: "country.create";
  countryId: ActiveCountryId;
}>;

const countryHashRecord = (
  countriesById: WorldStateV2["countriesById"],
  hash: (country: WorldStateV2["countriesById"][string]) => string,
) => Object.fromEntries(Object.keys(countriesById).sort().map((countryId) => [
  countryId,
  hash(countriesById[countryId]),
]));

export function planCountryCreate(
  state: WorldStateV2,
  command: CountryCreateV2Command,
  context: PlannerContext,
): PlanResult<CountryCreatePatch> {
  return dryRunPlanner(state, command, context, () => {
    const requestedId = command.payload.country.id;
    if (requestedId !== undefined && Object.hasOwn(state.countriesById, requestedId)) {
      return planningError(
        "country-id-active",
        command.commandId,
        `CountryId is already active: ${requestedId}`,
      );
    }
    if (requestedId !== undefined && state.retiredCountryIds.has(requestedId as RetiredCountryId)) {
      return planningError(
        "country-id-retired",
        command.commandId,
        `CountryId is retired and cannot be reissued: ${requestedId}`,
      );
    }

    const registry = {
      activeCountryIds: new Set(Object.keys(state.countriesById) as ActiveCountryId[]),
      retiredCountryIds: state.retiredCountryIds,
    };
    const countryId = requestedId === undefined
      ? allocateDynamicCountryId(registry)
      : issueCountryId(requestedId, registry);
    const country = createCountryEntity({...command.payload.country, id: countryId});
    const countriesById = Object.freeze({...state.countriesById, [countryId]: country});
    const countryOrder = addCountryToOrder(state.countryOrder, countryId);
    const countriesRootHash = buildDomainRootHash(
      "countries",
      countryHashRecord(countriesById, countryCoreLeafHash),
    );
    const presentationRootHash = buildDomainRootHash(
      "presentation",
      countryHashRecord(
        countriesById,
        (value) => countryPresentationLeafHash(value, state.policyVersion),
      ),
    );
    const nextState: WorldStateV2 = Object.freeze({
      ...state,
      revision: state.revision + 1,
      countriesById,
      countryOrder,
      hashRoots: Object.freeze({...state.hashRoots, countriesRootHash, presentationRootHash}),
    });

    return successfulPlan({
      commandId: command.commandId,
      baseRevision: state.revision,
      nextState,
      patch: Object.freeze({kind: "country.create", countryId}),
    });
  });
}
