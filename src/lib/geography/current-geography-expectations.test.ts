// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {createStateProvinceContractFixture} from '../test-only/state-province-contract-fixture';
import {deriveCurrentGeographyExpectations, observedGeographyCountryPartition, type CurrentGeographyOracleInput} from '../test-only/current-geography-expectations';

function fixture() {
  const f = createStateProvinceContractFixture(), artifact = f.metadata.provinces[0].sources[0].artifact;
  const input: CurrentGeographyOracleInput = {descriptor: {countryOrder: f.context.countryIds}, cells: f.context.cells,
    parents: f.context.administrativeParents.map(p => ({...p, macroId: p.sourceFeatureId ?? undefined})),
    features: new Map(f.ids.map(id => [id, {}])), fineProfiles: new Map(),
    coarse: {artifact, sourceId: 'fictional-coarse', version: 'fixture-v1',
      features: new Map(f.context.administrativeParents.filter(p => p.kind === 'administrative').map(p => [p.sourceFeatureId!, {name: p.name}]))}};
  const fineProfiles = new Map(input.fineProfiles), features = new Map(input.features);
  const refine = (country: string) => {
    const parents = input.parents.filter(p => p.sourceCountryId === country && p.kind === 'administrative');
    const sourceId = `fictional-fine-${country}`, sourceVersion = 'fixture-v2';
    const rawFeatures = new Map<string, {shapeName: string}>();
    for (const cell of input.cells.filter(c => c.sourceCountryId === country)) {
      const parent = input.parents[cell.administrativeOrdinal - 1];
      if (parent.kind !== 'administrative') continue;
      const featureId = `child:${parent.parentKey}`;
      rawFeatures.set(featureId, {shapeName: 'Shared source name'});
      features.set(cell.id, {fineSourceIdentity: {sourceId, sourceFeatureId: featureId}, sourceVersion});
    }
    fineProfiles.set(country, {sourceId, sourceVersion, raw: artifact, rawFeatures,
      macroSourceId: `fictional-macros-${country}`, macroArtifact: artifact,
      groups: new Map(parents.map(p => [p.macroId!, {macroId: p.macroId!, sourceFeatureId: `native:${p.macroId}`, name: p.name!, sourceVersion}]))});
  };
  const current = () => ({...input, features, fineProfiles});
  return {f, input, refine, current};
}

describe('independent current-catalog expectation derivation', () => {
  it('accepts a changing fine/coarse partition from source profiles and keeps exact IDs and source groups', () => {
    const h = fixture(), coarse = deriveCurrentGeographyExpectations(h.current());
    expect(coarse.fineCountries.size).toBe(0); expect(coarse.coarseCountries).toEqual(new Set(h.input.descriptor.countryOrder));
    h.refine('AAA'); const first = deriveCurrentGeographyExpectations(h.current());
    expect(first.fineCountries).toEqual(new Set(['AAA'])); expect(first.coarseCountries).toEqual(new Set(['BBB']));
    h.refine('BBB'); const next = deriveCurrentGeographyExpectations(h.current());
    expect(next.fineCountries).toEqual(new Set(h.input.descriptor.countryOrder)); expect(next.coarseCountries.size).toBe(0);
    expect(next.cells.map(c => c.provinceId)).toEqual(h.f.ids);
    expect(next.states.map(s => s.stateId)).toEqual(h.input.parents.filter(p => p.kind === 'administrative').map(p => p.parentKey));
    const shared = [...next.groups.values()].find(g => g.provinceIds.includes(h.f.ids[0]))!;
    expect(shared.provinceIds).toEqual(h.f.ids.slice(0, 2));
    expect(next.cells.find(c => c.provinceId === h.f.ids[4])?.precision).toBe('residual');
    expect(next.cells.filter(c => c.source === null).every(c => c.derivedDisplay)).toBe(true);
  });

  it('rejects duplicate IDs, missing cell links and incorrect country classification in the independent input', () => {
    const h = fixture(), input = h.current();
    expect(() => deriveCurrentGeographyExpectations({...input, cells: [...input.cells, input.cells[0]]})).toThrow('ORACLE_DUPLICATE_ID');
    expect(() => deriveCurrentGeographyExpectations({...input, features: new Map([...input.features].slice(1))})).toThrow('ORACLE_CELL_LINK');
    expect(() => deriveCurrentGeographyExpectations({...input, cells: [{...input.cells[0], sourceCountryId: input.cells[3].sourceCountryId}, ...input.cells.slice(1)]})).toThrow('ORACLE_CELL_LINK');
  });

  it('keeps an adopted fine country in the fine partition when all its current cells are residual', () => {
    const h = fixture(); h.refine('BBB');
    const input = h.current(), ids = new Set<string>(input.cells.filter(c => c.sourceCountryId === 'BBB').map(c => c.id));
    const residualOnly: CurrentGeographyOracleInput = {...input,
      features: new Map([...input.features].map(([id, feature]) => [id, ids.has(id) ? {} : feature])),
      parents: input.parents.map(p => p.sourceCountryId === 'BBB' ? {...p, kind: 'country-envelope-residual' as const,
        adminId: null, name: null, sourceFeatureId: null, sourceVersion: null, macroId: undefined} : p)};
    const expected = deriveCurrentGeographyExpectations(residualOnly);
    expect(expected.cells.filter(c => ids.has(c.provinceId)).every(c => c.precision === 'residual' && c.source === null && c.stateId === null)).toBe(true);
    const observed = observedGeographyCountryPartition(expected.cells);
    expect(observed.fineCountries).toEqual(expected.fineCountries);
    expect(observed.coarseCountries).toEqual(expected.coarseCountries);
    expect(expected.fineCountries).toEqual(new Set(['BBB']));
    const misclassified = expected.cells.map(c => ids.has(c.provinceId) ? {...c, precision: 'coarse' as const} : c);
    expect(observedGeographyCountryPartition(misclassified).fineCountries).not.toEqual(expected.fineCountries);
    expect(observedGeographyCountryPartition(misclassified).coarseCountries).not.toEqual(expected.coarseCountries);
  });
});
