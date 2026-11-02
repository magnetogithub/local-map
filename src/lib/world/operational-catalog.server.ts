import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {assertWorldGeometryCatalogRefMatches, createWorldGeometryCatalogRef, readCatalogTerritoryId, type WorldGeometryCatalogContract} from './world-geometry-catalog-ref';
import {readWorldV3CountryId} from './world-v3-validation';
import {OPERATIONAL_CATALOG_ROOT, OPERATIONAL_CATALOG_VERSION, type OperationalArtifact, type OperationalCatalogDescriptor, type OperationalCell, type OperationalCellMetrics, type OperationalAdministrativeParent, type OperationalPreviousParent, type OperationalEdge} from './operational-catalog';

export const OPERATIONAL_CATALOG_PATHS = Object.freeze({delivery: OPERATIONAL_CATALOG_ROOT});
export const OPERATIONAL_CATALOG_RUNTIME_PATHS = Object.freeze({current: 'data/runtime/operational-catalog/current.json'});
const DELIVERY_SCHEMA = 'operational-world-delivery-v2';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type CountryDetail = Readonly<{countryId: string; cellCount: number; metadata: OperationalArtifact; detail: OperationalArtifact}>;
type EdgeShard = Readonly<{shard: string; firstOrdinal: number; count: number; artifact: OperationalArtifact}>;
type ExactEdge = OperationalEdge & {geometry: {type: 'LineString'; coordinates: [number, number][]}};

/** Missing versioned assets fail closed; no generation or legacy fallback. */
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
  const pointer = json<{catalogVersion: string; root: string; index: OperationalArtifact}>(readFile(OPERATIONAL_CATALOG_RUNTIME_PATHS.current));
  if (pointer.catalogVersion !== OPERATIONAL_CATALOG_VERSION || pointer.root !== OPERATIONAL_CATALOG_PATHS.delivery) throw Error('OPERATIONAL_CATALOG_VERSION');
  const index = json<{schemaVersion: string; artifacts: OperationalArtifact[]}>(checked(`${pointer.root}/artifact-index.json`, pointer.index));
  const artifacts = new Map(index.artifacts.map(a => [a.path, Object.freeze(a)]));
  if (index.schemaVersion !== DELIVERY_SCHEMA || artifacts.size !== index.artifacts.length) throw Error('OPERATIONAL_ARTIFACT_INDEX');
  const artifact = (file: string) => {const a = artifacts.get(file); if (!a) throw Error('UNKNOWN_OPERATIONAL_ARTIFACT'); return a;};
  const deliveryBytes = (file: string) => checked(`${pointer.root}/${file}`, artifact(file));
  const gzip = <T>(file: string): T => json(gunzipSync(deliveryBytes(file)));
  const raw = json<OperationalCatalogDescriptor>(deliveryBytes('catalog.json'));
  const ref = createWorldGeometryCatalogRef(raw.catalogRef);
  if (ref.catalogVersion !== pointer.catalogVersion || raw.counts.countries !== raw.countryOrder.length) throw Error('OPERATIONAL_CATALOG_LINK_MISMATCH');
  const descriptor = Object.freeze({...raw, catalogRef: ref, counts: Object.freeze(raw.counts), countryOrder: Object.freeze(raw.countryOrder), indexRoots: Object.freeze(raw.indexRoots)});
  const details = json<{schemaVersion: string; ref: {catalogVersion: string}; countries: CountryDetail[]; edgeDetails: EdgeShard[]}>(deliveryBytes('detail-index.json'));
  if (details.schemaVersion !== DELIVERY_SCHEMA || details.ref.catalogVersion !== ref.catalogVersion || details.countries.length !== raw.counts.countries ||
      details.countries.some((c, i) => c.countryId !== raw.countryOrder[i]) || details.countries.reduce((n, c) => n + c.cellCount, 0) !== raw.counts.cells) throw Error('OPERATIONAL_DETAIL_INDEX_MISMATCH');
  const countries = new Map(details.countries.map(c => [c.countryId, c]));
  const parents = gzip<{administrative: Omit<OperationalAdministrativeParent, 'ordinal'>[]; previous: Omit<OperationalPreviousParent, 'ordinal'>[]}>('metadata/parents.json.gz');
  const administrativeParents = Object.freeze(parents.administrative.map((p, i) => Object.freeze({...p, ordinal: i + 1})));
  const previousParents = Object.freeze(parents.previous.map((p, i) => {
    const oldTerritoryId = readCatalogTerritoryId(p.oldTerritoryId);
    const seedParentIds = p.seedParentIds?.map(id => readCatalogTerritoryId(id));
    if (seedParentIds && (!seedParentIds.length || !seedParentIds.includes(oldTerritoryId) ||
        seedParentIds.some((id, n) => n > 0 && id <= seedParentIds[n - 1]))) throw Error('OPERATIONAL_SEED_LINEAGE');
    return Object.freeze({...p, oldTerritoryId, ...(seedParentIds ? {seedParentIds: Object.freeze(seedParentIds)} : {}), ordinal: i + 1});
  }));
  if (administrativeParents.length !== raw.counts.administrativeParents || previousParents.length !== raw.counts.previousParents) throw Error('OPERATIONAL_PARENT_COUNT');
  const adminByKey = new Map(administrativeParents.map(p => [p.parentKey, p]));
  const previousById = new Map(previousParents.map(p => [p.oldTerritoryId as string, p]));
  if (adminByKey.size !== administrativeParents.length || previousById.size !== previousParents.length ||
      [...administrativeParents, ...previousParents].some(p => !countries.has(p.sourceCountryId) || !Number.isSafeInteger(p.start) || p.start < 0 || !Number.isSafeInteger(p.count) || p.count < 1)) throw Error('OPERATIONAL_PARENT_MAPPING');
  const byOrdinal: (OperationalCell | undefined)[] = new Array(raw.counts.cells);
  const byId = new Map<string, OperationalCell>(), countryCells = new Map<string, readonly OperationalCell[]>();
  const ordinal = (n: number, max = raw.counts.cells) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > max) throw Error('UNKNOWN_OPERATIONAL_ORDINAL'); return n;
  };
  const loadCountry = (countryId: string): readonly OperationalCell[] => {
    const cached = countryCells.get(countryId); if (cached) return cached;
    const country = countries.get(countryId); if (!country) throw Error('UNKNOWN_OPERATIONAL_COUNTRY');
    const data = gzip<{countryId: string; columns: string[]; rows: [number, string, number, number][]}>(country.metadata.path);
    if (data.countryId !== countryId || data.rows.length !== country.cellCount || data.columns.join(',') !== 'cellOrdinal,cellId,administrativeOrdinal,previousParentOrdinal') throw Error('OPERATIONAL_COUNTRY_METADATA');
    const cells = data.rows.map(([n, id, a, p], i) => {
      ordinal(n); ordinal(a, administrativeParents.length); ordinal(p, previousParents.length);
      if ((i && data.rows[i - 1][0] >= n) || byOrdinal[n - 1] || byId.has(id) || administrativeParents[a - 1].sourceCountryId !== countryId || previousParents[p - 1].sourceCountryId !== countryId) throw Error('OPERATIONAL_CELL_MAPPING');
      return Object.freeze({id: readCatalogTerritoryId(id), ordinal: n, sourceCountryId: readWorldV3CountryId(countryId, 'sourceCountryId'), administrativeOrdinal: a, previousParentOrdinal: p});
    });
    if (new Set(cells.map(c => c.id)).size !== cells.length) throw Error('DUPLICATE_OPERATIONAL_CELL');
    cells.forEach(c => {byOrdinal[c.ordinal - 1] = c; byId.set(c.id, c);});
    const frozen = Object.freeze(cells); countryCells.set(countryId, frozen); return frozen;
  };
  const loadAll = () => {for (const id of raw.countryOrder) loadCountry(id); if (byId.size !== raw.counts.cells) throw Error('OPERATIONAL_CELL_COUNT');};
  const cell = (id: string | number): OperationalCell => {
    if (typeof id === 'number') ordinal(id); else readCatalogTerritoryId(id);
    let c = typeof id === 'number' ? byOrdinal[id - 1] : byId.get(id);
    if (!c) {loadAll(); c = typeof id === 'number' ? byOrdinal[id - 1] : byId.get(id);}
    if (!c) throw Error('UNKNOWN_OPERATIONAL_CELL'); return c;
  };
  const administrativeMembership = (key: string) => {
    const p = adminByKey.get(key); if (!p) throw Error('UNKNOWN_OPERATIONAL_ADMINISTRATIVE_PARENT');
    const cells = loadCountry(p.sourceCountryId).filter(c => c.administrativeOrdinal === p.ordinal);
    if (!cells.length) throw Error('OPERATIONAL_MEMBERSHIP_SHAPE'); return Object.freeze(cells);
  };
  const previousMembership = (id: string) => {
    const p = previousById.get(id); if (!p) throw Error('UNKNOWN_OPERATIONAL_PREVIOUS_PARENT');
    const cells = loadCountry(p.sourceCountryId).filter(c => c.previousParentOrdinal === p.ordinal);
    if (!cells.length) throw Error('OPERATIONAL_MEMBERSHIP_SHAPE'); return Object.freeze(cells);
  };
  let metrics: ReadonlyMap<string, OperationalCellMetrics> | undefined;
  const cellMetrics = (id: string | number): OperationalCellMetrics => {
    const c = cell(id);
    metrics ??= new Map(gzip<({id: string} & OperationalCellMetrics)[]>('metrics.json.gz').map(m => [m.id, Object.freeze({...m, centroid: Object.freeze(m.centroid)})]));
    const m = metrics.get(c.id); if (!m || !(m.areaKm2 >= 0) || !(m.diameterKm > 0) || !m.centroid.every(Number.isFinite)) throw Error('OPERATIONAL_CELL_METRICS'); return m;
  };
  let adjacency: {cellCount: number; offsets: number[]; neighbors: number[]} | undefined;
  const neighbors = (n: number) => {
    ordinal(n); adjacency ??= gzip('adjacency.json.gz');
    if (adjacency!.cellCount !== raw.counts.cells || adjacency!.offsets.length !== raw.counts.cells + 1) throw Error('OPERATIONAL_ADJACENCY_SHAPE');
    const values = adjacency!.neighbors.slice(adjacency!.offsets[n - 1], adjacency!.offsets[n]);
    values.forEach((v, i) => {ordinal(v); if (v === n || (i && v <= values[i - 1])) throw Error('OPERATIONAL_ADJACENCY_CELL');}); return Object.freeze(values);
  };
  // Small verified incidence is independent of geometry. Build the pair index
  // once, then each frontier contact reads only its matching exact edge shards.
  let incidence: Buffer | undefined, pairEdges: ReadonlyMap<string, readonly number[]> | undefined;
  const pairKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;
  const loadIncidence = () => {
    if (incidence) return;
    const bytes = gunzipSync(deliveryBytes('metadata/edge-incidence.bin.gz'));
    if (bytes.length !== raw.counts.edges * 8) throw Error('OPERATIONAL_EDGE_INCIDENCE_SHAPE');
    const pairs = new Map<string, number[]>();
    for (let n = 1; n <= raw.counts.edges; n++) {
      const left = bytes.readUInt32LE((n - 1) * 8), right = bytes.readUInt32LE((n - 1) * 8 + 4);
      if (left < 1 || left > raw.counts.cells || right > raw.counts.cells || left === right) throw Error('OPERATIONAL_EDGE_INCIDENCE_MAPPING');
      if (right) {const key = pairKey(left, right), values = pairs.get(key) ?? [];values.push(n);pairs.set(key, values);}
    }
    pairEdges = new Map([...pairs].map(([key, values]) => [key, Object.freeze(values)]));incidence = bytes;
  };
  const edgeIncidence = (n: number) => {
    ordinal(n, raw.counts.edges);loadIncidence();
    return Object.freeze({left: incidence!.readUInt32LE((n - 1) * 8), right: incidence!.readUInt32LE((n - 1) * 8 + 4)});
  };
  const shardByOrdinal: (EdgeShard | undefined)[] = new Array(raw.counts.edges);
  const indexedShards = new Set<string>();
  let nextEdge = 1;
  for (const shard of details.edgeDetails) {
    if (shard.firstOrdinal !== nextEdge || !Number.isSafeInteger(shard.count) || shard.count < 1 || shard.firstOrdinal + shard.count > raw.counts.edges + 1 ||
        !/^topology\/\d{3}\.json\.gz$/.test(shard.shard) || shard.artifact.path !== `detail/${shard.shard}` || indexedShards.has(shard.shard)) throw Error('OPERATIONAL_EDGE_INDEX');
    indexedShards.add(shard.shard);
    for (let n = shard.firstOrdinal; n < shard.firstOrdinal + shard.count; n++) shardByOrdinal[n - 1] = shard;
    nextEdge += shard.count;
  }
  if (nextEdge !== raw.counts.edges + 1) throw Error('OPERATIONAL_EDGE_INDEX');
  // Only current catalog edges are loaded on demand; no old world incidence.
  const shards = new Map<string, readonly ExactEdge[]>();
  const edge = (n: number): ExactEdge => {
    ordinal(n, raw.counts.edges);
    const shard = shardByOrdinal[n - 1];
    if (!shard) throw Error('UNKNOWN_OPERATIONAL_EDGE');
    let values = shards.get(shard.shard);
    if (!values) {
      const data = gzip<{schemaVersion: string; edges: ExactEdge[]}>(shard.artifact.path);
      if (data.schemaVersion !== DELIVERY_SCHEMA || data.edges.length !== shard.count) throw Error('OPERATIONAL_EDGE_SHARD');
      values = Object.freeze(data.edges.map((e, i) => {
        ordinal(e.left); if (e.right) ordinal(e.right);
        if (e.ordinal !== shard.firstOrdinal + i || !/^edge:operational:[a-f0-9]{64}$/.test(e.id) || !(e.lengthKm > 0) || e.left === e.right || e.flags.positiveAdjacency !== (e.right > 0)) throw Error('OPERATIONAL_EDGE_MAPPING');
        const pair = edgeIncidence(e.ordinal);
        if (e.left !== pair.left || e.right !== pair.right) throw Error('OPERATIONAL_EDGE_INCIDENCE_MISMATCH');
        return Object.freeze({...e, flags: Object.freeze(e.flags)});
      }));
      shards.set(shard.shard, values);
    }
    return values[n - shard.firstOrdinal];
  };
  const sharedBoundary = (left: number, right: number) => {
    ordinal(left); ordinal(right);
    if (!neighbors(left).includes(right)) throw Error('NO_OPERATIONAL_LAND_BOUNDARY');
    let selected: ExactEdge | undefined;
    loadIncidence();
    for (const n of pairEdges!.get(pairKey(left, right)) ?? []) {
      const e = edge(n);
      if (((e.left === left && e.right === right) || (e.left === right && e.right === left)) && (!selected || e.lengthKm > selected.lengthKm)) selected = e;
    }
    if (!selected) throw Error('NO_OPERATIONAL_LAND_BOUNDARY');
    let longest = 0, start = selected.geometry.coordinates[0], end = start;
    selected.geometry.coordinates.slice(1).forEach((b, i) => {
      const a = selected!.geometry.coordinates[i], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length > longest) {longest = length; start = a; end = b;}
    });
    return Object.freeze({edgeOrdinal: selected.ordinal, start: Object.freeze([...start]) as readonly [number, number], end: Object.freeze([...end]) as readonly [number, number]});
  };
  let contract: WorldGeometryCatalogContract | undefined;
  const worldContract = (): WorldGeometryCatalogContract => {
    if (contract) return contract; loadAll();
    const territoryOrder = Object.freeze(byOrdinal.map(c => c!.id));
    if (sha(Buffer.from(`${JSON.stringify(territoryOrder)}\n`)) !== raw.indexRoots.catalogOrder) throw Error('OPERATIONAL_CATALOG_ORDER');
    return contract = Object.freeze({ref, territoryOrder, territoriesById: Object.freeze(Object.fromEntries(byOrdinal.map(c => [c!.id, Object.freeze({id: c!.id, sourceCountryId: c!.sourceCountryId})])))});
  };
  return Object.freeze({descriptor, ref, administrativeParents, previousParents, loadCountry, cell, cellMetrics, administrativeMembership, previousMembership,
    neighbors, sharedBoundary, edgeIncidence, edge, worldContract, deliveryArtifact: artifact, readDeliveryAsset: deliveryBytes,
    assertRef: (actual: typeof ref) => assertWorldGeometryCatalogRefMatches(actual, ref),
    countryDetail: (id: string) => {const c = countries.get(id); if (!c) throw Error('UNKNOWN_OPERATIONAL_COUNTRY'); return c;},
    readRegionNames: () => new Map(Object.entries(gzip<Record<string, Record<string, string | number | null>>>('region-names.json.gz'))),
  });
}
export type OperationalCatalog = ReturnType<typeof prepareOperationalCatalog>;
let catalog: OperationalCatalog | undefined;
export const loadOperationalCatalog = () => catalog ??= prepareOperationalCatalog();
