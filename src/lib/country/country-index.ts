import data from "@/data/countries-2020.json";
import type { Country } from "@/types/country";
import { normalizeSearchText } from "./normalize-search-text";
export const countries = data as unknown as Country[];
export const countryById = new Map(countries.map(c=>[c.id,c]));
const rank=(value:string,q:string)=>value===q?0:value.startsWith(q)?1:value.includes(q)?2:9;
export function searchCountries(query:string, limit=8){const q=normalizeSearchText(query);if(!q)return [];return countries.filter(c=>c.playable).map(c=>({c,score:Math.min(rank(normalizeSearchText(c.id),q),rank(normalizeSearchText(c.nameKo),q),rank(normalizeSearchText(c.nameEn),q),rank(normalizeSearchText(c.iso3),q))})).filter(x=>x.score<9).sort((a,b)=>a.score-b.score||a.c.nameKo.localeCompare(b.c.nameKo,"ko")).slice(0,limit).map(x=>x.c)}
