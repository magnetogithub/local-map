import { z } from "zod";
import { countryById } from "@/lib/country/country-index";
export const STORAGE_KEY="pax-local:game-setup:v1";
export const persistedSchema=z.object({scenarioId:z.literal("2020-otl"),scenarioDate:z.literal("2020-01-01"),playerCountryId:z.string()});
export function readPersisted(raw:string|null){if(!raw)return null;try{const value=persistedSchema.parse(JSON.parse(raw));return countryById.get(value.playerCountryId)?.playable?value:null}catch{return null}}
export function persistPlayerCountry(playerCountryId:string){localStorage.setItem(STORAGE_KEY,JSON.stringify({scenarioId:"2020-otl",scenarioDate:"2020-01-01",playerCountryId}))}
