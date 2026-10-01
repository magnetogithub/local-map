import polygonClipping, {type MultiPolygon} from "polygon-clipping";

import {parseCommandBatchV2Command, type CommandBatchV2Command} from "../commands/command-batch-v2";
import {allocateDynamicCountryId, type ActiveCountryId} from "../world/country-id";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import type {TerritoryGeometry} from "../world/territory-entity";
import {normalizeTopologyGeometry} from "../world/topology-geometry-policy";
import type {WorldStateV2} from "../world/world-state-v2";
import type {SubdivisionCatalog, MaterializedSubdivision} from "./subdivision-catalog";
import type {WorldEffectV1} from "./world-effect";

export type WorldEffectCompileErrorCode =
  | "STALE_WORLD_REVISION"
  | "UNKNOWN_COUNTRY"
  | "RETIRED_COUNTRY"
  | "UNKNOWN_TERRITORY"
  | "INVALID_OWNERSHIP"
  | "SELF_MERGE"
  | "EMPTY_TERRITORY_SET"
  | "SUBDIVISION_VERSION_MISMATCH"
  | "SUBDIVISION_DATA_UNAVAILABLE"
  | "SUBDIVISION_BOUNDARY_MISSING"
  | "SUBDIVISION_COVERAGE_MISMATCH"
  | "UNSUPPORTED_EFFECT_COMBINATION"
  | "COMMAND_SCHEMA_INVALID";

export class WorldEffectCompileError extends Error {
  readonly code: WorldEffectCompileErrorCode;
  readonly effectId: string | null;

  constructor(code: WorldEffectCompileErrorCode, message: string, effectId: string | null = null) {
    super(message);
    this.name = "WorldEffectCompileError";
    this.code = code;
    this.effectId = effectId;
  }
}

export type CommandIdAllocator = Readonly<{
  next(scope: string): string;
}>;

export function createSequentialCommandIdAllocator(turnId: string): CommandIdAllocator {
  let sequence = 0;
  return Object.freeze({
    next(scope) {
      sequence += 1;
      return `${turnId}:${sequence.toString().padStart(3, "0")}:${scope}`;
    },
  });
}

export type CompiledWorldEffects = Readonly<{
  batch: CommandBatchV2Command | null;
  allocatedCountryIdsByLocalRef: Readonly<Record<string, ActiveCountryId>>;
  commandCount: number;
}>;

type CompileCursor = {
  commands: unknown[];
  allocatedCountryIdsByLocalRef: Record<string, ActiveCountryId>;
  reservedCountryIds: string[];
};

const countryIdentity = (id: ActiveCountryId, displayName: string) => ({
  id,
  names: {
    shortKo: displayName,
    officialKo: displayName,
    mapKo: displayName,
    english: displayName,
    searchAliases: [displayName],
  },
  politicalStatus: "sovereign" as const,
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const requireCountry = (world: WorldStateV2, countryId: string, effectId: string) => {
  const country = world.countriesById[countryId];
  if (country) return country;
  if ([...world.retiredCountryIds].includes(countryId as never)) {
    throw new WorldEffectCompileError(
      "RETIRED_COUNTRY",
      `Country is retired: ${countryId}`,
      effectId,
    );
  }
  throw new WorldEffectCompileError(
    "UNKNOWN_COUNTRY",
    `Country is not active: ${countryId}`,
    effectId,
  );
};

const allocateCountry = (
  world: WorldStateV2,
  cursor: CompileCursor,
  localRef: string,
  effectId: string,
) => {
  if (cursor.allocatedCountryIdsByLocalRef[localRef]) {
    throw new WorldEffectCompileError(
      "COMMAND_SCHEMA_INVALID",
      `Duplicate result-country local ref: ${localRef}`,
      effectId,
    );
  }
  const countryId = allocateDynamicCountryId({
    activeCountryIds: new Set(Object.keys(world.countriesById) as ActiveCountryId[]),
    retiredCountryIds: world.retiredCountryIds,
  }, cursor.reservedCountryIds);
  cursor.reservedCountryIds.push(countryId);
  cursor.allocatedCountryIdsByLocalRef[localRef] = countryId;
  return countryId;
};

const bindExistingCountry = (
  cursor: CompileCursor,
  localRef: string,
  countryId: ActiveCountryId,
  effectId: string,
) => {
  if (cursor.allocatedCountryIdsByLocalRef[localRef]) {
    throw new WorldEffectCompileError(
      "COMMAND_SCHEMA_INVALID",
      `Duplicate result-country local ref: ${localRef}`,
      effectId,
    );
  }
  cursor.allocatedCountryIdsByLocalRef[localRef] = countryId;
  return countryId;
};

const sourceTerritory = (
  world: WorldStateV2,
  sourceCountryId: string,
  effectId: string,
) => {
  const territoryIds = world.territoryOrder.filter((territoryId) =>
    world.territoriesById[territoryId].ownerCountryId === sourceCountryId);
  if (territoryIds.length !== 1) {
    throw new WorldEffectCompileError(
      "UNSUPPORTED_EFFECT_COMBINATION",
      `Subdivision compilation requires exactly one source territory; found ${territoryIds.length}`,
      effectId,
    );
  }
  return territoryIds[0];
};

const materializeCountryCatalog = (
  catalog: SubdivisionCatalog,
  sourceCountryId: string,
  sourceVersion: string,
  effectId: string,
) => {
  const summaries = catalog.listCountry(sourceCountryId);
  if (summaries.length === 0) {
    throw new WorldEffectCompileError(
      "SUBDIVISION_DATA_UNAVAILABLE",
      `No subdivision catalog exists for ${sourceCountryId}`,
      effectId,
    );
  }
  const entries: MaterializedSubdivision[] = [];
  for (const summary of summaries) {
    if (summary.ref.sourceVersion !== sourceVersion) {
      throw new WorldEffectCompileError(
        "SUBDIVISION_VERSION_MISMATCH",
        `Subdivision source version mismatch for ${summary.ref.subdivisionId}`,
        effectId,
      );
    }
    const entry = catalog.materialize(summary.ref);
    if (!entry) {
      throw new WorldEffectCompileError(
        "SUBDIVISION_BOUNDARY_MISSING",
        `Subdivision boundary is unavailable: ${summary.ref.subdivisionId}`,
        effectId,
      );
    }
    entries.push(entry);
  }
  return entries;
};

const MAX_SUBDIVISION_SOURCE_MISMATCH_RATIO = 1e-4;
const SUBDIVISION_REMAINDER_PARTITION_KEY = "__source-remainder__";

const geometryToMultiPolygon = (geometry: TerritoryGeometry): MultiPolygon =>
  (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as MultiPolygon;

const ringArea = (ring: readonly (readonly [number, number])[]) => Math.abs(
  ring.slice(0, -1).reduce((area, position, index) => {
    const next = ring[index + 1];
    return area + position[0] * next[1] - next[0] * position[1];
  }, 0) / 2,
);

const multiPolygonArea = (multiPolygon: MultiPolygon) => multiPolygon.reduce(
  (total, polygon) => total + Math.max(
    0,
    ringArea(polygon[0]) - polygon.slice(1).reduce((holes, ring) => holes + ringArea(ring), 0),
  ),
  0,
);

const multiPolygonToGeometry = (multiPolygon: MultiPolygon): TerritoryGeometry =>
  multiPolygon.length === 1
    ? {type: "Polygon", coordinates: multiPolygon[0]}
    : {type: "MultiPolygon", coordinates: multiPolygon};

const normalizeReconciliationGeometry = (geometry: TerritoryGeometry): TerritoryGeometry =>
  normalizeTopologyGeometry(geometry, {
    version: "subdivision-reconciliation-v1",
    coordinatePrecision: 5,
    exteriorRingWinding: "counterclockwise",
    minimumRingArea: 1e-12,
  });

/**
 * Admin-1 and country boundaries are independently versioned source products. Tiny
 * coastline differences are expected, but the domain partition command requires an
 * exact cover. Accept only a tightly bounded mismatch, clip each canonical entry to
 * the source, and preserve the remaining slivers as a deterministic source remainder.
 */
type ReconciledSubdivisionEntries = Readonly<{
  entries: readonly MaterializedSubdivision[];
  remainder: TerritoryGeometry | null;
}>;

const reconcileSubdivisionEntries = (
  world: WorldStateV2,
  sourceTerritoryId: TerritoryId,
  entries: readonly MaterializedSubdivision[],
  effectId: string,
): ReconciledSubdivisionEntries => {
  if (entries[0]?.ref.catalogId !== "natural-earth-admin1-v1") {
    return Object.freeze({entries, remainder: null});
  }
  const source = geometryToMultiPolygon(normalizeReconciliationGeometry(
    world.territoriesById[sourceTerritoryId].geometry,
  ));
  const subdivisions = entries.map((entry) => geometryToMultiPolygon(
    normalizeReconciliationGeometry(entry.geometry),
  ));
  let union: MultiPolygon;
  try {
    union = polygonClipping.union(subdivisions[0], ...subdivisions.slice(1));
    const sourceArea = multiPolygonArea(source);
    const mismatchArea = multiPolygonArea(polygonClipping.difference(source, union))
      + multiPolygonArea(polygonClipping.difference(union, source));
    const overlapArea = Math.max(
      0,
      subdivisions.reduce((sum, geometry) => sum + multiPolygonArea(geometry), 0)
        - multiPolygonArea(union),
    );
    if (
      sourceArea <= 0
      || mismatchArea / sourceArea > MAX_SUBDIVISION_SOURCE_MISMATCH_RATIO
      || overlapArea / sourceArea > MAX_SUBDIVISION_SOURCE_MISMATCH_RATIO
    ) {
      throw new WorldEffectCompileError(
        "SUBDIVISION_COVERAGE_MISMATCH",
        `Subdivision boundaries do not match source territory within ${MAX_SUBDIVISION_SOURCE_MISMATCH_RATIO}`,
        effectId,
      );
    }
  } catch (error) {
    if (error instanceof WorldEffectCompileError) throw error;
    throw new WorldEffectCompileError(
      "SUBDIVISION_COVERAGE_MISMATCH",
      `Subdivision boundary reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      effectId,
    );
  }

  const clippedEntries = entries.map((entry, index) => {
    const geometry = polygonClipping.intersection(subdivisions[index], source);
    if (geometry.length === 0 || multiPolygonArea(geometry) === 0) {
      throw new WorldEffectCompileError(
        "SUBDIVISION_COVERAGE_MISMATCH",
        `Subdivision has no area inside source territory: ${entry.ref.subdivisionId}`,
        effectId,
      );
    }
    return Object.freeze({
      ...entry,
      geometry: normalizeReconciliationGeometry(multiPolygonToGeometry(geometry)),
    });
  });
  const clippedUnion = polygonClipping.union(
    geometryToMultiPolygon(clippedEntries[0].geometry),
    ...clippedEntries.slice(1).map((entry) => geometryToMultiPolygon(entry.geometry)),
  );
  const remainder = polygonClipping.difference(source, clippedUnion);
  return Object.freeze({
    entries: Object.freeze(clippedEntries),
    remainder: multiPolygonArea(remainder) > 1e-10 ? multiPolygonToGeometry(remainder) : null,
  });
};

const reconcileSelectedProductionSubdivisions = (
  world: WorldStateV2,
  sourceTerritoryId: TerritoryId,
  entries: readonly MaterializedSubdivision[],
  effectId: string,
): ReconciledSubdivisionEntries => {
  const source = geometryToMultiPolygon(normalizeReconciliationGeometry(
    world.territoriesById[sourceTerritoryId].geometry,
  ));
  const selected = entries.map((entry) => geometryToMultiPolygon(
    normalizeReconciliationGeometry(entry.geometry),
  ));
  try {
    const selectedUnion = polygonClipping.union(selected[0], ...selected.slice(1));
    const selectedArea = multiPolygonArea(selectedUnion);
    const outsideArea = multiPolygonArea(polygonClipping.difference(selectedUnion, source));
    if (selectedArea <= 0 || outsideArea / selectedArea > MAX_SUBDIVISION_SOURCE_MISMATCH_RATIO) {
      throw new WorldEffectCompileError(
        "SUBDIVISION_COVERAGE_MISMATCH",
        `Selected subdivision boundaries do not match source territory within ${MAX_SUBDIVISION_SOURCE_MISMATCH_RATIO}`,
        effectId,
      );
    }
    const clipped = entries.map((entry, index) => {
      const geometry = polygonClipping.intersection(selected[index], source);
      if (geometry.length === 0 || multiPolygonArea(geometry) === 0) {
        throw new WorldEffectCompileError(
          "SUBDIVISION_COVERAGE_MISMATCH",
          `Subdivision has no area inside source territory: ${entry.ref.subdivisionId}`,
          effectId,
        );
      }
      return Object.freeze({
        ...entry,
        geometry: normalizeReconciliationGeometry(multiPolygonToGeometry(geometry)),
      });
    });
    const clippedUnion = polygonClipping.union(
      geometryToMultiPolygon(clipped[0].geometry),
      ...clipped.slice(1).map((entry) => geometryToMultiPolygon(entry.geometry)),
    );
    const remainder = polygonClipping.difference(source, clippedUnion);
    return Object.freeze({
      entries: Object.freeze(clipped),
      remainder: multiPolygonArea(remainder) > 1e-10 ? multiPolygonToGeometry(remainder) : null,
    });
  } catch (error) {
    if (error instanceof WorldEffectCompileError) throw error;
    throw new WorldEffectCompileError(
      "SUBDIVISION_COVERAGE_MISMATCH",
      `Selected subdivision reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      effectId,
    );
  }
};

const partitionCommand = (
  world: WorldStateV2,
  allocator: CommandIdAllocator,
  sourceTerritoryId: TerritoryId,
  reconciled: ReconciledSubdivisionEntries,
) => {
  const commandId = allocator.next("partition-subdivisions");
  const partitions = reconciled.entries.map((entry) => ({
    partitionKey: entry.ref.subdivisionId,
    geometry: entry.geometry,
  }));
  if (reconciled.remainder) {
    partitions.push({
      partitionKey: SUBDIVISION_REMAINDER_PARTITION_KEY,
      geometry: reconciled.remainder,
    });
  }
  return {
    commandId,
    type: "territory.partition",
    expectedRevision: world.revision,
    payload: {
      sourceTerritoryId,
      partitions,
    },
  } as const;
};

const derivedSubdivisionTerritoryId = (
  sourceTerritoryId: TerritoryId,
  subdivisionId: string,
) => deriveTerritoryId({
  kind: "partition",
  sourceTerritoryId,
  partitionKey: subdivisionId,
});

function compileSubdivisionEstablishments(
  effects: readonly Extract<WorldEffectV1, {type: "country.established"}>[],
  world: WorldStateV2,
  catalog: SubdivisionCatalog,
  allocator: CommandIdAllocator,
  cursor: CompileCursor,
) {
  const effect = effects[0];
  const sourceCountryId = effect?.sourceCountryId;
  if (!effect || sourceCountryId === null || sourceCountryId === undefined || effects.some((entry) => (
    entry.sourceCountryId === null
    || entry.sourceCountryId !== sourceCountryId
    || entry.territoryIds.length > 0
  ))) {
    throw new WorldEffectCompileError(
      "UNSUPPORTED_EFFECT_COMBINATION",
      "Grouped subdivision establishment requires one shared source country and no direct territory ids",
      effect?.effectId ?? null,
    );
  }
  requireCountry(world, sourceCountryId, effect.effectId);
  const allRefs = effects.flatMap((entry) => entry.subdivisionRefs);
  const firstRef = allRefs[0];
  if (!firstRef) {
    throw new WorldEffectCompileError(
      "EMPTY_TERRITORY_SET",
      "Subdivision establishment is empty",
      effect.effectId,
    );
  }
  if (allRefs.some((ref) =>
    ref.catalogId !== firstRef.catalogId || ref.sourceVersion !== firstRef.sourceVersion)) {
    throw new WorldEffectCompileError(
      "SUBDIVISION_VERSION_MISMATCH",
      "Subdivision references must share one catalog version",
      effect.effectId,
    );
  }
  const selectedIds = allRefs.map((ref) => ref.subdivisionId);
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new WorldEffectCompileError(
      "SUBDIVISION_COVERAGE_MISMATCH",
      "A subdivision can establish only one country in a turn",
      effect.effectId,
    );
  }
  const entries = materializeCountryCatalog(
    catalog,
    sourceCountryId,
    firstRef.sourceVersion,
    effect.effectId,
  );
  const entryIds = new Set(entries.map((entry) => entry.ref.subdivisionId));
  for (const ref of allRefs) {
    if (!entryIds.has(ref.subdivisionId) || !catalog.materialize(ref)) {
      throw new WorldEffectCompileError(
        "SUBDIVISION_BOUNDARY_MISSING",
        `Subdivision boundary is unavailable: ${ref.subdivisionId}`,
        effect.effectId,
      );
    }
  }
  const sourceTerritoryId = sourceTerritory(world, sourceCountryId, effect.effectId);
  const reconciledEntries = firstRef.catalogId === "natural-earth-admin1-v1"
    ? reconcileSelectedProductionSubdivisions(
        world,
        sourceTerritoryId,
        entries.filter((entry) => allRefs.some((ref) =>
          ref.subdivisionId === entry.ref.subdivisionId)),
        effect.effectId,
      )
    : reconcileSubdivisionEntries(world, sourceTerritoryId, entries, effect.effectId);
  cursor.commands.push(partitionCommand(world, allocator, sourceTerritoryId, reconciledEntries));
  const selectedTerritoryIds = allRefs.map((ref) =>
    derivedSubdivisionTerritoryId(sourceTerritoryId, ref.subdivisionId));
  cursor.commands.push({
    commandId: allocator.next("unclaim-independence-territories"),
    type: "territory.unclaim",
    expectedRevision: world.revision,
    payload: {territoryIds: selectedTerritoryIds},
  });
  for (const entry of effects) {
    const countryId = allocateCountry(world, cursor, entry.newCountryRef, entry.effectId);
    cursor.commands.push({
      commandId: allocator.next("establish-subdivision-country"),
      type: "country.establish",
      expectedRevision: world.revision,
      payload: {
        country: countryIdentity(countryId, entry.displayName),
        territoryIds: entry.subdivisionRefs.map((ref) =>
          derivedSubdivisionTerritoryId(sourceTerritoryId, ref.subdivisionId)),
      },
    });
  }
}

function compileSubdivisionPartition(
  effect: Extract<WorldEffectV1, {type: "country.partitionedBySubdivisions"}>,
  world: WorldStateV2,
  catalog: SubdivisionCatalog,
  allocator: CommandIdAllocator,
  cursor: CompileCursor,
) {
  requireCountry(world, effect.sourceCountryId, effect.effectId);
  const allRefs = effect.partitions.flatMap((partition) => partition.subdivisionRefs);
  const firstRef = allRefs[0];
  if (!firstRef || allRefs.some((ref) => ref.sourceVersion !== firstRef.sourceVersion)) {
    throw new WorldEffectCompileError(
      "SUBDIVISION_VERSION_MISMATCH",
      "Partition references must share one source version",
      effect.effectId,
    );
  }
  const entries = materializeCountryCatalog(
    catalog,
    effect.sourceCountryId,
    firstRef.sourceVersion,
    effect.effectId,
  );
  const expectedIds = entries.map((entry) => entry.ref.subdivisionId).sort();
  const actualIds = allRefs.map((ref) => ref.subdivisionId).sort();
  if (
    actualIds.length !== expectedIds.length
    || actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    throw new WorldEffectCompileError(
      "SUBDIVISION_COVERAGE_MISMATCH",
      "Country partition must cover every catalog subdivision exactly once",
      effect.effectId,
    );
  }
  const sourceTerritoryId = sourceTerritory(world, effect.sourceCountryId, effect.effectId);
  const reconciledEntries = reconcileSubdivisionEntries(
    world,
    sourceTerritoryId,
    entries,
    effect.effectId,
  );
  cursor.commands.push(partitionCommand(world, allocator, sourceTerritoryId, reconciledEntries));
  cursor.commands.push({
    commandId: allocator.next("split-country-by-subdivisions"),
    type: "country.split",
    expectedRevision: world.revision,
    payload: {
      sourceCountryId: effect.sourceCountryId,
      resultCountries: effect.partitions.map((partition, index) => {
        const countryId = allocateCountry(
          world,
          cursor,
          partition.newCountryRef,
          effect.effectId,
        );
        return {
          country: countryIdentity(countryId, partition.displayName),
          territorySources: [
            ...partition.subdivisionRefs.map((ref) => ({
              kind: "territory-id" as const,
              territoryId: derivedSubdivisionTerritoryId(sourceTerritoryId, ref.subdivisionId),
            })),
            ...(index === 0 && reconciledEntries.remainder ? [{
              kind: "territory-id" as const,
              territoryId: derivedSubdivisionTerritoryId(
                sourceTerritoryId,
                SUBDIVISION_REMAINDER_PARTITION_KEY,
              ),
            }] : []),
          ],
        };
      }),
    },
  });
}

export function compileWorldEffects(input: Readonly<{
  effects: readonly WorldEffectV1[];
  world: WorldStateV2;
  expectedWorldRevision: number;
  subdivisionCatalog: SubdivisionCatalog;
  allocator: CommandIdAllocator;
  preferredUnifiedCountryId?: ActiveCountryId;
}>): CompiledWorldEffects {
  if (input.expectedWorldRevision !== input.world.revision) {
    throw new WorldEffectCompileError(
      "STALE_WORLD_REVISION",
      `Expected world revision ${input.expectedWorldRevision}, current is ${input.world.revision}`,
    );
  }
  if (input.effects.length === 0) {
    return Object.freeze({
      batch: null,
      allocatedCountryIdsByLocalRef: Object.freeze({}),
      commandCount: 0,
    });
  }
  const cursor: CompileCursor = {
    commands: [],
    allocatedCountryIdsByLocalRef: {},
    reservedCountryIds: [],
  };
  const handledSubdivisionEstablishments = new Set<string>();

  try {
    for (const effect of input.effects) {
      switch (effect.type) {
        case "country.renamed":
          requireCountry(input.world, effect.countryId, effect.effectId);
          cursor.commands.push({
            commandId: input.allocator.next("rename-country"),
            type: "country.rename",
            expectedRevision: input.world.revision,
            payload: {
              countryId: effect.countryId,
              changes: {
                shortKo: effect.displayName,
                officialKo: effect.displayName,
                mapKo: effect.displayName,
                english: effect.displayName,
              },
            },
          });
          break;
        case "territories.transferred":
          requireCountry(input.world, effect.fromCountryId, effect.effectId);
          requireCountry(input.world, effect.toCountryId, effect.effectId);
          for (const territoryId of effect.territoryIds) {
            const territory = input.world.territoriesById[territoryId];
            if (!territory) {
              throw new WorldEffectCompileError(
                "UNKNOWN_TERRITORY",
                `Territory is not active: ${territoryId}`,
                effect.effectId,
              );
            }
            if (territory.ownerCountryId !== effect.fromCountryId) {
              throw new WorldEffectCompileError(
                "INVALID_OWNERSHIP",
                `Territory is not owned by ${effect.fromCountryId}: ${territoryId}`,
                effect.effectId,
              );
            }
            cursor.commands.push({
              commandId: input.allocator.next("transfer-territory"),
              type: "territory.transfer",
              expectedRevision: input.world.revision,
              payload: {
                source: {kind: "territory-id", territoryId},
                targetCountryId: effect.toCountryId,
              },
            });
          }
          break;
        case "countries.unified": {
          if (new Set(effect.countryIds).size !== effect.countryIds.length) {
            throw new WorldEffectCompileError(
              "SELF_MERGE",
              "A country cannot be merged with itself",
              effect.effectId,
            );
          }
          effect.countryIds.forEach((id) => requireCountry(input.world, id, effect.effectId));
          if (
            input.preferredUnifiedCountryId
            && effect.countryIds.includes(input.preferredUnifiedCountryId)
          ) {
            const countryId = bindExistingCountry(
              cursor,
              effect.newCountryRef,
              input.preferredUnifiedCountryId,
              effect.effectId,
            );
            cursor.commands.push({
              commandId: input.allocator.next("unify-countries"),
              type: "country.merge",
              expectedRevision: input.world.revision,
              payload: {
                sourceCountryIds: effect.countryIds,
                resultCountry: {kind: "existing-country", countryId},
                metadataInheritance: {mode: "preserve-result"},
              },
            });
            cursor.commands.push({
              commandId: input.allocator.next("rename-unified-country"),
              type: "country.rename",
              expectedRevision: input.world.revision,
              payload: {
                countryId,
                changes: {
                  shortKo: effect.displayName,
                  officialKo: effect.displayName,
                  mapKo: effect.displayName,
                  english: effect.displayName,
                },
              },
            });
            break;
          }
          const countryId = allocateCountry(
            input.world,
            cursor,
            effect.newCountryRef,
            effect.effectId,
          );
          cursor.commands.push({
            commandId: input.allocator.next("unify-countries"),
            type: "country.merge",
            expectedRevision: input.world.revision,
            payload: {
              sourceCountryIds: effect.countryIds,
              resultCountry: {
                kind: "new-country",
                country: countryIdentity(countryId, effect.displayName),
              },
              metadataInheritance: {mode: "preserve-result"},
            },
          });
          break;
        }
        case "country.dissolved": {
          requireCountry(input.world, effect.countryId, effect.effectId);
          if (effect.successorCountryId === effect.countryId) {
            throw new WorldEffectCompileError(
              "SELF_MERGE",
              "A dissolved country cannot succeed itself",
              effect.effectId,
            );
          }
          if (effect.successorCountryId !== null) {
            requireCountry(input.world, effect.successorCountryId, effect.effectId);
          }
          const territoryIds = input.world.territoryOrder.filter((territoryId) =>
            input.world.territoriesById[territoryId].ownerCountryId === effect.countryId);
          if (territoryIds.length === 0) {
            throw new WorldEffectCompileError(
              "EMPTY_TERRITORY_SET",
              "A territory-less country cannot be dissolved by this compiler",
              effect.effectId,
            );
          }
          cursor.commands.push({
            commandId: input.allocator.next("dissolve-country"),
            type: "country.dissolve",
            expectedRevision: input.world.revision,
            payload: {
              sourceCountryId: effect.countryId,
              territoryDispositions: territoryIds.map((territoryId) => ({
                territoryId,
                disposition: effect.successorCountryId === null
                  ? {type: "unclaim" as const}
                  : {type: "merge" as const, targetCountryId: effect.successorCountryId},
              })),
            },
          });
          break;
        }
        case "country.established": {
          if (effect.subdivisionRefs.length > 0) {
            if (handledSubdivisionEstablishments.has(effect.effectId)) break;
            const grouped = input.effects.filter((candidate): candidate is Extract<WorldEffectV1, {type: "country.established"}> =>
              candidate.type === "country.established"
              && candidate.subdivisionRefs.length > 0
              && candidate.sourceCountryId === effect.sourceCountryId);
            grouped.forEach((entry) => handledSubdivisionEstablishments.add(entry.effectId));
            compileSubdivisionEstablishments(
              grouped,
              input.world,
              input.subdivisionCatalog,
              input.allocator,
              cursor,
            );
            break;
          }
          if (effect.territoryIds.length === 0) {
            throw new WorldEffectCompileError(
              "EMPTY_TERRITORY_SET",
              "Country establishment requires territory",
              effect.effectId,
            );
          }
          for (const territoryId of effect.territoryIds) {
            const territory = input.world.territoriesById[territoryId];
            if (!territory) {
              throw new WorldEffectCompileError(
                "UNKNOWN_TERRITORY",
                `Territory is not active: ${territoryId}`,
                effect.effectId,
              );
            }
            if (
              effect.sourceCountryId === null
                ? territory.ownerCountryId !== null
                : territory.ownerCountryId !== effect.sourceCountryId
            ) {
              throw new WorldEffectCompileError(
                "INVALID_OWNERSHIP",
                `Territory ownership does not match establishment source: ${territoryId}`,
                effect.effectId,
              );
            }
          }
          if (effect.sourceCountryId !== null) {
            requireCountry(input.world, effect.sourceCountryId, effect.effectId);
            cursor.commands.push({
              commandId: input.allocator.next("unclaim-establishment-territories"),
              type: "territory.unclaim",
              expectedRevision: input.world.revision,
              payload: {territoryIds: effect.territoryIds},
            });
          }
          const countryId = allocateCountry(
            input.world,
            cursor,
            effect.newCountryRef,
            effect.effectId,
          );
          cursor.commands.push({
            commandId: input.allocator.next("establish-country"),
            type: "country.establish",
            expectedRevision: input.world.revision,
            payload: {
              country: countryIdentity(countryId, effect.displayName),
              territoryIds: effect.territoryIds,
            },
          });
          break;
        }
        case "country.partitionedBySubdivisions":
          compileSubdivisionPartition(
            effect,
            input.world,
            input.subdivisionCatalog,
            input.allocator,
            cursor,
          );
          break;
      }
    }

    const batch = parseCommandBatchV2Command({
      commandId: input.allocator.next("world-effects-batch"),
      type: "command.batch",
      expectedRevision: input.world.revision,
      payload: {commands: cursor.commands},
    });
    return Object.freeze({
      batch,
      allocatedCountryIdsByLocalRef: Object.freeze({...cursor.allocatedCountryIdsByLocalRef}),
      commandCount: cursor.commands.length,
    });
  } catch (error) {
    if (error instanceof WorldEffectCompileError) throw error;
    throw new WorldEffectCompileError(
      "COMMAND_SCHEMA_INVALID",
      error instanceof Error ? error.message : "Compiled command batch is invalid",
    );
  }
}

