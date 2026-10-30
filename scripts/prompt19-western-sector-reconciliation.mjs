// Explicit gameplay partition of the audited source-free western Korean sector.
// Contact-site Voronoi is an approximation to distance from the actual contact
// polylines; it does not assert the historical administrative boundary.
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import VoronoiDiagramBuilder from 'jsts/org/locationtech/jts/triangulate/VoronoiDiagramBuilder.js';
import {canonical, compareText, geometryMetadata, hashCanonical, normalizeGeometry, polygons} from './prompt14-catalog-core.mjs';
import {commonNodeRings, ringsFromSegments} from './prompt14-boundary-arrangement.mjs';
import {globalCellId} from './prompt19-joined-topology.mjs';

const basis = 'game-boundary-reconciliation', method = 'gameplay-contact-partition';
const maximumContactSamplingSpacingKm = 0.25, maximumSectorAreaKm2 = 150;
const selected = country => country === 'KOR' || country === 'PRK';
const idFor = cell => cell.id.startsWith('territory:catalog:') ? cell.id : globalCellId(cell);
const familyFor = cell => cell.properties.fineSourceIdentity ? canonical([cell.properties.countryId, cell.properties.fineSourceIdentity]) : null;
const residual = cell => cell.properties.countryId === 'KOR' && cell.properties.fineSourceIdentity === null && cell.properties.unresolvedFineSourceAssignment === true;
const pointKey = p => `${p[0]},${p[1]}`, cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
const edgeKey = (a, b) => cmp(a, b) < 0 ? `${pointKey(a)};${pointKey(b)}` : `${pointKey(b)};${pointKey(a)}`;
const eachSegment = (geometry, fn) => {for (const p of polygons(geometry)) for (const ring of p) for (let i = 1; i < ring.length; i++) fn(ring[i - 1], ring[i]);};
const seedsFor = record => record.seedParentIds ?? [record.previousParentId];
const lengthKm = coordinates => coordinates.slice(1).reduce((sum, p, i) => {
  const a = coordinates[i], r = Math.PI / 180, h = Math.sin((p[1] - a[1]) * r / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(p[1] * r) * Math.sin((p[0] - a[0]) * r / 2) ** 2;
  return sum + 12742.0176 * Math.asin(Math.sqrt(Math.min(1, h)));
}, 0);

function unionExact(geometries) {
  const segments = new Map(), seen = new Map();
  for (const geometry of geometries) eachSegment(normalizeGeometry(geometry), (a, b) => {
    const key = edgeKey(a, b), direction = cmp(a, b) < 0 ? 1 : -1, prior = seen.get(key);
    if (!prior) {seen.set(key, {direction, count: 1}); segments.set(key, [a, b]);}
    else {if (prior.count !== 1 || prior.direction === direction) throw Error('WESTERN_NON_PARTITION_SEGMENT'); prior.count++; segments.delete(key);}
  });
  return ringsFromSegments([...segments.values()]);
}

// Analytic line clipping avoids independent polygon overlay/roundoff at the
// finite Voronoi envelope. The entire residual lies strictly inside this box.
function clipLine(a, b, box) {
  let lower = 0, upper = 1;
  for (let axis = 0; axis < 2; axis++) {
    const delta = b[axis] - a[axis], minimum = box[axis], maximum = box[axis + 2];
    if (delta === 0) {if (a[axis] < minimum || a[axis] > maximum) return null; continue;}
    const first = (minimum - a[axis]) / delta, second = (maximum - a[axis]) / delta;
    lower = Math.max(lower, Math.min(first, second)); upper = Math.min(upper, Math.max(first, second));
    if (upper <= lower) return null;
  }
  return [lower === 0 ? a : a.map((v, i) => v + lower * (b[i] - v)), upper === 1 ? b : a.map((v, i) => v + upper * (b[i] - v))];
}

function sharedKoreaBorder(bundle, locals) {
  const records = new Map(bundle.records.map(r => [r.id, r])); let totalKm = 0, fineBothSidesKm = 0;
  const remaining = new Map();
  for (const e of bundle.edges) {
    if ([records.get(e.leftTerritoryId)?.countryId, records.get(e.rightTerritoryId)?.countryId].sort().join('|') !== 'KOR|PRK') continue;
    const km = lengthKm(e.geometry.coordinates); totalKm += km;
    if ([e.leftTerritoryId, e.rightTerritoryId].every(id => locals.get(id)?.properties.fineSourceIdentity)) fineBothSidesKm += km;
    for (const id of [e.leftTerritoryId, e.rightTerritoryId]) {
      const cell = locals.get(id); if (!cell || familyFor(cell)) continue;
      const item = remaining.get(id) ?? {id, countryId: cell.properties.countryId, lengthKm: 0, bbox: geometryMetadata(cell.geometry).bbox}; item.lengthKm += km; remaining.set(id, item);
    }
  }
  return {coverage: {totalKm, fineBothSidesKm, fineBothSidesFraction: totalKm ? fineBothSidesKm / totalKm : null}, remaining: [...remaining.values()].sort((a, b) => compareText(a.id, b.id))};
}

function chains(segments, records, locals) {
  const groups = new Map();
  for (const s of segments) {
    let {a, b, left, right} = s; if (!left) {[a, b] = [b, a]; [left, right] = [right, left];}
    const l = records.get(left), r = records.get(right); if (!l || (right && !r) || left === right) throw Error('WESTERN_INVALID_EDGE_OWNER');
    const boundaryClass = !r ? 'coast' : l.countryId !== r.countryId ? 'country' : !familyFor(locals.get(left)) || !familyFor(locals.get(right)) ? 'residual' : l.administrativeParentKey === r.administrativeParentKey ? 'operational' : 'administrative';
    const key = canonical([[left, right].sort(compareText), boundaryClass]), group = groups.get(key) ?? {boundaryClass, segments: []}; group.segments.push({a, b, left, right}); groups.set(key, group);
  }
  const edges = [];
  for (const group of groups.values()) {
    group.segments.sort((a, b) => cmp(a.a, b.a) || cmp(a.b, b.b)); const incident = new Map(), seen = new Set();
    group.segments.forEach((s, i) => {for (const p of [s.a, s.b]) {const key = pointKey(p), list = incident.get(key) ?? []; list.push(i); incident.set(key, list);}});
    const walk = (start, index) => {
      const coordinates = [start]; let current = start, owners;
      while (!seen.has(index)) {
        seen.add(index); const s = group.segments[index], forward = cmp(current, s.a) === 0, next = forward ? s.b : s.a, sides = forward ? [s.left, s.right] : [s.right, s.left];
        if (!owners) owners = sides; else if (owners[0] !== sides[0] || owners[1] !== sides[1]) throw Error('WESTERN_CHAIN_ORIENTATION');
        coordinates.push(next); current = next; const list = incident.get(pointKey(next)); if (list.length !== 2) break;
        const nextIndex = list.find(i => !seen.has(i)); if (nextIndex === undefined) break; index = nextIndex;
      }
      if (!owners[0]) {owners.reverse(); coordinates.reverse();}
      const identity = {leftTerritoryId: owners[0], rightTerritoryId: owners[1], boundaryClass: group.boundaryClass, geometry: {type: 'LineString', coordinates}};
      edges.push({id: `edge:operational:${hashCanonical('prompt19-western-sector-edge.v1', identity)}`, ...identity});
    };
    for (const [key, list] of incident) if (list.length !== 2) for (const i of list) if (!seen.has(i)) walk(key.split(',').map(Number), i);
    for (let i = 0; i < group.segments.length; i++) if (!seen.has(i)) walk(group.segments[i].a, i);
  }
  return edges.sort((a, b) => compareText(a.id, b.id));
}

/** Explicit opt-in stage; callers preserve older outputs by not invoking it. */
export function reconcileWesternSector({bundle, cells, onProgress = () => {}}) {
  if (!Array.isArray(bundle?.features) || !Array.isArray(bundle.records) || !Array.isArray(bundle.edges) || !Array.isArray(cells) || !Array.isArray(bundle.parents?.administrative) || !Array.isArray(bundle.parents.previous)) throw Error('WESTERN_INVALID_INPUT');
  if (bundle.report?.invalid?.length || bundle.report?.unresolved?.length || bundle.report?.topology?.pass === false) throw Error('WESTERN_UNVERIFIED_INPUT');
  if (bundle.report?.westernSectorReconciliation) throw Error('WESTERN_ALREADY_RECONCILED');
  const reader = new GeoJSONReader(), writer = new GeoJSONWriter(), locator = new PointLocator();
  const records = new Map(bundle.records.map(r => [r.id, r])), features = new Map(bundle.features.map(f => [f.id, f])), localMap = new Map();
  if (records.size !== bundle.records.length || features.size !== bundle.features.length || records.size !== features.size) throw Error('WESTERN_DUPLICATE_ID');
  for (const cell of cells) {
    const id = idFor(cell), record = records.get(id), p = cell.properties;
    if (!selected(p?.countryId) || !record || record.countryId !== p.countryId || record.administrativeParentKey !== p.administrativeParentKey || localMap.has(id) || canonical(cell.geometry) !== canonical(features.get(id)?.geometry)) throw Error('WESTERN_CELL_SCOPE');
    if (p.fineSourceIdentity && (p.unresolvedFineSourceAssignment !== false || p.sourceId !== p.fineSourceIdentity.sourceId || p.sourceFeatureId !== p.fineSourceIdentity.sourceFeatureId)) throw Error('WESTERN_FINE_IDENTITY');
    if (!p.fineSourceIdentity && (p.fineSourceIdentity !== null || p.unresolvedFineSourceAssignment !== true)) throw Error('WESTERN_RESIDUAL_IDENTITY');
    localMap.set(id, cell);
  }
  if (bundle.records.filter(r => selected(r.countryId)).some(r => !localMap.has(r.id))) throw Error('WESTERN_INCOMPLETE_CELLS');
  const starts = new Set(), adjacency = new Map();
  for (const edge of bundle.edges) {
    if (!records.has(edge.leftTerritoryId) || (edge.rightTerritoryId && !records.has(edge.rightTerritoryId))) throw Error('WESTERN_UNKNOWN_EDGE');
    if (!(lengthKm(edge.geometry.coordinates) > 0)) continue;
    for (const [id, other] of [[edge.leftTerritoryId, edge.rightTerritoryId], [edge.rightTerritoryId, edge.leftTerritoryId]]) {
      const cell = localMap.get(id); if (!cell || !residual(cell)) continue;
      if (records.get(other)?.countryId === 'PRK' && edge.boundaryClass === 'country') starts.add(id);
      const neighbor = localMap.get(other); if (neighbor && residual(neighbor)) {const set = adjacency.get(id) ?? new Set(); set.add(other); adjacency.set(id, set);}
    }
  }
  if (starts.size !== 1) throw Error('WESTERN_EXPECTED_ONE_KOREAN_RESIDUAL_BORDER_SECTOR');
  const scope = new Set(starts), pending = [...starts];
  while (pending.length) for (const neighbor of adjacency.get(pending.pop()) ?? []) if (!scope.has(neighbor)) {scope.add(neighbor); pending.push(neighbor);}
  const scopeCells = [...scope].sort(compareText).map(id => localMap.get(id));
  const scopeGeometry = unionExact(scopeCells.map(c => c.geometry)), metadata = geometryMetadata(scopeGeometry), latitude = (metadata.bbox[1] + metadata.bbox[3]) / 2;
  const approximateAreaKm2 = metadata.area * 111.195 ** 2 * Math.cos(latitude * Math.PI / 180);
  if (metadata.components !== 1 || metadata.holes !== 0 || approximateAreaKm2 > maximumSectorAreaKm2) throw Error('WESTERN_COMPONENT_SCOPE_LIMIT');
  const origin = [(metadata.bbox[0] + metadata.bbox[2]) / 2, latitude], xScale = 111.195 * Math.cos(latitude * Math.PI / 180);
  const project = p => [(p[0] - origin[0]) * xScale, (p[1] - origin[1]) * 111.195], unproject = p => [p[0] / xScale + origin[0], p[1] / 111.195 + origin[1]];
  const contacts = new Map();
  for (const edge of bundle.edges) {
    for (const [id, other] of [[edge.leftTerritoryId, edge.rightTerritoryId], [edge.rightTerritoryId, edge.leftTerritoryId]]) {
      if (!scope.has(id)) continue;
      if (other === null) throw Error('WESTERN_SECTOR_MUST_NOT_TOUCH_COAST');
      const cell = localMap.get(other); if (!cell || cell.properties.countryId !== 'KOR' || !familyFor(cell) || !(lengthKm(edge.geometry.coordinates) > 0)) continue;
      const key = familyFor(cell), entry = contacts.get(key) ?? {family: key, representative: cell, cellIds: new Set(), edges: []}; entry.cellIds.add(other); entry.edges.push(edge); contacts.set(key, entry);
    }
  }
  if (contacts.size !== 2 || new Set([...contacts.values()].map(c => c.representative.properties.administrativeParentKey)).size !== 1 || new Set([...contacts.values()].map(c => c.representative.properties.sourceParentId)).size !== 1) throw Error('WESTERN_REQUIRES_TWO_SAME_MACRO_FINE_CONTACT_FAMILIES');
  const expectedNames = new Set(['91817680B14253606839965', '91817680B98224083425041']);
  if ([...contacts.values()].some(c => !expectedNames.has(c.representative.properties.sourceFeatureId))) throw Error('WESTERN_FINE_SOURCE_FAMILY_SCOPE');
  const sitesByPoint = new Map(); let sampledSegments = 0, actualMaximumSpacingKm = 0;
  for (const contact of [...contacts.values()].sort((a, b) => compareText(a.family, b.family))) for (const edge of [...contact.edges].sort((a, b) => compareText(a.id, b.id))) {
    const coordinates = edge.geometry.coordinates;
    for (let i = 1; i < coordinates.length; i++) {
      const a = project(coordinates[i - 1]), b = project(coordinates[i]), distance = Math.hypot(b[0] - a[0], b[1] - a[1]), divisions = Math.max(1, Math.ceil(distance / maximumContactSamplingSpacingKm));
      sampledSegments++; actualMaximumSpacingKm = Math.max(actualMaximumSpacingKm, distance / divisions);
      for (let step = 0; step <= divisions; step++) {
        const p = step === 0 ? a : step === divisions ? b : a.map((v, axis) => v + (b[axis] - v) * step / divisions), key = pointKey(p);
        const site = sitesByPoint.get(key) ?? {pointKm: p, families: new Set(), contactEdgeIds: new Set()}; site.families.add(contact.family); site.contactEdgeIds.add(edge.id); sitesByPoint.set(key, site);
      }
    }
  }
  const sites = [...sitesByPoint.values()].map(site => ({pointKm: site.pointKm, families: [...site.families].sort(compareText), contactEdgeIds: [...site.contactEdgeIds].sort(compareText)})).sort((a, b) => cmp(a.pointKm, b.pointKm));
  if (sites.length < 3 || sites.length > 2000) throw Error('WESTERN_CONTACT_SITE_LIMIT');
  const builder = new VoronoiDiagramBuilder(), siteGeometry = reader.read({type: 'MultiPoint', coordinates: sites.map(s => s.pointKm)});
  builder.setSites(siteGeometry); builder.setTolerance(0);
  const lower = project([metadata.bbox[0], metadata.bbox[1]]), upper = project([metadata.bbox[2], metadata.bbox[3]]), clipBoxKm = [lower[0] - 1, lower[1] - 1, upper[0] + 1, upper[1] + 1];
  const subdivision = builder.getSubdivision(), sectorRadiusKm = Math.hypot(upper[0] - lower[0], upper[1] - lower[1]) / 2, frameDistances = [];
  for (const it = subdivision.getVertices(true).iterator(); it.hasNext();) {const vertex = it.next(); if (subdivision.isFrameVertex(vertex)) {const c = vertex.getCoordinate(); frameDistances.push(Math.hypot(c.x, c.y));}}
  const nearestRealSiteToCenterKm = Math.min(...sites.map(site => Math.hypot(...site.pointKm))), minimumFrameVertexToCenterKm = Math.min(...frameDistances);
  const frameDistanceMarginKm = minimumFrameVertexToCenterKm - nearestRealSiteToCenterKm - 2 * sectorRadiusKm;
  if (!(frameDistanceMarginKm > 0)) throw Error('WESTERN_VORONOI_FRAME_NOT_OUTSIDE_SECTOR');
  const diagram = subdivision.getVoronoiDiagram(siteGeometry.getFactory()), lineMap = new Map();
  for (let i = 0; i < diagram.getNumGeometries(); i++) {
    const g = writer.write(diagram.getGeometryN(i));
    for (const p of polygons(g)) for (const ring of p) for (let j = 1; j < ring.length; j++) {
      const line = clipLine(ring[j - 1], ring[j], clipBoxKm); if (!line) continue;
      const a = unproject(line[0]), b = unproject(line[1]); if (cmp(a, b)) lineMap.set(edgeKey(a, b), {coordinates: [a, b]});
    }
  }
  const external = bundle.edges.filter(e => ['coast', 'country'].includes(e.boundaryClass) && (localMap.has(e.leftTerritoryId) || localMap.has(e.rightTerritoryId)));
  onProgress(`western gameplay contact partition: ${scope.size} residual cells, ${sites.length} contact sites, ${lineMap.size} Voronoi segments`);
  const numerical = commonNodeRings({type: 'FeatureCollection', features: []}, {type: 'FeatureCollection', features: cells}, onProgress,
    [...external.map((e, i) => ({coordinates: e.geometry.coordinates, sourceFeatureId: `external:${i}`})), ...[...lineMap.values()].map((line, i) => ({...line, sourceFeatureId: `contact-voronoi:${i}`}))]);
  const common = new Map([...numerical.edges].map(([key, e]) => [key, {...e,
    left: [...new Set(e.contexts.filter(c => c.role === 'P1' && c.direction === 1).map(c => c.featureIndex))],
    right: [...new Set(e.contexts.filter(c => c.role === 'P1' && c.direction === -1).map(c => c.featureIndex))]}]));
  const originalDirected = cells.map(() => []), geometries = numerical.selected.features.map(c => reader.read(c.geometry)), index = new STRtree();
  geometries.forEach((g, i) => index.insert(g.getEnvelopeInternal(), i));
  const polygonizer = new Polygonizer();
  for (const e of common.values()) {polygonizer.add(reader.read({type: 'LineString', coordinates: [e.a, e.b]})); for (const i of e.left) originalDirected[i].push([e.a, e.b]); for (const i of e.right) originalDirected[i].push([e.b, e.a]);}
  const assigned = [], facesByFamily = new Map([...contacts.keys()].map(key => [key, []]));
  for (const it = polygonizer.getPolygons().iterator(); it.hasNext();) {
    const polygon = it.next(), point = InteriorPointArea.getInteriorPoint(polygon), hits = [];
    for (const candidates = index.query(new Envelope(point)).iterator(); candidates.hasNext();) {const i = candidates.next(); if (locator.locate(point, geometries[i]) === 0) hits.push(i);}
    if (!hits.length) continue;
    if (hits.length !== 1) throw Error('WESTERN_COMMON_FACE_MEMBERSHIP');
    const inputId = idFor(cells[hits[0]]); if (!scope.has(inputId)) continue;
    if (!new IsValidOp(polygon).isValid()) throw Error('WESTERN_INVALID_ASSIGNED_FACE');
    const projected = project([point.x, point.y]); let nearest = null, squared = Infinity;
    for (const site of sites) {const value = (site.pointKm[0] - projected[0]) ** 2 + (site.pointKm[1] - projected[1]) ** 2; if (value < squared) {squared = value; nearest = site;}}
    if (!nearest) throw Error('WESTERN_FACE_WITHOUT_CONTACT_SITE');
    const face = {inputId, family: nearest.families[0], geometry: normalizeGeometry(writer.write(polygon)), nearestContactSiteKm: nearest.pointKm};
    assigned.push(face); facesByFamily.get(face.family).push(face);
  }
  const assignedArea = assigned.reduce((sum, f) => sum + geometryMetadata(f.geometry).area, 0);
  if (!assigned.length || Math.abs(assignedArea - metadata.area) > Math.max(1e-10, metadata.area * 1e-8)) throw Error('WESTERN_INCOMPLETE_RESIDUAL_PARTITION');
  for (const cell of scopeCells) if (Math.abs(assigned.filter(f => f.inputId === idFor(cell)).reduce((sum, f) => sum + geometryMetadata(f.geometry).area, 0) - geometryMetadata(cell.geometry).area) > 1e-10) throw Error('WESTERN_INCOMPLETE_INPUT_RESIDUAL');
  const normalizedCells = cells.map((cell, i) => ({...cell, geometry: ringsFromSegments(originalDirected[i])}));
  const inputOrigins = new Map();
  for (const [oldId, descendants] of Object.entries(bundle.report?.nationalBoundaryReconciliation?.lineage ?? {})) for (const id of descendants) {const list = inputOrigins.get(id) ?? []; list.push(oldId); inputOrigins.set(id, list);}
  const originalResidualIds = [...new Set([...scope].flatMap(id => inputOrigins.get(id) ?? [id]))].sort(compareText);
  const nextCells = [], nextRecords = [], lineage = Object.fromEntries(bundle.records.map(r => [r.id, []])), changes = [], receivingComponents = [];
  for (const family of [...contacts.keys()].sort(compareText)) {
    const original = normalizedCells.filter(c => familyFor(c) === family), faces = facesByFamily.get(family), contact = contacts.get(family), representative = contact.representative;
    if (!faces.length) throw Error('WESTERN_CONTACT_FAMILY_LOST_ALL_ASSIGNMENTS');
    const assignedGeometry = unionExact(faces.map(f => f.geometry)), joined = unionExact([...original.map(c => c.geometry), ...faces.map(f => f.geometry)]);
    const assignedComponents = polygons(assignedGeometry).map(coordinates => {
      const geometry = normalizeGeometry({type: 'Polygon', coordinates}), contactSegments = []; let positiveOriginalFineContactKm = 0;
      eachSegment(geometry, (a, b) => {
        const contexts = common.get(edgeKey(a, b))?.contexts.filter(c => c.role === 'P1') ?? [];
        if (!contexts.some(c => scope.has(idFor(cells[c.featureIndex])))) return;
        const originalFineCellIds = [...new Set(contexts.filter(c => familyFor(cells[c.featureIndex]) === family).map(c => idFor(cells[c.featureIndex])))].sort(compareText);
        if (!originalFineCellIds.length) return;
        const km = lengthKm([a, b]); if (!(km > 0)) return;
        positiveOriginalFineContactKm += km; contactSegments.push({coordinates: [a, b], originalFineCellIds, lengthKm: km});
      });
      if (!(positiveOriginalFineContactKm > 0)) throw Error('WESTERN_ASSIGNED_COMPONENT_WITHOUT_POSITIVE_ORIGINAL_FINE_CONTACT');
      return {geometryHash: hashCanonical('prompt19-western-sector-assigned-component.v1', geometry), area: geometryMetadata(geometry).area, positiveOriginalFineContactKm, contactSegments};
    });
    const parts = polygons(joined).map(coordinates => {const geometry = normalizeGeometry({type: 'Polygon', coordinates}), g = reader.read(geometry); if (!new IsValidOp(g).isValid()) throw Error('WESTERN_INVALID_RECEIVING_COMPONENT'); return {geometry, g, originals: [], faces: []};});
    for (const cell of original) {const point = InteriorPointArea.getInteriorPoint(reader.read(cell.geometry)), matches = parts.filter(p => locator.locate(point, p.g) === 0); if (matches.length !== 1) throw Error('WESTERN_ORIGINAL_FINE_MEMBERSHIP'); matches[0].originals.push(cell);}
    for (const face of faces) {const point = InteriorPointArea.getInteriorPoint(reader.read(face.geometry)), matches = parts.filter(p => locator.locate(point, p.g) === 0); if (matches.length !== 1) throw Error('WESTERN_ASSIGNED_COMPONENT_MEMBERSHIP'); matches[0].faces.push(face);}
    for (const part of parts) {
      if (part.faces.length && !part.originals.length) throw Error('WESTERN_DISCONNECTED_ASSIGNED_COMPONENT');
      const inputIds = [...new Set([...part.originals.map(idFor), ...part.faces.map(f => f.inputId)])].sort(compareText), seedParentIds = [...new Set(inputIds.flatMap(id => seedsFor(records.get(id))))].sort(compareText), p = representative.properties;
      const localId = `KOR:cell:${hashCanonical('prompt19-western-sector-local-cell.v1', {fineSourceIdentity: p.fineSourceIdentity, administrativeParentKey: p.administrativeParentKey, geometry: part.geometry})}`;
      const cell = {type: 'Feature', id: localId, properties: {...p, localId, coarseParentTerritoryId: null, seedParentIds, mergedCellIds: inputIds,
        geometryAdjusted: true, geometryBasis: 'gameplay-national-boundary-reconciled', boundaryBasis: basis,
        boundaryAdjustment: {...p.boundaryAdjustment, basis, method, geometryAdjusted: true, rawSourceArtifactGeometryUnmodified: true, administrativeTruthClaim: false,
          westernSectorReconciliation: true, originalResidualIds: [...new Set([...(p.boundaryAdjustment?.originalResidualIds ?? []), ...originalResidualIds])].sort(compareText), inputResidualIds: [...scope].sort(compareText),
          originalFineCellIds: [...new Set(part.originals.flatMap(c => c.properties.boundaryAdjustment?.originalFineCellIds ?? [idFor(c)]))].sort(compareText)},
        decisions: [...new Set([...(p.decisions ?? []), method])]}, geometry: part.geometry};
      const id = globalCellId(cell); nextCells.push(cell); nextRecords.push({...records.get(idFor(representative)), id, previousParentId: seedParentIds[0], seedParentIds});
      for (const oldId of inputIds) lineage[oldId].push(id);
      if (part.faces.length) receivingComponents.push({cellId: id, fineSourceIdentity: p.fineSourceIdentity, originalFineCellIds: part.originals.map(idFor).sort(compareText), assignedArea: part.faces.reduce((sum, f) => sum + geometryMetadata(f.geometry).area, 0), connectedToOriginalFineByPositiveLengthPartition: true});
    }
    changes.push({kind: 'western-sector-gameplay-contact-assignment', basis, method, countryId: 'KOR', geometryAdjusted: true, rawSourceArtifactGeometryUnmodified: true, administrativeTruthClaim: false,
      originalResidualIds, inputResidualIds: [...scope].sort(compareText), originalResidualArea: metadata.area, assignedPartArea: geometryMetadata(assignedGeometry).area, assignedPartGeometry: assignedGeometry,
      fineSourceIdentity: {...representative.properties.fineSourceIdentity}, sourceParentId: representative.properties.sourceParentId, administrativeParentKey: representative.properties.administrativeParentKey,
      contactEdgeIds: contact.edges.map(e => e.id).sort(compareText), assignedComponents, witness: 'bounded-nearest-positive-length-fine-contact-sites'});
  }
  for (let i = 0; i < cells.length; i++) {
    const old = cells[i], oldId = idFor(old); if (scope.has(oldId) || contacts.has(familyFor(old))) continue;
    const geometry = normalizedCells[i].geometry; let cell = old;
    if (canonical(geometry) !== canonical(old.geometry)) {const localId = `${old.properties.countryId}:cell:${hashCanonical('prompt19-western-sector-noded-cell.v1', {priorCellId: old.id, geometry})}`; cell = {...old, id: localId, properties: {...old.properties, localId}, geometry};}
    nextCells.push(cell); nextRecords.push({...records.get(oldId), id: idFor(cell)}); lineage[oldId] = [idFor(cell)];
  }
  for (const r of bundle.records) if (!selected(r.countryId)) lineage[r.id] = [r.id];
  for (const id of Object.keys(lineage)) {lineage[id] = [...new Set(lineage[id])].sort(compareText); if (!lineage[id].length) throw Error('WESTERN_MISSING_INPUT_LINEAGE');}
  nextCells.sort((a, b) => compareText(a.id, b.id)); nextRecords.sort((a, b) => compareText(a.id, b.id));
  const allRecords = [...bundle.records.filter(r => !selected(r.countryId)), ...nextRecords], recordMap = new Map(allRecords.map(r => [r.id, r])), nextMap = new Map(nextCells.map(c => [idFor(c), c]));
  const ownedSegments = new Map();
  for (const cell of nextCells) eachSegment(cell.geometry, (a, b) => {const key = edgeKey(a, b), e = ownedSegments.get(key) ?? {a: cmp(a, b) < 0 ? a : b, b: cmp(a, b) < 0 ? b : a, left: [], right: []}; (cmp(a, b) < 0 ? e.left : e.right).push(idFor(cell)); ownedSegments.set(key, e);});
  const rawEdges = [];
  for (const [key, e] of ownedSegments) {
    if (e.left.length > 1 || e.right.length > 1) throw Error('WESTERN_AMBIGUOUS_FINAL_SIDE'); let left = e.left[0] ?? null, right = e.right[0] ?? null;
    if (!left || !right) {
      const proofs = common.get(key)?.contexts.filter(c => c.role === 'P1-extension' && c.sourceFeatureId.startsWith('external:')).map(c => external[Number(c.sourceFeatureId.slice(9))]) ?? [];
      if (proofs.length !== 1) throw Error('WESTERN_UNPAIRED_FINAL_BOUNDARY');
      const outside = [proofs[0].leftTerritoryId, proofs[0].rightTerritoryId].find(id => id && !selected(records.get(id)?.countryId)) ?? null; if (!left) left = outside; else right = outside;
      if (proofs[0].boundaryClass === 'country' && !outside) throw Error('WESTERN_MISSING_COUNTRY_SIDE');
    }
    rawEdges.push({a: e.a, b: e.b, left, right});
  }
  const edges = [...bundle.edges.filter(e => !selected(records.get(e.leftTerritoryId)?.countryId) && !selected(records.get(e.rightTerritoryId)?.countryId)), ...chains(rawEdges, recordMap, nextMap)];
  if (new Set(edges.map(e => e.id)).size !== edges.length || recordMap.size !== allRecords.length) throw Error('WESTERN_DUPLICATE_OUTPUT_ID');
  const usedAdministrative = new Set(allRecords.map(r => r.administrativeParentKey)), administrative = bundle.parents.administrative.filter(p => usedAdministrative.has(p.parentKey));
  const priorParents = new Map(bundle.parents.previous.map(p => [p.oldTerritoryId, p])), seedGroups = new Map();
  for (const r of nextRecords) {const set = seedGroups.get(r.previousParentId) ?? new Set(); seedsFor(r).forEach(id => set.add(id)); seedGroups.set(r.previousParentId, set);}
  const previous = [...bundle.parents.previous.filter(p => !selected(p.sourceCountryId)), ...[...seedGroups].sort(([a], [b]) => compareText(a, b)).map(([id, seeds]) => {const parent = priorParents.get(id); if (!parent) throw Error('WESTERN_UNKNOWN_SEED_PARENT'); return {...parent, seedParentIds: [...seeds].sort(compareText)};})];
  const summary = (bundle.report?.summary ?? []).map(before => {if (!selected(before.countryId)) return before; const own = nextCells.filter(c => c.properties.countryId === before.countryId), unknown = own.filter(c => !familyFor(c)); return {...before, cells: own.length, fineCells: own.length - unknown.length, coarseResidualCells: unknown.length, arrangedFaceArea: own.reduce((sum, c) => sum + geometryMetadata(c.geometry).area, 0), coarseResidualArea: unknown.reduce((sum, c) => sum + geometryMetadata(c.geometry).area, 0)};});
  const output = {...bundle, records: allRecords, features: [...bundle.features.filter(f => !selected(records.get(f.id).countryId)), ...nextCells.map(c => ({...c, id: idFor(c)}))], edges, parents: {...bundle.parents, administrative, previous}};
  const beforeBorder = sharedKoreaBorder(bundle, localMap), afterBorder = sharedKoreaBorder(output, nextMap);
  if (afterBorder.remaining.length || Math.abs(afterBorder.coverage.fineBothSidesFraction - 1) > 1e-12) throw Error('WESTERN_INCOMPLETE_DMZ_FINE_COVERAGE');
  const evidence = {schemaVersion: 'prompt19-western-sector-reconciliation-v1', basis, method, geometryAdjusted: true, rawSourceArtifactGeometryUnmodified: true, administrativeTruthClaim: false,
    originalFineExtentPreserved: true, sourceCountryAssignmentPreserved: true, macroAssignmentPreserved: true, nationalBoundaryPhysicalGeometryPreserved: true,
    policy: 'The audited western KOR source-free connected land sector is partitioned between its two existing same-macro fine contact families by a local point-site Voronoi sampled only from their positive-length shared contact boundaries. All original fine territory, source country, national/coast outline and raw artifacts remain preserved. The resulting affiliation is explicit gameplay geometry, without an official administrative-boundary claim.',
    inputResiduals: scopeCells.map(c => {
      const sourceFaces = assigned.filter(f => f.inputId === idFor(c)), assignments = [...contacts.keys()].sort(compareText).map(family => ({fineSourceIdentity: contacts.get(family).representative.properties.fineSourceIdentity, assignedArea: sourceFaces.filter(f => f.family === family).reduce((sum, f) => sum + geometryMetadata(f.geometry).area, 0)})), assignedArea = assignments.reduce((sum, a) => sum + a.assignedArea, 0), area = geometryMetadata(c.geometry).area;
      return {id: idFor(c), originalResidualIds: inputOrigins.get(idFor(c)) ?? [idFor(c)], area, assignedArea, areaError: assignedArea - area, assignments, geometry: c.geometry, geometryHash: hashCanonical('prompt19-western-sector-input-residual.v1', c.geometry)};
    }),
    component: {inputCellIds: [...scope].sort(compareText), geometry: scopeGeometry, bbox: metadata.bbox, area: metadata.area, approximateAreaKm2, maximumSectorAreaKm2, countryId: 'KOR', sourceFreeOnly: true},
    contacts: [...contacts.values()].sort((a, b) => compareText(a.family, b.family)).map(c => ({fineSourceIdentity: c.representative.properties.fineSourceIdentity, sourceParentId: c.representative.properties.sourceParentId, administrativeParentKey: c.representative.properties.administrativeParentKey, name: c.representative.properties.name, cellIds: [...c.cellIds].sort(compareText), edges: c.edges.map(e => ({id: e.id, geometry: e.geometry, lengthKm: lengthKm(e.geometry.coordinates)})).sort((a, b) => compareText(a.id, b.id))})),
    sampling: {method: 'local-km point-site Voronoi of sampled contact segments', continuousSegmentVoronoi: false, origin, xScaleKmPerDegree: xScale, yScaleKmPerDegree: 111.195,
      maximumContactSamplingSpacingKm, actualMaximumSpacingKm, maximumContactDistanceOverestimateKm: actualMaximumSpacingKm / 2, maximumNearestContactDistanceRegretKm: actualMaximumSpacingKm / 2,
      diagramCoverageCertificate: {sectorRadiusKm, nearestRealSiteToCenterKm, minimumFrameVertexToCenterKm, frameDistanceMarginKm, clipBoxKm,
        method: 'The enclosing-radius triangle inequality proves every artificial frame site is farther than a real contact site throughout the sector. Voronoi lines are analytically clipped 1 km outside the sector bbox; no independent polygon overlay is used.'},
      boundaryPositionDisplacementBoundClaimed: false, sites, sampledSegments, tiePolicy: 'Canonical projected coordinate order; coincident contact sites retain all source families and use their sorted identity as a deterministic gameplay tie-break. No country, macro, or centroid guess.'},
    changes, receivingComponents, ledger: {inputResidualArea: metadata.area, assignedArea, assignedFamilyArea: changes.reduce((sum, c) => sum + c.assignedPartArea, 0), areaError: assignedArea - metadata.area, unassignedResidualArea: 0, originalFineAreaRemoved: 0},
    precisionNormalization: {gridDegrees: 1e-12, maxSourceSegmentDeviationDegrees: numerical.evidence.maximumNodedSegmentDisplacement, maxRoundedCoordinateDisplacementDegrees: numerical.evidence.maximumRoundedDisplacement, insertedNodes: numerical.evidence.insertedNodes},
    sharedKoreaBorderBefore: beforeBorder.coverage, sharedKoreaBorderAfter: afterBorder.coverage, remainingDmzResiduals: afterBorder.remaining, inputCells: cells.length, outputCells: nextCells.length, lineage};
  const priorNational = bundle.report?.nationalBoundaryReconciliation ?? {}, combinedLineage = Object.fromEntries(Object.entries(priorNational.lineage ?? Object.fromEntries(bundle.records.map(r => [r.id, [r.id]]))).map(([id, descendants]) => [id, [...new Set(descendants.flatMap(d => lineage[d] ?? [d]))].sort(compareText)]));
  const national = {...priorNational, changes: [...(priorNational.changes ?? []), ...changes], lineage: combinedLineage, outputCells: nextCells.length, assignedResidualParts: (priorNational.changes?.length ?? 0) + changes.length,
    sharedKoreaBorderAfter: afterBorder.coverage, remainingDmzResiduals: afterBorder.remaining, westernSectorReconciliation: evidence,
    priorStagePolicy: priorNational.policy ?? null, policy: `${evidence.policy} Earlier enclosed-loop and witnessed coastal-strip adjustments remain documented in their original stage evidence.`};
  output.report = {...bundle.report, cells: nextCells.length, summary, strictSourceMembership: false, geometryAdjusted: true, rawSourceArtifactGeometryUnmodified: true, westernSectorReconciliation: evidence,
    nationalBoundaryReconciliation: national, topology: {...bundle.report?.topology, pass: true, edges: edges.filter(e => selected(recordMap.get(e.leftTerritoryId)?.countryId) || selected(recordMap.get(e.rightTerritoryId)?.countryId)).length, westernSectorReconciliation: evidence, nationalBoundaryReconciliation: national}};
  return {bundle: output, cells: nextCells, evidence, lineage, oldCellToNewCell: Object.fromEntries(Object.entries(lineage).filter(([, ids]) => ids.length === 1).map(([id, ids]) => [id, ids[0]]))};
}
