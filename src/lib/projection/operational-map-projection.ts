import type {OperationalStateChange, OperationalWorldView} from '../world/operational-catalog';
import type {TerritoryId} from '../world/territory-id';
import {createTerritoryEntityV3, type TerritoryEntityV3} from '../world/territory-entity-v3';
import {assertWorldGeometryCatalogRefMatches, type WorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import {mapColorPresentation} from '../world/country-map-color';

/** The world/order is supplied by the runtime, never reconstructed from source-country ownership. */
export type OperationalMapWorld = OperationalWorldView & Readonly<{
  territoryOrder: readonly TerritoryId[];
  countriesById: Readonly<Record<string, Readonly<{mapColor: string}>>>;
}>;
export type OperationalMapProjection = Readonly<{world: OperationalMapWorld; appliedRevision: number}>;
// Module-lifetime FIFO: retain at most 512 successful color presentations, never worlds or cells.
// Hits do not reorder entries, keeping the per-cell path to a single lookup.
const COLOR_PRESENTATION_CACHE_LIMIT = 512;
const colorPresentations = new Map<string, ReturnType<typeof mapColorPresentation>>();
function cachedColorPresentation(color: string) {
  const cached = colorPresentations.get(color);
  if (cached) return cached;
  const presentation = mapColorPresentation(color);
  if (colorPresentations.size >= COLOR_PRESENTATION_CACHE_LIMIT) {
    const oldest = colorPresentations.keys().next().value;
    if (oldest !== undefined) colorPresentations.delete(oldest);
  }
  colorPresentations.set(color, presentation);
  return presentation;
}
const same = (a: TerritoryEntityV3, b: TerritoryEntityV3) => a.id === b.id && a.sourceCountryId === b.sourceCountryId && a.ownerCountryId === b.ownerCountryId && a.controllerCountryId === b.controllerCountryId;
export function createOperationalMapProjection(world: OperationalMapWorld, ref: WorldGeometryCatalogRef, cellCount: number): OperationalMapProjection {
  assertWorldGeometryCatalogRefMatches(world.catalogRef, ref);
  if (!Number.isSafeInteger(world.revision) || world.revision < 0 || world.territoryOrder.length !== cellCount) throw Error('INVALID_OPERATIONAL_MAP_WORLD');
  return Object.freeze({world, appliedRevision: world.revision});
}
function cellAt(world: OperationalMapWorld, ordinal: number) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw Error('INVALID_OPERATIONAL_MAP_ORDINAL');
  const id = world.territoryOrder[ordinal - 1], cell = world.territoriesById[id];
  if (!id || !cell || cell.id !== id) throw Error('UNKNOWN_OPERATIONAL_MAP_CELL');
  return cell;
}
export function operationalCellView(world: OperationalMapWorld, ordinal: number) {
  const cell = cellAt(world, ordinal), controller = cell.controllerCountryId, country = controller === null ? null : world.countriesById[controller];
  if (controller !== null && !country) throw Error('UNKNOWN_OPERATIONAL_MAP_CONTROLLER');
  return {ordinal, ...cell, ...cachedColorPresentation(country?.mapColor ?? '#D6D3C7'), occupied: controller !== null && controller !== cell.ownerCountryId};
}
export function operationalFront(world: OperationalMapWorld, pair: Readonly<{left: number; right: number}>) {
  if (pair.right <= 0) return false;
  const a = cellAt(world, pair.left), b = cellAt(world, pair.right);
  if (!a.ownerCountryId || !b.ownerCountryId || !a.controllerCountryId || !b.controllerCountryId ||
      !world.countriesById[a.ownerCountryId] || !world.countriesById[b.ownerCountryId] ||
      !world.countriesById[a.controllerCountryId] || !world.countriesById[b.controllerCountryId]) return false;
  return a.controllerCountryId !== b.controllerCountryId &&
    (a.controllerCountryId !== a.ownerCountryId || b.controllerCountryId !== b.ownerCountryId);
}

/** An explicit runtime delta avoids a world scan. Snapshot restoration can derive the same small delta. */
export function prepareOperationalMapUpdate(previous: OperationalMapProjection, world: OperationalMapWorld, change?: OperationalStateChange) {
  const before = previous.world;
  assertWorldGeometryCatalogRefMatches(world.catalogRef, before.catalogRef);
  if (!Number.isSafeInteger(world.revision) || world.revision <= previous.appliedRevision) throw Error('STALE_OPERATIONAL_MAP_REVISION');
  if (world.territoryOrder.length !== before.territoryOrder.length) throw Error('OPERATIONAL_MAP_ORDER_CHANGED');
  const cells: OperationalStateChange['cells'][number][] = [];
  if (change) {
    assertWorldGeometryCatalogRefMatches(change.catalogRef, world.catalogRef);
    if (change.baseWorldRevision !== previous.appliedRevision || change.worldRevision !== world.revision) throw Error('STALE_OPERATIONAL_MAP_DELTA');
    const seen = new Set<string>();
    for (const c of change.cells) {
      const a = before.territoriesById[c.id], b = world.territoriesById[c.id];
      createTerritoryEntityV3(c.before); createTerritoryEntityV3(c.after);
      if (seen.has(c.id) || !a || !b || !same(a, c.before) || !same(b, c.after) || a.sourceCountryId !== b.sourceCountryId) throw Error('INVALID_OPERATIONAL_MAP_DELTA');
      seen.add(c.id); if (!same(a, b)) cells.push(c);
    }
  } else if (world.territoriesById !== before.territoriesById) {
    for (let i = 0; i < world.territoryOrder.length; i++) {
      const id = world.territoryOrder[i], a = before.territoriesById[id], b = world.territoriesById[id];
      if (id !== before.territoryOrder[i] || !a || !b || a.sourceCountryId !== b.sourceCountryId) throw Error('OPERATIONAL_MAP_ORDER_CHANGED');
      if (!same(a, b)) {createTerritoryEntityV3(b); cells.push({id, before: a, after: b});}
    }
  }
  const countryColors = new Set([...Object.keys(before.countriesById), ...Object.keys(world.countriesById)]
    .filter(id => before.countriesById[id]?.mapColor !== world.countriesById[id]?.mapColor));
  return {projection: Object.freeze({world, appliedRevision: world.revision}), cells, countryColors};
}
