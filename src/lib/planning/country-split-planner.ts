import type {CountrySplitV2Command} from "../commands/country-split-v2";
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
import {
  createTerritoryEntity,
  type TerritoryEntity,
  type TerritoryGeometry,
  type TerritoryPosition,
} from "../world/territory-entity";
import type {TerritoryId} from "../world/territory-id";
import {territoryOwnershipLeafHash} from "../world/territory-ownership-hash";
import type {WorldStateV2} from "../world/world-state-v2";
import {planningError, successfulPlan, type PlanResult} from "./plan-result";
import {dryRunPlanner, type PlannerContext} from "./planner-boundary";

export type CountrySplitMeasurements = Readonly<{
  sourceTerritoryCount: number;
  assignedTerritoryCount: number;
  sourceArea: number;
  assignedArea: number;
  gapArea: number;
  overlapArea: number;
}>;

export type CountrySplitPatch = Readonly<{
  kind: "country.split";
  sourceCountryId: ActiveCountryId;
  resultCountryIds: readonly ActiveCountryId[];
  territoryOwnerChanges: Readonly<Record<string, ActiveCountryId>>;
  measurements: CountrySplitMeasurements;
}>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const TERRITORY_HASH_GEOMETRY_POLICY = Object.freeze({
  coordinatePrecision: 6,
  exteriorRingWinding: "counterclockwise" as const,
});

const ringArea = (ring: readonly TerritoryPosition[]) => Math.abs(
  ring.slice(0, -1).reduce((area, position, index) => {
    const next = ring[index + 1];
    return area + position[0] * next[1] - next[0] * position[1];
  }, 0) / 2,
);

const geometryArea = (geometry: TerritoryGeometry) => {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.reduce((total, polygon) => total + Math.max(
    0,
    ringArea(polygon[0]) - polygon.slice(1).reduce(
      (holes, hole) => holes + ringArea(hole),
      0,
    ),
  ), 0);
};

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

export function planCountrySplit(
  state: WorldStateV2,
  command: CountrySplitV2Command,
  context: PlannerContext,
): PlanResult<CountrySplitPatch> {
  return dryRunPlanner(state, command, context, () => {
    const sourceCountryId = command.payload.sourceCountryId as ActiveCountryId;
    if (!state.countriesById[sourceCountryId]) {
      return countryError(state, sourceCountryId, command.commandId, "source");
    }

    const requestedResultIds = command.payload.resultCountries
      .map(({country}) => country.id)
      .filter((countryId): countryId is string => countryId !== undefined);
    if (new Set(requestedResultIds).size !== requestedResultIds.length) {
      return planningError(
        "split-result-country-duplicate",
        command.commandId,
        "Country split result CountryIds must be unique",
      );
    }
    for (const requestedId of requestedResultIds) {
      if (Object.hasOwn(state.countriesById, requestedId)) {
        return planningError(
          "country-id-active",
          command.commandId,
          `Result CountryId is already active: ${requestedId}`,
        );
      }
      if (state.retiredCountryIds.has(requestedId as RetiredCountryId)) {
        return planningError(
          "country-id-retired",
          command.commandId,
          `Result CountryId is retired and cannot be reissued: ${requestedId}`,
        );
      }
    }

    const sourceTerritoryIds = state.territoryOrder.filter(
      (territoryId) => state.territoriesById[territoryId].ownerCountryId === sourceCountryId,
    );
    const sourceTerritoryIdSet = new Set(sourceTerritoryIds);
    const ownerByTerritoryId = new Map<TerritoryId, ActiveCountryId>();
    const resultCountryIds: ActiveCountryId[] = [];
    const registry = {
      activeCountryIds: new Set(Object.keys(state.countriesById) as ActiveCountryId[]),
      retiredCountryIds: state.retiredCountryIds,
    };

    for (const result of command.payload.resultCountries) {
      const resultCountryId = result.country.id === undefined
        ? allocateDynamicCountryId(registry, [...resultCountryIds, ...requestedResultIds])
        : issueCountryId(result.country.id, {
            ...registry,
            activeCountryIds: new Set([...registry.activeCountryIds, ...resultCountryIds]),
          });
      resultCountryIds.push(resultCountryId);
      for (const reference of result.territorySources) {
        if (reference.kind === "partition-result") {
          return planningError(
            "partition-result-unresolved",
            command.commandId,
            `Partition result ${reference.commandId}:${reference.partitionKey} must be resolved by the batch planner`,
          );
        }
        const territoryId = reference.territoryId as TerritoryId;
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
        if (ownerByTerritoryId.has(territoryId)) {
          return planningError(
            "territory-source-duplicate",
            command.commandId,
            `Territory ${territoryId} is assigned to more than one split result`,
          );
        }
        ownerByTerritoryId.set(territoryId, resultCountryId);
      }
    }

    const missingTerritoryIds = sourceTerritoryIds.filter(
      (territoryId) => !ownerByTerritoryId.has(territoryId),
    );
    if (missingTerritoryIds.length > 0) {
      return planningError(
        "territory-source-missing",
        command.commandId,
        `Every source Territory must be assigned; missing ${missingTerritoryIds.join(",")}`,
      );
    }
    const unexpectedTerritoryId = [...ownerByTerritoryId.keys()].find(
      (territoryId) => !sourceTerritoryIdSet.has(territoryId),
    );
    if (unexpectedTerritoryId) {
      return planningError(
        "territory-not-owned-by-source",
        command.commandId,
        `Territory ${unexpectedTerritoryId} is not owned by ${sourceCountryId}`,
      );
    }

    const countriesByIdMutable = Object.fromEntries(
      Object.entries(state.countriesById).filter(([countryId]) => countryId !== sourceCountryId),
    ) as Record<string, CountryEntity>;
    command.payload.resultCountries.forEach((result, index) => {
      const resultCountryId = resultCountryIds[index];
      countriesByIdMutable[resultCountryId] = createCountryEntity({
        ...result.country,
        id: resultCountryId,
      });
    });
    const countriesById = Object.freeze(countriesByIdMutable);

    const territoriesByIdMutable: Record<string, TerritoryEntity> = {};
    const territoryOwnerChangesMutable: Record<string, ActiveCountryId> = {};
    for (const territoryId of state.territoryOrder) {
      const territory = state.territoriesById[territoryId];
      const ownerCountryId = ownerByTerritoryId.get(territoryId);
      if (!ownerCountryId) {
        territoriesByIdMutable[territoryId] = territory;
        continue;
      }
      territoriesByIdMutable[territoryId] = createTerritoryEntity({...territory, ownerCountryId});
      territoryOwnerChangesMutable[territoryId] = ownerCountryId;
    }
    const territoriesById = Object.freeze(territoriesByIdMutable);
    const sourceArea = sourceTerritoryIds.reduce(
      (total, territoryId) => total + geometryArea(state.territoriesById[territoryId].geometry),
      0,
    );
    const assignedArea = [...ownerByTerritoryId.keys()].reduce(
      (total, territoryId) => total + geometryArea(state.territoriesById[territoryId].geometry),
      0,
    );
    const measurements: CountrySplitMeasurements = Object.freeze({
      sourceTerritoryCount: sourceTerritoryIds.length,
      assignedTerritoryCount: ownerByTerritoryId.size,
      sourceArea,
      assignedArea,
      gapArea: 0,
      overlapArea: 0,
    });
    const nextState: WorldStateV2 = Object.freeze({
      ...state,
      revision: state.revision + 1,
      countriesById,
      countryOrder: createCountryOrder(Object.keys(countriesById) as ActiveCountryId[]),
      retiredCountryIds: createImmutableReadonlySet([
        ...state.retiredCountryIds,
        sourceCountryId as unknown as RetiredCountryId,
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
        kind: "country.split",
        sourceCountryId,
        resultCountryIds: Object.freeze([...resultCountryIds].sort(compareText)),
        territoryOwnerChanges: Object.freeze(territoryOwnerChangesMutable),
        measurements,
      }),
    });
  });
}
