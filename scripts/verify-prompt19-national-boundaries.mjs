// Independent audit of country/coast reconciliation. No reconciliation implementation is imported.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import RelateOp from 'jsts/org/locationtech/jts/operation/relate/RelateOp.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import CommonBitsOp from 'jsts/org/locationtech/jts/precision/CommonBitsOp.js';
import UnaryUnionOp from 'jsts/org/locationtech/jts/operation/union/UnaryUnionOp.js';
import {canonical, geometryMetadata, polygons, signedArea} from './prompt14-catalog-core.mjs';

const read = file => JSON.parse(fs.readFileSync(file));
const option = (name, fallback) => {const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1];};
const selected = c => c === 'KOR' || c === 'PRK';
const keyOf = feature => feature.properties.fineSourceIdentity ? `${feature.properties.countryId}|${feature.properties.fineSourceIdentity.sourceId}|${feature.properties.fineSourceIdentity.sourceFeatureId}` : null;
const changeKey = change => change.fineSourceIdentity ? `${change.countryId}|${change.fineSourceIdentity.sourceId}|${change.fineSourceIdentity.sourceFeatureId}` : null;
const reader = new GeoJSONReader(), writer = new GeoJSONWriter();
const area = coordinates => coordinates.reduce((sum, polygon) => {
  const value = Math.abs(signedArea(polygon[0])) - polygon.slice(1).reduce((n, ring) => n + Math.abs(signedArea(ring)), 0);
  if (value < -1e-10) throw Error('INDEPENDENT_OVERLAY_NEGATIVE_POLYGON_AREA');
  return sum + Math.max(0, value);
}, 0);
const geometry = coordinates => ({type: 'MultiPolygon', coordinates});
const polygonal = value => value.type === 'GeometryCollection' ? value.geometries.flatMap(polygonal) : value.type === 'Polygon' ? value.coordinates.length ? [value.coordinates] : [] : value.type === 'MultiPolygon' ? value.coordinates : [];
const tolerance = 1e-10;
const coordinateTolerance = 1e-10;
const comparisonPrecision = {gridScale: 1e12, maximumVertexDisplacementDegrees: 0, maximumPolygonAreaChangeDegreesSquared: 0, maximumSymmetricDifferenceAreaBoundDegreesSquared: 0, roundedVertices: 0};
const comparisonCoordinates = coordinates => coordinates.flatMap(polygon => {
  const rings = polygon.map(ring => {
    let perimeter = 0, maximum = 0;
    const rounded = ring.map((p, i) => {
      if (i) perimeter += Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]);
      const next = p.map(v => Math.round(v * comparisonPrecision.gridScale) / comparisonPrecision.gridScale), displacement = Math.hypot(next[0] - p[0], next[1] - p[1]);
      maximum = Math.max(maximum, displacement); comparisonPrecision.roundedVertices++; return next;
    }).filter((p, i, all) => !i || p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]);
    comparisonPrecision.maximumVertexDisplacementDegrees = Math.max(comparisonPrecision.maximumVertexDisplacementDegrees, maximum);
    comparisonPrecision.maximumPolygonAreaChangeDegreesSquared = Math.max(comparisonPrecision.maximumPolygonAreaChangeDegreesSquared, Math.abs(Math.abs(signedArea(ring)) - (rounded.length > 3 ? Math.abs(signedArea(rounded)) : 0)));
    comparisonPrecision.maximumSymmetricDifferenceAreaBoundDegreesSquared = Math.max(comparisonPrecision.maximumSymmetricDifferenceAreaBoundDegreesSquared, 2 * perimeter * maximum + Math.PI * maximum * maximum);
    return rounded.length > 3 && Math.abs(signedArea(rounded)) > 0 ? rounded : null;
  });
  return rings[0] ? [[rings[0], ...rings.slice(1).filter(Boolean)]] : [];
});
const fallbackCounts = {union: 0, difference: 0, intersection: 0};
const overlaySlivers = {components: 0, maximumAreaDiscardedInOneOperationDegreesSquared: 0, componentAreaThresholdDegreesSquared: 1e-14};
const cleanOverlay = coordinates => {
  let discarded = 0;
  const result = coordinates.filter(polygon => {const value = area([polygon]); if (value > overlaySlivers.componentAreaThresholdDegreesSquared) return true; discarded += value; overlaySlivers.components++; return false;});
  if (discarded > tolerance) throw Error('INDEPENDENT_OVERLAY_SLIVERS_EXCEED_AREA_TOLERANCE');
  overlaySlivers.maximumAreaDiscardedInOneOperationDegreesSquared = Math.max(overlaySlivers.maximumAreaDiscardedInOneOperationDegreesSquared, discarded);
  return result;
};
const union = features => {
  if (!features.length) return [];
  const inputs = features.map(f => comparisonCoordinates(polygons(f.geometry))).filter(value => value.length);
  if (!inputs.length) return [];
  try {return polygonClipping.union(...inputs);}
  catch {fallbackCounts.union++; return polygonal(writer.write(UnaryUnionOp.union(reader.read({type: 'GeometryCollection', geometries: inputs.map(geometry)}))));}
};
const difference = (a, b) => {
  a = cleanOverlay(comparisonCoordinates(a)); b = cleanOverlay(comparisonCoordinates(b));
  if (!a.length) return [];
  if (!b.length) return a;
  try {return cleanOverlay(polygonClipping.difference(a, b));}
  catch (original) {
    fallbackCounts.difference++;
    try {return cleanOverlay(polygonal(writer.write(OverlayOp.difference(reader.read(geometry(a)), reader.read(geometry(b))))));}
    catch {try {return cleanOverlay(polygonal(writer.write(new CommonBitsOp(true).difference(reader.read(geometry(a)), reader.read(geometry(b))))));} catch {throw original;}}
  }
};
const intersectionArea = (a, b) => {
  try {return area(polygonClipping.intersection(a, b));}
  catch (original) {
    fallbackCounts.intersection++;
    try {return OverlayOp.intersection(reader.read(geometry(a)), reader.read(geometry(b))).getArea();}
    catch {try {return new CommonBitsOp(true).intersection(reader.read(geometry(a)), reader.read(geometry(b))).getArea();} catch {throw original;}}
  }
};
const grouped = features => {
  const result = new Map();
  for (const f of features) {const key = keyOf(f); if (!key) continue; if (!result.has(key)) result.set(key, []); result.get(key).push(f);}
  return result;
};
const pointKey = p => `${p[0]},${p[1]}`;
const segmentKey = (a, b) => {const x = pointKey(a), y = pointKey(b); return x < y ? `${x};${y}` : `${y};${x}`;};
const segments = value => {
  const result = new Set();
  for (const poly of polygons(value)) for (const ring of poly) for (let i = 1; i < ring.length; i++) result.add(segmentKey(ring[i - 1], ring[i]));
  return result;
};
const haversine = (a, b) => {
  const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
  return 12742 * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2));
};
const lineLength = value => value.coordinates.slice(1).reduce((n, p, i) => n + haversine(value.coordinates[i], p), 0);
const outlineSegments = (bundle, country) => {
  const records = new Map(bundle.records.map(r => [r.id, r])), result = new Set();
  for (const e of bundle.edges) {
    const left = records.get(e.leftTerritoryId)?.countryId, right = records.get(e.rightTerritoryId)?.countryId;
    if (!((left === country && right !== country) || (right === country && left !== country))) continue;
    for (let i = 1; i < e.geometry.coordinates.length; i++) result.add(segmentKey(e.geometry.coordinates[i - 1], e.geometry.coordinates[i]));
  }
  return result;
};
const setDifference = (a, b) => [...a].filter(x => !b.has(x));
const decodeSegment = key => key.split(';').map(value => value.split(',').map(Number));
const uncoveredSegments = (wanted, available) => {
  const bases = [...available].map(decodeSegment).map(([a, b]) => ({a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1])})).sort((a, b) => a.minX - b.minX);
  const uncovered = [];
  for (const key of wanted) {
    if (available.has(key)) continue;
    const [a, b] = decodeSegment(key), dx = b[0] - a[0], dy = b[1] - a[1], squared = dx * dx + dy * dy, length = Math.sqrt(squared);
    if (length <= coordinateTolerance) continue;
    const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]), minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]), ranges = [];
    for (const base of bases) {
      if (base.minX > maxX + coordinateTolerance) break;
      if (base.maxX < minX - coordinateTolerance || base.minY > maxY + coordinateTolerance || base.maxY < minY - coordinateTolerance) continue;
      const project = p => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / squared;
      const first = project(base.a), last = project(base.b), from = Math.max(0, Math.min(first, last)), to = Math.min(1, Math.max(first, last));
      if (to < from) continue;
      const baseDx = base.b[0] - base.a[0], baseDy = base.b[1] - base.a[1], baseLength = Math.hypot(baseDx, baseDy);
      const perpendicular = t => Math.abs((a[0] + t * dx - base.a[0]) * baseDy - (a[1] + t * dy - base.a[1]) * baseDx) / baseLength;
      if (baseLength && perpendicular(from) <= coordinateTolerance && perpendicular(to) <= coordinateTolerance) ranges.push([from, to]);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    let covered = 0;
    for (const [from, to] of ranges) {if (from > covered + coordinateTolerance / length) break; covered = Math.max(covered, to);}
    if (covered < 1 - coordinateTolerance / length) uncovered.push(key);
  }
  return uncovered;
};

export function verifyNationalBoundaries({before, after, beforePath = null, afterPath = null, beforeArtifact = null, afterArtifact = null}) {
  const failures = [], fail = (condition, message, data = {}) => {if (!condition) failures.push({message, ...data});};
  const records = new Map(after.records.map(r => [r.id, r]));
  const oldById = new Map(before.features.map(f => [f.id, f])), newById = new Map(after.features.map(f => [f.id, f]));
  const proofChanges = after.report.nationalBoundaryReconciliation?.changes ?? [];
  const changesBySource = new Map();
  for (const change of proofChanges) {
    const key = changeKey(change);
    fail(!!key && !!change.assignedPartGeometry && change.administrativeTruthClaim !== true, 'Reconciliation change lacks fine identity or assigned geometry');
    if (!key || !change.assignedPartGeometry) continue;
    const list = changesBySource.get(key) ?? []; list.push({geometry: change.assignedPartGeometry}); changesBySource.set(key, list);
  }
  fail(oldById.size === before.features.length && newById.size === after.features.length, 'Duplicate feature IDs');
  fail(records.size === after.records.length && records.size === newById.size, 'Record/feature cardinality differs');
  for (const f of after.features) fail(records.has(f.id) && records.get(f.id).countryId === f.properties.countryId, 'Record/feature identity differs', {id: f.id});
  const countries = [], sourceReports = [], countryUnions = new Map();
  for (const country of ['KOR', 'PRK']) {
    const old = before.features.filter(f => f.properties.countryId === country), now = after.features.filter(f => f.properties.countryId === country);
    const oldUnion = union(old), newUnion = union(now), oldMeta = geometryMetadata(geometry(oldUnion)), newMeta = geometryMetadata(geometry(newUnion));
    countryUnions.set(country, newUnion);
    const missing = area(difference(oldUnion, newUnion)), extra = area(difference(newUnion, oldUnion));
    fail(missing <= tolerance && extra <= tolerance && oldMeta.components === newMeta.components && oldMeta.holes === newMeta.holes, 'Country envelope/islands/holes changed', {country, missing, extra});
    const oldOutline = outlineSegments(before, country), newOutline = outlineSegments(after, country);
    const oldSegmentsMissing = setDifference(oldOutline, newOutline), newSegmentsExtra = setDifference(newOutline, oldOutline);
    const oldUncovered = uncoveredSegments(oldOutline, newOutline), newUncovered = uncoveredSegments(newOutline, oldOutline);
    fail(oldUncovered.length === 0 && newUncovered.length === 0, 'Country/coast linework changed beyond collinear subdivision', {country, oldUncovered: oldUncovered.length, newUncovered: newUncovered.length, previousExamples: oldUncovered.slice(0, 3), currentExamples: newUncovered.slice(0, 3)});
    const oldFine = old.filter(keyOf), oldResidual = old.filter(f => !keyOf(f)), newFine = now.filter(keyOf), newResidual = now.filter(f => !keyOf(f));
    let addedArea = 0, removedArea = 0, unprovedArea = 0;
    const sourceBefore = grouped(old), sourceAfter = grouped(now);
    fail(sourceBefore.size === sourceAfter.size, 'Original fine source-family count changed', {country});
    for (const [key, oldFamily] of sourceBefore) {
      const newFamily = sourceAfter.get(key) ?? [], a = union(oldFamily), b = union(newFamily);
      const oldLost = area(difference(a, b)), gain = difference(b, a);
      const previousParentIds = new Set(oldFamily.map(f => f.properties.sourceParentId));
      const macroMismatch = newFamily.filter(f => !previousParentIds.has(f.properties.sourceParentId)).length;
      const provenanceFailures = area(gain) > tolerance ? newFamily.filter(f => {
        const ownGain = area(difference(polygons(f.geometry), a));
        return ownGain > tolerance && (f.properties.geometryAdjusted !== true || f.properties.boundaryAdjustment?.administrativeTruthClaim !== false);
      }).length : 0;
      const claimed = union(changesBySource.get(key) ?? []), unprovedGain = area(difference(gain, claimed)), overclaimed = area(difference(claimed, gain));
      const exactAreaGain = area(b) - area(a) + oldLost;
      addedArea += exactAreaGain; removedArea += oldLost; unprovedArea += unprovedGain;
      fail(oldLost <= tolerance && macroMismatch === 0, 'Fine identity lost territory or changed macro lineage', {country, source: key, oldLost, macroMismatch});
      fail(provenanceFailures === 0, 'Adapted fine geometry lacks explicit gameplay-only provenance', {country, source: key, provenanceFailures});
      fail(unprovedGain <= tolerance && overclaimed <= tolerance, 'Added fine territory differs from declared residual assignment geometry', {country, source: key, unprovedGain, overclaimed});
      sourceReports.push({country, source: key, previousCells: oldFamily.length, cells: newFamily.length, removedAreaDegreesSquared: oldLost, addedAreaDegreesSquared: exactAreaGain, unprovedGainAreaDegreesSquared: unprovedGain, overclaimedAssignmentAreaDegreesSquared: overclaimed, macroMismatch, provenanceFailures});
    }
    const residualAreaBefore = oldResidual.reduce((n, f) => n + area(polygons(f.geometry)), 0), residualAreaAfter = newResidual.reduce((n, f) => n + area(polygons(f.geometry)), 0);
    const residualAccountingError = residualAreaBefore - residualAreaAfter - addedArea;
    fail(removedArea <= tolerance && unprovedArea <= tolerance && Math.abs(residualAccountingError) <= tolerance, 'Fine/residual territory accounting failed', {country, removedArea, unprovedArea, residualAccountingError});
    const shapes = now.map(f => ({...f, ...geometryMetadata(f.geometry), jsts: reader.read(f.geometry)})).sort((a, b) => a.bbox[0] - b.bbox[0]);
    let invalid = 0, candidates = 0, interiorOverlaps = 0, positiveAreaOverlaps = 0, predicateErrors = 0;
    for (const f of shapes) if (!new IsValidOp(f.jsts).isValid()) {invalid++; fail(false, 'Invalid reconciled polygon', {country, id: f.id});}
    for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length && shapes[j].bbox[0] < shapes[i].bbox[2]; j++) {
      const a = shapes[i], b = shapes[j]; if (b.bbox[1] >= a.bbox[3] || b.bbox[3] <= a.bbox[1]) continue; candidates++;
      try {
        if (RelateOp.relate(a.jsts, b.jsts).get(0, 0) >= 0) interiorOverlaps++;
        if (intersectionArea(polygons(a.geometry), polygons(b.geometry)) > tolerance) positiveAreaOverlaps++;
      } catch (e) {predicateErrors++; fail(false, 'Overlap predicate failed', {country, left: a.id, right: b.id, error: e.message});}
    }
    fail(invalid === 0 && interiorOverlaps === 0 && positiveAreaOverlaps === 0 && predicateErrors === 0, 'Reconciled country partition overlaps or is invalid', {country});
    countries.push({country, beforeCells: old.length, cells: now.length, beforeFine: oldFine.length, fine: newFine.length, beforeResidual: oldResidual.length, residual: newResidual.length, missingAreaDegreesSquared: missing, extraAreaDegreesSquared: extra, previousComponents: oldMeta.components, components: newMeta.components, previousHoles: oldMeta.holes, holes: newMeta.holes, bbox: newMeta.bbox, previousAreaDegreesSquared: oldMeta.area, areaDegreesSquared: newMeta.area, addedFineAreaDegreesSquared: addedArea, removedFineAreaDegreesSquared: removedArea, unprovenAddedFineAreaDegreesSquared: unprovedArea, previousResidualAreaDegreesSquared: residualAreaBefore, residualAreaDegreesSquared: residualAreaAfter, residualAccountingErrorDegreesSquared: residualAccountingError, residualOnlyGainProof: 'Each original fine family is preserved; the final partition is disjoint and its country union is unchanged, so all fine gains belong to the original residual complement.', invalid, bboxCandidatePairs: candidates, interiorOverlaps, positiveAreaOverlaps, predicateErrors, outlineMissingCoordinateSegments: oldSegmentsMissing.length, outlineExtraCoordinateSegments: newSegmentsExtra.length, oldOutlineUncoveredSegments: oldUncovered.length, newOutlineUncoveredSegments: newUncovered.length});
  }
  const crossCountryOverlapAreaDegreesSquared = intersectionArea(countryUnions.get('KOR'), countryUnions.get('PRK'));
  fail(crossCountryOverlapAreaDegreesSquared <= tolerance, 'KOR and PRK final country polygons overlap', {crossCountryOverlapAreaDegreesSquared});
  let unchangedOtherCountries = 0, changedOtherFeatures = 0;
  for (const country of new Set(before.records.filter(r => !selected(r.countryId)).map(r => r.countryId))) {
    const old = before.features.filter(f => f.properties.countryId === country), now = after.features.filter(f => f.properties.countryId === country);
    if (old.length !== now.length || old.some(f => !newById.has(f.id) || canonical(f.geometry) !== canonical(newById.get(f.id).geometry))) changedOtherFeatures++;
    else unchangedOtherCountries++;
  }
  fail(changedOtherFeatures === 0, 'Other-country ID/geometry changed', {changedOtherFeatures});
  const segmentsById = new Map(after.features.filter(f => selected(f.properties.countryId)).map(f => [f.id, segments(f.geometry)]));
  let missingEdgeSides = 0, nationalBoundaryNotMesh = 0, coastBoundaryNotMesh = 0, invalidInteriorEdges = 0;
  const graphSegments = new Map();
  const boundaryCoverage = Object.fromEntries(['KOR', 'PRK'].map(country => [country, {coast: {totalKm: 0, fineKm: 0, residualKm: 0}, country: {totalKm: 0, fineKm: 0, residualKm: 0}}]));
  const dmzClasses = {}, zones = {west: {}, central: {}, east: {}};
  const count = (target, category, edge) => {target[category] ??= {edges: 0, lengthKm: 0}; target[category].edges++; target[category].lengthKm += lineLength(edge.geometry);};
  for (const e of after.edges) {
    const l = records.get(e.leftTerritoryId), r = records.get(e.rightTerritoryId), lf = newById.get(e.leftTerritoryId), rf = newById.get(e.rightTerritoryId);
    if (!l || (e.rightTerritoryId && !r)) {missingEdgeSides++; continue;}
    const national = r && l.countryId !== r.countryId, coast = !r;
    if (national || coast) for (const [row, feature] of [[l, lf], [r, rf]]) if (row && selected(row.countryId)) {
      const value = boundaryCoverage[row.countryId][coast ? 'coast' : 'country'], km = lineLength(e.geometry);
      value.totalKm += km; value[keyOf(feature) ? 'fineKm' : 'residualKm'] += km;
    }
    if (selected(l.countryId) || selected(r?.countryId)) for (let i = 1; i < e.geometry.coordinates.length; i++) {
      const key = segmentKey(e.geometry.coordinates[i - 1], e.geometry.coordinates[i]);
      graphSegments.set(key, (graphSegments.get(key) ?? 0) + 1);
    }
    for (const [id, row] of [[e.leftTerritoryId, l], [e.rightTerritoryId, r]]) {
      if (!row || !selected(row.countryId)) continue;
      const known = segmentsById.get(id);
      const missing = e.geometry.coordinates.slice(1).some((p, i) => !known.has(segmentKey(e.geometry.coordinates[i], p)));
      if (missing) {if (national) nationalBoundaryNotMesh++; else if (coast) coastBoundaryNotMesh++; else invalidInteriorEdges++;}
    }
    if (national && [l.countryId, r.countryId].sort().join('|') === 'KOR|PRK') {
      const category = [keyOf(lf) ? 'fine' : 'residual', keyOf(rf) ? 'fine' : 'residual'].sort().join('-');
      count(dmzClasses, category, e);
      const centerLon = e.geometry.coordinates.reduce((s, p) => s + p[0], 0) / e.geometry.coordinates.length;
      count(zones[centerLon < 127.1 ? 'west' : centerLon < 128 ? 'central' : 'east'], category, e);
    }
  }
  let missingMeshSegments = 0;
  for (const cellSegments of segmentsById.values()) for (const key of cellSegments) if (!graphSegments.has(key)) missingMeshSegments++;
  const duplicateGraphSegments = [...graphSegments.values()].filter(n => n > 1).length;
  fail(missingMeshSegments === 0 && duplicateGraphSegments === 0, 'Final mesh/graph has missing or duplicate boundary segments', {missingMeshSegments, duplicateGraphSegments});
  fail(missingEdgeSides === 0 && nationalBoundaryNotMesh === 0 && coastBoundaryNotMesh === 0 && invalidInteriorEdges === 0, 'Edge is not the actual boundary of both adjacent final mesh cells', {missingEdgeSides, nationalBoundaryNotMesh, coastBoundaryNotMesh, invalidInteriorEdges});
  const adaptedFamilies = sourceReports.filter(r => r.addedAreaDegreesSquared > tolerance).length;
  fail(adaptedFamilies === 0 || after.report.strictSourceMembership === false, 'Adapted geometry must not claim strict raw-source containment', {adaptedFamilies, strictSourceMembership: after.report.strictSourceMembership});
  fail(comparisonPrecision.maximumVertexDisplacementDegrees <= 1e-12 && comparisonPrecision.maximumSymmetricDifferenceAreaBoundDegreesSquared <= tolerance, 'Comparison-grid normalization exceeds its certified displacement/area budget', {...comparisonPrecision});
  const result = {date: '2026-10-30', beforePath, afterPath, before: beforeArtifact, after: afterArtifact, pass: failures.length === 0, numericalAreaToleranceDegreesSquared: tolerance, numericalCoordinateToleranceDegrees: coordinateTolerance, comparisonPrecisionNormalization: {...comparisonPrecision, purpose: 'Only independent overlay operands use the common 1e12 grid. Validity, DE9IM overlap, final shared-segment ownership and outline displacement checks use original output coordinates.', areaBoundMethod: 'Each rounded ring lies within maximum vertex displacement of the original ring; the conservative two-sided boundary-band bound is 2 * perimeter * displacement + PI * displacement^2.'}, discardedNumericalOverlaySlivers: {...overlaySlivers}, countries, unchangedOtherCountries, changedOtherFeatures, sources: sourceReports, adaptedFamilies, topology: {missingEdgeSides, nationalBoundaryNotMesh, coastBoundaryNotMesh, invalidInteriorEdges, missingMeshSegments, duplicateGraphSegments, crossCountryOverlapAreaDegreesSquared}, boundaryCoverage, dmz: {classes: dmzClasses, zones}, fallbackCounts: {...fallbackCounts}, failures, limits: ['Source identity and verified macro ancestry are preserved; adapted coast/border geometry is not certified as unchanged raw administrative-source geometry.', 'Area comparisons normalize both operands to the explicitly certified grid; final country/coast linework must cover the prior linework in both directions within the stated coordinate tolerance.', 'Residual territory without supported fine attribution remains explicit rather than inventing source identity.']};
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const beforePath = option('--before', 'reports/maintenance/prompt19-C/fine-macro-2020-joined-world-input.json');
  const afterPath = option('--input', null);
  if (!afterPath) throw Error('MISSING_ARGUMENT:--input');
  const output = option('--output', 'reports/maintenance/20261030-national-boundary-independent-verification.json');
  const artifact = file => {const bytes = fs.readFileSync(file); return {path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};};
  const result = verifyNationalBoundaries({before: read(beforePath), after: read(afterPath), beforePath, afterPath, beforeArtifact: artifact(beforePath), afterArtifact: artifact(afterPath)});
  fs.mkdirSync(path.dirname(output), {recursive: true}); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({...result, sources: undefined, failures: result.failures.slice(0, 12)}));
  if (!result.pass) process.exitCode = 2;
}
