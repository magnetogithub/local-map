// Additional visual-artifact regression audit layered on the frozen national proof.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import {canonical, geometryMetadata, polygons, signedArea} from './prompt14-catalog-core.mjs';
import {verifyNationalBoundaries} from './verify-prompt19-national-boundaries.mjs';

const read = file => JSON.parse(fs.readFileSync(file));
const option = (name, fallback) => {const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1];};
const artifact = file => {const bytes = fs.readFileSync(file); return {path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};};
const selected = c => c === 'KOR' || c === 'PRK';
const family = f => f?.properties.fineSourceIdentity ? canonical([f.properties.countryId, f.properties.fineSourceIdentity]) : null;
const pointKey = p => `${p[0]},${p[1]}`;
const segmentKey = (a, b) => {const x = pointKey(a), y = pointKey(b); return x < y ? `${x};${y}` : `${y};${x}`;};
const rad = Math.PI / 180, projection = [111.195 * Math.cos(38 * rad), 111.195];
const project = p => [p[0] * projection[0], p[1] * projection[1]];
const distanceKm = (a, b) => {const h = Math.sin((b[1] - a[1]) * rad / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2; return 12742.0176 * Math.asin(Math.min(1, Math.sqrt(h)));};
const lineLength = coordinates => coordinates.slice(1).reduce((s, p, i) => s + distanceKm(coordinates[i], p), 0);
const ringAreaKm2 = r => Math.abs(r.slice(1).reduce((s, b, i) => {const a = r[i]; return s + (b[0] - a[0]) * rad * (2 + Math.sin(a[1] * rad) + Math.sin(b[1] * rad));}, 0) * 6371.0088 ** 2 / 2);
const areaKm2 = g => polygons(g).reduce((n, p) => n + ringAreaKm2(p[0]) - p.slice(1).reduce((s, r) => s + ringAreaKm2(r), 0), 0);
const area = value => value.reduce((sum, polygon) => sum + Math.abs(signedArea(polygon[0])) - polygon.slice(1).reduce((n, ring) => n + Math.abs(signedArea(ring)), 0), 0);
const grid = coordinates => coordinates.map(polygon => polygon.map(ring => ring.map(p => p.map(v => Math.round(v * 1e12) / 1e12))));
const bboxIntersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const lineSegments = edges => edges.flatMap(e => e.geometry.coordinates.slice(1).map((p, i) => [e.geometry.coordinates[i], p]));
const pointSegment = (p, a, b) => {const dx = b[0] - a[0], dy = b[1] - a[1], d = dx * dx + dy * dy, t = d ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / d)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);};
const minimumLineDistanceKm = (g, segments) => {
  let best = Infinity;
  const projected = segments.map(([a, b]) => [project(a), project(b)]);
  for (const p of polygons(g).flat(2)) {const q = project(p); for (const [a, b] of projected) best = Math.min(best, pointSegment(q, a, b));}
  return best;
};
export const sharedLength = (edges, previousSegments) => {
  let total = 0;
  for (const [a, b] of lineSegments(edges)) {
    const dx = b[0] - a[0], dy = b[1] - a[1], squared = dx * dx + dy * dy;
    if (!squared) continue;
    const ranges = [];
    for (const [c, d] of previousSegments) {
      if (Math.max(c[0], d[0]) < Math.min(a[0], b[0]) - 1e-10 || Math.min(c[0], d[0]) > Math.max(a[0], b[0]) + 1e-10 || Math.max(c[1], d[1]) < Math.min(a[1], b[1]) - 1e-10 || Math.min(c[1], d[1]) > Math.max(a[1], b[1]) + 1e-10) continue;
      const parameter = p => ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / squared;
      const first = parameter(c), last = parameter(d), from = Math.max(0, Math.min(first, last)), to = Math.min(1, Math.max(first, last));
      if (to <= from) continue;
      const ex = d[0] - c[0], ey = d[1] - c[1], length = Math.hypot(ex, ey);
      const perpendicular = t => Math.abs((a[0] + t * dx - c[0]) * ey - (a[1] + t * dy - c[1]) * ex) / length;
      if (length && perpendicular(from) <= 1e-10 && perpendicular(to) <= 1e-10) ranges.push([from, to]);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    let covered = 0, end = 0;
    for (const [from, to] of ranges) {covered += Math.max(0, to - Math.max(end, from)); end = Math.max(end, to);}
    total += distanceKm(a, b) * covered;
  }
  return total;
};

export function verifyBoundaryCleanup({baseline, after, original}) {
  const failures = [], fail = (condition, message, extra = {}) => {if (!condition) failures.push({message, ...extra});};
  const oldRecords = new Map(baseline.records.map(r => [r.id, r])), afterRecords = new Map(after.records.map(r => [r.id, r]));
  const oldFeatures = new Map(baseline.features.map(f => [f.id, f]));
  const newFeatures = new Map(after.features.map(f => [f.id, f]));
  const originalFeatures = new Map(original.features.map(f => [f.id, f]));
  const originalFinePairEdges = new Map();
  const pairKey = (left, right) => [left, right].sort().join('|');
  for (const e of original.edges) {
    const left = family(originalFeatures.get(e.leftTerritoryId)), right = family(originalFeatures.get(e.rightTerritoryId));
    if (!left || !right || left === right || originalFeatures.get(e.leftTerritoryId).properties.countryId !== originalFeatures.get(e.rightTerritoryId).properties.countryId) continue;
    const key = pairKey(left, right), list = originalFinePairEdges.get(key) ?? []; list.push(e); originalFinePairEdges.set(key, list);
  }
  const afterCoastVertices = new Map();
  for (const e of after.edges.filter(e => !e.rightTerritoryId)) for (const p of e.geometry.coordinates) {
    const key = pointKey(p), list = afterCoastVertices.get(key) ?? []; list.push(e.id); afterCoastVertices.set(key, list);
  }
  const afterFeatures = after.features.filter(f => selected(f.properties.countryId)).map(f => ({...f, ...geometryMetadata(f.geometry)}));
  const afterResidual = afterFeatures.filter(f => !family(f)), afterByFamily = new Map();
  for (const f of afterFeatures.filter(family)) {const key = family(f), list = afterByFamily.get(key) ?? []; list.push(f); afterByFamily.set(key, list);}
  const countryEdges = baseline.edges.filter(e => [oldRecords.get(e.leftTerritoryId)?.countryId, oldRecords.get(e.rightTerritoryId)?.countryId].sort().join('|') === 'KOR|PRK');
  const nationalSegments = lineSegments(countryEdges), oldByCell = new Map();
  for (const e of baseline.edges) for (const id of [e.leftTerritoryId, e.rightTerritoryId]) {if (!oldByCell.has(id)) oldByCell.set(id, []); oldByCell.get(id).push(e);}
  const afterInternal = after.edges.filter(e => e.rightTerritoryId && selected(afterRecords.get(e.leftTerritoryId)?.countryId) && afterRecords.get(e.leftTerritoryId).countryId === afterRecords.get(e.rightTerritoryId)?.countryId);
  const afterResidualInternal = afterInternal.filter(e => !family(newFeatures.get(e.leftTerritoryId)) || !family(newFeatures.get(e.rightTerritoryId)));
  const afterSameFamilyInternal = afterInternal.filter(e => family(newFeatures.get(e.leftTerritoryId)) && family(newFeatures.get(e.leftTerritoryId)) === family(newFeatures.get(e.rightTerritoryId)));
  const candidates = [];
  for (const f of baseline.features.filter(f => selected(f.properties.countryId) && !family(f))) {
    const m = geometryMetadata(f.geometry), own = oldByCell.get(f.id), contactFamilies = new Set(), areaValue = areaKm2(f.geometry);
    if (areaValue > 3 || m.bbox[3] < 37.5 || m.bbox[1] > 38.9) continue;
    let exterior = false, unresolvedNeighbor = false;
    for (const e of own) {
      const other = oldFeatures.get(e.leftTerritoryId === f.id ? e.rightTerritoryId : e.leftTerritoryId);
      if (!other || other.properties.countryId !== f.properties.countryId) {exterior = true; continue;}
      const key = family(other); if (!key) unresolvedNeighbor = true; else contactFamilies.add(key);
    }
    if (exterior || unresolvedNeighbor || contactFamilies.size !== 1) continue;
    const minimumNationalDistanceKm = minimumLineDistanceKm(f.geometry, nationalSegments);
    if (minimumNationalDistanceKm > 5) continue;
    candidates.push({feature: f, ...m, areaKm2: areaValue, minimumNationalDistanceKm, sourceFamily: [...contactFamilies][0], perimeterKm: own.reduce((n, e) => n + lineLength(e.geometry.coordinates), 0)});
  }
  fail(candidates.length === 8, 'Frozen national baseline no longer identifies the eight reported DMZ loops', {loops: candidates.length});
  const remainingResidualArea = target => afterResidual.filter(f => f.properties.countryId === target.properties.countryId && bboxIntersects(geometryMetadata(target.geometry).bbox, f.bbox)).reduce((n, f) => n + area(polygonClipping.intersection(grid(polygons(target.geometry)), grid(polygons(f.geometry)))), 0);
  const loopReports = candidates.map(({feature, sourceFamily, ...metadata}) => {
    const members = afterByFamily.get(sourceFamily) ?? [], covered = members.length ? polygonClipping.union(...members.map(f => grid(polygons(f.geometry)))) : [];
    const outsideExpectedFamily = covered.length ? area(polygonClipping.difference(grid(polygons(feature.geometry)), covered)) : geometryMetadata(feature.geometry).area;
    const residualArea = remainingResidualArea(feature), oldLinesStillInternalKm = sharedLength(afterInternal, lineSegments(oldByCell.get(feature.id)));
    fail(outsideExpectedFamily <= 1e-10 && residualArea <= 1e-10 && oldLinesStillInternalKm <= 0.001, 'Reported DMZ loop remains or joined a different fine family', {id: feature.id, outsideExpectedFamily, residualArea, oldLinesStillInternalKm});
    return {id: feature.id, countryId: feature.properties.countryId, ...metadata, sourceFamily, afterFineCells: members.map(f => f.id), outsideExpectedFamilyAreaDegreesSquared: outsideExpectedFamily, remainingResidualAreaDegreesSquared: residualArea, oldLinesStillInternalKm};
  });
  const stripAudit = (id, required) => {
    const f = oldFeatures.get(id);
    if (!f) {fail(false, 'Frozen coastal regression target missing', {id}); return {id, present: false};}
    const own = oldByCell.get(id), internal = own.filter(e => e.rightTerritoryId && oldRecords.get(e.leftTerritoryId).countryId === oldRecords.get(e.rightTerritoryId).countryId), coast = own.filter(e => !e.rightTerritoryId);
    const residualArea = remainingResidualArea(f), oldLinesStillInternalKm = sharedLength(afterInternal, lineSegments(internal));
    const oldLinesStillResidualKm = sharedLength(afterResidualInternal, lineSegments(internal)), oldLinesStillSameFamilyKm = sharedLength(afterSameFamilyInternal, lineSegments(internal));
    const fineJunctions = afterInternal.filter(e => family(newFeatures.get(e.leftTerritoryId)) && family(newFeatures.get(e.rightTerritoryId)) && family(newFeatures.get(e.leftTerritoryId)) !== family(newFeatures.get(e.rightTerritoryId))).map(e => {
      const sharedPreviousLineKm = sharedLength([e], lineSegments(internal));
      if (sharedPreviousLineKm <= 0.000001) return null;
      const left = newFeatures.get(e.leftTerritoryId), right = newFeatures.get(e.rightTerritoryId), pair = pairKey(family(left), family(right));
      const sourceWitnesses = (originalFinePairEdges.get(pair) ?? []).map(w => ({edgeId: w.id, sharedSourceLineKm: sharedLength([e], lineSegments([w]))})).filter(w => w.sharedSourceLineKm > 0.001);
      const endpoints = [e.geometry.coordinates[0], e.geometry.coordinates.at(-1)], closed = pointKey(endpoints[0]) === pointKey(endpoints[1]);
      const coastConnectedEndpoints = endpoints.filter(p => afterCoastVertices.has(pointKey(p))).map(p => ({coordinate: p, coastEdgeIds: [...new Set(afterCoastVertices.get(pointKey(p)))]}));
      const certificate = {leftFineSourceIdentity: left.properties.fineSourceIdentity, rightFineSourceIdentity: right.properties.fineSourceIdentity, originalSharedFinePairEdgeWitnesses: sourceWitnesses, afterSeamEndpoints: endpoints, coastConnectedEndpoints, afterSeamClosed: closed, originalPairToCoastConnected: sourceWitnesses.length > 0 && coastConnectedEndpoints.length > 0 && !closed};
      fail(certificate.originalPairToCoastConnected, 'Retained coastal fine junction lacks an original shared-fine pair and an exact coast endpoint connection', {targetId: id, edgeId: e.id, certificate});
      return {edgeId: e.id, boundaryClass: e.boundaryClass, sharedPreviousLineKm, leftName: left.properties.name, rightName: right.properties.name, certificate};
    }).filter(Boolean);
    const afterResidualCoast = after.edges.filter(e => !e.rightTerritoryId && afterRecords.get(e.leftTerritoryId)?.countryId === f.properties.countryId && !family(newFeatures.get(e.leftTerritoryId)));
    const oldCoastStillResidualKm = sharedLength(afterResidualCoast, lineSegments(coast));
    if (required) fail(residualArea <= 1e-10 && oldCoastStillResidualKm <= 0.001 && oldLinesStillResidualKm <= 0.001 && oldLinesStillSameFamilyKm <= 0.001, 'Reported long east-coast residual/same-family parallel strip remains', {id, residualArea, oldCoastStillResidualKm, oldLinesStillResidualKm, oldLinesStillSameFamilyKm});
    return {id, required, present: true, ...geometryMetadata(f.geometry), areaKm2: areaKm2(f.geometry), previousCoastKm: coast.reduce((n, e) => n + lineLength(e.geometry.coordinates), 0), previousInternalLineKm: internal.reduce((n, e) => n + lineLength(e.geometry.coordinates), 0), remainingResidualAreaDegreesSquared: residualArea, oldCoastStillResidualKm, oldLinesStillInternalKm, oldLinesStillResidualKm, oldLinesStillSameFamilyKm, fineJunctions};
  };
  const eastCoast = stripAudit('territory:catalog:a3d6b442da48bfe6c5ad9474a29b83d75e55cd447d5c60289fef3b00503b41e7', true);
  const secondaryUljinYeongdeok = stripAudit('territory:catalog:9b03db0fbcc86fac9bcbe8baae61b17dcc0c8777f187dd678705abbd2867ead8', true);
  const afterSegmentKeys = new Set(lineSegments(afterInternal).map(([a, b]) => segmentKey(a, b)));
  return {pass: failures.length === 0, targets: {dmzLoops: candidates.length, mainCoastalStrip: 1, uljinYeongdeokStrip: 1}, loops: loopReports, eastCoast, secondaryUljinYeongdeok, afterInternalGraphSegments: afterSegmentKeys.size, failures, limits: ['The eight enclosed loops and coastal strips are explicit regression targets from the frozen prior gameplay partition.', 'Retained short fine junctions must share positive-length linework with the same pair of original fine sources, remain open, and connect to the final coast at an exact graph endpoint.', 'This confirms their control-area seams are removed; it does not certify adjusted outlines as original legal administrative geometry.']};
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const beforePath = option('--before', 'reports/maintenance/prompt19-C/fine-macro-2020-joined-world-input.json');
  const afterPath = option('--input', 'reports/maintenance/prompt19-C/boundary-cleanup-2020-joined-world-input.json');
  const cleanupBaselinePath = option('--cleanup-baseline', 'reports/maintenance/prompt19-C/national-boundary-2020-joined-world-input.json');
  const output = option('--output', 'reports/maintenance/20261030-boundary-cleanup-independent-verification.json');
  const after = read(afterPath), before = read(beforePath), basic = verifyNationalBoundaries({before, after, beforePath, afterPath, beforeArtifact: artifact(beforePath), afterArtifact: artifact(afterPath)});
  const cleanupAcceptance = verifyBoundaryCleanup({baseline: read(cleanupBaselinePath), after, original: before});
  const result = {...basic, pass: basic.pass && cleanupAcceptance.pass, baseGeometryProofPass: basic.pass, cleanupBaseline: artifact(cleanupBaselinePath), cleanupAcceptance, failures: [...basic.failures, ...cleanupAcceptance.failures.map(f => ({...f, scope: 'cleanupAcceptance'}))]};
  fs.mkdirSync(path.dirname(output), {recursive: true}); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  const stripSummary = value => ({id: value.id, required: value.required, remainingResidualAreaDegreesSquared: value.remainingResidualAreaDegreesSquared, oldCoastStillResidualKm: value.oldCoastStillResidualKm, oldLinesStillResidualKm: value.oldLinesStillResidualKm, oldLinesStillSameFamilyKm: value.oldLinesStillSameFamilyKm, certifiedFineJunctions: value.fineJunctions?.map(j => ({leftName: j.leftName, rightName: j.rightName, sharedPreviousLineKm: j.sharedPreviousLineKm, originalPairToCoastConnected: j.certificate.originalPairToCoastConnected}))});
  console.log(JSON.stringify({pass: result.pass, before: result.before, after: result.after, topology: result.topology, cleanupAcceptance: {pass: cleanupAcceptance.pass, targets: cleanupAcceptance.targets, loopSeamsRemainingKm: cleanupAcceptance.loops.reduce((n, r) => n + r.oldLinesStillInternalKm, 0), eastCoast: stripSummary(cleanupAcceptance.eastCoast), uljinYeongdeok: stripSummary(cleanupAcceptance.secondaryUljinYeongdeok)}, failures: result.failures}));
  if (!result.pass) process.exitCode = 2;
}
