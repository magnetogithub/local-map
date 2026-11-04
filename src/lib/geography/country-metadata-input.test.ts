// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {createCountryMetadataHandoffFixture} from '../test-only/country-metadata-handoff-fixture';
import {
  countGeographyCountry, sealGeographyMetadata, stateIdSchema,
  type GeographyMetadata,
} from './state-province-contract';
import {validateGeographyMetadata, type GeographyDiagnosticCode} from './state-province-validation';
import {validateCountryMetadataInput} from './country-metadata-input';

function reseal(doc: GeographyMetadata) {
  const {metadataRef, ...body} = doc;
  void metadataRef;
  return sealGeographyMetadata(body);
}
function rejects(value: unknown, code: GeographyDiagnosticCode, country: unknown = 'AAA') {
  const {shared} = createCountryMetadataHandoffFixture();
  const result = validateCountryMetadataInput(country, value, shared.context);
  expect(result).toMatchObject({ok: false, diagnostics: [{code}]});
  if (!result.ok) expect(result.diagnostics[0].remedy).toBeTruthy();
}

describe('country metadata producer handoff', () => {
  it.each(['AAA', 'BBB'])('reuses the common contract for fictional %s without a fine-country allowlist', country => {
    const {shared, inputs} = createCountryMetadataHandoffFixture();
    const input = inputs.find(i => i.sourceCountryId === country)!;
    const before = JSON.stringify({input, context: shared.context});
    const result = validateCountryMetadataInput(country, input.metadata, shared.context);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    expect(result.value.scope).toBe('country-preparation');
    expect(result.value.sourceCountryId).toBe(country);
    expect(result.value.metadata.catalogRef).toEqual(shared.catalog.ref);
    expect(result.value.metadata.countries).toHaveLength(1);
    expect(Object.isFrozen(result.value.metadata.provinces[0].names)).toBe(true);
    expect(JSON.stringify({input, context: shared.context})).toBe(before);
    // A country preparation is not a complete metadata release for the global catalog.
    expect(validateGeographyMetadata(input.metadata, shared.context)).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_MEMBERSHIP'}]});
  });

  it('retains global parent ordinals and coarse/residual/null support in the second country', () => {
    const {shared, inputs} = createCountryMetadataHandoffFixture();
    expect(shared.context.cells[3].administrativeOrdinal).toBe(3);
    const result = validateCountryMetadataInput('BBB', inputs[1].metadata, shared.context);
    if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
    expect(result.value.metadata.provinces[0]).toMatchObject({precision: 'coarse', parentStatus: 'verified', stateId: shared.stateB});
    expect(result.value.metadata.provinces[1]).toMatchObject({precision: 'residual', stateId: null, names: {displayBasis: 'derived', sourceName: null, nameKo: null}});
    expect(result.value.metadata.sourceRegions[0].coverage.status).toBe('unsupported');
    expect(result.value.metadata.countries[0].officialSubdivisionCount).toBeNull();
  });

  it.each(['CCC', 'KOR', 'Korea', 'aaa', ' AAA', null])('rejects unregistered or malformed country %s', country => {
    const {inputs} = createCountryMetadataHandoffFixture();
    rejects(inputs[0].metadata, 'GEOGRAPHY_CATALOG', country);
  });

  it('requires the full existing country set, not an unrelated or mixed-country submission', () => {
    const {shared, inputs} = createCountryMetadataHandoffFixture();
    rejects(inputs[1].metadata, 'GEOGRAPHY_MEMBERSHIP');
    rejects(shared.metadata, 'GEOGRAPHY_MEMBERSHIP');
  });

  it.each(['geometryRoot', 'topologyRoot', 'renderArtifactRoot', 'catalogVersion', 'manifestPath'] as const)('rejects a stale %s against the pinned global catalog', field => {
    const {inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    if (field === 'catalogVersion') {
      changed.catalogRef = {...changed.catalogRef, catalogVersion: 'synthetic-other-v1', manifestPath: '/data/catalogs/synthetic-other-v1/manifest.json'};
    } else {
      changed.catalogRef = {...changed.catalogRef, [field]: field === 'manifestPath' ? '/data/other/synthetic-geography-v1/manifest.json' : 'f'.repeat(64)};
    }
    rejects(reseal(changed), 'GEOGRAPHY_CATALOG');
  });

  it('rejects country relabeling even when its summary was recomputed and sealed', () => {
    const {inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    changed.provinces[0].sourceCountryId = inputs[1].sourceCountryId;
    changed.countries[0].counts = countGeographyCountry(changed, 'AAA');
    rejects(reseal(changed), 'GEOGRAPHY_CATALOG');
  });

  it.each(['omit', 'duplicate', 'foreign-cell'] as const)('rejects %s province membership', operation => {
    const {inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    if (operation === 'omit') changed.provinces.pop();
    if (operation === 'duplicate') changed.provinces.push(structuredClone(changed.provinces[0]));
    if (operation === 'foreign-cell') changed.provinces.push(structuredClone(inputs[1].metadata.provinces[0]));
    rejects(reseal(changed), 'GEOGRAPHY_MEMBERSHIP');
  });

  it.each(['foreign', 'missing'] as const)('rejects a %s verified parent reference', kind => {
    const {shared, inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    changed.provinces[0] = {...changed.provinces[0], parentStatus: 'verified', stateId: kind === 'foreign' ? shared.stateB : stateIdSchema.parse('unregistered-parent'), unassignedReason: null};
    rejects(reseal(changed), 'GEOGRAPHY_PARENT');
  });

  it('compares raw parent identities against independent crosswalk evidence', () => {
    const {inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    changed.states[0].source.sourceFeatureId = 'invented-parent';
    rejects(reseal(changed), 'GEOGRAPHY_PARENT');
  });

  it('rejects an invented source identity and an incomplete group of an admitted source', () => {
    const {inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    changed.provinces[0].sources[0].sourceFeatureId = 'invented-feature';
    rejects(reseal(changed), 'GEOGRAPHY_SOURCE');
    const split = structuredClone(inputs[0].metadata);
    split.sourceRegions[0].provinceIds.pop();
    rejects(reseal(split), 'GEOGRAPHY_SOURCE');
  });

  it('rejects a raw source mapped to another catalog country', () => {
    const {inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    changed.provinces[0].sources = structuredClone(inputs[1].metadata.provinces[0].sources);
    rejects(reseal(changed), 'GEOGRAPHY_SOURCE');
  });

  it('keeps omitted source evidence in scope instead of trusting the submitted group list', () => {
    const {inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    const port = changed.provinces[2];
    port.sources = [];
    port.precision = 'coarse';
    port.geometryStatus = 'source-free';
    port.names = {...port.names, displayBasis: 'derived', sourceName: null};
    changed.sourceRegions.pop();
    changed.countries[0].counts = countGeographyCountry(changed, 'AAA');
    rejects(reseal(changed), 'GEOGRAPHY_SOURCE');
  });

  it('rejects forged complete coverage and uses only independently supplied witnesses', () => {
    const {shared, inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    changed.sourceRegions[1].coverage = {...changed.sourceRegions[0].coverage, knownProvinceCount: 1, expectedProvinceCount: 1};
    rejects(reseal(changed), 'GEOGRAPHY_COVERAGE');
    expect(validateCountryMetadataInput('AAA', inputs[0].metadata, {...shared.context, coverageWitnesses: []})).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_COVERAGE'}]});
  });

  it('rejects unsealed edits and extra mutable state through the shared validator', () => {
    const {inputs} = createCountryMetadataHandoffFixture();
    const changed = structuredClone(inputs[0].metadata);
    changed.provinces[0].names.displayName = 'edited without sealing';
    rejects(changed, 'GEOGRAPHY_METADATA');
    const mutable = structuredClone(inputs[0].metadata);
    Object.assign(mutable.provinces[0], {ownerCountryId: 'BBB'});
    rejects(mutable, 'GEOGRAPHY_SCHEMA');
  });

  it('leaves global assembly to the integrator and validates that assembly with the same contract', () => {
    const {shared, inputs} = createCountryMetadataHandoffFixture();
    const prepared = inputs.map(input => {
      const result = validateCountryMetadataInput(input.sourceCountryId, input.metadata, shared.context);
      if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
      return result.value.metadata;
    });
    const {metadataRef, ...body} = structuredClone(shared.metadata);
    void metadataRef;
    body.states = prepared.flatMap(p => p.states);
    body.provinces = prepared.flatMap(p => p.provinces);
    body.sourceRegions = prepared.flatMap(p => p.sourceRegions);
    body.countries = prepared.flatMap(p => p.countries);
    expect(validateGeographyMetadata(sealGeographyMetadata(body), shared.context).ok).toBe(true);
  });
});
