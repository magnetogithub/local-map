import {createImmutableReadonlySet} from "./immutable-readonly-set";

declare const territoryIdBrand: unique symbol;

export type TerritoryId = string & {readonly [territoryIdBrand]: "territory-id"};

export type SeedTerritoryIdInput = Readonly<{
  kind: "seed";
  seedVersion: string;
  sourceFeatureId: string;
}>;

export type PartitionTerritoryIdInput = Readonly<{
  kind: "partition";
  sourceTerritoryId: TerritoryId;
  partitionKey: string;
}>;

export type TerritoryIdInput = SeedTerritoryIdInput | PartitionTerritoryIdInput;

export type TerritoryIdRegistry = Readonly<{
  territoryIds: ReadonlySet<TerritoryId>;
}>;

export type TerritoryIdRegistryInput = Readonly<{
  territoryIds: Iterable<unknown>;
}>;

export type TerritoryIdErrorCode =
  | "invalid-territory-id"
  | "duplicate-territory-id"
  | "territory-id-collision";

export class TerritoryIdError extends Error {
  readonly code: TerritoryIdErrorCode;

  constructor(code: TerritoryIdErrorCode, message: string) {
    super(message);
    this.name = "TerritoryIdError";
    this.code = code;
  }
}

const invalid = (message: string): never => {
  throw new TerritoryIdError("invalid-territory-id", message);
};

const readCanonicalPart = (value: unknown, context: string) => {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    return invalid(`${context} must be a non-empty canonical string`);
  }
  return value;
};

const parseEncodedParts = (payload: string, count: number, context: string) => {
  const parts: string[] = [];
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const separator = payload.indexOf(":", cursor);
    if (separator < 0) return invalid(`${context} has a malformed component length`);
    const lengthText = payload.slice(cursor, separator);
    if (!/^[1-9]\d*$/.test(lengthText)) {
      return invalid(`${context} has a malformed component length`);
    }
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length)) {
      return invalid(`${context} component length is not a safe integer`);
    }
    const start = separator + 1;
    const end = start + length;
    if (end > payload.length) return invalid(`${context} component is truncated`);
    parts.push(payload.slice(start, end));
    cursor = end;
  }
  if (cursor !== payload.length) return invalid(`${context} contains trailing bytes`);
  return parts;
};

const parseTerritoryId = (territoryId: string, context: string, depth: number): void => {
  if (depth > 64) return invalid(`${context} exceeds the partition nesting limit`);
  if (territoryId.startsWith("territory:seed:")) {
    const [seedVersion, sourceFeatureId] = parseEncodedParts(
      territoryId.slice("territory:seed:".length),
      2,
      context,
    );
    readCanonicalPart(seedVersion, `${context} seedVersion`);
    readCanonicalPart(sourceFeatureId, `${context} sourceFeatureId`);
    return;
  }
  if (territoryId.startsWith("territory:partition:")) {
    const [sourceTerritoryId, partitionKey] = parseEncodedParts(
      territoryId.slice("territory:partition:".length),
      2,
      context,
    );
    const sourceId = readCanonicalPart(sourceTerritoryId, `${context} sourceTerritoryId`);
    parseTerritoryId(sourceId, `${context} sourceTerritoryId`, depth + 1);
    readCanonicalPart(partitionKey, `${context} partitionKey`);
    return;
  }
  invalid(`${context} must use the seed or partition TerritoryId namespace`);
};

export const readTerritoryId = (value: unknown, context = "TerritoryId"): TerritoryId => {
  const territoryId = readCanonicalPart(value, context);
  parseTerritoryId(territoryId, context, 0);
  return territoryId as TerritoryId;
};

const assertExactKeys = (value: object, expectedKeys: readonly string[], context: string) => {
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    invalid(`${context} contains unknown or missing fields`);
  }
};

const encodePart = (value: string) => `${value.length}:${value}`;

export function deriveTerritoryId(value: unknown): TerritoryId {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalid("TerritoryId derivation input must be an object");
  }
  const input = value as Record<string, unknown>;

  if (input.kind === "seed") {
    assertExactKeys(input, ["kind", "seedVersion", "sourceFeatureId"], "Seed input");
    const seedVersion = readCanonicalPart(input.seedVersion, "seedVersion");
    const sourceFeatureId = readCanonicalPart(input.sourceFeatureId, "sourceFeatureId");
    return `territory:seed:${encodePart(seedVersion)}${encodePart(sourceFeatureId)}` as TerritoryId;
  }

  if (input.kind === "partition") {
    assertExactKeys(
      input,
      ["kind", "partitionKey", "sourceTerritoryId"],
      "Partition input",
    );
    const sourceTerritoryId = readTerritoryId(input.sourceTerritoryId, "sourceTerritoryId");
    const partitionKey = readCanonicalPart(input.partitionKey, "partitionKey");
    return `territory:partition:${encodePart(sourceTerritoryId)}${encodePart(partitionKey)}` as TerritoryId;
  }

  return invalid("TerritoryId derivation kind must be seed or partition");
}

export function createTerritoryIdRegistry(
  input: TerritoryIdRegistryInput,
): TerritoryIdRegistry {
  const territoryIds = new Set<TerritoryId>();
  for (const value of input.territoryIds) {
    const territoryId = readTerritoryId(value, "Registered TerritoryId");
    if (territoryIds.has(territoryId)) {
      throw new TerritoryIdError(
        "duplicate-territory-id",
        `Duplicate TerritoryId: ${territoryId}`,
      );
    }
    territoryIds.add(territoryId);
  }
  return Object.freeze({territoryIds: createImmutableReadonlySet(territoryIds)});
}

export function issueTerritoryId(
  input: TerritoryIdInput,
  registry: TerritoryIdRegistry,
): TerritoryId {
  const territoryId = deriveTerritoryId(input);
  if (registry.territoryIds.has(territoryId)) {
    throw new TerritoryIdError(
      "territory-id-collision",
      `TerritoryId already exists: ${territoryId}`,
    );
  }
  return territoryId;
}
