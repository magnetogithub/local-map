import {describe, expect, it} from 'vitest';
import {createCatalogBorderLookup} from './catalog-border-lookup';

describe('approved catalog border lookup', () => {
  const entries = [
    {id:'north.a',sourceCountryId:'PRK'}, {id:'north.b',sourceCountryId:'PRK'},
    {id:'north.interior',sourceCountryId:'PRK'}, {id:'south.a',sourceCountryId:'KOR'},
    {id:'other.a',sourceCountryId:'CHN'},
  ];
  const edges = [
    {leftTerritoryId:'north.a',rightTerritoryId:'south.a'},
    {leftTerritoryId:'south.a',rightTerritoryId:'north.b'},
    {leftTerritoryId:'north.a',rightTerritoryId:'north.interior'},
    {leftTerritoryId:'north.interior',rightTerritoryId:'other.a'},
    {leftTerritoryId:'north.interior',rightTerritoryId:null},
    {leftTerritoryId:'north.a',rightTerritoryId:'south.a'},
  ];
  it('returns only sorted existing cells on the requested side, without coast or interior cells', () => {
    const lookup = createCatalogBorderLookup(entries,edges);
    expect(lookup('PRK','KOR',512)).toEqual(['north.a','north.b']);
    expect(lookup('KOR','PRK',512)).toEqual(['south.a']);
    expect(lookup('PRK','CHN',512)).toEqual(['north.interior']);
    expect(lookup('KOR','CHN',512)).toEqual([]);
  });
  it('rejects unknown topology members, duplicates, invalid scope, and cap overflow without truncating', () => {
    expect(() => createCatalogBorderLookup(entries,[{leftTerritoryId:'missing',rightTerritoryId:'south.a'}])).toThrow();
    expect(() => createCatalogBorderLookup([...entries,entries[0]],edges)).toThrow();
    const lookup = createCatalogBorderLookup(entries,edges);
    expect(() => lookup('PRK','KOR',1)).toThrow('BORDER_REQUEST_CAP');
    expect(() => lookup('PRK','PRK',512)).toThrow();
    expect(() => lookup('PRK','KOR',513)).toThrow();
  });
});
