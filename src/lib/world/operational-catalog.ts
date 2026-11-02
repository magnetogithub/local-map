import type {CountryId} from './country-id';
import type {TerritoryId} from './territory-id';
import type {TerritoryEntityV3} from './territory-entity-v3';
import {assertWorldGeometryCatalogRefMatches, type WorldGeometryCatalogRef} from './world-geometry-catalog-ref';
import currentOperationalCatalog from '../../../data/runtime/operational-catalog/current.json';

export const OPERATIONAL_CATALOG_VERSION = currentOperationalCatalog.catalogVersion;
export const OPERATIONAL_CATALOG_ROOT = currentOperationalCatalog.root;
export type CellOrdinal = number; // Positive, one-based; zero is reserved for the sea.
export type EdgeOrdinal = number;
export type OperationalArtifact = Readonly<{path: string; sha256: string; byteLength: number}>;
export type OperationalCatalogDescriptor = Readonly<{
  schemaVersion: 'operational-catalog-v1';
  catalogRef: WorldGeometryCatalogRef;
  indexRoots: Readonly<{catalogOrder: string; administrativeMembership: string; previousParent: string}>;
  counts: Readonly<{countries: number; cells: number; edges: number; administrativeParents: number; previousParents: number}>;
  countryOrder: readonly string[];
}>;
export type OperationalCell = Readonly<{
  id: TerritoryId;
  ordinal: CellOrdinal;
  sourceCountryId: CountryId;
  administrativeOrdinal: number;
  previousParentOrdinal: number;
}>;
/** Physical metadata from the pinned catalog, without loading cell polygons. */
export type OperationalCellMetrics = Readonly<{
  centroid: readonly [number, number];
  areaKm2: number;
  diameterKm: number;
}>;
export type OperationalLandBoundary = Readonly<{
  edgeOrdinal: EdgeOrdinal;
  start: readonly [number, number];
  end: readonly [number, number];
}>;
export type OperationalAdministrativeParent = Readonly<{
  ordinal: number;
  parentKey: string;
  sourceCountryId: string;
  kind: 'administrative' | 'country-envelope-residual';
  adminId: string | null;
  name: string | null;
  sourceFeatureId: string | null;
  sourceVersion: string | null;
  restorationId: string | null;
  residualId: string | null;
  // Presentation hints only. Country metadata rows define explicit membership.
  start: number;
  count: number;
}>;
export type OperationalPreviousParent = Readonly<{
  ordinal: number;
  oldTerritoryId: TerritoryId;
  /** Merged fine units may cross old coarse pieces; every seed source must agree. */
  seedParentIds?: readonly TerritoryId[];
  sourceCountryId: string;
  // Members need not occupy a contiguous interval in global catalog order.
  start: number;
  count: number;
}>;
export type OperationalEdge = Readonly<{
  id: string;
  ordinal: EdgeOrdinal;
  left: CellOrdinal;
  right: CellOrdinal | 0;
  lengthKm: number;
  boundaryClass: 'coast' | 'country' | 'administrative' | 'operational' | 'residual';
  flags: Readonly<{positiveAdjacency: boolean; country: boolean; administrative: boolean; previous: boolean; residual: boolean}>;
}>;

/** A, B and C receive the same authoritative view; no module-level mutable world. */
export type OperationalWorldView = Readonly<{
  catalogRef: WorldGeometryCatalogRef;
  revision: number;
  territoriesById: Readonly<Record<string, TerritoryEntityV3>>;
}>;
export type OperationalOperation = 'occupy' | 'liberate' | 'transfer';
export type OperationalSelection = Readonly<{
  catalogRef: WorldGeometryCatalogRef;
  baseWorldRevision: number;
  actorCountryId: string;
  targetCountryId: string;
  operation: OperationalOperation;
  cellIds: readonly TerritoryId[];
}>;
export type OperationalStateChange = Readonly<{
  catalogRef: WorldGeometryCatalogRef;
  baseWorldRevision: number;
  worldRevision: number;
  cells: readonly Readonly<{id: TerritoryId; before: TerritoryEntityV3; after: TerritoryEntityV3}>[];
}>;

export function readOperationalCellState(world: OperationalWorldView, catalogRef: WorldGeometryCatalogRef, id: TerritoryId) {
  assertWorldGeometryCatalogRefMatches(world.catalogRef, catalogRef);
  const cell = Object.hasOwn(world.territoriesById, id) ? world.territoriesById[id] : undefined;
  if (!cell || cell.id !== id) throw Error('UNKNOWN_OPERATIONAL_CELL_STATE');
  return cell;
}
