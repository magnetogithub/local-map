import {
  readTerritoryId as readCanonicalTerritoryId,
  type TerritoryId,
} from "./territory-id";

export type TerritoryOrder = readonly TerritoryId[];

export type TerritoryOrderErrorCode =
  | "invalid-territory-order-id"
  | "duplicate-territory-order-id"
  | "missing-source-territory-id"
  | "invalid-territory-partition"
  | "invalid-territory-merge"
  | "territory-order-id-collision";

export class TerritoryOrderError extends Error {
  readonly code: TerritoryOrderErrorCode;

  constructor(code: TerritoryOrderErrorCode, message: string) {
    super(message);
    this.name = "TerritoryOrderError";
    this.code = code;
  }
}

const compareCanonicalIds = (left: TerritoryId, right: TerritoryId) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const readTerritoryId = (value: TerritoryId): TerritoryId => {
  try {
    return readCanonicalTerritoryId(value, "territoryOrder value");
  } catch {
    throw new TerritoryOrderError(
      "invalid-territory-order-id",
      "territoryOrder values must be canonical TerritoryIds",
    );
  }
};

export function createTerritoryOrder(territoryIds: Iterable<TerritoryId>): TerritoryOrder {
  const uniqueIds = new Set<TerritoryId>();
  for (const value of territoryIds) {
    const territoryId = readTerritoryId(value);
    if (uniqueIds.has(territoryId)) {
      throw new TerritoryOrderError(
        "duplicate-territory-order-id",
        `Duplicate territoryOrder id: ${territoryId}`,
      );
    }
    uniqueIds.add(territoryId);
  }
  return Object.freeze([...uniqueIds].sort(compareCanonicalIds));
}

export function partitionTerritoryOrder(
  territoryOrder: TerritoryOrder,
  sourceTerritoryId: TerritoryId,
  partitionTerritoryIds: Iterable<TerritoryId>,
): TerritoryOrder {
  const canonicalOrder = createTerritoryOrder(territoryOrder);
  const canonicalSourceId = readTerritoryId(sourceTerritoryId);
  if (!canonicalOrder.includes(canonicalSourceId)) {
    throw new TerritoryOrderError(
      "missing-source-territory-id",
      `Territory partition is missing source ${canonicalSourceId}`,
    );
  }

  const canonicalPartitionIds = createTerritoryOrder(partitionTerritoryIds);
  if (canonicalPartitionIds.length < 2 || canonicalPartitionIds.includes(canonicalSourceId)) {
    throw new TerritoryOrderError(
      "invalid-territory-partition",
      "Territory partition must replace its source with at least two new TerritoryIds",
    );
  }
  const unaffectedIds = canonicalOrder.filter((id) => id !== canonicalSourceId);
  const collision = canonicalPartitionIds.find((id) => unaffectedIds.includes(id));
  if (collision) {
    throw new TerritoryOrderError(
      "territory-order-id-collision",
      `Territory partition output collides with existing id ${collision}`,
    );
  }
  return createTerritoryOrder([...unaffectedIds, ...canonicalPartitionIds]);
}

export function mergeTerritoryOrder(
  territoryOrder: TerritoryOrder,
  sourceTerritoryIds: Iterable<TerritoryId>,
  mergedTerritoryId: TerritoryId,
): TerritoryOrder {
  const canonicalOrder = createTerritoryOrder(territoryOrder);
  const canonicalSourceIds = createTerritoryOrder(sourceTerritoryIds);
  if (canonicalSourceIds.length < 2) {
    throw new TerritoryOrderError(
      "invalid-territory-merge",
      "Territory merge requires at least two source TerritoryIds",
    );
  }
  for (const sourceTerritoryId of canonicalSourceIds) {
    if (!canonicalOrder.includes(sourceTerritoryId)) {
      throw new TerritoryOrderError(
        "missing-source-territory-id",
        `Territory merge is missing source ${sourceTerritoryId}`,
      );
    }
  }

  const canonicalMergedId = readTerritoryId(mergedTerritoryId);
  if (
    canonicalOrder.includes(canonicalMergedId) &&
    !canonicalSourceIds.includes(canonicalMergedId)
  ) {
    throw new TerritoryOrderError(
      "territory-order-id-collision",
      `Territory merge output collides with existing id ${canonicalMergedId}`,
    );
  }
  const sourceSet = new Set(canonicalSourceIds);
  return createTerritoryOrder([
    ...canonicalOrder.filter((id) => !sourceSet.has(id)),
    canonicalMergedId,
  ]);
}
