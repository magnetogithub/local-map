import {z} from "zod";

import type {CountrySearchProjection} from "../projection/country-search-index-patch";
import {canonicalStringify} from "../world/canonical-serializer";
import type {WorldStateV2} from "../world/world-state-v2";
import type {WorldStateV3} from '../world/world-state-v3';
import {countryPresentationAuthoritySchema,territorialControlAuthoritySchema, MAX_COUNTRY_PRESENTATION_AUTHORITIES, type CountryPresentationAuthority,type TerritorialControlAuthority, type SimulationStateV2} from './simulation-state-v2';
import type {SimulationStateV1} from "./simulation-state";
import type {SubdivisionCatalog} from "./subdivision-catalog";
import {
  assertSafeSimulationData,
  boundedSummarySchema,
  boundedTitleSchema,
  compareCanonicalText,
  countryIdSchema,
  isoCalendarDateSchema,
  MAX_PLAYER_ACTION_LENGTH,
  simulationIdSchema,
} from "./simulation-contract-primitives";
import {activeSituationSchema, scheduledConsequenceSchema, simulationFactSchema} from "./narrative-state";
import {simulationEventSchema} from "./simulation-event";
import {presentationHistory, presentationHistorySchema, type PresentationHistory} from './presentation-grant-validation';
import {authorityMapColorSchema} from './simulation-state-v2';

export const SIMULATION_CONTEXT_LIMITS = Object.freeze({
  countries: 64,
  territoryIdsPerCountry: 16,
  catalogDirectoryIdsPerCountry: 4,
  countryDirectory: 512,
  aliasesPerCountry: 12,
  territoryDirectory: 4_096,
  requestBytes: 240 * 1024,
  facts: 64,
  situations: 32,
  dueConsequences: 32,
  recentEvents: 20,
  subdivisions: 128,
});

export class SimulationContextError extends Error {
  constructor(
    readonly code: "SIMULATION_CONTEXT_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "SimulationContextError";
  }
}

type ClipRecord = Readonly<{
  section: string;
  omittedCount: number;
  reason: string;
}>;

export type SimulationContextV1 = Readonly<{
  contextVersion: "simulation-context.v1";
  scenario: Readonly<{id: string; startDate: string}>;
  revisions: Readonly<{simulation: number; world: number}>;
  period: Readonly<{startDate: string; endDate: string}>;
  playerCountry: Readonly<{countryId: string; name: string}>;
  queuedActions: readonly Readonly<{
    actionId: string;
    actorCountryId: string;
    submittedAtDate: string;
    text: string;
    visibility: "public" | "private";
  }>[];
  countries: readonly Readonly<{
    countryId: string;
    shortKo: string;
    english: string;
    politicalStatus: string;
    territoryCount: number;
    territoryIds: readonly string[];
  }>[];
  countryDirectory: readonly Readonly<{
    countryId: string;
    shortKo: string;
    english: string;
    searchAliases: readonly string[];
    politicalStatus: string;
  }>[];
  territoryDirectory: readonly Readonly<{
    countryId: string;
    territoryIds: readonly string[];
  }>[];
  facts: readonly unknown[];
  situations: readonly unknown[];
  dueConsequences: readonly unknown[];
  recentEvents: readonly unknown[];
  countryPresentationAuthorities?: readonly CountryPresentationAuthority[];
  presentationAuthorityHistory?: PresentationHistory;
  countryMapColors?: readonly Readonly<{countryId: string; mapColor: string}>[];
  territorialControlAuthorities?: readonly TerritorialControlAuthority[];
  regionCatalog?: import("../world/world-geometry-catalog-ref").WorldGeometryCatalogRef;
  subdivisions: readonly Readonly<{
    catalogId: string;
    sourceVersion: string;
    subdivisionId: string;
    parentCountryId: string;
    nameKo: string;
    nameEn: string;
    materializable: boolean;
  }>[];
  rules: Readonly<{
    locale: string;
    capabilities: readonly string[];
  }>;
  metadata: Readonly<{clipped: readonly ClipRecord[]}>;
}>;

const directoryCountrySchema = z.strictObject({
  countryId: countryIdSchema,
  shortKo: boundedTitleSchema,
  english: boundedTitleSchema,
  searchAliases: z.array(boundedTitleSchema).max(SIMULATION_CONTEXT_LIMITS.aliasesPerCountry),
  politicalStatus: z.string().trim().min(1).max(64),
});
const territoryDirectoryEntrySchema = z.strictObject({
  countryId: countryIdSchema,
  territoryIds: z.array(z.string().min(1).max(160)).max(SIMULATION_CONTEXT_LIMITS.territoryDirectory),
});

export const simulationContextSchema = z.strictObject({
  contextVersion: z.literal("simulation-context.v1"),
  scenario: z.strictObject({id: simulationIdSchema, startDate: isoCalendarDateSchema}),
  revisions: z.strictObject({simulation: z.number().int().nonnegative(), world: z.number().int().nonnegative()}),
  period: z.strictObject({startDate: isoCalendarDateSchema, endDate: isoCalendarDateSchema}),
  playerCountry: z.strictObject({countryId: countryIdSchema, name: boundedTitleSchema}),
  queuedActions: z.array(z.strictObject({
    actionId: simulationIdSchema,
    actorCountryId: countryIdSchema,
    submittedAtDate: isoCalendarDateSchema,
    text: z.string().trim().min(1).max(MAX_PLAYER_ACTION_LENGTH),
    visibility: z.enum(["public", "private"]),
  })).max(128),
  countries: z.array(z.strictObject({
    countryId: countryIdSchema,
    shortKo: boundedTitleSchema,
    english: boundedTitleSchema,
    politicalStatus: z.string().trim().min(1).max(64),
    territoryCount: z.number().int().nonnegative(),
    territoryIds: z.array(z.string().min(1).max(160)).max(SIMULATION_CONTEXT_LIMITS.territoryIdsPerCountry),
  })).max(SIMULATION_CONTEXT_LIMITS.countries),
  countryDirectory: z.array(directoryCountrySchema).max(SIMULATION_CONTEXT_LIMITS.countryDirectory),
  territoryDirectory: z.array(territoryDirectoryEntrySchema).max(SIMULATION_CONTEXT_LIMITS.countryDirectory),
  facts: z.array(simulationFactSchema).max(SIMULATION_CONTEXT_LIMITS.facts),
  situations: z.array(activeSituationSchema).max(SIMULATION_CONTEXT_LIMITS.situations),
  dueConsequences: z.array(scheduledConsequenceSchema).max(SIMULATION_CONTEXT_LIMITS.dueConsequences),
  recentEvents: z.array(simulationEventSchema).max(SIMULATION_CONTEXT_LIMITS.recentEvents),
  countryPresentationAuthorities: z.array(countryPresentationAuthoritySchema).max(MAX_COUNTRY_PRESENTATION_AUTHORITIES).optional(),
  presentationAuthorityHistory: presentationHistorySchema.optional(),
  countryMapColors: z.array(z.strictObject({countryId: countryIdSchema, mapColor: authorityMapColorSchema})).max(SIMULATION_CONTEXT_LIMITS.countryDirectory).optional(),
  territorialControlAuthorities: z.array(territorialControlAuthoritySchema).max(8).optional(),
  regionCatalog: z.strictObject({catalogVersion:z.string().max(160),geometryRoot:z.string().regex(/^[a-f0-9]{64}$/),topologyRoot:z.string().regex(/^[a-f0-9]{64}$/),renderArtifactRoot:z.string().regex(/^[a-f0-9]{64}$/),manifestPath:z.string().max(256)}).optional(),
  subdivisions: z.array(z.strictObject({
    catalogId: simulationIdSchema,
    sourceVersion: simulationIdSchema,
    subdivisionId: simulationIdSchema,
    parentCountryId: countryIdSchema,
    nameKo: boundedTitleSchema,
    nameEn: boundedTitleSchema,
    materializable: z.boolean(),
  })).max(SIMULATION_CONTEXT_LIMITS.subdivisions),
  rules: z.strictObject({
    locale: z.string().trim().min(2).max(32),
    capabilities: z.array(boundedSummarySchema).max(32),
  }),
  metadata: z.strictObject({
    clipped: z.array(z.strictObject({
      section: z.string().trim().min(1).max(160),
      omittedCount: z.number().int().positive(),
      reason: boundedSummarySchema,
    })).max(256),
  }),
}).superRefine((context, refinement) => {
  const territoryCount = context.territoryDirectory.reduce((total, entry) => total + entry.territoryIds.length, 0);
  if (territoryCount > SIMULATION_CONTEXT_LIMITS.territoryDirectory) {
    refinement.addIssue({code: "custom", path: ["territoryDirectory"], message: "Territory directory exceeds its total bound"});
  }
  if (context.period.endDate <= context.period.startDate) {
    refinement.addIssue({code: "custom", path: ["period"], message: "Context period must advance"});
  }
});

export function parseSimulationContextV1(input: unknown): SimulationContextV1 {
  assertSafeSimulationData(input);
  return simulationContextSchema.parse(input) as SimulationContextV1;
}

const clip = <Value>(
  values: readonly Value[],
  limit: number,
  section: string,
  clipped: ClipRecord[],
) => {
  if (values.length > limit) {
    clipped.push(Object.freeze({
      section,
      omittedCount: values.length - limit,
      reason: `bounded to ${limit} canonical items`,
    }));
  }
  return values.slice(0, limit);
};

export function buildSimulationContext(input: Readonly<{
  simulation: SimulationStateV1|SimulationStateV2;
  world: WorldStateV2|WorldStateV3;
  countrySearchProjection: CountrySearchProjection;
  subdivisionCatalog: SubdivisionCatalog;
  scenarioId: string;
  scenarioStartDate: string;
  targetDate: string;
  locale?: string;
}>): SimulationContextV1 {
  const {simulation, world, countrySearchProjection, subdivisionCatalog} = input;
  if (countrySearchProjection.revision !== world.revision) {
    throw new Error("Country search projection is stale for SimulationContextV1");
  }
  const clipped: ClipRecord[] = [];
  if (world.countryOrder.length > SIMULATION_CONTEXT_LIMITS.countryDirectory) {
    throw new SimulationContextError(
      "SIMULATION_CONTEXT_TOO_LARGE",
      `Active country directory exceeds ${SIMULATION_CONTEXT_LIMITS.countryDirectory} entries`,
    );
  }
  const countryDirectory = world.countryOrder
    .map((countryId) => {
      const country = world.countriesById[countryId];
      const search = countrySearchProjection.entriesById.get(country.id);
      return Object.freeze({
        countryId,
        shortKo: search?.shortKo ?? country.names.shortKo,
        english: search?.english ?? country.names.english,
        searchAliases: Object.freeze((search?.searchAliases ?? country.names.searchAliases)
          .slice(0, SIMULATION_CONTEXT_LIMITS.aliasesPerCountry)),
        politicalStatus: country.politicalStatus,
      });
    })
    .sort((left, right) => compareCanonicalText(left.countryId, right.countryId));
  const territoryIdsByCountry = new Map<string, string[]>();
  for (const territoryId of world.territoryOrder) {
    const ownerCountryId = world.territoriesById[territoryId].ownerCountryId;
    if (ownerCountryId === null) continue;
    const ids = territoryIdsByCountry.get(ownerCountryId) ?? [];
    ids.push(territoryId);
    territoryIdsByCountry.set(ownerCountryId, ids);
  }
  const ownedTerritoryCount = [...territoryIdsByCountry.values()]
    .reduce((total, ids) => total + ids.length, 0);
  if (world.schemaVersion===2 && ownedTerritoryCount > SIMULATION_CONTEXT_LIMITS.territoryDirectory) {
    throw new SimulationContextError(
      "SIMULATION_CONTEXT_TOO_LARGE",
      `Territory directory exceeds ${SIMULATION_CONTEXT_LIMITS.territoryDirectory} entries`,
    );
  }
  const territoryDirectory = countryDirectory.map(({countryId}) => Object.freeze({
    countryId,
    territoryIds: Object.freeze(world.schemaVersion===3?clip((territoryIdsByCountry.get(countryId)??[]).sort(compareCanonicalText),SIMULATION_CONTEXT_LIMITS.catalogDirectoryIdsPerCountry,`directory:${countryId}`,clipped):(territoryIdsByCountry.get(countryId) ?? []).sort(compareCanonicalText)),
  }));
  const relevantCountryIds = new Set<string>([simulation.playerCountryId]);
  simulation.queuedActions.forEach((action) => relevantCountryIds.add(action.actorCountryId));
  Object.values(simulation.factsById).forEach((fact) =>
    fact.actorCountryIds.forEach((id) => relevantCountryIds.add(id)));
  Object.values(simulation.situationsById).forEach((situation) =>
    situation.participantCountryIds.forEach((id) => relevantCountryIds.add(id)));
  const sortedCountryIds = [...relevantCountryIds]
    .filter((id) => Boolean(world.countriesById[id]))
    .sort(compareCanonicalText);
  const countryIds = clip(
    sortedCountryIds,
    SIMULATION_CONTEXT_LIMITS.countries,
    "countries",
    clipped,
  );
  const countries = countryIds.map((countryId) => {
    const country = world.countriesById[countryId];
    const search = countrySearchProjection.entriesById.get(country.id);
    const territoryIds = world.territoryOrder
      .filter((territoryId) => world.territoriesById[territoryId].ownerCountryId === countryId)
      .sort(compareCanonicalText);
    return Object.freeze({
      countryId,
      shortKo: search?.shortKo ?? country.names.shortKo,
      english: search?.english ?? country.names.english,
      politicalStatus: country.politicalStatus,
      territoryCount: territoryIds.length,
      territoryIds: Object.freeze(clip(
        territoryIds,
        SIMULATION_CONTEXT_LIMITS.territoryIdsPerCountry,
        `territories:${countryId}`,
        clipped,
      )),
    });
  });
  const facts = Object.values(simulation.factsById)
    .filter((fact) => fact.status === "active")
    .sort((left, right) => compareCanonicalText(left.factId, right.factId));
  const situations = Object.values(simulation.situationsById)
    .filter((situation) => situation.status === "active")
    .sort((left, right) => compareCanonicalText(left.situationId, right.situationId));
  const dueConsequences = simulation.scheduledConsequences
    .filter((entry) => entry.status !== "cancelled" && entry.earliestDate <= input.targetDate)
    .sort((left, right) =>
      compareCanonicalText(left.earliestDate, right.earliestDate)
      || compareCanonicalText(left.consequenceId, right.consequenceId));
  const recentEvents = [...simulation.eventLog]
    .sort((left, right) =>
      compareCanonicalText(left.date, right.date)
      || compareCanonicalText(left.eventId, right.eventId))
    .slice(-SIMULATION_CONTEXT_LIMITS.recentEvents);
  if (simulation.eventLog.length > recentEvents.length) {
    clipped.push(Object.freeze({
      section: "recentEvents",
      omittedCount: simulation.eventLog.length - recentEvents.length,
      reason: "only the most recent authoritative events are included",
    }));
  }
  const subdivisions = clip(
    countryDirectory.flatMap(({countryId}) => subdivisionCatalog.listCountry(countryId))
      .sort((left, right) =>
        compareCanonicalText(left.parentCountryId, right.parentCountryId)
        || compareCanonicalText(left.ref.subdivisionId, right.ref.subdivisionId)),
    SIMULATION_CONTEXT_LIMITS.subdivisions,
    "subdivisions",
    clipped,
  ).map((entry) => Object.freeze({
    ...entry.ref,
    parentCountryId: entry.parentCountryId,
    nameKo: entry.nameKo,
    nameEn: entry.nameEn,
    materializable: entry.materializable,
  }));
  const playerCountry = countries.find((country) => country.countryId === simulation.playerCountryId);
  if (!playerCountry) throw new Error("Player country was clipped from SimulationContextV1");

  const context: SimulationContextV1 = Object.freeze({
    contextVersion: "simulation-context.v1",
    scenario: Object.freeze({id: input.scenarioId, startDate: input.scenarioStartDate}),
    revisions: Object.freeze({simulation: simulation.revision, world: world.revision}),
    period: Object.freeze({startDate: simulation.currentDate, endDate: input.targetDate}),
    playerCountry: Object.freeze({
      countryId: playerCountry.countryId,
      name: playerCountry.shortKo,
    }),
    queuedActions: Object.freeze(simulation.queuedActions
      .filter((action) => action.status === "queued" || action.status === "resolving")
      .sort((left, right) => compareCanonicalText(left.actionId, right.actionId))
      .map(({actionId, actorCountryId, submittedAtDate, text, visibility}) => Object.freeze({
        actionId,
        actorCountryId,
        submittedAtDate,
        text,
        visibility,
      }))),
    countries: Object.freeze(countries),
    countryDirectory: Object.freeze(countryDirectory),
    territoryDirectory: Object.freeze(territoryDirectory),
    facts: Object.freeze(clip(facts, SIMULATION_CONTEXT_LIMITS.facts, "facts", clipped)),
    situations: Object.freeze(clip(
      situations,
      SIMULATION_CONTEXT_LIMITS.situations,
      "situations",
      clipped,
    )),
    dueConsequences: Object.freeze(clip(
      dueConsequences,
      SIMULATION_CONTEXT_LIMITS.dueConsequences,
      "dueConsequences",
      clipped,
    )),
    recentEvents: Object.freeze(recentEvents),
    ...(simulation.schemaVersion === 2 ? {countryPresentationAuthorities:Object.freeze(simulation.countryPresentationAuthorityOrder.map(id => simulation.countryPresentationAuthoritiesById[id])),presentationAuthorityHistory:presentationHistory(simulation.eventLog)} : {}),
    ...(world.schemaVersion === 3 ? {countryMapColors:world.countryOrder.map(countryId=>({countryId,mapColor:world.countriesById[countryId].mapColor}))} : {}),
    ...(simulation.schemaVersion === 2 ? {territorialControlAuthorities:Object.freeze(clip(simulation.territorialControlAuthorityOrder.map(id=>simulation.territorialControlAuthoritiesById[id]).filter(a=>a.actorCountryId===simulation.playerCountryId||a.targetCountryId===simulation.playerCountryId),8,'territorialControlAuthorities',clipped).map(a=>Object.freeze({...a,allowedTerritoryIds:Object.freeze(clip(a.allowedTerritoryIds,SIMULATION_CONTEXT_LIMITS.territoryIdsPerCountry,`authority:${a.id}`,clipped))})))} : {}),
    ...(world.schemaVersion===3?{regionCatalog:world.catalogRef}:{}),
    subdivisions: Object.freeze(subdivisions),
    rules: Object.freeze({
      locale: input.locale ?? "ko-KR",
      capabilities: Object.freeze(world.schemaVersion===3?['narrative-events','facts-and-situations','scheduled-consequences','country-rename','country-map-color','bounded-territorial-authority','territory-occupy','territory-liberate','territory-transfer-ownership','countries-merge']:[
        "narrative-events",
        "facts-and-situations",
        "scheduled-consequences",
        "semantic-world-effects",
      ]),
    }),
    metadata: Object.freeze({clipped: Object.freeze(clipped)}),
  });
  if (new TextEncoder().encode(canonicalStringify(context)).byteLength > SIMULATION_CONTEXT_LIMITS.requestBytes) {
    throw new SimulationContextError(
      "SIMULATION_CONTEXT_TOO_LARGE",
      `Serialized context exceeds ${SIMULATION_CONTEXT_LIMITS.requestBytes} bytes`,
    );
  }
  return context;
}

export const serializeSimulationContext = (context: SimulationContextV1): string =>
  canonicalStringify(context);

