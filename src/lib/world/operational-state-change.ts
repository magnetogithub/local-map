import type {OperationalStateChange, OperationalWorldView} from './operational-catalog';
import {assertWorldGeometryCatalogRefMatches} from './world-geometry-catalog-ref';

/** Derive the complete render delta from authoritative snapshots, never a provider's summary. */
export function createOperationalStateChange(before: OperationalWorldView, after: OperationalWorldView): OperationalStateChange {
  assertWorldGeometryCatalogRefMatches(before.catalogRef, after.catalogRef);
  const cells: OperationalStateChange['cells'][number][] = [];
  if (before.territoriesById !== after.territoriesById) {
    for (const id of Object.keys(after.territoriesById)) {
      const previous = before.territoriesById[id], next = after.territoriesById[id];
      if (!previous || previous.id !== next.id || previous.sourceCountryId !== next.sourceCountryId) {
        throw Error('OPERATIONAL_STATE_IDENTITY_MISMATCH');
      }
      if (previous.ownerCountryId !== next.ownerCountryId || previous.controllerCountryId !== next.controllerCountryId) {
        cells.push(Object.freeze({id: next.id, before: previous, after: next}));
      }
    }
    if (Object.keys(before.territoriesById).length !== Object.keys(after.territoriesById).length) {
      throw Error('OPERATIONAL_STATE_IDENTITY_MISMATCH');
    }
    cells.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  return Object.freeze({catalogRef: after.catalogRef, baseWorldRevision: before.revision,
    worldRevision: after.revision, cells: Object.freeze(cells)});
}
