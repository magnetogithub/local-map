// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {FeatureCollection, Polygon} from 'geojson';
import type {OperationalVectorDelivery} from './operational-vector-delivery';
import {createOperationalMapSources, OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID} from './operational-map-sources';

const cleanups: (() => void)[] = [];
afterEach(() => {for (const cleanup of cleanups.splice(0)) cleanup();});
const data: FeatureCollection<Polygon> = {type: 'FeatureCollection', features: []};
function untilAborted<Value>(signal?: AbortSignal): Promise<Value> {
  return new Promise((_resolve, reject) => {
    if (!signal) throw Error('Missing request signal');
    signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  });
}
function fixture() {
  const ports = new Map<string, {setData: ReturnType<typeof vi.fn>}>();
  const map = {addSource: (id: string) => ports.set(id, {setData: vi.fn()}), removeSource: (id: string) => ports.delete(id), getSource: (id: string) => ports.get(id)};
  const api = {addProtocol: vi.fn(), removeProtocol: vi.fn()};
  const identity = {path: '/fixture', sha256: 'a'.repeat(64), byteLength: 0};
  const delivery = {protocol: 'source-cancellation-fixture', source: {type: 'vector' as const, tiles: ['fixture:///{z}/{x}/{y}']},
    bootstrap: {manifest: identity, tileIndex: identity}, loadTile: vi.fn(async () => new ArrayBuffer(0)),
    incidentEdges: vi.fn<OperationalVectorDelivery['incidentEdges']>(() => []),
    loadCountryDetail: vi.fn(async (_id: string, signal?: AbortSignal) => {signal?.throwIfAborted(); return data;}),
    loadCellDetail: vi.fn(async (_cells: readonly {id: string; sourceCountryId: string}[], signal?: AbortSignal) => {signal?.throwIfAborted(); return data;}),
    loadEdgeDetails: vi.fn(async (_ordinals: readonly number[], signal?: AbortSignal) => {signal?.throwIfAborted(); return [] as Awaited<ReturnType<OperationalVectorDelivery['loadEdgeDetails']>>;})};
  const sources = createOperationalMapSources(map, api, delivery as unknown as OperationalVectorDelivery);
  cleanups.push(sources.dispose); return {sources, delivery, ports, api};
}

describe('operational detail request cancellation', () => {
  it('stages country polygons and their real incident boundaries before replacing detail', async () => {
    const f = fixture();
    await f.sources.showCountryDetail('AAA');
    const cells = f.ports.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!, edges = f.ports.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!;
    expect(cells.setData).toHaveBeenCalledOnce(); expect(edges.setData).toHaveBeenCalledOnce();
    f.delivery.loadEdgeDetails.mockRejectedValueOnce(Error('boundaries offline'));
    await expect(f.sources.showCountryDetail('BBB')).rejects.toThrow('boundaries offline');
    expect(cells.setData).toHaveBeenCalledOnce(); expect(edges.setData).toHaveBeenCalledOnce();
    await f.sources.showCountryDetail('BBB');
    expect(cells.setData).toHaveBeenCalledTimes(2); expect(edges.setData).toHaveBeenCalledTimes(2);
  });

  it('cancels pending country boundaries when a new selection replaces them', async () => {
    const f = fixture();
    f.delivery.loadEdgeDetails.mockImplementationOnce((_ids, signal) => untilAborted(signal));
    const old = expect(f.sources.showCountryDetail('AAA')).rejects.toHaveProperty('name', 'AbortError');
    await Promise.resolve();
    expect(f.delivery.loadEdgeDetails).toHaveBeenCalledOnce();
    await f.sources.showCountryDetail('BBB'); await old;
    expect(f.ports.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!.setData).toHaveBeenCalledOnce();
    expect(f.ports.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!.setData).toHaveBeenCalledOnce();
  });

  it.each(['country', 'cell'] as const)('cancels an obsolete %s request when its shared cell source is replaced', async kind => {
    const f = fixture(); let loading: Promise<FeatureCollection>;
    if (kind === 'country') {
      f.delivery.loadCountryDetail.mockImplementationOnce((_id, signal) => untilAborted(signal));
      loading = f.sources.showCountryDetail('AAA');
    } else {
      f.delivery.loadCellDetail.mockImplementationOnce((_cells, signal) => untilAborted(signal));
      loading = f.sources.showCellDetail([]);
    }
    const obsolete = expect(loading).rejects.toHaveProperty('name', 'AbortError');
    if (kind === 'country') await f.sources.showCellDetail([]); else await f.sources.showCountryDetail('BBB');
    await obsolete;
    expect(f.ports.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!.setData).toHaveBeenCalledExactlyOnceWith(data);
  });

  it('keeps edge requests independent of selection replacement and preserves the parent signal', async () => {
    const f = fixture(), parent = new AbortController(); let finish!: (value: Awaited<ReturnType<OperationalVectorDelivery['loadEdgeDetails']>>) => void;
    f.delivery.loadEdgeDetails.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const edge = f.sources.showEdgeDetail([1], parent.signal), edgeSignal = f.delivery.loadEdgeDetails.mock.calls[0][1]!;
    f.delivery.loadCountryDetail.mockImplementationOnce((_id, signal) => untilAborted(signal));
    const old = f.sources.showCountryDetail('AAA', parent.signal), obsolete = expect(old).rejects.toHaveProperty('name', 'AbortError');
    await f.sources.showCellDetail([], parent.signal); await obsolete;
    expect(parent.signal.aborted).toBe(false); expect(edgeSignal.aborted).toBe(false);
    finish([]); await edge; expect(f.ports.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!.setData).toHaveBeenCalledOnce();
  });

  it.each(['clear', 'dispose'] as const)('aborts both pending detail channels on %s', async operation => {
    const f = fixture();
    f.delivery.loadCountryDetail.mockImplementationOnce((_id, signal) => untilAborted(signal));
    f.delivery.loadEdgeDetails.mockImplementationOnce((_ids, signal) => untilAborted(signal));
    const country = expect(f.sources.showCountryDetail('AAA')).rejects.toHaveProperty('name', 'AbortError');
    const edge = expect(f.sources.showEdgeDetail([1])).rejects.toHaveProperty('name', 'AbortError');
    const cellPort = f.ports.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!, edgePort = f.ports.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!;
    if (operation === 'clear') f.sources.clearDetail(); else f.sources.dispose();
    await Promise.all([country, edge]);
    if (operation === 'clear') {
      expect(cellPort.setData).toHaveBeenCalledExactlyOnceWith(data); expect(edgePort.setData).toHaveBeenCalledExactlyOnceWith(data);
      await f.sources.showCountryDetail('BBB'); expect(cellPort.setData).toHaveBeenCalledTimes(2);
    } else {
      expect(cellPort.setData).not.toHaveBeenCalled(); expect(edgePort.setData).not.toHaveBeenCalled();
      expect(f.ports.size).toBe(0); expect(f.api.removeProtocol).toHaveBeenCalledOnce();
    }
  });

  it('propagates parent cancellation without publishing detail', async () => {
    const f = fixture(), parent = new AbortController();
    f.delivery.loadCountryDetail.mockImplementationOnce((_id, signal) => untilAborted(signal));
    const cancelled = expect(f.sources.showCountryDetail('AAA', parent.signal)).rejects.toHaveProperty('name', 'AbortError');
    parent.abort(); await cancelled;
    expect(f.ports.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!.setData).not.toHaveBeenCalled();
  });
});
