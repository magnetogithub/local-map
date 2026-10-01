import type {
  BilateralRelationshipViewModel,
  CountryViewModel,
  DiplomacyChannelViewModel,
} from "./contracts";
import {
  createCountrySummaryProjection,
  projectCountryEvents,
} from "./country-management-projection";
import type {WorldMapRuntimeProjection} from "@/lib/projection/world-map-runtime-projection";
import {getCountryPanelView, type CountryPanelProjection} from "@/lib/projection/country-panel-projection";
import type {SimulationStateV1} from "@/lib/simulation/simulation-state";
import type {ActiveCountryId} from "@/lib/world/country-id";
import type {CountryPoliticalStatus} from "@/lib/world/country-entity";
import type {WorldStateV2} from "@/lib/world/world-state-v2";

const politicalStatusLabel: Record<CountryPoliticalStatus, string> = {
  sovereign: "주권 국가",
  dependent: "속령",
  disputed: "분쟁 지역",
  unrecognized: "미승인 국가",
};

export function createRelationshipProjection(input: Readonly<{
  world: WorldStateV2;
  mapProjection: WorldMapRuntimeProjection;
  playerCountryId: ActiveCountryId;
  foreignCountryId: ActiveCountryId;
}>): BilateralRelationshipViewModel {
  const player = createCountrySummaryProjection(input.world, input.mapProjection, input.playerCountryId);
  const foreign = createCountrySummaryProjection(input.world, input.mapProjection, input.foreignCountryId);
  return Object.freeze({
    playerToForeign: Object.freeze({
      fromCountry: player,
      toCountry: foreign,
      score: null,
      dataAvailable: false,
    }),
    foreignToPlayer: Object.freeze({
      fromCountry: foreign,
      toCountry: player,
      score: null,
      dataAvailable: false,
    }),
  });
}

export function createCountryViewProjection(input: Readonly<{
  world: WorldStateV2;
  mapProjection: WorldMapRuntimeProjection;
  playerCountryId: ActiveCountryId;
  countryId: ActiveCountryId;
  simulation: SimulationStateV1 | null;
  countryPanelProjection: CountryPanelProjection;
}>): CountryViewModel {
  const entity = input.world.countriesById[input.countryId];
  if (!entity) throw new Error(`Country view target is not active: ${input.countryId}`);
  const isPlayerCountry = input.countryId === input.playerCountryId;
  const panelView = input.countryPanelProjection.appliedRevision === input.world.revision
    ? getCountryPanelView(input.countryPanelProjection, input.countryId)
    : null;
  const optionalPresentationText = (value: string | undefined) => {
    const normalized = value?.trim() ?? "";
    return normalized.length > 0 && normalized !== "??" ? normalized : null;
  };
  return Object.freeze({
    country: createCountrySummaryProjection(input.world, input.mapProjection, input.countryId),
    officialNameKo: entity.names.officialKo,
    englishName: entity.names.english,
    politicalStatus: politicalStatusLabel[entity.politicalStatus],
    capitalKo: optionalPresentationText(panelView?.capitalKo),
    capitalEn: optionalPresentationText(panelView?.capitalEn),
    region: optionalPresentationText(panelView?.region),
    isPlayerCountry,
    relationship: isPlayerCountry ? null : createRelationshipProjection({
      world: input.world,
      mapProjection: input.mapProjection,
      playerCountryId: input.playerCountryId,
      foreignCountryId: input.countryId,
    }),
    recentEvents: Object.freeze((input.simulation?.eventLog ?? [])
      .filter((event) => event.actorCountryIds.includes(input.countryId))
      .slice(-5)
      .reverse()
      .map((event) => projectCountryEvents({...input.simulation!, eventLog: [event]}, input.countryId, event.outcomeCategory)[0])),
    relatedWars: Object.freeze([]),
    warsDataAvailable: false,
  });
}

export function createDiplomacyChannelProjection(input: Readonly<{
  world: WorldStateV2;
  mapProjection: WorldMapRuntimeProjection;
  playerCountryId: ActiveCountryId;
  counterpartCountryId: ActiveCountryId | null;
}>): DiplomacyChannelViewModel {
  const availableCounterparts = Object.freeze(input.world.countryOrder
    .filter((countryId) => countryId !== input.playerCountryId)
    .map((countryId) => createCountrySummaryProjection(input.world, input.mapProjection, countryId)));
  const counterpart = input.counterpartCountryId === null
    ? null
    : createCountrySummaryProjection(input.world, input.mapProjection, input.counterpartCountryId);
  return Object.freeze({
    availableCounterparts,
    counterpart,
    relationship: counterpart === null ? null : createRelationshipProjection({
      ...input,
      foreignCountryId: counterpart.countryId as ActiveCountryId,
    }),
    connectionState: "disconnected",
    connectionMessage: "외교 채널 API 연결 예정",
    transcript: Object.freeze([]),
    quickIntents: Object.freeze([
      Object.freeze({id: "proposal", label: "제안"}),
      Object.freeze({id: "warning", label: "경고"}),
      Object.freeze({id: "pressure", label: "압력"}),
    ]),
    canSend: false,
  });
}
