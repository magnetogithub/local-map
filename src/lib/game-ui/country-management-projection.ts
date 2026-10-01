import type {
  CountrySummaryViewModel,
  EconomyMetricViewModel,
  EconomyViewModel,
  NewsItemViewModel,
  PoliticsViewModel,
} from "./contracts";
import type {WorldMapRuntimeProjection} from "@/lib/projection/world-map-runtime-projection";
import type {SimulationStateV1} from "@/lib/simulation/simulation-state";
import type {ActiveCountryId, CountryId} from "@/lib/world/country-id";
import type {WorldStateV2} from "@/lib/world/world-state-v2";

type MapCountryFeature = Readonly<{
  properties?: Readonly<{ownerCountryId?: string | null; mapColor?: string}>;
}>;

const countryMapColor = (
  mapProjection: WorldMapRuntimeProjection,
  countryId: ActiveCountryId,
) => (mapProjection.countriesLow.features as readonly MapCountryFeature[])
  .find((feature) => feature.properties?.ownerCountryId === countryId)
  ?.properties?.mapColor ?? null;

export const createCountrySummaryProjection = (
  world: WorldStateV2,
  mapProjection: WorldMapRuntimeProjection,
  countryId: ActiveCountryId,
): CountrySummaryViewModel => {
  const country = world.countriesById[countryId];
  if (!country) throw new Error(`Management projection country is not active: ${countryId}`);
  return Object.freeze({
    countryId: country.id,
    nameKo: country.names.shortKo,
    code: country.id,
    flagUrl: null,
    mapColor: countryMapColor(mapProjection, country.id),
  });
};

export const projectCountryEvents = (
  simulation: SimulationStateV1 | null,
  countryId: ActiveCountryId,
  category: NewsItemViewModel["category"],
): readonly NewsItemViewModel[] => Object.freeze((simulation?.eventLog ?? [])
  .filter((event) => event.outcomeCategory === category && event.actorCountryIds.includes(countryId))
  .slice(-5)
  .reverse()
  .map((event) => Object.freeze({
    eventId: event.eventId,
    date: event.date,
    title: event.title,
    narrative: event.publicNarrative,
    category: event.outcomeCategory,
    significance: event.significance,
    relatedCountryIds: Object.freeze(event.actorCountryIds.map((id) => id as CountryId)),
    acknowledged: false,
  })));

export function createPoliticsProjection(input: Readonly<{
  world: WorldStateV2;
  mapProjection: WorldMapRuntimeProjection;
  countryId: ActiveCountryId;
  simulation: SimulationStateV1 | null;
}>): PoliticsViewModel {
  return Object.freeze({
    dataAvailable: false,
    unavailableReason: "정치 체제·지도자 데이터 연결 예정",
    country: createCountrySummaryProjection(input.world, input.mapProjection, input.countryId),
    regimeName: null,
    leaderName: null,
    domesticSituation: null,
    recentDomesticEvents: projectCountryEvents(input.simulation, input.countryId, "domestic"),
  });
}

const unavailableEconomyMetrics = (): readonly EconomyMetricViewModel[] => Object.freeze([
  Object.freeze({key: "production", label: "생산", value: null, unit: null, dataAvailable: false}),
  Object.freeze({key: "finance", label: "재정", value: null, unit: null, dataAvailable: false}),
  Object.freeze({key: "trade", label: "무역", value: null, unit: null, dataAvailable: false}),
]);

export function createEconomyProjection(input: Readonly<{
  world: WorldStateV2;
  mapProjection: WorldMapRuntimeProjection;
  countryId: ActiveCountryId;
  simulation: SimulationStateV1 | null;
}>): EconomyViewModel {
  return Object.freeze({
    dataAvailable: false,
    unavailableReason: "인구·경제 지표 데이터 연결 예정",
    country: createCountrySummaryProjection(input.world, input.mapProjection, input.countryId),
    population: null,
    summary: null,
    metrics: unavailableEconomyMetrics(),
    recentEconomicEvents: projectCountryEvents(input.simulation, input.countryId, "economic"),
  });
}
