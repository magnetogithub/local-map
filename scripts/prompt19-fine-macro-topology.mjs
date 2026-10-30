// Derive macro regions from the exact fine partition, never from a second outline.
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {canonical, compareText, geometryMetadata, hashCanonical, normalizeGeometry, polygons} from './prompt14-catalog-core.mjs';
import {ringsFromSegments} from './prompt14-boundary-arrangement.mjs';
import {globalCellId} from './prompt19-joined-topology.mjs';

const selectedCountry = countryId => countryId === 'KOR' || countryId === 'PRK';
const get = (object, key) => object instanceof Map ? object.get(key) : Object.hasOwn(object ?? {}, key) ? object[key] : undefined;
const text = value => typeof value === 'string' && value.trim().length > 0;
const pointKey = p => `${p[0]},${p[1]}`;
const comparePoint = (a, b) => a[0] - b[0] || a[1] - b[1];
const segmentKey = (a, b) => comparePoint(a, b) < 0 ? `${pointKey(a)};${pointKey(b)}` : `${pointKey(b)};${pointKey(a)}`;
const idFor = cell => cell.id?.startsWith('territory:catalog:') ? cell.id : globalCellId(cell);
const familyFor = cell => canonical([cell.properties.countryId, cell.properties.fineSourceIdentity.sourceId, cell.properties.fineSourceIdentity.sourceFeatureId]);
const parentKey = (countryId, macroId) => `fine-macro:${countryId}:${macroId}`;
const residualParentKey = countryId => `fine-macro-residual:${countryId}`;
const sourceMacroId = (countryId, macroId) => `${countryId}:${macroId}`;

/**
 * Pure exact quotient of a verified joint arrangement.
 * Crosswalks are externally verified country -> raw sourceFeatureId -> macro records.
 * previousParentId is only a representative seed lookup; seedParentIds records every
 * original predecessor whose state must agree before the new cell can inherit it.
 */
export function deriveFineMacroWorld({bundle, cells, crosswalks}) {
  if (!Array.isArray(bundle?.features) || !Array.isArray(bundle.records) || !Array.isArray(bundle.edges) ||
      !Array.isArray(bundle.parents?.administrative) || !Array.isArray(bundle.parents.previous) || !Array.isArray(cells)) throw Error('FINE_MACRO_INVALID_INPUT');
  if (bundle.report?.invalid?.length || bundle.report?.unresolved?.length || bundle.report?.topology?.pass === false) throw Error('FINE_MACRO_UNVERIFIED_INPUT');
  const reader = new GeoJSONReader(), locator = new PointLocator();
  const records = new Map(bundle.records.map(r => [r.id, r]));
  const features = new Map(bundle.features.map(f => [f.id, f]));
  const previousParents = new Map(bundle.parents.previous.map(p => [p.oldTerritoryId, p]));
  if (records.size !== bundle.records.length || features.size !== bundle.features.length || previousParents.size !== bundle.parents.previous.length ||
      records.size !== features.size || [...records.keys()].some(id => !features.has(id))) throw Error('FINE_MACRO_DUPLICATE_OR_MISSING_ID');
  const countries = [...new Set(bundle.records.filter(r => selectedCountry(r.countryId)).map(r => r.countryId))].sort(compareText);
  const locals = new Map(), groups = new Map(), residuals = [], macroParents = new Map();
  for (const cell of cells) {
    const p = cell.properties, countryId = p?.countryId, oldId = idFor(cell), record = records.get(oldId), feature = features.get(oldId);
    if (!selectedCountry(countryId) || !record || record.countryId !== countryId || locals.has(oldId)) throw Error('FINE_MACRO_CELL_SCOPE');
    if (canonical(cell.geometry) !== canonical(feature.geometry)) throw Error('FINE_MACRO_CELL_GEOMETRY_MISMATCH');
    const seedId = record.previousParentId, seed = previousParents.get(seedId);
    if (!seed || seed.sourceCountryId !== countryId) throw Error('FINE_MACRO_SEED_PARENT_SCOPE');
    locals.set(oldId, cell);
    if (p.fineSourceIdentity === null && p.unresolvedFineSourceAssignment === true) {
      residuals.push({cell, oldId, record}); continue;
    }
    const fine = p.fineSourceIdentity;
    if (!fine || !text(fine.sourceId) || !text(fine.sourceFeatureId) || fine.sourceId !== p.sourceId || fine.sourceFeatureId !== p.sourceFeatureId ||
        p.unresolvedFineSourceAssignment !== false || polygons(cell.geometry).length !== 1) throw Error('FINE_MACRO_INVALID_FINE_IDENTITY');
    const macro = get(get(crosswalks, countryId), fine.sourceFeatureId);
    if (!macro || !text(macro.macroId) || !text(macro.name) || (macro.nameKo != null && !text(macro.nameKo)) ||
        (macro.sourceVersion != null && !text(macro.sourceVersion))) throw Error(`FINE_MACRO_MISSING_OR_INVALID_CROSSWALK:${countryId}:${fine.sourceFeatureId}`);
    const key = parentKey(countryId, macro.macroId), description = {countryId, macroId: macro.macroId, name: macro.name,
      nameKo: macro.nameKo ?? macro.name, sourceVersion: macro.sourceVersion ?? null};
    const known = macroParents.get(key);
    if (known && canonical(known) !== canonical(description)) throw Error('FINE_MACRO_INCONSISTENT_PARENT');
    macroParents.set(key, description);
    const family = familyFor(cell), group = groups.get(family) ?? {family, countryId, macro: description, parentKey: key, representative: cell, members: [], segments: new Map(), seen: new Map()};
    if (group.parentKey !== key || group.representative.properties.sourceVersion !== p.sourceVersion) throw Error('FINE_MACRO_INCONSISTENT_SOURCE');
    group.members.push({cell, oldId, record, geometry: reader.read(cell.geometry)});
    for (const poly of polygons(normalizeGeometry(cell.geometry))) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1], b = ring[i], segment = segmentKey(a, b), direction = comparePoint(a, b) < 0 ? 1 : -1, seen = group.seen.get(segment);
      if (!seen) {group.seen.set(segment, {direction, count: 1}); group.segments.set(segment, [a, b]);}
      else {
        if (seen.count !== 1 || seen.direction === direction) throw Error('FINE_MACRO_NON_PARTITION_SEGMENT');
        seen.count++; group.segments.delete(segment);
      }
    }
    groups.set(family, group);
  }
  const expected = bundle.records.filter(r => selectedCountry(r.countryId));
  if (expected.length !== locals.size || expected.some(r => !locals.has(r.id))) throw Error('FINE_MACRO_INCOMPLETE_CELLS');
  const oldCellToNewCell = Object.fromEntries(bundle.records.map(r => [r.id, r.id]));
  const newLocals = [], newFeatures = [], newRecords = [], regionNames = {...bundle.regionNames};
  for (const group of [...groups.values()].sort((a, b) => compareText(a.family, b.family))) {
    const geometry = ringsFromSegments([...group.segments.values()]);
    const parts = polygons(geometry).map(coordinates => {
      const part = normalizeGeometry({type: 'Polygon', coordinates}), g = reader.read(part), validity = new IsValidOp(g);
      if (!validity.isValid()) throw Error(`FINE_MACRO_INVALID_MERGED_POLYGON:${validity.getValidationError()?.getMessage()}`);
      return {part, geometry: g, members: []};
    });
    for (const member of group.members) {
      const point = InteriorPointArea.getInteriorPoint(member.geometry), matches = parts.filter(p => locator.locate(point, p.geometry) === 0);
      if (matches.length !== 1) throw Error('FINE_MACRO_COMPONENT_MEMBERSHIP');
      matches[0].members.push(member);
    }
    for (const {part, members} of parts) {
      if (!members.length) throw Error('FINE_MACRO_EMPTY_COMPONENT');
      const seedParentIds = [...new Set(members.map(m => m.record.previousParentId))].sort(compareText);
      const mergedCellIds = members.map(m => m.oldId).sort(compareText), p = group.representative.properties;
      const localId = `${group.countryId}:cell:${hashCanonical('prompt19-fine-macro-local-cell.v1', {
        countryId: group.countryId, sourceId: p.sourceId, sourceFeatureId: p.sourceFeatureId, macroId: group.macro.macroId, geometry: part})}`;
      const cell = {type: 'Feature', id: localId, properties: {...p, localId, sourceParentId: group.macro.macroId,
        administrativeParentKey: group.parentKey, coarseParentTerritoryId: null, seedParentIds, mergedCellIds,
        arrangementGroup: canonical([group.countryId, p.sourceId, p.sourceFeatureId, group.macro.macroId]),
        hierarchyBasis: 'verified-source-crosswalk; macro is the union of complete fine-source units'}, geometry: part};
      const id = globalCellId(cell);
      for (const oldId of mergedCellIds) oldCellToNewCell[oldId] = id;
      newLocals.push(cell); newFeatures.push({...cell, id});
      newRecords.push({id, countryId: group.countryId, administrativeParentKey: group.parentKey, previousParentId: seedParentIds[0], seedParentIds});
    }
  }
  for (const {cell, oldId, record} of residuals) {
    const seedParentIds = [record.previousParentId], next = {...cell, properties: {...cell.properties,
      administrativeParentKey: residualParentKey(record.countryId), sourceParentId: null, seedParentIds}};
    newLocals.push(next); newFeatures.push({...features.get(oldId), properties: next.properties});
    newRecords.push({...record, administrativeParentKey: residualParentKey(record.countryId), seedParentIds});
  }
  newLocals.sort((a, b) => compareText(a.id, b.id));
  newFeatures.sort((a, b) => compareText(a.id, b.id)); newRecords.sort((a, b) => compareText(a.id, b.id));
  if (new Set(newRecords.map(r => r.id)).size !== newRecords.length) throw Error('FINE_MACRO_DUPLICATE_NEW_ID');
  const transformedRecords = [...bundle.records.filter(r => !selectedCountry(r.countryId)), ...newRecords];
  const transformedFeatures = [...bundle.features.filter(f => !selectedCountry(records.get(f.id).countryId)), ...newFeatures];
  const nextRecords = new Map(transformedRecords.map(r => [r.id, r]));
  const administrative = bundle.parents.administrative.filter(p => !selectedCountry(p.sourceCountryId));
  for (const [key, macro] of [...macroParents].sort(([a], [b]) => compareText(a, b))) {
    const sourceFeatureId = sourceMacroId(macro.countryId, macro.macroId);
    administrative.push({parentKey: key, sourceCountryId: macro.countryId, kind: 'administrative',
      adminId: key, name: macro.name, sourceFeatureId, sourceVersion: macro.sourceVersion,
      restorationId: null, residualId: null, start: 0, count: 0, boundaryBasis: 'fine-derived-macro', macroId: macro.macroId});
    regionNames[sourceFeatureId] = {name: macro.name, name_en: macro.name, name_ko: macro.nameKo};
  }
  for (const countryId of countries) if (residuals.some(r => r.record.countryId === countryId)) {
    administrative.push({parentKey: residualParentKey(countryId), sourceCountryId: countryId, kind: 'country-envelope-residual',
      adminId: null, name: `${countryId} source-unassigned land`, sourceFeatureId: null, sourceVersion: null,
      restorationId: null, residualId: hashCanonical('prompt19-fine-macro-residual-parent.v1', countryId), start: 0, count: 0});
  }
  const seedGroups = new Map();
  for (const record of newRecords) {
    const group = seedGroups.get(record.previousParentId) ?? new Set();
    record.seedParentIds.forEach(id => group.add(id)); seedGroups.set(record.previousParentId, group);
  }
  const previous = bundle.parents.previous.filter(p => !selectedCountry(p.sourceCountryId));
  for (const [id, seeds] of [...seedGroups].sort(([a], [b]) => compareText(a, b))) {
    previous.push({...previousParents.get(id), seedParentIds: [...seeds].sort(compareText)});
  }
  let removedSeams = 0, changedEdges = 0;
  const edges = [];
  for (const edge of bundle.edges) {
    const oldLeft = records.get(edge.leftTerritoryId), oldRight = edge.rightTerritoryId == null ? null : records.get(edge.rightTerritoryId);
    if (!oldLeft || (edge.rightTerritoryId != null && !oldRight)) throw Error('FINE_MACRO_UNKNOWN_EDGE_CELL');
    if (!selectedCountry(oldLeft.countryId) && (!oldRight || !selectedCountry(oldRight.countryId))) {edges.push(edge); continue;}
    const leftTerritoryId = oldCellToNewCell[edge.leftTerritoryId], rightTerritoryId = edge.rightTerritoryId == null ? null : oldCellToNewCell[edge.rightTerritoryId];
    if (leftTerritoryId === rightTerritoryId) {removedSeams++; continue;}
    const left = nextRecords.get(leftTerritoryId), right = rightTerritoryId == null ? null : nextRecords.get(rightTerritoryId);
    let boundaryClass;
    if (!right) boundaryClass = 'coast';
    else if (left.countryId !== right.countryId) boundaryClass = 'country';
    else if (left.administrativeParentKey === residualParentKey(left.countryId) || right.administrativeParentKey === residualParentKey(right.countryId)) boundaryClass = 'residual';
    else boundaryClass = left.administrativeParentKey === right.administrativeParentKey ? 'operational' : 'administrative';
    if (edge.leftTerritoryId === leftTerritoryId && edge.rightTerritoryId === rightTerritoryId && edge.boundaryClass === boundaryClass) {edges.push(edge); continue;}
    const identity = {leftTerritoryId, rightTerritoryId, boundaryClass, geometry: edge.geometry};
    edges.push({...edge, id: `edge:operational:${hashCanonical('prompt19-fine-macro-edge.v1', identity)}`, ...identity}); changedEdges++;
  }
  if (new Set(edges.map(e => e.id)).size !== edges.length) throw Error('FINE_MACRO_DUPLICATE_EDGE');
  const summary = countries.map(countryId => {
    const selected = newLocals.filter(c => c.properties.countryId === countryId), coarse = selected.filter(c => c.properties.fineSourceIdentity === null);
    const before = bundle.report?.summary?.find(s => s.countryId === countryId) ?? {};
    return {...before, countryId, cells: selected.length, fineCells: selected.length - coarse.length, coarseResidualCells: coarse.length,
      arrangedFaceArea: selected.reduce((sum, c) => sum + geometryMetadata(c.geometry).area, 0),
      coarseResidualArea: coarse.reduce((sum, c) => sum + geometryMetadata(c.geometry).area, 0)};
  });
  const selectedEdges = edges.filter(e => selectedCountry(nextRecords.get(e.leftTerritoryId).countryId) || (e.rightTerritoryId && selectedCountry(nextRecords.get(e.rightTerritoryId).countryId)));
  const evidence = {schemaVersion: 'prompt19-fine-macro-quotient-v1', method: 'Exact cancellation of shared boundaries inside complete fine-source families; promoted macro edges are existing shared fine edges.',
    countries, sourceFamilies: groups.size, oldCells: locals.size, cells: newLocals.length, removedSeams, changedEdges,
    inputEdges: bundle.edges.length, outputEdges: edges.length, sourceCoordinatesMoved: 0, independentMacroGeometry: false,
    seedInheritance: 'Each representative previous parent carries all seedParentIds; runtime must reject inheritance unless their complete territory states agree.',
    oldMacroGeometryUsed: false, sourceFreePolicy: 'Original coarse residual cells retain exact IDs and geometry, with unassigned country-residual macro membership.'};
  const sourceSummary = bundle.report?.summary ?? [];
  const report = {...bundle.report, cells: newLocals.length,
    summary: [...sourceSummary.filter(s => !selectedCountry(s.countryId)), ...summary],
    topology: {...bundle.report?.topology, pass: true, edges: selectedEdges.length, method: evidence.method, quotient: evidence}, fineMacro: evidence};
  return {bundle: {...bundle, features: transformedFeatures, records: transformedRecords, edges,
    parents: {...bundle.parents, administrative, previous}, regionNames, report}, cells: newLocals, oldCellToNewCell, evidence};
}
