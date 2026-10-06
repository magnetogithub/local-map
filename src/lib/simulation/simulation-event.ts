import {z} from "zod";

import {
  boundedNarrativeSchema,
  boundedSummarySchema,
  boundedTitleSchema,
  countryIdSchema,
  isoCalendarDateSchema,
  simulationIdSchema,
} from "./simulation-contract-primitives";

export const eventCauseReferenceSchema = z.strictObject({
  kind: z.enum([
    "authoritative-event",
    "resolution-event",
    "queued-action",
    "scheduled-consequence",
  ]),
  id: simulationIdSchema,
});

export const simulationEventSchema = z.strictObject({
  referenceLifecycle:z.strictObject({referenceId:simulationIdSchema,kind:z.enum(['queued-action','fact','situation','consequence']),operation:z.enum(['rewritten','ended','cancelled']),reason:z.enum(['country-successor','retired-actor','collapsed-relation'])}).optional(),
  authorityLifecycle:z.strictObject({authorityId:simulationIdSchema,operation:z.enum(['granted','expired','rewritten','invalidated']),reason:z.enum(['validated-turn-grant','date-expired','country-successor','self-reference','no-successor','operation-scope-invalid']),previousActorCountryId:z.union([countryIdSchema,z.null()]),previousTargetCountryId:z.union([countryIdSchema,z.null()])}).optional(),
  eventId: simulationIdSchema,
  date: isoCalendarDateSchema,
  title: boundedTitleSchema,
  publicNarrative: boundedNarrativeSchema,
  actorCountryIds: z.array(countryIdSchema).min(1).max(16),
  relatedFactIds: z.array(simulationIdSchema).max(32),
  relatedSituationIds: z.array(simulationIdSchema).max(32),
  causes: z.array(eventCauseReferenceSchema).max(16),
  outcomeCategory: z.enum([
    "diplomatic",
    "treaty",
    "domestic",
    "economic",
    "military",
    "territorial",
    "humanitarian",
    "other",
  ]),
  significance: z.enum(["minor", "notable", "major", "transformative"]),
});

export const playerActionOutcomeSchema = z.strictObject({
  outcomeId: simulationIdSchema,
  actionId: simulationIdSchema,
  status: z.enum([
    "succeeded",
    "partially_succeeded",
    "failed",
    "delayed",
    "superseded",
  ]),
  evidenceEventId: simulationIdSchema,
  summary: boundedSummarySchema,
  remainingConditions: z.array(boundedSummarySchema).max(16),
});

export type EventCauseReferenceV1 = z.infer<typeof eventCauseReferenceSchema>;
export type SimulationEventV1 = z.infer<typeof simulationEventSchema>;
export type PlayerActionOutcomeV1 = z.infer<typeof playerActionOutcomeSchema>;

