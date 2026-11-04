const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const REQUIRED_TURNS = Object.freeze([['PRK', 'KOR'], ['KOR', 'PRK'], ['PRK', 'CHN']]);
const key = (actor, target) => `${actor}->${target}`;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Count the required records themselves, including absent/failed selection or commit.
function summarizeRequiredTurns(turns) {
  const requiredKeys = REQUIRED_TURNS.map(([actor, target]) => key(actor, target));
  const groups = requiredKeys.map(id => turns.filter(turn => key(turn.actor, turn.target) === id));
  const passed = groups.filter(group => group.length === 1 && group[0].executed === true
    && group[0].completed === true && group[0].ok === true).length;
  const unexpected = turns.filter(turn => !requiredKeys.includes(key(turn.actor, turn.target)));
  return {
    required: requiredKeys.length, executed: groups.filter(group => group.some(turn => turn.executed)).length,
    passed, failed: requiredKeys.length - passed + unexpected.length,
    missingTargets: groups.flatMap((group, i) => group.length ? [] : [REQUIRED_TURNS[i][1]]),
    duplicateTargets: groups.flatMap((group, i) => group.length > 1 ? [REQUIRED_TURNS[i][1]] : []),
    unexpected: unexpected.map(turn => key(turn.actor, turn.target)),
  };
}

function runAudit(outputFile) {
  const root = fs.realpathSync(path.resolve(__dirname, '../..'));
  assert.equal(fs.realpathSync(process.cwd()), root, 'Run from the worktree root');
  const output = path.resolve(root, outputFile);
  const runRoot = path.join(root, '.tmp/prompt21');
  assert(output.startsWith(runRoot + path.sep) && output.endsWith('.json'), 'Output must be .tmp/prompt21/<run>/file.json');
  fs.mkdirSync(path.dirname(output), {recursive: true});
  assert(fs.realpathSync(path.dirname(output)).startsWith(fs.realpathSync(runRoot) + path.sep), 'Output parent must stay inside the run root');
  assert(!fs.existsSync(output), 'Use a new output file for each audit');

  const startedAt = new Date().toISOString();
  const originalRead = fs.readFileSync;
  const pins = new Map();
  // Capture actual synchronous source/seed/catalog reads, including compressed assets.
  fs.readFileSync = function(file, ...args) {
    const bytes = originalRead.call(this, file, ...args);
    if (typeof file === 'string') {
      const relative = path.relative(root, path.resolve(file)).replaceAll('\\', '/');
      if (/^(src|scripts|data|public|reports)\//.test(relative) || ['package.json', 'package-lock.json'].includes(relative)) {
        const identity = {path: relative, sha256: sha(bytes), byteLength: Buffer.byteLength(bytes)};
        if (pins.has(relative)) assert.deepEqual(identity, pins.get(relative), `Input changed while reading: ${relative}`);
        else pins.set(relative, identity);
      }
    }
    return bytes;
  };
  const turns = [];
  const evidence = {
    schemaVersion: 'prompt21-current-frontiers-v1', startedAt, timezone: 'Asia/Seoul',
    reuseOf: 'reports/province-independence-parallelism-20261103/audit.cjs actualCatalogTurnProbes',
    scope: 'Read current catalog and canonical seed; three independent memory runtimes; no live game or artifact writes.',
    turns,
  };
  try {
    fs.readFileSync(__filename);
    fs.readFileSync('package.json');
    const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
    evidence.dependencyVersions = Object.fromEntries(['next', 'typescript', 'zod', 'zustand'].map(name => {
      const version = require(`${name}/package.json`).version;
      assert.equal(version, lock.packages[`node_modules/${name}`].version, `Installed dependency differs from lockfile: ${name}`);
      return [name, version];
    }));
    const Module = require('node:module');
    const ts = require('typescript');
    const empty = require.resolve('next/dist/compiled/server-only/empty.js');
    const originalResolve = Module._resolveFilename;
    Module._resolveFilename = function(request, ...args) {
      return originalResolve.call(this, request === 'server-only' ? empty
        : request.startsWith('@/') ? path.join(root, 'src', request.slice(2)) : request, ...args);
    };
    require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true},
    }).outputText, file);
    process.env.NODE_ENV = 'test';
    const fromRoot = file => require(path.join(root, file));
    const {prepareOperationalCatalog} = fromRoot('src/lib/world/operational-catalog.server.ts');
    const {createProductionOperationalGame} = fromRoot('src/lib/world/operational-game.server.ts');
    const {deserializeWorldStateV3, serializeWorldStateV3, worldStateV3ContentHash} = fromRoot('src/lib/world/world-state-v3.ts');
    const {createOperationalRegionIndex} = fromRoot('src/lib/simulation/operational-region.server.ts');
    const {selectOperationalFrontier} = fromRoot('src/lib/simulation/operational-frontier.server.ts');
    const {createSimulationStateV2, simulationStateV2ContentHash} = fromRoot('src/lib/simulation/simulation-state-v2.ts');
    const {createCatalogRuntime} = fromRoot('src/lib/simulation/catalog-runtime.ts');
    const {createCatalogTurnPlan} = fromRoot('src/lib/simulation/catalog-turn-plan.ts');
    const {assertWorldGeometryCatalogRefMatches} = fromRoot('src/lib/world/world-geometry-catalog-ref.ts');
    const catalog = prepareOperationalCatalog(), contract = catalog.worldContract();
    const index = createOperationalRegionIndex(catalog);
    evidence.catalogRef = catalog.ref;
    const registry = JSON.parse(fs.readFileSync('data/runtime/geography/current.json', 'utf8'));
    assertWorldGeometryCatalogRefMatches(registry.catalogRef, catalog.ref);
    const manifestBytes = fs.readFileSync(registry.manifest.path);
    assert.equal(sha(manifestBytes), registry.manifest.sha256);
    assert.equal(manifestBytes.length, registry.manifest.byteLength);
    const manifest = JSON.parse(manifestBytes);
    assertWorldGeometryCatalogRefMatches(manifest.catalogRef, catalog.ref);
    assert.deepEqual(manifest.metadataRef, registry.metadataRef);
    evidence.metadataRef = registry.metadataRef;
    evidence.metadataManifest = registry.manifest;
    // Preserve the historical audit and its reports as additional read-only pins.
    for (const file of ['audit.cjs', 'evidence.json', 'verification.json', 'report.md']) {
      fs.readFileSync(`reports/province-independence-parallelism-20261103/${file}`);
    }
    const worlds = new Set();
    for (const [actor, target] of REQUIRED_TURNS) {
      const record = {actor, target, catalogRef: catalog.ref, executed: true, committed: false, completed: false, ok: false, attempts: []};
      turns.push(record);
      try {
        // The production seed is cached and immutable; deserialize to give each turn its own objects.
        const seed = createProductionOperationalGame(actor).pair;
        const world = deserializeWorldStateV3(JSON.parse(JSON.stringify(serializeWorldStateV3(seed.world))), contract);
        assert(!worlds.has(world)); worlds.add(world);
        assert(world.territoryOrder.every(id => world.territoriesById[id] !== seed.world.territoriesById[id]));
        let selection;
        record.stage = 'selection';
        for (const extent of ['near', 'limited', 'deeper']) {
          try {
            selection = selectOperationalFrontier(catalog, world, {catalogRef: catalog.ref, baseWorldRevision: world.revision,
              actorCountryId: actor, targetCountryId: target, operation: 'occupy', extent,
              direction: null, reference: null, regionQuery: null, cap: 512}, index);
            assert(selection.cellIds.length > 0, 'EMPTY_FRONTIER_SELECTION');
            record.attempts.push({extent, ok: true, count: selection.cellIds.length});
            break;
          } catch (error) {selection = undefined; record.attempts.push({extent, ok: false, error: error.message});}
        }
        assert(selection, 'FRONTIER_SELECTION_FAILED');
        const selected = new Set(selection.cellIds);
        assert.equal(selected.size, selection.cellIds.length, 'DUPLICATE_SELECTION');
        record.selectedIds = [...selection.cellIds];
        const actionId = 'action.audit.' + target, eventId = 'event.audit.' + target;
        const simulation = createSimulationStateV2({...seed.simulation, queuedActions: [{
          actionId, actorCountryId: actor, submittedAtDate: seed.simulation.currentDate,
          text: '[DEBUG_WORLD_EFFECT] Audit bounded occupation', visibility: 'public', status: 'queued',
        }]}, world);
        const pair = {world, simulation, revisions: {worldRevision: world.revision, simulationRevision: simulation.revision}};
        const resolution = {
          contractVersion: 'turn-resolution.v1', baseSimulationRevision: simulation.revision, baseWorldRevision: world.revision,
          period: {startDate: simulation.currentDate, endDate: '2020-01-02'},
          playerActionOutcomes: [{outcomeId: 'outcome.audit.' + target, actionId, status: 'succeeded', evidenceEventId: eventId,
            summary: 'Bounded occupation', remainingConditions: []}],
          events: [{eventId, date: '2020-01-02', title: 'Audit occupation', publicNarrative: 'Selected real catalog cells changed control',
            actorCountryIds: [actor, target], relatedFactIds: [], relatedSituationIds: [], causes: [{kind: 'queued-action', id: actionId}],
            outcomeCategory: 'military', significance: 'notable'}],
          factMutations: [], situationMutations: [], scheduledConsequences: [],
          worldEffects: [{effectId: 'effect.audit.' + target, type: 'territory.occupy', causedByEventId: eventId,
            actorCountryId: actor, targetCountryId: target, authorityId: 'tca:debug', territoryIds: selection.cellIds,
            regionRefs: null, frontierScope: selection.scope}],
          advisorSummary: 'Audit actual catalog partial occupation', unresolvedQuestions: [],
        };
        const runtime = createCatalogRuntime(pair, contract);
        const notifications = [];
        runtime.subscribeChanges(change => notifications.push(change.kind));
        record.stage = 'plan-and-commit';
        const plan = createCatalogTurnPlan({...pair, turnId: 'turn.audit.' + target, resolution, catalog: contract, regionIndex: index,
          frontier: {world, resolve: (current, scope) => selectOperationalFrontier(catalog, current, scope, index)}});
        const committed = runtime.commit(plan);
        record.committed = true;
        const delta = runtime.getLastChange().stateChange;
        record.changedIds = world.territoryOrder.filter(id => world.territoriesById[id] !== committed.world.territoriesById[id]);
        record.delta = delta;
        assert.deepEqual([...record.changedIds].sort(), [...selected].sort());
        assert.deepEqual(delta.cells.map(cell => cell.id).sort(), [...selected].sort());
        assert.equal(runtime.getHistory().pointer, 1);
        assert.equal(runtime.getHistory().entries.length, 1);
        record.stage = 'undo-and-redo';
        const undo = runtime.undo();
        assert.equal(runtime.getHistory().pointer, 0);
        const redo = runtime.redo();
        assert.equal(runtime.getHistory().pointer, 1);
        record.hashes = {before: worldStateV3ContentHash(world), committed: worldStateV3ContentHash(committed.world),
          undo: worldStateV3ContentHash(undo.world), redo: worldStateV3ContentHash(redo.world)};
        const outside = world.territoryOrder.filter(id => !selected.has(id));
        record.stages = Object.fromEntries([['commit', committed], ['undo', undo], ['redo', redo]].map(([name, current]) => [name, {
          outsideTerritoryReferencesAndStates: outside.every(id => Object.isFrozen(world.territoriesById[id])
            && current.world.territoriesById[id] === world.territoriesById[id]),
          countryReferencesAndStates: world.countryOrder.every(id => Object.isFrozen(world.countriesById[id])
            && current.world.countriesById[id] === world.countriesById[id]),
          selectedReferencesRestored: selection.cellIds.every(id => current.world.territoriesById[id]
            === (name === 'undo' ? world : committed.world).territoriesById[id]),
          selectedStates: selection.cellIds.map(id => {
            const before = world.territoriesById[id], after = current.world.territoriesById[id];
            return {id, sourceCountryId: after.sourceCountryId, ownerCountryId: after.ownerCountryId, controllerCountryId: after.controllerCountryId,
              preserved: after.sourceCountryId === before.sourceCountryId && after.ownerCountryId === before.ownerCountryId
                && before.ownerCountryId === target && after.controllerCountryId === (name === 'undo' ? before.controllerCountryId : actor)};
          }),
        }]));
        for (const state of Object.values(record.stages)) {
          assert(state.outsideTerritoryReferencesAndStates && state.countryReferencesAndStates && state.selectedReferencesRestored);
          assert(state.selectedStates.every(cell => cell.preserved));
        }
        assert.equal(record.hashes.undo, record.hashes.before);
        assert.equal(record.hashes.redo, record.hashes.committed);
        // History restores content with fresh monotonic revisions; simulation hashes include revision.
        const restoredSimulationHash = (current, expected) => simulationStateV2ContentHash(
          createSimulationStateV2({...current.simulation, revision: expected.revision}, current.world));
        assert.equal(restoredSimulationHash(undo, simulation), simulationStateV2ContentHash(simulation));
        assert.equal(restoredSimulationHash(redo, committed.simulation), simulationStateV2ContentHash(committed.simulation));
        assert(undo.simulation.revision > committed.simulation.revision && redo.simulation.revision > undo.simulation.revision);
        assert.deepEqual(notifications, ['commit', 'undo', 'redo']);
        assert.deepEqual(runtime.getSubscriberFailures(), []);
        record.history = {undoWorldRestored: true, redoWorldRestored: true, simulationRestored: true,
          simulationHashComparison: 'Content compared at original revision; undo/redo revisions separately increase.',
          historyEntries: runtime.getHistory().entries.length, historyPointer: runtime.getHistory().pointer, notifications};
        record.independentMemorySeed = true;
        record.stage = 'complete'; record.completed = true; record.ok = true;
      } catch (error) {record.error = error.message;}
    }
  } catch (error) {evidence.setupError = error.message;}
  finally {fs.readFileSync = originalRead;}
  evidence.inputPins = [...pins.values()].sort((a, b) => a.path.localeCompare(b.path));
  evidence.changedInputs = evidence.inputPins.filter(pin => {
    try {return sha(originalRead(path.join(root, pin.path))) !== pin.sha256;}
    catch {return true;}
  }).map(pin => pin.path);
  evidence.summary = summarizeRequiredTurns(turns);
  evidence.ok = !evidence.setupError && evidence.summary.failed === 0 && evidence.changedInputs.length === 0;
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({file: path.relative(root, output).replaceAll('\\', '/'), ok: evidence.ok,
    summary: evidence.summary, setupError: evidence.setupError, changedInputs: evidence.changedInputs,
    turns: turns.map(turn => ({actor: turn.actor, target: turn.target, stage: turn.stage, ok: turn.ok,
      selected: turn.selectedIds?.length, changed: turn.changedIds?.length, error: turn.error}))}, null, 2));
  if (!evidence.ok) process.exitCode = 1;
}

module.exports = {summarizeRequiredTurns};
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') {
    console.error('Usage: node scripts/workspaces/audit-current-frontiers.cjs --output .tmp/prompt21/<run>/frontiers.json');
    process.exitCode = 1;
  } else runAudit(args[1]);
}
