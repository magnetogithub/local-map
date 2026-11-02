// @vitest-environment node
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {FeatureCollection, Polygon} from 'geojson';
import type {OperationalVectorDelivery} from './operational-vector-delivery';
import {createOperationalMapSources, OperationalMapSourceWriteError, OPERATIONAL_EXACT_CELL_SOURCE_ID, OPERATIONAL_EXACT_EDGE_SOURCE_ID} from './operational-map-sources';

const cleanups: (() => void)[] = [];
afterEach(() => {for (const cleanup of cleanups.splice(0)) cleanup();});
const data: FeatureCollection<Polygon> = {type: 'FeatureCollection', features: []};
function untilAborted<Value>(signal?: AbortSignal): Promise<Value> {
  return new Promise((_resolve, reject) => {
    if (!signal) throw Error('Missing request signal');
    signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  });
}
function fixture(onEdgeDetailChange = vi.fn<(ordinals: readonly number[]) => void>()) {
  const ports = new Map<string, {setData: ReturnType<typeof vi.fn>}>();
  const map = {addSource: (id: string) => ports.set(id, {setData: vi.fn()}), removeSource: (id: string) => ports.delete(id), getSource: (id: string) => ports.get(id)};
  const api = {addProtocol: vi.fn(), removeProtocol: vi.fn()};
  const identity = {path: '/fixture', sha256: 'a'.repeat(64), byteLength: 0};
  const delivery = {protocol: 'source-cancellation-fixture', source: {type: 'vector' as const, tiles: ['fixture:///{z}/{x}/{y}']},
    bootstrap: {manifest: identity, tileIndex: identity}, loadTile: vi.fn(async () => new ArrayBuffer(0)),
    incidentEdges: vi.fn<OperationalVectorDelivery['incidentEdges']>(() => []),
    loadCountryDetail: vi.fn(async (_id: string, signal?: AbortSignal) => {signal?.throwIfAborted(); return data;}),
    loadCountryViewportDetail: vi.fn<OperationalVectorDelivery['loadCountryViewportDetail']>(async (_id, _bounds, signal) => {signal?.throwIfAborted(); return {cells:data,edges:[]};}),
    loadCellDetail: vi.fn(async (_cells: readonly {id: string; sourceCountryId: string}[], signal?: AbortSignal) => {signal?.throwIfAborted(); return data;}),
    loadEdgeDetails: vi.fn(async (_ordinals: readonly number[], signal?: AbortSignal) => {signal?.throwIfAborted(); return [] as Awaited<ReturnType<OperationalVectorDelivery['loadEdgeDetails']>>;})};
  const sources = createOperationalMapSources(map, api, delivery as unknown as OperationalVectorDelivery, onEdgeDetailChange);
  cleanups.push(sources.dispose); return {sources, delivery, ports, api, onEdgeDetailChange};
}
const edgeDetails = (...ordinals: number[]): Awaited<ReturnType<OperationalVectorDelivery['loadEdgeDetails']>> => ordinals.map(ordinal => ({
  id: `edge:operational:${String(ordinal).padStart(64, '0')}`, ordinal, left: 1, right: 2, boundaryClass: 'administrative',
  flags: {positiveAdjacency: true, country: false, administrative: true, previous: false, residual: false},
  geometry: {type: 'LineString', coordinates: [[0, ordinal], [1, ordinal]]},
}));

describe('operational detail request cancellation', () => {
  it('publishes complete viewport cells and edges once and skips the same immutable scope', async () => {
    const f=fixture(), cells:FeatureCollection<Polygon>={type:'FeatureCollection',features:[{type:'Feature',id:11,properties:{},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]],[[.2,.2],[.2,.3],[.3,.3],[.3,.2],[.2,.2]]]}}]};
    f.delivery.loadCountryViewportDetail.mockResolvedValue({cells,edges:edgeDetails(2)});
    await f.sources.showCountryViewportDetail('AAA',[0,0,1,1]);
    const cell=f.ports.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!,edge=f.ports.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!;
    expect(f.delivery.loadCountryDetail).not.toHaveBeenCalled();expect(cell.setData).toHaveBeenCalledExactlyOnceWith(cells);
    expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith([2]);expect(f.sources.getDetailSourceWrites()).toBe(2);
    f.delivery.loadCountryViewportDetail.mockResolvedValue(structuredClone({cells,edges:edgeDetails(2)}));
    await f.sources.showCountryViewportDetail('AAA',[.01,0,1.01,1]);
    expect(cell.setData).toHaveBeenCalledOnce();expect(edge.setData).toHaveBeenCalledOnce();expect(f.sources.getDetailSourceWrites()).toBe(2);
  });

  it('rejects an obsolete viewport even when transport ignores cancellation', async () => {
    const f=fixture();let finish!:(value:Awaited<ReturnType<OperationalVectorDelivery['loadCountryViewportDetail']>>)=>void;
    f.delivery.loadCountryViewportDetail.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const stale=expect(f.sources.showCountryViewportDetail('AAA',[0,0,1,1])).rejects.toHaveProperty('name','AbortError');
    f.delivery.loadCountryViewportDetail.mockResolvedValueOnce({cells:data,edges:edgeDetails(5)});
    await f.sources.showCountryViewportDetail('BBB',[1,1,2,2]);finish({cells:data,edges:edgeDetails(2)});await stale;
    expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith([5]);expect(f.sources.getDetailSourceWrites()).toBe(2);
  });
  it('stages country polygons and their real incident boundaries before replacing detail', async () => {
    const f = fixture();
    await f.sources.showCountryDetail('AAA');
    const cells = f.ports.get(OPERATIONAL_EXACT_CELL_SOURCE_ID)!, edges = f.ports.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!;
    expect(cells.setData).toHaveBeenCalledOnce(); expect(edges.setData).toHaveBeenCalledOnce();
    expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith([]);
    f.delivery.loadEdgeDetails.mockRejectedValueOnce(Error('boundaries offline'));
    await expect(f.sources.showCountryDetail('BBB')).rejects.toThrow('boundaries offline');
    expect(cells.setData).toHaveBeenCalledOnce(); expect(edges.setData).toHaveBeenCalledOnce();
    expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith([]);
    await f.sources.showCountryDetail('BBB');
    expect(cells.setData).toHaveBeenCalledTimes(2); expect(edges.setData).toHaveBeenCalledTimes(2);
    expect(f.onEdgeDetailChange).toHaveBeenCalledTimes(2);
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
    expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith([]);
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
    expect(f.onEdgeDetailChange).not.toHaveBeenCalled();
  });

  it.each(['country', 'edge'] as const)('notifies exact edge identities after successful %s publication and releases them on clear', async kind => {
    const f = fixture(), order: string[] = [];
    f.delivery.incidentEdges.mockReturnValue([2, 5]); f.delivery.loadEdgeDetails.mockResolvedValue(edgeDetails(2, 5));
    f.ports.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!.setData.mockImplementation(() => order.push('published'));
    f.onEdgeDetailChange.mockImplementation(ids => {order.push('notified'); expect(Object.isFrozen(ids)).toBe(true);});
    if (kind === 'country') await f.sources.showCountryDetail('AAA'); else await f.sources.showEdgeDetail([2, 5]);
    expect(order).toEqual(['published', 'notified']); expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith([2, 5]);
    await f.sources.showCellDetail([]); expect(f.onEdgeDetailChange).toHaveBeenCalledOnce();
    f.sources.clearDetail(); expect(f.onEdgeDetailChange).toHaveBeenLastCalledWith([]);
    expect(order).toEqual(['published', 'notified', 'published', 'notified']);
  });

  it('does not notify a stale edge result that ignores request cancellation', async () => {
    const f = fixture(); let finish!: (value: Awaited<ReturnType<OperationalVectorDelivery['loadEdgeDetails']>>) => void;
    f.delivery.loadEdgeDetails.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const stale = expect(f.sources.showEdgeDetail([2])).rejects.toHaveProperty('name', 'AbortError');
    f.delivery.loadEdgeDetails.mockResolvedValueOnce(edgeDetails(5)); await f.sources.showEdgeDetail([5]);
    finish(edgeDetails(2)); await stale;
    expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith([5]);
  });

  it.each(['clear', 'dispose'] as const)('does not notify late edge data after %s', async operation => {
    const f = fixture(); let finish!: (value: Awaited<ReturnType<OperationalVectorDelivery['loadEdgeDetails']>>) => void;
    f.delivery.loadEdgeDetails.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
    const stale = expect(f.sources.showEdgeDetail([2])).rejects.toHaveProperty('name', 'AbortError');
    if (operation === 'clear') f.sources.clearDetail(); else f.sources.dispose();
    finish(edgeDetails(2)); await stale;
    if (operation === 'clear') expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith([]);
    else expect(f.onEdgeDetailChange).not.toHaveBeenCalled();
  });

  it('keeps the previous edge identities when fetch or source publication fails', async () => {
    const f = fixture(); f.delivery.loadEdgeDetails.mockResolvedValueOnce(edgeDetails(2)); await f.sources.showEdgeDetail([2]);
    f.delivery.loadEdgeDetails.mockRejectedValueOnce(Error('edge offline'));
    await expect(f.sources.showEdgeDetail([5])).rejects.toThrow('edge offline');
    f.ports.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!.setData.mockImplementationOnce(() => {throw Error('edge worker');});
    await expect(f.sources.showEdgeDetail([5])).rejects.toBeInstanceOf(OperationalMapSourceWriteError);
    expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith([2]);
  });

  it.each(['country', 'edge', 'clear'] as const)('wraps a synchronous %s notification failure as a source publication failure', async operation => {
    const failure = Error('edge mask publication');
    const f = fixture(); f.onEdgeDetailChange.mockImplementationOnce(() => {throw failure;});
    f.delivery.loadEdgeDetails.mockResolvedValue(edgeDetails(2));
    if (operation === 'clear') {
      expect(() => f.sources.clearDetail()).toThrow(OperationalMapSourceWriteError);
    } else {
      const pending = operation === 'country' ? f.sources.showCountryDetail('AAA') : f.sources.showEdgeDetail([2]);
      await expect(pending).rejects.toMatchObject({name: 'Error', message: 'OPERATIONAL_MAP_SOURCE_WRITE_FAILED', cause: failure});
    }
    expect(f.ports.get(OPERATIONAL_EXACT_EDGE_SOURCE_ID)!.setData).toHaveBeenCalledOnce();
    expect(f.onEdgeDetailChange).toHaveBeenCalledExactlyOnceWith(operation === 'clear' ? [] : [2]);
  });
});
