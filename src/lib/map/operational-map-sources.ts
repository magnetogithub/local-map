import type {FeatureCollection, GeoJSON} from 'geojson';
import type {SourceSpecification} from 'maplibre-gl';
import {OPERATIONAL_MAP_SOURCE_ID} from './operational-delivery-contract';
import {fetchOperationalVectorDelivery, operationalEdgeFeatures, type OperationalVectorDelivery} from './operational-vector-delivery';
import {registerCatalogTileProtocol, type CatalogFetch} from './catalog-vector-delivery';
import type {WorldGeometryCatalogRef} from '../world/world-geometry-catalog-ref';

export const OPERATIONAL_EXACT_CELL_SOURCE_ID = 'world-operational-exact-cells';
export const OPERATIONAL_EXACT_EDGE_SOURCE_ID = 'world-operational-exact-edges';
type SourcePort = {addSource: (id: string, source: SourceSpecification) => unknown; removeSource: (id: string) => unknown; getSource: (id: string) => unknown};
type ProtocolApi = Parameters<typeof registerCatalogTileProtocol>[0];
const empty = (): FeatureCollection => ({type: 'FeatureCollection', features: []});

/** Source wiring for 16-05's layers and 16-08's game mount; no independent mutable world. */
export function createOperationalMapSources(map: SourcePort, protocolApi: ProtocolApi, delivery: OperationalVectorDelivery) {
  const ids = [OPERATIONAL_MAP_SOURCE_ID, OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID];
  if (ids.some(id => map.getSource(id))) throw Error('OPERATIONAL_MAP_SOURCE_EXISTS');
  const unregister = registerCatalogTileProtocol(protocolApi, delivery), added: string[] = [];
  try {
    for (const id of ids) {
      map.addSource(id, id === OPERATIONAL_MAP_SOURCE_ID ? delivery.source : {type: 'geojson', data: empty()}); added.push(id);
    }
  } catch (error) {for (const id of added.reverse()) map.removeSource(id); unregister(); throw error;}
  let disposed = false, cellRequest = 0, edgeRequest = 0;
  const setData = (id: string, data: GeoJSON) => {
    const source = map.getSource(id) as {setData?: (data: GeoJSON) => unknown} | undefined;
    if (typeof source?.setData !== 'function') throw Error('OPERATIONAL_EXACT_SOURCE_MISSING');
    source.setData(data);
  };
  const check = () => {if (disposed) throw Error('OPERATIONAL_MAP_SOURCES_DISPOSED');};
  return Object.freeze({delivery,
    showCountryDetail: async (countryId: string, signal?: AbortSignal) => {
      check(); const request = ++cellRequest, data = await delivery.loadCountryDetail(countryId, signal);
      signal?.throwIfAborted(); if (!disposed && request === cellRequest) setData(OPERATIONAL_EXACT_CELL_SOURCE_ID, data);
      return data;
    },
    showCellDetail: async (cells: Parameters<OperationalVectorDelivery['loadCellDetail']>[0], signal?: AbortSignal) => {
      check(); const request = ++cellRequest, data = await delivery.loadCellDetail(cells, signal);
      signal?.throwIfAborted(); if (!disposed && request === cellRequest) setData(OPERATIONAL_EXACT_CELL_SOURCE_ID, data);
      return data;
    },
    showEdgeDetail: async (ordinals: readonly number[], signal?: AbortSignal) => {
      check(); const request = ++edgeRequest, data = operationalEdgeFeatures(await delivery.loadEdgeDetails(ordinals, signal));
      signal?.throwIfAborted(); if (!disposed && request === edgeRequest) setData(OPERATIONAL_EXACT_EDGE_SOURCE_ID, data);
      return data;
    },
    clearDetail: () => {check(); cellRequest++; edgeRequest++; setData(OPERATIONAL_EXACT_CELL_SOURCE_ID, empty()); setData(OPERATIONAL_EXACT_EDGE_SOURCE_ID, empty());},
    // Remove dependent layers before disposing the sources.
    dispose: () => {if (disposed) return; disposed = true; for (const id of [...ids].reverse()) if (map.getSource(id)) map.removeSource(id); unregister();},
  });
}
export async function mountOperationalMapSources(input: {map: SourcePort; protocolApi: ProtocolApi; catalogRef: WorldGeometryCatalogRef; fetcher?: CatalogFetch; signal?: AbortSignal}) {
  const delivery = await fetchOperationalVectorDelivery(input.catalogRef, input.fetcher, input.signal);
  input.signal?.throwIfAborted();
  return createOperationalMapSources(input.map, input.protocolApi, delivery);
}
