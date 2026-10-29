import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {assertWorldGeometryCatalogRefMatches, createWorldGeometryCatalogRef, readCatalogTerritoryId, type WorldGeometryCatalogContract} from './world-geometry-catalog-ref';
import {readWorldV3CountryId} from './world-v3-validation';
import {OPERATIONAL_CATALOG_VERSION, type OperationalArtifact, type OperationalCatalogDescriptor, type OperationalCell, type OperationalCellMetrics, type OperationalLandBoundary, type OperationalAdministrativeParent, type OperationalPreviousParent, type OperationalEdge} from './operational-catalog';

export const OPERATIONAL_CATALOG_PATHS = Object.freeze({
  admission: 'reports/prompt15/15-21-final-join/20261027T122926152KST-receipt-intake/final-admission.json',
  verdict: 'reports/prompt15/15-21-final-join/20261027T122926152KST-receipt-intake/admitted/verdict.json',
  catalog: 'data/derived/prompt15/15-19-operational-catalog-v3-ae59d85d8dedbafc44f6',
  indices: 'data/derived/prompt15/15-20-topology-membership-v1-22406931e1665b6ede05',
  delivery: 'data/derived/prompt15/15-21-world-delivery-v1-56fc6c79c216e6bd1a11',
});
// Byte-identical deployment copies. Evidence paths above remain the logical provenance.
export const OPERATIONAL_CATALOG_RUNTIME_PATHS = Object.freeze({
  admission: 'data/runtime/operational-catalog/catalog-v3-56fc6c79c216e6bd1a11/final-admission.json',
  verdict: 'data/runtime/operational-catalog/catalog-v3-56fc6c79c216e6bd1a11/verdict.json',
  deliveryIndex: 'data/runtime/operational-catalog/catalog-v3-56fc6c79c216e6bd1a11/delivery-artifact-index.json',
});
const DELIVERY_SCHEMA = 'prompt15-task-15-21-world-delivery-v1';
const INDEX_SCHEMA = 'prompt15-task-15-20-world-indices-v1';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type ArtifactIndex = {artifacts: OperationalArtifact[]};
type Membership<P> = {schemaVersion: string; cellCount: number; parents: P[]; cellOrdinals: number[]; oldParentOrdinalByCell?: number[]};
type RawAdmin = Omit<OperationalAdministrativeParent, 'ordinal'>;
type RawPrevious = Omit<OperationalPreviousParent, 'ordinal'>;
type PreviousMembership = Membership<RawPrevious> & {oldParentOrdinalByCell: number[]};
type CountryDetail = Readonly<{countryId: string; cellCount: number; metadata: OperationalArtifact; detail: OperationalArtifact}>;
type EdgeShard = Readonly<{shard: string; firstOrdinal: number; count: number; artifact: OperationalArtifact}>;
type Adjacency = {schemaVersion: string; cellCount: number; offsets: number[]; neighbors: number[]};

/** Admission binds only the pinned existing assets. This is not a new geometry audit. */
export function prepareOperationalCatalog(root = process.cwd(), read = (file: string): Buffer => fs.readFileSync(file)) {
  const readFile = (file: string) => {
    if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.split('/').some(part => !part || part === '.' || part === '..')) throw Error('UNSAFE_CATALOG_PATH');
    return read(path.join(root, file));
  };
  const json = <T>(bytes: Buffer): T => JSON.parse(bytes.toString('utf8'));
  const checked = (file: string, identity: Omit<OperationalArtifact, 'path'>) => {
    const bytes = readFile(file);
    if (bytes.length !== identity.byteLength || sha(bytes) !== identity.sha256) throw Error('OPERATIONAL_ASSET_IDENTITY');
    return bytes;
  };
  const admission = json<{authoritativeVerdict: string; task15_21: string}>(readFile(OPERATIONAL_CATALOG_RUNTIME_PATHS.admission));
  if (admission.authoritativeVerdict !== OPERATIONAL_CATALOG_PATHS.verdict || admission.task15_21 !== 'PASS') throw Error('OPERATIONAL_CATALOG_NOT_ADMITTED');
  const verdict = json<{candidate: string; task15_21: string; assetVerification: string; upstreamVerification: string; artifactIndex: Omit<OperationalArtifact, 'path'>}>(readFile(OPERATIONAL_CATALOG_RUNTIME_PATHS.verdict));
  if (verdict.candidate !== OPERATIONAL_CATALOG_PATHS.delivery || verdict.task15_21 !== 'PASS' || verdict.assetVerification !== 'PASS' || verdict.upstreamVerification !== 'VERIFIED') throw Error('OPERATIONAL_CATALOG_NOT_ADMITTED');

  const artifactMap = (index: ArtifactIndex) => {
    const map = new Map(index.artifacts.map(a => [a.path, Object.freeze(a)]));
    if (map.size !== index.artifacts.length) throw Error('DUPLICATE_OPERATIONAL_ARTIFACT');
    return map;
  };
  const deliveryArtifacts = artifactMap(json<ArtifactIndex>(checked(OPERATIONAL_CATALOG_RUNTIME_PATHS.deliveryIndex, verdict.artifactIndex)));
  const artifact = (map: ReadonlyMap<string, OperationalArtifact>, file: string) => {
    const a = map.get(file); if (!a) throw Error('UNKNOWN_OPERATIONAL_ARTIFACT'); return a;
  };
  const deliveryBytes = (file: string) => checked(`${OPERATIONAL_CATALOG_PATHS.delivery}/${file}`, artifact(deliveryArtifacts, file));
  const provenance = json<{inputs: OperationalArtifact[]}>(deliveryBytes('provenance.json'));
  const upstream = (base: string) => {
    const pin = provenance.inputs.find(a => a.path === `${base}/artifact-index.json`);
    if (!pin) throw Error('OPERATIONAL_UPSTREAM_PIN');
    const map = artifactMap(json<ArtifactIndex>(checked(pin.path, pin)));
    return {bytes: (file: string) => checked(`${base}/${file}`, artifact(map, file))};
  };
  const catalogSource = upstream(OPERATIONAL_CATALOG_PATHS.catalog), indexSource = upstream(OPERATIONAL_CATALOG_PATHS.indices);
  const manifest = json<{
    schemaVersion: string; ref: Record<string, string>; counts: OperationalCatalogDescriptor['counts'];
    detailIndex: OperationalArtifact; edgeIncidence: {artifact: OperationalArtifact; decodedByteLength: number; recordCount: number; recordBytes: number; format: string};
  }>(deliveryBytes('manifest.json'));
  const indices = json<{schemaVersion: string; sourceCatalogRoot: string; roots: Record<string, string>; counts: {cells: number; edges: number}; administrativeMembership: string; previousParentIndex: string; adjacency: string}>(indexSource.bytes('index-root.json'));
  const source = json<{schemaVersion: string; cellCount: number; countryOrder: string[]}>(catalogSource.bytes('catalog-root.json'));
  if (manifest.schemaVersion !== DELIVERY_SCHEMA || indices.schemaVersion !== INDEX_SCHEMA || source.schemaVersion !== 'prompt15-task-15-19-world-catalog-v1' ||
      manifest.ref.catalogVersion !== OPERATIONAL_CATALOG_VERSION || manifest.ref.sourceCatalogRoot !== OPERATIONAL_CATALOG_PATHS.catalog || manifest.ref.sourceIndicesRoot !== OPERATIONAL_CATALOG_PATHS.indices ||
      indices.sourceCatalogRoot !== OPERATIONAL_CATALOG_PATHS.catalog || manifest.counts.cells !== indices.counts.cells || manifest.counts.cells !== source.cellCount || manifest.counts.edges !== indices.counts.edges || manifest.counts.countries !== source.countryOrder.length) throw Error('OPERATIONAL_CATALOG_LINK_MISMATCH');
  for (const [field, key] of [['topologyRoot', 'topology'], ['catalogOrderRoot', 'catalogOrder'], ['administrativeMembershipRoot', 'administrativeMembership'], ['previousParentRoot', 'previousParent']] as const) {
    if (manifest.ref[field] !== indices.roots[key]) throw Error('OPERATIONAL_CATALOG_ROOT_MISMATCH');
  }
  const ref = createWorldGeometryCatalogRef({catalogVersion: manifest.ref.catalogVersion, geometryRoot: manifest.ref.geometryRoot, topologyRoot: manifest.ref.topologyRoot,
    renderArtifactRoot: manifest.ref.renderArtifactRoot, manifestPath: `/data/territory-catalog/${manifest.ref.catalogVersion}/manifest.json`});
  const details = json<{schemaVersion: string; ref: Record<string, string>; countries: CountryDetail[]; edgeDetails: EdgeShard[]}>(checked(`${OPERATIONAL_CATALOG_PATHS.delivery}/${manifest.detailIndex.path}`, manifest.detailIndex));
  if (details.schemaVersion !== DELIVERY_SCHEMA || JSON.stringify(details.ref) !== JSON.stringify(manifest.ref) ||
      details.countries.length !== source.countryOrder.length || details.countries.some((c, i) => c.countryId !== source.countryOrder[i])) throw Error('OPERATIONAL_DETAIL_INDEX_MISMATCH');
  const countries = new Map(details.countries.map(c => [c.countryId, c]));
  const descriptor: OperationalCatalogDescriptor = Object.freeze({schemaVersion: 'operational-catalog-v1', catalogRef: ref,
    indexRoots: Object.freeze({catalogOrder: indices.roots.catalogOrder, administrativeMembership: indices.roots.administrativeMembership, previousParent: indices.roots.previousParent}),
    counts: Object.freeze({...manifest.counts}), countryOrder: Object.freeze([...source.countryOrder])});
  const gzip = <T>(bytes: Buffer) => json<T>(gunzipSync(bytes));
  const parents = gzip<{administrative: RawAdmin[]; previous: RawPrevious[]}>(deliveryBytes('metadata/parents.json.gz'));
  if (parents.administrative.length !== manifest.counts.administrativeParents || parents.previous.length !== manifest.counts.previousParents) throw Error('OPERATIONAL_PARENT_COUNT');
  const administrativeParents = Object.freeze(parents.administrative.map((p, i) => Object.freeze({...p, ordinal: i + 1})));
  const previousParents = Object.freeze(parents.previous.map((p, i) => Object.freeze({...p, oldTerritoryId: readCatalogTerritoryId(p.oldTerritoryId), ordinal: i + 1})));
  const adminByKey = new Map(administrativeParents.map(p => [p.parentKey, p]));
  const previousById = new Map(previousParents.map(p => [p.oldTerritoryId as string, p]));
  const byOrdinal: (OperationalCell | undefined)[] = new Array(manifest.counts.cells);
  const byId = new Map<string, OperationalCell>(), countryCells = new Map<string, readonly OperationalCell[]>();
  const metricCountries = new Map<string, ReadonlyMap<string, OperationalCellMetrics>>();
  let administrative: Membership<RawAdmin> | undefined, previous: PreviousMembership | undefined;
  let adjacency: Adjacency | undefined, incidence: Buffer | undefined, contract: WorldGeometryCatalogContract | undefined;
  const edgeShards = new Map<string, readonly OperationalEdge[]>();
  const ordinal = (value: number, max = manifest.counts.cells) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error('UNKNOWN_OPERATIONAL_ORDINAL');
    return value;
  };
  const loadCountry = (countryId: string): readonly OperationalCell[] => {
    const cached = countryCells.get(countryId); if (cached) return cached;
    const country = countries.get(countryId); if (!country) throw Error('UNKNOWN_OPERATIONAL_COUNTRY');
    const metadata = gzip<{countryId: string; columns: string[]; rows: [number, string, number, number][]}>(deliveryBytes(country.metadata.path));
    if (metadata.countryId !== countryId || metadata.rows.length !== country.cellCount || metadata.columns.join(',') !== 'cellOrdinal,cellId,administrativeOrdinal,previousParentOrdinal') throw Error('OPERATIONAL_COUNTRY_METADATA');
    // Validate the entire country before publishing any cache entry.
    const cells = metadata.rows.map(([n, id, a, p], i) => {
      ordinal(n); ordinal(a, administrativeParents.length); ordinal(p, previousParents.length);
      if ((i > 0 && metadata.rows[i - 1][0] >= n) || byOrdinal[n - 1] || byId.has(id) || administrativeParents[a - 1].sourceCountryId !== countryId || previousParents[p - 1].sourceCountryId !== countryId) throw Error('OPERATIONAL_CELL_MAPPING');
      return Object.freeze({id: readCatalogTerritoryId(id), ordinal: n, sourceCountryId: readWorldV3CountryId(countryId, 'sourceCountryId'), administrativeOrdinal: a, previousParentOrdinal: p});
    });
    if (new Set(cells.map(c => c.id)).size !== cells.length) throw Error('DUPLICATE_OPERATIONAL_CELL');
    cells.forEach(c => {byOrdinal[c.ordinal - 1] = c; byId.set(c.id, c);});
    countryCells.set(countryId, Object.freeze(cells)); return countryCells.get(countryId)!;
  };
  const loadAllCells = () => {
    for (const countryId of source.countryOrder) loadCountry(countryId);
    if (byId.size !== manifest.counts.cells) throw Error('OPERATIONAL_CELL_COUNT');
  };
  const cell = (idOrOrdinal: string | number): OperationalCell => {
    if (typeof idOrOrdinal === 'number') ordinal(idOrOrdinal); else readCatalogTerritoryId(idOrOrdinal);
    let found = typeof idOrOrdinal === 'number' ? byOrdinal[idOrOrdinal - 1] : byId.get(idOrOrdinal);
    if (!found) {loadAllCells(); found = typeof idOrOrdinal === 'number' ? byOrdinal[idOrOrdinal - 1] : byId.get(idOrOrdinal);}
    if (!found) throw Error('UNKNOWN_OPERATIONAL_CELL'); return found;
  };
  const cellMetrics = (idOrOrdinal: string | number): OperationalCellMetrics => {
    const current = cell(idOrOrdinal), countryId = current.sourceCountryId;
    let metrics = metricCountries.get(countryId);
    if (!metrics) {
      const data = gzip<{schemaVersion: string; countryId: string; entries: ({id: string; sourceCountryId: string} & OperationalCellMetrics)[]}>(catalogSource.bytes(`countries/${countryId}/catalog.json.gz`));
      const cells = loadCountry(countryId);
      if (data.schemaVersion !== 'prompt15-task-15-19-world-catalog-v1' || data.countryId !== countryId || data.entries.length !== cells.length) throw Error('OPERATIONAL_METRICS_SHAPE');
      const countryIds = new Set(cells.map(c => c.id as string));
      const prepared = new Map<string, OperationalCellMetrics>();
      for (const entry of data.entries) {
        if (!countryIds.has(entry.id) || prepared.has(entry.id) || entry.sourceCountryId !== countryId ||
            !Number.isFinite(entry.areaKm2) || entry.areaKm2 < 0 || !Number.isFinite(entry.diameterKm) || entry.diameterKm <= 0 ||
            !Array.isArray(entry.centroid) || entry.centroid.length !== 2 || !entry.centroid.every(Number.isFinite) ||
            Math.abs(entry.centroid[0]) > 180 || Math.abs(entry.centroid[1]) > 90) throw Error('OPERATIONAL_CELL_METRICS');
        prepared.set(entry.id, Object.freeze({centroid: Object.freeze([...entry.centroid]) as readonly [number, number], areaKm2: entry.areaKm2, diameterKm: entry.diameterKm}));
      }
      if (metricCountries.size >= 4) metricCountries.delete(metricCountries.keys().next().value!);
      metrics = prepared; metricCountries.set(countryId, metrics);
    }
    return metrics.get(current.id)!;
  };
  const loadMembership = <P extends {start: number; count: number}>(file: string, expected: readonly P[]): Membership<P> => {
    const result = gzip<Membership<P>>(indexSource.bytes(file));
    if (result.schemaVersion !== INDEX_SCHEMA || result.cellCount !== manifest.counts.cells || result.cellOrdinals.length !== manifest.counts.cells || result.parents.length !== expected.length) throw Error('OPERATIONAL_MEMBERSHIP_SHAPE');
    let end = 0;
    result.parents.forEach((p, i) => {
      const descriptor = {...expected[i]} as P & {ordinal?: number};
      delete descriptor.ordinal;
      if (JSON.stringify(p) !== JSON.stringify(descriptor) || p.start !== end || !Number.isInteger(p.count) || p.count < 1) throw Error('OPERATIONAL_MEMBERSHIP_PARENT');
      end += p.count;
    });
    if (end !== result.cellOrdinals.length) throw Error('OPERATIONAL_MEMBERSHIP_SHAPE');
    return result;
  };
  const loadPreviousMembership = (): PreviousMembership => {
    const result = loadMembership<RawPrevious>(indices.previousParentIndex, previousParents);
    const reverse = result.oldParentOrdinalByCell;
    if (!Array.isArray(reverse) || reverse.length !== manifest.counts.cells) throw Error('OPERATIONAL_PREVIOUS_PARENT_SHAPE');
    return {...result, oldParentOrdinalByCell: reverse};
  };
  const membership = (parent: OperationalAdministrativeParent | OperationalPreviousParent, kind: 'administrative' | 'previous') => {
    loadCountry(parent.sourceCountryId);
    const index = kind === 'administrative' ? administrative ??= loadMembership(indices.administrativeMembership, administrativeParents) : previous ??= loadPreviousMembership();
    const cells = index.cellOrdinals.slice(parent.start, parent.start + parent.count).map(n => {
      const c = byOrdinal[ordinal(n) - 1];
      if (!c || c.sourceCountryId !== parent.sourceCountryId || (kind === 'administrative' ? c.administrativeOrdinal : c.previousParentOrdinal) !== parent.ordinal ||
          (kind === 'previous' && previous!.oldParentOrdinalByCell[n - 1] !== parent.ordinal)) throw Error('OPERATIONAL_MEMBERSHIP_CELL');
      return c;
    });
    if (new Set(cells.map(c => c.ordinal)).size !== parent.count) throw Error('OPERATIONAL_MEMBERSHIP_DUPLICATE');
    return Object.freeze(cells);
  };
  const administrativeMembership = (parentKey: string) => {
    const p = adminByKey.get(parentKey); if (!p) throw Error('UNKNOWN_OPERATIONAL_ADMINISTRATIVE_PARENT'); return membership(p, 'administrative');
  };
  const previousMembership = (oldTerritoryId: string) => {
    const p = previousById.get(oldTerritoryId); if (!p) throw Error('UNKNOWN_OPERATIONAL_PREVIOUS_PARENT'); return membership(p, 'previous');
  };
  const edgeIncidence = (n: number) => {
    ordinal(n, manifest.counts.edges);
    if (!incidence) {
      const spec = manifest.edgeIncidence, bytes = gunzipSync(deliveryBytes(spec.artifact.path));
      if (spec.format !== 'uint32-le-pairs' || spec.recordBytes !== 8 || spec.recordCount !== manifest.counts.edges || bytes.length !== spec.decodedByteLength || bytes.length !== manifest.counts.edges * 8) throw Error('OPERATIONAL_EDGE_INCIDENCE');
      incidence = bytes;
    }
    const left = incidence.readUInt32LE((n - 1) * 8), right = incidence.readUInt32LE((n - 1) * 8 + 4);
    ordinal(left); if (right !== 0) ordinal(right); if (left === right) throw Error('OPERATIONAL_EDGE_INCIDENCE');
    return Object.freeze({left, right});
  };
  const edge = (n: number): OperationalEdge => {
    ordinal(n, manifest.counts.edges);
    const shard = details.edgeDetails.find(s => n >= s.firstOrdinal && n < s.firstOrdinal + s.count);
    if (!shard) throw Error('UNKNOWN_OPERATIONAL_EDGE');
    let edges = edgeShards.get(shard.shard);
    if (!edges) {
      const data = gzip<{schemaVersion: string; edges: OperationalEdge[]}>(indexSource.bytes(shard.shard));
      if (data.schemaVersion !== INDEX_SCHEMA || data.edges.length !== shard.count) throw Error('OPERATIONAL_EDGE_SHARD');
      edges = Object.freeze(data.edges.map((e, i) => {
        const pair = edgeIncidence(e.ordinal);
        if (e.ordinal !== shard.firstOrdinal + i || !/^edge:operational:[a-f0-9]{64}$/.test(e.id) || !(e.lengthKm > 0) || e.left !== pair.left || e.right !== pair.right || e.flags.positiveAdjacency !== (e.right > 0)) throw Error('OPERATIONAL_EDGE_MAPPING');
        return Object.freeze({id: e.id, ordinal: e.ordinal, left: e.left, right: e.right, lengthKm: e.lengthKm, boundaryClass: e.boundaryClass, flags: Object.freeze({...e.flags})});
      }));
      if (edgeShards.size >= 4) edgeShards.delete(edgeShards.keys().next().value!);
      edgeShards.set(shard.shard, edges);
    }
    return edges[n - shard.firstOrdinal];
  };
  const neighbors = (n: number) => {
    ordinal(n);
    if (!adjacency) {
      const data = gzip<Adjacency>(indexSource.bytes(indices.adjacency));
      if (data.schemaVersion !== INDEX_SCHEMA || data.cellCount !== manifest.counts.cells || data.offsets.length !== manifest.counts.cells + 1 || data.offsets[0] !== 0 || data.offsets[data.cellCount] !== data.neighbors.length) throw Error('OPERATIONAL_ADJACENCY_SHAPE');
      adjacency = data;
    }
    const start = adjacency.offsets[n - 1], end = adjacency.offsets[n];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > adjacency.neighbors.length) throw Error('OPERATIONAL_ADJACENCY_RANGE');
    const result = adjacency.neighbors.slice(start, end);
    result.forEach((value, i) => {ordinal(value); if (value === n || (i > 0 && value <= result[i - 1])) throw Error('OPERATIONAL_ADJACENCY_CELL');});
    return Object.freeze(result);
  };
  /** Only a real positive-length edge can anchor a land advance. */
  const sharedBoundary = (left: number, right: number): OperationalLandBoundary => {
    ordinal(left); ordinal(right);
    if (left === right || !neighbors(left).includes(right)) throw Error('NO_OPERATIONAL_LAND_BOUNDARY');
    edgeIncidence(1); // Load the compact incidence buffer once, without world polygons.
    let selected: OperationalEdge | undefined;
    for (let offset = 0; offset < incidence!.length; offset += 8) {
      const a = incidence!.readUInt32LE(offset), b = incidence!.readUInt32LE(offset + 4);
      if ((a === left && b === right) || (a === right && b === left)) {
        const candidate = edge(offset / 8 + 1);
        if (candidate.flags.positiveAdjacency && (!selected || candidate.lengthKm > selected.lengthKm)) selected = candidate;
      }
    }
    if (!selected) throw Error('NO_OPERATIONAL_LAND_BOUNDARY');
    const shard = details.edgeDetails.find(s => selected!.ordinal >= s.firstOrdinal && selected!.ordinal < s.firstOrdinal + s.count)!;
    const raw = gzip<{edges: {geometry: {type: string; coordinates: [number, number][]}}[]}>(indexSource.bytes(shard.shard));
    const geometry = raw.edges[selected.ordinal - shard.firstOrdinal].geometry;
    if (geometry.type !== 'LineString' || geometry.coordinates.length < 2) throw Error('OPERATIONAL_BOUNDARY_GEOMETRY');
    let segment: {start: readonly [number, number]; end: readonly [number, number]; length: number} | undefined;
    for (let i = 1; i < geometry.coordinates.length; i++) {
      const start = geometry.coordinates[i - 1], end = geometry.coordinates[i];
      const dx = ((end[0] - start[0] + 540) % 360 - 180) * Math.cos((start[1] + end[1]) * Math.PI / 360);
      const length = Math.hypot(dx, end[1] - start[1]);
      if (length > (segment?.length ?? 0)) segment = {start, end, length};
    }
    if (!segment) throw Error('OPERATIONAL_BOUNDARY_GEOMETRY');
    return Object.freeze({edgeOrdinal: selected.ordinal, start: Object.freeze([...segment.start]) as readonly [number, number], end: Object.freeze([...segment.end]) as readonly [number, number]});
  };
  const worldContract = (): WorldGeometryCatalogContract => {
    if (contract) return contract;
    loadAllCells();
    const territoryOrder = Object.freeze(byOrdinal.map(c => c!.id));
    // Same canonical order root as catalog-order, without decoding its large redundant descriptors.
    if (sha(Buffer.from(`${JSON.stringify(territoryOrder)}\n`)) !== indices.roots.catalogOrder) throw Error('OPERATIONAL_CATALOG_ORDER');
    const territoriesById = Object.fromEntries(byOrdinal.map(c => [c!.id, Object.freeze({id: c!.id, sourceCountryId: c!.sourceCountryId})]));
    return contract = Object.freeze({ref, territoryOrder, territoriesById: Object.freeze(territoriesById)});
  };
  return Object.freeze({descriptor, ref, administrativeParents, previousParents, loadCountry, cell, cellMetrics, administrativeMembership, previousMembership, neighbors, sharedBoundary, edgeIncidence, edge, worldContract,
    deliveryArtifact: (file: string) => artifact(deliveryArtifacts, file),
    readDeliveryAsset: deliveryBytes,
    assertRef: (actual: typeof ref) => assertWorldGeometryCatalogRefMatches(actual, ref),
    countryDetail: (countryId: string) => {const c = countries.get(countryId); if (!c) throw Error('UNKNOWN_OPERATIONAL_COUNTRY'); return Object.freeze({...c, metadata: Object.freeze({...c.metadata}), detail: Object.freeze({...c.detail})});},
    // Names are attached to source identities only; this does not read mutable ownership.
    readRegionNames: () => {
      const catalogProvenance = json<{inputs: OperationalArtifact[]}>(catalogSource.bytes('provenance.json'));
      const pin = catalogProvenance.inputs.find(a => a.path === 'data/source-locks/prompt14-derived-game-input-lock.json');
      if (!pin) throw Error('OPERATIONAL_REGION_SOURCE_LOCK');
      const lock = json<{lineageInputs: {repositoryPath: string; sha256: string; byteLength: number}[]}>(checked(pin.path, pin));
      const sourcePath = 'data/raw/ne_10m_admin_1_states_provinces.geojson', identity = lock.lineageInputs.find(a => a.repositoryPath === sourcePath);
      if (!identity) throw Error('OPERATIONAL_REGION_SOURCE_IDENTITY');
      const raw = json<{features: {properties: Record<string, string | number | null>}[]}>(checked(sourcePath, identity));
      return new Map(raw.features.map(f => [String(f.properties.ne_id), Object.freeze(f.properties)]));
    },
  });
}

export type OperationalCatalog = ReturnType<typeof prepareOperationalCatalog>;
let catalog: OperationalCatalog | undefined;
export const loadOperationalCatalog = () => catalog ??= prepareOperationalCatalog();
