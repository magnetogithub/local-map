import 'server-only';
import {z} from 'zod';
import {operationalFrontierPolicy as policy} from './operational-frontier-policy';
import type {OperationalCatalog} from '../world/operational-catalog.server';
import {readOperationalCellState, type OperationalCell, type OperationalSelection, type OperationalWorldView} from '../world/operational-catalog';
import {assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';
import type {TerritoryEntityV3} from '../world/territory-entity-v3';
import type {CatalogRegionIndex} from './catalog-region';
import {operationalFrontierRequestSchema, type OperationalFrontierRequest} from './operational-frontier-contract';
export {operationalFrontierRequestSchema, type OperationalFrontierRequest} from './operational-frontier-contract';
export type OperationalFrontierCatalog = Pick<OperationalCatalog, 'ref' | 'cell' | 'cellMetrics' | 'neighbors' | 'sharedBoundary' | 'administrativeMembership' | 'administrativeParents'>;
export type OperationalFrontierSelection = OperationalSelection & Readonly<{
  scope: OperationalFrontierRequest;
  frontier: Readonly<{kind: 'land-border' | 'current-controller'; cellId: string; supportCellId: string; edgeOrdinal: number}>;
  effectTarget: Readonly<{territoryIds: OperationalSelection['cellIds']; regionRefs: null}>;
  metrics: Readonly<{
    count: number; areaKm2: number; maximumGraphDepthKm: number; maximumForwardDepthKm: number;
    maximumLateralKm: number; maximumCellDiameterKm: number;
  }>;
  limits: Readonly<{depthKm: number; widthKm: number; maximumAreaKm2: number}>;
  approximation: string;
}>;

const rad = Math.PI / 180;
const longitudeDelta = (from: number, to: number) => ((to - from + 540) % 360) - 180;
const distanceKm = (a: readonly [number, number], b: readonly [number, number]) => {
  const value = Math.sin((b[1] - a[1]) * rad / 2) ** 2
    + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(longitudeDelta(a[0], b[0]) * rad / 2) ** 2;
  return 2 * policy.earthRadiusKm * Math.asin(Math.sqrt(Math.min(1, Math.max(0, value))));
};
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Read-only selection. The caller supplies the authoritative current world on every call. */
export function selectOperationalFrontier(
  catalog: OperationalFrontierCatalog,
  world: OperationalWorldView,
  rawRequest: unknown,
  regions?: CatalogRegionIndex,
): OperationalFrontierSelection {
  const request = operationalFrontierRequestSchema.parse(rawRequest);
  assertWorldGeometryCatalogRefMatches(request.catalogRef, catalog.ref);
  assertWorldGeometryCatalogRefMatches(world.catalogRef, catalog.ref);
  if (!Number.isSafeInteger(world.revision) || world.revision !== request.baseWorldRevision) throw Error('STALE_WORLD_REVISION');
  if (request.actorCountryId === request.targetCountryId) throw Error('FRONTIER_COUNTRY_SCOPE');

  let regionIds: ReadonlySet<string> | undefined;
  let reference = request.reference;
  if (reference || request.regionQuery) {
    if (!regions?.catalogRef) throw Error('REGION_RESOLVER_REQUIRED');
    assertWorldGeometryCatalogRefMatches(regions.catalogRef, catalog.ref);
    // Transfer selects the donor side. Other operations select the opposing side.
    const countryId = request.operation === 'transfer' ? request.actorCountryId : request.targetCountryId;
    if (request.regionQuery) {
      const candidates = regions.search(countryId, request.regionQuery);
      if (candidates.length !== 1) throw Error(candidates.length ? 'AMBIGUOUS_REGION' : 'UNKNOWN_REGION');
      reference = candidates[0].ref;
    }
    regionIds = new Set(regions.lookup(countryId, reference!).territoryIds);
  }

  const states = new Map<number, TerritoryEntityV3>();
  const state = (cell: OperationalCell) => {
    let current = states.get(cell.ordinal);
    if (!current) {
      current = readOperationalCellState(world, catalog.ref, cell.id);
      if (current.sourceCountryId !== cell.sourceCountryId) throw Error('OPERATIONAL_CELL_SOURCE_MISMATCH');
      states.set(cell.ordinal, current);
    }
    return current;
  };
  const eligibleState = (t: TerritoryEntityV3) => {
    if (request.operation === 'occupy') return t.ownerCountryId === request.targetCountryId && t.controllerCountryId === request.targetCountryId;
    if (request.operation === 'liberate') return t.ownerCountryId !== null && t.controllerCountryId === request.targetCountryId && t.controllerCountryId !== t.ownerCountryId;
    return t.ownerCountryId === request.actorCountryId;
  };
  const supportCountry = request.operation === 'transfer' ? request.targetCountryId : request.actorCountryId;
  type Contact = {cell: OperationalCell; support: OperationalCell; advanced: boolean};
  const contacts: Contact[] = [];
  const eligible = new Set<number>();
  let actorPresent = false, targetPresent = false;
  // Current ownership/control may differ from sourceCountryId, including after annexation.
  for (const id of Object.keys(world.territoriesById)) {
    const current = world.territoriesById[id];
    actorPresent ||= current.ownerCountryId === request.actorCountryId || current.controllerCountryId === request.actorCountryId;
    targetPresent ||= current.ownerCountryId === request.targetCountryId || current.controllerCountryId === request.targetCountryId;
    if (!eligibleState(current) || (regionIds && !regionIds.has(id))) continue;
    const cell = catalog.cell(id);
    if (current.id !== id) throw Error('UNKNOWN_OPERATIONAL_CELL_STATE');
    state(cell); eligible.add(cell.ordinal);
  }
  if (!actorPresent || !targetPresent) throw Error('UNKNOWN_FRONTIER_COUNTRY');
  for (const ordinal of eligible) {
    const cell = catalog.cell(ordinal);
    for (const n of catalog.neighbors(ordinal)) {
      // neighbors() contains positive-length land contacts only; never coast/point contacts.
      const support = catalog.cell(n);
      if (state(support).controllerCountryId === supportCountry) {
        contacts.push({cell, support, advanced: support.sourceCountryId === cell.sourceCountryId});
      }
    }
  }
  if (!contacts.length) throw Error('NO_CURRENT_LAND_FRONTIER');

  // Prefer the front already inside the source country to an untouched national border.
  // A direction locates a portion of that front; it never supplies invented coordinates.
  const directionalRank = (c: OperationalCell) => {
    const [x, y] = catalog.cellMetrics(c.ordinal).centroid;
    return request.direction === 'north' ? -y : request.direction === 'south' ? y
      : request.direction === 'east' ? -x : request.direction === 'west' ? x : 0;
  };
  contacts.sort((a, b) => Number(b.advanced) - Number(a.advanced)
    || directionalRank(a.cell) - directionalRank(b.cell)
    || catalog.cellMetrics(b.cell.ordinal).areaKm2 - catalog.cellMetrics(a.cell.ordinal).areaKm2
    || compareId(a.cell.id, b.cell.id) || compareId(a.support.id, b.support.id));
  const contact = contacts[0], boundary = catalog.sharedBoundary(contact.cell.ordinal, contact.support.ordinal);
  const delta = longitudeDelta(boundary.start[0], boundary.end[0]);
  const anchor: [number, number] = [((boundary.start[0] + delta / 2 + 540) % 360) - 180, (boundary.start[1] + boundary.end[1]) / 2];
  const offset = (point: readonly [number, number]) => [longitudeDelta(anchor[0], point[0]) * rad * policy.earthRadiusKm * Math.cos(anchor[1] * rad), (point[1] - anchor[1]) * rad * policy.earthRadiusKm];
  const dx = delta * Math.cos(anchor[1] * rad), dy = boundary.end[1] - boundary.start[1], length = Math.hypot(dx, dy);
  if (!(length > 0)) throw Error('NO_OPERATIONAL_LAND_BOUNDARY');
  const tangent = [dx / length, dy / length];
  const targetOffset = offset(catalog.cellMetrics(contact.cell.ordinal).centroid);
  let normal = [-tangent[1], tangent[0]];
  if (targetOffset[0] * normal[0] + targetOffset[1] * normal[1] < 0) normal = normal.map(n => -n);
  const limits = Object.freeze({...policy.ranges[request.extent]});
  const projected = (n: number) => {
    const v = offset(catalog.cellMetrics(n).centroid);
    return {forward: v[0] * normal[0] + v[1] * normal[1], lateral: Math.abs(v[0] * tangent[0] + v[1] * tangent[1])};
  };
  const inCorridor = (n: number) => {
    if (!eligible.has(n)) return false;
    const p = projected(n);
    return p.forward >= -1e-8 && p.forward <= limits.depthKm && p.lateral <= limits.widthKm / 2
      && distanceKm(anchor, catalog.cellMetrics(n).centroid) <= Math.hypot(limits.depthKm, limits.widthKm / 2);
  };
  const seed = contact.cell.ordinal;
  if (!inCorridor(seed)) throw Error('FRONTIER_SCOPE_EMPTY');
  const firstDistance = distanceKm(anchor, catalog.cellMetrics(seed).centroid);
  if (firstDistance > limits.depthKm) throw Error('FRONTIER_SCOPE_EMPTY');
  const distances = new Map<number, number>([[seed, firstDistance]]);
  const queue: [number, number][] = [[firstDistance, seed]];
  const settled = new Set<number>();
  let areaKm2 = 0;
  // Small bounded Dijkstra traversal. A failed cap returns no usable partial selection.
  while (queue.length) {
    queue.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const [distance, n] = queue.pop()!;
    if (settled.has(n) || distance !== distances.get(n)) continue;
    settled.add(n); areaKm2 += catalog.cellMetrics(n).areaKm2;
    if (settled.size > request.cap || areaKm2 > limits.maximumAreaKm2) throw Error('FRONTIER_REQUEST_CAP');
    for (const next of catalog.neighbors(n)) {
      if (settled.has(next) || !inCorridor(next)) continue;
      const nextDistance = distance + distanceKm(catalog.cellMetrics(n).centroid, catalog.cellMetrics(next).centroid);
      if (nextDistance <= limits.depthKm && nextDistance < (distances.get(next) ?? Infinity)) {
        distances.set(next, nextDistance); queue.push([nextDistance, next]);
      }
    }
  }

  if (request.extent === 'near') {
    const areas = new Map<number, number>();
    for (const n of settled) {
      const c = catalog.cell(n);
      areas.set(c.administrativeOrdinal, (areas.get(c.administrativeOrdinal) ?? 0) + catalog.cellMetrics(n).areaKm2);
    }
    for (const [ordinal, selectedArea] of areas) {
      const parent = catalog.administrativeParents[ordinal - 1];
      const total = catalog.administrativeMembership(parent.parentKey).reduce((sum, c) => sum + catalog.cellMetrics(c.ordinal).areaKm2, 0);
      if (total >= policy.sufficientlyLargeAdministrativeAreaKm2 && selectedArea / total > policy.nearMaximumParentAreaFraction) throw Error('FRONTIER_PARENT_AREA_CAP');
    }
  }
  const cells = [...settled].map(n => catalog.cell(n));
  const cellIds = Object.freeze(cells.map(c => c.id).sort(compareId));
  const scope = Object.freeze({...request, direction: request.direction ?? null, reference: reference ? Object.freeze({...reference}) : null, regionQuery: null});
  return Object.freeze({catalogRef: catalog.ref, baseWorldRevision: world.revision, actorCountryId: request.actorCountryId,
    targetCountryId: request.targetCountryId, operation: request.operation, cellIds, scope, limits,
    frontier: Object.freeze({kind: contact.advanced ? 'current-controller' : 'land-border', cellId: contact.cell.id, supportCellId: contact.support.id, edgeOrdinal: boundary.edgeOrdinal}),
    effectTarget: Object.freeze({territoryIds: cellIds, regionRefs: null}),
    metrics: Object.freeze({count: cells.length, areaKm2, maximumGraphDepthKm: Math.max(...[...settled].map(n => distances.get(n)!)),
      maximumForwardDepthKm: Math.max(...cells.map(c => projected(c.ordinal).forward)), maximumLateralKm: Math.max(...cells.map(c => projected(c.ordinal).lateral)),
      maximumCellDiameterKm: Math.max(...cells.map(c => catalog.cellMetrics(c.ordinal).diameterKm))}),
    approximation: 'Centroid great-circle graph distances in a local corridor anchored on an existing shared land edge. Whole cells can extend beyond the centroid limits by their diameter; this is not an exact geodesic band.',
  });
}

/** For the subsequent provider tool: retains no mutable world and grants no authority. */
export function createOperationalFrontierLookup(catalog: OperationalFrontierCatalog, regions?: CatalogRegionIndex) {
  return (world: OperationalWorldView, request: unknown) => {
    try {return {ok: true as const, selection: selectOperationalFrontier(catalog, world, request, regions)};}
    catch (error) {
      const code = error instanceof z.ZodError ? 'INVALID_FRONTIER_REQUEST' : error instanceof Error ? error.message : 'FRONTIER_LOOKUP_FAILED';
      const message = code === 'NO_CURRENT_LAND_FRONTIER' ? '현재 통제 상태에서 연결된 육상 접경을 찾을 수 없습니다.'
        : code === 'FRONTIER_REQUEST_CAP' || code === 'FRONTIER_PARENT_AREA_CAP' ? '선택 범위가 상한을 넘습니다. 더 작은 범위나 특정 접경 지역을 요청하세요.'
        : code === 'AMBIGUOUS_REGION' || code === 'UNKNOWN_REGION' ? '대상 지역을 하나로 결정할 수 없습니다. 국가 또는 지역을 구체적으로 지정하세요.'
        : '현재 상태와 요청의 catalog, revision 및 범위를 확인하세요.';
      return {ok: false as const, code, message};
    }
  };
}
