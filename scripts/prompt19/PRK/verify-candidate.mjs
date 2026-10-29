// Country-only read/verification; diagnostic source topology is never a runtime candidate.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import DistanceOp from 'jsts/org/locationtech/jts/operation/distance/DistanceOp.js';
import {digest, geometryMetadata, jsonBytes, normalizeGeometry, polygons} from '../../prompt14-catalog-core.mjs';
import {buildCatalogTopology, territoryIdForAtom} from '../../prompt14-catalog-topology.mjs';
import {normalizeSource, SOURCE_ID} from './normalize-source.mjs';

const candidateRoot = 'data/derived/prompt19/candidates/PRK/1b726665e8afc0006e1f';
const reportRoot = 'reports/verification/prompt19/PRK';
const collection = features => ({type: 'FeatureCollection', features});
const errorInfo = e => ({message: e.message, evidence: e.evidence ?? null});
const areaOf = coords => coords.length ? geometryMetadata(normalizeGeometry({type: 'MultiPolygon', coordinates: coords})).area : 0;
export function verifyCandidate(root = process.cwd()) {
  const readBytes = relative => fs.readFileSync(path.join(root, relative));
  const read = relative => JSON.parse(readBytes(relative));
  const identity = relative => {const bytes = readBytes(relative); return {path: relative, sha256: digest(bytes), byteLength: bytes.length};};
  const write = (file, value) => fs.writeFileSync(path.join(root, reportRoot, file), jsonBytes(value));
  const sourceBytes = readBytes('data/raw/prompt19/PRK/geoBoundaries-PRK-ADM2.geojson');
  const normalized = read('data/raw/prompt19/PRK/normalized-adm2.geojson');
  assert.deepEqual(normalized, normalizeSource(sourceBytes), 'All source features, coordinates, holes and components must be retained');
  const lock = read('data/source-locks/prompt19/PRK.json'), handoff = read('reports/maintenance/prompt19-handoff.json');
  for (const pin of [...handoff.commonGenerator.files, ...handoff.baseline.artifacts, handoff.baseline.artifactIndex, handoff.coarseWorld.artifactIndex,
    lock.normalizedInput, ...lock.preprocessing.code, ...lock.sources.map(s => s.artifact)]) assert.deepEqual(identity(pin.path), pin);
  const current = read('data/runtime/operational-catalog/current.json');
  assert.equal(current.catalogVersion, handoff.coarseWorld.catalogVersion);
  assert.equal(current.index.sha256, handoff.coarseWorld.artifactIndex.sha256);
  const candidateIndex = read(`${candidateRoot}/artifact-index.json`);
  for (const pin of candidateIndex.artifacts) assert.deepEqual(identity(`${candidateRoot}/${pin.path}`), {...pin, path: `${candidateRoot}/${pin.path}`});
  const cells = read(`${candidateRoot}/cells.geojson`), validation = read(`${candidateRoot}/validation.json`), manifest = read(`${candidateRoot}/manifest.json`);
  assert.deepEqual(identity('data/source-locks/prompt19/PRK.json'), manifest.sourceLock);
  assert.equal(manifest.runtimePublication, false); assert.equal(manifest.globalOrdinalsAssigned, false);
  const sourceById = new Map(normalized.features.map(f => [f.properties.sourceFeatureId, f]));
  const parents = read('data/derived/prompt19/baseline-v1/coarse-parents.geojson').features.filter(f => f.properties.countryId === 'PRK');
  const parentById = new Map(parents.map(f => [f.properties.coarseTerritoryId, f]));
  assert.equal(sourceById.size, 179);
  for (const c of cells.features) {
    assert.ok(c.id.startsWith('PRK:cell:') && c.id === c.properties.localId);
    assert.ok(!('ordinal' in c.properties) && !('catalogRef' in c.properties));
    assert.equal(c.properties.sourceId, SOURCE_ID);
    assert.ok(sourceById.has(c.properties.sourceFeatureId));
    assert.equal(c.properties.sourceParentId, null);
    assert.equal(c.properties.administrativeParentKey, parentById.get(c.properties.coarseParentTerritoryId)?.properties.parentKey);
  }
  assert.equal(new Set(cells.features.map(f => f.id)).size, cells.features.length);
  assert.equal(new Set(cells.features.map(f => f.properties.sourceFeatureId)).size, 179);
  assert.equal(validation.checks.sourceGeometryValid, true);
  assert.ok(validation.parentCoverage.every(p => p.distinctSourceFeatures > 1));
  // A rejected candidate must never acquire a misleading playable topology or ready status.
  assert.equal(validation.pass, false); assert.equal(manifest.status, 'needs-source-or-alignment');
  assert.equal(read(`${candidateRoot}/topology.json`), null);

  const nativeFeatures = normalized.features.map(f => ({...f, geometry: normalizeGeometry(f.geometry)}));
  const nativeUnion = polygonClipping.union(...nativeFeatures.map(f => polygons(f.geometry)));
  const nativeEnvelope = normalizeGeometry({type: 'MultiPolygon', coordinates: nativeUnion});
  const envelope = read('data/derived/prompt19/baseline-v1/country-envelopes.geojson').features.find(f => f.properties.countryId === 'PRK');
  const residual = read(`${candidateRoot}/residuals.geojson`);
  const componentCoverage = polygons(envelope.geometry).map((component, i) => {
    const geometry = normalizeGeometry({type: 'Polygon', coordinates: component});
    const area = geometryMetadata(geometry).area;
    const sourceMissing = polygonClipping.difference([component], nativeUnion);
    const gapArea = areaOf(sourceMissing);
    return {baselineComponent: i, ...geometryMetadata(geometry), sourceMissingAreaDegrees2: gapArea,
      sourceGapPercent: 100 * gapArea / area, sourceFullyMissing: polygonClipping.intersection([component], nativeUnion).length === 0};
  });
  const seamChains = read('data/derived/prompt19/baseline-v1/national-boundaries.geojson').features
    .filter(f => [f.properties.leftCountryId, f.properties.rightCountryId].sort().join(':') === 'KOR:PRK');
  const reader = new GeoJSONReader();
  const nativeBoundary = reader.read({type: 'MultiLineString', coordinates: polygons(nativeEnvelope).flatMap(p => p)});
  const seamSamples = seamChains.map(chain => {
    const coordinates = chain.geometry.coordinates;
    const samples = coordinates.flatMap((p, i) => i ? [{position: p, at: `vertex:${i}`},
      {position: [(p[0] + coordinates[i - 1][0]) / 2, (p[1] + coordinates[i - 1][1]) / 2], at: `segment-midpoint:${i - 1}`}]
      : [{position: p, at: 'vertex:0'}]).map(sample => {
      const distance = new DistanceOp(reader.read({type: 'Point', coordinates: sample.position}), nativeBoundary);
      const nearest = distance.nearestPoints()[1];
      return {...sample, distanceToSourceBoundaryDegrees: distance.distance(), nearestSourceBoundaryPosition: [nearest.x, nearest.y]};
    });
    return {baselineEdgeId: chain.properties.baselineEdgeId, sampledPoints: samples.length,
      exactCoincidentSamples: samples.filter(s => s.distanceToSourceBoundaryDegrees === 0).length,
      maxDistanceDegrees: Math.max(...samples.map(s => s.distanceToSourceBoundaryDegrees)), samples};
  });
  const nativeAtoms = nativeFeatures.map(f => ({canonicalAtomKey: `PRK:source:${f.properties.sourceFeatureId}`, geometry: f.geometry, identity: {sourceCountryId: 'PRK'}}));
  const sourceIdByTemporary = new Map(nativeAtoms.map((a, i) => [territoryIdForAtom(a.canonicalAtomKey), nativeFeatures[i].properties.sourceFeatureId]));
  let nativeTopology, nativeTopologyFailure = null;
  try {
    const result = buildCatalogTopology(nativeAtoms, collection([{type: 'Feature', properties: {countryId: 'PRK'}, geometry: nativeEnvelope}]));
    nativeTopology = {status: 'diagnostic-source-outline-only', baselineCompatible: false,
      evidenceContext: 'P0 in reused evidence means the union of this acquired source, not the project pinned envelope. No authoritative baseline compatibility is certified.', evidence: result.evidence,
      adjacency: Object.fromEntries(Object.entries(result.adjacency).map(([id, neighbors]) => [sourceIdByTemporary.get(id), neighbors.map(n => sourceIdByTemporary.get(n))])),
      edges: result.edges.map(e => ({leftSourceFeatureId: sourceIdByTemporary.get(e.leftTerritoryId), rightSourceFeatureId: sourceIdByTemporary.get(e.rightTerritoryId) ?? null,
        kind: e.rightTerritoryId ? 'internal-land' : 'source-envelope-contact', geometry: e.geometry}))};
    assert.ok(nativeTopology.edges.filter(e => e.kind === 'internal-land').every(e => e.geometry.coordinates.some((p, i, all) => i > 0 && (p[0] !== all[i - 1][0] || p[1] !== all[i - 1][1]))));
    for (const [id, neighbors] of Object.entries(nativeTopology.adjacency)) for (const n of neighbors) assert.ok(n !== id && nativeTopology.adjacency[n].includes(id));
    write('source-native-topology.json', nativeTopology);
  } catch (error) {nativeTopologyFailure = errorInfo(error); nativeTopology = null;}
  const rawTotals = nativeFeatures.reduce((sum, f) => {const m = geometryMetadata(f.geometry); for (const k of ['vertices', 'components', 'holes']) sum[k] += m[k]; return sum;}, {features: nativeFeatures.length, vertices: 0, components: 0, holes: 0});
  const cellAreas = cells.features.map(c => ({localId: c.id, sourceFeatureId: c.properties.sourceFeatureId, areaDegrees2: geometryMetadata(c.geometry).area}));
  const tiny = cellAreas.filter(c => c.areaDegrees2 < 1e-10);
  const gap = validation.coverage.gapArea, p0Area = validation.coverage.p0Area;
  const report = {schemaVersion: 'prompt19-PRK-verification-v1', countryId: 'PRK', branch: '19-02B', status: manifest.status,
    supersededCandidates: [{root: 'data/derived/prompt19/candidates/PRK/229d1a4ac80c76f19004',
      sourceLockSnapshot: 'data/raw/prompt19/PRK/source-lock-initial-build-date.json',
      reason: 'Metadata correction: publication date is unknown (null); 2023-12-12 is only a known build date. Geometry is unchanged. Use the current candidateRoot.'}],
    candidateRoot, candidateIndex: identity(`${candidateRoot}/artifact-index.json`), sourceLock: identity('data/source-locks/prompt19/PRK.json'),
    sourceEvidence: [
      ['data/raw/prompt19/PRK/geoboundaries-api-ADM2.json', 'https://www.geoboundaries.org/api/current/gbOpen/PRK/ADM2/'],
      ['data/raw/prompt19/PRK/geoboundaries-humanitarian-api-ADM2.json', 'https://www.geoboundaries.org/api/current/gbHumanitarian/PRK/ADM2/'],
      ['data/raw/prompt19/PRK/geoBoundaries-PRK-ADM2.lfs.txt', 'https://raw.githubusercontent.com/wmgeolab/geoBoundaries/9469f09/releaseData/gbOpen/PRK/ADM2/geoBoundaries-PRK-ADM2.geojson'],
      ['data/raw/prompt19/PRK/cc-by-3.0-igo.html', 'https://creativecommons.org/licenses/by/3.0/igo/'],
    ].map(([file, url]) => ({...identity(file), url, localSavedAtUtc: fs.statSync(path.join(root, file)).mtime.toISOString()})),
    checks: {inputAndCandidatePinsMatch: true, rawCoordinatesAndComponentsPreserved: true, all179SourceFeaturesRepresented: true,
      everyCoarseParentHasMultipleSourceFeatures: true, countryScopeAndLocalIdentityOnly: true, runtimePointerUnchanged: true,
      generatorAndBaselineUnchanged: true, rejectedCandidateNotPublished: true},
    candidateChecks: validation.checks, sourceTotals: rawTotals, candidateTotals: validation.totals, candidateBytes: validation.bytes,
    candidateArtifactBytes: candidateIndex.artifacts.reduce((sum, p) => sum + p.byteLength, 0) + identity(`${candidateRoot}/artifact-index.json`).byteLength,
    coverage: {...validation.coverage, gapPercent: 100 * gap / p0Area, areaUnits: 'longitude/latitude degrees squared; percent is planar coverage, not geodesic area'},
    componentCoverage, fullyMissingBaselineComponents: componentCoverage.filter(c => c.sourceFullyMissing).map(c => c.baselineComponent),
    sourceComponentsOutsideBaseline: validation.sourceTrace.flatMap(f => f.componentTrace.filter(c => c.intersectingEnvelopeAreaDegrees2 === 0)
      .map(c => ({sourceFeatureId: f.sourceFeatureId, sourceComponentHash: c.sourceComponentHash, sourceHoles: c.sourceHoles, localIds: c.localIds}))),
    sourceOutsideEnvelopeAreaDegrees2: validation.sourceTrace.reduce((sum, f) => sum + f.outsideEnvelopeAreaDegrees2, 0),
    residualParts: residual.features.map(f => ({...f.properties, ...geometryMetadata(f.geometry)})),
    parentCoverage: validation.parentCoverage.map(p => ({coarseTerritoryId: p.coarseTerritoryId, parentKey: p.parentKey,
      name: parentById.get(p.coarseTerritoryId)?.properties.name ?? null, cells: p.localIds.length, distinctSourceFeatures: p.distinctSourceFeatures, coverage: p.coverage})),
    fragmentation: {tinyThresholdDegrees2: 1e-10, tinyCells: tiny.length, smallestCell: [...cellAreas].sort((a, b) => a.areaDegrees2 - b.areaDegrees2)[0],
      explanation: 'One source feature can intersect several pinned coarse parents and split into disconnected components. All nonempty clipped components are retained; all 230 original components remain in raw input. Very small intersections include outline differences and floating-point slivers, not additional administrative units.'},
    sourceNativeTopology: nativeTopology ? {status: nativeTopology.status, baselineCompatible: false, evidence: nativeTopology.evidence,
      evidenceContext: nativeTopology.evidenceContext, artifact: identity(`${reportRoot}/source-native-topology.json`),
      path: `${reportRoot}/source-native-topology.json`} : {status: 'failed', failure: nativeTopologyFailure},
    pinnedCandidateTopologyFailure: {message: validation.topologyFailure?.message, evidenceCounts: validation.topologyFailure?.evidence && {
      errors: validation.topologyFailure.evidence.errorCount, p0OnlySegments: validation.topologyFailure.evidence.p0OnlySegments, territorySegments: validation.topologyFailure.evidence.territorySegments}},
    sharedBorder: {pinnedChains: seamChains.map(f => ({properties: f.properties, geometry: f.geometry})), samples: seamSamples,
      sampleMethod: 'Every pinned vertex and segment midpoint, planar distance to the unchanged native source union boundary, nearest source coordinate retained. Sample distances locate mismatches; not a complete seam certificate or geodesic distance.',
      status: 'unaltered; full baseline boundary certification failed; no shared-border alignment or authoritative adjacency claimed'},
    reproduction: {normalization: 'node scripts/prompt19/PRK/normalize-source.mjs', candidate: 'node scripts/prepare-prompt19-country.mjs PRK',
      candidateExpectedExitCode: 2, candidateOverwrite: 'Do not rerun over existing content-key output; inspect immutable artifacts or reproduce in memory.',
      verification: 'node scripts/prompt19/PRK/verify-candidate.mjs'},
    scope: {sourceOnlyNativeTopologyIsPlayable: false, runtimePublication: false, globalIdsAssigned: false, KORChanged: false, commonCodeChanged: false, buildServerBrowserRun: false}};
  write('verification.json', report);
  return {status: report.status, checks: report.checks, sourceTotals: rawTotals, candidateTotals: validation.totals,
    gapPercent: report.coverage.gapPercent, missingBaselineComponents: report.fullyMissingBaselineComponents,
    tinyCells: tiny.length, sourceNativeTopology: report.sourceNativeTopology.status, nativeTopologyFailure: nativeTopologyFailure?.message};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(verifyCandidate()));
