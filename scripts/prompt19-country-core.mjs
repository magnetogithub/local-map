// Shared offline candidate engine. Country adapters supply acquired source polygons only.
import {z} from 'zod';
import polygonClipping from 'polygon-clipping';
import {canonical, compareText, digest, geometryMetadata, hashCanonical, jsonBytes, normalizeGeometry, polygons} from './prompt14-catalog-core.mjs';
import {buildCatalogTopology, territoryIdForAtom} from './prompt14-catalog-topology.mjs';
import {CANONICAL_P0_VALIDATOR_POLICY, validatePartitionCoverage, validatePolygonFeatureCollection} from './prompt14-source-gate.mjs';

export const PROMPT19_CANDIDATE_SCHEMA = 'prompt19-country-candidate-v1';
export const PROMPT19_SOURCE_SCHEMA = 'prompt19-country-source-lock-v1';
export const prompt19Country = z.enum(['KOR', 'PRK']);
const text = z.string().trim().min(1).max(2048);
const artifact = z.strictObject({path: text, sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: z.number().int().nonnegative()});
const source = z.strictObject({sourceId: text, url: z.url().regex(/^https?:\/\//), version: text, publishedAt: text.nullable(),
  retrievedAt: z.iso.datetime({offset: true}), boundaryBasis: z.enum(['administrative', 'documented-natural']), adminLevel: z.number().int().min(2).nullable(),
  temporalCoverage: text, scenarioDateCaveat: text, originalCrs: text,
  license: z.strictObject({name: text, url: z.url().regex(/^https?:\/\//), attribution: text, redistributionAllowed: z.literal(true)}), artifact,
}).refine(s => s.boundaryBasis !== 'administrative' || s.adminLevel !== null, 'Administrative fine sources require ADM2 or finer');
export const prompt19SourceLockSchema = z.strictObject({schemaVersion: z.literal(PROMPT19_SOURCE_SCHEMA), countryId: prompt19Country,
  normalizedCrs: z.literal('EPSG:4326'), sources: z.array(source).min(1), normalizedInput: artifact,
  preprocessing: z.strictObject({description: text, code: z.array(artifact).min(1)})});
const featureProperties = z.strictObject({countryId: prompt19Country, sourceId: text, sourceFeatureId: text,
  sourceParentId: text.nullable(), name: text.nullable(), boundaryEvidenceRef: text.nullable()});
const asGeometry = coords => normalizeGeometry({type: 'MultiPolygon', coordinates: coords});
const collection = features => ({type: 'FeatureCollection', features});
const area = coords => coords.length ? geometryMetadata(asGeometry(coords)).area : 0;
const errorText = error => error instanceof Error ? error.message : String(error);
const lineLengthKm = coordinates => coordinates.slice(1).reduce((sum, b, i) => {
  const a = coordinates[i], rad = Math.PI / 180;
  const h = Math.sin((b[1] - a[1]) * rad / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin((b[0] - a[0]) * rad / 2) ** 2;
  return sum + 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(h)));
}, 0);

/** No I/O, no output registry, no global IDs/ordinals; fixtures can exercise the same engine. */
export function buildPrompt19CountryCandidate({countryId, sourceLock, normalized, envelope, coarseParents, baselineIdentity}) {
  prompt19Country.parse(countryId);
  const lock = prompt19SourceLockSchema.parse(sourceLock);
  if (lock.countryId !== countryId || envelope.properties.countryId !== countryId || coarseParents.some(f => f.properties.countryId !== countryId)) throw Error('PROMPT19_COUNTRY_SCOPE');
  if (normalized.type !== 'FeatureCollection' || !Array.isArray(normalized.features) || !normalized.features.length) throw Error('PROMPT19_SOURCE_FEATURE_COLLECTION');
  const sources = new Map(lock.sources.map(s => [s.sourceId, s]));
  if (sources.size !== lock.sources.length || new Set(coarseParents.map(f => f.properties.coarseTerritoryId)).size !== coarseParents.length) throw Error('PROMPT19_DUPLICATE_SOURCE_OR_PARENT');
  const seen = new Set(), features = normalized.features.map(f => {
    const p = featureProperties.parse(f.properties), s = sources.get(p.sourceId);
    if (p.countryId !== countryId || !s) throw Error('PROMPT19_SOURCE_COUNTRY_OR_ID');
    if (s.boundaryBasis === 'documented-natural' && !p.boundaryEvidenceRef) throw Error('PROMPT19_NATURAL_BOUNDARY_EVIDENCE');
    const key = canonical([p.sourceId, p.sourceFeatureId]);
    if (seen.has(key)) throw Error('PROMPT19_DUPLICATE_FEATURE_ID'); seen.add(key);
    return {type: 'Feature', properties: p, geometry: normalizeGeometry(f.geometry)};
  }).sort((a, b) => compareText(canonical(a.properties), canonical(b.properties)));
  const validity = validatePolygonFeatureCollection(collection(features), 'Prompt19 normalized source', CANONICAL_P0_VALIDATOR_POLICY);
  if (!validity.pass) throw Error(`PROMPT19_INVALID_SOURCE_GEOMETRY: ${validity.errors.join('; ')}`);
  const cells = [], sourceTrace = [];
  // Spatial intersection is the parent crosswalk. Display names/centroids never allocate territory.
  for (const f of features) {
    const p = f.properties, s = sources.get(p.sourceId), parts = [];
    const componentTrace = [];
    for (const sourceComponent of polygons(f.geometry)) {
      const sourceComponentHash = hashCanonical('prompt19-source-component.v1', sourceComponent), componentIds = [];
      for (const parent of coarseParents) {
        const clipped = polygonClipping.intersection([sourceComponent], polygons(parent.geometry));
        for (const component of clipped) {
        const geometry = normalizeGeometry({type: 'Polygon', coordinates: component});
        const identity = {countryId, sourceId: p.sourceId, sourceVersion: s.version, sourceArtifactSha256: s.artifact.sha256,
          sourceFeatureId: p.sourceFeatureId, coarseParentTerritoryId: parent.properties.coarseTerritoryId, geometry};
        const localId = `${countryId}:cell:${hashCanonical('prompt19-country-local-cell.v1', identity)}`;
        cells.push({type: 'Feature', id: localId, properties: {localId, countryId, sourceId: p.sourceId, sourceVersion: s.version,
          sourceFeatureId: p.sourceFeatureId, sourceParentId: p.sourceParentId, sourceComponentHash,
          boundaryBasis: s.boundaryBasis, adminLevel: s.adminLevel, name: p.name, boundaryEvidenceRef: p.boundaryEvidenceRef,
          coarseParentTerritoryId: parent.properties.coarseTerritoryId, administrativeParentKey: parent.properties.parentKey}, geometry});
        parts.push(localId); componentIds.push(localId);
        }
      }
      componentTrace.push({sourceComponentHash, sourceHoles: sourceComponent.length - 1, localIds: componentIds.sort(compareText),
        intersectingEnvelopeAreaDegrees2: area(polygonClipping.intersection([sourceComponent], polygons(envelope.geometry)))});
    }
    const outside = polygonClipping.difference(polygons(f.geometry), polygons(envelope.geometry));
    sourceTrace.push({sourceId: p.sourceId, sourceFeatureId: p.sourceFeatureId, sourceComponents: polygons(f.geometry).length,
      localIds: parts.sort(compareText), componentTrace, outsideEnvelopeAreaDegrees2: area(outside)});
  }
  cells.sort((a, b) => compareText(a.id, b.id));
  if (new Set(cells.map(c => c.id)).size !== cells.length) throw Error('PROMPT19_DUPLICATE_LOCAL_CELL');
  const parentCoverage = coarseParents.map(parent => {
    const members = cells.filter(c => c.properties.coarseParentTerritoryId === parent.properties.coarseTerritoryId);
    return {coarseTerritoryId: parent.properties.coarseTerritoryId, parentKey: parent.properties.parentKey, kind: parent.properties.kind,
      localIds: members.map(c => c.id), fineUnitCount: members.length,
      distinctSourceFeatures: new Set(members.map(c => canonical([c.properties.sourceId, c.properties.sourceFeatureId]))).size,
      coverage: validatePartitionCoverage(parent.geometry, members.map(c => c.geometry), CANONICAL_P0_VALIDATOR_POLICY)};
  });
  const coverage = validatePartitionCoverage(envelope.geometry, cells.map(c => c.geometry), CANONICAL_P0_VALIDATOR_POLICY);
  const residuals = polygonClipping.difference(polygons(envelope.geometry), ...(cells.length ? [polygonClipping.union(...cells.map(c => polygons(c.geometry)))] : [[]]));
  let topology = null, topologyFailure = null;
  try {
    const atoms = cells.map(c => ({canonicalAtomKey: c.id, geometry: c.geometry, identity: {sourceCountryId: countryId}}));
    const localByTemporaryId = new Map(atoms.map((a, i) => [territoryIdForAtom(a.canonicalAtomKey), cells[i].id]));
    const result = buildCatalogTopology(atoms, collection([envelope]));
    // Temporary catalog IDs are implementation details of the reused noder; never exported.
    const edges = result.edges.map(e => {
      const leftLocalId = localByTemporaryId.get(e.leftTerritoryId), rightLocalId = localByTemporaryId.get(e.rightTerritoryId) ?? null;
      const identity = {countryId, leftLocalId, rightLocalId, geometry: e.geometry};
      return {localEdgeId: `${countryId}:edge:${hashCanonical('prompt19-country-local-edge.v1', identity)}`,
        leftLocalId, rightLocalId, geometry: e.geometry, lengthKm: lineLengthKm(e.geometry.coordinates), kind: rightLocalId ? 'internal-land' : 'envelope-contact'};
    });
    topology = {edges, adjacency: Object.fromEntries([...localByTemporaryId].map(([id, local]) => [local, result.adjacency[id].map(n => localByTemporaryId.get(n)).sort(compareText)])), evidence: result.evidence};
  } catch (error) {topologyFailure = {message: errorText(error), evidence: error.evidence ?? null};}
  const checks = {sourceGeometryValid: validity.pass, countryCoverage: coverage.pass, everyParentCovered: parentCoverage.every(p => p.coverage.pass),
    everySourceRepresented: sourceTrace.every(s => s.localIds.length > 0),
    everyInEnvelopeSourceComponentRepresented: sourceTrace.every(s => s.componentTrace.every(c => c.intersectingEnvelopeAreaDegrees2 === 0 || c.localIds.length > 0)),
    administrativePartialSelection: parentCoverage.filter(p => p.kind === 'administrative').every(p => p.distinctSourceFeatures > 1),
    completeBoundaryPairing: topology !== null, residualGeometryEmpty: residuals.length === 0};
  const totals = cells.reduce((n, c) => {const m = geometryMetadata(c.geometry); return {cells: n.cells + 1, vertices: n.vertices + m.vertices, components: n.components + m.components, holes: n.holes + m.holes};}, {cells: 0, vertices: 0, components: 0, holes: 0});
  totals.edges = topology?.edges.length ?? null;
  totals.internalLandEdges = topology?.edges.filter(e => e.kind === 'internal-land').length ?? null;
  totals.adjacencyPairs = topology ? Object.values(topology.adjacency).reduce((n, values) => n + values.length, 0) / 2 : null;
  const validation = {pass: Object.values(checks).every(Boolean), checks, coverage, parentCoverage, sourceTrace, topologyFailure,
    residualPolicy: 'Diagnostic only. Do not assign a gap to a nearby source, rename coarse ADM1 as fine, or omit an island.', totals,
    bytes: {geometry: jsonBytes(collection(cells)).length, topology: jsonBytes(topology).length}};
  return {schemaVersion: PROMPT19_CANDIDATE_SCHEMA, countryId, status: validation.pass ? 'ready-for-coordinator-integration' : 'needs-source-or-alignment',
    baselineIdentity, sourceLockSha256: digest(jsonBytes(lock)), cells: collection(cells), topology,
    residuals: collection(residuals.map((coordinates, i) => ({type: 'Feature', properties: {countryId, diagnosticPart: i}, geometry: {type: 'Polygon', coordinates}}))), validation};
}
