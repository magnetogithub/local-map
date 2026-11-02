import {z} from "zod";

import {canonicalStringify} from "../world/canonical-serializer";
import {
  boundedSummarySchema,
  assertSafeSimulationData,
  compareCanonicalText,
  countryIdSchema,
  isoCalendarDateSchema,
  nullableSimulationIdSchema,
  simulationIdSchema,
} from "./simulation-contract-primitives";

const actorIdsSchema = z.array(countryIdSchema).min(1).max(16);

export const simulationFactSchema = z.strictObject({
  factId: simulationIdSchema,
  kind: z.enum([
    "diplomatic-relation",
    "treaty-or-negotiation",
    "conflict-or-war",
    "domestic-politics",
    "economy",
    "military-or-occupation",
    "territorial-claim",
    "scenario",
  ]),
  actorCountryIds: actorIdsSchema,
  publicSummary: boundedSummarySchema,
  startDate: isoCalendarDateSchema,
  status: z.enum(["active", "superseded", "ended"]),
  sourceEventId: simulationIdSchema,
});

export const activeSituationSchema = z.strictObject({
  situationId: simulationIdSchema,
  type: z.enum([
    "unification-negotiation",
    "independence-movement",
    "war",
    "sanctions",
    "coup-crisis",
    "diplomatic-process",
    "domestic-crisis",
    "other",
  ]),
  participantCountryIds: actorIdsSchema,
  stage: boundedSummarySchema,
  stakes: boundedSummarySchema,
  startedByEventId: simulationIdSchema,
  lastUpdatedByEventId: simulationIdSchema,
  unresolvedQuestion: boundedSummarySchema,
  status: z.enum(["active", "resolved"]),
});

export const scheduledConsequenceSchema = z.strictObject({
  consequenceId: simulationIdSchema,
  earliestDate: isoCalendarDateSchema,
  deadlineDate: z.union([isoCalendarDateSchema, z.null()]),
  actorCountryIds: z.array(countryIdSchema).max(16),
  situationId: nullableSimulationIdSchema,
  triggerSummary: boundedSummarySchema,
  sourceEventId: simulationIdSchema,
  status: z.enum(["scheduled", "due", "resolved", "cancelled"]),
}).superRefine((value, context) => {
  if (value.deadlineDate !== null && value.deadlineDate < value.earliestDate) {
    context.addIssue({
      code: "custom",
      path: ["deadlineDate"],
      message: "deadlineDate must be on or after earliestDate",
    });
  }
});

export type SimulationFactV1 = z.infer<typeof simulationFactSchema>;
export type ActiveSituationV1 = z.infer<typeof activeSituationSchema>;
export type ScheduledConsequenceV1 = z.infer<typeof scheduledConsequenceSchema>;

export const factMutationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    mutationId: simulationIdSchema,
    operation: z.literal("upsert"),
    causedByEventId: simulationIdSchema,
    factId: z.null(),
    fact: simulationFactSchema,
  }),
  z.strictObject({
    mutationId: simulationIdSchema,
    operation: z.literal("end"),
    causedByEventId: simulationIdSchema,
    factId: simulationIdSchema,
    fact: z.null(),
  }),
]);

export const situationMutationSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    mutationId: simulationIdSchema,
    operation: z.literal("upsert"),
    causedByEventId: simulationIdSchema,
    situationId: z.null(),
    situation: activeSituationSchema,
  }),
  z.strictObject({
    mutationId: simulationIdSchema,
    operation: z.literal("resolve"),
    causedByEventId: simulationIdSchema,
    situationId: simulationIdSchema,
    situation: z.null(),
  }),
]);

export type FactMutationV1 = z.infer<typeof factMutationSchema>;
export type SituationMutationV1 = z.infer<typeof situationMutationSchema>;

export type NarrativeStateCollectionsV1 = Readonly<{
  factsById: Readonly<Record<string, SimulationFactV1>>;
  factOrder: readonly string[];
  situationsById: Readonly<Record<string, ActiveSituationV1>>;
  situationOrder: readonly string[];
  scheduledConsequences: readonly ScheduledConsequenceV1[];
}>;

const uniqueById = <Value>(
  values: readonly Value[],
  idOf: (value: Value) => string,
  context: string,
) => {
  const record: Record<string, Value> = Object.create(null) as Record<string, Value>;
  for (const value of values) {
    const id = idOf(value);
    if (Object.hasOwn(record, id)) throw new Error(`Duplicate ${context} id: ${id}`);
    Object.defineProperty(record, id, {enumerable: true, value, writable: false});
  }
  return Object.freeze(record);
};

export function createNarrativeStateCollections(input: Readonly<{
  facts: readonly unknown[];
  situations: readonly unknown[];
  scheduledConsequences: readonly unknown[];
}>): NarrativeStateCollectionsV1 {
  assertSafeSimulationData(input);
  const facts = input.facts.map((value) => simulationFactSchema.parse(value));
  const situations = input.situations.map((value) => activeSituationSchema.parse(value));
  const consequences = input.scheduledConsequences
    .map((value) => scheduledConsequenceSchema.parse(value))
    .sort((left, right) =>
      compareCanonicalText(left.earliestDate, right.earliestDate)
      || compareCanonicalText(left.consequenceId, right.consequenceId));
  const factsById = uniqueById(facts, (fact) => fact.factId, "fact");
  const situationsById = uniqueById(situations, (situation) => situation.situationId, "situation");
  return Object.freeze({
    factsById,
    factOrder: Object.freeze(Object.keys(factsById).sort(compareCanonicalText)),
    situationsById,
    situationOrder: Object.freeze(Object.keys(situationsById).sort(compareCanonicalText)),
    scheduledConsequences: Object.freeze(consequences),
  });
}

export const serializeNarrativeStateCanonical = (state: NarrativeStateCollectionsV1) =>
  canonicalStringify(state);

export function validateNarrativeStateReferences(
  state: NarrativeStateCollectionsV1,
  references: Readonly<{
    countryIds: ReadonlySet<string>;
    eventIds: ReadonlySet<string>;
  }>,
): void {
  const requireCountries = (ids: readonly string[], context: string) => {
    for (const id of ids) {
      if (!references.countryIds.has(id)) throw new Error(`${context} references unknown country ${id}`);
    }
  };
  for (const fact of Object.values(state.factsById)) {
    requireCountries(fact.actorCountryIds, `Fact ${fact.factId}`);
    if (!references.eventIds.has(fact.sourceEventId)) {
      throw new Error(`Fact ${fact.factId} references unknown event ${fact.sourceEventId}`);
    }
  }
  for (const situation of Object.values(state.situationsById)) {
    requireCountries(situation.participantCountryIds, `Situation ${situation.situationId}`);
    for (const eventId of [situation.startedByEventId, situation.lastUpdatedByEventId]) {
      if (!references.eventIds.has(eventId)) {
        throw new Error(`Situation ${situation.situationId} references unknown event ${eventId}`);
      }
    }
  }
  for (const consequence of state.scheduledConsequences) {
    requireCountries(consequence.actorCountryIds, `Consequence ${consequence.consequenceId}`);
    if (!references.eventIds.has(consequence.sourceEventId)) {
      throw new Error(
        `Consequence ${consequence.consequenceId} references unknown event ${consequence.sourceEventId}`,
      );
    }
    if (consequence.situationId !== null && !state.situationsById[consequence.situationId]) {
      throw new Error(
        `Consequence ${consequence.consequenceId} references unknown situation ${consequence.situationId}`,
      );
    }
  }
}

