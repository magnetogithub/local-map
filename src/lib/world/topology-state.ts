import {readTerritoryId, type TerritoryId} from "./territory-id";

declare const topologyEdgeIdBrand: unique symbol;

export type TopologyEdgeId = string & {readonly [topologyEdgeIdBrand]: "topology-edge-id"};
export type TopologyPosition = readonly [longitude: number, latitude: number];
export type TopologyEdgeClassification = "coast" | "internal";

export type TopologyEdge = Readonly<{
  id: TopologyEdgeId;
  territoryIds: readonly [TerritoryId, TerritoryId | null];
  classification: TopologyEdgeClassification;
  coordinates: readonly TopologyPosition[];
}>;

export type TopologyState = Readonly<{
  edgesById: Readonly<Record<string, TopologyEdge>>;
  neighborTerritoryIdsById: Readonly<Record<string, readonly TerritoryId[]>>;
}>;

export type TopologyStateErrorCode =
  | "invalid-topology-edge"
  | "duplicate-topology-edge"
  | "noncanonical-topology-edge";

export class TopologyStateError extends Error {
  readonly code: TopologyStateErrorCode;

  constructor(code: TopologyStateErrorCode, message: string) {
    super(message);
    this.name = "TopologyStateError";
    this.code = code;
  }
}

const edgeKeys = ["classification", "coordinates", "id", "territoryIds"] as const;

const assertExactKeys = (value: object) => {
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== edgeKeys.length ||
    actualKeys.some((key, index) => key !== edgeKeys[index])
  ) {
    throw new TopologyStateError(
      "invalid-topology-edge",
      "TopologyEdge contains unknown or missing fields",
    );
  }
};

const readCanonicalString = (value: unknown, context: string) => {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new TopologyStateError(
      "invalid-topology-edge",
      `${context} must be a non-empty canonical string`,
    );
  }
  return value;
};

const readEdgeId = (value: unknown): TopologyEdgeId => {
  const edgeId = readCanonicalString(value, "TopologyEdge.id");
  if (!edgeId.startsWith("topology-edge:")) {
    throw new TopologyStateError(
      "invalid-topology-edge",
      "TopologyEdge.id must use the topology-edge namespace",
    );
  }
  return edgeId as TopologyEdgeId;
};

const comparePosition = (left: TopologyPosition, right: TopologyPosition) =>
  left[0] - right[0] || left[1] - right[1];

const compareCoordinateSequence = (
  left: readonly TopologyPosition[],
  right: readonly TopologyPosition[],
) => {
  for (let index = 0; index < left.length; index += 1) {
    const comparison = comparePosition(left[index], right[index]);
    if (comparison !== 0) return comparison;
  }
  return 0;
};

const readCoordinates = (value: unknown): readonly TopologyPosition[] => {
  if (!Array.isArray(value) || value.length < 2) {
    throw new TopologyStateError(
      "invalid-topology-edge",
      "TopologyEdge.coordinates must contain at least two positions",
    );
  }
  const positions = value.map((position, index) => {
    if (
      !Array.isArray(position) ||
      position.length !== 2 ||
      !position.every((coordinate) =>
        typeof coordinate === "number" && Number.isFinite(coordinate)
      )
    ) {
      throw new TopologyStateError(
        "invalid-topology-edge",
        `TopologyEdge.coordinates[${index}] must contain two finite numbers`,
      );
    }
    return Object.freeze([position[0], position[1]]) as TopologyPosition;
  });
  const reverse = [...positions].reverse();
  return Object.freeze(
    compareCoordinateSequence(positions, reverse) <= 0 ? positions : reverse,
  );
};

const readEdge = (value: unknown): TopologyEdge => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TopologyStateError("invalid-topology-edge", "TopologyEdge must be an object");
  }
  assertExactKeys(value);
  const input = value as Record<(typeof edgeKeys)[number], unknown>;
  if (input.classification !== "coast" && input.classification !== "internal") {
    throw new TopologyStateError(
      "invalid-topology-edge",
      "TopologyEdge.classification must be coast or internal",
    );
  }
  if (!Array.isArray(input.territoryIds) || input.territoryIds.length !== 2) {
    throw new TopologyStateError(
      "invalid-topology-edge",
      "TopologyEdge.territoryIds must contain exactly two sides",
    );
  }
  const firstTerritoryId = readTerritoryId(input.territoryIds[0], "First territory side");
  const secondTerritoryId =
    input.territoryIds[1] === null
      ? null
      : readTerritoryId(input.territoryIds[1], "Second territory side");

  if (input.classification === "coast" && secondTerritoryId !== null) {
    throw new TopologyStateError(
      "invalid-topology-edge",
      "A coast edge must have null as its second territory side",
    );
  }
  if (input.classification === "internal" && secondTerritoryId === null) {
    throw new TopologyStateError(
      "invalid-topology-edge",
      "An internal edge must have two territory sides",
    );
  }
  if (
    secondTerritoryId !== null &&
    (firstTerritoryId === secondTerritoryId || firstTerritoryId > secondTerritoryId)
  ) {
    throw new TopologyStateError(
      "noncanonical-topology-edge",
      "Internal territory sides must be distinct and canonically ordered",
    );
  }

  const territoryIds = Object.freeze([
    firstTerritoryId,
    secondTerritoryId,
  ]) as readonly [TerritoryId, TerritoryId | null];

  return Object.freeze({
    id: readEdgeId(input.id),
    territoryIds,
    classification: input.classification,
    coordinates: readCoordinates(input.coordinates),
  });
};

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

export function createTopologyState(edges: Iterable<unknown>): TopologyState {
  const edgesById: Record<string, TopologyEdge> = {};
  const semanticEdges = new Set<string>();
  const neighborSets = new Map<TerritoryId, Set<TerritoryId>>();

  const canonicalEdges = [...edges].map(readEdge).sort((left, right) =>
    compareText(left.id, right.id),
  );
  for (const edge of canonicalEdges) {
    const semanticKey = JSON.stringify([
      edge.classification,
      edge.territoryIds,
      edge.coordinates,
    ]);
    if (edgesById[edge.id] || semanticEdges.has(semanticKey)) {
      throw new TopologyStateError(
        "duplicate-topology-edge",
        `Canonical topology edge is duplicated: ${edge.id}`,
      );
    }
    edgesById[edge.id] = edge;
    semanticEdges.add(semanticKey);

    const [firstTerritoryId, secondTerritoryId] = edge.territoryIds;
    if (!neighborSets.has(firstTerritoryId)) neighborSets.set(firstTerritoryId, new Set());
    if (secondTerritoryId !== null) {
      if (!neighborSets.has(secondTerritoryId)) neighborSets.set(secondTerritoryId, new Set());
      neighborSets.get(firstTerritoryId)!.add(secondTerritoryId);
      neighborSets.get(secondTerritoryId)!.add(firstTerritoryId);
    }
  }

  const neighborTerritoryIdsById: Record<string, readonly TerritoryId[]> = {};
  for (const territoryId of [...neighborSets.keys()].sort(compareText)) {
    neighborTerritoryIdsById[territoryId] = Object.freeze(
      [...neighborSets.get(territoryId)!].sort(compareText),
    );
  }
  return Object.freeze({
    edgesById: Object.freeze(edgesById),
    neighborTerritoryIdsById: Object.freeze(neighborTerritoryIdsById),
  });
}

const topologyStateKeys = ["edgesById", "neighborTerritoryIdsById"] as const;

const readObjectRecord = (value: unknown, context: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TopologyStateError("invalid-topology-edge", `${context} must be an object record`);
  }
  return value as Record<string, unknown>;
};

export function createTopologyStateSnapshot(value: unknown): TopologyState {
  const input = readObjectRecord(value, "TopologyState");
  const actualKeys = Object.keys(input).sort();
  if (
    actualKeys.length !== topologyStateKeys.length ||
    actualKeys.some((key, index) => key !== topologyStateKeys[index])
  ) {
    throw new TopologyStateError(
      "invalid-topology-edge",
      "TopologyState contains unknown or missing fields",
    );
  }

  const edgeRecord = readObjectRecord(input.edgesById, "TopologyState.edgesById");
  for (const [edgeId, edge] of Object.entries(edgeRecord)) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge) || (edge as {id?: unknown}).id !== edgeId) {
      throw new TopologyStateError(
        "invalid-topology-edge",
        `TopologyState edge record key does not match edge id: ${edgeId}`,
      );
    }
  }
  const snapshot = createTopologyState(Object.values(edgeRecord));
  const suppliedNeighbors = readObjectRecord(
    input.neighborTerritoryIdsById,
    "TopologyState.neighborTerritoryIdsById",
  );
  const expectedKeys = Object.keys(snapshot.neighborTerritoryIdsById).sort(compareText);
  const suppliedKeys = Object.keys(suppliedNeighbors).sort(compareText);
  if (
    suppliedKeys.length !== expectedKeys.length ||
    suppliedKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TopologyStateError(
      "invalid-topology-edge",
      "TopologyState neighbor index does not match edges",
    );
  }
  for (const territoryId of expectedKeys) {
    const supplied = suppliedNeighbors[territoryId];
    if (!Array.isArray(supplied)) {
      throw new TopologyStateError(
        "invalid-topology-edge",
        `TopologyState neighbor index for ${territoryId} must be an array`,
      );
    }
    const parsed = supplied.map((neighbor, index) =>
      readTerritoryId(neighbor, `TopologyState neighbor index ${territoryId}[${index}]`),
    );
    const expected = snapshot.neighborTerritoryIdsById[territoryId];
    if (
      parsed.length !== expected.length ||
      parsed.some((neighbor, index) => neighbor !== expected[index])
    ) {
      throw new TopologyStateError(
        "invalid-topology-edge",
        `TopologyState neighbor index for ${territoryId} does not match edges`,
      );
    }
  }
  return snapshot;
}
