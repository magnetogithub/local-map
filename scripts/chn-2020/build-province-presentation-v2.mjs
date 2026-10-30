// Alternative v2: preserve high-coverage raw family presentation across existing game gains.
// Never changes administrative membership, game geometry, or the immutable v1 candidate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const relative = file => file.replaceAll('\\', '/');
const bytes = file => fs.readFileSync(path.resolve(root, file));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const pin = file => {const b = bytes(file); return {path: relative(file), sha256: digest(b), byteLength: b.length};};
const samePin = (a, b) => a.path === b.path && a.sha256 === b.sha256 && a.byteLength === b.byteLength;
const read = file => JSON.parse(bytes(file));
const checked = a => {const b = bytes(a.path); if (digest(b) !== a.sha256 || b.length !== a.byteLength) throw Error(`PIN_CHANGED:${a.path}`); return b;};
const checkedJSON = a => JSON.parse(checked(a));
const fail = message => {throw Error(message);};
const invariant = (ok, message) => {if (!ok) fail(message);};
const arg = (name, fallback) => {const n = process.argv.indexOf(name); return n < 0 ? fallback : process.argv[n + 1] ?? fail(`MISSING_ARGUMENT:${name}`);};

const pointerPath = arg('--pointer', 'data/runtime/operational-catalog/current.json');
const analysisPath = arg('--analysis', 'reports/chn-province-20261030/newdata/active-family-overlap-analysis.json');
const pointerPin = pin(pointerPath), pointer = checkedJSON(pointerPin);
const indexPin = {path: `${pointer.root}/artifact-index.json`, ...pointer.index};
const index = checkedJSON(indexPin), artifacts = new Map(index.artifacts.map(a => [a.path, a]));
invariant(artifacts.size === index.artifacts.length, 'DUPLICATE_INDEX_ARTIFACT');
const catalogArtifact = file => {const a = artifacts.get(file); if (!a) fail(`INDEX_ARTIFACT_MISSING:${file}`); return {...a, path: `${pointer.root}/${file}`};};
const provenance = checkedJSON(catalogArtifact('provenance.json'));
const descriptor = checkedJSON(catalogArtifact('catalog.json'));
invariant(descriptor.catalogRef.catalogVersion === pointer.catalogVersion, 'CATALOG_VERSION_MISMATCH');
const hierarchyPin = provenance.hierarchyArtifacts.find(a => a.countryId === 'CHN');
invariant(Boolean(hierarchyPin), 'NO_CHN_HIERARCHY');
const hierarchyArtifact = Object.fromEntries(['path', 'sha256', 'byteLength'].map(k => [k, hierarchyPin[k]]));
const hierarchy = checkedJSON(hierarchyArtifact);
const geometryPin = provenance.incremental.geometry;
const activeAnalysisPin = pin(analysisPath), analysis = checkedJSON(activeAnalysisPin);
const rawAnalysisPin = pin('reports/chn-province-20261030/newdata/source-overlap-analysis.json');
const rawAnalysis = checkedJSON(rawAnalysisPin);
invariant(rawAnalysis.schemaVersion === 'chn-province-presentation-source-overlap-analysis-v1' &&
  rawAnalysis.mode === 'analysis-only-no-render-assignment' && rawAnalysis.administrativeTruthClaim === false,
  'INVALID_RAW_OVERLAP_ANALYSIS');
for (const a of [...Object.values(rawAnalysis.inputs), ...rawAnalysis.code]) checked(a);
invariant(analysis.schemaVersion === 'chn-active-province-presentation-overlap-analysis-v1' &&
  analysis.mode === 'analysis-only-no-render-assignment' && analysis.administrativeTruthClaim === false &&
  analysis.catalogVersion === pointer.catalogVersion, 'INVALID_ACTIVE_ANALYSIS');
for (const a of [...Object.values(analysis.inputs), ...analysis.code]) checked(a);
invariant(samePin(analysis.inputs.activePointer, pointerPin) && samePin(analysis.inputs.activeIndex, indexPin) &&
  samePin(analysis.inputs.activeCHNGeometry, geometryPin) && samePin(analysis.inputs.hierarchy, hierarchyArtifact) &&
  samePin(analysis.inputs.activeProvenance, catalogArtifact('provenance.json')), 'ANALYSIS_ACTIVE_INPUT_BINDING');
const metadataPin = catalogArtifact('metadata/countries/CHN.json.gz');
const metadata = JSON.parse(gunzipSync(checked(metadataPin)));
const parentsPin = catalogArtifact('metadata/parents.json.gz');
const parents = JSON.parse(gunzipSync(checked(parentsPin)));
const incidencePin = catalogArtifact('metadata/edge-incidence.bin.gz');
const incidence = gunzipSync(checked(incidencePin));
invariant(incidence.length === descriptor.counts.edges * 8, 'INVALID_EDGE_INCIDENCE');
invariant(metadata.countryId === 'CHN' && metadata.columns.join(',') === 'cellOrdinal,cellId,administrativeOrdinal,previousParentOrdinal', 'INVALID_CHN_METADATA');
invariant(samePin(analysis.inputs.activeCHNMetadata, metadataPin), 'ANALYSIS_CHN_METADATA_BINDING');
const fineSourcePin = hierarchy.sourceFine, provinceSourcePin = hierarchy.sourceAdmin1.artifact;
invariant(samePin(rawAnalysis.inputs.rawFineFamilies, fineSourcePin) && samePin(rawAnalysis.inputs.rawSourceProvinces, provinceSourcePin) &&
  samePin(rawAnalysis.inputs.hierarchy, hierarchyArtifact) && samePin(analysis.inputs.rawFamilyAnalysis, rawAnalysisPin), 'RAW_OVERLAP_INPUT_BINDING');
const rawStatsBySource = new Map(rawAnalysis.families.map(s => [s.sourceFeatureId, s]));
checked(fineSourcePin);
const provinceSource = checkedJSON(provinceSourcePin);
invariant(samePin(provenance.incremental.macroSource, provinceSourcePin) &&
  samePin(analysis.inputs.rawSourceProvinces, provinceSourcePin), 'PROVINCE_SOURCE_BINDING');
const rawProvinceById = new Map(provinceSource.features.map(f => [f.properties.shapeID, f.properties]));
const provinces = hierarchy.macroGroups.map(m => {
  const p = rawProvinceById.get(m.sourceFeatureId);
  invariant(p?.shapeISO === m.sourceISO && p.shapeName === m.name, 'PROVINCE_SOURCE_IDENTITY');
  return {id: m.macroId, sourceFeatureId: m.sourceFeatureId, sourceISO: m.sourceISO, name: m.name};
}).sort((a, b) => a.id.localeCompare(b.id, 'en'));
invariant(provinces.length === 31 && new Set(provinces.map(p => p.id)).size === 31, 'INVALID_PROVINCE_GROUPS');
const provinceBySource = new Map(provinces.map(p => [p.sourceFeatureId, p]));
const verified = new Map(hierarchy.assignments.map(a => [a.sourceFeatureId, a]));
const unknown = new Set(hierarchy.unresolved.map(a => a.sourceFeatureId));
const statsBySource = new Map(analysis.families.map(a => [a.sourceFeatureId, a]));
invariant(statsBySource.size === analysis.families.length && statsBySource.size === 2850, 'INVALID_ANALYZED_FAMILIES');
const geometry = checkedJSON(geometryPin);
const sourceByCell = new Map(), cellIdsBySource = new Map();
for (const feature of geometry.cells) {
  const identity = feature.properties.fineSourceIdentity;
  const sourceId = identity ? feature.properties.sourceFeatureId : null;
  invariant(!sourceByCell.has(feature.id) && feature.properties.countryId === 'CHN', 'INVALID_GEOMETRY_CELL');
  invariant(!identity || identity.sourceFeatureId === sourceId, 'INVALID_GEOMETRY_SOURCE_IDENTITY');
  sourceByCell.set(feature.id, sourceId);
  if (sourceId) {const ids = cellIdsBySource.get(sourceId) ?? []; ids.push(feature.id); cellIdsBySource.set(sourceId, ids);}
}
invariant(metadata.rows.length === geometry.cells.length && metadata.rows.every(r => sourceByCell.has(r[1])), 'CURRENT_GEOMETRY_DELIVERY_ID_MISMATCH');
const AEA = '+proj=aea +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +datum=WGS84 +units=m +no_defs';
invariant(analysis.areaMeasurement.equalAreaCRS === AEA && analysis.areaMeasurement.alwaysXY === true &&
  analysis.areaMeasurement.overlayCRS === 'OGC:CRS84', 'UNSUPPORTED_AREA_MEASUREMENT');
const policy = {minimumTopShare: .99, maximumSecondShare: .001, metric: 'active-family-equal-area',
  candidatePolicy: 'active-overlap-plus-source-family-presentation-inheritance-v2',
  requireUniqueStrictPositiveTop: true, preserveVerifiedHierarchyMembership: true,
  sourceFreeCells: 'unassigned', wholeFamilyAssignment: true, administrativeTruthClaim: false,
  overlayCRS: 'OGC:CRS84', sourceAxisOrder: 'longitude,latitude', equalAreaCRS: AEA, alwaysXY: true,
  areaUnits: 'square meters', operationOrder: ['union-existing-delivered-cells-by-sourceFeatureId', 'CRS84-polygon-intersection', 'transform-existing-intersection-vertices-to-Albers', 'planar-square-meter-area'],
  densification: 'none; vertex-transformed equal-area diagnostic; no geometric coordinate changes',
  sourceFamilyInheritance: {minimumRawTopShare: .999, maximumRawSecondShare: .001,
    rawMetric: 'whole-raw-family-CRS84-planar-area', requireRawUniqueStrictPositiveTop: true,
    requireActiveUniqueStrictPositiveTop: true, requireRawAndActiveTopProvinceMatch: true,
    maximumActiveSecondShare: .001, wholeFamilyIncludingExistingGameplayGains: true,
    order: 'after-verified-hierarchy-and-active-policy', administrativeTruthClaim: false,
    meaning: 'A high-coverage source-family display identity may be inherited over its existing game-coast/border gains when the active whole family still has the same unique top and no rival province above the existing 0.1% cap. This does not claim that gained land is source administrative territory.'},
  uncertainty: 'Dominant overlap is a game presentation rule only. Uncovered/secondary areas remain recorded and no official administrative parent is inferred.'};
const families = [...statsBySource.values()].sort((a, b) => a.sourceFeatureId.localeCompare(b.sourceFeatureId, 'en')).map(s => {
  const actualIds = cellIdsBySource.get(s.sourceFeatureId)?.sort();
  invariant(actualIds && JSON.stringify(actualIds) === JSON.stringify([...s.cellIds].sort()), 'ANALYSIS_FAMILY_CELL_MISMATCH');
  invariant(s.positiveProvinceOverlaps.every(o => provinceBySource.has(o.sourceFeatureId)), 'UNKNOWN_OVERLAP_PROVINCE');
  const top = s.positiveProvinceOverlaps[0], second = s.positiveProvinceOverlaps[1];
  const topArea = top?.intersectionAreaSquareMetersAEA ?? 0, secondArea = second?.intersectionAreaSquareMetersAEA ?? 0;
  const unique = topArea > 0 && topArea > secondArea;
  const topShare = top?.shareOfFamilyAreaAEA ?? 0, secondShare = second?.shareOfFamilyAreaAEA ?? 0;
  invariant(topShare === s.topShareAEA && secondShare === s.secondShareAEA && unique === s.uniqueStrictLargestPositiveOverlapAEA,
    'ANALYSIS_SUMMARY_DOES_NOT_MATCH_OVERLAPS');
  const retained = verified.get(s.sourceFeatureId);
  let renderProvinceId = null, method = 'unresolved';
  const reasons = [], activePolicyFailures = [], inheritancePolicyFailures = [];
  let originalSourceFamilyPresentationEvidence = null;
  if (retained) {
    invariant(s.verifiedMembershipPreserved && s.existingVerifiedSourceMacroIdUnchanged === retained.macroId, 'VERIFIED_SOURCE_MEMBERSHIP_MISMATCH');
    renderProvinceId = retained.macroId; method = 'verified-hierarchy';
  } else {
    invariant(unknown.has(s.sourceFeatureId) && !s.verifiedMembershipPreserved, 'UNKNOWN_SOURCE_HIERARCHY_STATE');
    if (!unique) reasons.push('no-unique-positive-top-overlap');
    if (topShare < policy.minimumTopShare) reasons.push('top-share-below-policy');
    if (secondShare > policy.maximumSecondShare) reasons.push('second-share-above-policy');
    activePolicyFailures.push(...reasons);
    if (!reasons.length) {renderProvinceId = provinceBySource.get(top.sourceFeatureId).id; method = 'source-overlap-presentation';}
    else {
      const raw = rawStatsBySource.get(s.sourceFeatureId);
      invariant(raw, 'MISSING_RAW_UNRESOLVED_SOURCE_FAMILY');
      const rawTop = raw.positiveProvinceOverlaps[0], rawSecond = raw.positiveProvinceOverlaps[1];
      const rawTopArea = rawTop?.intersectionAreaDegrees2 ?? 0, rawSecondArea = rawSecond?.intersectionAreaDegrees2 ?? 0;
      const rawUnique = rawTopArea > 0 && rawTopArea > rawSecondArea;
      const rawTopShare = rawTop?.shareOfRawFamilyArea ?? 0, rawSecondShare = rawSecond?.shareOfRawFamilyArea ?? 0;
      invariant(rawUnique === raw.uniqueStrictLargestPositiveOverlap && rawTopShare === raw.topShare && rawSecondShare === raw.secondShare,
        'RAW_OVERLAP_SUMMARY_MISMATCH');
      if (!rawUnique) inheritancePolicyFailures.push('raw-source-has-no-unique-positive-top');
      if (rawTopShare < policy.sourceFamilyInheritance.minimumRawTopShare) inheritancePolicyFailures.push('raw-source-top-share-below-inheritance-policy');
      if (rawSecondShare > policy.sourceFamilyInheritance.maximumRawSecondShare) inheritancePolicyFailures.push('raw-source-second-share-above-inheritance-policy');
      if (!unique) inheritancePolicyFailures.push('active-source-has-no-unique-positive-top');
      if (rawTop?.sourceFeatureId !== top?.sourceFeatureId) inheritancePolicyFailures.push('raw-and-active-top-provinces-differ');
      if (secondShare > policy.sourceFamilyInheritance.maximumActiveSecondShare) inheritancePolicyFailures.push('active-second-share-above-inheritance-policy');
      originalSourceFamilyPresentationEvidence = {rawMetric: policy.sourceFamilyInheritance.rawMetric,
        rawFamilyAreaDegrees2: raw.rawFamilyAreaDegrees2, rawTopShare, rawSecondShare,
        rawUncoveredShare: raw.uncoveredShare, rawUniqueStrictPositiveTop: rawUnique,
        rawTopProvinceSourceFeatureId: rawTop?.sourceFeatureId ?? null,
        rawSecondProvinceSourceFeatureId: rawSecond?.sourceFeatureId ?? null,
        activeTopProvinceSourceFeatureId: top?.sourceFeatureId ?? null, activeTopShare: topShare,
        activeSecondShare: secondShare, activeUncoveredShare: s.uncoveredShareAEA,
        wholeCurrentFamilyIncludingGameGains: true, administrativeTruthClaim: false};
      if (!inheritancePolicyFailures.length) {
        renderProvinceId = provinceBySource.get(rawTop.sourceFeatureId).id;
        method = 'source-family-presentation-inheritance'; reasons.length = 0;
      } else reasons.push(...inheritancePolicyFailures);
    }
  }
  return {sourceFeatureId: s.sourceFeatureId, renderProvinceId, method, evidence: {
    metric: policy.metric, sourceName: s.sourceName, activeCellCount: s.activeCellCount,
    activeFamilyAreaSquareMetersAEA: s.activeFamilyAreaSquareMetersAEA,
    topShare, secondShare, uncoveredShare: s.uncoveredShareAEA, sumPositiveOverlapShares: s.sumPositiveOverlapSharesAEA,
    uniqueStrictPositiveTop: unique, topProvinceSourceFeatureId: top?.sourceFeatureId ?? null,
    secondProvinceSourceFeatureId: second?.sourceFeatureId ?? null,
    positiveProvinceOverlaps: s.positiveProvinceOverlaps,
    originalVerifiedHierarchyMethod: retained?.method ?? null,
    originalVerifiedHierarchyEvidence: retained?.evidence ?? null,
    rawComparison: s.rawComparison ?? null, unresolvedReasons: reasons,
    activePolicyFailures, inheritancePolicyFailures, originalSourceFamilyPresentationEvidence,
    administrativeTruthClaim: false}};
});
const familiesById = new Map(families.map(f => [f.sourceFeatureId, f]));
const cells = metadata.rows.map(([ordinal, id, adminOrdinal]) => {
  const sourceFeatureId = sourceByCell.get(id), family = sourceFeatureId ? familiesById.get(sourceFeatureId) : null;
  invariant(!sourceFeatureId || Boolean(family), 'MISSING_FAMILY_PRESENTATION');
  const retained = sourceFeatureId ? verified.get(sourceFeatureId) : null;
  if (retained) invariant(parents.administrative[adminOrdinal - 1]?.macroId === retained.macroId, 'OFFICIAL_MEMBERSHIP_CHANGED_BEFORE_PRESENTATION');
  return {ordinal, id, sourceFeatureId, renderProvinceId: family?.renderProvinceId ?? null};
}).sort((a, b) => a.ordinal - b.ordinal);
invariant(cells.length === 3320 && cells.filter(c => c.sourceFeatureId === null).length === 7, 'INVALID_PRESENTATION_CELL_SCOPE');
const cellByOrdinal = new Map(cells.map(c => [c.ordinal, c]));
const addedBoundaryOrdinals = [];
for (let i = 0; i < incidence.length / 8; i++) {
  const left = cellByOrdinal.get(incidence.readUInt32LE(i * 8)), right = cellByOrdinal.get(incidence.readUInt32LE(i * 8 + 4));
  if (left && right && left.renderProvinceId && right.renderProvinceId && left.renderProvinceId !== right.renderProvinceId) addedBoundaryOrdinals.push(i + 1);
}
const inputs = {pointer: pointerPin, index: indexPin, metadata: metadataPin, parents: parentsPin,
  hierarchy: hierarchyArtifact, fineSource: fineSourcePin, provinceSource: provinceSourcePin,
  incidence: incidencePin, geometry: geometryPin, activeOverlapAnalysis: activeAnalysisPin, rawOverlapAnalysis: rawAnalysisPin};
const detailIndexPin = catalogArtifact('detail-index.json'), detailIndex = checkedJSON(detailIndexPin);
const boundaryAuditInputs = [detailIndexPin], addedSet = new Set(addedBoundaryOrdinals), observedAdded = new Set();
const provinceAudit = new Map(provinces.map(p => [p.id, {renderProvinceId: p.id, name: p.name,
  assignedFamilies: families.filter(f => f.renderProvinceId === p.id).length,
  assignedCells: cells.filter(c => c.renderProvinceId === p.id).length,
  interProvinceBoundaryEdges: 0, interProvinceBoundaryLengthKm: 0, countryCoastBoundaryLengthKm: 0,
  suggestedOmittedBoundaryLengthKm: 0}]));
const tentativeProvince = cell => {
  if (!cell) return null;
  if (cell.renderProvinceId) return cell.renderProvinceId;
  const stats = cell.sourceFeatureId ? statsBySource.get(cell.sourceFeatureId) : null;
  return stats?.uniqueStrictLargestPositiveOverlapAEA ? provinceBySource.get(stats.positiveProvinceOverlaps[0].sourceFeatureId).id : null;
};
const gapParts = [], unresolvedInterfaceOrdinals = [];
const distanceKm = coordinates => coordinates.slice(1).reduce((sum, b, i) => {
  const a = coordinates[i], rad = Math.PI / 180;
  const h = Math.sin((b[1] - a[1]) * rad / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2;
  return sum + 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}, 0);
for (const shard of detailIndex.edgeDetails) {
  const artifact = catalogArtifact(shard.artifact.path);
  invariant(artifact.sha256 === shard.artifact.sha256 && artifact.byteLength === shard.artifact.byteLength, 'DETAIL_EDGE_PIN_BINDING');
  boundaryAuditInputs.push(artifact);
  const data = JSON.parse(gunzipSync(checked(artifact)));
  for (const edge of data.edges) {
    const left = cellByOrdinal.get(edge.left), right = cellByOrdinal.get(edge.right);
    if (!left && !right) continue;
    invariant(edge.left === incidence.readUInt32LE((edge.ordinal - 1) * 8) &&
      edge.right === incidence.readUInt32LE((edge.ordinal - 1) * 8 + 4) && edge.lengthKm > 0, 'EDGE_AUDIT_INCIDENCE_MISMATCH');
    if (!left || !right) {
      const province = (left ?? right).renderProvinceId;
      if (province) provinceAudit.get(province).countryCoastBoundaryLengthKm += edge.lengthKm;
      continue;
    }
    if (addedSet.has(edge.ordinal)) {
      invariant(edge.flags.positiveAdjacency, 'PRESENTATION_EDGE_WITHOUT_POSITIVE_ADJACENCY');
      observedAdded.add(edge.ordinal);
      for (const province of [left.renderProvinceId, right.renderProvinceId]) {
        const row = provinceAudit.get(province);
        row.interProvinceBoundaryEdges++; row.interProvinceBoundaryLengthKm += edge.lengthKm;
      }
      continue;
    }
    const a = tentativeProvince(left), b = tentativeProvince(right);
    if (!left.renderProvinceId || !right.renderProvinceId) unresolvedInterfaceOrdinals.push(edge.ordinal);
    if (!a || !b || a === b) continue;
    const pair = [a, b].sort();
    for (const province of pair) provinceAudit.get(province).suggestedOmittedBoundaryLengthKm += edge.lengthKm;
    const parts = edge.geometry.type === 'LineString' ? [edge.geometry.coordinates] : edge.geometry.coordinates;
    for (const coordinates of parts) gapParts.push({ordinal: edge.ordinal, pair, lengthKm: distanceKm(coordinates),
      coordinates, sourceFeatureIds: [left.sourceFeatureId, right.sourceFeatureId].filter(Boolean).sort()});
  }
}
invariant(observedAdded.size === addedSet.size, 'PRESENTATION_EDGE_AUDIT_INCOMPLETE');
const componentParent = gapParts.map((_, i) => i), endpointOwner = new Map();
const find = i => {while (componentParent[i] !== i) {componentParent[i] = componentParent[componentParent[i]]; i = componentParent[i];} return i;};
const union = (a, b) => {a = find(a); b = find(b); if (a !== b) componentParent[b] = a;};
for (let i = 0; i < gapParts.length; i++) {
  const part = gapParts[i], pairKey = JSON.stringify(part.pair);
  for (const endpoint of [part.coordinates[0], part.coordinates.at(-1)]) {
    const key = `${pairKey}:${JSON.stringify(endpoint)}`, previous = endpointOwner.get(key);
    if (previous !== undefined) union(i, previous); else endpointOwner.set(key, i);
  }
}
const gapComponents = new Map();
for (let i = 0; i < gapParts.length; i++) {
  const part = gapParts[i], key = find(i);
  const component = gapComponents.get(key) ?? {suggestedProvinceIds: part.pair, edgeOrdinals: new Set(),
    sourceFeatureIds: new Set(), lengthKm: 0, bounds: [Infinity, Infinity, -Infinity, -Infinity]};
  component.edgeOrdinals.add(part.ordinal); part.sourceFeatureIds.forEach(id => component.sourceFeatureIds.add(id));
  component.lengthKm += part.lengthKm;
  for (const [x, y] of part.coordinates) {component.bounds[0] = Math.min(component.bounds[0], x); component.bounds[1] = Math.min(component.bounds[1], y);
    component.bounds[2] = Math.max(component.bounds[2], x); component.bounds[3] = Math.max(component.bounds[3], y);}
  gapComponents.set(key, component);
}
const suggestedGaps = [...gapComponents.values()].map(c => ({...c, edgeOrdinals: [...c.edgeOrdinals].sort((a, b) => a - b),
  sourceFeatureIds: [...c.sourceFeatureIds].sort(), sourceNames: [...c.sourceFeatureIds].sort().map(id => statsBySource.get(id).sourceName)}))
  .sort((a, b) => b.lengthKm - a.lengthKm || a.edgeOrdinals[0] - b.edgeOrdinals[0]);
const boundaryAudit = {method: 'Lengths use existing delivered edge geometry and the catalog spherical-distance convention. Connected suggested gaps join exact matching endpoints only within one tentative province pair.',
  gapMeaning: 'Suggested omitted source-overlap display interfaces only: at least one family failed the display policy, but its unique positive top differs from its neighbor. These are uncertainty diagnostics, not certified administrative province boundary lengths; none are added to the render index.',
  all31GroupsHavePositiveAssignedCellArea: provinces.every(p => families.some(f => f.renderProvinceId === p.id && f.evidence.activeFamilyAreaSquareMetersAEA > 0)),
  provinces: [...provinceAudit.values()], totalRenderedInterProvinceLengthKm: [...provinceAudit.values()].reduce((s, p) => s + p.interProvinceBoundaryLengthKm, 0) / 2,
  suggestedOmittedBoundaryLengthKm: gapParts.reduce((s, p) => s + p.lengthKm, 0), suggestedOmittedConnectedComponents: suggestedGaps.length,
  suggestedOmittedEdges: [...new Set(gapParts.map(p => p.ordinal))].sort((a, b) => a - b),
  largestSuggestedGaps: suggestedGaps.slice(0, 20), unassignedInterfaceOrdinals: unresolvedInterfaceOrdinals,
  noInterProvinceBoundaryGroups: [...provinceAudit.values()].filter(p => p.interProvinceBoundaryEdges === 0).map(p => ({renderProvinceId: p.renderProvinceId,
    name: p.name, countryCoastBoundaryLengthKm: p.countryCoastBoundaryLengthKm,
    reason: p.name === 'Hainan' ? 'Island province has no positive-length inter-province land boundary; existing coast remains country/coast rendering.' : 'No admitted inter-province edge; inspect uncertainty ledger.'}))};
const code = [pin('scripts/chn-2020/build-province-presentation-v2.mjs'), ...analysis.code];
for (const a of [...Object.values(inputs), ...boundaryAuditInputs, ...code]) checked(a);
const result = {schemaVersion: 'chn-province-presentation-v1', countryId: 'CHN', administrativeTruthClaim: false,
  catalogRef: descriptor.catalogRef, inputs, code, policy, provinces, families, cells, addedBoundaryOrdinals, boundaryAuditInputs, boundaryAudit,
  summary: {provinces: provinces.length, cells: cells.length, wholeFineFamilies: families.length,
    verifiedHierarchyFamilies: families.filter(f => f.method === 'verified-hierarchy').length,
    sourceOverlapPresentationFamilies: families.filter(f => f.method === 'source-overlap-presentation').length,
    inheritedSourceFamilyPresentationFamilies: families.filter(f => f.method === 'source-family-presentation-inheritance').length,
    unresolvedFineFamilies: families.filter(f => f.method === 'unresolved').length,
    sourceFreeCells: cells.filter(c => c.sourceFeatureId === null).length,
    unassignedCells: cells.filter(c => c.renderProvinceId === null).length, addedBoundaryEdges: addedBoundaryOrdinals.length},
  temporalLimits: analysis.sourceTemporalLimits,
  limitations: ['Separate game presentation membership; never replaces administrativeParents or gameplay cap checks.',
    'Source-family display inheritance includes existing game gains outside the historical source province polygon; it is separately recorded and does not claim administrative coverage of those gains.',
    'Province contours consist only of existing positive-adjacency shared mesh edges between differently assigned CHN cells.',
    'No old independent coarse lines, new polygon coordinates, inferred official parent or foreign territory are added.',
    'Unassigned fine families and all seven source-free cells retain visible uncertainty in the ledger.']};
const resultBytes = Buffer.from(JSON.stringify(result) + '\n');
const sha256 = digest(resultBytes);
const output = `data/derived/chn-2020/province-presentation-${sha256.slice(0, 20)}/presentation.json`;
const destination = path.resolve(root, output);
fs.mkdirSync(path.dirname(destination), {recursive: true});
if (fs.existsSync(destination)) invariant(fs.readFileSync(destination).equals(resultBytes), 'IMMUTABLE_PRESENTATION_CHANGED');
else fs.writeFileSync(destination, resultBytes, {flag: 'wx'});
console.log(JSON.stringify({artifact: {path: output, sha256, byteLength: resultBytes.length}, summary: result.summary,
  unresolved: families.filter(f => f.method === 'unresolved').map(f => ({sourceFeatureId: f.sourceFeatureId,
    name: f.evidence.sourceName, topShare: f.evidence.topShare, secondShare: f.evidence.secondShare, reasons: f.evidence.unresolvedReasons}))}));
