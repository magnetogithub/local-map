import type {TerritoryId} from "./territory-id";
import type {CountryId} from "./country-id";
import {assertSha256Hex} from "./domain-hash-root";
import {
  assertWorldV3Keys, assertWorldV3RecordOrder, readWorldV3CountryId,
  readWorldV3Order, readWorldV3Record, readWorldV3Version,
} from "./world-v3-validation";

export type WorldGeometryCatalogRef = Readonly<{
  catalogVersion: string;
  geometryRoot: string;
  topologyRoot: string;
  renderArtifactRoot: string;
  manifestPath: string;
}>;

/** Minimal validated catalog view consumed by mutable schemas; never geometry bytes. */
export type WorldGeometryCatalogContract = Readonly<{
  ref: WorldGeometryCatalogRef;
  territoriesById: Readonly<Record<string, Readonly<{id: TerritoryId; sourceCountryId: CountryId}>>>;
  territoryOrder: readonly TerritoryId[];
}>;

/** Catalog IDs are separate from V2's unbounded seed/partition namespaces. */
export function readCatalogTerritoryId(value: unknown, context = "Catalog TerritoryId"): TerritoryId {
  if (typeof value !== "string" || !/^territory:catalog:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${context} must be a bounded ASCII catalog TerritoryId`);
  }
  return value as TerritoryId;
}

export function createWorldGeometryCatalogRef(value: unknown): WorldGeometryCatalogRef {
  const input = readWorldV3Record(value, "WorldGeometryCatalogRef");
  assertWorldV3Keys(input, ["catalogVersion", "geometryRoot", "topologyRoot", "renderArtifactRoot", "manifestPath"], "WorldGeometryCatalogRef");
  for (const field of ["geometryRoot", "topologyRoot", "renderArtifactRoot"] as const) {
    assertSha256Hex(input[field], `WorldGeometryCatalogRef.${field}`);
  }
  const catalogVersion = readWorldV3Version(input.catalogVersion, "catalogVersion");
  const path = input.manifestPath;
  if (typeof path !== "string" || path.length > 512 || !/^\/data\/[A-Za-z0-9._/-]+\.json$/.test(path) ||
    path.split("/").some((part, index) => index > 0 && (!part || part === "." || part === "..")) ||
    !path.split("/").includes(catalogVersion)) {
    throw new Error("manifestPath must be a local versioned /data/ JSON path without traversal");
  }
  return Object.freeze({catalogVersion, geometryRoot: input.geometryRoot as string,
    topologyRoot: input.topologyRoot as string, renderArtifactRoot: input.renderArtifactRoot as string,
    manifestPath: path});
}

export function createWorldGeometryCatalogContract(value: unknown): WorldGeometryCatalogContract {
  const input = readWorldV3Record(value, "WorldGeometryCatalogContract");
  assertWorldV3Keys(input, ["ref", "territoriesById", "territoryOrder"], "WorldGeometryCatalogContract");
  const ref = createWorldGeometryCatalogRef(input.ref);
  const territoryOrder = readWorldV3Order(input.territoryOrder, readCatalogTerritoryId, "catalog.territoryOrder");
  const record = readWorldV3Record(input.territoriesById, "catalog.territoriesById");
  assertWorldV3RecordOrder(record, territoryOrder, "catalog territories");
  const territoriesById: Record<string, Readonly<{id: TerritoryId; sourceCountryId: CountryId}>> = {};
  for (const id of territoryOrder) {
    const entry = readWorldV3Record(record[id], "catalog entry");
    assertWorldV3Keys(entry, ["id", "sourceCountryId"], "catalog entry");
    if (readCatalogTerritoryId(entry.id) !== id) throw new Error("Catalog record key must match entry id");
    territoriesById[id] = Object.freeze({id, sourceCountryId: readWorldV3CountryId(entry.sourceCountryId, "sourceCountryId")});
  }
  return Object.freeze({ref, territoryOrder, territoriesById: Object.freeze(territoriesById)});
}

export function assertWorldGeometryCatalogRefMatches(actual: WorldGeometryCatalogRef, expected: WorldGeometryCatalogRef) {
  for (const field of Object.keys(expected) as (keyof WorldGeometryCatalogRef)[]) {
    if (actual[field] !== expected[field]) throw new Error(`Catalog ref mismatch: ${field}`);
  }
}
