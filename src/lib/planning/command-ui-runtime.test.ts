import {describe, expect, it} from "vitest";

import {createLabelProjection} from "../projection/label-projection-checkpoint";
import {
  createProjectionCoordinator,
  createSynchronizedMapSources,
} from "../projection/map-projection-checkpoint";
import {
  applyWorldCommand,
  commandUiSessionSummary,
  createCommandUiSession,
  defaultCommandJson,
  dryRunWorldCommand,
  migratePrompt09CommandUiSession,
  redoCommandUiSession,
  undoCommandUiSession,
} from "./command-ui-runtime";
import {checkpointWorldContentHash} from "./history-persistence-checkpoint";

const command = (value: unknown) => JSON.stringify(value, null, 2);

const renameCommand = (expectedRevision: number, commandId = "rename-aaa") => command({
  commandId,
  type: "country.rename",
  expectedRevision,
  payload: {
    countryId: "AAA",
    changes: {
      shortKo: "Alpha",
      officialKo: "Alpha Republic",
      mapKo: "Alpha",
      english: "Alpha Republic",
      searchAliases: ["Alpha"],
    },
  },
});

const dissolveCommand = (expectedRevision: number, territoryIds: readonly string[]) => command({
  commandId: "dissolve-aaa",
  type: "country.dissolve",
  expectedRevision,
  payload: {
    sourceCountryId: "AAA",
    territoryDispositions: territoryIds.map((territoryId) => ({
      territoryId,
      disposition: {type: "transfer", targetCountryId: "BBB"},
    })),
  },
});

describe("10-119~10-124 command UI and final integration checkpoint", () => {
  it("supports JSON command dry-run and patch preview without mutating the session", () => {
    const session = createCommandUiSession();
    const beforeSummary = commandUiSessionSummary(session);

    const result = dryRunWorldCommand(session, defaultCommandJson(session.worldState));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.commandType).toBe("country.establish");
    expect(result.preview.beforeRevision).toBe(session.worldState.revision);
    expect(result.preview.afterRevision).toBe(session.worldState.revision + 1);
    expect(result.preview.entityChangeSets.countries.created).toEqual(["D01"]);
    expect(commandUiSessionSummary(session)).toEqual(beforeSummary);
  });

  it("applies commands and blocks duplicate command ids through planner/executor integration", () => {
    const session = createCommandUiSession();
    const input = defaultCommandJson(session.worldState);

    const applied = applyWorldCommand(session, input);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const duplicate = applyWorldCommand(
      applied.session,
      defaultCommandJson(applied.session.worldState),
    );
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.message).toContain("already committed");
    expect(applied.session.worldState.countriesById.D01).toBeDefined();
    expect(applied.session.history.entries).toHaveLength(1);
  });

  it("runs establish, dissolve, split and merge style flows with undo redo hash consistency", () => {
    const initial = createCommandUiSession();
    const established = applyWorldCommand(initial, defaultCommandJson(initial.worldState));
    expect(established.ok).toBe(true);
    if (!established.ok) return;

    const renamed = applyWorldCommand(
      established.session,
      renameCommand(established.session.worldState.revision),
    );
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;

    const sourceTerritoryIds = renamed.session.worldState.territoryOrder.filter((territoryId) =>
      renamed.session.worldState.territoriesById[territoryId].ownerCountryId === "AAA"
    );
    const dissolved = applyWorldCommand(
      renamed.session,
      dissolveCommand(renamed.session.worldState.revision, sourceTerritoryIds),
    );
    expect(dissolved.ok).toBe(true);
    if (!dissolved.ok) return;

    const undone = undoCommandUiSession(dissolved.session);
    const redone = redoCommandUiSession(undone);

    expect(dissolved.session.worldState.countriesById.AAA).toBeUndefined();
    expect(commandUiSessionSummary(redone).contentHash)
      .toBe(commandUiSessionSummary(dissolved.session).contentHash);
    expect(checkpointWorldContentHash(redone.worldState))
      .toBe(checkpointWorldContentHash(dissolved.session.worldState));
    expect(undone.history.pointer).toBe(dissolved.session.history.pointer - 1);
    expect(redone.history.pointer).toBe(dissolved.session.history.pointer);
    for (const snapshot of [dissolved.session, undone, redone]) {
      const state = snapshot.worldState;
      const map = createSynchronizedMapSources(state);
      const labels = createLabelProjection(state);
      const activeIds = new Set<string>(state.countryOrder);
      expect(map.low.meta.appliedRevision).toBe(state.revision);
      expect(map.high.meta.appliedRevision).toBe(state.revision);
      expect(labels.appliedRevision).toBe(state.revision);
      expect(map.low.featureCollection.features.every(({properties}) =>
        properties.ownerCountryId === null || activeIds.has(properties.ownerCountryId)
      )).toBe(true);
      expect(labels.jobs.every(({countryId}) => activeIds.has(countryId))).toBe(true);
    }
    expect(undone.worldState.countriesById.AAA).toBeDefined();
    expect(redone.worldState.countriesById.AAA).toBeUndefined();
  });

  it("keeps final projections aligned after command application", () => {
    const session = createCommandUiSession();
    const applied = applyWorldCommand(session, defaultCommandJson(session.worldState));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    const mapSources = createSynchronizedMapSources(applied.session.worldState);
    const labels = createLabelProjection(applied.session.worldState);
    const coordinator = createProjectionCoordinator(applied.session.worldState, []);
    const territoryIds = new Set(applied.session.worldState.territoryOrder);
    const ownerIds = new Set<string>(Object.values(applied.session.worldState.territoriesById)
      .map(({ownerCountryId}) => ownerCountryId)
      .filter((ownerCountryId) => ownerCountryId !== null)
      .map((ownerCountryId) => ownerCountryId as string));

    expect(mapSources.low.meta.appliedRevision).toBe(applied.session.worldState.revision);
    expect(mapSources.high.meta.appliedRevision).toBe(applied.session.worldState.revision);
    expect(mapSources.low.featureCollection.features.map(({properties}) => properties.territoryId).sort())
      .toEqual([...territoryIds].sort());
    expect(labels.revision).toBe(applied.session.worldState.revision);
    expect(labels.jobs.every((label) =>
      territoryIds.has(label.territoryId) && ownerIds.has(label.countryId as string)
    )).toBe(true);
    expect(coordinator.records.size).toBe(0);
  });

  it("loads Prompt 09 style saves through migration without transient UI state", () => {
    const session = migratePrompt09CommandUiSession({
      selectedCountryId: "MISSING",
      playerCountryId: "AAA",
      deletedCountryIds: ["RETIRED"],
      maplibreCache: {unexpected: true},
    });

    expect(session.lastError).toContain("MISSING");
    expect(session.lastError).toContain("RETIRED");
    expect(commandUiSessionSummary(session).activeCountryIds).toEqual(["AAA", "BBB", "CCC"]);
  });
});
