// @vitest-environment node
import fs from 'node:fs';
import {expect,it} from 'vitest';
import {loadCatalogLabelSeed,buildCatalogCountryLabel} from './catalog-labels.server';
import {prepareProductionCatalogSeed} from '../world/production-catalog-seed.server';
it('verifies approved seed identities and preserves exact shape-aware seed geometry',()=>{
 const seed=loadCatalogLabelSeed();expect(seed.fills).toEqual(JSON.parse(fs.readFileSync('public/data/maps/country-label-glyph-fills-2020.geojson','utf8')));
 for(const id of ['AUS','RUS','USA','CHN'])expect(seed.fills.features.filter(f=>f.properties.countryId===id).length).toBeGreaterThan(0);
 expect(seed.placements.features.some(f=>f.properties.countryId==='VAT'&&f.properties.placementMode==='small-country-point')).toBe(true);
});
it('builds and caches affected-country glyphs with the existing layout/font/typography policy',()=>{
 const p=JSON.parse(prepareProductionCatalogSeed().serializedPair),ids=p.world.territoryOrder.filter((id:string)=>p.world.territoriesById[id].ownerCountryId==='FRA');
 const result=buildCatalogCountryLabel('FRA','French Republic 2020',ids);expect(result.fills.features.length).toBeGreaterThan(0);expect(result.outlines.features).toHaveLength(result.fills.features.length);
 expect(result.placement.properties?.mapLabelKo).toBe('French Republic 2020');expect(buildCatalogCountryLabel('FRA','French Republic 2020',[...ids].reverse())).toBe(result);
 expect(()=>buildCatalogCountryLabel('FRA','Invalid',['territory:catalog:'+'0'.repeat(64)])).toThrow();
},120000);
