import {sealGeographyMetadata} from '../geography/state-province-contract';
import {createStateProvinceContractFixture} from './state-province-contract-fixture';

/** Country preparation examples only; no real country, source-lock or publication. */
export function createCountryMetadataHandoffFixture() {
  const shared = createStateProvinceContractFixture();
  const inputs = shared.metadata.countries.map(country => {
    const {metadataRef, ...body} = structuredClone(shared.metadata);
    void metadataRef;
    body.states = body.states.filter(s => s.sourceCountryId === country.sourceCountryId);
    body.provinces = body.provinces.filter(p => p.sourceCountryId === country.sourceCountryId);
    body.sourceRegions = body.sourceRegions.filter(r => r.sourceCountryId === country.sourceCountryId);
    body.countries = body.countries.filter(c => c.sourceCountryId === country.sourceCountryId);
    body.provenance.method = 'Fictional country preparation example; not an adopted country dataset';
    return {sourceCountryId: country.sourceCountryId, metadata: sealGeographyMetadata(body)};
  });
  return {shared, inputs};
}
