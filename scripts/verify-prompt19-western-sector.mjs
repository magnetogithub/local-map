// Independent, bounded western gameplay-partition proof. Frozen prior verifiers are reused unchanged.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import {canonical, geometryMetadata, polygons, signedArea, jsonBytes} from './prompt14-catalog-core.mjs';
import {verifyNationalBoundaries} from './verify-prompt19-national-boundaries.mjs';
import {verifyBoundaryCleanup, sharedLength} from './verify-prompt19-boundary-cleanup.mjs';

const read = file => JSON.parse(fs.readFileSync(file));
const option = (name, fallback) => {const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1];};
const artifact = file => {const bytes = fs.readFileSync(file); return {path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};};
const family = f => f?.properties.fineSourceIdentity ? canonical([f.properties.countryId, f.properties.fineSourceIdentity]) : null;
const area = value => value.reduce((sum, polygon) => sum + Math.abs(signedArea(polygon[0])) - polygon.slice(1).reduce((n, ring) => n + Math.abs(signedArea(ring)), 0), 0);
const grid = coordinates => coordinates.map(polygon => polygon.map(ring => ring.map(p => p.map(v => Math.round(v * 1e12) / 1e12))));
const rad = Math.PI / 180;
const lengthKm = coordinates => coordinates.slice(1).reduce((n, p, i) => {const a = coordinates[i], h = Math.sin((p[1] - a[1]) * rad / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(p[1] * rad) * Math.sin((p[0] - a[0]) * rad / 2) ** 2; return n + 12742.0176 * Math.asin(Math.min(1, Math.sqrt(h)));}, 0);
const ringAreaKm2 = ring => Math.abs(ring.slice(1).reduce((n, p, i) => {const a = ring[i]; return n + (p[0] - a[0]) * rad * (2 + Math.sin(a[1] * rad) + Math.sin(p[1] * rad));}, 0) * 6371.0088 ** 2 / 2);
const areaKm2 = g => polygons(g).reduce((n, p) => n + ringAreaKm2(p[0]) - p.slice(1).reduce((v, r) => v + ringAreaKm2(r), 0), 0);
const bboxIntersects = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
const ringLines = g => polygons(g).flatMap(p => p.map(coordinates => ({geometry: {type: 'LineString', coordinates}})));
const segments = edges => edges.flatMap(e => e.geometry.coordinates.slice(1).map((p, i) => [e.geometry.coordinates[i], p]));
const pointSegment = (p, a, b) => {const dx = b[0] - a[0], dy = b[1] - a[1], square = dx * dx + dy * dy, t = square ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / square : 0; return {parameter: t, distance: Math.hypot(p[0] - a[0] - Math.max(0, Math.min(1, t)) * dx, p[1] - a[1] - Math.max(0, Math.min(1, t)) * dy)};};

export function westernComponent(baseline) {
  const records = new Map(baseline.records.map(r => [r.id, r])), features = new Map(baseline.features.map(f => [f.id, f]));
  const residual = id => features.get(id)?.properties.countryId === 'KOR' && !family(features.get(id));
  const byCell = new Map(), starts = new Set();
  for (const e of baseline.edges) {
    for (const id of [e.leftTerritoryId, e.rightTerritoryId]) {const list = byCell.get(id) ?? []; list.push(e); byCell.set(id, list);}
    if (e.rightTerritoryId && [records.get(e.leftTerritoryId).countryId, records.get(e.rightTerritoryId).countryId].sort().join('|') === 'KOR|PRK') for (const id of [e.leftTerritoryId, e.rightTerritoryId]) if (residual(id)) starts.add(id);
  }
  const ids = new Set(starts), queue = [...starts];
  for (let i = 0; i < queue.length; i++) for (const e of byCell.get(queue[i])) {
    const other = e.leftTerritoryId === queue[i] ? e.rightTerritoryId : e.leftTerritoryId;
    if (other && residual(other) && lengthKm(e.geometry.coordinates) > 0 && !ids.has(other)) {ids.add(other); queue.push(other);}
  }
  const contacts = new Map(), international = new Map(), componentFeatures = [...ids].map(id => features.get(id));
  let coastKm = 0, internalKm = 0;
  for (const e of baseline.edges) {
    const left = ids.has(e.leftTerritoryId), right = ids.has(e.rightTerritoryId); if (!left && !right) continue;
    const km = lengthKm(e.geometry.coordinates); if (left && right) {internalKm += km; continue;}
    const other = left ? e.rightTerritoryId : e.leftTerritoryId;
    if (!other) {coastKm += km; continue;}
    const f = features.get(other), key = family(f);
    if (f.properties.countryId !== 'KOR') {international.set(f.properties.countryId, (international.get(f.properties.countryId) ?? 0) + km); continue;}
    const value = contacts.get(key) ?? {family: key, name: f.properties.name, fineSourceIdentity: f.properties.fineSourceIdentity, sourceParentId: f.properties.sourceParentId, contactKm: 0, edgeIds: [], cellIds: []};
    value.contactKm += km; value.edgeIds.push(e.id); value.cellIds.push(other); contacts.set(key, value);
  }
  const union = componentFeatures.length ? polygonClipping.union(...componentFeatures.map(f => grid(polygons(f.geometry)))) : [];
  return {features: componentFeatures, geometry: {type: 'MultiPolygon', coordinates: union}, starts: [...starts], ids: [...ids], contacts: [...contacts.values()].map(v => ({...v, cellIds: [...new Set(v.cellIds)]})), internationalBoundaryKm: Object.fromEntries(international), coastKm, internalResidualLineKm: internalKm};
}

export function verifyWesternSector({baseline, after}) {
  const failures = [], fail = (condition, message, details = {}) => {if (!condition) failures.push({message, ...details});};
  const component = westernComponent(baseline), allowed = new Set(component.contacts.map(v => v.family)), metadata = geometryMetadata(component.geometry);
  fail(component.features.length === 2 && component.starts.length === 1 && component.contacts.length === 2 && component.contacts.every(v => v.family && v.contactKm > 0), 'Western frozen component or positive-contact source-family witnesses changed');
  fail(component.contacts.every(v => v.sourceParentId === 'KOR:macro:citypopulation:31') && component.coastKm === 0 && Object.keys(component.internationalBoundaryKm).join('|') === 'PRK', 'Western component crossed country/coast or verified macro scope');
  const shapes = after.features.filter(f => f.properties.countryId === 'KOR').map(f => ({...f, ...geometryMetadata(f.geometry)}));
  const coveredByFamily = new Map(), residualFragments = [], wrongFamilies = [];
  for (const f of shapes) {
    if (!bboxIntersects(metadata.bbox, f.bbox)) continue;
    const intersection = polygonClipping.intersection(grid(polygons(f.geometry)), grid(polygons(component.geometry))), value = area(intersection);
    if (value <= 1e-10) continue;
    const key = family(f);
    if (!key) residualFragments.push({id: f.id, areaDegreesSquared: value});
    else if (!allowed.has(key)) wrongFamilies.push({id: f.id, fineSourceIdentity: f.properties.fineSourceIdentity, areaDegreesSquared: value});
    else {const previous = coveredByFamily.get(key) ?? {family: key, name: f.properties.name, fineSourceIdentity: f.properties.fineSourceIdentity, areaDegreesSquared: 0, cells: []}; previous.areaDegreesSquared += value; previous.cells.push(f.id); coveredByFamily.set(key, previous);}
  }
  const assignedArea = [...coveredByFamily.values()].reduce((n, r) => n + r.areaDegreesSquared, 0), remainingResidualArea = residualFragments.reduce((n, r) => n + r.areaDegreesSquared, 0), wrongFamilyArea = wrongFamilies.reduce((n, r) => n + r.areaDegreesSquared, 0);
  fail(remainingResidualArea <= 1e-10 && wrongFamilyArea <= 1e-10 && Math.abs(assignedArea - metadata.area) <= 1e-10, 'Western source-free component is not completely assigned to the two positively contacting families', {remainingResidualArea, wrongFamilyArea, coverageError: assignedArea - metadata.area});
  const records = new Map(after.records.map(r => [r.id, r])), features = new Map(after.features.map(f => [f.id, f]));
  let totalDmzKm = 0, bothFineDmzKm = 0, residualDmzKm = 0;
  for (const e of after.edges) if (e.rightTerritoryId && [records.get(e.leftTerritoryId)?.countryId, records.get(e.rightTerritoryId)?.countryId].sort().join('|') === 'KOR|PRK') {
    const km = lengthKm(e.geometry.coordinates); totalDmzKm += km;
    if (family(features.get(e.leftTerritoryId)) && family(features.get(e.rightTerritoryId))) bothFineDmzKm += km; else residualDmzKm += km;
  }
  fail(totalDmzKm > 0 && residualDmzKm === 0 && Math.abs(totalDmzKm - bothFineDmzKm) < 1e-9, 'Shared Korea seam is not fine on both sides everywhere', {totalDmzKm, bothFineDmzKm, residualDmzKm});
  return {pass: failures.length === 0, component: {ids: component.ids, starts: component.starts, ...metadata, areaKm2: component.features.reduce((n, f) => n + areaKm2(f.geometry), 0), memberAreasKm2: component.features.map(f => ({id: f.id, areaKm2: areaKm2(f.geometry)})), contacts: component.contacts, internationalBoundaryKm: component.internationalBoundaryKm, coastKm: component.coastKm, internalResidualLineKm: component.internalResidualLineKm}, allocation: [...coveredByFamily.values()], remainingResidualAreaDegreesSquared: remainingResidualArea, wrongFamilyAreaDegreesSquared: wrongFamilyArea, assignedAreaDegreesSquared: assignedArea, coverageErrorDegreesSquared: assignedArea - metadata.area, residualFragments, wrongFamilies, sharedKoreaSeam: {totalKm: totalDmzKm, bothFineKm: bothFineDmzKm, residualKm: residualDmzKm, bothFineFraction: totalDmzKm ? bothFineDmzKm / totalDmzKm : null}, failures};
}

export function verifyWesternIsolation({baseline, after, beforePath, afterPath, beforeArtifact, afterArtifact}) {
  const component = westernComponent(baseline), expected = grid(polygons(component.geometry)), clippedChanges = [];
  for (const change of after.report.nationalBoundaryReconciliation?.changes ?? []) {
    if (!change.assignedPartGeometry || !bboxIntersects(geometryMetadata(change.assignedPartGeometry).bbox, geometryMetadata(component.geometry).bbox)) continue;
    const intersection = polygonClipping.intersection(grid(polygons(change.assignedPartGeometry)), expected);
    if (area(intersection) <= 1e-10) continue;
    clippedChanges.push({...change, assignedPartGeometry: {type: 'MultiPolygon', coordinates: intersection}, assignedPartArea: area(intersection)});
  }
  const projected = {...after, report: {...after.report, nationalBoundaryReconciliation: {...after.report.nationalBoundaryReconciliation, changes: clippedChanges}}};
  const proof = verifyNationalBoundaries({before: baseline, after: projected, beforePath, afterPath, beforeArtifact, afterArtifact});
  return {...proof, proofPurpose: 'Preserve all previous gameplay fine geometry and allow only gains inside the independently discovered western residual component. Assignment witnesses are clipped to that component before comparing the prior cleanup partition to the new output.', componentClippedAssignmentClaims: clippedChanges.length};
}

export function verifyWesternContactEvidence({baseline, after, original}) {
  const failures = [], fail = (condition, message, data = {}) => {if (!condition) failures.push({message, ...data});};
  const e = after.report.westernSectorReconciliation;
  if (!e) return {pass: false, failures: [{message: 'Western gameplay provenance is missing'}]};
  fail(e.method === 'gameplay-contact-partition' && e.administrativeTruthClaim === false && e.geometryAdjusted === true && e.rawSourceArtifactGeometryUnmodified === true, 'Western geometry is not explicitly identified as a gameplay adjustment');
  const component = westernComponent(baseline), expectedContacts = new Map(component.contacts.map(c => [c.family, c])), expectedIds = new Set(component.ids), baselineEdges = new Map(baseline.edges.map(v => [v.id, v]));
  const inputResiduals = new Map((e.inputResiduals ?? []).map(v => [v.id, v]));
  fail(inputResiduals.size === expectedIds.size && component.features.every(f => inputResiduals.has(f.id) && canonical(inputResiduals.get(f.id).geometry) === canonical(f.geometry)), 'Declared input residual geometry differs from the independently discovered component');
  const declaredSeeds = new Map();
  for (const contact of e.contacts ?? []) {
    const key = canonical(['KOR', contact.fineSourceIdentity]), expected = expectedContacts.get(key);
    fail(!!expected && contact.sourceParentId === expected?.sourceParentId, 'Contact witness changed receiving family or macro', {fineSourceIdentity: contact.fineSourceIdentity});
    for (const edge of contact.edges ?? []) {
      const actual = baselineEdges.get(edge.id);
      fail(!!actual && expected?.edgeIds.includes(edge.id) && canonical(edge.geometry) === canonical(actual?.geometry) && lengthKm(edge.geometry.coordinates) > 0, 'Contact seed is not the actual positive-length baseline edge', {edgeId: edge.id});
      declaredSeeds.set(edge.id, {edge: actual, family: key});
    }
  }
  const expectedSeedIds = component.contacts.flatMap(c => c.edgeIds);
  fail(declaredSeeds.size === expectedSeedIds.length && expectedSeedIds.every(id => declaredSeeds.has(id)), 'Positive-contact seed edge set is incomplete or enlarged');
  const sampling = e.sampling ?? {}, origin = sampling.origin, xScale = sampling.xScaleKmPerDegree, yScale = sampling.yScaleKmPerDegree;
  if (!Array.isArray(origin) || origin.length !== 2 || !(xScale > 0) || !(yScale > 0) || !Array.isArray(sampling.sites)) return {pass: false, failures: [...failures, {message: 'Contact sampling projection or sites are missing'}]};
  const box = geometryMetadata(component.geometry).bbox, midpoint = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  fail(Math.abs(origin[0] - midpoint[0]) < 1e-12 && Math.abs(origin[1] - midpoint[1]) < 1e-12 && Math.abs(xScale - 111.195 * Math.cos(midpoint[1] * rad)) < 1e-10 && yScale === 111.195, 'Contact sampling projection does not use the audited local component');
  fail(sampling.continuousSegmentVoronoi === false && sampling.boundaryPositionDisplacementBoundClaimed === false && sampling.maximumContactSamplingSpacingKm <= 0.25, 'Sampling approximation or distance-error meaning is misstated');
  const project = p => [(p[0] - origin[0]) * xScale, (p[1] - origin[1]) * yScale];
  let maxSiteDistance = 0, siteErrors = 0;
  for (const site of sampling.sites) {
    for (const key of site.families) {
      const edges = site.contactEdgeIds.map(id => declaredSeeds.get(id)).filter(v => v?.family === key);
      const closest = edges.length ? Math.min(...edges.flatMap(v => segments([v.edge])).map(([a, b]) => pointSegment(site.pointKm, project(a), project(b)).distance)) : Infinity;
      maxSiteDistance = Math.max(maxSiteDistance, closest);
      if (!expectedContacts.has(key) || closest > 1e-8) siteErrors++;
    }
    for (const id of site.contactEdgeIds) if (!declaredSeeds.has(id) || !site.families.includes(declaredSeeds.get(id).family)) siteErrors++;
  }
  fail(siteErrors === 0, 'A Voronoi seed is not on its declared actual fine contact boundary', {siteErrors, maxSiteDistance});
  let maxGap = 0, segmentErrors = 0;
  for (const {edge} of declaredSeeds.values()) for (const [a0, b0] of segments([edge])) {
    const a = project(a0), b = project(b0), distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const values = sampling.sites.filter(s => s.contactEdgeIds.includes(edge.id)).map(s => pointSegment(s.pointKm, a, b)).filter(v => v.distance <= 1e-8 && v.parameter >= -1e-9 && v.parameter <= 1 + 1e-9).map(v => Math.max(0, Math.min(1, v.parameter))).sort((x, y) => x - y);
    if (!values.length || values[0] > 1e-9 || values.at(-1) < 1 - 1e-9) segmentErrors++;
    for (let i = 1; i < values.length; i++) maxGap = Math.max(maxGap, distance * (values[i] - values[i - 1]));
  }
  fail(segmentErrors === 0 && maxGap <= 0.250000001 && Math.abs(maxGap / 2 - sampling.maximumContactDistanceOverestimateKm) <= 1e-8 && Math.abs(maxGap / 2 - sampling.maximumNearestContactDistanceRegretKm) <= 1e-8, 'Sample spacing/distance-regret certificate is not reproduced from actual seed lines', {segmentErrors, maxGap});
  const receivingParts = [], whole = grid(polygons(component.geometry));
  let maxAssignedSiteRegret = 0, nearestSiteErrors = 0;
  for (const f of after.features.filter(f => expectedContacts.has(family(f)))) {
    const key = family(f), assigned = polygonClipping.intersection(grid(polygons(f.geometry)), whole);
    for (const coordinates of assigned) {
      if (area([coordinates]) <= 1e-10) continue;
      const g = {type: 'Polygon', coordinates}, witness = expectedContacts.get(key), ownSeeds = witness.edgeIds.map(id => baselineEdges.get(id));
      const positiveContactKm = sharedLength(ringLines(g), segments(ownSeeds));
      const oldFamily = original.features.filter(v => family(v) === key), originalContactKm = sharedLength(ringLines(g), oldFamily.flatMap(v => segments(ringLines(v.geometry))));
      fail(positiveContactKm > 0.001 && originalContactKm > 0.001, 'An assigned connected part has no positive-length connection to its receiving original fine family', {cellId: f.id, positiveContactKm, originalContactKm});
      const points = coordinates.flatMap(ring => ring.flatMap((p, i) => i ? [p, [(p[0] + ring[i - 1][0]) / 2, (p[1] + ring[i - 1][1]) / 2]] : [p]));
      for (const p of points) {
        const q = project(p), distances = sampling.sites.map(s => ({distance: Math.hypot(q[0] - s.pointKm[0], q[1] - s.pointKm[1]), families: s.families}));
        const nearest = Math.min(...distances.map(v => v.distance)), receiving = Math.min(...distances.filter(v => v.families.includes(key)).map(v => v.distance)), regret = receiving - nearest;
        maxAssignedSiteRegret = Math.max(maxAssignedSiteRegret, regret); if (regret > 1e-7) nearestSiteErrors++;
      }
      receivingParts.push({cellId: f.id, fineSourceIdentity: f.properties.fineSourceIdentity, assignedAreaDegreesSquared: area([coordinates]), positiveBaselineFineContactKm: positiveContactKm, positiveOriginalFineContactKm: originalContactKm, boundarySamples: points.length});
    }
  }
  fail(receivingParts.length >= 2 && nearestSiteErrors === 0, 'Assigned western geometry violates its receiving nearest-contact-site label', {receivingParts: receivingParts.length, nearestSiteErrors, maxAssignedSiteRegret});
  for (const c of e.changes ?? []) fail(c.method === 'gameplay-contact-partition' && c.administrativeTruthClaim === false && c.geometryAdjusted === true && expectedContacts.has(canonical(['KOR', c.fineSourceIdentity])) && c.inputResidualIds?.length === expectedIds.size && c.inputResidualIds.every(id => expectedIds.has(id)), 'Western assignment provenance crosses its explicit gameplay scope');
  return {pass: failures.length === 0, method: e.method, administrativeTruthClaim: e.administrativeTruthClaim, positiveContactEdges: declaredSeeds.size, sampledSites: sampling.sites.length, maxSiteDistanceToClaimedContactKm: maxSiteDistance, reproducedMaximumSampleSpacingKm: maxGap, reproducedNearestContactDistanceRegretBoundKm: maxGap / 2, boundaryPositionDisplacementBoundClaimed: sampling.boundaryPositionDisplacementBoundClaimed, receivingParts, maximumAssignedNearestSiteRegretKm: maxAssignedSiteRegret, failures};
}

export async function verifyWesternReplay({baselinePath, cellsPath, after, afterPath, afterCellsPath}) {
  const helperPath = 'scripts/prompt19-western-sector-reconciliation.mjs', helperBefore = artifact(helperPath), bundlePin = artifact(baselinePath), cellsPin = artifact(cellsPath), failures = [];
  const {reconcileWesternSector} = await import('./prompt19-western-sector-reconciliation.mjs');
  const replay = reconcileWesternSector({bundle: read(baselinePath), cells: read(cellsPath).features});
  if (after.report.westernSectorInput) replay.bundle.report.westernSectorInput = after.report.westernSectorInput;
  const hash = value => crypto.createHash('sha256').update(jsonBytes(value)).digest('hex');
  const replayBundleHash = hash(replay.bundle), outputBundleCanonicalHash = hash(after), bundleMatches = replayBundleHash === outputBundleCanonicalHash;
  if (!bundleMatches) failures.push({message: 'Western helper replay does not reproduce the complete output bundle'});
  const cells = {type: 'FeatureCollection', features: replay.cells}, replayCellsHash = hash(cells), afterCells = read(afterCellsPath), cellsMatch = replayCellsHash === hash(afterCells);
  if (!cellsMatch) failures.push({message: 'Western helper replay does not reproduce the complete output local cells'});
  const sourcePins = after.report.westernSectorInput;
  if (sourcePins && (sourcePins.bundle.sha256 !== bundlePin.sha256 || sourcePins.bundle.byteLength !== bundlePin.byteLength || sourcePins.cells.sha256 !== cellsPin.sha256 || sourcePins.cells.byteLength !== cellsPin.byteLength)) failures.push({message: 'Western replay input pins differ from declared provenance'});
  const helperAfter = artifact(helperPath); if (helperAfter.sha256 !== helperBefore.sha256) failures.push({message: 'Western helper changed during replay'});
  return {pass: failures.length === 0, helper: helperBefore, inputs: {bundle: bundlePin, cells: cellsPin}, output: artifact(afterPath), outputCells: artifact(afterCellsPath), replayBundleCanonicalSha256: replayBundleHash, replayCellsCanonicalSha256: replayCellsHash, fullBundleMatch: bundleMatches, fullLocalCellsMatch: cellsMatch, failures};
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const beforePath = option('--before', 'reports/maintenance/prompt19-C/fine-macro-2020-joined-world-input.json');
  const afterPath = option('--input', 'reports/maintenance/prompt19-C/western-sector-2020-joined-world-input.json');
  const westernBaselinePath = option('--western-baseline', 'reports/maintenance/prompt19-C/boundary-cleanup-2020-joined-world-input.json');
  const cleanupBaselinePath = option('--cleanup-baseline', 'reports/maintenance/prompt19-C/national-boundary-2020-joined-world-input.json');
  const baselineCellsPath = option('--baseline-cells', 'reports/maintenance/prompt19-C/boundary-cleanup-2020-joint-arrangement-cells.geojson');
  const afterCellsPath = option('--cells', 'reports/maintenance/prompt19-C/western-sector-2020-joint-arrangement-cells.geojson');
  const output = option('--output', 'reports/maintenance/20261030-western-sector-independent-verification.json');
  const before = read(beforePath), after = read(afterPath), baseline = read(westernBaselinePath);
  const basic = verifyNationalBoundaries({before, after, beforePath, afterPath, beforeArtifact: artifact(beforePath), afterArtifact: artifact(afterPath)});
  const cleanupAcceptance = verifyBoundaryCleanup({baseline: read(cleanupBaselinePath), after, original: before});
  const westernAcceptance = verifyWesternSector({baseline, after});
  const westernIsolation = verifyWesternIsolation({baseline, after, beforePath: westernBaselinePath, afterPath, beforeArtifact: artifact(westernBaselinePath), afterArtifact: artifact(afterPath)});
  const westernContactEvidence = verifyWesternContactEvidence({baseline, after, original: before});
  const reproducibility = await verifyWesternReplay({baselinePath: westernBaselinePath, cellsPath: baselineCellsPath, after, afterPath, afterCellsPath});
  const failures = [...basic.failures, ...cleanupAcceptance.failures.map(f => ({...f, scope: 'cleanupAcceptance'})), ...westernAcceptance.failures.map(f => ({...f, scope: 'westernAcceptance'})), ...westernIsolation.failures.map(f => ({...f, scope: 'westernIsolation'})), ...westernContactEvidence.failures.map(f => ({...f, scope: 'westernContactEvidence'})), ...reproducibility.failures.map(f => ({...f, scope: 'reproducibility'}))];
  const result = {...basic, pass: failures.length === 0, baseGeometryProofPass: basic.pass, westernBaseline: artifact(westernBaselinePath), cleanupBaseline: artifact(cleanupBaselinePath), cleanupAcceptance, westernAcceptance, westernIsolation, westernContactEvidence, reproducibility, failures};
  fs.mkdirSync(path.dirname(output), {recursive: true}); fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({pass: result.pass, after: result.after, topology: result.topology, cleanupAcceptance: cleanupAcceptance.pass, westernAcceptance: {...westernAcceptance, component: {ids: westernAcceptance.component.ids, areaKm2: westernAcceptance.component.areaKm2, bbox: westernAcceptance.component.bbox, contacts: westernAcceptance.component.contacts.map(v => ({name: v.name, contactKm: v.contactKm}))}}, failures}));
  if (!result.pass) process.exitCode = 2;
}
