import {
  commandBatchV2CommandSchema,
  leafMapCommandV2Schema,
  type CommandBatchV2Command,
  type LeafMapCommandV2,
} from "../commands/command-batch-v2";
import {createCountryEntity} from "../world/country-entity";
import type {ActiveCountryId, RetiredCountryId} from "../world/country-id";
import {createImmutableReadonlySet} from "../world/immutable-readonly-set";
import {sha256Hex} from "../world/sha256";
import {createTopologyState} from "../world/topology-state";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId} from "../world/territory-id";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import {calculateAffectedSet} from "./affected-set";
import {planCommandBatch} from "./command-batch-planner";
import {planCountryCreate} from "./country-create-planner";
import {planCountryDelete} from "./country-delete-planner";
import {planCountryDissolve} from "./country-dissolve-planner";
import {planCountryEstablish} from "./country-establish-planner";
import {planCountryMerge} from "./country-merge-planner";
import {planCountryRename} from "./country-rename-planner";
import {planCountrySplit} from "./country-split-planner";
import {
  checkpointWorldContentHash,
  createWorldHistory,
  migratePrompt09SaveToWorldStateV2,
  recordHistoryEntry,
  redoHistory,
  undoHistory,
  type WorldHistory,
} from "./history-persistence-checkpoint";
import {planningError, type PlanResult, type SuccessfulPlan} from "./plan-result";
import type {PlannerContext} from "./planner-boundary";
import {planTerritoryAssign} from "./territory-assign-planner";
import {planTerritoryPartition} from "./territory-partition-planner";
import {planTerritoryReplace} from "./territory-replace-planner";
import {planTerritoryTransfer} from "./territory-transfer-planner";
import {planTerritoryUnclaim} from "./territory-unclaim-planner";
import {buildWorldPatchV2, type WorldPatchV2} from "./world-patch-v2";

export type RuntimeCommand = LeafMapCommandV2 | CommandBatchV2Command;

export type CommandPreview = Readonly<{
  ok: true;
  commandId: string;
  commandType: string;
  beforeRevision: number;
  afterRevision: number;
  beforeContentHash: string;
  afterContentHash: string;
  entityDeltas: WorldPatchV2["entityDeltas"];
  entityChangeSets: WorldPatchV2["entityChangeSets"];
  plannerPatch: unknown;
}>;

export type CommandRuntimeError = Readonly<{
  ok: false;
  message: string;
}>;

export type CommandDryRunResult =
  | Readonly<{
    ok: true;
    command: RuntimeCommand;
    plan: SuccessfulPlan<unknown>;
    patch: WorldPatchV2;
    preview: CommandPreview;
  }>
  | CommandRuntimeError;

export type CommandUiSession = Readonly<{
  worldState: WorldStateV2;
  history: WorldHistory;
  committedCommandIds: ReadonlySet<string>;
  lastPreview: CommandPreview | null;
  lastError: string | null;
}>;

export type CommandApplyResult =
  | Readonly<{ok: true; session: CommandUiSession; preview: CommandPreview}>
  | CommandRuntimeError;

const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const activeCountryId = (countryId: string) => countryId as ActiveCountryId;
const textEncoder = new TextEncoder();
const hash = (value: unknown) => sha256Hex(textEncoder.encode(JSON.stringify(value)));

const rectangle = (x: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[
    [x, 0],
    [x + 1, 0],
    [x + 1, 1],
    [x, 1],
    [x, 0],
  ]],
});

const country = (id: string) => createCountryEntity({
  id: activeCountryId(id),
  names: {
    shortKo: id,
    officialKo: `${id} Republic`,
    mapKo: id,
    english: `${id} Republic`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {core: 1, names: 1},
});

const territory = (sourceFeatureId: string, ownerCountryId: string | null, x: number) =>
  createTerritoryEntity({
    id: deriveTerritoryId({
      kind: "seed",
      seedVersion: "10-124-command-ui",
      sourceFeatureId,
    }),
    ownerCountryId: ownerCountryId === null ? null : activeCountryId(ownerCountryId),
    geometry: rectangle(x),
    properties: {sourceFeatureId},
  });

export function createCommandUiDemoWorldState(): WorldStateV2 {
  const territories = [
    territory("alpha", "AAA", 0),
    territory("beta", "AAA", 2),
    territory("gamma", "BBB", 4),
    territory("free", null, 6),
  ];
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "10-124-command-ui",
    policyVersion: "world-policy-v1",
    revision: 0,
    countriesById: {
      AAA: country("AAA"),
      BBB: country("BBB"),
      CCC: country("CCC"),
    },
    countryOrder: [activeCountryId("AAA"), activeCountryId("BBB"), activeCountryId("CCC")],
    retiredCountryIds: createImmutableReadonlySet<RetiredCountryId>([]),
    territoriesById: Object.freeze(Object.fromEntries(territories.map((entry) => [entry.id, entry]))),
    territoryOrder: Object.freeze(territories.map(({id}) => id)),
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: hash("countries"),
      presentationRootHash: hash("presentation"),
      territoriesRootHash: hash("territories"),
      topologyRootHash: hash("topology"),
    },
  });
}

export function createCommandUiSession(
  worldState: WorldStateV2 = createCommandUiDemoWorldState(),
): CommandUiSession {
  return Object.freeze({
    worldState,
    history: createWorldHistory(worldState.revision),
    committedCommandIds: new Set<string>(),
    lastPreview: null,
    lastError: null,
  });
}

export function defaultCommandJson(state: WorldStateV2): string {
  const freeTerritoryId = state.territoryOrder.find((territoryId) =>
    state.territoriesById[territoryId].ownerCountryId === null
  ) ?? state.territoryOrder[0];
  return JSON.stringify({
    commandId: "establish-generated-country",
    type: "country.establish",
    expectedRevision: state.revision,
    payload: {
      country: {
        names: {
          shortKo: "새 국가",
          officialKo: "새 국가",
          mapKo: "새 국가",
          english: "New Country",
          searchAliases: ["New Country"],
        },
        politicalStatus: "sovereign",
        presentationOverride: null,
        moduleVersions: {core: 1, names: 1},
      },
      territoryIds: [freeTerritoryId],
    },
  }, null, 2);
}

export function parseRuntimeCommand(input: string): RuntimeCommand {
  const raw = JSON.parse(input) as unknown;
  const batch = commandBatchV2CommandSchema.safeParse(raw);
  if (batch.success) return batch.data;
  const leaf = leafMapCommandV2Schema.safeParse(raw);
  if (leaf.success) return leaf.data;
  throw new Error(batch.error.issues[0]?.message ?? leaf.error.issues[0]?.message ?? "Invalid command JSON");
}

function planLeafCommand(
  state: WorldStateV2,
  command: LeafMapCommandV2,
  context: PlannerContext,
): PlanResult<unknown> {
  switch (command.type) {
    case "country.create":
      return planCountryCreate(state, command, context);
    case "country.rename":
      return planCountryRename(state, command, context);
    case "country.establish":
      return planCountryEstablish(state, command, context);
    case "country.delete":
      return planCountryDelete(state, command, context);
    case "country.dissolve":
      return planCountryDissolve(state, command, context);
    case "territory.partition":
      return planTerritoryPartition(state, command, context);
    case "territory.assign":
      return planTerritoryAssign(state, command, context);
    case "territory.unclaim":
      return planTerritoryUnclaim(state, command, context);
    case "territory.replace":
      return planTerritoryReplace(state, command, context);
    case "territory.transfer":
      return planTerritoryTransfer(state, command, context);
    case "country.split":
      return planCountrySplit(state, command, context);
    case "country.merge":
      return planCountryMerge(state, command, context);
    default:
      {
        const unsupported = command as LeafMapCommandV2;
        return planningError(
          "batch-command-unsupported",
          unsupported.commandId,
          `No planner is registered for command type: ${unsupported.type}`,
        );
      }
  }
}

export function planRuntimeCommand(
  state: WorldStateV2,
  command: RuntimeCommand,
  committedCommandIds: ReadonlySet<string>,
): PlanResult<unknown> {
  const context = {committedCommandIds};
  return command.type === "command.batch"
    ? planCommandBatch(state, command, context)
    : planLeafCommand(state, command, context);
}

function previewFromPatch(
  command: RuntimeCommand,
  patch: WorldPatchV2,
  plannerPatch: unknown,
): CommandPreview {
  return Object.freeze({
    ok: true,
    commandId: command.commandId,
    commandType: command.type,
    beforeRevision: patch.beforeRevision,
    afterRevision: patch.afterRevision,
    beforeContentHash: patch.beforeContentHash,
    afterContentHash: patch.afterContentHash,
    entityDeltas: patch.entityDeltas,
    entityChangeSets: patch.entityChangeSets,
    plannerPatch,
  });
}

export function dryRunWorldCommand(
  session: CommandUiSession,
  input: string,
): CommandDryRunResult {
  try {
    const command = parseRuntimeCommand(input);
    const plan = planRuntimeCommand(
      session.worldState,
      command,
      session.committedCommandIds,
    );
    if (!plan.ok) {
      return Object.freeze({ok: false, message: plan.error.message});
    }
    const affectedSet = calculateAffectedSet({
      beforeState: session.worldState,
      afterState: plan.plan.nextState,
      patch: plan.plan.patch,
    });
    const patch = buildWorldPatchV2({
      commandId: plan.plan.commandId,
      beforeState: session.worldState,
      afterState: plan.plan.nextState,
      affectedSet,
      plannerPatch: plan.plan.patch,
    });
    return Object.freeze({
      ok: true,
      command,
      plan: plan.plan,
      patch,
      preview: previewFromPatch(command, patch, plan.plan.patch),
    });
  } catch (error) {
    return Object.freeze({
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function applyWorldCommand(
  session: CommandUiSession,
  input: string,
): CommandApplyResult {
  const dryRun = dryRunWorldCommand(session, input);
  if (!dryRun.ok) return dryRun;
  const history = recordHistoryEntry(
    session.history,
    dryRun.patch,
    session.worldState,
    dryRun.plan.nextState,
  );
  return Object.freeze({
    ok: true,
    preview: dryRun.preview,
    session: Object.freeze({
      worldState: dryRun.plan.nextState,
      history,
      committedCommandIds: new Set<string>([...session.committedCommandIds, dryRun.command.commandId]),
      lastPreview: dryRun.preview,
      lastError: null,
    }),
  });
}

export function undoCommandUiSession(session: CommandUiSession): CommandUiSession {
  const result = undoHistory(session.history, session.worldState);
  return Object.freeze({
    ...session,
    worldState: result.state,
    history: result.history,
    lastError: null,
  });
}

export function redoCommandUiSession(session: CommandUiSession): CommandUiSession {
  const result = redoHistory(session.history, session.worldState);
  return Object.freeze({
    ...session,
    worldState: result.state,
    history: result.history,
    lastError: null,
  });
}

export function migratePrompt09CommandUiSession(
  raw: unknown,
  fallback: CommandUiSession = createCommandUiSession(),
): CommandUiSession {
  const migrated = migratePrompt09SaveToWorldStateV2(raw, fallback.worldState);
  return Object.freeze({
    ...fallback,
    worldState: migrated.worldState,
    history: createWorldHistory(migrated.worldState.revision),
    lastError: migrated.ignoredCountryIds.length === 0
      ? null
      : `Ignored legacy country ids: ${[...migrated.ignoredCountryIds].sort(compareText).join(", ")}`,
  });
}

export function commandUiSessionSummary(session: CommandUiSession) {
  return Object.freeze({
    revision: session.worldState.revision,
    contentHash: checkpointWorldContentHash(session.worldState),
    activeCountryIds: Object.freeze([...session.worldState.countryOrder]),
    territoryOwners: Object.freeze(session.worldState.territoryOrder.map((territoryId) => ({
      territoryId,
      ownerCountryId: session.worldState.territoriesById[territoryId].ownerCountryId,
    }))),
    historyPointer: session.history.pointer,
    historyLength: session.history.entries.length,
  });
}
