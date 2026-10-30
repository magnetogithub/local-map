import type {FeatureCollection, GeoJSON} from 'geojson';
import type {SourceSpecification} from 'maplibre-gl';
import {OPERATIONAL_MAP_SOURCE_ID} from './operational-delivery-contract';
import {fetchOperationalVectorDelivery, operationalEdgeFeatures, type OperationalVectorDelivery} from './operational-vector-delivery';
import {registerCatalogTileProtocol, type CatalogFetch} from './catalog-vector-delivery';
import type {WorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';

export const OPERATIONAL_EXACT_CELL_SOURCE_ID = 'world-operational-exact-cells';
export const OPERATIONAL_EXACT_EDGE_SOURCE_ID = 'world-operational-exact-edges';
// MapLibre otherwise simplifies and culls each small polygon independently.
// The delivery already determines detail; a second simplification can perforate land.
export const OPERATIONAL_EXACT_SOURCE_OPTIONS = {type: 'geojson', tolerance: 0} as const;
type SourcePort = {addSource: (id: string, source: SourceSpecification) => unknown; removeSource: (id: string) => unknown; getSource: (id: string) => unknown};
type ProtocolApi = Parameters<typeof registerCatalogTileProtocol>[0];
const empty = (): FeatureCollection => ({type: 'FeatureCollection', features: []});
export class OperationalMapSourceWriteError extends Error {
  constructor(cause: unknown) {super('OPERATIONAL_MAP_SOURCE_WRITE_FAILED', {cause});}
}

/** Source wiring for 16-05's layers and 16-08's game mount; no independent mutable world. */
export function createOperationalMapSources(map: SourcePort, protocolApi: ProtocolApi, delivery: OperationalVectorDelivery,
  onEdgeDetailChange?: (ordinals: readonly number[]) => void) {
  const ids = [OPERATIONAL_MAP_SOURCE_ID, OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID];
  if (ids.some(id => map.getSource(id))) throw Error('OPERATIONAL_MAP_SOURCE_EXISTS');
  const unregister = registerCatalogTileProtocol(protocolApi, delivery), added: string[] = [];
  try {
    for (const id of ids) {
      map.addSource(id, id === OPERATIONAL_MAP_SOURCE_ID ? delivery.source : {...OPERATIONAL_EXACT_SOURCE_OPTIONS, data: empty()}); added.push(id);
    }
  } catch (error) {for (const id of added.reverse()) map.removeSource(id); unregister(); throw error;}
  let disposed = false, cellRequest = 0, edgeRequest = 0;
  let cellAbort: AbortController | undefined, edgeAbort: AbortController | undefined;
  const beginCellRequest = (signal?: AbortSignal) => {
    cellAbort?.abort(); cellAbort = new AbortController();
    return signal ? AbortSignal.any([signal, cellAbort.signal]) : cellAbort.signal;
  };
  const beginEdgeRequest = (signal?: AbortSignal) => {
    edgeAbort?.abort(); edgeAbort = new AbortController();
    return signal ? AbortSignal.any([signal, edgeAbort.signal]) : edgeAbort.signal;
  };
  const cancelDetail = () => {
    cellRequest++; edgeRequest++; cellAbort?.abort(); edgeAbort?.abort(); cellAbort = undefined; edgeAbort = undefined;
  };
  const setData = (id: string, data: GeoJSON) => {
    try {
      const source = map.getSource(id) as {setData?: (data: GeoJSON) => unknown} | undefined;
      if (typeof source?.setData !== 'function') throw Error('OPERATIONAL_EXACT_SOURCE_MISSING');
      source.setData(data);
      if (id === OPERATIONAL_EXACT_EDGE_SOURCE_ID && data.type === 'FeatureCollection') {
        onEdgeDetailChange?.(Object.freeze(data.features.map(feature => Number(feature.id))));
      }
    } catch (error) {throw new OperationalMapSourceWriteError(error);}
  };
  const check = () => {if (disposed) throw Error('OPERATIONAL_MAP_SOURCES_DISPOSED');};
  return Object.freeze({delivery,
    showCountryDetail: async (countryId: string, signal?: AbortSignal) => {
      check(); const request = ++cellRequest, requestSignal = beginCellRequest(signal), data = await delivery.loadCountryDetail(countryId, requestSignal);
      requestSignal.throwIfAborted();
      const boundaryRequest = ++edgeRequest, boundarySignal = beginEdgeRequest(requestSignal);
      const ordinals = delivery.incidentEdges(data.features.map(f => Number(f.id)));
      const edges = operationalEdgeFeatures(await delivery.loadEdgeDetails(ordinals, boundarySignal));
      boundarySignal.throwIfAborted();
      // Stage both immutable payloads before replacing the previous country's detail.
      if (!disposed && request === cellRequest && boundaryRequest === edgeRequest) {
        setData(OPERATIONAL_EXACT_CELL_SOURCE_ID, data); setData(OPERATIONAL_EXACT_EDGE_SOURCE_ID, edges);
      }
      return data;
    },
    showCellDetail: async (cells: Parameters<OperationalVectorDelivery['loadCellDetail']>[0], signal?: AbortSignal) => {
      check(); const request = ++cellRequest, requestSignal = beginCellRequest(signal), data = await delivery.loadCellDetail(cells, requestSignal);
      requestSignal.throwIfAborted(); if (!disposed && request === cellRequest) setData(OPERATIONAL_EXACT_CELL_SOURCE_ID, data);
      return data;
    },
    showEdgeDetail: async (ordinals: readonly number[], signal?: AbortSignal) => {
      check(); const request = ++edgeRequest, requestSignal = beginEdgeRequest(signal), edges = await delivery.loadEdgeDetails(ordinals, requestSignal);
      requestSignal.throwIfAborted(); const data = operationalEdgeFeatures(edges);
      if (!disposed && request === edgeRequest) setData(OPERATIONAL_EXACT_EDGE_SOURCE_ID, data);
      return data;
    },
    clearDetail: () => {check(); cancelDetail(); setData(OPERATIONAL_EXACT_CELL_SOURCE_ID, empty()); setData(OPERATIONAL_EXACT_EDGE_SOURCE_ID, empty());},
    // Remove dependent layers before disposing the sources.
    dispose: () => {if (disposed) return; disposed = true; cancelDetail(); for (const id of [...ids].reverse()) if (map.getSource(id)) map.removeSource(id); unregister();},
  });
}
export async function mountOperationalMapSources(input: {map: SourcePort; protocolApi: ProtocolApi; catalogRef: WorldGeometryCatalogRef; fetcher?: CatalogFetch; signal?: AbortSignal}) {
  const delivery = await fetchOperationalVectorDelivery(input.catalogRef, input.fetcher, input.signal);
  input.signal?.throwIfAborted();
  return createOperationalMapSources(input.map, input.protocolApi, delivery);
}
