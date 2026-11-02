import type {CountryId} from "@/lib/world/country-id";
import type {TurnClientPhase} from "@/lib/simulation/client/turn-state-machine";
import type {SimulationEventV1} from "@/lib/simulation/simulation-event";

export type DataAvailability = Readonly<{
  dataAvailable: boolean;
  unavailableReason: string | null;
  loading?: boolean;
}>;

export type CountrySummaryViewModel = Readonly<{
  countryId: CountryId;
  nameKo: string;
  code: string;
  flagUrl: string | null;
  mapColor: string | null;
}>;

export type GameHudViewModel = DataAvailability & Readonly<{
  playerCountry: CountrySummaryViewModel;
  currentDate: string | null;
  turnNumber: number | null;
  phase: TurnClientPhase;
  population: number | null;
  unacknowledgedMajorEventCount: number | null;
  queuedActionCount: number | null;
  ongoingWarCount: number | null;
}>;

export type PoliticsViewModel = DataAvailability & Readonly<{
  country: CountrySummaryViewModel;
  regimeName: string | null;
  leaderName: string | null;
  domesticSituation: string | null;
  recentDomesticEvents: readonly NewsItemViewModel[];
}>;

export type EconomyMetricViewModel = Readonly<{
  key: string;
  label: string;
  value: number | null;
  unit: string | null;
  dataAvailable: boolean;
}>;

export type EconomyViewModel = DataAvailability & Readonly<{
  country: CountrySummaryViewModel;
  population: number | null;
  summary: string | null;
  metrics: readonly EconomyMetricViewModel[];
  recentEconomicEvents: readonly NewsItemViewModel[];
}>;

export type DirectionalRelationshipViewModel = Readonly<{
  fromCountry: CountrySummaryViewModel;
  toCountry: CountrySummaryViewModel;
  score: number | null;
  dataAvailable: boolean;
}>;

export type BilateralRelationshipViewModel = Readonly<{
  playerToForeign: DirectionalRelationshipViewModel;
  foreignToPlayer: DirectionalRelationshipViewModel;
}>;

export type CountryViewModel = Readonly<{
  country: CountrySummaryViewModel;
  officialNameKo: string;
  englishName: string;
  politicalStatus: string;
  capitalKo: string | null;
  capitalEn: string | null;
  region: string | null;
  isPlayerCountry: boolean;
  relationship: BilateralRelationshipViewModel | null;
  recentEvents: readonly NewsItemViewModel[];
  relatedWars: readonly WarViewModel[];
  warsDataAvailable: boolean;
}>;

export type WarStatus = "ongoing" | "ceasefire" | "ended" | "unknown";

export type WarViewModel = Readonly<{
  warId: string;
  name: string;
  belligerents: readonly CountrySummaryViewModel[];
  startDate: string | null;
  status: WarStatus;
  recentEvents: readonly NewsItemViewModel[];
  mapLayerAvailable: boolean;
  mapLayerVisible: boolean;
}>;

export type WarsViewModel = DataAvailability & Readonly<{
  wars: readonly WarViewModel[];
}>;

export type DiplomacyConnectionState = "disconnected" | "connecting" | "ready" | "sending" | "error";
export type DiplomacyMessageRole = "player" | "foreign" | "system";

export type DiplomacyMessageViewModel = Readonly<{
  messageId: string;
  role: DiplomacyMessageRole;
  text: string;
  createdAt: string;
}>;

export type DiplomacyChannelViewModel = Readonly<{
  availableCounterparts: readonly CountrySummaryViewModel[];
  counterpart: CountrySummaryViewModel | null;
  relationship: BilateralRelationshipViewModel | null;
  connectionState: DiplomacyConnectionState;
  connectionMessage: string;
  transcript: readonly DiplomacyMessageViewModel[];
  quickIntents: readonly Readonly<{id: string; label: string}>[];
  canSend: boolean;
}>;

export type DiplomacySendRequest = Readonly<{
  counterpartCountryId: CountryId<"active">;
  text: string;
  intentId: string | null;
}>;

export type DiplomacySendResponse = Readonly<{
  accepted: true;
  messages: readonly DiplomacyMessageViewModel[];
}>;

export interface DiplomacyChannelPort {
  send(request: DiplomacySendRequest, signal: AbortSignal): Promise<DiplomacySendResponse>;
}

export type GameSaveRequest = Readonly<{
  playerCountryId: CountryId<"active">;
  worldRevision: number;
  simulationRevision: number;
  currentDate: string;
  turnNumber: number;
}>;

export type GameSaveResult = Readonly<{
  saveId: string;
  savedAt: string;
}>;

export interface GameSavePort {
  save(request: GameSaveRequest, signal: AbortSignal): Promise<GameSaveResult>;
}

export type NewsItemViewModel = Readonly<{
  eventId: string;
  date: string;
  title: string;
  narrative: string;
  category: SimulationEventV1["outcomeCategory"];
  significance: SimulationEventV1["significance"];
  relatedCountryIds: readonly CountryId[];
  acknowledged: boolean;
}>;

export type NewsViewModel = DataAvailability & Readonly<{
  items: readonly NewsItemViewModel[];
  selectedEventId: string | null;
}>;

export interface HudViewPort { read(): GameHudViewModel; }
export interface PoliticsViewPort { read(countryId: CountryId<"active">): PoliticsViewModel; }
export interface EconomyViewPort { read(countryId: CountryId<"active">): EconomyViewModel; }
export interface RelationshipViewPort {
  read(playerCountryId: CountryId<"active">, foreignCountryId: CountryId<"active">): BilateralRelationshipViewModel;
}
export interface WarsViewPort { read(): WarsViewModel; }
export interface DiplomacyViewPort { read(counterpartCountryId: CountryId<"active"> | null): DiplomacyChannelViewModel; }
export interface NewsViewPort { read(selectedEventId: string | null): NewsViewModel; }

export type GameUiPorts = Readonly<{
  hud: HudViewPort;
  politics: PoliticsViewPort;
  economy: EconomyViewPort;
  relationships: RelationshipViewPort;
  wars: WarsViewPort;
  diplomacyView: DiplomacyViewPort;
  diplomacyChannel: DiplomacyChannelPort | null;
  save: GameSavePort | null;
  news: NewsViewPort;
}>;

export function assertRelationshipScore(score: number | null): number | null {
  if (score === null) return null;
  if (!Number.isInteger(score) || score < -100 || score > 100) {
    throw new RangeError("Relationship score must be an integer from -100 through 100");
  }
  return score;
}

export function isBlockingNewsItem(item: NewsItemViewModel): boolean {
  return !item.acknowledged
    && (item.significance === "major" || item.significance === "transformative");
}

