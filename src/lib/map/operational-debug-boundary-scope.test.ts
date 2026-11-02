// @vitest-environment node
import {describe, expect, it, vi} from 'vitest';
import {createOperationalDebugBoundaryScopeIndex, type OperationalDebugBoundaryWorld} from './operational-debug-boundary-scope';

function fixture(extraABContact = false) {
  const owners = ['A', 'A', 'B', 'B', 'C', 'C', 'D', null, null];
  const world: OperationalDebugBoundaryWorld = {territoryOrder: owners.map((_, i) => `cell:${i + 1}`),
    countriesById: {A: {}, B: {}, C: {}, D: {}, SOURCE: {}},
    territoriesById: Object.fromEntries(owners.map((owner, i) => [`cell:${i + 1}`,
      {ownerCountryId: owner, controllerCountryId: owner, sourceCountryId: 'SOURCE'}]))};
  const edges = [{left: 1, right: 2}, {left: 2, right: 3}, {left: 3, right: 4},
    {left: 4, right: 5}, {left: 5, right: 6}, {left: 6, right: 7},
    {left: 1, right: 0}, {left: 0, right: 7}, {left: 1, right: 8}, {left: 8, right: 9},
    ...(extraABContact ? [{left: 1, right: 4}] : [])];
  const incidence = vi.fn((n: number) => edges[n - 1]);
  const index = createOperationalDebugBoundaryScopeIndex({world, edgeCount: edges.length, edgeIncidence: incidence});
  return {world, index, incidence, edges};
}
function changed(world: OperationalDebugBoundaryWorld, changes: Record<number, {ownerCountryId?: string | null; controllerCountryId?: string | null}>) {
  return {...world, territoriesById: {...world.territoriesById, ...Object.fromEntries(Object.entries(changes).map(([ordinal, patch]) => {
    const id = world.territoryOrder[Number(ordinal) - 1];
    return [id, {...world.territoriesById[id]!, ...patch}];
  }))}};
}

describe('operational debug boundary country scope', () => {
  it('uses live owner identity rather than source and includes only one-hop countries', () => {
    const {index} = fixture();
    expect(index.scope('A')).toEqual({countryIds: ['A', 'B'], edgeOrdinals: [1, 2, 3, 4, 9]});
    // The B–C incident edge belongs to B, but C's internal and C–D edges do not.
    expect(index.scope('A').countryIds).not.toContain('C');
    expect(index.scope('A').edgeOrdinals).not.toContain(5);
    expect(index.scope('A').edgeOrdinals).not.toContain(6);
    expect(index.scope('SOURCE')).toEqual({countryIds: ['SOURCE'], edgeOrdinals: []});
  });

  it('excludes every sea/coast edge, null identity, and unknown hover', () => {
    const {index} = fixture();
    expect(index.scope(null)).toEqual({countryIds: [], edgeOrdinals: []});
    expect(index.scope('SEA')).toBe(index.scope(null));
    expect(index.scope('D').edgeOrdinals).toEqual([4, 5, 6]);
    expect(index.scope('A').edgeOrdinals).not.toContain(7);
    expect(index.scope('D').edgeOrdinals).not.toContain(8);
    expect(index.scope('A').edgeOrdinals).not.toContain(10);
  });

  it('memoizes frozen sorted scopes without reading incidence after initialization', () => {
    const {index, incidence, edges} = fixture();
    expect(incidence).toHaveBeenCalledTimes(edges.length);
    const scope = index.scope('A');
    expect(index.scope('A')).toBe(scope);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(scope.countryIds)).toBe(true);
    expect(Object.isFrozen(scope.edgeOrdinals)).toBe(true);
    expect(incidence).toHaveBeenCalledTimes(edges.length);
  });

  it('retains at most eight recent country scopes and refreshes hits', () => {
    const countriesById = Object.fromEntries('ABCDEFGHI'.split('').map(id => [id, {}]));
    const index = createOperationalDebugBoundaryScopeIndex({world: {territoryOrder: [], territoriesById: {}, countriesById},
      edgeCount: 0, edgeIncidence: () => {throw Error('NO_EDGES');}});
    const initial = Object.fromEntries('ABCDEFGH'.split('').map(id => [id, index.scope(id)]));
    expect(index.scope('A')).toBe(initial.A);
    index.scope('I');
    expect(index.scope('A')).toBe(initial.A);
    expect(index.scope('B')).not.toBe(initial.B);
  });

  it('treats same-world, unchanged cell, and occupation controller updates as no-ops', () => {
    const {index, world, incidence, edges} = fixture();
    const scope = index.scope('A');
    expect(index.update(world, [1])).toBe(false);
    expect(index.update(changed(world, {1: {controllerCountryId: 'C'}}), [1])).toBe(false);
    expect(index.scope('A')).toBe(scope);
    expect(index.update({...world, countriesById: {...world.countriesById}}, [1, 1])).toBe(false);
    expect(index.scope('A')).toBe(scope);
    expect(incidence).toHaveBeenCalledTimes(edges.length);
  });

  it('falls back to controller only when owner is null and updates that identity', () => {
    const {world, edges} = fixture();
    const initial = changed(world, {1: {ownerCountryId: null, controllerCountryId: 'A'}});
    const index = createOperationalDebugBoundaryScopeIndex({world: initial, edgeCount: edges.length, edgeIncidence: n => edges[n - 1]});
    expect(index.scope('A').countryIds).toEqual(['A', 'B']);
    expect(index.update(changed(initial, {1: {controllerCountryId: 'D'}}), [1])).toBe(true);
    expect(index.scope('A').countryIds).toEqual(['A', 'B', 'D']);
    expect(index.scope('D').edgeOrdinals).toEqual([1, 2, 4, 5, 6, 9]);
  });

  it('updates only changed-cell identities and preserves parallel country contacts by reference count', () => {
    const {index, world, incidence, edges} = fixture(true);
    const before = index.scope('A');
    const first = changed(world, {3: {ownerCountryId: 'C'}});
    expect(index.update(first, [3, 3])).toBe(true);
    expect(index.scope('A')).not.toBe(before);
    expect(index.scope('A').countryIds).toEqual(['A', 'B', 'C']);
    const second = changed(first, {4: {ownerCountryId: 'C'}});
    expect(index.update(second, [4])).toBe(true);
    expect(index.scope('A').countryIds).toEqual(['A', 'C']);
    expect(index.scope('B')).toEqual({countryIds: ['B'], edgeOrdinals: []});
    expect(incidence).toHaveBeenCalledTimes(edges.length);
  });

  it('updates a shared changed edge once when both endpoints change', () => {
    const {index, world} = fixture();
    const transferred = changed(world, {1: {ownerCountryId: 'D'}, 2: {ownerCountryId: 'D'}});
    expect(index.update(transferred, [1, 2, 1])).toBe(true);
    expect(index.scope('A')).toEqual({countryIds: ['A'], edgeOrdinals: []});
    expect(index.scope('D')).toEqual({countryIds: ['B', 'C', 'D'], edgeOrdinals: [1, 2, 3, 4, 5, 6, 9]});
  });

  it('removes retired countries from scope without scanning their cells and supports restoration', () => {
    const {index, world} = fixture();
    const cached = index.scope('A');
    const {B: _retired, ...countriesById} = world.countriesById;
    void _retired;
    const retired = {...world, countriesById};
    expect(index.update(retired, [])).toBe(true);
    expect(index.scope('B')).toBe(index.scope(null));
    expect(index.scope('A')).toEqual({countryIds: ['A'], edgeOrdinals: [1, 2, 9]});
    expect(index.scope('A')).not.toBe(cached);
    expect(index.update({...retired, countriesById: world.countriesById}, [])).toBe(true);
    expect(index.scope('A')).toEqual(cached);
  });

  it('does not read unrelated cell entities during an incremental update', () => {
    const {index, world} = fixture();
    const next = changed(world, {1: {ownerCountryId: 'D'}});
    const accessed: string[] = [];
    const territoriesById = new Proxy(next.territoriesById, {get(target, key: string) {accessed.push(key); return target[key];}});
    expect(index.update({...next, territoriesById}, [1])).toBe(true);
    expect(accessed).toEqual(['cell:1']);
  });
});
