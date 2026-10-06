import {presentationMapColor} from './runtime-view';
import type {GameWorldView as WorldStateV2, SimulationPresentation as SimulationStateV1, MapPresentation as WorldMapRuntimeProjection} from './runtime-view';
import type {EconomyViewModel, GameHudViewModel} from "@/lib/game-ui/contracts";
import type {TurnClientPhase} from "@/lib/simulation/client/turn-state-machine";
import type {ActiveCountryId} from "@/lib/world/country-id";

const playerMapColor = (
  mapProjection: WorldMapRuntimeProjection,
  playerCountryId: ActiveCountryId,
) => presentationMapColor(mapProjection, playerCountryId);

export function createGameHudProjection(input: Readonly<{
  world: WorldStateV2;
  mapProjection: WorldMapRuntimeProjection;
  playerCountryId: ActiveCountryId;
  simulation: SimulationStateV1 | null;
  phase: TurnClientPhase;
  economy?: Pick<EconomyViewModel, "population"> | null;
  unacknowledgedMajorEventCount?: number;
}>): GameHudViewModel {
  const country = input.world.countriesById[input.playerCountryId];
  if (!country) throw new Error(`HUD player country is not active: ${input.playerCountryId}`);
  const simulation = input.simulation;
  return Object.freeze({
    dataAvailable: simulation !== null,
    unavailableReason: simulation === null ? "시뮬레이션 초기화 중" : null,
    playerCountry: Object.freeze({
      countryId: country.id,
      nameKo: country.names.shortKo,
      code: country.id,
      flagUrl: null,
      mapColor: playerMapColor(input.mapProjection, country.id),
    }),
    currentDate: simulation?.currentDate ?? null,
    turnNumber: simulation?.turnNumber ?? null,
    phase: input.phase,
    population: input.economy?.population ?? null,
    unacknowledgedMajorEventCount: simulation === null
      ? null
      : input.unacknowledgedMajorEventCount ?? simulation.eventLog.filter((event) =>
        event.significance === "major" || event.significance === "transformative").length,
    queuedActionCount: simulation === null
      ? null
      : simulation.queuedActions.filter((action) => action.status === "queued").length,
    ongoingWarCount: null,
  });
}

