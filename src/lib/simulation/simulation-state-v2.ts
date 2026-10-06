import {z} from "zod";

import {canonicalStringify} from "../world/canonical-serializer";
import {sha256Hex} from "../world/sha256";
import type {TerritoryId} from "../world/territory-id";
import {
  assertExactSimulationOrder,
  assertSimulationStateInvariants,
  freezeSimulationValue,
  parseSimulationStateV1,
  simulationStateSchema,
  type SimulationStateV1,
  type SimulationWorldReferences,
} from "./simulation-state";
import {
  assertSafeSimulationData,
  compareCanonicalText,
  countryIdSchema,
  isoCalendarDateSchema,
  MAX_ID_LENGTH,
  simulationIdSchema,
} from "./simulation-contract-primitives";

export const SIMULATION_STATE_V2_SCHEMA_VERSION = 2 as const;
export const MAX_TERRITORIAL_CONTROL_AUTHORITIES = 256;
export const MAX_AUTHORITY_TERRITORIES = 512;
export const MAX_COUNTRY_PRESENTATION_AUTHORITIES = 128;
export const MAX_AUTHORITY_MAP_COLORS = 16;

// The prefixed pattern already enforces canonical simulation-id characters.
// Chaining two regex checks emits allOf, which OpenAI strict tools reject.
const authorityIdSchema = (prefix: "tca" | "cpa") => z.string().min(1).max(MAX_ID_LENGTH)
  .regex(new RegExp(`^${prefix}:[A-Za-z0-9][A-Za-z0-9._:-]*$`));

export const territorialControlAuthorityIdSchema = authorityIdSchema("tca");
export const countryPresentationAuthorityIdSchema = authorityIdSchema("cpa");
// Territory IDs have their own bounded namespace (catalog IDs include a full SHA-256).
// Membership is checked against the supplied world's validated territory registry.
export const authorityTerritoryIdSchema = z.string().min(1).max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Expected a bounded ASCII TerritoryId")
  .transform((value) => value as TerritoryId);
export const authorityMapColorSchema = z.string().regex(/^#[0-9A-F]{6}$/);

const canonicalArray = <Schema extends z.ZodType>(schema: Schema, cap: number) =>
  z.array(schema).min(1).max(cap).refine(
    (items) => items.every((item, index) => index === 0
      || compareCanonicalText(String(items[index - 1]), String(item)) < 0),
    {message: "Expected unique values in bytewise canonical order"},
  );

const authorityDates = {
  validFrom: isoCalendarDateSchema,
  validTo: z.union([isoCalendarDateSchema, z.null()]),
  sourceEventId: simulationIdSchema,
};
const validDateRange = (value: {validFrom: string; validTo: string | null}) =>
  value.validTo === null || value.validFrom <= value.validTo;

export const territorialControlAuthoritySchema = z.strictObject({
  id: territorialControlAuthorityIdSchema,
  actorCountryId: countryIdSchema,
  targetCountryId: z.union([countryIdSchema, z.null()]),
  allowedTerritoryIds: canonicalArray(authorityTerritoryIdSchema, MAX_AUTHORITY_TERRITORIES),
  allowedOperations: canonicalArray(z.enum(["occupy", "liberate", "transfer"]), 3),
  ...authorityDates,
}).refine(validDateRange, {message: "Authority validFrom must not exceed validTo"});

export const countryPresentationAuthoritySchema = z.strictObject({
  id: countryPresentationAuthorityIdSchema,
  actorCountryId: countryIdSchema,
  targetCountryId: countryIdSchema,
  allowedMapColors: canonicalArray(authorityMapColorSchema, MAX_AUTHORITY_MAP_COLORS),
  ...authorityDates,
}).refine(validDateRange, {message: "Authority validFrom must not exceed validTo"});

const boundedRecord = <Schema extends z.ZodType>(
  idSchema: z.ZodString,
  valueSchema: Schema,
  cap: number,
) => z.record(idSchema, valueSchema).refine((record) => Object.keys(record).length <= cap, {
  message: `Authority collection exceeds cap ${cap}`,
});

export const simulationStateV2Schema = simulationStateSchema.extend({
  schemaVersion: z.literal(SIMULATION_STATE_V2_SCHEMA_VERSION),
  territorialControlAuthoritiesById: boundedRecord(
    territorialControlAuthorityIdSchema, territorialControlAuthoritySchema,
    MAX_TERRITORIAL_CONTROL_AUTHORITIES,
  ),
  territorialControlAuthorityOrder: z.array(territorialControlAuthorityIdSchema)
    .max(MAX_TERRITORIAL_CONTROL_AUTHORITIES),
  countryPresentationAuthoritiesById: boundedRecord(
    countryPresentationAuthorityIdSchema, countryPresentationAuthoritySchema,
    MAX_COUNTRY_PRESENTATION_AUTHORITIES,
  ),
  countryPresentationAuthorityOrder: z.array(countryPresentationAuthorityIdSchema)
    .max(MAX_COUNTRY_PRESENTATION_AUTHORITIES),
}).superRefine((state, context) => {
  try {
    assertExactSimulationOrder(state.factsById, state.factOrder, "Simulation fact");
    assertExactSimulationOrder(state.situationsById, state.situationOrder, "Simulation situation");
    for (const [id, fact] of Object.entries(state.factsById)) {
      if (id !== fact.factId) throw new Error("Simulation fact key must match factId");
    }
    for (const [id, situation] of Object.entries(state.situationsById)) {
      if (id !== situation.situationId) throw new Error("Simulation situation key must match situationId");
    }
    for (const [record, order] of [
      [state.territorialControlAuthoritiesById, state.territorialControlAuthorityOrder],
      [state.countryPresentationAuthoritiesById, state.countryPresentationAuthorityOrder],
    ] as const) {
      assertExactSimulationOrder(record, order, "Simulation authority");
      for (const [id, authority] of Object.entries(record)) {
        if (authority.id !== id) throw new Error("Authority record key must match id");
        if (authority.validTo !== null && authority.validTo < state.currentDate) {
          throw new Error("Expired authority must be removed from active collections");
        }
      }
    }
  } catch (error) {
    context.addIssue({code: "custom", message: (error as Error).message});
  }
});

type DeepReadonly<Value> = Value extends string | number | boolean | null | undefined ? Value : Value extends object
  ? {readonly [Key in keyof Value]: DeepReadonly<Value[Key]>} : Value;

export type TerritorialControlAuthority = DeepReadonly<z.infer<typeof territorialControlAuthoritySchema>>;
export type CountryPresentationAuthority = DeepReadonly<z.infer<typeof countryPresentationAuthoritySchema>>;
export type SimulationStateV2 = Omit<SimulationStateV1, "schemaVersion"> & Readonly<{
  schemaVersion: typeof SIMULATION_STATE_V2_SCHEMA_VERSION;
  territorialControlAuthoritiesById: Readonly<Record<string, TerritorialControlAuthority>>;
  territorialControlAuthorityOrder: readonly string[];
  countryPresentationAuthoritiesById: Readonly<Record<string, CountryPresentationAuthority>>;
  countryPresentationAuthorityOrder: readonly string[];
}>;

export type SimulationAuthorityWorldReferences = SimulationWorldReferences & Readonly<{
  territoriesById: Readonly<Record<string, unknown>>;
}>;

export function parseSimulationStateV2(input: unknown): SimulationStateV2 {
  assertSafeSimulationData(input);
  return freezeSimulationValue(simulationStateV2Schema.parse(input)) as unknown as SimulationStateV2;
}

export function isAuthorityActiveAt(
  authority: Readonly<{validFrom: string; validTo: string | null}>,
  currentDate: string,
): boolean {
  isoCalendarDateSchema.parse(currentDate);
  isoCalendarDateSchema.parse(authority.validFrom);
  if (authority.validTo !== null) isoCalendarDateSchema.parse(authority.validTo);
  if (!validDateRange(authority)) throw new Error("Invalid authority date range");
  return authority.validFrom <= currentDate
    && (authority.validTo === null || currentDate <= authority.validTo);
}

export function assertSimulationStateV2Invariants(
  state: SimulationStateV2,
  world: SimulationAuthorityWorldReferences,
): void {
  // Structural validation also applies to caller-constructed typed values.
  parseSimulationStateV2(state);
  assertSimulationStateInvariants(state, world);
  const sourceEvents = new Map(state.eventLog.map((event) => [event.eventId, event]));
  for (const authority of [
    ...Object.values(state.territorialControlAuthoritiesById),
    ...Object.values(state.countryPresentationAuthoritiesById),
  ]) {
    for (const countryId of [authority.actorCountryId, authority.targetCountryId]) {
      if (countryId !== null && !Object.hasOwn(world.countriesById, countryId)) {
        throw new Error(`Authority ${authority.id} references inactive country ${countryId}`);
      }
    }
    const sourceEvent = sourceEvents.get(authority.sourceEventId);
    if (!sourceEvent) throw new Error(`Authority ${authority.id} references unknown source event`);
    if (sourceEvent.date > authority.validFrom) {
      throw new Error(`Authority ${authority.id} predates its source event`);
    }
    if ("allowedTerritoryIds" in authority) {
      for (const territoryId of authority.allowedTerritoryIds) {
        if (!Object.hasOwn(world.territoriesById, territoryId)) {
          throw new Error(`Authority ${authority.id} references unknown territory ${territoryId}`);
        }
      }
    }
  }
}

export function createSimulationStateV2(
  input: unknown,
  world: SimulationAuthorityWorldReferences,
): SimulationStateV2 {
  const state = parseSimulationStateV2(input);
  assertSimulationStateV2Invariants(state, world);
  return state;
}

/** Pure preparation step; callers atomically migrate the pair at the later cutover. */
export function migrateSimulationStateV1ToV2(
  input: unknown,
  world: SimulationAuthorityWorldReferences,
): SimulationStateV2 {
  const legacy = parseSimulationStateV1(input);
  assertSimulationStateInvariants(legacy, world);
  return createSimulationStateV2({
    ...legacy,
    schemaVersion: SIMULATION_STATE_V2_SCHEMA_VERSION,
    territorialControlAuthoritiesById: {},
    territorialControlAuthorityOrder: [],
    countryPresentationAuthoritiesById: {},
    countryPresentationAuthorityOrder: [],
  }, world);
}

const orderedRecord = <Value>(record: Readonly<Record<string, Value>>, order: readonly string[]) =>
  Object.fromEntries(order.map((id) => [id, record[id]]));

const canonicalState = (state: SimulationStateV2) => ({
  ...state,
  factsById: orderedRecord(state.factsById, state.factOrder),
  situationsById: orderedRecord(state.situationsById, state.situationOrder),
  territorialControlAuthoritiesById: orderedRecord(
    state.territorialControlAuthoritiesById, state.territorialControlAuthorityOrder,
  ),
  countryPresentationAuthoritiesById: orderedRecord(
    state.countryPresentationAuthoritiesById, state.countryPresentationAuthorityOrder,
  ),
});

export function simulationStateV2ContentHash(state: SimulationStateV2): string {
  const canonical = canonicalState(parseSimulationStateV2(state));
  return sha256Hex(new TextEncoder().encode(`simulation-state.v2\0${canonicalStringify(canonical)}`));
}

const serializedSimulationStateV2Schema = z.strictObject({
  format: z.literal("simulation-state.v2"),
  simulation: simulationStateV2Schema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});

/** In-memory/file serialization; does not introduce browser persistence. */
export function serializeSimulationStateV2(
  state: SimulationStateV2,
  world: SimulationAuthorityWorldReferences,
): string {
  assertSimulationStateV2Invariants(state, world);
  return canonicalStringify({
    format: "simulation-state.v2",
    simulation: canonicalState(state),
    contentHash: simulationStateV2ContentHash(state),
  });
}

export function deserializeSimulationStateV2(
  raw: string,
  world: SimulationAuthorityWorldReferences,
): SimulationStateV2 {
  const input: unknown = JSON.parse(raw);
  assertSafeSimulationData(input);
  const saved = serializedSimulationStateV2Schema.parse(input);
  const state = createSimulationStateV2(saved.simulation, world);
  if (simulationStateV2ContentHash(state) !== saved.contentHash) {
    throw new Error("Simulation V2 content hash mismatch");
  }
  return state;
}
