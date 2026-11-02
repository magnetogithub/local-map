import type {WorldStateV2} from '../world/world-state-v2';
import type {SimulationStateV1} from '../simulation/simulation-state';
import type {WorldMapRuntimeProjection} from '../projection/world-map-runtime-projection';
import type {CatalogMapConsumerProjection} from '../projection/catalog-map-consumer-projection';
export type GameWorldView=Pick<WorldStateV2,'countriesById'|'countryOrder'|'revision'>;
export type SimulationPresentation=Omit<SimulationStateV1,'schemaVersion'>&Readonly<{schemaVersion:1|2}>;
export type MapPresentation=WorldMapRuntimeProjection|CatalogMapConsumerProjection|Readonly<{world: Pick<import('../world/world-state-v3').WorldStateV3, 'countriesById'>}>;
export function presentationMapColor(projection:MapPresentation,id:string){
  if('world'in projection)return projection.world.countriesById[id]?.mapColor??null;
  return (projection.countriesLow.features as readonly {properties?:{ownerCountryId?:string|null;mapColor?:string}}[]).find(f=>f.properties?.ownerCountryId===id)?.properties?.mapColor??null;
}
