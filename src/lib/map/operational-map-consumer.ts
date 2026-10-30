import type {Feature, FeatureCollection, LineString, MultiLineString, MultiPolygon, Polygon} from 'geojson';
import type {ExpressionSpecification, GeoJSONSourceDiff, LayerSpecification, SourceSpecification} from 'maplibre-gl';
import type {OperationalStateChange} from '../world/operational-catalog';
import {mapColorPresentation} from '../world/country-map-color';
import {createOperationalMapProjection, operationalCellView, operationalFront, prepareOperationalMapUpdate, type OperationalMapWorld} from '../projection/operational-map-projection';
import {OPERATIONAL_MAP_SOURCE_ID} from './operational-delivery-contract';
import {createOperationalMapSources, OperationalMapSourceWriteError, OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID, OPERATIONAL_EXACT_SOURCE_OPTIONS} from './operational-map-sources';
import {fetchOperationalVectorDelivery, operationalEdgeFeatures, type OperationalVectorDelivery} from './operational-vector-delivery';
import {registerCatalogTileProtocol, type CatalogFetch} from './catalog-vector-delivery';
import {OPERATIONAL_COUNTRY_BORDER_OPACITY, OPERATIONAL_DEBUG_BOUNDARY_PAINT, OPERATIONAL_LEGACY_BOUNDARY_PAINT, operationalCountryBorderWidth} from './operational-boundary-style';
import {OPERATIONAL_FILL_COLOR} from './operational-fill-paint';
import type {OperationalViewportBounds} from './operational-vector-delivery';
import {createOperationalDebugBoundaryScopeIndex, type OperationalDebugBoundaryScope} from './operational-debug-boundary-scope';

export const OPERATIONAL_CHANGED_CELL_SOURCE_ID = 'world-operational-changed-cells';
export const OPERATIONAL_FRONT_SOURCE_ID = 'world-operational-front-detail';
export const OPERATIONAL_PROVINCE_LOD_SOURCE_ID = 'world-operational-province-display-lod';
export const OPERATIONAL_MICRO_LOD_SOURCE_ID = 'world-operational-micro-display-lod';
export const OPERATIONAL_MAP_LAYERS = {
  fill: 'operational-fill', detailFill: 'operational-detail-fill', changedFill: 'operational-changed-fill',
  occupation: 'operational-occupation', detailOccupation: 'operational-detail-occupation', changedOccupation: 'operational-changed-occupation',
  hover: 'operational-hover', detailHover: 'operational-detail-hover', changedHover: 'operational-changed-hover',
  selected: 'operational-selected', detailSelected: 'operational-detail-selected', changedSelected: 'operational-changed-selected',
  country: 'operational-country-border', administrative: 'operational-administrative-border', synthetic: 'operational-cell-grid',
  detailCountry: 'operational-detail-country-border', detailAdministrative: 'operational-detail-administrative-border', detailSynthetic: 'operational-detail-cell-grid',
  front: 'operational-front', detailFront: 'operational-detail-front',
  provinceDisplayLod: 'operational-province-display-lod', provinceOriginal: 'operational-province-original', detailProvinceOriginal: 'operational-detail-province-original',
  microDisplayLod: 'operational-micro-display-lod', microOriginal: 'operational-micro-original', detailMicroOriginal: 'operational-detail-micro-original',
} as const;
type Hit = {id?: string | number; source?: string; sourceLayer?: string};
type MapEvent = {features?: Hit[]};
export type OperationalMapPort = {
  addSource: (id: string, source: SourceSpecification) => unknown; removeSource: (id: string) => unknown; getSource: (id: string) => unknown;
  addLayer: (layer: LayerSpecification) => unknown; removeLayer: (id: string) => unknown; getLayer: (id: string) => unknown;
  setLayoutProperty: (id: string, name: string, value: unknown) => unknown;
  setFilter: (id: string, filter: import('maplibre-gl').FilterSpecification) => unknown;
  setFeatureState: (target: {source: string; sourceLayer?: string; id: string | number}, state: Record<string, unknown>) => unknown;
  removeFeatureState: (target: {source: string; sourceLayer?: string; id: string | number}) => unknown;
  on: (event: string, layer: string, listener: (event: MapEvent) => void) => unknown;
  off: (event: string, layer: string, listener: (event: MapEvent) => void) => unknown;
};
type CellFeature = Feature<Polygon | MultiPolygon>;
type EdgeFeature = Feature<LineString | MultiLineString>;
type CellCountries = Readonly<{ownerCountryId: string | null; controllerCountryId: string | null}>;
const empty = (): FeatureCollection => ({type: 'FeatureCollection', features: []});
type Input = {map: OperationalMapPort; protocolApi: Parameters<typeof registerCatalogTileProtocol>[0]; delivery: OperationalVectorDelivery; world: OperationalMapWorld; externalHover?: boolean;
  signal?: AbortSignal; onSelect?: (id: string | null) => void; onHover?: (id: string | null) => void; onTerritorySelect?: (id: string | null) => void};

/** B branch: renders only the supplied authoritative snapshots/deltas, without mutating the world. */
export async function createOperationalMapConsumer(input: Input) {
  const {map, delivery, onSelect, onHover, onTerritorySelect} = input, L = OPERATIONAL_MAP_LAYERS;
  const legacyOrdinals = [...new Set([...(delivery.bootstrap.legacyBoundaryOrdinals ?? []), ...(delivery.bootstrap.provincePresentationBoundaryOrdinals ?? [])])];
  const provinceLod = delivery.bootstrap.provinceBoundaryLod;
  const microLod = delivery.bootstrap.microBoundaryLod, microLodIds = new Set(microLod?.edgeOrdinals ?? []);
  // MapLibre compiles match labels into a lookup table; in(array) scans every label per edge.
  const legacyBoundary: ExpressionSpecification = legacyOrdinals.length
    ? ['match', ['id'], [...legacyOrdinals], true, false] : ['==', ['id'], -1];
  const microBoundary = ['all', ['!', legacyBoundary], ['in', ['get', 'c'], ['literal', [2, 3, 4]]]] as const;
  const exactMicroBoundary = ['all', ['!', legacyBoundary], ['in', ['get', 'boundaryClass'], ['literal', ['administrative', 'operational', 'residual']]]] as const;
  const noDebugEdges: ExpressionSpecification = ['==', ['id'], -1];
  const provinceBoundary: ExpressionSpecification = ['match', ['id'], [...delivery.bootstrap.provincePresentationBoundaryOrdinals ?? []], true, false];
  const ordinaryLegacyBoundary = provinceLod ? ['all', legacyBoundary, ['!', provinceBoundary]] : legacyBoundary;
  const chnMicroBoundary: ExpressionSpecification = microLod ? ['match', ['id'], [...microLod.edgeOrdinals], true, false] : noDebugEdges;
  const ordinaryMicroBoundary = microLod ? ['all', microBoundary, ['!', chnMicroBoundary]] : microBoundary;
  const ordinaryExactMicroBoundary = microLod ? ['all', exactMicroBoundary, ['!', chnMicroBoundary]] : exactMicroBoundary;
  let projection = createOperationalMapProjection(input.world, delivery.bootstrap.catalog.catalogRef, delivery.bootstrap.catalog.counts.cells);
  for (const country of Object.values(input.world.countriesById)) mapColorPresentation(country.mapColor);
  const ownedSources = [OPERATIONAL_CHANGED_CELL_SOURCE_ID, OPERATIONAL_FRONT_SOURCE_ID, ...(provinceLod ? [OPERATIONAL_PROVINCE_LOD_SOURCE_ID] : []), ...(microLod ? [OPERATIONAL_MICRO_LOD_SOURCE_ID] : [])];
  if (Object.values(L).some(id => map.getLayer(id)) || ownedSources.some(id => map.getSource(id))) throw Error('OPERATIONAL_MAP_ALREADY_MOUNTED');
  input.signal?.throwIfAborted();
  const sources = createOperationalMapSources(map, input.protocolApi, delivery, ordinals => replaceDetailEdges(ordinals)), addedSources: string[] = [], addedLayers: string[] = [];
  const abort = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  let disposed = false, failed: unknown = null, selected: string | null = null, hovered: string | null = null, detailRequest = 0;
  let queue: Promise<unknown> = Promise.resolve(), stopFeatures = () => {};
  const vectorCells = new Set<number>(), detailCells = new Set<number>(), exactCells = new Map<number, CellFeature>(), exactFronts = new Map<number, EdgeFeature>();
  const interactionCells = new Map<string, Set<number>>(), controllerCells = new Map<string, Set<number>>();
  const frontOverrides = new Map<number, {front: boolean; exactFront: boolean}>();
  const detailEdges = new Set<number>();
  const emptyDebugScope: OperationalDebugBoundaryScope = Object.freeze({countryIds: Object.freeze([]), edgeOrdinals: Object.freeze([])});
  let debugEnabled = false, debugScope = emptyDebugScope;
  let debugIndex: ReturnType<typeof createOperationalDebugBoundaryScopeIndex> | undefined;
  let provinceLodPublished = false, provinceLodActive = false;
  let microLodPublished = false, microLodActive = false, microLodInScope = false;
  const stats = {fullProjectionBuilds: 1, updates: 0, cellsUpdated: 0, edgesExamined: 0, exactCellsAdded: 0, exactFrontsAdded: 0, exactFrontsRemoved: 0,
    debugBoundaryScopeBuilds: 0, debugBoundaryFilterWrites: 0,
    provinceDisplayLodVertexCount: 0, provinceDisplayLodSourceWrites: 0, microDisplayLodVertexCount: 0, microDisplayLodSourceWrites: 0};
  const addLayer = (layer: LayerSpecification) => {map.addLayer(layer); addedLayers.push(layer.id);};
  const geoSource = (id: string) => {
    const source = map.getSource(id) as {updateData?: (diff: GeoJSONSourceDiff) => unknown} | undefined;
    if (typeof source?.updateData !== 'function') throw Error('OPERATIONAL_INCREMENTAL_SOURCE_MISSING');
    return source as {updateData: (diff: GeoJSONSourceDiff) => unknown};
  };
  const check = () => {if (disposed) throw Error('OPERATIONAL_MAP_DISPOSED'); if (failed) throw Error('OPERATIONAL_MAP_RESYNC_REQUIRED'); signal.throwIfAborted();};
  const syncDebugVisibility = () => {
    for (const id of [L.synthetic, L.detailSynthetic]) map.setLayoutProperty(id, 'visibility', debugEnabled ? 'visible' : 'none');
    if (microLod) {
      for (const id of [L.microOriginal, L.detailMicroOriginal]) map.setLayoutProperty(id, 'visibility', debugEnabled && !microLodActive ? 'visible' : 'none');
      map.setLayoutProperty(L.microDisplayLod, 'visibility', debugEnabled && microLodActive ? 'visible' : 'none');
    }
  };
  const updateDebugScope = () => {
    let next = emptyDebugScope;
    if (debugEnabled && hovered) {
      if (!debugIndex) {
        debugIndex = createOperationalDebugBoundaryScopeIndex({world: projection.world, edgeCount: delivery.bootstrap.catalog.counts.edges, edgeIncidence: delivery.edgeIncidence});
        stats.debugBoundaryScopeBuilds++;
      }
      next = debugIndex.scope(hovered);
    }
    if (next === debugScope) return;
    const allowed: ExpressionSpecification = next.edgeOrdinals.length ? ['match', ['id'], [...next.edgeOrdinals], true, false] : noDebugEdges;
    map.setFilter(L.synthetic, ['all', ordinaryMicroBoundary, allowed] as unknown as import('maplibre-gl').FilterSpecification);
    map.setFilter(L.detailSynthetic, ['all', ordinaryExactMicroBoundary, allowed] as unknown as import('maplibre-gl').FilterSpecification);
    if (microLod) {
      map.setFilter(L.microOriginal, ['all', microBoundary, chnMicroBoundary, allowed] as unknown as import('maplibre-gl').FilterSpecification);
      map.setFilter(L.detailMicroOriginal, ['all', exactMicroBoundary, chnMicroBoundary, allowed] as unknown as import('maplibre-gl').FilterSpecification);
      map.setFilter(L.microDisplayLod, allowed as import('maplibre-gl').FilterSpecification);
    }
    debugScope = next;
    microLodInScope = next.edgeOrdinals.some(id => microLodIds.has(id));
    if (!microLodInScope && microLodActive) {microLodActive = false; syncDebugVisibility();}
    stats.debugBoundaryFilterWrites++;
  };
  function replaceDetailEdges(ordinals: readonly number[]) {
    const next = new Set(ordinals);
    for (const n of detailEdges) if (!next.has(n)) {
      const target = {source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'edges', id: n};
      if (frontOverrides.has(n)) map.setFeatureState(target, {detailEdge: false}); else map.removeFeatureState(target);
    }
    for (const n of next) if (!detailEdges.has(n)) map.setFeatureState({source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'edges', id: n}, {detailEdge: true});
    detailEdges.clear(); next.forEach(n => detailEdges.add(n));
  }
  const hasCell = (n: number) => vectorCells.has(n) || detailCells.has(n) || exactCells.has(n);
  const updateIndex = (index: Map<string, Set<number>>, country: string | null, n: number, add: boolean) => {
    if (country === null) return;
    const members = index.get(country);
    if (add) {
      if (members) members.add(n); else index.set(country, new Set([n]));
    } else if (members) {
      members.delete(n); if (!members.size) index.delete(country);
    }
  };
  const indexCell = (n: number, cell: CellCountries, add: boolean) => {
    updateIndex(interactionCells, cell.ownerCountryId ?? cell.controllerCountryId, n, add);
    updateIndex(controllerCells, cell.controllerCountryId, n, add);
  };
  const writeCell = (n: number, state: Record<string, unknown>) => {
    if (vectorCells.has(n)) map.setFeatureState({source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'territories', id: n}, state);
    if (detailCells.has(n)) map.setFeatureState({source: OPERATIONAL_EXACT_CELL_SOURCE_ID, id: n}, state);
    if (exactCells.has(n)) map.setFeatureState({source: OPERATIONAL_CHANGED_CELL_SOURCE_ID, id: n}, state);
  };
  const applyCell = (n: number, onlySource?: string) => {
    if (!hasCell(n)) return;
    const cell = operationalCellView(projection.world, n), country = cell.ownerCountryId ?? cell.controllerCountryId;
    indexCell(n, cell, true);
    const state = {mapColor: cell.mapColor, selectionColor: cell.selectionColor, occupied: cell.occupied,
      hover: country !== null && country === hovered, selected: country !== null && country === selected};
    if (vectorCells.has(n) && (!onlySource || onlySource === OPERATIONAL_MAP_SOURCE_ID)) map.setFeatureState({source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'territories', id: n}, {...state, exactCell: exactCells.has(n) || detailCells.has(n)});
    if (detailCells.has(n) && (!onlySource || onlySource === OPERATIONAL_EXACT_CELL_SOURCE_ID)) map.setFeatureState({source: OPERATIONAL_EXACT_CELL_SOURCE_ID, id: n}, state);
    if (exactCells.has(n) && !onlySource) map.setFeatureState({source: OPERATIONAL_CHANGED_CELL_SOURCE_ID, id: n}, state);
    stats.cellsUpdated++;
  };
  const restoreVectorMask = (n: number) => {
    if (vectorCells.has(n)) map.setFeatureState({source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'territories', id: n}, {exactCell: exactCells.has(n) || detailCells.has(n)});
  };
  const removeDetailCellState = (n: number) => {
    map.removeFeatureState({source: OPERATIONAL_EXACT_CELL_SOURCE_ID, id: n});
    if (!hasCell(n)) indexCell(n, projection.world.territoriesById[projection.world.territoryOrder[n - 1]], false);
    restoreVectorMask(n);
  };
  const applyEdge = (n: number) => {
    const world = projection.world, pair = delivery.edgeIncidence(n), front = operationalFront(world, pair), exactFront = exactFronts.has(n);
    const previous = frontOverrides.get(n), target = {source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'edges', id: n};
    // Immutable country borders are peaceful by default. Only changed/restored
    // occupation contacts override this, without scanning every border.
    if (!front && !exactFront) {
      if (previous) {
        if (detailEdges.has(n)) map.setFeatureState(target, {front: false, exactFront: false, detailEdge: true}); else map.removeFeatureState(target);
        frontOverrides.delete(n);
      }
    } else if (!previous || previous.front !== front || previous.exactFront !== exactFront) {
      map.setFeatureState(target, {front, exactFront, ...(detailEdges.has(n) ? {detailEdge: true} : {})}); frontOverrides.set(n, {front, exactFront});
    }
  };
  const frontValue = (n: number, world: OperationalMapWorld) => operationalFront(world, delivery.edgeIncidence(n));
  const stageDetail = async (world: OperationalMapWorld, cells: readonly {id: string; sourceCountryId: string; ordinal: number}[], edges: readonly number[]) => {
    const missingCells = cells.filter(c => !exactCells.has(c.ordinal));
    const missingFronts = edges.filter(n => frontValue(n, world) && !exactFronts.has(n));
    const cellData = missingCells.length ? await delivery.loadCellDetail(missingCells, signal) : empty();
    const edgeData = missingFronts.length ? operationalEdgeFeatures(await delivery.loadEdgeDetails(missingFronts, signal)) : empty();
    check();
    const cellIds = new Set(missingCells.map(c => c.ordinal)), frontIds = new Set(missingFronts);
    if (cellData.features.length !== cellIds.size || cellData.features.some(f => !cellIds.delete(Number(f.id))) ||
        edgeData.features.length !== frontIds.size || edgeData.features.some(f => !frontIds.delete(Number(f.id)))) throw Error('OPERATIONAL_DETAIL_SCOPE_MISMATCH');
    return {cells: cellData.features as CellFeature[], fronts: edgeData.features as EdgeFeature[], remove: edges.filter(n => exactFronts.has(n) && !frontValue(n, world))};
  };
  const publishDetail = (data: Awaited<ReturnType<typeof stageDetail>>) => {
    // Check both ports before the first write; worker failures require an explicit remount.
    const cellSource = geoSource(OPERATIONAL_CHANGED_CELL_SOURCE_ID), frontSource = geoSource(OPERATIONAL_FRONT_SOURCE_ID);
    try {
      if (data.cells.length) cellSource.updateData({add: data.cells});
      if (data.fronts.length || data.remove.length) frontSource.updateData({...(data.fronts.length ? {add: data.fronts} : {}), ...(data.remove.length ? {remove: data.remove} : {})});
      for (const f of data.cells) exactCells.set(Number(f.id), f);
      for (const f of data.fronts) exactFronts.set(Number(f.id), f);
      for (const n of data.remove) exactFronts.delete(n);
      stats.exactCellsAdded += data.cells.length; stats.exactFrontsAdded += data.fronts.length; stats.exactFrontsRemoved += data.remove.length;
    } catch (error) {failed = error; throw error;}
  };
  const fillLayers = [L.fill, L.detailFill, L.changedFill] as const;
  const hit = (event: MapEvent) => {
    const f = event.features?.find(f => typeof f.id === 'number' && (f.source === OPERATIONAL_MAP_SOURCE_ID && f.sourceLayer === 'territories' || [OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_CHANGED_CELL_SOURCE_ID].includes(f.source ?? '')));
    return f ? operationalCellView(projection.world, Number(f.id)) : null;
  };
  const interaction = (kind: 'hover' | 'selected', id: string | null) => {
    check(); if (id !== null && !projection.world.countriesById[id]) throw Error('UNKNOWN_OPERATIONAL_MAP_COUNTRY');
    const old = kind === 'hover' ? hovered : selected; if (old === id) return;
    if (kind === 'hover') hovered = id; else selected = id;
    try {
      if (kind === 'hover') updateDebugScope();
      for (const [country, active] of [[old, false], [id, true]] as const) {
        if (country === null) continue;
        const state = {[kind]: active};
        for (const n of interactionCells.get(country) ?? []) {writeCell(n, state); stats.cellsUpdated++;}
      }
    } catch (error) {failed = error; throw error;}
  };
  const click = (event: MapEvent) => {const c = hit(event), country = c ? c.ownerCountryId ?? c.controllerCountryId : null; interaction('selected', country); onSelect?.(country); onTerritorySelect?.(c?.id ?? null);};
  const move = (event: MapEvent) => {const c = hit(event), country = c ? c.ownerCountryId ?? c.controllerCountryId : null; if (country === hovered) return; interaction('hover', country); onHover?.(country);};
  const leave = () => {if (hovered === null) return; interaction('hover', null); onHover?.(null);};
  const dispose = () => {
    if (disposed) return; disposed = true; abort.abort(); stopFeatures();
    interactionCells.clear(); controllerCells.clear(); detailEdges.clear();
    for (const layer of fillLayers) {map.off('click', layer, click); map.off('mousemove', layer, move); map.off('mouseleave', layer, leave);}
    for (const id of [...addedLayers].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [...addedSources].reverse()) if (map.getSource(id)) map.removeSource(id);
    sources.dispose();
  };
  try {
    for (const id of ownedSources) {map.addSource(id, {...OPERATIONAL_EXACT_SOURCE_OPTIONS, ...([OPERATIONAL_PROVINCE_LOD_SOURCE_ID, OPERATIONAL_MICRO_LOD_SOURCE_ID].includes(id) ? {maxzoom: 7} : {}), data: empty()}); addedSources.push(id);}
    const fills = [[L.fill, OPERATIONAL_MAP_SOURCE_ID], [L.detailFill, OPERATIONAL_EXACT_CELL_SOURCE_ID], [L.changedFill, OPERATIONAL_CHANGED_CELL_SOURCE_ID]] as const;
    for (const [fill, source] of fills) {
      const vector = source === OPERATIONAL_MAP_SOURCE_ID, layerSource = {source, ...(vector ? {'source-layer': 'territories'} : {})};
      const visible: boolean | ExpressionSpecification = vector ? ['!', ['boolean', ['feature-state', 'exactCell'], false]] : true;
      addLayer({id: fill, type: 'fill', ...layerSource, paint: {'fill-antialias': false, 'fill-color': OPERATIONAL_FILL_COLOR, 'fill-opacity': ['case', visible, 1, 0]}});
    }
    const countryPaint = {'line-color': '#000000', 'line-width': operationalCountryBorderWidth(false), 'line-opacity': OPERATIONAL_COUNTRY_BORDER_OPACITY};
    const vectorOpacity = (opacity: ExpressionSpecification): ExpressionSpecification => {
      // Keep zoom at the outer interpolation, as required by MapLibre camera expressions.
      const result: unknown[] = [...opacity];
      for (let i = 4; i < result.length; i += 2) result[i] = ['case', ['boolean', ['feature-state', 'detailEdge'], false], 0, result[i]];
      return result as ExpressionSpecification;
    };
    addLayer({id: L.country, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'edges', filter: ['in', ['get', 'c'], ['literal', [0, 1]]], paint: {...countryPaint, 'line-opacity': vectorOpacity(OPERATIONAL_COUNTRY_BORDER_OPACITY)}});
    addLayer({id: L.administrative, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'edges', minzoom: 2.2, filter: ordinaryLegacyBoundary as unknown as import('maplibre-gl').FilterSpecification, layout: {visibility: 'visible'}, paint: {...OPERATIONAL_LEGACY_BOUNDARY_PAINT, 'line-opacity': vectorOpacity(OPERATIONAL_LEGACY_BOUNDARY_PAINT['line-opacity'])}});
    addLayer({id: L.synthetic, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'edges', minzoom: 2.2, filter: ['all', ordinaryMicroBoundary, noDebugEdges] as unknown as import('maplibre-gl').FilterSpecification, layout: {visibility: 'none'}, paint: {...OPERATIONAL_DEBUG_BOUNDARY_PAINT, 'line-opacity': vectorOpacity(OPERATIONAL_DEBUG_BOUNDARY_PAINT['line-opacity'])}});
    for (const [id, filter, minzoom, debug] of [[L.detailCountry, ['in', ['get', 'boundaryClass'], ['literal', ['coast', 'country']]], 0, false],
      [L.detailAdministrative, ordinaryLegacyBoundary, 2.2, false], [L.detailSynthetic, ['all', ordinaryExactMicroBoundary, noDebugEdges], 2.2, true]] as const) {
      addLayer({id, type: 'line', source: OPERATIONAL_EXACT_EDGE_SOURCE_ID, minzoom, filter: filter as unknown as import('maplibre-gl').FilterSpecification,
        layout: {visibility: debug ? 'none' : 'visible'}, paint: id === L.detailAdministrative ? OPERATIONAL_LEGACY_BOUNDARY_PAINT : debug ? OPERATIONAL_DEBUG_BOUNDARY_PAINT : countryPaint});
    }
    if (provinceLod) {
      // Keep original buckets as an instant fallback. Visibility swaps avoid
      // rebuilding filters or drawing original and simplified strokes together.
      addLayer({id: L.provinceOriginal, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'edges', minzoom: 2.2,
        filter: provinceBoundary as import('maplibre-gl').FilterSpecification, paint: {...OPERATIONAL_LEGACY_BOUNDARY_PAINT, 'line-opacity': vectorOpacity(OPERATIONAL_LEGACY_BOUNDARY_PAINT['line-opacity'])}});
      addLayer({id: L.detailProvinceOriginal, type: 'line', source: OPERATIONAL_EXACT_EDGE_SOURCE_ID, minzoom: 2.2,
        filter: provinceBoundary as import('maplibre-gl').FilterSpecification, paint: OPERATIONAL_LEGACY_BOUNDARY_PAINT});
      addLayer({id: L.provinceDisplayLod, type: 'line', source: OPERATIONAL_PROVINCE_LOD_SOURCE_ID, minzoom: provinceLod.minZoom, maxzoom: provinceLod.maxZoom,
        layout: {visibility: 'none', 'line-join': 'round'}, paint: OPERATIONAL_LEGACY_BOUNDARY_PAINT});
    }
    if (microLod) {
      addLayer({id: L.microOriginal, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'edges', minzoom: 2.2,
        filter: ['all', microBoundary, chnMicroBoundary, noDebugEdges] as unknown as import('maplibre-gl').FilterSpecification, layout: {visibility: 'none'},
        paint: {...OPERATIONAL_DEBUG_BOUNDARY_PAINT, 'line-opacity': vectorOpacity(OPERATIONAL_DEBUG_BOUNDARY_PAINT['line-opacity'])}});
      addLayer({id: L.detailMicroOriginal, type: 'line', source: OPERATIONAL_EXACT_EDGE_SOURCE_ID, minzoom: 2.2,
        filter: ['all', exactMicroBoundary, chnMicroBoundary, noDebugEdges] as unknown as import('maplibre-gl').FilterSpecification, layout: {visibility: 'none'}, paint: OPERATIONAL_DEBUG_BOUNDARY_PAINT});
      addLayer({id: L.microDisplayLod, type: 'line', source: OPERATIONAL_MICRO_LOD_SOURCE_ID, minzoom: microLod.minZoom, maxzoom: microLod.maxZoom,
        filter: noDebugEdges as import('maplibre-gl').FilterSpecification, layout: {visibility: 'none', 'line-join': 'round'}, paint: OPERATIONAL_DEBUG_BOUNDARY_PAINT});
    }
    addLayer({id: L.front, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'edges', filter: ['==', ['get', 'c'], 1], paint: {'line-color': '#D9A43C', 'line-width': 2, 'line-dasharray': [3, 2],
      'line-opacity': ['case', ['all', ['boolean', ['feature-state', 'front'], false], ['!', ['boolean', ['feature-state', 'exactFront'], false]]], 1, 0]}});
    addLayer({id: L.detailFront, type: 'line', source: OPERATIONAL_FRONT_SOURCE_ID, paint: {'line-color': '#D9A43C', 'line-width': 2, 'line-dasharray': [3, 2]}});
    // Geometry is initially lazy; restored occupied/transferred cells still need exact coverage.
    // Do not capture input/the initial world in callbacks retained for the map lifetime.
    const initialCells: {id: string; sourceCountryId: string}[] = [];
    for (const id of input.world.territoryOrder) {
      const cell = input.world.territoriesById[id];
      if (cell.controllerCountryId !== cell.sourceCountryId || cell.ownerCountryId !== cell.sourceCountryId) initialCells.push(cell);
    }
    if (initialCells.length) {
      const cells = await delivery.resolveCells(initialCells, signal), edges = delivery.incidentEdges(cells.map(c => c.ordinal));
      const data = await stageDetail(input.world, cells, edges); publishDetail(data); cells.forEach(c => applyCell(c.ordinal)); edges.forEach(applyEdge);
    }
    stopFeatures = delivery.observeTileFeatures(batch => {
      if (disposed) return;
      // Source feature-state survives tile loads. Only restored/changed incident edges need overrides.
      try {for (const n of batch.cells) {if (!vectorCells.has(n)) {vectorCells.add(n); applyCell(n, OPERATIONAL_MAP_SOURCE_ID);}}} catch (error) {failed = error; throw error;}
    });
    for (const layer of fillLayers) {map.on('click', layer, click); if (!input.externalHover) {map.on('mousemove', layer, move); map.on('mouseleave', layer, leave);}}
  } catch (error) {dispose(); throw error;}
  return Object.freeze({
    getProjection: () => projection, getUpdateStats: () => ({...stats, exactCells: exactCells.size, exactFronts: exactFronts.size, selectedDetailCells: detailCells.size, detailSourceWrites: sources.getDetailSourceWrites(),
      debugBoundaryCountryIds: debugScope.countryIds, debugBoundaryEdgeCount: debugScope.edgeOrdinals.length,
      provinceDisplayLodReady: provinceLodPublished, provinceDisplayLodActive: provinceLodActive,
      microDisplayLodReady: microLodPublished, microDisplayLodActive: microLodActive, microDisplayLodInScope: debugEnabled && microLodInScope, resyncRequired: !!failed}),
    loadProvinceBoundaryLod: async (requestSignal?: AbortSignal) => {
      check(); if (!provinceLod || provinceLodPublished) return;
      const currentSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      const data = await delivery.loadProvinceBoundaryLod(currentSignal); currentSignal.throwIfAborted(); check();
      if (provinceLodPublished) return;
      const source = map.getSource(OPERATIONAL_PROVINCE_LOD_SOURCE_ID) as {setData?: (data: FeatureCollection) => unknown} | undefined;
      if (!source?.setData) throw Error('PROVINCE_BOUNDARY_LOD_SOURCE_MISSING');
      source.setData(data); provinceLodPublished = true;
      stats.provinceDisplayLodVertexCount = data.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
      stats.provinceDisplayLodSourceWrites++;
    },
    setProvinceBoundaryLodEnabled: (enabled: boolean) => {
      check(); const active = !!provinceLod && provinceLodPublished && enabled;
      if (active === provinceLodActive) return;
      map.setLayoutProperty(L.provinceOriginal, 'visibility', active ? 'none' : 'visible');
      map.setLayoutProperty(L.detailProvinceOriginal, 'visibility', active ? 'none' : 'visible');
      map.setLayoutProperty(L.provinceDisplayLod, 'visibility', active ? 'visible' : 'none');
      provinceLodActive = active;
    },
    loadMicroBoundaryLod: async (requestSignal?: AbortSignal) => {
      check(); if (!microLod || microLodPublished) return;
      const currentSignal = requestSignal ? AbortSignal.any([signal, requestSignal]) : signal;
      const data = await delivery.loadMicroBoundaryLod(currentSignal); currentSignal.throwIfAborted(); check();
      if (microLodPublished) return;
      const source = map.getSource(OPERATIONAL_MICRO_LOD_SOURCE_ID) as {setData?: (data: FeatureCollection) => unknown} | undefined;
      if (!source?.setData) throw Error('MICRO_BOUNDARY_LOD_SOURCE_MISSING');
      source.setData(data); microLodPublished = true;
      stats.microDisplayLodVertexCount = data.features.reduce((n, f) => n + f.geometry.coordinates.length, 0);
      stats.microDisplayLodSourceWrites++;
    },
    setMicroBoundaryLodEnabled: (enabled: boolean) => {
      check(); const active = !!microLod && microLodPublished && debugEnabled && microLodInScope && enabled;
      if (active === microLodActive) return;
      microLodActive = active; syncDebugVisibility();
    },
    setDebugBoundaries: (enabled: boolean) => {
      check();
      if (debugEnabled === enabled) return;
      debugEnabled = enabled; updateDebugScope();
      if (!enabled) microLodActive = false;
      syncDebugVisibility();
    },
    supportsCountryViewportDetail: (id: string) => delivery.supportsCountryViewportDetail(id),
    selectCountry: (id: string | null) => interaction('selected', id), hoverCountry: (id: string | null) => interaction('hover', id),
    updateWorld: (world: OperationalMapWorld, change?: OperationalStateChange) => {
      const update = queue.then(async () => {
        check(); if (world === projection.world) return;
        const next = prepareOperationalMapUpdate(projection, world, change);
        for (const countryId of next.countryColors) if (world.countriesById[countryId]) mapColorPresentation(world.countriesById[countryId].mapColor);
        const cells = await delivery.resolveCells(next.cells.map(c => c.after), signal);
        if (cells.some(c => world.territoryOrder[c.ordinal - 1] !== c.id || projection.world.territoryOrder[c.ordinal - 1] !== c.id)) throw Error('OPERATIONAL_MAP_ORDER_CHANGED');
        const edges = delivery.incidentEdges(cells.map(c => c.ordinal)), data = await stageDetail(world, cells, edges);
        const affected = new Set(cells.map(c => c.ordinal));
        for (const country of next.countryColors) for (const n of controllerCells.get(country) ?? []) affected.add(n);
        if (selected && !world.countriesById[selected]) for (const n of interactionCells.get(selected) ?? []) affected.add(n);
        if (hovered && !world.countriesById[hovered]) for (const n of interactionCells.get(hovered) ?? []) affected.add(n);
        try {
          publishDetail(data);
          for (const c of cells) indexCell(c.ordinal, projection.world.territoriesById[c.id], false);
          projection = next.projection;
          debugIndex?.update(world, cells.map(c => c.ordinal));
          if (selected && !world.countriesById[selected]) {selected = null; onSelect?.(null);}
          if (hovered && !world.countriesById[hovered]) {hovered = null; onHover?.(null);}
          updateDebugScope();
          affected.forEach(n => applyCell(n)); edges.forEach(applyEdge);
        } catch (error) {failed = error; throw error;}
        stats.updates++; stats.edgesExamined += edges.length;
      });
      queue = update.catch(() => {}); return update;
    },
    showCountryDetail: async (id: string) => {
      check(); const request = ++detailRequest, data = await sources.showCountryDetail(id, signal).catch(error => {
        if (error instanceof OperationalMapSourceWriteError) failed = error;
        throw error;
      });
      if (disposed || request !== detailRequest) return data;
      check();
      try {
        const previous = [...detailCells]; detailCells.clear(); data.features.forEach(f => detailCells.add(Number(f.id)));
        for (const n of previous) if (!detailCells.has(n)) removeDetailCellState(n);
        detailCells.forEach(n => {applyCell(n, OPERATIONAL_EXACT_CELL_SOURCE_ID); restoreVectorMask(n);}); return data;
      } catch (error) {failed = error; throw error;}
    },
    showCountryViewportDetail: async (id: string, bounds: OperationalViewportBounds, requestSignal?: AbortSignal) => {
      check(); const request = ++detailRequest;
      const data = await sources.showCountryViewportDetail(id, bounds, requestSignal ? AbortSignal.any([signal, requestSignal]) : signal).catch(error => {
        if (error instanceof OperationalMapSourceWriteError) failed = error;
        throw error;
      });
      if (disposed || request !== detailRequest) return data;
      check();
      const next = new Set(data.features.map(f => Number(f.id)));
      if (next.size === detailCells.size && [...next].every(n => detailCells.has(n))) return data;
      try {
        const previous = [...detailCells]; detailCells.clear(); next.forEach(n => detailCells.add(n));
        for (const n of previous) if (!detailCells.has(n)) removeDetailCellState(n);
        detailCells.forEach(n => {applyCell(n, OPERATIONAL_EXACT_CELL_SOURCE_ID); restoreVectorMask(n);}); return data;
      } catch (error) {failed = error; throw error;}
    },
    showEdgeDetail: (ordinals: readonly number[]) => {
      check(); return sources.showEdgeDetail(ordinals, signal).catch(error => {
        if (error instanceof OperationalMapSourceWriteError) failed = error;
        throw error;
      });
    },
    clearDetail: () => {
      check(); detailRequest++;
      try {
        sources.clearDetail(); const previous = [...detailCells]; detailCells.clear();
        previous.forEach(removeDetailCellState);
      } catch (error) {failed = error; throw error;}
    },
    dispose,
  });
}
export type OperationalMapConsumer = Awaited<ReturnType<typeof createOperationalMapConsumer>>;
export async function mountOperationalMapConsumer(input: Omit<Input, 'delivery'> & {fetcher?: CatalogFetch}) {
  const delivery = await fetchOperationalVectorDelivery(input.world.catalogRef, input.fetcher, input.signal);
  return createOperationalMapConsumer({...input, delivery});
}
