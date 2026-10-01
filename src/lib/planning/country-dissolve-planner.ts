import type {CountryDissolveV2Command} from "../commands/country-dissolve-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity, type CountryEntity} from "../world/country-entity";
import type {ActiveCountryId, RetiredCountryId} from "../world/country-id";
import {removeCountryFromOrder} from "../world/country-order";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {createImmutableReadonlySet} from "../world/immutable-readonly-set";
import {territoryGeometryLeafHash} from "../world/territory-geometry-hash";
import {createTerritoryEntity, type TerritoryEntity} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

type CountryMetadataField = Exclude<keyof CountryEntity, "id">;

export type DissolveMergeMetadataSuccession = Readonly<{
  names: "preserve-target-display-and-inherit-source-search-aliases";
  politicalStatus: "preserve-target";
  presentationOverride: "preserve-target";
  moduleVersions: "maximum-version-per-module";
}>;

/**
 * A dissolve-merge always retains the target identity. Source identity remains
 * searchable, module migrations never move backwards, and geometry-derived
 * presentation plus political status continue to belong to the target.
 */
export const DISSOLVE_MERGE_METADATA_SUCCESSION = Object.freeze({
  names: "preserve-target-display-and-inherit-source-search-aliases",
  politicalStatus: "preserve-target",
  presentationOverride: "preserve-target",
  moduleVersions: "maximum-version-per-module",
} satisfies Record<CountryMetadataField, string>) as DissolveMergeMetadataSuccession;

export type CountryDissolvePatch = Readonly<{
  kind: "country.dissolve";
  sourceCountryId: ActiveCountryId;
  territoryOwnerChanges: Readonly<Record<string, ActiveCountryId | null>>;
  metadataSuccessionByTarget: Readonly<Record<string, Readonly<{
    sourceCountryId: ActiveCountryId;
    fields: DissolveMergeMetadataSuccession;
  }>>>;
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

const mergedSearchAliases = (target: CountryEntity, source: CountryEntity) =>
  Object.freeze([
    ...new Set([
      ...target.names.searchAliases,
      source.id,
      source.names.shortKo,
      source.names.officialKo,
      source.names.mapKo,
      source.names.english,
      ...source.names.searchAliases,
    ]),
  ].sort(compareText));

const mergedModuleVersions = (target: CountryEntity, source: CountryEntity) =>
  Object.freeze(Object.fromEntries(
    [...new Set([
      ...Object.keys(target.moduleVersions),
      ...Object.keys(source.moduleVersions),
    ])]
      .sort(compareText)
      .map((moduleName) => [
        moduleName,
        Math.max(target.moduleVersions[moduleName] ?? 0, source.moduleVersions[moduleName] ?? 0),
      ]),
  ));

export function applyDissolveMergeMetadataSuccession(
  target: CountryEntity,
  source: CountryEntity,
): CountryEntity {
  return createCountryEntity({
    id: target.id,
    names: {...target.names, searchAliases: mergedSearchAliases(target, source)},
    politicalStatus: target.politicalStatus,
    presentationOverride: target.presentationOverride,
    moduleVersions: mergedModuleVersions(target, source),
  });
}

const countryError = (
  state: WorldStateV2,
  countryId: string,
  commandId: string,
  role: "source" | "target",
) => {
  if (state.retiredCountryIds.has(countryId as RetiredCountryId)) {
    return planningError(
      "country-id-retired",
      commandId,
      `${role} CountryId is retired: ${countryId}`,
    );
  }
  return planningError(
    "country-not-found",
    commandId,
    `${role} CountryId is not active: ${countryId}`,
  );
};

export function planCountryDissolve(
  state: WorldStateV2,
  command: CountryDissolveV2Command,
  context: PlannerContext,
): PlanResult<CountryDissolvePatch> {
  return dryRunPlanner(state, command, context, () => {
    const sourceCountryId = command.payload.sourceCountryId as ActiveCountryId;
    const source = state.countriesById[sourceCountryId];
    if (!source) return countryError(state, sourceCountryId, command.commandId, "source");
    if (state.countryOrder.length <= 1) {
      return planningError(
        "last-country-delete",
        command.commandId,
        "country.dissolve cannot delete the last active Country",
      );
    }

    const sourceTerritoryIds = state.territoryOrder.filter(
      (territoryId) => state.territoriesById[territoryId].ownerCountryId === sourceCountryId,
    );
    const dispositionByTerritoryId = new Map<TerritoryId, ActiveCountryId | null>();
    const mergeTargetIds = new Set<ActiveCountryId>();

    for (const entry of command.payload.territoryDispositions) {
      const territoryId = entry.territoryId as TerritoryId;
      const territory = state.territoriesById[territoryId];
      if (!territory) {
        return planningError(
          "territory-not-found",
          command.commandId,
          `TerritoryId is not active: ${territoryId}`,
        );
      }
      if (territory.ownerCountryId !== sourceCountryId) {
        return planningError(
          "territory-not-owned-by-source",
          command.commandId,
          `Territory ${territoryId} is not owned by ${sourceCountryId}`,
        );
      }
      if (dispositionByTerritoryId.has(territoryId)) {
        return planningError(
          "territory-disposition-duplicate",
          command.commandId,
          `Territory ${territoryId} has more than one disposition`,
        );
      }

      if (entry.disposition.type === "unclaim") {
        dispositionByTerritoryId.set(territoryId, null);
        continue;
      }

      const targetCountryId = entry.disposition.targetCountryId as ActiveCountryId;
      if (targetCountryId === sourceCountryId) {
        return planningError(
          "country-target-self",
          command.commandId,
          `Dissolve target cannot equal source CountryId ${sourceCountryId}`,
        );
      }
      if (!state.countriesById[targetCountryId]) {
        return countryError(state, targetCountryId, command.commandId, "target");
      }
      dispositionByTerritoryId.set(territoryId, targetCountryId);
      if (entry.disposition.type === "merge") mergeTargetIds.add(targetCountryId);
    }

    const missingTerritoryIds = sourceTerritoryIds.filter(
      (territoryId) => !dispositionByTerritoryId.has(territoryId),
    );
    if (missingTerritoryIds.length > 0) {
      return planningError(
        "territory-disposition-missing",
        command.commandId,
        `Every source Territory requires a disposition; missing ${missingTerritoryIds.join(",")}`,
      );
    }

    const countriesByIdMutable = Object.fromEntries(
      Object.entries(state.countriesById).filter(([countryId]) => countryId !== sourceCountryId),
    ) as Record<string, CountryEntity>;
    const metadataSuccessionByTargetMutable: Record<string, {
      sourceCountryId: ActiveCountryId;
      fields: DissolveMergeMetadataSuccession;
    }> = {};
    for (const targetCountryId of [...mergeTargetIds].sort(compareText)) {
      countriesByIdMutable[targetCountryId] = applyDissolveMergeMetadataSuccession(
        countriesByIdMutable[targetCountryId],
        source,
      );
      metadataSuccessionByTargetMutable[targetCountryId] = Object.freeze({
        sourceCountryId,
        fields: DISSOLVE_MERGE_METADATA_SUCCESSION,
      });
    }
    const countriesById = Object.freeze(countriesByIdMutable);

    const territoriesByIdMutable: Record<string, TerritoryEntity> = {};
    const territoryOwnerChangesMutable: Record<string, ActiveCountryId | null> = {};
    for (const territoryId of state.territoryOrder) {
      const territory = state.territoriesById[territoryId];
      if (!dispositionByTerritoryId.has(territoryId)) {
        territoriesByIdMutable[territoryId] = territory;
        continue;
      }
      const ownerCountryId = dispositionByTerritoryId.get(territoryId)!;
      territoriesByIdMutable[territoryId] = createTerritoryEntity({...territory, ownerCountryId});
      territoryOwnerChangesMutable[territoryId] = ownerCountryId;
    }
    const territoriesById = Object.freeze(territoriesByIdMutable);
    const countriesRootHash = buildDomainRootHash(
      "countries",
      countryHashRecord(countriesById, countryCoreLeafHash),
    );
    const presentationRootHash = buildDomainRootHash(
      "presentation",
      countryHashRecord(
        countriesById,
        (country) => countryPresentationLeafHash(country, state.policyVersion),
      ),
    );
    const territoriesRootHash = buildDomainRootHash(
      "territories",
      territoryHashRecord(territoriesById),
    );
    const nextState: WorldStateV2 = Object.freeze({
      ...state,
      revision: state.revision + 1,
      countriesById,
      countryOrder: removeCountryFromOrder(state.countryOrder, sourceCountryId),
      retiredCountryIds: createImmutableReadonlySet([
        ...state.retiredCountryIds,
        sourceCountryId as unknown as RetiredCountryId,
      ]),
      territoriesById,
      hashRoots: Object.freeze({
        ...state.hashRoots,
        countriesRootHash,
        presentationRootHash,
        territoriesRootHash,
      }),
    });

    return successfulPlan({
      commandId: command.commandId,
      baseRevision: state.revision,
      nextState,
      patch: Object.freeze({
        kind: "country.dissolve",
        sourceCountryId,
        territoryOwnerChanges: Object.freeze(territoryOwnerChangesMutable),
        metadataSuccessionByTarget: Object.freeze(metadataSuccessionByTargetMutable),
      }),
    });
  });
}

export const planDissolveMerge = planCountryDissolve;
