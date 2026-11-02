// Gameplay-only reconciliation of the locked country partition and fine families.
// Raw administrative source geometry remains an independent, unchanged input.
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import DistanceOp from 'jsts/org/locationtech/jts/operation/distance/DistanceOp.js';
import {canonical, compareText, geometryMetadata, hashCanonical, normalizeGeometry, polygons} from './prompt14-catalog-core.mjs';
import {commonNodeRings, ringsFromSegments} from './prompt14-boundary-arrangement.mjs';
import {globalCellId} from './prompt19-joined-topology.mjs';

const selected = countryId => countryId === 'KOR' || countryId === 'PRK';
const pointKey = p => `${p[0]},${p[1]}`;
const comparePoint = (a, b) => a[0] - b[0] || a[1] - b[1];
const segmentKey = (a, b) => comparePoint(a, b) < 0 ? `${pointKey(a)};${pointKey(b)}` : `${pointKey(b)};${pointKey(a)}`;
const idFor = cell => cell.id?.startsWith('territory:catalog:') ? cell.id : globalCellId(cell);
const familyFor = cell => cell.properties.fineSourceIdentity ? canonical([cell.properties.countryId, cell.properties.fineSourceIdentity]) : null;
const eachSegment = (geometry, fn) => {for (const p of polygons(geometry)) for (const ring of p) for (let i = 1; i < ring.length; i++) fn(ring[i - 1], ring[i]);};
const seedsFor = record => record.seedParentIds ?? [record.previousParentId];
const basis = 'game-boundary-reconciliation';
const geometryBasis = 'gameplay-national-boundary-reconciled';
const maximumStripWidthKm = 5, maximumRayKm = 10;
const cleanupPolicy = Object.freeze({maximumEnclosedResidualAreaKm2: 3, maximumBoundaryDistanceKm: 5, maximumBoundaryVertexDistanceKm: 5,
  maximumLongThinResidualAreaKm2: 250, maximumLongThinResidualWidthKm: 2,
  requireSameCountryFineFamily: true, requireEntireEnclosedPerimeterContact: true, preserveAllOriginalFineTerritory: true,
  originalTerminalHeadingRequired: true, maximumRayKm: 10, wholeSourcePairCorridorCertified: true,
  distanceBasis: 'Minimum polygon-to-existing-national/coast-line distance in local kilometers; longitude scaled by cosine of candidate latitude.',
  landBasis: 'Only an existing source-free residual cell of the verified P0 land partition can be absorbed. A water hole has no such cell and remains unchanged.'});
const lengthKm = coordinates => coordinates.slice(1).reduce((sum, p, i) => {
  const a = coordinates[i], r = Math.PI / 180, h = Math.sin((p[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(p[1] * r) * Math.sin((p[0] - a[0]) * r / 2) ** 2;
  return sum + 12742.0176 * Math.asin(Math.sqrt(Math.min(1, h)));
}, 0);

function stripMetrics(geometry) {
  const metadata = geometryMetadata(geometry), lat = (metadata.bbox[1] + metadata.bbox[3]) / 2;
  let perimeterKm = 0; eachSegment(geometry, (a, b) => {perimeterKm += lengthKm([a, b]);});
  const approximateAreaKm2 = metadata.area * 111.195 ** 2 * Math.cos(lat * Math.PI / 180);
  return {approximateAreaKm2, perimeterKm, effectiveStripWidthKm: perimeterKm ? 2 * approximateAreaKm2 / perimeterKm : Infinity};
}

function boundaryDistancesKm(cell, lines, reader) {
  const latitude = geometryMetadata(cell.geometry).centroid[1], xScale = 111.195 * Math.cos(latitude * Math.PI / 180);
  const project = p => [p[0] * xScale, p[1] * 111.195];
  const g = reader.read({type: 'MultiPolygon', coordinates: polygons(cell.geometry).map(p => p.map(ring => ring.map(project)))});
  const coordinates = [...(lines?.country ?? []), ...(lines?.coast ?? [])];
  const outline = coordinates.length ? reader.read({type: 'MultiLineString', coordinates: coordinates.map(line => line.map(project))}) : null;
  const distance = coordinates => coordinates.length ? DistanceOp.distance(g, reader.read({type: 'MultiLineString', coordinates: coordinates.map(line => line.map(project))})) : null;
  const nationalBoundaryDistanceKm = distance(lines?.country ?? []), coastBoundaryDistanceKm = distance(lines?.coast ?? []);
  const distances = [nationalBoundaryDistanceKm, coastBoundaryDistanceKm].filter(v => v !== null);
  let maximumBoundaryVertexDistanceKm = null;
  if (outline) {maximumBoundaryVertexDistanceKm = 0; eachSegment(cell.geometry, p => {maximumBoundaryVertexDistanceKm = Math.max(maximumBoundaryVertexDistanceKm, DistanceOp.distance(reader.read({type: 'Point', coordinates: project(p)}), outline));});}
  return {nationalBoundaryDistanceKm, coastBoundaryDistanceKm, minimumBoundaryDistanceKm: distances.length ? Math.min(...distances) : null, maximumBoundaryVertexDistanceKm};
}

function seamCoverage(bundle, localMap) {
  const records = new Map(bundle.records.map(r => [r.id, r]));
  let totalKm = 0, fineBothSidesKm = 0;
  for (const e of bundle.edges) if ([records.get(e.leftTerritoryId)?.countryId, records.get(e.rightTerritoryId)?.countryId].sort().join('|') === 'KOR|PRK') {
    const km = lengthKm(e.geometry.coordinates); totalKm += km;
    if (localMap.get(e.leftTerritoryId)?.properties.fineSourceIdentity && localMap.get(e.rightTerritoryId)?.properties.fineSourceIdentity) fineBothSidesKm += km;
  }
  return {totalKm, fineBothSidesKm, fineBothSidesFraction: totalKm ? fineBothSidesKm / totalKm : null};
}

function unionExact(members) {
  const segments = new Map(), seen = new Map();
  for (const member of members) eachSegment(normalizeGeometry(member.cell.geometry), (a, b) => {
    const key = segmentKey(a, b), direction = comparePoint(a, b) < 0 ? 1 : -1, prior = seen.get(key);
    if (!prior) {seen.set(key, {direction, count: 1}); segments.set(key, [a, b]);}
    else {
      if (prior.count !== 1 || prior.direction === direction) throw Error('NATIONAL_RECONCILIATION_NON_PARTITION_SEGMENT');
      prior.count++; segments.delete(key);
    }
  });
  return ringsFromSegments([...segments.values()]);
}

function chainEdges(segments, recordMap, localMap) {
  const groups = new Map();
  for (const segment of segments) {
    let {a, b, left, right} = segment;
    if (!left) {[a, b] = [b, a]; [left, right] = [right, left];}
    const l = recordMap.get(left), r = recordMap.get(right);
    if (!l || (right && !r) || left === right) throw Error('NATIONAL_RECONCILIATION_INVALID_EDGE_OWNER');
    const boundaryClass = !r ? 'coast' : l.countryId !== r.countryId ? 'country' :
      !localMap.get(left)?.properties.fineSourceIdentity || !localMap.get(right)?.properties.fineSourceIdentity ? 'residual' :
        l.administrativeParentKey === r.administrativeParentKey ? 'operational' : 'administrative';
    const key = canonical([[left, right].sort(compareText), boundaryClass]);
    const group = groups.get(key) ?? {boundaryClass, segments: []}; group.segments.push({a, b, left, right}); groups.set(key, group);
  }
  const edges = [];
  for (const group of groups.values()) {
    group.segments.sort((a, b) => comparePoint(a.a, b.a) || comparePoint(a.b, b.b));
    const incident = new Map(), seen = new Set();
    group.segments.forEach((e, i) => {for (const p of [e.a, e.b]) {const key = pointKey(p), list = incident.get(key) ?? []; list.push(i); incident.set(key, list);}});
    const walk = (start, index) => {
      const coordinates = [start]; let current = start, owners;
      while (!seen.has(index)) {
        seen.add(index); const e = group.segments[index], forward = comparePoint(current, e.a) === 0;
        const next = forward ? e.b : e.a, sides = forward ? [e.left, e.right] : [e.right, e.left];
        if (!owners) owners = sides;
        else if (owners[0] !== sides[0] || owners[1] !== sides[1]) throw Error('NATIONAL_RECONCILIATION_CHAIN_SIDE');
        coordinates.push(next); current = next;
        const list = incident.get(pointKey(next)); if (list.length !== 2) break;
        const nextIndex = list.find(i => !seen.has(i)); if (nextIndex === undefined) break; index = nextIndex;
      }
      if (!owners[0]) {owners.reverse(); coordinates.reverse();}
      const identity = {leftTerritoryId: owners[0], rightTerritoryId: owners[1], boundaryClass: group.boundaryClass, geometry: {type: 'LineString', coordinates}};
      edges.push({id: `edge:operational:${hashCanonical('prompt19-national-reconciled-edge.v1', identity)}`, ...identity});
    };
    for (const [key, list] of incident) if (list.length !== 2) for (const i of list) if (!seen.has(i)) walk(key.split(',').map(Number), i);
    for (let i = 0; i < group.segments.length; i++) if (!seen.has(i)) walk(group.segments[i].a, i);
  }
  return edges.sort((a, b) => compareText(a.id, b.id));
}

function witnessedTerminals(bundle, cells) {
  const locals = new Map(cells.map(c => [idFor(c), c])), pairs = new Map();
  for (const edge of bundle.edges) {
    const left = locals.get(edge.leftTerritoryId), right = locals.get(edge.rightTerritoryId);
    const lf = left && familyFor(left), rf = right && familyFor(right);
    if (!lf || !rf || lf === rf || left.properties.countryId !== right.properties.countryId) continue;
    const key = canonical([lf, rf].sort(compareText)), list = pairs.get(key) ?? [];
    const c = edge.geometry.coordinates;
    for (let i = 1; i < c.length; i++) list.push({a: c[i - 1], b: c[i], left: lf, right: rf, originalEdgeId: edge.id, countryId: left.properties.countryId});
    pairs.set(key, list);
  }
  const terminals = [];
  for (const list of pairs.values()) {
    const degree = new Map(); for (const e of list) for (const p of [e.a, e.b]) degree.set(pointKey(p), (degree.get(pointKey(p)) ?? 0) + 1);
    for (const e of list) {
      if (degree.get(pointKey(e.a)) === 1) terminals.push({...e, terminal: e.a, other: e.b, left: e.right, right: e.left});
      if (degree.get(pointKey(e.b)) === 1) terminals.push({...e, terminal: e.b, other: e.a});
    }
  }
  return terminals;
}

function rayExit(witness, geometry, g, locator) {
  const {terminal, other} = witness, vector = [terminal[0] - other[0], terminal[1] - other[1]];
  let hit = null;
  eachSegment(geometry, (a, b) => {
    const d = [a[0] - terminal[0], a[1] - terminal[1]], segment = [b[0] - a[0], b[1] - a[1]], den = vector[0] * segment[1] - vector[1] * segment[0];
    if (!den) return;
    const t = (d[0] * segment[1] - d[1] * segment[0]) / den, u = (d[0] * vector[1] - d[1] * vector[0]) / den;
    if (t <= 1e-9 || u < 0 || u > 1 || (hit && t >= hit.t)) return;
    const end = u === 0 ? a : u === 1 ? b : [a[0] + u * segment[0], a[1] + u * segment[1]];
    const midpoint = new Coordinate((terminal[0] + end[0]) / 2, (terminal[1] + end[1]) / 2);
    if (locator.locate(midpoint, g) !== 0 || lengthKm([terminal, end]) > maximumRayKm) return;
    hit = {t, end};
  });
  if (!hit) return null;
  const distance = Math.hypot(hit.end[0] - terminal[0], hit.end[1] - terminal[1]);
  // A tiny exterior dangle makes robust line noding register the boundary hit;
  // only polygonized faces inside the original residual can be assigned.
  const guard = 1e-10, nodingEnd = hit.end.map((v, i) => v + (v - terminal[i]) / distance * guard);
  return {...witness, coordinates: [terminal, nodingEnd], exactResidualExit: hit.end, lengthKm: lengthKm([terminal, hit.end]), numericalIntersectionGuardDegrees: guard};
}

// In cleanup mode a coastal residual can wrap around a small protrusion of an
// already established source pair. Candidate exits keep the exact original
// heading; a separate whole-path certificate must approve every interval.
function rayExitCandidates(witness, geometry, g, locator) {
  const {terminal, other} = witness, vector = [terminal[0] - other[0], terminal[1] - other[1]], cuts = [];
  eachSegment(geometry, (a, b) => {
    const d = [a[0] - terminal[0], a[1] - terminal[1]], segment = [b[0] - a[0], b[1] - a[1]], den = vector[0] * segment[1] - vector[1] * segment[0]; if (!den) return;
    const t = (d[0] * segment[1] - d[1] * segment[0]) / den, u = (d[0] * vector[1] - d[1] * vector[0]) / den;
    if (t <= 1e-9 || u < 0 || u > 1) return;
    const end = u === 0 ? a : u === 1 ? b : [a[0] + u * segment[0], a[1] + u * segment[1]];
    cuts.push({t, end});
  });
  const ordered = [...new Map(cuts.sort((a, b) => a.t - b.t).map(hit => [pointKey(hit.end), hit])).values()], result = [];
  for (let i = 0; i < ordered.length; i++) {
    const hit = ordered[i], previousT = i ? ordered[i - 1].t : 0, midpointT = (hit.t + previousT) / 2;
    if (locator.locate(new Coordinate(terminal[0] + midpointT * vector[0], terminal[1] + midpointT * vector[1]), g) !== 0 || lengthKm([terminal, hit.end]) > maximumRayKm) continue;
    const distance = Math.hypot(hit.end[0] - terminal[0], hit.end[1] - terminal[1]), guard = 1e-10;
    result.push({...witness, coordinates: [terminal, hit.end.map((v, j) => v + (v - terminal[j]) / distance * guard)], exactResidualExit: hit.end,
      lengthKm: lengthKm([terminal, hit.end]), numericalIntersectionGuardDegrees: guard});
  }
  return result.sort((a, b) => b.lengthKm - a.lengthKm);
}

function certifySourcePairCorridor(ray, residualId, cells, geometries, locator, recordSegments = false) {
  const a = ray.terminal, b = ray.exactResidualExit, vector = [b[0] - a[0], b[1] - a[1]], cuts = [0, 1];
  const relevant = cells.map((cell, i) => ({cell, g: geometries[i]})).filter(({g}) => {
    const e = g.getEnvelopeInternal(); return e.getMaxX() >= Math.min(a[0], b[0]) && e.getMinX() <= Math.max(a[0], b[0]) && e.getMaxY() >= Math.min(a[1], b[1]) && e.getMinY() <= Math.max(a[1], b[1]);
  });
  for (const {cell} of relevant) eachSegment(cell.geometry, (p, q) => {
    const segment = [q[0] - p[0], q[1] - p[1]], d = [p[0] - a[0], p[1] - a[1]], den = vector[0] * segment[1] - vector[1] * segment[0]; if (!den) return;
    const t = (d[0] * segment[1] - d[1] * segment[0]) / den, u = (d[0] * vector[1] - d[1] * vector[0]) / den;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) cuts.push(t);
  });
  const ordered = [...new Set(cuts)].sort((x, y) => x - y), traversed = new Set(), certifiedSegments = []; let firstResidualT = null;
  for (let i = 1; i < ordered.length; i++) {
    const coordinateSpan = (ordered[i] - ordered[i - 1]) * Math.hypot(...vector);
    if (recordSegments ? coordinateSpan <= 1e-12 : ordered[i] - ordered[i - 1] < 1e-12) {
      if (recordSegments) certifiedSegments.push({fromFraction: ordered[i - 1], toFraction: ordered[i], numericalBoundaryInterval: true, coordinateSpanDegrees: coordinateSpan, maximumNumericalCoordinateSpanDegrees: 1e-12});
      continue;
    }
    const t = (ordered[i] + ordered[i - 1]) / 2, point = new Coordinate(a[0] + t * vector[0], a[1] + t * vector[1]);
    const hits = relevant.filter(({g}) => locator.locate(point, g) !== 2);
    if (!hits.length) return null;
    for (const {cell} of hits) {
      const id = idFor(cell); traversed.add(id);
      if (id === residualId) {firstResidualT ??= ordered[i - 1]; continue;}
      if (cell.properties.countryId !== ray.countryId || ![ray.left, ray.right].includes(familyFor(cell))) return null;
    }
    if (recordSegments) certifiedSegments.push({fromFraction: ordered[i - 1], toFraction: ordered[i],
      from: [a[0] + ordered[i - 1] * vector[0], a[1] + ordered[i - 1] * vector[1]], to: [a[0] + ordered[i] * vector[0], a[1] + ordered[i] * vector[1]],
      coveringCellIds: hits.map(({cell}) => idFor(cell)).sort(compareText), fineFamilies: [...new Set(hits.map(({cell}) => familyFor(cell)).filter(Boolean))].sort(compareText),
      targetResidual: hits.some(({cell}) => idFor(cell) === residualId)});
  }
  if (firstResidualT === null) return null;
  return {kind: 'same-country-source-pair-corridor', traversedCellIds: [...traversed].sort(compareText),
    ...(recordSegments ? {certifiedSegments, wholePathSegmentCertificate: true} : {}),
    terminalToResidualEntryKm: lengthKm([a, [a[0] + firstResidualT * vector[0], a[1] + firstResidualT * vector[1]]]),
    policy: 'The original shared-fine terminal heading reaches this residual through the same two established fine families only; no sea, other country, or other unassigned residual is crossed.'};
}

function splitWitnessedResiduals({bundle, cells, witnessBundle, witnessCells, onProgress, cleanupBoundarySlivers = false}) {
  const reader = new GeoJSONReader(), writer = new GeoJSONWriter(), locator = new PointLocator();
  const locals = new Map(cells.map((cell, i) => [idFor(cell), {cell, i}])), records = new Map(bundle.records.map(r => [r.id, r]));
  const representatives = new Map(cells.filter(c => familyFor(c)).map(c => [familyFor(c), c]));
  const corridorGeometries = cells.map(c => reader.read(c.geometry));
  const terminals = witnessedTerminals(witnessBundle, witnessCells), boundary = new Set(), contactFamilies = new Map();
  const external = bundle.edges.filter(e => (e.boundaryClass === 'coast' || e.boundaryClass === 'country') && (locals.has(e.leftTerritoryId) || locals.has(e.rightTerritoryId)));
  for (const e of bundle.edges) {
    if (e.boundaryClass === 'coast' || e.boundaryClass === 'country') for (const id of [e.leftTerritoryId, e.rightTerritoryId]) if (locals.has(id)) boundary.add(id);
    if (!e.rightTerritoryId || records.get(e.leftTerritoryId).countryId !== records.get(e.rightTerritoryId).countryId) continue;
    for (const [id, other] of [[e.leftTerritoryId, e.rightTerritoryId], [e.rightTerritoryId, e.leftTerritoryId]]) {
      const family = locals.has(other) && familyFor(locals.get(other).cell); if (!family) continue;
      const set = contactFamilies.get(id) ?? new Set(); set.add(family); contactFamilies.set(id, set);
    }
  }
  const attempts = [], rays = [], raysByCell = new Map();
  for (const cell of [...cells].sort((a, b) => compareText(a.id, b.id))) {
    const id = idFor(cell), families = contactFamilies.get(id) ?? new Set();
    if (familyFor(cell) || !boundary.has(id) || families.size < 2) continue;
    const strip = stripMetrics(cell.geometry);
    const longThinException = cleanupBoundarySlivers && strip.approximateAreaKm2 <= cleanupPolicy.maximumLongThinResidualAreaKm2 && strip.effectiveStripWidthKm <= cleanupPolicy.maximumLongThinResidualWidthKm;
    if (strip.effectiveStripWidthKm > maximumStripWidthKm || (strip.approximateAreaKm2 > 100 && !longThinException)) continue;
    const g = reader.read(cell.geometry), vertices = []; eachSegment(cell.geometry, a => vertices.push(a));
    const candidates = terminals.filter(w => w.countryId === cell.properties.countryId && families.has(w.left) && families.has(w.right))
      .map(w => {
        if (cleanupBoundarySlivers) {
          const exits = rayExitCandidates(w, cell.geometry, g, locator);
          for (const ray of exits) {
            const corridorWitness = certifySourcePairCorridor(ray, id, cells, corridorGeometries, locator, true);
            if (!corridorWitness) continue;
            return {...ray, terminalAtResidualVertex: vertices.some(p => Math.hypot(p[0] - ray.terminal[0], p[1] - ray.terminal[1]) <= 1e-12),
              corridorWitness, earlierResidualExitKm: Math.min(...exits.map(e => e.lengthKm))};
          }
          return null;
        }
        return rayExit(w, cell.geometry, g, locator);
      }).filter(Boolean).map(ray => {
        if (cleanupBoundarySlivers) return ray;
        const terminalAtResidualVertex = vertices.some(p => Math.hypot(p[0] - ray.terminal[0], p[1] - ray.terminal[1]) <= 1e-12);
        if (terminalAtResidualVertex) return {...ray, terminalAtResidualVertex, corridorWitness: null};
        const corridorWitness = certifySourcePairCorridor(ray, id, cells, corridorGeometries, locator);
        return corridorWitness ? {...ray, terminalAtResidualVertex, corridorWitness} : null;
      }).filter(Boolean);
    const unique = [...new Map(candidates.map(r => [canonical([r.coordinates, r.left, r.right]), {...r, residualId: id}])).values()].sort((a, b) => compareText(canonical(a), canonical(b)));
    if (!unique.length) {attempts.push({originalResidualId: id, outcome: 'no-witnessed-terminal-enters-residual'}); continue;}
    raysByCell.set(id, unique); rays.push(...unique);
  }
  if (!rays.length) return {bundle, cells, changes: [], attempts, lineage: Object.fromEntries(bundle.records.map(r => [r.id, [r.id]]))};
  onProgress(`one common national arrangement with ${cells.length} cells and ${rays.length} original-source terminal witnesses`);
  const numerical = commonNodeRings({type: 'FeatureCollection', features: []}, {type: 'FeatureCollection', features: cells}, onProgress,
    [...external.map((e, i) => ({coordinates: e.geometry.coordinates, sourceFeatureId: String(i)})), ...rays.map((r, i) => ({...r, sourceFeatureId: String(i + external.length)}))]);
  const common = {segments: new Map([...numerical.edges].map(([key, e]) => [key, {...e,
    left: [...new Set(e.contexts.filter(c => c.role === 'P1' && c.direction === 1).map(c => c.featureIndex))],
    right: [...new Set(e.contexts.filter(c => c.role === 'P1' && c.direction === -1).map(c => c.featureIndex))],
    extensions: [...new Set(e.contexts.filter(c => c.role === 'P1-extension').map(c => Number(c.sourceFeatureId)))]}]))};
  const geometries = numerical.selected.features.map(c => reader.read(c.geometry)), index = new STRtree();
  geometries.forEach((g, i) => index.insert(g.getEnvelopeInternal(), i));
  const polygonizer = new Polygonizer();
  for (const e of common.segments.values()) polygonizer.add(reader.read({type: 'LineString', coordinates: [e.a, e.b]}));
  const facesByCell = new Map();
  for (const it = polygonizer.getPolygons().iterator(); it.hasNext();) {
    const polygon = it.next(), point = InteriorPointArea.getInteriorPoint(polygon), hits = [];
    for (const candidates = index.query(new Envelope(point)).iterator(); candidates.hasNext();) {const i = candidates.next(); if (locator.locate(point, geometries[i]) === 0) hits.push(i);}
    if (!hits.length) continue;
    if (hits.length !== 1) throw Error('NATIONAL_RECONCILIATION_COMMON_FACE_MEMBERSHIP');
    const i = hits[0], cell = cells[i], id = idFor(cell); if (!raysByCell.has(id)) continue;
    const geometry = normalizeGeometry(writer.write(polygon)), direct = new Set(), witnessFamilies = new Set();
    eachSegment(geometry, (a, b) => {
      const e = common.segments.get(segmentKey(a, b)); if (!e) throw Error('NATIONAL_RECONCILIATION_FACE_EDGE_NOT_NODED');
      for (const n of [...e.left, ...e.right]) if (n !== i && cells[n].properties.countryId === cell.properties.countryId && familyFor(cells[n])) direct.add(familyFor(cells[n]));
    });
    for (const ray of raysByCell.get(id)) {
      if (direct.size && (!direct.has(ray.left) || !direct.has(ray.right))) continue;
      const [a, b] = ray.coordinates, cross = (b[0] - a[0]) * (point.y - a[1]) - (b[1] - a[1]) * (point.x - a[0]);
      if (cross) witnessFamilies.add(cross > 0 ? ray.left : ray.right);
    }
    const family = direct.size === 1 ? [...direct][0] : witnessFamilies.size === 1 && (!direct.size || direct.has([...witnessFamilies][0])) ? [...witnessFamilies][0] : null;
    if (!(new IsValidOp(polygon)).isValid()) throw Error('NATIONAL_RECONCILIATION_INVALID_COMMON_FACE');
    const list = facesByCell.get(id) ?? []; list.push({geometry, family, direct: [...direct].sort(compareText), witnessFamilies: [...witnessFamilies].sort(compareText)}); facesByCell.set(id, list);
  }
  const replacements = new Map(), changes = [], originalDirected = cells.map(() => []);
  for (const e of common.segments.values()) {for (const i of e.left) originalDirected[i].push([e.a, e.b]); for (const i of e.right) originalDirected[i].push([e.b, e.a]);}
  for (const [id, faceList] of facesByCell) {
    const original = locals.get(id).cell, area = geometryMetadata(original.geometry).area, strip = stripMetrics(original.geometry);
    const total = faceList.reduce((sum, f) => sum + geometryMetadata(f.geometry).area, 0);
    if (Math.abs(total - area) > Math.max(1e-10, area * 1e-8)) throw Error('NATIONAL_RECONCILIATION_COMMON_SPLIT_AREA');
    if (faceList.length < 2 || !faceList.some(f => f.family)) {attempts.push({originalResidualId: id, outcome: 'ambiguous-split-retained', rays: raysByCell.get(id).length, faces: faceList.length}); continue;}
    replacements.set(id, faceList.map(face => {
      const representative = face.family ? representatives.get(face.family) : original, p = representative.properties;
      if (p.countryId !== original.properties.countryId) throw Error('NATIONAL_RECONCILIATION_SPLIT_COUNTRY_CROSSING');
      const localId = `${p.countryId}:cell:${hashCanonical('prompt19-national-reconciled-split-cell.v1', {originalResidualId: id, fineSourceIdentity: p.fineSourceIdentity, geometry: face.geometry})}`;
      const adjustment = {basis, geometryAdjusted: true, originalResidualIds: [id], originalFineCellIds: [], rawSourceArtifactGeometryUnmodified: true, administrativeTruthClaim: false,
        method: 'witnessed-shared-source-terminal-continuation', assignedResidualArea: geometryMetadata(face.geometry).area};
      if (face.family) changes.push({kind: 'witnessed-residual-part-assignment', basis, geometryAdjusted: true, countryId: p.countryId, originalResidualIds: [id], originalResidualArea: area,
        originalResidualGeometryHash: hashCanonical('prompt19-national-original-residual.v1', original.geometry), fineSourceIdentity: {...p.fineSourceIdentity}, assignedPartArea: adjustment.assignedResidualArea,
        assignedPartGeometry: face.geometry, witness: adjustment.method, directFineFamilyContacts: face.direct, sourcePairSideWitnesses: face.witnessFamilies, ...strip,
        ...(cleanupBoundarySlivers && strip.approximateAreaKm2 > 100 ? {cleanupBoundarySlivers: true, longThinResidualException: true,
          guard: {maximumOriginalResidualAreaKm2: cleanupPolicy.maximumLongThinResidualAreaKm2, maximumEffectiveStripWidthKm: cleanupPolicy.maximumLongThinResidualWidthKm,
            maximumRayKm, originalSharedFineTerminalWitnessRequired: true}} : {}),
        terminalWitnesses: raysByCell.get(id).map(({a, b, coordinates, exactResidualExit, lengthKm, numericalIntersectionGuardDegrees, originalEdgeId, left, right, terminalAtResidualVertex, corridorWitness, earlierResidualExitKm}) => ({originalSharedFineSegment: [a, b], originalEdgeId, coordinates, exactResidualExit, lengthKm, numericalIntersectionGuardDegrees, leftFineFamily: left, rightFineFamily: right, terminalAtResidualVertex, corridorWitness,
          ...(cleanupBoundarySlivers ? {earlierResidualExitKm} : {})}))});
      return {type: 'Feature', id: localId, properties: {...p, localId, seedParentIds: seedsFor(records.get(id)), mergedCellIds: [id], coarseParentTerritoryId: null,
        geometryBasis, geometryAdjusted: true, boundaryBasis: basis, boundaryAdjustment: adjustment, decisions: [...new Set([...(p.decisions ?? []), basis])]}, geometry: face.geometry};
    }));
    attempts.push({originalResidualId: id, outcome: 'witnessed-split', rays: raysByCell.get(id).length, faces: faceList.length, assignedFaces: faceList.filter(f => f.family).length});
  }
  if (!replacements.size) return {bundle, cells, changes: [], attempts, lineage: Object.fromEntries(bundle.records.map(r => [r.id, [r.id]]))};
  const nextCells = [], nextRecords = [], lineage = Object.fromEntries(bundle.records.filter(r => !selected(r.countryId)).map(r => [r.id, [r.id]]));
  for (const [i, old] of cells.entries()) {
    const id = idFor(old), originalRecord = records.get(id); let pieces = replacements.get(id);
    if (!pieces) {
      const geometry = ringsFromSegments(originalDirected[i]);
      if (canonical(geometry) === canonical(old.geometry)) pieces = [old];
      else {const localId = `${old.properties.countryId}:cell:${hashCanonical('prompt19-national-reconciled-node-cell.v1', {priorCellId: old.id, geometry})}`; pieces = [{...old, id: localId, properties: {...old.properties, localId}, geometry}];}
    }
    lineage[id] = pieces.map(idFor);
    for (const cell of pieces) {
      const representative = familyFor(cell) ? records.get(idFor(representatives.get(familyFor(cell)))) : originalRecord;
      nextCells.push(cell); nextRecords.push({...representative, id: idFor(cell), previousParentId: originalRecord.previousParentId, seedParentIds: seedsFor(originalRecord)});
    }
  }
  const segmentOwners = new Map();
  for (const cell of nextCells) eachSegment(cell.geometry, (a, b) => {
    const key = segmentKey(a, b), e = segmentOwners.get(key) ?? {a: comparePoint(a, b) < 0 ? a : b, b: comparePoint(a, b) < 0 ? b : a, left: [], right: []};
    (comparePoint(a, b) < 0 ? e.left : e.right).push(idFor(cell)); segmentOwners.set(key, e);
  });
  const rawEdges = [];
  for (const [key, e] of segmentOwners) {
    if (e.left.length > 1 || e.right.length > 1) throw Error(`NATIONAL_RECONCILIATION_COMMON_AMBIGUOUS_SIDE:${canonical(e)}`);
    let left = e.left[0] ?? null, right = e.right[0] ?? null;
    if (!left || !right) {
      const proofs = (common.segments.get(key)?.extensions ?? []).filter(i => i < external.length).map(i => external[i]);
      if (proofs.length !== 1) throw Error(`NATIONAL_RECONCILIATION_COMMON_UNPAIRED_EDGE:${key}`);
      const outside = [proofs[0].leftTerritoryId, proofs[0].rightTerritoryId].find(id => id && !selected(records.get(id)?.countryId)) ?? null;
      if (!left) left = outside; else right = outside;
      if (proofs[0].boundaryClass === 'country' && !outside) throw Error('NATIONAL_RECONCILIATION_COMMON_MISSING_COUNTRY_SIDE');
    }
    rawEdges.push({a: e.a, b: e.b, left, right});
  }
  const allRecords = [...bundle.records.filter(r => !selected(r.countryId)), ...nextRecords], recordMap = new Map(allRecords.map(r => [r.id, r]));
  const edges = [...bundle.edges.filter(e => !selected(records.get(e.leftTerritoryId)?.countryId) && !selected(records.get(e.rightTerritoryId)?.countryId)),
    ...chainEdges(rawEdges, recordMap, new Map(nextCells.map(c => [idFor(c), c])))];
  return {bundle: {...bundle, records: allRecords, features: [...bundle.features.filter(f => !selected(records.get(f.id).countryId)), ...nextCells.map(c => ({...c, id: idFor(c)}))], edges},
    cells: nextCells, changes, attempts, lineage, numericalRepresentation: numerical.evidence};
}

/**
 * Reassign source-free country-edge faces only with explicit geometric witnesses.
 * Original source identifiers identify a gameplay family, not administrative truth
 * of an adjusted outline. No distance, area majority, or cross-country allocation.
 */
function reconcileUniqueContacts({bundle, cells, onProgress = () => {}, cleanupBoundarySlivers = false}) {
  if (!Array.isArray(bundle?.features) || !Array.isArray(bundle.records) || !Array.isArray(bundle.edges) || !Array.isArray(cells) ||
      !Array.isArray(bundle.parents?.administrative) || !Array.isArray(bundle.parents.previous)) throw Error('NATIONAL_RECONCILIATION_INVALID_INPUT');
  if (bundle.report?.invalid?.length || bundle.report?.unresolved?.length || bundle.report?.topology?.pass === false) throw Error('NATIONAL_RECONCILIATION_UNVERIFIED_INPUT');
  const reader = new GeoJSONReader(), locator = new PointLocator();
  const records = new Map(bundle.records.map(r => [r.id, r])), features = new Map(bundle.features.map(f => [f.id, f]));
  const localMap = new Map(), families = new Map();
  if (records.size !== bundle.records.length || features.size !== bundle.features.length || records.size !== features.size) throw Error('NATIONAL_RECONCILIATION_DUPLICATE_ID');
  for (const cell of cells) {
    const id = idFor(cell), record = records.get(id), p = cell.properties;
    if (!selected(p?.countryId) || !record || record.countryId !== p.countryId || localMap.has(id) || canonical(cell.geometry) !== canonical(features.get(id)?.geometry)) throw Error('NATIONAL_RECONCILIATION_CELL_SCOPE');
    const family = familyFor(cell);
    if (family && (p.unresolvedFineSourceAssignment !== false || !p.fineSourceIdentity.sourceId || !p.fineSourceIdentity.sourceFeatureId || p.sourceId !== p.fineSourceIdentity.sourceId || p.sourceFeatureId !== p.fineSourceIdentity.sourceFeatureId)) throw Error('NATIONAL_RECONCILIATION_FINE_IDENTITY');
    if (!family && (p.fineSourceIdentity !== null || p.unresolvedFineSourceAssignment !== true)) throw Error('NATIONAL_RECONCILIATION_RESIDUAL_IDENTITY');
    const member = {oldId: id, cell, record, family}; localMap.set(id, member);
    if (family) {const group = families.get(family) ?? []; group.push(member); families.set(family, group);}
  }
  if (bundle.records.filter(r => selected(r.countryId)).some(r => !localMap.has(r.id))) throw Error('NATIONAL_RECONCILIATION_INCOMPLETE_CELLS');
  const boundaryCells = new Set(), contacts = new Map(), contactLengths = new Map(), boundaryLines = new Map();
  for (const edge of bundle.edges) {
    if (!records.has(edge.leftTerritoryId) || (edge.rightTerritoryId !== null && !records.has(edge.rightTerritoryId))) throw Error('NATIONAL_RECONCILIATION_UNKNOWN_EDGE');
    if (!(lengthKm(edge.geometry.coordinates) > 0)) continue;
    if (edge.boundaryClass === 'coast' || edge.boundaryClass === 'country') {
      if (localMap.has(edge.leftTerritoryId)) boundaryCells.add(edge.leftTerritoryId);
      if (localMap.has(edge.rightTerritoryId)) boundaryCells.add(edge.rightTerritoryId);
      if (cleanupBoundarySlivers) for (const countryId of new Set([records.get(edge.leftTerritoryId)?.countryId, records.get(edge.rightTerritoryId)?.countryId].filter(selected))) {
        const lines = boundaryLines.get(countryId) ?? {coast: [], country: []}; lines[edge.boundaryClass].push(edge.geometry.coordinates); boundaryLines.set(countryId, lines);
      }
    }
    if (!edge.rightTerritoryId || records.get(edge.leftTerritoryId).countryId !== records.get(edge.rightTerritoryId).countryId) continue;
    for (const [id, other] of [[edge.leftTerritoryId, edge.rightTerritoryId], [edge.rightTerritoryId, edge.leftTerritoryId]]) {
      const fine = localMap.get(other); if (!fine?.family) continue;
      const map = contacts.get(id) ?? new Map(), witnesses = map.get(fine.family) ?? [];
      witnesses.push(edge.id); map.set(fine.family, witnesses); contacts.set(id, map);
      if (cleanupBoundarySlivers) {const lengths = contactLengths.get(id) ?? new Map(); lengths.set(fine.family, (lengths.get(fine.family) ?? 0) + lengthKm(edge.geometry.coordinates)); contactLengths.set(id, lengths);}
    }
  }
  onProgress('reconciling country-edge residuals with unique positive-length fine-family contact');
  const changes = [], retained = [], changedFamilies = new Set();
  for (const member of [...localMap.values()].sort((a, b) => compareText(a.oldId, b.oldId))) {
    if (member.family) continue;
    const {oldId, cell} = member, contact = contacts.get(oldId) ?? new Map();
    const strip = stripMetrics(cell.geometry);
    let enclosedCleanup = null;
    if (cleanupBoundarySlivers && !boundaryCells.has(oldId) && contact.size === 1 && strip.approximateAreaKm2 <= cleanupPolicy.maximumEnclosedResidualAreaKm2) {
      const family = [...contact.keys()][0], positiveFineContactPerimeterKm = contactLengths.get(oldId)?.get(family) ?? 0;
      const wholePerimeterContact = Math.abs(positiveFineContactPerimeterKm - strip.perimeterKm) <= Math.max(1e-6, strip.perimeterKm * 1e-9);
      const distances = boundaryDistancesKm(cell, boundaryLines.get(cell.properties.countryId), reader);
      enclosedCleanup = {sourceFreeP0LandCell: true, wholePerimeterContact, positiveFineContactPerimeterKm, ...distances,
        guard: {maximumAreaKm2: cleanupPolicy.maximumEnclosedResidualAreaKm2, maximumBoundaryDistanceKm: cleanupPolicy.maximumBoundaryDistanceKm, maximumBoundaryVertexDistanceKm: cleanupPolicy.maximumBoundaryVertexDistanceKm,
          sameCountryFineFamilies: 1, actualWaterHole: false},
        eligible: wholePerimeterContact && distances.minimumBoundaryDistanceKm !== null && distances.minimumBoundaryDistanceKm <= cleanupPolicy.maximumBoundaryDistanceKm &&
          distances.maximumBoundaryVertexDistanceKm !== null && distances.maximumBoundaryVertexDistanceKm <= cleanupPolicy.maximumBoundaryVertexDistanceKm};
    }
    if ((!boundaryCells.has(oldId) && !enclosedCleanup?.eligible) || contact.size !== 1 || strip.effectiveStripWidthKm > maximumStripWidthKm) {
      retained.push({originalResidualId: oldId, countryId: cell.properties.countryId, originalResidualArea: geometryMetadata(cell.geometry).area,
        reason: !boundaryCells.has(oldId) ? 'enclosed-inland-residual' : strip.effectiveStripWidthKm > maximumStripWidthKm ? 'bulk-missing-source-land' : contact.size ? 'multiple-fine-family-contacts' : 'no-fine-family-contact', fineFamilyContacts: contact.size, ...strip,
        ...(enclosedCleanup ? {cleanupEvaluation: enclosedCleanup} : {})});
      continue;
    }
    const family = [...contact.keys()][0], representative = families.get(family)[0];
    if (representative.cell.properties.countryId !== cell.properties.countryId) throw Error('NATIONAL_RECONCILIATION_COUNTRY_CROSSING');
    families.get(family).push(member); changedFamilies.add(family);
    if (enclosedCleanup?.eligible) member.enclosedCleanup = enclosedCleanup;
    changes.push({kind: enclosedCleanup?.eligible ? 'enclosed-residual-loop-absorption' : 'whole-residual-absorption', basis, geometryAdjusted: true, countryId: cell.properties.countryId,
      originalResidualIds: [oldId], originalResidualArea: geometryMetadata(cell.geometry).area,
      assignedPartArea: geometryMetadata(cell.geometry).area, assignedPartGeometry: cell.geometry,
      fineSourceIdentity: {...representative.cell.properties.fineSourceIdentity}, witness: enclosedCleanup?.eligible ? 'unique-entire-perimeter-fine-family-contact-near-national-or-coast-boundary' : 'unique-positive-length-fine-family-contact', contactEdgeIds: [...contact.values()][0].sort(compareText), ...strip,
      ...(enclosedCleanup?.eligible ? {cleanupBoundarySlivers: true, enclosedCleanup, sourceGeometryDeleted: false, originalResidualGeometryHash: hashCanonical('prompt19-national-original-residual.v1', cell.geometry)} : {})});
  }
  for (const [family, members] of families) if (members.some(m => m.cell.properties.boundaryAdjustment?.basis === basis)) changedFamilies.add(family);
  const oldCellToNewCell = Object.fromEntries(bundle.records.map(r => [r.id, r.id]));
  const nextLocals = [], nextFeatures = [], nextRecords = [], absorbedIds = new Set(changes.flatMap(c => c.originalResidualIds));
  for (const [family, members] of [...families].sort(([a], [b]) => compareText(a, b))) {
    if (!changedFamilies.has(family)) continue;
    const representative = members.find(m => m.family === family), p = representative.cell.properties;
    const union = unionExact(members), parts = polygons(union).map(coordinates => {
      const geometry = normalizeGeometry({type: 'Polygon', coordinates}), g = reader.read(geometry), valid = new IsValidOp(g);
      if (!valid.isValid()) throw Error(`NATIONAL_RECONCILIATION_INVALID_UNION:${valid.getValidationError()?.getMessage()}`);
      return {geometry, g, members: []};
    });
    for (const member of members) {
      const point = InteriorPointArea.getInteriorPoint(reader.read(member.cell.geometry)), hits = parts.filter(part => locator.locate(point, part.g) === 0);
      if (hits.length !== 1) throw Error('NATIONAL_RECONCILIATION_COMPONENT_MEMBERSHIP');
      hits[0].members.push(member);
    }
    for (const part of parts) {
      if (!part.members.length) throw Error('NATIONAL_RECONCILIATION_EMPTY_COMPONENT');
      const seedParentIds = [...new Set(part.members.flatMap(m => seedsFor(m.record)))].sort(compareText), mergedCellIds = part.members.map(m => m.oldId).sort(compareText);
      const adjustedResidualIds = [...new Set(part.members.flatMap(m => m.family ? m.cell.properties.boundaryAdjustment?.originalResidualIds ?? [] : [m.oldId]))].sort(compareText);
      const localId = `${p.countryId}:cell:${hashCanonical('prompt19-national-reconciled-local-cell.v1', {countryId: p.countryId, fineSourceIdentity: p.fineSourceIdentity, administrativeParentKey: p.administrativeParentKey, geometry: part.geometry})}`;
      const cell = {type: 'Feature', id: localId, properties: {...p, localId, seedParentIds, mergedCellIds, coarseParentTerritoryId: null,
        geometryAdjusted: adjustedResidualIds.length > 0 || p.geometryAdjusted === true, boundaryBasis: basis, geometryBasis,
        boundaryAdjustment: {basis, geometryAdjusted: true, originalResidualIds: adjustedResidualIds, originalFineCellIds: part.members.filter(m => m.family).map(m => m.oldId).sort(compareText), rawSourceArtifactGeometryUnmodified: true,
          administrativeTruthClaim: false, method: part.members.some(m => m.cell.properties.boundaryAdjustment?.method === 'witnessed-shared-source-terminal-continuation') ? 'witnessed-shared-source-terminal-continuation' : 'unique-positive-length-fine-family-contact',
          ...(part.members.some(m => m.enclosedCleanup || m.cell.properties.boundaryAdjustment?.enclosedCleanupResidualIds?.length) ? {cleanupBoundarySlivers: true,
            enclosedCleanupResidualIds: [...new Set(part.members.flatMap(m => m.enclosedCleanup ? [m.oldId] : m.cell.properties.boundaryAdjustment?.enclosedCleanupResidualIds ?? []))].sort(compareText)} : {})},
        decisions: [...new Set([...(p.decisions ?? []), basis])]}, geometry: part.geometry};
      const id = globalCellId(cell); nextLocals.push(cell); nextFeatures.push({...cell, id});
      nextRecords.push({...representative.record, id, previousParentId: seedParentIds[0], seedParentIds});
      for (const oldId of mergedCellIds) oldCellToNewCell[oldId] = id;
    }
  }
  for (const member of localMap.values()) if ((!member.family && !absorbedIds.has(member.oldId)) || (member.family && !changedFamilies.has(member.family))) {
    nextLocals.push(member.cell); nextFeatures.push(features.get(member.oldId)); nextRecords.push(member.record);
  }
  nextLocals.sort((a, b) => compareText(a.id, b.id)); nextFeatures.sort((a, b) => compareText(a.id, b.id)); nextRecords.sort((a, b) => compareText(a.id, b.id));
  const allRecords = [...bundle.records.filter(r => !selected(r.countryId)), ...nextRecords], allFeatures = [...bundle.features.filter(f => !selected(records.get(f.id).countryId)), ...nextFeatures];
  const nextRecordMap = new Map(allRecords.map(r => [r.id, r])), nextLocalMap = new Map(nextLocals.map(c => [idFor(c), c]));
  if (nextRecordMap.size !== allRecords.length) throw Error('NATIONAL_RECONCILIATION_DUPLICATE_OUTPUT_ID');
  let removedSeams = 0;
  const edges = [];
  for (const edge of bundle.edges) {
    const leftTerritoryId = oldCellToNewCell[edge.leftTerritoryId], rightTerritoryId = edge.rightTerritoryId === null ? null : oldCellToNewCell[edge.rightTerritoryId];
    if (leftTerritoryId === rightTerritoryId) {removedSeams++; continue;}
    const left = nextRecordMap.get(leftTerritoryId), right = nextRecordMap.get(rightTerritoryId);
    const boundaryClass = !right ? 'coast' : left.countryId !== right.countryId ? 'country' :
      !nextLocalMap.get(leftTerritoryId)?.properties.fineSourceIdentity || !nextLocalMap.get(rightTerritoryId)?.properties.fineSourceIdentity ?
        selected(left.countryId) ? 'residual' : edge.boundaryClass : left.administrativeParentKey === right.administrativeParentKey ? 'operational' : 'administrative';
    if (edge.leftTerritoryId === leftTerritoryId && edge.rightTerritoryId === rightTerritoryId && edge.boundaryClass === boundaryClass) {edges.push(edge); continue;}
    const identity = {leftTerritoryId, rightTerritoryId, boundaryClass, geometry: edge.geometry};
    edges.push({...edge, ...identity, id: `edge:operational:${hashCanonical('prompt19-national-reconciled-edge.v1', identity)}`});
  }
  const usedAdministrative = new Set(allRecords.map(r => r.administrativeParentKey)), administrative = bundle.parents.administrative.filter(p => usedAdministrative.has(p.parentKey));
  const seedGroups = new Map();
  for (const record of nextRecords) {const seeds = seedGroups.get(record.previousParentId) ?? new Set(); seedsFor(record).forEach(id => seeds.add(id)); seedGroups.set(record.previousParentId, seeds);}
  const priorParents = new Map(bundle.parents.previous.map(p => [p.oldTerritoryId, p]));
  const previous = [...bundle.parents.previous.filter(p => !selected(p.sourceCountryId)), ...[...seedGroups].sort(([a], [b]) => compareText(a, b)).map(([id, seeds]) => {
    const parent = priorParents.get(id); if (!parent) throw Error('NATIONAL_RECONCILIATION_UNKNOWN_SEED_PARENT');
    return {...parent, seedParentIds: [...seeds].sort(compareText)};
  })];
  const outputBundle = {...bundle, features: allFeatures, records: allRecords, edges, parents: {...bundle.parents, administrative, previous}};
  const evidence = {schemaVersion: 'prompt19-national-boundary-reconciliation-v1', basis, geometryAdjusted: true, rawSourceArtifactGeometryUnmodified: true,
    administrativeTruthClaim: false, countryEnvelopeGeometryChanged: false, nationalBoundaryGeometryChanged: false, otherCountryGeometryChanged: false,
    policy: 'Only country/coast-adjacent source-free residuals with one same-country positive-length fine-family contact are absorbed. Enclosed source holes and ambiguous/no-contact land remain unassigned.',
    changes, retained, absorbedResidualCells: changes.length, removedSeams, inputCells: cells.length, outputCells: nextLocals.length,
    sharedKoreaBorderBefore: seamCoverage(bundle, new Map([...localMap].map(([id, m]) => [id, m.cell]))),
    sharedKoreaBorderAfter: seamCoverage(outputBundle, new Map(nextLocals.map(c => [idFor(c), c])))};
  const summary = (bundle.report?.summary ?? []).map(before => {
    if (!selected(before.countryId)) return before;
    const own = nextLocals.filter(c => c.properties.countryId === before.countryId), residual = own.filter(c => !c.properties.fineSourceIdentity);
    return {...before, cells: own.length, fineCells: own.length - residual.length, coarseResidualCells: residual.length,
      arrangedFaceArea: own.reduce((sum, c) => sum + geometryMetadata(c.geometry).area, 0), coarseResidualArea: residual.reduce((sum, c) => sum + geometryMetadata(c.geometry).area, 0)};
  });
  outputBundle.report = {...bundle.report, cells: nextLocals.length, summary, nationalBoundaryReconciliation: evidence,
    topology: {...bundle.report?.topology, pass: true, edges: edges.filter(e => selected(nextRecordMap.get(e.leftTerritoryId).countryId) || selected(nextRecordMap.get(e.rightTerritoryId)?.countryId)).length, nationalBoundaryReconciliation: evidence}};
  return {bundle: outputBundle, cells: nextLocals, evidence, oldCellToNewCell,
    lineage: Object.fromEntries(Object.entries(oldCellToNewCell).map(([oldId, newId]) => [oldId, [newId]]))};
}

export function reconcileNationalBoundaries({bundle, cells, onProgress = () => {}, cleanupBoundarySlivers = false}) {
  if (typeof cleanupBoundarySlivers !== 'boolean') throw Error('NATIONAL_RECONCILIATION_INVALID_CLEANUP_OPTION');
  const originalCells = new Map(cells.map(c => [idFor(c), c]));
  const originalResiduals = new Map(cells.filter(c => !familyFor(c)).map(c => [idFor(c), c]));
  let current = reconcileUniqueContacts({bundle, cells, onProgress, cleanupBoundarySlivers});
  let lineage = Object.fromEntries(bundle.records.map(r => [r.id, [r.id]]));
  let origins = new Map(bundle.records.map(r => [r.id, originalResiduals.has(r.id) ? [r.id] : []]));
  const historicalOrigins = new Map(origins);
  const normalizeChanges = entries => entries.map(change => {
    const originalResidualIds = [...new Set(change.originalResidualIds.flatMap(id => originalResiduals.has(id) ? [id] : historicalOrigins.get(id) ?? []))].sort(compareText);
    if (!originalResidualIds.length) throw Error('NATIONAL_RECONCILIATION_MISSING_RESIDUAL_PROVENANCE');
    return {...change, inputResidualCellIds: change.originalResidualIds, inputResidualCellArea: change.originalResidualArea, originalResidualIds,
      originalResidualArea: originalResidualIds.reduce((sum, id) => sum + geometryMetadata(originalResiduals.get(id).geometry).area, 0)};
  });
  let changes = normalizeChanges(current.evidence.changes);
  const compose = next => {
    lineage = Object.fromEntries(Object.entries(lineage).map(([id, descendants]) => [id, [...new Set(descendants.flatMap(d => next[d] ?? [d]))].sort(compareText)]));
    const nextOrigins = new Map();
    for (const [id, originIds] of origins) for (const descendant of next[id] ?? [id]) {
      nextOrigins.set(descendant, [...new Set([...(nextOrigins.get(descendant) ?? []), ...originIds])].sort(compareText));
    }
    origins = nextOrigins;
    for (const [id, originIds] of origins) historicalOrigins.set(id, originIds);
  };
  compose(current.lineage);
  let uniqueContactPasses = 1;
  const splitAttempts = [], numericalPasses = [];
  // Only boundary-touching faces can enter this propagation. Each step requires
  // exactly one already established fine family, never a residual majority.
  for (let round = 0; round < cells.length; round++) {
    const split = splitWitnessedResiduals({bundle: current.bundle, cells: current.cells, witnessBundle: bundle, witnessCells: cells, onProgress, cleanupBoundarySlivers});
    splitAttempts.push(...split.attempts.map(a => ({...a, round})));
    if (split.numericalRepresentation) numericalPasses.push(split.numericalRepresentation);
    changes.push(...normalizeChanges(split.changes)); compose(split.lineage);
    current = {...current, bundle: split.bundle, cells: split.cells};
    let uniqueAdded = 0;
    for (let pass = 0; pass < cells.length; pass++) {
      const next = reconcileUniqueContacts({bundle: current.bundle, cells: current.cells, onProgress, cleanupBoundarySlivers});
      changes.push(...normalizeChanges(next.evidence.changes)); compose(next.lineage); uniqueContactPasses++; current = next;
      uniqueAdded += next.evidence.absorbedResidualCells;
      if (!next.evidence.absorbedResidualCells) break;
    }
    if (!split.changes.length && !uniqueAdded) break;
  }
  current.cells = current.cells.map(cell => {
    if (!cell.properties.boundaryAdjustment) return cell;
    const adjustment = cell.properties.boundaryAdjustment;
    const originalResidualIds = [...new Set(adjustment.originalResidualIds.flatMap(id => originalResiduals.has(id) ? [id] : historicalOrigins.get(id) ?? []))].sort(compareText);
    const originalFineCellIds = [...originalCells].filter(([id, old]) => familyFor(old) && familyFor(old) === familyFor(cell) && lineage[id]?.includes(idFor(cell))).map(([id]) => id).sort(compareText);
    return {...cell, properties: {...cell.properties, boundaryAdjustment: {...adjustment, originalResidualIds, originalFineCellIds,
      ...(adjustment.enclosedCleanupResidualIds ? {enclosedCleanupResidualIds: [...new Set(adjustment.enclosedCleanupResidualIds.flatMap(id => originalResiduals.has(id) ? [id] : historicalOrigins.get(id) ?? []))].sort(compareText)} : {}),
      rawSourceArtifactGeometryUnmodified: true}}};
  });
  const finalCells = new Map(current.cells.map(c => [idFor(c), c]));
  current.bundle.features = current.bundle.features.map(f => finalCells.has(f.id) ? {...f, properties: finalCells.get(f.id).properties} : f);
  const before = seamCoverage(bundle, originalCells), after = seamCoverage(current.bundle, new Map(current.cells.map(c => [idFor(c), c])));
  const recordMap = new Map(current.bundle.records.map(r => [r.id, r])), remainingDmz = new Map();
  for (const e of current.bundle.edges) {
    if ([recordMap.get(e.leftTerritoryId)?.countryId, recordMap.get(e.rightTerritoryId)?.countryId].sort().join('|') !== 'KOR|PRK') continue;
    for (const id of [e.leftTerritoryId, e.rightTerritoryId]) {
      const cell = finalCells.get(id); if (!cell || familyFor(cell)) continue;
      const item = remainingDmz.get(id) ?? {countryId: cell.properties.countryId, id, lengthKm: 0, bbox: geometryMetadata(cell.geometry).bbox,
        reason: 'No original shared-fine terminal heading reaches this residual through the same established source pair within 10 km. Preserve unassigned gameplay land instead of inventing administrative ownership.'};
      item.lengthKm += lengthKm(e.geometry.coordinates); remainingDmz.set(id, item);
    }
  }
  const evidence = {...current.evidence, rawSourceArtifactGeometryUnmodified: true,
    policy: 'Existing country/coast physical partition is immutable within the established <=1e-12 degree numerical representation policy. Boundary-touching residual strips of effective width <=5 km may join a unique same-country fine family, or split at existing original shared-fine terminal headings continued <=10 km, including certified corridors through that same established source pair. Enclosed source holes, bulk missing land, and ambiguity remain unassigned. In particular, a remaining DMZ residual without a valid original terminal heading keeps its own gameplay unit and canonical shared national edge. Adjusted family outlines are gameplay geometry, not an assertion of original administrative ownership.',
    ...(cleanupBoundarySlivers ? {cleanupBoundarySlivers: true, cleanupPolicy,
      policy: 'Existing country/coast physical partition is immutable within the established <=1e-12 degree numerical representation policy, and every original fine-source territory is retained. Explicit gameplay cleanup additionally absorbs source-free P0 land loops <=3 km² only when their entire perimeter contacts one same-country fine family, their minimum distance to that country’s existing coast/national line is <=5 km, and every loop vertex is within 5 km of that exterior linework. Internal fine/macro lines never qualify as exterior proximity. Actual P0 water holes and far inland gaps remain unchanged. Witnessed terminal splitting also permits long thin residuals <=250 km² and effective width <=2 km; the existing <=5 km general width, <=10 km original-heading ray, and unique source-pair proof remain required. Large missing land and ambiguity remain unassigned. These adjusted outlines describe gameplay territory rather than original administrative truth.'} : {}),
    maximumStripWidthKm, maximumRayKm, maximumMultiFamilyResidualAreaKm2: 100, uniqueContactPasses, changes, splitAttempts,
    precisionNormalization: numericalPasses.length ? {gridDegrees: 1e-12, passes: numericalPasses.length,
      maxSourceSegmentDeviationDegrees: Math.max(...numericalPasses.map(p => p.maximumNodedSegmentDisplacement)),
      maxRoundedCoordinateDisplacementDegrees: Math.max(...numericalPasses.map(p => p.maximumRoundedDisplacement)),
      normalizedSourcePositions: numericalPasses.reduce((sum, p) => sum + p.roundedPositions, 0), insertedNodes: numericalPasses.reduce((sum, p) => sum + p.insertedNodes, 0),
      policy: 'Country/coast physical geometry is preserved within the existing <=1e-12 degree numerical representation policy. Final cells and edges share one noded partition; exact source coordinate bytes can be normalized.'} : null,
    absorbedResidualCells: new Set(changes.flatMap(c => c.originalResidualIds)).size,
    assignedResidualParts: changes.length, inputCells: cells.length, outputCells: current.cells.length,
    remainingDmzResiduals: [...remainingDmz.values()].sort((a, b) => compareText(a.id, b.id)),
    sharedKoreaBorderBefore: before, sharedKoreaBorderAfter: after,
    originalResiduals: [...originalResiduals].filter(([id]) => changes.some(c => c.originalResidualIds.includes(id))).map(([id, cell]) => ({id, area: geometryMetadata(cell.geometry).area, geometryHash: hashCanonical('prompt19-national-original-residual.v1', cell.geometry)})),
    lineage};
  current.bundle.report = {...current.bundle.report, strictSourceMembership: false, geometryAdjusted: true, rawSourceArtifactGeometryUnmodified: true,
    nationalBoundaryReconciliation: evidence, topology: {...current.bundle.report.topology, nationalBoundaryReconciliation: evidence}};
  const oldCellToNewCell = Object.fromEntries(Object.entries(lineage).filter(([, ids]) => ids.length === 1).map(([id, ids]) => [id, ids[0]]));
  return {bundle: current.bundle, cells: current.cells, evidence, oldCellToNewCell, lineage};
}
