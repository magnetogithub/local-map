// One exact noded arrangement of fine source + immutable coarse parents/P0.
// No repeated clipping, global sweep-line union, grid, nearest-owner fill, or source snapping.
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import InteriorPointArea from 'jsts/org/locationtech/jts/algorithm/InteriorPointArea.js';
import Polygonizer from 'jsts/org/locationtech/jts/operation/polygonize/Polygonizer.js';
import STRtree from 'jsts/org/locationtech/jts/index/strtree/STRtree.js';
import Envelope from 'jsts/org/locationtech/jts/geom/Envelope.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {canonical, compareText, geometryMetadata, hashCanonical, normalizeGeometry, polygons} from './prompt14-catalog-core.mjs';
import {nodeCatalogBoundarySegments} from './prompt14-catalog-topology.mjs';
import {ringsFromSegments} from './prompt14-boundary-arrangement.mjs';

const reader = new GeoJSONReader(), writer = new GeoJSONWriter(), locator = new PointLocator();
const pointKey = p => `${p[0]},${p[1]}`;
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1];
const edgeKey = (a, b) => cmp(a, b) < 0 ? `${pointKey(a)};${pointKey(b)}` : `${pointKey(b)};${pointKey(a)}`;
const covered = (point, geometry) => locator.locate(point, geometry) !== 2;
const interior = (point, geometry) => locator.locate(point, geometry) === 0;
const iterable = collection => {const result = []; for (const it = collection.iterator(); it.hasNext();) result.push(it.next()); return result;};
const lookup = (index, point, test = interior) => iterable(index.query(new Envelope(point))).filter(item => test(point, item.g));
const indexItems = items => {const index = new STRtree(); for (const item of items) index.insert(item.g.getEnvelopeInternal(), item); return index;};
const eachSegment = (geometry, fn) => {for (const p of polygons(geometry)) for (const r of p) for (let i = 1; i < r.length; i++) fn(r[i - 1], r[i]);};
function rayExit(terminal, other, face) {
  const vector = [terminal[0] - other[0], terminal[1] - other[1]];
  let hit = null;
  eachSegment(face.geometry, (a, b) => {
    const segment = [b[0] - a[0], b[1] - a[1]], den = vector[0] * segment[1] - vector[1] * segment[0];
    if (!den) return;
    const d = [a[0] - terminal[0], a[1] - terminal[1]];
    const t = (d[0] * segment[1] - d[1] * segment[0]) / den;
    const u = (d[0] * vector[1] - d[1] * vector[0]) / den;
    if (t <= 1e-9 || u < 0 || u > 1 || (hit && t >= hit.t)) return;
    const end = u === 0 ? a : u === 1 ? b : [a[0] + u * segment[0], a[1] + u * segment[1]];
    const mid = new Coordinate(terminal[0] + (end[0] - terminal[0]) * 0.5, terminal[1] + (end[1] - terminal[1]) * 0.5);
    if (interior(mid, face.g)) hit = {t, end};
  });
  return hit;
}

export function arrangePrompt19Sources({datasets, neighboringParents = [], reconcile = true, continueTerminals = false, preserveCanonicalResiduals = false, strictSourceMembership = false, onProgress = () => {}}) {
  const components = [], parents = [], countries = [], detached = [];
  for (const dataset of datasets) {
    countries.push({countryId: dataset.countryId, geometry: dataset.envelope.geometry, g: reader.read(dataset.envelope.geometry)});
    for (const f of dataset.features) for (const [componentIndex, coordinates] of polygons(f.geometry).entries()) {
      const geometry = normalizeGeometry({type: 'Polygon', coordinates});
      components.push({countryId: dataset.countryId, feature: f, componentIndex, geometry, g: reader.read(geometry)});
    }
    for (const f of dataset.coarseParents) parents.push({countryId: dataset.countryId, feature: f, geometry: f.geometry, g: reader.read(f.geometry), neighbor: false});
    for (const [componentIndex, coordinates] of polygons(dataset.envelope.geometry).entries()) {
      const geometry = normalizeGeometry({type: 'Polygon', coordinates});
      detached.push({countryId: dataset.countryId, componentIndex, geometry, g: reader.read(geometry), fineMembers: 0});
    }
  }
  for (const f of neighboringParents) parents.push({countryId: f.properties.countryId, feature: f, geometry: f.geometry, g: reader.read(f.geometry), neighbor: true});
  const countryIndex = indexItems(countries), sourceIndex = indexItems(components), parentIndex = indexItems(parents), detachedIndex = indexItems(detached);
  const atoms = [...components, ...parents].map((item, i) => ({canonicalAtomKey: String(i), geometry: item.geometry, identity: {sourceCountryId: item.countryId}}));
  const sourceCount = components.length, extensions = [], extensionKeys = new Set();
  let final = null;
  for (let iteration = 0; iteration < 6; iteration++) {
    onProgress(`joint source arrangement pass ${iteration + 1}, ${sourceCount} source components, ${extensions.length} witnessed continuations`);
    const common = nodeCatalogBoundarySegments(atoms, {type: 'FeatureCollection', features: countries.map(c => ({type: 'Feature', properties: {countryId: c.countryId}, geometry: c.geometry}))}, onProgress, extensions);
    const polygonizer = new Polygonizer();
    for (const e of common.segments.values()) polygonizer.add(reader.read({type: 'LineString', coordinates: [e.a, e.b]}));
    const allFaces = [], gaps = [], changes = [];
    for (const polygon of iterable(polygonizer.getPolygons())) {
      const point = InteriorPointArea.getInteriorPoint(polygon), country = lookup(countryIndex, point)[0];
      const parentHits = lookup(parentIndex, point), parent = parentHits.find(p => !p.neighbor && p.countryId === country?.countryId);
      if (!country) {
        const neighbor = parentHits.find(p => p.neighbor);
        if (neighbor) allFaces.push({countryId: neighbor.countryId, neighbor: true, parent: neighbor, polygon, geometry: normalizeGeometry(writer.write(polygon))});
        continue;
      }
      if (!parent) throw Error(`PROMPT19_FACE_WITHOUT_COARSE_PARENT: ${country.countryId}`);
      const geometry = normalizeGeometry(writer.write(polygon)), contacts = new Set(), inward = new Set();
      eachSegment(geometry, (a, b) => {
        const e = common.segments.get(edgeKey(a, b)); if (!e) throw Error('PROMPT19_FACE_EDGE_NOT_NODED');
        for (const n of [...e.left, ...e.right]) if (n < sourceCount && components[n].countryId === country.countryId) contacts.add(n);
        for (const n of (cmp(a, b) < 0 ? e.left : e.right)) if (n < sourceCount && components[n].countryId === country.countryId) inward.add(n);
      });
      const members = lookup(sourceIndex, point).filter(c => c.countryId === country.countryId), sides = [...inward];
      // In strict mode a face receives fine identity only from its original
      // interior membership. A shared edge is no evidence that a source hole
      // or uncovered coastal face belongs to that administrative source.
      let source = members.length === 1 ? members[0] : !strictSourceMembership && members.length === 0 && sides.length === 1 ? components[sides[0]] : null;
      let decision = 'actual-source-membership';
      if (!strictSourceMembership && !source && members.length === 0 && reconcile) {
        const contactFeatures = new Map([...contacts].map(n => [canonical([components[n].feature.properties.sourceId, components[n].feature.properties.sourceFeatureId]), n]));
        const witnesses = new Set();
        for (const extension of extensions) if (extension.countryId === country.countryId && covered(point, extension.residual) &&
          (!contacts.size || contacts.has(extension.left) || contacts.has(extension.right))) {
          const [a, b] = extension.coordinates, cross = (b[0] - a[0]) * (point.y - a[1]) - (b[1] - a[1]) * (point.x - a[0]);
          if (cross) witnesses.add(cross > 0 ? extension.left : extension.right);
        }
        if (contactFeatures.size === 1) {source = components[[...contactFeatures.values()][0]]; decision = 'unique-positive-length-source-contact';}
        else if (witnesses.size === 1) {source = components[[...witnesses][0]]; decision = 'witnessed-shared-source-terminal-continuation';}
      }
      const face = {countryId: country.countryId, parent, source, memberCount: members.length, decision, geometry, polygon, g: polygon, contacts, point,
        detached: lookup(detachedIndex, point)[0]};
      if (source) {
        if (decision === 'actual-source-membership') face.detached.fineMembers++;
        else changes.push({countryId: face.countryId, sourceFeatureId: source.feature.properties.sourceFeatureId, decision, area: polygon.getArea(), geometry});
      } else gaps.push(face);
      allFaces.push(face);
    }
    const failures = {dangles: polygonizer.getDangles().size(), cutEdges: polygonizer.getCutEdges().size(), invalidRings: polygonizer.getInvalidRingLines().size()};
    onProgress(`faces ${allFaces.length}, unresolved ${gaps.length}; ${JSON.stringify(failures)}`);
    final = {allFaces, gaps, changes, common, failures};
    if (strictSourceMembership || !reconcile || !continueTerminals || !gaps.length) break;
    const sourcePairs = new Map();
    for (const e of common.segments.values()) {
      const left = e.left.filter(n => n < sourceCount), right = e.right.filter(n => n < sourceCount);
      if (left.length !== 1 || right.length !== 1 || left[0] === right[0] || components[left[0]].countryId !== components[right[0]].countryId) continue;
      const key = [left[0], right[0]].sort((a, b) => a - b).join('/'), list = sourcePairs.get(key) ?? [];
      list.push({a: e.a, b: e.b, left: left[0], right: right[0]}); sourcePairs.set(key, list);
    }
    const terminals = [];
    for (const list of sourcePairs.values()) {
      const degree = new Map(); for (const e of list) for (const p of [e.a, e.b]) degree.set(pointKey(p), (degree.get(pointKey(p)) ?? 0) + 1);
      for (const e of list) {
        if (degree.get(pointKey(e.b)) === 1) terminals.push({terminal: e.b, other: e.a, left: e.left, right: e.right});
        if (degree.get(pointKey(e.a)) === 1) terminals.push({terminal: e.a, other: e.b, left: e.right, right: e.left});
      }
    }
    let added = 0;
    for (const face of gaps) {
      if (face.contacts.size < 2) continue;
      for (const t of terminals) {
        if (!face.contacts.has(t.left) || !face.contacts.has(t.right) || !covered(new Coordinate(...t.terminal), face.g)) continue;
        const hit = rayExit(t.terminal, t.other, face); if (!hit) continue;
        const key = canonical([t.terminal, hit.end, t.left, t.right]); if (extensionKeys.has(key)) continue;
        const delta = [hit.end[0] - t.terminal[0], hit.end[1] - t.terminal[1]], length = Math.hypot(...delta);
        const guard = Math.min(1e-11, length * 1e-8);
        const nodingEnd = [hit.end[0] + delta[0] / length * guard, hit.end[1] + delta[1] / length * guard];
        extensionKeys.add(key); extensions.push({coordinates: [t.terminal, nodingEnd], exactResidualExit: hit.end, numericalIntersectionGuardDegrees: guard,
          countryId: face.countryId, left: t.left, right: t.right,
          leftSourceFeatureId: components[t.left].feature.properties.sourceFeatureId, rightSourceFeatureId: components[t.right].feature.properties.sourceFeatureId,
          residual: face.g, residualGeometry: face.geometry, witness: [t.other, t.terminal], maximumExtent: 'First exit of this recorded residual face along the actual source boundary terminal direction'}); added++;
      }
    }
    if (!added) break;
  }
  const groups = new Map(), unresolved = [];
  for (const face of final.allFaces) {
    if (face.neighbor) {face.group = `neighbor:${face.parent.feature.properties.coarseTerritoryId}`; continue;}
    if (!face.source) {
      // Entire original country components with no fine membership retain their P0 identity.
      if (strictSourceMembership && face.memberCount === 0) face.decision = 'canonical-country-residual';
      else if (reconcile && face.memberCount === 0 && face.detached.fineMembers === 0 && face.contacts.size === 0) face.decision = 'unchanged-detached-baseline-component';
      else if (preserveCanonicalResiduals && face.memberCount === 0) face.decision = 'canonical-country-residual';
      else {unresolved.push({countryId: face.countryId, parentKey: face.parent.feature.properties.parentKey,
        memberCount: face.memberCount, contacts: [...face.contacts].map(n => components[n].feature.properties.sourceFeatureId), geometry: face.geometry, area: face.polygon.getArea()}); continue;}
    }
    const identity = [face.countryId, face.parent.feature.properties.coarseTerritoryId, face.source?.feature.properties.sourceId ?? 'canonical-country-p0',
      face.source?.feature.properties.sourceFeatureId ?? (face.decision === 'canonical-country-residual' ? `baseline-residual:${hashCanonical('prompt19-canonical-residual.v1', face.geometry)}` : `baseline-component:${face.detached.componentIndex}`)];
    face.group = canonical(identity);
    const group = groups.get(face.group) ?? {identity, countryId: face.countryId, parent: face.parent.feature, source: face.source,
      decisions: new Set(), boundaries: new Map(), area: 0};
    group.decisions.add(face.decision); group.area += face.polygon.getArea();
    eachSegment(face.geometry, (a, b) => {const key = edgeKey(a, b); if (group.boundaries.has(key)) group.boundaries.delete(key); else group.boundaries.set(key, [a, b]);});
    groups.set(face.group, group);
  }
  const cells = [], invalid = [];
  for (const [key, group] of groups) {
    const geometry = ringsFromSegments([...group.boundaries.values()]);
    for (const coordinates of polygons(geometry)) {
      const part = normalizeGeometry({type: 'Polygon', coordinates});
      const valid = new IsValidOp(reader.read(part)); if (!valid.isValid()) invalid.push({group: key, error: valid.getValidationError()?.getMessage()});
      const localId = `${group.countryId}:cell:${hashCanonical('prompt19-arranged-local-cell.v2', {identity: group.identity, geometry: part})}`;
      cells.push({type: 'Feature', id: localId, properties: {localId, countryId: group.countryId, sourceId: group.identity[2], sourceFeatureId: group.identity[3],
        sourceVersion: group.source?.feature.properties.sourceVersion ?? null, sourceParentId: group.source?.feature.properties.sourceParentId ?? null,
        name: group.source?.feature.properties.name ?? group.parent.properties.name, boundaryBasis: group.source ? 'administrative' : group.decisions.has('canonical-country-residual') ? 'canonical-country-residual' : 'canonical-country-component',
        unresolvedFineSourceAssignment: !group.source, fineSourceIdentity: group.source ? {sourceId: group.identity[2], sourceFeatureId: group.identity[3]} : null,
        adminLevel: group.source?.feature.properties.adminLevel ?? null, coarseParentTerritoryId: group.parent.properties.coarseTerritoryId,
        administrativeParentKey: group.parent.properties.parentKey, arrangementGroup: key, decisions: [...group.decisions]}, geometry: part});
    }
  }
  cells.sort((a, b) => compareText(a.id, b.id));
  const sourceTrace = components.map(c => ({countryId: c.countryId, sourceFeatureId: c.feature.properties.sourceFeatureId, componentIndex: c.componentIndex,
    represented: final.allFaces.some(f => f.source === c && f.decision === 'actual-source-membership'),
    disposition: final.allFaces.some(f => f.source === c && f.decision === 'actual-source-membership') ? 'represented-inside-fixed-envelope' : 'source-outside-fixed-envelope'}));
  const summary = datasets.map(d => ({countryId: d.countryId, sourceFeatures: d.features.length, cells: cells.filter(c => c.properties.countryId === d.countryId).length,
    envelopeArea: geometryMetadata(d.envelope.geometry).area, arrangedFaceArea: final.allFaces.filter(f => !f.neighbor && f.countryId === d.countryId).reduce((n, f) => n + f.polygon.getArea(), 0),
    unresolvedArea: unresolved.filter(f => f.countryId === d.countryId).reduce((n, f) => n + f.area, 0),
    coarseResidualCells: cells.filter(c => c.properties.countryId === d.countryId && c.properties.unresolvedFineSourceAssignment).length,
    coarseResidualArea: final.allFaces.filter(f => f.countryId === d.countryId && !f.neighbor && !f.source).reduce((n, f) => n + f.polygon.getArea(), 0)}));
  return {cells, unresolved, invalid, sourceTrace, summary, faces: final.allFaces, segments: final.common.segments,
    evidence: {mode: 'exact-joint-arrangement-v2', strictSourceMembership, sourceVerticesMoved: 0, baselineVerticesMoved: 0, gridGenerated: false, failures: final.failures,
      extensions: extensions.map(({residual, ...e}) => {void residual; return e;}), changes: final.changes,
      canonicalResiduals: final.allFaces.filter(f => !f.neighbor && !f.source && f.group).map(f => ({countryId: f.countryId,
        coarseParentTerritoryId: f.parent.feature.properties.coarseTerritoryId, memberCount: f.memberCount,
        geometryHash: hashCanonical('prompt19-canonical-residual.v1', f.geometry), area: f.polygon.getArea(),
        contacts: [...f.contacts].map(n => components[n].feature.properties.sourceFeatureId), geometry: f.geometry, decision: f.decision})),
      detachedPolicy: 'Fixed P0 land with zero original source membership is retained with explicit coarse provenance; fine assignment remains incomplete. No invented ADM identity or extrapolated administrative line.'}};
}
