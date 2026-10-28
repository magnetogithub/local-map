import {z} from 'zod';
import type {WorldStateV3} from '../world/world-state-v3';
import type {RetiredCountryId} from '../world/country-id';
import type {OperationalStateChange} from '../world/operational-catalog';
import type {SimulationStateV2} from './simulation-state-v2';
import type {TurnReport} from './client/turn-report';
import type {CatalogCountryMetadata} from '../map/catalog-consumer-contract';
import {MAX_PLAYER_ACTION_LENGTH, isoCalendarDateSchema} from './simulation-contract-primitives';

export const OPERATIONAL_GAME_HEADER = 'X-Pax-Game';
const revisions = z.strictObject({worldRevision: z.number().int().nonnegative(), simulationRevision: z.number().int().nonnegative()});
export const operationalGameCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({operation: z.literal('start')}),
  z.strictObject({operation: z.literal('read'), sessionId: z.string().uuid(), revisions}),
  z.strictObject({operation: z.literal('select-player'), sessionId: z.string().uuid(), revisions, countryId: z.string().regex(/^[A-Z]{3}$/)}),
  z.strictObject({operation: z.literal('queue'), sessionId: z.string().uuid(), revisions, text: z.string().trim().min(1).max(MAX_PLAYER_ACTION_LENGTH)}),
  z.strictObject({operation: z.literal('cancel-action'), sessionId: z.string().uuid(), revisions, actionId: z.string().min(1).max(160)}),
  ...(['undo', 'redo', 'restart'] as const).map(operation => z.strictObject({operation: z.literal(operation), sessionId: z.string().uuid(), revisions})),
  z.strictObject({operation: z.literal('prepare-turn'), sessionId: z.string().uuid(), revisions, targetDate: isoCalendarDateSchema}),
]);
export type OperationalGameCommand = z.infer<typeof operationalGameCommandSchema>;
type ClientCommand<T> = T extends {sessionId: string} ? Omit<T, 'sessionId' | 'revisions'> : never;
export type OperationalClientCommand = ClientCommand<OperationalGameCommand>;
export type OperationalControlCounts = Readonly<Record<string, Readonly<{owned: number; controlled: number; occupied: number}>>>;
export type OperationalCountryPresentation = CatalogCountryMetadata & Readonly<{focus: Readonly<{center: readonly [number, number]; zoom: number}>}>;
export type OperationalGameSnapshot = Readonly<{
  revisions: Readonly<{worldRevision: number; simulationRevision: number}>;
  world: Pick<WorldStateV3, 'catalogRef' | 'revision' | 'countriesById' | 'countryOrder'> & {retiredCountryIds: readonly RetiredCountryId[]};
  simulation: SimulationStateV2;
  stateChange: OperationalStateChange | null;
  counts: OperationalControlCounts;
  canUndo: boolean;
  canRedo: boolean;
  report: TurnReport | null;
}>;
export type OperationalGameStart = Readonly<{
  sessionId: string;
  snapshot: OperationalGameSnapshot;
  seedVersion: string;
  policyVersion: string;
  // Consecutive catalog ordinals with the same inherited state. No geometry.
  runs: readonly (readonly [number, string, string | null, string | null])[];
  presentation: readonly OperationalCountryPresentation[];
}>;
