/** Small structural contract: this index never imports geometry or world services. */
export type OperationalDebugBoundaryWorld = Readonly<{
  territoryOrder: readonly string[];
  territoriesById: Readonly<Record<string, Readonly<{
    ownerCountryId: string | null;
    controllerCountryId: string | null;
    sourceCountryId?: string | null;
  }> | undefined>>;
  countriesById: Readonly<Record<string, unknown>>;
}>;

export type OperationalDebugBoundaryScope = Readonly<{
  countryIds: readonly string[];
  edgeOrdinals: readonly number[];
}>;

type Incidence = Readonly<{left: number; right: number}>;
type Input = Readonly<{
  world: OperationalDebugBoundaryWorld;
  edgeCount: number;
  edgeIncidence: (ordinal: number) => Incidence;
}>;

const EMPTY_SCOPE: OperationalDebugBoundaryScope = Object.freeze({
  countryIds: Object.freeze([] as string[]), edgeOrdinals: Object.freeze([] as number[]),
});
const CACHE_LIMIT = 8;

/** Build lazily on the first debug hover. Topology/order must stay fixed for this
 * instance. Owner is the hover identity; controller is used only without owner.
 * Positive land edges are retained for scoped countries, including their outer
 * incident edges. A neighbor's neighbors do not expand the country scope.
 */
export function createOperationalDebugBoundaryScopeIndex(input: Input) {
  const cellIds = [...input.world.territoryOrder], count = cellIds.length;
  if (!Number.isSafeInteger(input.edgeCount) || input.edgeCount < 0) throw Error('INVALID_DEBUG_BOUNDARY_EDGE_COUNT');
  let currentWorld = input.world;
  const identities: (string | null)[] = [null];
  const identityAt = (world: OperationalDebugBoundaryWorld, n: number) => {
    if (!Number.isSafeInteger(n) || n < 1 || n > count || world.territoryOrder[n - 1] !== cellIds[n - 1]) throw Error('INVALID_DEBUG_BOUNDARY_CELL_ORDINAL');
    const cell = world.territoriesById[cellIds[n - 1]];
    if (!cell) throw Error('DEBUG_BOUNDARY_CELL_MISSING');
    return cell.ownerCountryId ?? cell.controllerCountryId;
  };
  for (let n = 1; n <= count; n++) identities.push(identityAt(input.world, n));
  const liveCountries = (world: OperationalDebugBoundaryWorld) => new Set(Object.keys(world.countriesById).filter(id => Boolean(world.countriesById[id])));
  let live = liveCountries(input.world);
  const left = new Uint32Array(input.edgeCount + 1), right = new Uint32Array(input.edgeCount + 1);
  const incidentEdges = Array.from({length: count + 1}, () => [] as number[]);
  const edgesByCountry = new Map<string, Set<number>>();
  const neighborReferences = new Map<string, Map<string, number>>();
  const cache = new Map<string, OperationalDebugBoundaryScope>();

  const membership = (country: string | null, edge: number, add: boolean) => {
    if (country === null) return;
    if (add) {
      let edges = edgesByCountry.get(country);
      if (!edges) edgesByCountry.set(country, edges = new Set());
      edges.add(edge);
    } else {
      const edges = edgesByCountry.get(country);
      edges?.delete(edge);
      if (edges?.size === 0) edgesByCountry.delete(country);
    }
  };
  const neighbor = (a: string, b: string, delta: 1 | -1) => {
    let refs = neighborReferences.get(a);
    const next = (refs?.get(b) ?? 0) + delta;
    if (next < 0) throw Error('INVALID_DEBUG_BOUNDARY_NEIGHBOR_REFERENCE');
    if (next > 0) {
      if (!refs) neighborReferences.set(a, refs = new Map());
      refs.set(b, next);
    } else {
      refs?.delete(b);
      if (refs?.size === 0) neighborReferences.delete(a);
    }
  };
  const indexEdge = (n: number, add: boolean) => {
    const a = identities[left[n]], b = identities[right[n]];
    membership(a, n, add);
    if (b !== a) membership(b, n, add);
    if (a !== null && b !== null && a !== b) {
      const delta = add ? 1 : -1;
      neighbor(a, b, delta); neighbor(b, a, delta);
    }
  };
  for (let n = 1; n <= input.edgeCount; n++) {
    const edge = input.edgeIncidence(n);
    if (![edge.left, edge.right].every(v => Number.isSafeInteger(v) && v >= 0 && v <= count) ||
        (edge.left > 0 && edge.left === edge.right)) throw Error('INVALID_DEBUG_BOUNDARY_INCIDENCE');
    if (!edge.left || !edge.right) continue;
    left[n] = edge.left; right[n] = edge.right;
    incidentEdges[edge.left].push(n); incidentEdges[edge.right].push(n);
    indexEdge(n, true);
  }

  const scope = (hoveredCountry: string | null): OperationalDebugBoundaryScope => {
    if (hoveredCountry === null || !live.has(hoveredCountry)) return EMPTY_SCOPE;
    const cached = cache.get(hoveredCountry);
    if (cached) {cache.delete(hoveredCountry); cache.set(hoveredCountry, cached); return cached;}
    const countryIds = [hoveredCountry, ...[...(neighborReferences.get(hoveredCountry)?.keys() ?? [])].filter(id => live.has(id))].sort();
    const edges = new Set<number>();
    for (const country of countryIds) for (const n of edgesByCountry.get(country) ?? []) edges.add(n);
    const result = Object.freeze({countryIds: Object.freeze(countryIds), edgeOrdinals: Object.freeze([...edges].sort((a, b) => a - b))});
    cache.set(hoveredCountry, result);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    return result;
  };
  const update = (world: OperationalDebugBoundaryWorld, changedCellOrdinals: readonly number[]): boolean => {
    if (world === currentWorld) return false;
    if (world.territoryOrder.length !== count) throw Error('DEBUG_BOUNDARY_TOPOLOGY_CHANGED');
    const nextLive = world.countriesById === currentWorld.countriesById ? live : liveCountries(world);
    const liveChanged = nextLive.size !== live.size || [...nextLive].some(id => !live.has(id));
    const changes = new Map<number, string | null>();
    for (const n of changedCellOrdinals) {
      const identity = identityAt(world, n);
      if (identity !== identities[n]) changes.set(n, identity);
    }
    if (changes.size) {
      const affected = new Set<number>();
      for (const n of changes.keys()) for (const edge of incidentEdges[n]) affected.add(edge);
      for (const edge of affected) indexEdge(edge, false);
      for (const [n, identity] of changes) identities[n] = identity;
      for (const edge of affected) indexEdge(edge, true);
    }
    currentWorld = world; live = nextLive;
    if (changes.size || liveChanged) {cache.clear(); return true;}
    return false;
  };
  return Object.freeze({scope, update});
}
