import type {CountryMergeV2Command} from "../commands/country-merge-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity, type CountryEntity} from "../world/country-entity";
import {
  allocateDynamicCountryId,
  issueCountryId,
  type ActiveCountryId,
  type RetiredCountryId,
} from "../world/country-id";
import {createCountryOrder} from "../world/country-order";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {createImmutableReadonlySet} from "../world/immutable-readonly-set";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryEntity} from "../world/territory-entity";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type CountryMergeMeasurements = Readonly<{
  sourceTerritoryCount: number;
  resultOwnedSourceTerritoryCount: number;
}>;

export type CountryMergePatch = Readonly<{
  kind: "country.merge";
  sourceCountryIds: readonly ActiveCountryId[];
  removedSourceCountryIds: readonly ActiveCountryId[];
  resultCountryId: ActiveCountryId;
  territoryOwnerChanges: Readonly<Record<string, ActiveCountryId>>;
  measurements: CountryMergeMeasurements;
}>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const TERRITORY_HASH_GEOMETRY_POLICY = Object.freeze({
  coordinatePrecision: 6,
  exteriorRingWinding: "counterclockwise" as const,
});

const countryHashRecord = (
  countriesById: WorldStateV2["countriesById"],
  hash: (country: CountryEntity) => string,
) => Object.fromEntries(
  Object.entries(countriesById)
    .sort(([left], [right]) => compareText(left, right))
    .map(([countryId, country]) => [countryId, hash(country)]),
);

const territoryHashRecord = (territoriesById: WorldStateV2["territoriesById"]) =>
  Object.fromEntries(
    Object.entries(territoriesById)
      .sort(([left], [right]) => compareText(left, right))
      .flatMap(([territoryId, territory]) => [
        [
          `geometry:${territoryId}`,
          territoryGeometryLeafHash(territory, TERRITORY_HASH_GEOMETRY_POLICY),
        ],
        [`ownership:${territoryId}`, territoryOwnershipLeafHash(territory)],
      ]),
  );

const countryError = (
  state: WorldStateV2,
  countryId: string,
  commandId: string,
  role: "source" | "result",
) => state.retiredCountryIds.has(countryId as RetiredCountryId)
  ? planningError(
      "country-id-retired",
      commandId,
      `${role} CountryId is retired: ${countryId}`,
    )
  : planningError(
      "country-not-found",
      commandId,
      `${role} CountryId is not active: ${countryId}`,
    );

const inheritMetadata = (
  base: CountryEntity,
  source: CountryEntity,
  fields: readonly ("names" | "politicalStatus" | "presentationOverride" | "moduleVersions")[],
) => createCountryEntity({
  id: base.id,
  names: fields.includes("names") ? source.names : base.names,
  politicalStatus: fields.includes("politicalStatus")
    ? source.politicalStatus
    : base.politicalStatus,
  presentationOverride: fields.includes("presentationOverride")
    ? source.presentationOverride
    : base.presentationOverride,
  moduleVersions: fields.includes("moduleVersions")
    ? source.moduleVersions
    : base.moduleVersions,
});

export function planCountryMerge(
  state: WorldStateV2,
  command: CountryMergeV2Command,
  context: PlannerContext,
): PlanResult<CountryMergePatch> {
  return dryRunPlanner(state, command, context, () => {
    const sourceCountryIds = command.payload.sourceCountryIds as ActiveCountryId[];
    if (new Set(sourceCountryIds).size !== sourceCountryIds.length) {
      return planningError(
        "merge-source-country-duplicate",
        command.commandId,
        "Country merge source CountryIds must be unique",
      );
    }
    for (const sourceCountryId of sourceCountryIds) {
      if (!state.countriesById[sourceCountryId]) {
        return countryError(state, sourceCountryId, command.commandId, "source");
      }
    }

    let resultCountry: CountryEntity;
    if (command.payload.resultCountry.kind === "existing-country") {
      const requestedId = command.payload.resultCountry.countryId as ActiveCountryId;
      const existing = state.countriesById[requestedId];
      if (!existing) return countryError(state, requestedId, command.commandId, "result");
      resultCountry = existing;
    } else {
      const requestedId = command.payload.resultCountry.country.id;
      if (requestedId !== undefined && Object.hasOwn(state.countriesById, requestedId)) {
        return planningError(
          "country-id-active",
          command.commandId,
          `Result CountryId is already active: ${requestedId}`,
        );
      }
      if (requestedId !== undefined && state.retiredCountryIds.has(requestedId as RetiredCountryId)) {
        return planningError(
          "country-id-retired",
          command.commandId,
          `Result CountryId is retired and cannot be reissued: ${requestedId}`,
        );
      }
      const registry = {
        activeCountryIds: new Set(Object.keys(state.countriesById) as ActiveCountryId[]),
        retiredCountryIds: state.retiredCountryIds,
      };
      const resultCountryId = requestedId === undefined
        ? allocateDynamicCountryId(registry)
        : issueCountryId(requestedId, registry);
      resultCountry = createCountryEntity({
        ...command.payload.resultCountry.country,
        id: resultCountryId,
      });
    }

    const inheritance = command.payload.metadataInheritance;
    if (inheritance.mode === "inherit-source") {
      const metadataSourceId = inheritance.sourceCountryId as ActiveCountryId;
      if (!sourceCountryIds.includes(metadataSourceId)) {
        return planningError(
          "merge-metadata-source-invalid",
          command.commandId,
          `Metadata source ${metadataSourceId} must be one of the merge source Countries`,
        );
      }
      resultCountry = inheritMetadata(
        resultCountry,
        state.countriesById[metadataSourceId],
        inheritance.fields,
      );
    }

    const resultCountryId = resultCountry.id;
    const removedSourceCountryIds = sourceCountryIds
      .filter((countryId) => countryId !== resultCountryId)
      .sort(compareText);
    const removedSourceSet = new Set(removedSourceCountryIds);
    const countriesByIdMutable = Object.fromEntries(
      Object.entries(state.countriesById).filter(([countryId]) => !removedSourceSet.has(
        countryId as ActiveCountryId,
      )),
    ) as Record<string, CountryEntity>;
    countriesByIdMutable[resultCountryId] = resultCountry;
    const countriesById = Object.freeze(countriesByIdMutable);

    const sourceCountryIdSet = new Set(sourceCountryIds);
    const territoriesByIdMutable: Record<string, TerritoryEntity> = {};
    const territoryOwnerChangesMutable: Record<string, ActiveCountryId> = {};
    let sourceTerritoryCount = 0;
    for (const territoryId of state.territoryOrder) {
      const territory = state.territoriesById[territoryId];
      if (
        territory.ownerCountryId === null ||
        !sourceCountryIdSet.has(territory.ownerCountryId)
      ) {
        territoriesByIdMutable[territoryId] = territory;
        continue;
      }
      sourceTerritoryCount += 1;
      territoryOwnerChangesMutable[territoryId] = resultCountryId;
      territoriesByIdMutable[territoryId] = territory.ownerCountryId === resultCountryId
        ? territory
        : createTerritoryEntity({...territory, ownerCountryId: resultCountryId});
    }
    const territoriesById = Object.freeze(territoriesByIdMutable);
    const resultOwnedSourceTerritoryCount = Object.keys(territoryOwnerChangesMutable).filter(
      (territoryId) => territoriesById[territoryId].ownerCountryId === resultCountryId,
    ).length;
    const measurements: CountryMergeMeasurements = Object.freeze({
      sourceTerritoryCount,
      resultOwnedSourceTerritoryCount,
    });
    const nextState: WorldStateV2 = Object.freeze({
      ...state,
      revision: state.revision + 1,
      countriesById,
      countryOrder: createCountryOrder(Object.keys(countriesById) as ActiveCountryId[]),
      retiredCountryIds: createImmutableReadonlySet([
        ...state.retiredCountryIds,
        ...removedSourceCountryIds.map(
          (countryId) => countryId as unknown as RetiredCountryId,
        ),
      ]),
      territoriesById,
      hashRoots: Object.freeze({
        ...state.hashRoots,
        countriesRootHash: buildDomainRootHash(
          "countries",
          countryHashRecord(countriesById, countryCoreLeafHash),
        ),
        presentationRootHash: buildDomainRootHash(
          "presentation",
          countryHashRecord(
            countriesById,
            (country) => countryPresentationLeafHash(country, state.policyVersion),
          ),
        ),
        territoriesRootHash: buildDomainRootHash(
          "territories",
          territoryHashRecord(territoriesById),
        ),
      }),
    });

    return successfulPlan({
      commandId: command.commandId,
      baseRevision: state.revision,
      nextState,
      patch: Object.freeze({
        kind: "country.merge",
        sourceCountryIds: Object.freeze([...sourceCountryIds].sort(compareText)),
        removedSourceCountryIds: Object.freeze(removedSourceCountryIds),
        resultCountryId,
        territoryOwnerChanges: Object.freeze(territoryOwnerChangesMutable),
        measurements,
      }),
    });
  });
}
