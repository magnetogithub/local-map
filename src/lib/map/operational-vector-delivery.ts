import {z} from 'zod';
import type {Feature, FeatureCollection, LineString, MultiLineString, MultiPolygon, Polygon} from 'geojson';
import type {VectorSourceSpecification} from 'maplibre-gl';
import {VectorTile} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
import type {OperationalAdministrativeParent, OperationalCell, OperationalEdge, OperationalPreviousParent} from '../world/operational-catalog';
import {readCatalogTerritoryId, type WorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';
import {catalogArtifactIdentity, type CatalogArtifactIdentity} from './catalog-consumer-contract';
import {verifyCatalogResponse, type CatalogFetch} from './catalog-vector-delivery';
import {assertOperationalDeliveryRef, OPERATIONAL_DELIVERY_SCHEMA, OPERATIONAL_MAP_SOURCE_ID, readOperationalMapBootstrap} from './operational-delivery-contract';
import type {RenderFeatureRef} from './render-feature-ref';

const integer = z.number().int().nonnegative().max(0xffffffff), positive = integer.positive();
const artifactSchema = z.strictObject({path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: integer});
const countrySchema = z.strictObject({countryId: z.string().regex(/^[A-Z]{3}$/), cellCount: positive, metadata: artifactSchema, detail: artifactSchema});
const shardSchema = z.strictObject({shard: z.string(), firstOrdinal: positive, count: positive, artifact: artifactSchema});
const indexSchema = z.object({schemaVersion: z.literal(OPERATIONAL_DELIVERY_SCHEMA), ref: z.unknown()});
const coordinate = z.array(z.number().finite()).min(2).max(3);
const polygon = z.array(z.array(coordinate).min(4)).min(1);
const polygonSchema = z.discriminatedUnion('type', [z.object({type: z.literal('Polygon'), coordinates: polygon}),
  z.object({type: z.literal('MultiPolygon'), coordinates: z.array(polygon).min(1)})]);
const lineSchema = z.discriminatedUnion('type', [z.object({type: z.literal('LineString'), coordinates: z.array(coordinate).min(2)}),
  z.object({type: z.literal('MultiLineString'), coordinates: z.array(z.array(coordinate).min(2)).min(1)})]);
const edgeSchema = z.object({id: z.string().regex(/^edge:operational:[a-f0-9]{64}$/), ordinal: positive, left: positive, right: integer,
  boundaryClass: z.enum(['coast', 'country', 'administrative', 'operational', 'residual']),
  flags: z.object({positiveAdjacency: z.boolean(), country: z.boolean(), administrative: z.boolean(), previous: z.boolean(), residual: z.boolean()}), geometry: lineSchema});
const decoder = new TextDecoder();
type CellHint = Readonly<{id: string; sourceCountryId: string}>;
type ExactCells = FeatureCollection<Polygon | MultiPolygon>;
type ExactEdge = Omit<OperationalEdge, 'lengthKm'> & Readonly<{geometry: LineString | MultiLineString}>;

/** V3 transport keeps ordinals numeric. It never constructs a v1 metadata/world surrogate. */
export async function loadOperationalVectorDelivery(value: unknown, expected: WorldGeometryCatalogRef, fetcher: CatalogFetch = fetch, signal?: AbortSignal) {
  const bootstrap = readOperationalMapBootstrap(value, expected), {catalog} = bootstrap, {counts} = catalog;
  const base = `/data/territory-catalog/${expected.catalogVersion}/`;
  const identity = (a: z.infer<typeof artifactSchema>) => catalogArtifactIdentity({...a, path: base + a.path}, expected);
  const ordinal = (value: number, max: number) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw Error('INVALID_OPERATIONAL_ORDINAL');
    return value;
  };
  // Cache decoded bytes, not mutable GeoJSON objects. All entry points share this bounded LRU.
  const cache = new Map<string, ArrayBuffer>();
  let cachedBytes = 0, verifiedRequests = 0, cacheHits = 0;
  const read = async (a: CatalogArtifactIdentity, s?: AbortSignal): Promise<ArrayBuffer> => {
    s?.throwIfAborted();
    const old = cache.get(a.path);
    if (old) {cache.delete(a.path); cache.set(a.path, old); cacheHits++; return old.slice(0);}
    const compressed = await verifyCatalogResponse(await fetcher(a.path, {signal: s, cache: 'force-cache', redirect: 'error'}), a, s);
    const bytes = a.path.endsWith('.gz') ? await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : compressed;
    s?.throwIfAborted(); verifiedRequests++;
    if (bytes.byteLength <= 32 * 1024 * 1024) {
      const replaced = cache.get(a.path); if (replaced) cachedBytes -= replaced.byteLength;
      cache.delete(a.path); cache.set(a.path, bytes); cachedBytes += bytes.byteLength;
      while (cache.size > 256 || cachedBytes > 32 * 1024 * 1024) {
        const first = cache.keys().next().value!; cachedBytes -= cache.get(first)!.byteLength; cache.delete(first);
      }
    }
    return bytes.slice(0);
  };
  const json = async (a: CatalogArtifactIdentity, s?: AbortSignal) => JSON.parse(decoder.decode(await read(a, s)));
  const manifest = await json(bootstrap.manifest, signal);
  indexSchema.parse(manifest); assertOperationalDeliveryRef(manifest.ref, catalog);
  if (manifest.sourceId !== OPERATIONAL_MAP_SOURCE_ID || manifest.minZoom !== 0 || manifest.maxZoom !== 6 || manifest.promoteId !== null ||
      manifest.tileTemplate !== 'tiles/{z}/{x}/{y}.pbf.gz' || Object.entries(counts).some(([key, n]) => manifest.counts?.[key] !== n) ||
      manifest.policy?.tileTransport?.compression !== 'gzip' || manifest.policy.tileTransport.httpContentEncoding !== null ||
      manifest.policy.administrativeMinZoom !== 4 || manifest.policy.operationalMinZoom !== 8) throw Error('INVALID_OPERATIONAL_MANIFEST');
  for (const [a, expectedIdentity] of [[manifest.tileIndex, bootstrap.tileIndex], [manifest.detailIndex, bootstrap.detailIndex]] as const) {
    const actual = identity(artifactSchema.parse(a));
    if (JSON.stringify(actual) !== JSON.stringify(expectedIdentity)) throw Error('OPERATIONAL_INDEX_IDENTITY');
  }
  const tileRaw = await json(bootstrap.tileIndex, signal);
  const tiles = z.object({artifacts: z.array(artifactSchema)}).parse(tileRaw);
  const detailRaw = await json(bootstrap.detailIndex, signal);
  const detail = z.object({countries: z.array(countrySchema), edgeDetails: z.array(shardSchema), lazy: z.literal(true),
    parents: z.literal('metadata/parents.json.gz'), lodCoverage: z.literal('lod-coverage.json.gz')}).parse(detailRaw);
  for (const raw of [tileRaw, detailRaw]) {
    indexSchema.parse(raw); assertOperationalDeliveryRef(raw.ref, catalog);
  }
  const tileArtifacts = new Map<string, CatalogArtifactIdentity>(); let index = 0;
  for (let z = 0; z <= 6; z++) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) {
    const a = identity(artifactSchema.parse(tiles.artifacts[index++]));
    if (a.path !== `${base}tiles/${z}/${x}/${y}.pbf.gz`) throw Error('INVALID_OPERATIONAL_TILE_INDEX');
    tileArtifacts.set(a.path, a);
  }
  if (index !== tiles.artifacts.length || detail.countries.length !== counts.countries ||
      detail.countries.reduce((n, c) => n + c.cellCount, 0) !== counts.cells ||
      detail.countries.some((c, i) => c.countryId !== catalog.countryOrder[i] || c.metadata.path !== `metadata/countries/${c.countryId}.json.gz` || c.detail.path !== `detail/countries/${c.countryId}.geojson.gz`)) throw Error('INVALID_OPERATIONAL_DETAIL_INDEX');
  let edgeEnd = 1;
  for (const shard of detail.edgeDetails) {
    if (shard.firstOrdinal !== edgeEnd || !/^topology\/\d{3}\.json\.gz$/.test(shard.shard) || shard.artifact.path !== `detail/${shard.shard}`) throw Error('INVALID_OPERATIONAL_EDGE_INDEX');
    identity(shard.artifact); edgeEnd += shard.count;
  }
  if (edgeEnd !== counts.edges + 1) throw Error('INVALID_OPERATIONAL_EDGE_INDEX');
  const spec = manifest.edgeIncidence;
  if (spec?.format !== 'uint32-le-pairs' || spec.recordBytes !== 8 || spec.recordCount !== counts.edges || spec.decodedByteLength !== counts.edges * 8 || spec.artifact?.path !== 'metadata/edge-incidence.bin.gz') throw Error('INVALID_OPERATIONAL_INCIDENCE');
  const incidenceBytes = await read(identity(artifactSchema.parse(spec.artifact)), signal);
  if (incidenceBytes.byteLength !== counts.edges * 8) throw Error('INVALID_OPERATIONAL_INCIDENCE');
  const incidence = new DataView(incidenceBytes);
  const edgeIncidence = (n: number) => {
    ordinal(n, counts.edges);
    const left = incidence.getUint32((n - 1) * 8, true), right = incidence.getUint32((n - 1) * 8 + 4, true);
    ordinal(left, counts.cells); if (right) ordinal(right, counts.cells);
    if (left === right) throw Error('INVALID_OPERATIONAL_INCIDENCE');
    return Object.freeze({left, right});
  };
  // Build the static reverse incidence once, rather than scanning all edges on every turn.
  let edgeOffsets: Uint32Array | undefined, edgesByCell: Uint32Array | undefined;
  const incidentEdges = (cellOrdinals: readonly number[]) => {
    cellOrdinals.forEach(n => ordinal(n, counts.cells));
    if (!cellOrdinals.length) return [];
    if (!edgeOffsets) {
      const offsets = new Uint32Array(counts.cells + 1);
      for (let n = 1; n <= counts.edges; n++) {
        const {left, right} = edgeIncidence(n); offsets[left]++; if (right) offsets[right]++;
      }
      for (let n = 1; n <= counts.cells; n++) offsets[n] += offsets[n - 1];
      const edges = new Uint32Array(offsets[counts.cells]), cursor = offsets.slice(0, counts.cells);
      for (let n = 1; n <= counts.edges; n++) {
        const {left, right} = edgeIncidence(n); edges[cursor[left - 1]++] = n; if (right) edges[cursor[right - 1]++] = n;
      }
      edgeOffsets = offsets; edgesByCell = edges;
    }
    const found = new Set<number>();
    for (const n of cellOrdinals) for (let i = edgeOffsets[n - 1]; i < edgeOffsets[n]; i++) found.add(edgesByCell![i]);
    return [...found].sort((a, b) => a - b);
  };
  const countries = new Map(detail.countries.map(c => [c.countryId, c]));
  const country = (id: string) => {const c = countries.get(id); if (!c) throw Error('UNKNOWN_OPERATIONAL_COUNTRY'); return c;};
  const countryCells = new Map<string, readonly OperationalCell[]>();
  const loadCountry = async (countryId: string, s?: AbortSignal): Promise<readonly OperationalCell[]> => {
    s?.throwIfAborted(); const c = country(countryId), old = countryCells.get(countryId);
    if (old) {countryCells.delete(countryId); countryCells.set(countryId, old); return old;}
    const metadata = z.object({countryId: z.literal(countryId), columns: z.tuple([z.literal('cellOrdinal'), z.literal('cellId'), z.literal('administrativeOrdinal'), z.literal('previousParentOrdinal')]),
      rows: z.array(z.tuple([positive, z.string(), positive, positive]))}).parse(await json(identity(c.metadata), s));
    const seen = new Set<string>();
    const cells = metadata.rows.map(([n, id, a, p], i) => {
      ordinal(n, counts.cells); ordinal(a, counts.administrativeParents); ordinal(p, counts.previousParents);
      if ((i > 0 && metadata.rows[i - 1][0] >= n) || seen.has(id)) throw Error('INVALID_OPERATIONAL_CELL_MAPPING');
      seen.add(id);
      return Object.freeze({id: readCatalogTerritoryId(id), ordinal: n, sourceCountryId: countryId, administrativeOrdinal: a, previousParentOrdinal: p}) as OperationalCell;
    });
    if (cells.length !== c.cellCount) throw Error('INVALID_OPERATIONAL_COUNTRY_COUNT');
    if (countryCells.size >= 16) countryCells.delete(countryCells.keys().next().value!);
    countryCells.set(countryId, Object.freeze(cells)); return countryCells.get(countryId)!;
  };
  const resolveCells = async (hints: readonly CellHint[], s?: AbortSignal) => {
    const found = new Map<string, OperationalCell>();
    for (const countryId of new Set(hints.map(c => c.sourceCountryId))) {
      const byId = new Map((await loadCountry(countryId, s)).map(c => [c.id as string, c]));
      for (const hint of hints) if (hint.sourceCountryId === countryId) {
        const cell = byId.get(hint.id); if (!cell) throw Error('UNKNOWN_OPERATIONAL_CELL'); found.set(hint.id, cell);
      }
    }
    return hints.map(c => found.get(c.id)!);
  };
  const loadCountryDetail = async (countryId: string, s?: AbortSignal): Promise<ExactCells> => {
    const cells = await loadCountry(countryId, s), bytes = await json(identity(country(countryId).detail), s);
    const fc = z.object({type: z.literal('FeatureCollection'), features: z.array(z.object({type: z.literal('Feature'), id: positive, properties: z.record(z.string(), z.unknown()), geometry: polygonSchema}))}).parse(bytes);
    if (fc.features.length !== cells.length || fc.features.some((f, i) => f.id !== cells[i].ordinal)) throw Error('INVALID_OPERATIONAL_EXACT_CELLS');
    return fc as ExactCells;
  };
  const loadCellDetail = async (hints: readonly CellHint[], s?: AbortSignal): Promise<ExactCells> => {
    const selected = await resolveCells(hints, s), ids = new Set(selected.map(c => c.ordinal));
    const features: ExactCells['features'] = [];
    for (const countryId of new Set(selected.map(c => c.sourceCountryId))) {
      features.push(...(await loadCountryDetail(countryId, s)).features.filter(f => ids.has(f.id as number)));
    }
    if (features.length !== ids.size) throw Error('MISSING_OPERATIONAL_EXACT_CELLS');
    return {type: 'FeatureCollection', features: features.sort((a, b) => Number(a.id) - Number(b.id))};
  };
  const loadEdgeDetails = async (ordinals: readonly number[], s?: AbortSignal): Promise<readonly ExactEdge[]> => {
    const wanted = new Set(ordinals.map(n => ordinal(n, counts.edges))), found = new Map<number, ExactEdge>();
    for (const shard of detail.edgeDetails) {
      if (![...wanted].some(n => n >= shard.firstOrdinal && n < shard.firstOrdinal + shard.count)) continue;
      const raw = await json(identity(shard.artifact), s);
      const data = z.object({schemaVersion: z.literal(OPERATIONAL_DELIVERY_SCHEMA), edges: z.array(edgeSchema)}).parse(raw);
      if (data.edges.length !== shard.count) throw Error('INVALID_OPERATIONAL_EXACT_EDGES');
      data.edges.forEach((e, i) => {
        const pair = edgeIncidence(e.ordinal);
        if (e.ordinal !== shard.firstOrdinal + i || e.left !== pair.left || e.right !== pair.right || e.flags.positiveAdjacency !== (e.right > 0)) throw Error('INVALID_OPERATIONAL_EXACT_EDGE');
        if (wanted.has(e.ordinal)) found.set(e.ordinal, e as ExactEdge);
      });
    }
    if (found.size !== wanted.size) throw Error('MISSING_OPERATIONAL_EXACT_EDGES');
    return ordinals.map(n => found.get(n)!);
  };
  const loadParents = async (s?: AbortSignal) => {
    const parent = z.object({sourceCountryId: z.string(), start: integer, count: positive});
    const data = z.object({administrative: z.array(parent.extend({parentKey: z.string()}).passthrough()), previous: z.array(parent.extend({oldTerritoryId: z.string()}).passthrough())}).parse(await json(bootstrap.parents, s));
    if (data.administrative.length !== counts.administrativeParents || data.previous.length !== counts.previousParents) throw Error('INVALID_OPERATIONAL_PARENTS');
    for (const parents of [data.administrative, data.previous]) for (const p of parents) country(p.sourceCountryId);
    if (new Set(data.administrative.map(p => p.parentKey)).size !== data.administrative.length ||
        new Set(data.previous.map(p => p.oldTerritoryId)).size !== data.previous.length) throw Error('INVALID_OPERATIONAL_PARENT_MAPPING');
    return {administrative: data.administrative.map((p, i) => ({...p, ordinal: i + 1}) as OperationalAdministrativeParent),
      previous: data.previous.map((p, i) => ({...p, oldTerritoryId: readCatalogTerritoryId(p.oldTerritoryId), ordinal: i + 1}) as OperationalPreviousParent)};
  };
  const administrativeMembership = async (parentKey: string, s?: AbortSignal) => {
    const parents = await loadParents(s), parent = parents.administrative.find(p => p.parentKey === parentKey);
    if (!parent) throw Error('UNKNOWN_OPERATIONAL_ADMINISTRATIVE_PARENT');
    const members = (await loadCountry(parent.sourceCountryId, s)).filter(c => c.administrativeOrdinal === parent.ordinal);
    if (!members.length) throw Error('INVALID_OPERATIONAL_MEMBERSHIP');
    return members; // Complete stored membership; the action cap belongs to the command validator.
  };
  const loadCoverage = async (s?: AbortSignal) => {
    const data = z.object({schemaVersion: z.literal(OPERATIONAL_DELIVERY_SCHEMA), cellCount: positive, edgeCount: positive, exactCells: positive, exactEdges: positive,
      missingOverviewCellOrdinals: z.array(positive), missingOverviewEdgeOrdinals: z.array(positive)}).parse(await json(bootstrap.coverage, s));
    if (data.cellCount !== counts.cells || data.edgeCount !== counts.edges || data.exactCells !== counts.cells || data.exactEdges !== counts.edges) throw Error('INVALID_OPERATIONAL_COVERAGE');
    for (const [values, max] of [[data.missingOverviewCellOrdinals, counts.cells], [data.missingOverviewEdgeOrdinals, counts.edges]] as const) {
      values.forEach((n, i) => {ordinal(n, max); if (i > 0 && values[i - 1] >= n) throw Error('INVALID_OPERATIONAL_COVERAGE');});
    }
    return data;
  };
  type TileFeatures = Readonly<{cells: readonly number[]; edges: readonly number[]}>;
  const featureListeners = new Set<(features: TileFeatures) => void>();
  const seenCells = new Set<number>(), seenEdges = new Set<number>();
  const indexTile = (bytes: ArrayBuffer) => {
    const tile = new VectorTile(new PbfReader(new Uint8Array(bytes)) as unknown as ConstructorParameters<typeof VectorTile>[0]);
    const cells = new Set<number>(), edges = new Set<number>();
    for (const [name, layer] of Object.entries(tile.layers)) {
      if (!['territories', 'edges', 'administrative'].includes(name)) throw Error('INVALID_OPERATIONAL_TILE_LAYER');
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i); ordinal(f.id!, name === 'territories' ? counts.cells : counts.edges);
        (name === 'territories' ? cells : edges).add(f.id!);
        if (name !== 'territories') {
          edgeIncidence(f.id!);
          if (!Number.isInteger(f.properties.c) || Number(f.properties.c) < 0 || Number(f.properties.c) > 4 ||
              ![0, 1].includes(Number(f.properties.a)) || (name === 'administrative' && Number(f.properties.a) !== 1)) throw Error('INVALID_OPERATIONAL_TILE_EDGE');
        }
      }
    }
    const added = {cells: [...cells].filter(n => !seenCells.has(n)), edges: [...edges].filter(n => !seenEdges.has(n))};
    added.cells.forEach(n => seenCells.add(n)); added.edges.forEach(n => seenEdges.add(n));
    if (added.cells.length || added.edges.length) for (const listener of featureListeners) listener(added);
  };
  const loadTile = async (path: string, s?: AbortSignal) => {
    const a = tileArtifacts.get(path); if (!a) throw Error('UNREGISTERED_OPERATIONAL_TILE');
    const bytes = await read(a, s); indexTile(bytes);
    return bytes;
  };
  const observeTileFeatures = (listener: (features: TileFeatures) => void) => {
    featureListeners.add(listener);
    try {listener({cells: [...seenCells], edges: [...seenEdges]});} catch (error) {featureListeners.delete(listener); throw error;}
    return () => {featureListeners.delete(listener);};
  };
  const protocol = `pax-operational-${expected.catalogVersion.slice('catalog-v3-'.length)}`;
  // OperationalWorldMap supplies linked source/license credits. Keep the source's
  // duplicate credit short; full provenance remains in the immutable manifest.
  const source: VectorSourceSpecification = {type: 'vector', tiles: [`${protocol}://${base}${manifest.tileTemplate}`], minzoom: 0, maxzoom: 6, attribution: 'Natural Earth'};
  const renderRef = (sourceLayer: 'territories' | 'edges' | 'administrative', n: number): RenderFeatureRef => ({sourceType: 'vector', sourceId: OPERATIONAL_MAP_SOURCE_ID,
    sourceLayer, featureId: ordinal(n, sourceLayer === 'territories' ? counts.cells : counts.edges)});
  return Object.freeze({bootstrap, source, protocol, loadTile, edgeIncidence, incidentEdges, observeTileFeatures, loadCountry, resolveCells, loadCountryDetail, loadCellDetail, loadEdgeDetails,
    loadParents, administrativeMembership, loadCoverage, renderRef,
    counters: () => ({verifiedRequests, cacheHits, cachedEntries: cache.size, cachedBytes, cachedCountries: countryCells.size})});
}
export type OperationalVectorDelivery = Awaited<ReturnType<typeof loadOperationalVectorDelivery>>;
export async function fetchOperationalVectorDelivery(expected: WorldGeometryCatalogRef, fetcher: CatalogFetch = fetch, signal?: AbortSignal) {
  const response = await fetcher('/api/world/catalog/operational/map', {signal, cache: 'no-store', redirect: 'error'});
  if (!response.ok || response.redirected) throw Error('OPERATIONAL_MAP_NOT_READY');
  return loadOperationalVectorDelivery(await response.json(), expected, fetcher, signal);
}

/** Exact edge features retain numeric IDs so the later projection can share feature-state targets. */
export function operationalEdgeFeatures(edges: readonly ExactEdge[]): FeatureCollection<LineString | MultiLineString> {
  return {type: 'FeatureCollection', features: edges.map(e => ({type: 'Feature', id: e.ordinal, properties: {left: e.left, right: e.right, boundaryClass: e.boundaryClass, administrative: e.flags.administrative}, geometry: e.geometry}) as Feature<LineString | MultiLineString>)};
}
