import fs from 'node:fs';
import path from 'node:path';
import {CodexClient} from './codex-client.mjs';
import {afterImplementation, afterVerification, initialState, operatingFailure, stopState, TERMINAL} from './state-machine.mjs';
import {appendEvent, atomicJson, fileIdentity, readJson, resolveInside, resolveInsideEither, runId} from './protocol.mjs';

export const IMPLEMENTATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['status', 'summary', 'changedFiles', 'artifactPaths', 'commands', 'remainingIssues'],
  properties: {
    status: {type: 'string', enum: ['complete', 'blocked', 'external_input']},
    summary: {type: 'string'},
    changedFiles: {type: 'array', items: {type: 'string'}},
    artifactPaths: {type: 'array', items: {type: 'string'}},
    commands: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['command', 'exitCode'], properties: {command: {type: 'string'}, exitCode: {type: 'integer'}}}},
    remainingIssues: {type: 'array', items: {type: 'string'}},
  },
};

export const VERIFICATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'failureKind', 'summary', 'failures', 'commands', 'evidencePaths', 'verdictPath', 'checks'],
  properties: {
    verdict: {type: 'string', enum: ['pass', 'fail', 'blocked']},
    failureKind: {type: ['string', 'null'], enum: ['product', 'operating', 'external', null]},
    summary: {type: 'string'},
    failures: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['code', 'message', 'evidence'], properties: {code: {type: 'string'}, message: {type: 'string'}, evidence: {type: ['string', 'null']}}}},
    commands: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['command', 'exitCode'], properties: {command: {type: 'string'}, exitCode: {type: 'integer'}}}},
    evidencePaths: {type: 'array', items: {type: 'string'}},
    verdictPath: {type: 'string'},
    checks: {
      type: 'object', additionalProperties: false,
      required: [
        'positiveCandidate', 'independentCurrentBytes', 'commandExitCodesAllZero',
        'buildAllowed', 'sourceCountSVN', 'tracedCountSVN', 'missing', 'duplicate', 'unresolved',
        'componentHoleCorrespondence', 'protectedOverlayCorrespondence',
        'missingFixtureRejected', 'unresolvedFixtureRejected',
      ],
      properties: {
        positiveCandidate: {type: 'boolean'}, independentCurrentBytes: {type: 'boolean'}, commandExitCodesAllZero: {type: 'boolean'},
        buildAllowed: {type: ['boolean', 'null']}, sourceCountSVN: {type: ['integer', 'null']}, tracedCountSVN: {type: ['integer', 'null']},
        missing: {type: ['integer', 'null']}, duplicate: {type: ['integer', 'null']}, unresolved: {type: ['integer', 'null']},
        componentHoleCorrespondence: {type: ['boolean', 'null']}, protectedOverlayCorrespondence: {type: ['boolean', 'null']},
        missingFixtureRejected: {type: ['boolean', 'null']}, unresolvedFixtureRejected: {type: ['boolean', 'null']},
      },
    },
  },
};

const pad = value => String(value).padStart(3, '0');

function taskById(plan, taskId) {
  const task = plan.tasks.find(row => row.id === taskId);
  if (!task) throw Error(`Unknown task: ${taskId}`);
  return task;
}
function compactFailure(state) {
  const latest = state.failures.at(-1);
  if (!latest) return null;
  const verification = latest.verification;
  return {
    attempt: latest.attempt,
    summary: verification.summary,
    failures: verification.failures,
    evidencePaths: verification.evidencePaths,
    checks: verification.checks,
  };
}

function implementationPrompt({task, workspace, state, config, root}) {
  return [
    `Implement only Prompt 15 task ${task.id}: ${task.title}.`,
    `Work only in this candidate workspace: ${workspace}`,
    `This is product attempt ${state.productAttempt} of ${state.maxProductAttempts}.`,
    `Read the fixed prompt at ${path.join(root, config.promptPath)} and apply sections ${task.sections.join(', ')}.`,
    `Task contract: ${JSON.stringify(task)}`,
    `Previous independent verification failure: ${JSON.stringify(compactFailure(state))}`,
    'Implement the product directly. A product failure, unresolved geometry, rejected build, or failed test is not an operating incident.',
    'Run focused implementation checks. Do not claim PASS; the verifier alone decides PASS from current bytes.',
    'Do not edit REVIEW B inputs, the fixed prompt, task plan, policy thresholds, or prior reports.',
    'Do not start a later task or REVIEW C. Preserve failed evidence instead of hiding it.',
    'Return status=blocked when the current candidate still fails, with exact remaining issues. That response will go to verification, not Guardian.',
  ].join('\n\n');
}

function verificationPrompt({task, workspace, implementation, evidenceDirectory, config, root}) {
  const strict18 = task.id === '15-18' ? [
    'For 15-18, PASS requires an actual buildAllowed=true candidate, SVN source=193 and traced=193, missing=0, duplicate=0, unresolved=0, complete component/hole and protected-overlay correspondence, plus injected missing/unresolved fixtures rejected non-zero.',
    'A correctly rejected candidate is FAIL, never PASS.',
    'Do not trust generator status. Re-read current artifact bytes with separate verification code.',
  ].join(' ') : '';
  return [
    `Independently verify only Prompt 15 task ${task.id}: ${task.title}.`,
    `Read current bytes from candidate workspace: ${workspace}`,
    `Write verification-only evidence under: ${evidenceDirectory}`,
    `Read the fixed prompt at ${path.join(root, config.promptPath)} and apply sections ${task.sections.join(', ')}.`,
    `Task contract: ${JSON.stringify(task)}`,
    `Implementation response: ${JSON.stringify(implementation)}`,
    strict18,
    'Run the required targeted commands yourself. Product test failures must use failureKind=product.',
    'Use failureKind=operating only when a command could not execute because the runtime/controller/environment failed, not when the product or test failed.',
    'Write a JSON verdict artifact, return its absolute path as verdictPath, and list every evidence file.',
    'PASS requires positive current-byte success evidence and all command exit codes zero. Never infer PASS from historical status.',
    'Do not modify product files, criteria, tests, thresholds, REVIEW B inputs, or later tasks.',
  ].filter(Boolean).join('\n\n');
}

export class Prompt15Orchestrator {
  constructor({root, directory, config, plan, clientFactory = options => new CodexClient(options)}) {
    this.root = path.resolve(root);
    this.directory = path.resolve(directory);
    this.config = config;
    this.plan = plan;
    this.clientFactory = clientFactory;
    this.stateFile = path.join(this.directory, 'state.json');
    this.eventFile = path.join(this.directory, 'events.jsonl');
    this.stopFile = path.join(this.directory, 'stop.json');
    this.state = readJson(this.stateFile);
  }

  static create({root, taskId, seed, config, plan}) {
    root = path.resolve(root);
    taskById(plan, taskId);
    seed = resolveInside(root, seed, 'seed');
    if (!fs.statSync(seed).isDirectory()) throw Error('Seed must be a directory');
    const directory = path.join(root, 'reports/prompt15/orchestrator-v2', runId());
    const workspace = path.join(directory, 'workspace');
    fs.mkdirSync(directory, {recursive: true});
    fs.cpSync(seed, workspace, {recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true});
    const state = initialState({runId: path.basename(directory), taskId, workspace, maxProductAttempts: config.maxProductAttempts});
    state.seed = {path: path.relative(root, seed).replaceAll('\\', '/'), copiedAt: new Date().toISOString()};
    state.inputs = [
      fileIdentity(root, path.join(root, 'automation/prompt15/config.json')),
      fileIdentity(root, path.join(root, 'automation/prompt15/task-plan.json')),
      fileIdentity(root, path.join(root, config.promptPath)),
    ];
    atomicJson(path.join(directory, 'state.json'), state);
    atomicJson(path.join(root, 'reports/prompt15/orchestrator-v2/latest.json'), {runId: state.runId, directory});
    appendEvent(path.join(directory, 'events.jsonl'), {kind: 'run_created', taskId, workspace, seed});
    return new Prompt15Orchestrator({root, directory, config, plan});
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    atomicJson(this.stateFile, this.state);
  }

  event(value) { appendEvent(this.eventFile, value); }
  stopped() { return fs.existsSync(this.stopFile); }

  reportDirectory(kind) {
    const base = path.join(this.directory, 'attempts', `attempt-${pad(this.state.productAttempt)}`);
    const sequence = kind === 'implementation' ? ++this.state.implementationTurns : ++this.state.verificationTurns;
    const directory = path.join(base, `${kind}-turn-${pad(sequence)}`);
    fs.mkdirSync(directory, {recursive: true});
    return directory;
  }

  async executeRole({roleName, prompt, schema, reportDirectory, evidenceDirectory = null}) {
    const role = this.config.roles[roleName];
    const developerInstructions = fs.readFileSync(path.join(this.root, role.promptPath), 'utf8');
    atomicJson(path.join(reportDirectory, 'request.json'), {role: roleName, taskId: this.state.taskId, productAttempt: this.state.productAttempt, workspace: this.state.workspace, prompt, schema});
    const client = this.clientFactory({
      binary: this.config.codexBinary ?? 'codex',
      cwd: this.root,
      turnTimeoutMs: this.config.turnTimeoutMs,
      log: event => this.event({...event, role: roleName}),
    });
    try {
      await client.initialize();
      const threadId = await client.startThread({cwd: this.state.workspace, role, developerInstructions});
      this.state.activeTurn = {role: roleName, threadId, startedAt: new Date().toISOString(), reportDirectory};
      this.save();
      const result = await client.runTurn({
        threadId, cwd: this.state.workspace, role, prompt, schema,
        writableRoots: [this.state.workspace, ...(evidenceDirectory ? [evidenceDirectory] : [])],
        shouldStop: () => this.stopped(),
        onStarted: ({turnId}) => { this.state.activeTurn.turnId = turnId; this.save(); },
      });
      atomicJson(path.join(reportDirectory, 'response.json'), {threadId, turnId: result.turnId, result: result.value});
      const responseIdentity = fileIdentity(this.root, path.join(reportDirectory, 'response.json'));
      this.event({kind: 'role_completed', role: roleName, threadId, taskId: this.state.taskId, productAttempt: this.state.productAttempt, responseIdentity});
      this.state.activeTurn = null;
      this.save();
      return {value: result.value, responseIdentity};
    } finally { await client.close().catch(error => this.event({kind: 'client_close_error', text: error.message})); }
  }

  validateVerification(value) {
    const roots = [this.state.workspace, this.directory];
    const evidence = [];
    try {
      for (const item of [...value.evidencePaths, value.verdictPath]) {
        const file = resolveInsideEither(roots, item, 'verification evidence');
        if (!fs.statSync(file).isFile()) throw Error(`Not a file: ${item}`);
        evidence.push(fileIdentity(this.root, file));
      }
      const verdictFile = resolveInsideEither(roots, value.verdictPath, 'verdictPath');
      const artifact = readJson(verdictFile);
      if (artifact.verdict !== value.verdict) throw Error('Verdict artifact disagrees with structured response');
      if (value.verdict === 'pass' && JSON.stringify(artifact.checks ?? {}) !== JSON.stringify(value.checks)) throw Error('PASS checks disagree with verdict artifact');
      if (value.verdict === 'pass' && value.commands.some(row => row.exitCode !== 0)) throw Error('PASS contains a non-zero command');
      return {...value, evidenceIdentities: evidence};
    } catch (error) {
      return {
        ...value,
        verdict: 'fail', failureKind: 'operating',
        summary: `Verification evidence could not be authenticated: ${error.message}`,
        failures: [...(value.failures ?? []), {code: 'VERIFICATION_EVIDENCE_INVALID', message: error.message}],
      };
    }
  }

  async run() {
    if (TERMINAL.has(this.state.status) && this.state.status !== 'stopped') return this.state;
    if (this.state.status === 'stopped') { this.state.status = 'running'; delete this.state.stoppedAt; }
    if (fs.existsSync(this.stopFile)) fs.unlinkSync(this.stopFile);
    const task = taskById(this.plan, this.state.taskId);
    while (!TERMINAL.has(this.state.status)) {
      if (this.stopped()) { this.state = stopState(this.state); this.save(); break; }
      try {
        if (this.state.phase === 'implement') {
          const report = this.reportDirectory('implementation');
          const response = await this.executeRole({roleName: 'implementer', prompt: implementationPrompt({task, workspace: this.state.workspace, state: this.state, config: this.config, root: this.root}), schema: IMPLEMENTATION_SCHEMA, reportDirectory: report});
          this.state.lastImplementation = {attempt: this.state.productAttempt, ...response};
          this.state = afterImplementation(this.state, response.value);
          this.save();
          continue;
        }
        if (this.state.phase === 'verify') {
          const report = this.reportDirectory('verification');
          const evidenceDirectory = path.join(this.state.workspace, '.prompt15-v2', 'verification', `attempt-${pad(this.state.productAttempt)}`);
          fs.mkdirSync(evidenceDirectory, {recursive: true});
          const response = await this.executeRole({roleName: 'verifier', prompt: verificationPrompt({task, workspace: this.state.workspace, implementation: this.state.lastImplementation.value, evidenceDirectory, config: this.config, root: this.root}), schema: VERIFICATION_SCHEMA, reportDirectory: report, evidenceDirectory});
          const verified = this.validateVerification(response.value);
          atomicJson(path.join(report, 'authenticated-verdict.json'), verified);
          this.state.lastVerification = {attempt: this.state.productAttempt, responseIdentity: response.responseIdentity, verdictIdentity: fileIdentity(this.root, path.join(report, 'authenticated-verdict.json')), value: verified};
          this.state = afterVerification(this.state, verified);
          this.save();
          continue;
        }
        throw Error(`Unknown phase: ${this.state.phase}`);
      } catch (error) {
        if (error.code === 'STOP_REQUESTED' || this.stopped()) this.state = stopState(this.state);
        else {
          const incidentFile = path.join(this.directory, 'incidents', `incident-${Date.now()}.json`);
          atomicJson(incidentFile, {version: 1, at: new Date().toISOString(), taskId: this.state.taskId, phase: this.state.phase, productAttempt: this.state.productAttempt, message: error.message, code: error.code ?? null});
          this.state = operatingFailure(this.state, error, fileIdentity(this.root, incidentFile));
        }
        this.save();
        this.event({kind: this.state.status, taskId: this.state.taskId, phase: this.state.phase, text: error.message});
      }
    }
    this.event({kind: 'run_finished', status: this.state.status, taskId: this.state.taskId, productAttempt: this.state.productAttempt});
    return this.state;
  }
}
