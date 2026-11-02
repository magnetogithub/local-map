// @vitest-environment node
import {expect,it} from 'vitest';
import {POST} from '@/app/api/world/labels/route';
import {buildCatalogCountryLabel,loadCatalogLabelSeed} from './catalog-labels.server';
import {prepareProductionCatalogSeed} from '../world/production-catalog-seed.server';
import {worldEffectSchema} from '../simulation/world-effect';
import {shapeFontOutlines} from './font-outline';
const seed=prepareProductionCatalogSeed(),pair=JSON.parse(seed.serializedPair);
const territoryIds=pair.world.territoryOrder.filter((id:string)=>pair.world.territoriesById[id].ownerCountryId==='FRA');
for(const length of [120,121,160,161])it(`rename and real label POST/font/layout share the ${length}-character boundary`,async()=>{
 const text='가'.repeat(length),effect={effectId:'effect.length',causedByEventId:'event.length',type:'country.renamed',countryId:'FRA',displayName:text};
 expect(worldEffectSchema.safeParse(effect).success).toBe(length<=160);
 const response=await POST(new Request('http://localhost/api/world/labels',{method:'POST',body:JSON.stringify({catalogRef:seed.bootstrap.catalogRef,countryId:'FRA',text,territoryIds})}));
 expect(response.status).toBe(length<=160?200:400);
 if(length>160){expect(()=>buildCatalogCountryLabel('FRA',text,territoryIds)).toThrow('LABEL_REQUEST_CAP');return;}
 const actual=buildCatalogCountryLabel('FRA',text,territoryIds),body=await response.json();expect(body).toEqual(actual);
 expect(actual.placement.properties?.mapLabelKo).toBe(text);expect(actual.placement.properties?.fontSizeWorldUnits).toBeGreaterThan(0);
 const font=loadCatalogLabelSeed(),shaped=shapeFontOutlines(font.font,font.fontHash,text);expect(shaped.glyphs).toHaveLength(length);expect(shaped.totalAdvance).toBeGreaterThan(0);
 expect(actual.fills.features).toHaveLength(length);expect(actual.outlines.features).toHaveLength(length);
 expect(actual.placement.properties).toMatchObject({readableFallback:true,placementMode:'small-country-point',mapLabelKo:text});
 const fallback=String(actual.placement.properties?.fallbackText);expect(fallback.replaceAll('\n','')).toBe(text);expect(fallback.split('\n').every(line=>line.length<=18)).toBe(true);
 for(const feature of actual.fills.features){expect(feature.geometry.type).toMatch(/Polygon/);expect(JSON.stringify(feature.geometry)).not.toContain('null');}
},120000);
