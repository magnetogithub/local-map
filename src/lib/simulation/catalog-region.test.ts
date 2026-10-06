// @vitest-environment node
import {describe,it,expect} from 'vitest';
import {loadCatalogRegionIndex} from './catalog-region.server';
describe('approved catalog region identity',()=>{
  it('resolves named source regions without exposing geometry',()=>{
    const index=loadCatalogRegionIndex(),matches=index.search('CHN','Guangdong');
    expect(matches).toHaveLength(1);const region=index.resolve('CHN',matches[0].ref,'occupy');
    expect(region.territoryIds.length).toBeGreaterThan(0);expect(region.provenanceIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(region)).not.toMatch(/coordinates|geometry"/);
    expect(()=>index.resolve('USA',region.ref,'occupy')).toThrow('REGION_COUNTRY_SCOPE');
    expect(()=>index.resolve('CHN',{...region.ref,sourceVersion:'0'.repeat(64)},'occupy')).toThrow();
    expect(()=>index.resolve('CHN',region.ref,'invalid')).toThrow();
    expect(()=>index.resolve('CHN',region.ref,'occupy',0)).toThrow('REGION_REQUEST_CAP');
    expect(index.search('CHN','missing admin name')).toEqual([]);
    expect(index.search('USA','Carolina').length).toBeGreaterThan(1);
    expect(index.records.filter(r=>r.parentCountryId==='CHN')).toHaveLength(32);
    expect(index.records.filter(r=>r.parentCountryId==='USA')).toHaveLength(52);
  });
});
