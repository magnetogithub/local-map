import {
  assertSha256Hex,
  buildDomainRootHash,
  buildWorldDomainHashRoots,
  type LeafHashRecord,
  type WorldDomainHashRoots,
  type WorldLeafHashRecords,
} from "./domain-hash-root";

export type LeafHashChanges = Readonly<{
  [Field in keyof WorldLeafHashRecords]?: Readonly<Record<string, string | null>>;
}>;

export type IncrementalDomainHashState = Readonly<{
  leafHashes: WorldLeafHashRecords;
  hashRoots: WorldDomainHashRoots;
}>;

export type IncrementalRootField = keyof WorldDomainHashRoots;

export type IncrementalLeafHashUpdate = Readonly<{
  state: IncrementalDomainHashState;
  recomputedRootFields: readonly IncrementalRootField[];
  metrics: Readonly<{
    changedLeaves: number;
    rootRecomputations: number;
    deepWorldSerializations: 0;
  }>;
}>;

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

const assertLeafKey = (key: string) => {
  if (key.length === 0 || key !== key.trim()) {
    throw new TypeError("Incremental leaf key must be a non-empty canonical string");
  }
};

const createNullPrototypeLeafRecord = (): Record<string, string> =>
  Object.create(null) as Record<string, string>;

const defineLeafHash = (record: Record<string, string>, key: string, leafHash: string) => {
  Object.defineProperty(record, key, {
    value: leafHash,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

const cloneLeafHashRecord = (record: LeafHashRecord): Record<string, string> => {
  const clone = createNullPrototypeLeafRecord();
  for (const [key, leafHash] of Object.entries(record)) {
    defineLeafHash(clone, key, leafHash);
  }
  return clone;
};

const snapshotLeafRecord = (record: LeafHashRecord): LeafHashRecord => {
  const entries = Object.entries(record).sort(([left], [right]) => compareText(left, right));
  const snapshot = createNullPrototypeLeafRecord();
  for (const [key, leafHash] of entries) {
    assertLeafKey(key);
    assertSha256Hex(leafHash, `Incremental leaf hash ${key}`);
    defineLeafHash(snapshot, key, leafHash);
  }
  return Object.freeze(snapshot);
};

const snapshotLeafHashes = (input: WorldLeafHashRecords): WorldLeafHashRecords =>
  Object.freeze({
    countryCoreHashes: snapshotLeafRecord(input.countryCoreHashes),
    countryPresentationHashes: snapshotLeafRecord(input.countryPresentationHashes),
    territoryGeometryHashes: snapshotLeafRecord(input.territoryGeometryHashes),
    territoryOwnershipHashes: snapshotLeafRecord(input.territoryOwnershipHashes),
    topologyEdgeHashes: snapshotLeafRecord(input.topologyEdgeHashes),
  });

export function createIncrementalDomainHashState(
  input: WorldLeafHashRecords,
): IncrementalDomainHashState {
  const leafHashes = snapshotLeafHashes(input);
  return Object.freeze({
    leafHashes,
    hashRoots: buildWorldDomainHashRoots(leafHashes),
  });
}

function applyRecordChanges(
  current: LeafHashRecord,
  changes: Readonly<Record<string, string | null>> | undefined,
): Readonly<{record: LeafHashRecord; changedLeaves: number}> {
  if (!changes) return {record: current, changedLeaves: 0};
  const next = cloneLeafHashRecord(current);
  let changedLeaves = 0;
  for (const [key, leafHash] of Object.entries(changes).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    assertLeafKey(key);
    if (leafHash === null) {
      if (Object.hasOwn(next, key)) {
        delete next[key];
        changedLeaves += 1;
      }
      continue;
    }
    assertSha256Hex(leafHash, `Incremental changed leaf hash ${key}`);
    if (next[key] !== leafHash) {
      defineLeafHash(next, key, leafHash);
      changedLeaves += 1;
    }
  }
  return {
    record: changedLeaves === 0 ? current : snapshotLeafRecord(next),
    changedLeaves,
  };
}

const territoriesRootHash = (leafHashes: WorldLeafHashRecords) =>
  buildDomainRootHash("territories", {
    ...Object.fromEntries(
      Object.entries(leafHashes.territoryGeometryHashes).map(([key, value]) => [
        `geometry:${key}`,
        value,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(leafHashes.territoryOwnershipHashes).map(([key, value]) => [
        `ownership:${key}`,
        value,
      ]),
    ),
  });

export function applyIncrementalLeafHashChanges(
  current: IncrementalDomainHashState,
  changes: LeafHashChanges,
): IncrementalLeafHashUpdate {
  const countryCore = applyRecordChanges(
    current.leafHashes.countryCoreHashes,
    changes.countryCoreHashes,
  );
  const countryPresentation = applyRecordChanges(
    current.leafHashes.countryPresentationHashes,
    changes.countryPresentationHashes,
  );
  const territoryGeometry = applyRecordChanges(
    current.leafHashes.territoryGeometryHashes,
    changes.territoryGeometryHashes,
  );
  const territoryOwnership = applyRecordChanges(
    current.leafHashes.territoryOwnershipHashes,
    changes.territoryOwnershipHashes,
  );
  const topologyEdge = applyRecordChanges(
    current.leafHashes.topologyEdgeHashes,
    changes.topologyEdgeHashes,
  );
  const changedLeaves =
    countryCore.changedLeaves +
    countryPresentation.changedLeaves +
    territoryGeometry.changedLeaves +
    territoryOwnership.changedLeaves +
    topologyEdge.changedLeaves;

  if (changedLeaves === 0) {
    return Object.freeze({
      state: current,
      recomputedRootFields: Object.freeze([]),
      metrics: Object.freeze({
        changedLeaves: 0,
        rootRecomputations: 0,
        deepWorldSerializations: 0,
      }),
    });
  }

  const leafHashes: WorldLeafHashRecords = Object.freeze({
    countryCoreHashes: countryCore.record,
    countryPresentationHashes: countryPresentation.record,
    territoryGeometryHashes: territoryGeometry.record,
    territoryOwnershipHashes: territoryOwnership.record,
    topologyEdgeHashes: topologyEdge.record,
  });
  const hashRoots = {...current.hashRoots};
  const recomputedRootFields: IncrementalRootField[] = [];

  if (countryCore.changedLeaves > 0) {
    hashRoots.countriesRootHash = buildDomainRootHash(
      "countries",
      leafHashes.countryCoreHashes,
    );
    recomputedRootFields.push("countriesRootHash");
  }
  if (countryPresentation.changedLeaves > 0) {
    hashRoots.presentationRootHash = buildDomainRootHash(
      "presentation",
      leafHashes.countryPresentationHashes,
    );
    recomputedRootFields.push("presentationRootHash");
  }
  if (territoryGeometry.changedLeaves > 0 || territoryOwnership.changedLeaves > 0) {
    hashRoots.territoriesRootHash = territoriesRootHash(leafHashes);
    recomputedRootFields.push("territoriesRootHash");
  }
  if (topologyEdge.changedLeaves > 0) {
    hashRoots.topologyRootHash = buildDomainRootHash(
      "topology",
      leafHashes.topologyEdgeHashes,
    );
    recomputedRootFields.push("topologyRootHash");
  }

  const state = Object.freeze({leafHashes, hashRoots: Object.freeze(hashRoots)});
  return Object.freeze({
    state,
    recomputedRootFields: Object.freeze(recomputedRootFields),
    metrics: Object.freeze({
      changedLeaves,
      rootRecomputations: recomputedRootFields.length,
      deepWorldSerializations: 0,
    }),
  });
}
