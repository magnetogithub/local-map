import type {Feature, FeatureCollection, LineString, MultiLineString, MultiPolygon, Polygon} from 'geojson';
import type {ExpressionSpecification, GeoJSONSourceDiff, LayerSpecification, SourceSpecification} from 'maplibre-gl';
import type {OperationalStateChange} from '../world/operational-catalog';
import {mapColorPresentation} from '../world/country-map-color';
import {createOperationalMapProjection, operationalCellView, operationalFront, prepareOperationalMapUpdate, type OperationalMapWorld} from '../projection/operational-map-projection';
import {OPERATIONAL_MAP_SOURCE_ID} from './operational-delivery-contract';
import {createOperationalMapSources, OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID} from './operational-map-sources';
import {fetchOperationalVectorDelivery, operationalEdgeFeatures, type OperationalVectorDelivery} from './operational-vector-delivery';
import {registerCatalogTileProtocol, type CatalogFetch} from './catalog-vector-delivery';

export const OPERATIONAL_CHANGED_CELL_SOURCE_ID = 'world-operational-changed-cells';
export const OPERATIONAL_FRONT_SOURCE_ID = 'world-operational-front-detail';
export const OPERATIONAL_MAP_LAYERS = {
  fill: 'operational-fill', detailFill: 'operational-detail-fill', changedFill: 'operational-changed-fill',
  occupation: 'operational-occupation', detailOccupation: 'operational-detail-occupation', changedOccupation: 'operational-changed-occupation',
  hover: 'operational-hover', detailHover: 'operational-detail-hover', changedHover: 'operational-changed-hover',
  selected: 'operational-selected', detailSelected: 'operational-detail-selected', changedSelected: 'operational-changed-selected',
  country: 'operational-country-border', administrative: 'operational-administrative-border', synthetic: 'operational-cell-grid',
  detailCountry: 'operational-detail-country-border', detailAdministrative: 'operational-detail-administrative-border', detailSynthetic: 'operational-detail-cell-grid',
  front: 'operational-front', detailFront: 'operational-detail-front',
} as const;
type Hit = {id?: string | number; source?: string; sourceLayer?: string};
type MapEvent = {features?: Hit[]};
export type OperationalMapPort = {
  addSource: (id: string, source: SourceSpecification) => unknown; removeSource: (id: string) => unknown; getSource: (id: string) => unknown;
  addLayer: (layer: LayerSpecification) => unknown; removeLayer: (id: string) => unknown; getLayer: (id: string) => unknown;
  setFeatureState: (target: {source: string; sourceLayer?: string; id: string | number}, state: Record<string, unknown>) => unknown;
  on: (event: string, layer: string, listener: (event: MapEvent) => void) => unknown;
  off: (event: string, layer: string, listener: (event: MapEvent) => void) => unknown;
};
type CellFeature = Feature<Polygon | MultiPolygon>;
type EdgeFeature = Feature<LineString | MultiLineString>;
const empty = (): FeatureCollection => ({type: 'FeatureCollection', features: []});
type Input = {map: OperationalMapPort; protocolApi: Parameters<typeof registerCatalogTileProtocol>[0]; delivery: OperationalVectorDelivery; world: OperationalMapWorld;
  signal?: AbortSignal; onSelect?: (id: string | null) => void; onHover?: (id: string | null) => void; onTerritorySelect?: (id: string | null) => void};

/** B branch: renders only the supplied authoritative snapshots/deltas, without mutating the world. */
export async function createOperationalMapConsumer(input: Input) {
  const {map, delivery} = input, L = OPERATIONAL_MAP_LAYERS;
  let projection = createOperationalMapProjection(input.world, delivery.bootstrap.catalog.catalogRef, delivery.bootstrap.catalog.counts.cells);
  for (const country of Object.values(input.world.countriesById)) mapColorPresentation(country.mapColor);
  const ownedSources = [OPERATIONAL_CHANGED_CELL_SOURCE_ID, OPERATIONAL_FRONT_SOURCE_ID];
  if (Object.values(L).some(id => map.getLayer(id)) || ownedSources.some(id => map.getSource(id))) throw Error('OPERATIONAL_MAP_ALREADY_MOUNTED');
  input.signal?.throwIfAborted();
  const sources = createOperationalMapSources(map, input.protocolApi, delivery), addedSources: string[] = [], addedLayers: string[] = [];
  const abort = new AbortController(), signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
  let disposed = false, failed: unknown = null, selected: string | null = null, hovered: string | null = null, detailRequest = 0;
  let queue: Promise<unknown> = Promise.resolve(), stopFeatures = () => {};
  const visibleCells = new Set<number>(), detailCells = new Set<number>(), exactCells = new Map<number, CellFeature>(), exactFronts = new Map<number, EdgeFeature>();
  const stats = {fullProjectionBuilds: 1, updates: 0, cellsUpdated: 0, edgesExamined: 0, exactCellsAdded: 0, exactFrontsAdded: 0, exactFrontsRemoved: 0};
  const addLayer = (layer: LayerSpecification) => {map.addLayer(layer); addedLayers.push(layer.id);};
  const geoSource = (id: string) => {
    const source = map.getSource(id) as {updateData?: (diff: GeoJSONSourceDiff) => unknown} | undefined;
    if (typeof source?.updateData !== 'function') throw Error('OPERATIONAL_INCREMENTAL_SOURCE_MISSING');
    return source as {updateData: (diff: GeoJSONSourceDiff) => unknown};
  };
  const check = () => {if (disposed) throw Error('OPERATIONAL_MAP_DISPOSED'); if (failed) throw Error('OPERATIONAL_MAP_RESYNC_REQUIRED'); signal.throwIfAborted();};
  const applyCell = (n: number) => {
    const cell = operationalCellView(projection.world, n), country = cell.ownerCountryId ?? cell.controllerCountryId;
    const state = {...cell, hover: country !== null && country === hovered, selected: country !== null && country === selected};
    map.setFeatureState({source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'territories', id: n}, {...state, exactCell: exactCells.has(n) || detailCells.has(n)});
    for (const source of [OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_CHANGED_CELL_SOURCE_ID]) map.setFeatureState({source, id: n}, state);
    stats.cellsUpdated++;
  };
  const applyEdge = (n: number) => map.setFeatureState({source: OPERATIONAL_MAP_SOURCE_ID, sourceLayer: 'edges', id: n},
    {front: operationalFront(projection.world, delivery.edgeIncidence(n)), exactFront: exactFronts.has(n)});
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
    for (const n of new Set([...visibleCells, ...detailCells, ...exactCells.keys()])) {
      const c = operationalCellView(projection.world, n), country = c.ownerCountryId ?? c.controllerCountryId;
      if (country === old || country === id) applyCell(n);
    }
  };
  const click = (event: MapEvent) => {const c = hit(event), country = c ? c.ownerCountryId ?? c.controllerCountryId : null; interaction('selected', country); input.onSelect?.(country); input.onTerritorySelect?.(c?.id ?? null);};
  const move = (event: MapEvent) => {const c = hit(event), country = c ? c.ownerCountryId ?? c.controllerCountryId : null; interaction('hover', country); input.onHover?.(country);};
  const leave = () => {interaction('hover', null); input.onHover?.(null);};
  const dispose = () => {
    if (disposed) return; disposed = true; abort.abort(); stopFeatures();
    for (const layer of fillLayers) {map.off('click', layer, click); map.off('mousemove', layer, move); map.off('mouseleave', layer, leave);}
    for (const id of [...addedLayers].reverse()) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of [...addedSources].reverse()) if (map.getSource(id)) map.removeSource(id);
    sources.dispose();
  };
  try {
    for (const id of ownedSources) {map.addSource(id, {type: 'geojson', data: empty()}); addedSources.push(id);}
    const fills = [[L.fill, L.occupation, L.hover, L.selected, OPERATIONAL_MAP_SOURCE_ID],
      [L.detailFill, L.detailOccupation, L.detailHover, L.detailSelected, OPERATIONAL_EXACT_CELL_SOURCE_ID],
      [L.changedFill, L.changedOccupation, L.changedHover, L.changedSelected, OPERATIONAL_CHANGED_CELL_SOURCE_ID]] as const;
    for (const [fill, occupation, hover, selectedLayer, source] of fills) {
      const vector = source === OPERATIONAL_MAP_SOURCE_ID, layerSource = {source, ...(vector ? {'source-layer': 'territories'} : {})};
      const visible: boolean | ExpressionSpecification = vector ? ['!', ['boolean', ['feature-state', 'exactCell'], false]] : true;
      addLayer({id: fill, type: 'fill', ...layerSource, paint: {'fill-color': ['coalesce', ['feature-state', 'mapColor'], '#D6D3C7'], 'fill-outline-color': ['coalesce', ['feature-state', 'mapColor'], '#D6D3C7'], 'fill-opacity': ['case', visible, 1, 0]}});
      addLayer({id: occupation, type: 'fill', ...layerSource, paint: {'fill-antialias': false, 'fill-color': '#40285E', 'fill-opacity': ['case', ['all', visible, ['boolean', ['feature-state', 'occupied'], false]], 0.18, 0]}});
      for (const [id, key] of [[hover, 'hover'], [selectedLayer, 'selected']] as const) addLayer({id, type: 'fill', ...layerSource,
        paint: {'fill-antialias': false, 'fill-color': ['coalesce', ['feature-state', 'selectionColor'], '#FFFFFF'], 'fill-opacity': ['case', ['all', visible, ['boolean', ['feature-state', key], false]], 0.18, 0]}});
    }
    addLayer({id: L.country, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'edges', filter: ['in', ['get', 'c'], ['literal', [0, 1]]], paint: {'line-color': '#53615F', 'line-width': 0.8}});
    addLayer({id: L.administrative, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'administrative', minzoom: 4, paint: {'line-color': '#FFFFFF', 'line-opacity': 0.5, 'line-width': 0.75}});
    addLayer({id: L.synthetic, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'edges', minzoom: 8, filter: ['in', ['get', 'c'], ['literal', [3, 4]]], layout: {visibility: 'none'}, paint: {'line-color': '#53615F', 'line-opacity': 0.2, 'line-width': 0.5}});
    for (const [id, filter, minzoom, synthetic] of [[L.detailCountry, ['in', ['get', 'boundaryClass'], ['literal', ['coast', 'country']]], 0, false],
      [L.detailAdministrative, ['==', ['get', 'administrative'], true], 4, false], [L.detailSynthetic, ['in', ['get', 'boundaryClass'], ['literal', ['operational', 'residual']]], 8, true]] as const) {
      addLayer({id, type: 'line', source: OPERATIONAL_EXACT_EDGE_SOURCE_ID, minzoom, filter: filter as unknown as import('maplibre-gl').FilterSpecification,
        layout: {visibility: synthetic ? 'none' : 'visible'}, paint: {'line-color': id === L.detailAdministrative ? '#FFFFFF' : '#53615F', 'line-width': 0.75}});
    }
    addLayer({id: L.front, type: 'line', source: OPERATIONAL_MAP_SOURCE_ID, 'source-layer': 'edges', paint: {'line-color': '#D9A43C', 'line-width': 2, 'line-dasharray': [3, 2],
      'line-opacity': ['case', ['all', ['boolean', ['feature-state', 'front'], false], ['!', ['boolean', ['feature-state', 'exactFront'], false]]], 1, 0]}});
    addLayer({id: L.detailFront, type: 'line', source: OPERATIONAL_FRONT_SOURCE_ID, paint: {'line-color': '#D9A43C', 'line-width': 2, 'line-dasharray': [3, 2]}});
    // Geometry is initially lazy; restored occupied/transferred cells still need exact coverage.
    const initialIds = input.world.territoryOrder.filter(id => {const c = input.world.territoriesById[id]; return c.controllerCountryId !== c.sourceCountryId || c.ownerCountryId !== c.sourceCountryId;});
    if (initialIds.length) {
      const cells = await delivery.resolveCells(initialIds.map(id => input.world.territoriesById[id]), signal), edges = delivery.incidentEdges(cells.map(c => c.ordinal));
      const data = await stageDetail(input.world, cells, edges); publishDetail(data); cells.forEach(c => applyCell(c.ordinal)); edges.forEach(applyEdge);
    }
    stopFeatures = delivery.observeTileFeatures(batch => {
      if (disposed) return;
      try {for (const n of batch.cells) {visibleCells.add(n); applyCell(n);} batch.edges.forEach(applyEdge);} catch (error) {failed = error; throw error;}
    });
    for (const layer of fillLayers) {map.on('click', layer, click); map.on('mousemove', layer, move); map.on('mouseleave', layer, leave);}
  } catch (error) {dispose(); throw error;}
  return Object.freeze({
    getProjection: () => projection, getUpdateStats: () => ({...stats, exactCells: exactCells.size, exactFronts: exactFronts.size, resyncRequired: !!failed}),
    selectCountry: (id: string | null) => interaction('selected', id), hoverCountry: (id: string | null) => interaction('hover', id),
    updateWorld: (world: OperationalMapWorld, change?: OperationalStateChange) => {
      const update = queue.then(async () => {
        check(); if (world === projection.world) return;
        const next = prepareOperationalMapUpdate(projection, world, change);
        for (const countryId of next.countryColors) if (world.countriesById[countryId]) mapColorPresentation(world.countriesById[countryId].mapColor);
        const cells = await delivery.resolveCells(next.cells.map(c => c.after), signal);
        if (cells.some(c => world.territoryOrder[c.ordinal - 1] !== c.id || projection.world.territoryOrder[c.ordinal - 1] !== c.id)) throw Error('OPERATIONAL_MAP_ORDER_CHANGED');
        const edges = delivery.incidentEdges(cells.map(c => c.ordinal)), data = await stageDetail(world, cells, edges);
        publishDetail(data); projection = next.projection;
        const affected = new Set(cells.map(c => c.ordinal));
        if (next.countryColors.size) for (const n of new Set([...visibleCells, ...detailCells, ...exactCells.keys()])) {
          const c = world.territoriesById[world.territoryOrder[n - 1]];
          if (c.controllerCountryId && next.countryColors.has(c.controllerCountryId)) affected.add(n);
        }
        if (selected && !world.countriesById[selected]) {selected = null; input.onSelect?.(null);}
        if (hovered && !world.countriesById[hovered]) {hovered = null; input.onHover?.(null);}
        try {affected.forEach(applyCell); edges.forEach(applyEdge);} catch (error) {failed = error; throw error;}
        stats.updates++; stats.edgesExamined += edges.length;
      });
      queue = update.catch(() => {}); return update;
    },
    showCountryDetail: async (id: string) => {
      check(); const request = ++detailRequest, data = await sources.showCountryDetail(id, signal);
      if (disposed || request !== detailRequest) return data;
      const previous = [...detailCells]; detailCells.clear(); data.features.forEach(f => detailCells.add(Number(f.id)));
      new Set([...previous, ...detailCells]).forEach(applyCell); return data;
    },
    showEdgeDetail: (ordinals: readonly number[]) => {check(); return sources.showEdgeDetail(ordinals, signal);},
    clearDetail: () => {check(); detailRequest++; sources.clearDetail(); const previous = [...detailCells]; detailCells.clear(); previous.forEach(applyCell);},
    dispose,
  });
}
export type OperationalMapConsumer = Awaited<ReturnType<typeof createOperationalMapConsumer>>;
export async function mountOperationalMapConsumer(input: Omit<Input, 'delivery'> & {fetcher?: CatalogFetch}) {
  const delivery = await fetchOperationalVectorDelivery(input.world.catalogRef, input.fetcher, input.signal);
  return createOperationalMapConsumer({...input, delivery});
}
