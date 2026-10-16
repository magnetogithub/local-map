import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const REVIEWS = ['C', 'D', 'E', 'F'];
export const REPAIR_REVIEWS = ['A', 'B', ...REVIEWS];
export const CHECKPOINTS = {A: ['15-1', '15-2'], B: ['15-3'], C: ['15-4'], D: ['15-5', '15-6'], E: ['15-7'], F: ['15-8']};
export const GATES = {
  A: ['baseline_reproduction', 'source_identity_preservation', 'administrative_loss_audit', 'restoration_candidates', 'rollout_blockers'],
  B: ['physical_resolution', 'near_extent_policy', 'generation_budget', 'identity_provenance_policy', 'representative_country_experiments'],
  C: ['administrative_identity', 'world_geometry', 'world_topology_membership', 'delivery', 'independent_generation'],
  D: ['bounded_lookup', 'strict_submit_scope', 'commit_cap', 'migration_atomicity', 'both_branches'],
  E: ['partial_occupation', 'continued_frontier', 'liberation_transfer_history', 'map_regressions'],
  F: ['whole_world', 'api', 'browser', 'performance', 'regressions_negative_cases', 'cutover_candidate_recovery'],
};

const str = {type: 'string'};
const strings = {type: 'array', items: str};
const object = properties => ({type: 'object', properties, required: Object.keys(properties), additionalProperties: false});
const enumeration = values => ({type: 'string', enum: values});
const identitySchema = object({path: str, sha256: str, byteLength: {type: 'integer'}});
export const VERIFICATION_SCHEMA = object({
  review: enumeration(REPAIR_REVIEWS), verdict: enumeration(['pass', 'fail', 'blocked']), summary: str,
  nonPassKind: enumeration(['none', 'implementation', 'environment']),
  checks: {type: 'array', items: object({id: str, status: enumeration(['pass', 'fail', 'blocked']), evidencePaths: strings, detail: str})},
  evidence: {type: 'array', items: identitySchema},
  inputs: {type: 'array', items: identitySchema},
  commands: {type: 'array', items: object({command: str, exitCode: {type: ['integer', 'null']}, evidencePath: str})},
  failures: strings, suggestedRepairPrompt: str,
});
export const SUPERVISION_SCHEMA = object({
  review: enumeration(REPAIR_REVIEWS), action: enumeration(['repair', 'advance', 'wait', 'blocked']),
  repairReview: enumeration(REPAIR_REVIEWS), summary: str, repairPrompt: str, repairCoverage: strings,
  branchPlans: {type: 'array', items: object({checkpoint: enumeration(['15-5', '15-6']), instructions: str, writablePaths: strings})},
  blockerKind: enumeration(['none', 'user_decision', 'permission', 'missing_external_input']), blockerEvidence: str,
});
export const PROMPT14_GATES = ['typecheck', 'production_build', 'handler_contracts', 'catalog_identity', 'browser_regressions'];
export const PROMPT14_VERIFICATION_SCHEMA = object({...VERIFICATION_SCHEMA.properties, review: enumeration(['prompt14'])});
export const PROMPT14_SUPERVISION_SCHEMA = object({action: enumeration(['repair', 'blocked']), summary: str, repairPrompt: str,
  blockerKind: enumeration(['none', 'user_decision', 'permission', 'missing_external_input']), blockerEvidence: str});
export const IMPLEMENTATION_SCHEMA = object({
  status: enumeration(['completed', 'blocked']), summary: str, changedFiles: strings,
  artifactPaths: strings, commands: strings, remainingIssues: strings,
});
export const BOUND_IMPLEMENTATION_SCHEMA = object({...IMPLEMENTATION_SCHEMA.properties, candidateRoot: str, inputManifestPath: str});
export const BOUND_VERIFICATION_SCHEMA = object({...VERIFICATION_SCHEMA.properties, candidateRoot: str, targetId: str});
export const TASK_GATES = ['prompt_instructions', 'scope_preservation', 'execution_evidence'];
export const TASK_RELAY_SCHEMA = object({
  review: enumeration(REPAIR_REVIEWS), taskId: str, verificationPrompt: str,
});
export const TASK_VERIFICATION_SCHEMA = object({
  ...VERIFICATION_SCHEMA.properties,
  taskId: str, readyForReview: {type: 'boolean'},
});
export const BOUND_TASK_VERIFICATION_SCHEMA = object({...TASK_VERIFICATION_SCHEMA.properties, candidateRoot: str, targetId: str});
export const IMPLEMENTATION_HANDOFF_SCHEMA = object({
  action: enumeration(['repair', 'reverify', 'verify_b', 'blocked']),
  repairReview: enumeration(REPAIR_REVIEWS), summary: str, repairPrompt: str, verificationPrompt: str, repairCoverage: strings,
  blockerKind: enumeration(['none', 'user_decision', 'permission', 'missing_external_input']), blockerEvidence: str,
});

export function validateImplementationHandoff(review, decision) {
  if (!REPAIR_REVIEWS.includes(review) || !['repair', 'reverify', 'verify_b', 'blocked'].includes(decision.action) || !REPAIR_REVIEWS.includes(decision.repairReview)) throw Error('Invalid implementation handoff decision');
  if (REPAIR_REVIEWS.indexOf(decision.repairReview) > REPAIR_REVIEWS.indexOf(review)) throw Error('Implementation handoff cannot skip a review');
  if (decision.action === 'repair' && !decision.repairPrompt.trim()) throw Error('Implementation handoff needs a concrete repair prompt');
  if (decision.action === 'verify_b' && !decision.verificationPrompt.trim()) throw Error('REVIEW B handoff needs an independent verification assignment');
  if (decision.action === 'blocked' && (!['user_decision', 'permission', 'missing_external_input'].includes(decision.blockerKind) || !decision.blockerEvidence.trim())) throw Error('Only an evidenced external blocker can stop the workflow');
  if (decision.action !== 'blocked' && decision.blockerKind !== 'none') throw Error('Continuing handoff must not claim an external blocker');
  return decision;
}

export function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

export function resolveInside(root, relative) {
  if (typeof relative !== 'string' || !relative.trim()) throw Error('Empty evidence path');
  const file = path.resolve(root, relative);
  if (!inside(path.resolve(root), file)) throw Error(`Path escapes project: ${relative}`);
  // Real paths prevent evidence links from escaping the repository.
  if (fs.existsSync(file) && !inside(fs.realpathSync(root), fs.realpathSync(file))) throw Error(`Symlink escapes project: ${relative}`);
  return file;
}

export function fileIdentity(root, relative) {
  const file = resolveInside(root, relative);
  if (!fs.statSync(file).isFile()) throw Error(`Evidence is not a file: ${relative}`);
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return {path: path.relative(root, file).replaceAll('\\', '/'), sha256: hash.digest('hex'), byteLength: fs.statSync(file).size};
}

export function validateIdentities(root, identities) {
  if (!Array.isArray(identities)) throw Error('Evidence must be an array');
  for (const item of identities) {
    const actual = fileIdentity(root, item.path);
    if (actual.sha256 !== item.sha256 || actual.byteLength !== item.byteLength) throw Error(`Evidence bytes changed: ${item.path}`);
  }
}

// Agents work in a dedicated report cwd. Accept both project-relative and
// report-relative references, and store only unambiguous project-relative paths.
export function normalizeVerification(root, reportDirectory, result) {
  const normalized = structuredClone(result);
  const aliases = new Map();
  const normalize = (name, preferReport = true) => {
    if (aliases.has(name)) return aliases.get(name);
    const candidates = path.isAbsolute(name) ? [name] : preferReport
      ? [path.resolve(reportDirectory, name), path.resolve(root, name)]
      : [path.resolve(root, name), path.resolve(reportDirectory, name)];
    const existing = candidates.find(file => inside(root, file) && fs.existsSync(file));
    if (!existing) throw Error(`Evidence file not found within project: ${name}`);
    return path.relative(root, resolveInside(root, existing)).replaceAll('\\', '/');
  };
  normalized.evidence = normalized.evidence.map(item => {
    const canonical = normalize(item.path);
    aliases.set(item.path, canonical);
    return {...item, path: canonical};
  });
  normalized.inputs = normalized.inputs.map(item => ({...item, path: normalize(item.path, false)}));
  normalized.checks = normalized.checks.map(check => ({...check, evidencePaths: check.evidencePaths.map(name => normalize(name))}));
  normalized.commands = normalized.commands.map(command => ({...command, evidencePath: normalize(command.evidencePath)}));
  return normalized;
}

export function validateVerification(root, reportDirectory, review, result, requiredGates = GATES[review]) {
  if (result.review !== review || !['pass', 'fail', 'blocked'].includes(result.verdict)) throw Error('Invalid review identity/verdict');
  const nonPassKind = result.nonPassKind ?? (result.verdict === 'pass' ? 'none' : 'implementation');
  if (!['none', 'implementation', 'environment'].includes(nonPassKind) || (result.verdict === 'pass') !== (nonPassKind === 'none')) throw Error('Invalid verification non-pass classification');
  if (!Array.isArray(result.checks) || !Array.isArray(result.failures) || !Array.isArray(result.commands)) throw Error('Incomplete verification response');
  validateIdentities(root, result.evidence);
  validateIdentities(root, result.inputs);
  const evidence = new Map(result.evidence.map(item => [fileIdentity(root, item.path).path, item]));
  const checks = new Map();
  for (const check of result.checks) {
    if (checks.has(check.id)) throw Error(`Duplicate gate: ${check.id}`);
    if (!['pass', 'fail', 'blocked'].includes(check.status)) throw Error('Invalid gate status');
    checks.set(check.id, check);
    for (const name of check.evidencePaths) {
      const relative = path.relative(root, resolveInside(root, name)).replaceAll('\\', '/');
      if (!evidence.has(relative)) throw Error(`Gate evidence is not attested: ${name}`);
    }
  }
  for (const id of requiredGates) if (!checks.has(id)) throw Error(`Missing required gate: ${id}`);
  if (result.verdict === 'pass') {
    if (!result.inputs.length || !result.commands.length || result.failures.length) throw Error('PASS needs actual inputs, executed checks, and zero failures');
    for (const check of checks.values()) {
      if (check.status !== 'pass' || !check.evidencePaths.length) throw Error(`Non-passing or unsupported gate: ${check.id}`);
      if (!check.evidencePaths.some(name => inside(reportDirectory, resolveInside(root, name)))) throw Error(`Gate needs fresh evidence in this verification: ${check.id}`);
    }
    for (const command of result.commands) {
      if (command.exitCode !== 0) throw Error(`Unsuccessful command in PASS: ${command.command}`);
      const relative = path.relative(root, resolveInside(root, command.evidencePath)).replaceAll('\\', '/');
      if (!evidence.has(relative) || !inside(reportDirectory, resolveInside(root, relative))) throw Error('Command needs fresh attested execution evidence');
    }
  } else if (!result.failures.length) throw Error('Failed/blocked review must explain its failures');
  return result;
}

export function validateTaskVerification(root, reportDirectory, review, taskId, result) {
  if (result.taskId !== taskId || typeof result.readyForReview !== 'boolean') throw Error('Invalid task verification identity');
  if (result.readyForReview && result.verdict !== 'pass') throw Error('An unsuccessful task cannot be ready for full review');
  return validateVerification(root, reportDirectory, review, result, TASK_GATES);
}

export function validateDecision(review, verification, decision) {
  if (!REPAIR_REVIEWS.includes(review) || decision.review !== review || !REPAIR_REVIEWS.includes(decision.repairReview)) throw Error('Invalid supervisor review');
  if (REPAIR_REVIEWS.indexOf(decision.repairReview) > REPAIR_REVIEWS.indexOf(review)) throw Error('Cannot skip forward to repair a later review');
  if (decision.action === 'blocked') {
    if (!['user_decision', 'permission', 'missing_external_input'].includes(decision.blockerKind) || !decision.blockerEvidence?.trim()) throw Error('Waiting needs an evidenced external condition; internal review failure must be repaired');
    return decision;
  }
  if (verification.verdict === 'pass') {
    if (decision.action !== (review === 'F' ? 'wait' : 'advance')) throw Error('Supervisor cannot override a passed gate or dispatch past F');
  } else {
    if (decision.action !== 'repair' || !decision.repairPrompt.trim()) throw Error('Failed gate must return a concrete repair prompt');
  }
  return decision;
}

function overlaps(a, b) {
  const left = a.replaceAll('\\', '/').replace(/\/+$/, '');
  const right = b.replaceAll('\\', '/').replace(/\/+$/, '');
  const l = process.platform === 'win32' ? left.toLowerCase() : left;
  const r = process.platform === 'win32' ? right.toLowerCase() : right;
  return l === r || l.startsWith(`${r}/`) || r.startsWith(`${l}/`);
}

export function validateBranchPlans(root, plans) {
  if (plans.length !== 2 || plans.map(p => p.checkpoint).sort().join(',') !== '15-5,15-6') throw Error('C advance requires both 15-5 and 15-6 plans');
  for (const plan of plans) {
    if (!plan.instructions.trim() || !plan.writablePaths.length) throw Error('Parallel branch needs instructions and explicit file ownership');
    for (const name of plan.writablePaths) {
      resolveInside(root, name);
      if (path.isAbsolute(name) || name.includes('*') || name.replaceAll('\\', '/').split('/').some(p => p === '.' || p === '..')) throw Error('Use project-relative literal ownership paths');
      if (['.git', 'node_modules', 'automation', 'prompts', 'docs/automation', 'scripts/prompt15-orchestrator'].some(p => overlaps(p, name))) throw Error(`Reserved parallel path: ${name}`);
    }
  }
  for (const a of plans[0].writablePaths) for (const b of plans[1].writablePaths) if (overlaps(a, b)) throw Error(`Parallel file ownership overlaps: ${a} / ${b}`);
  return plans;
}

export function sourceSnapshot(root) {
  const files = new Map();
  const visit = relative => {
    const name = path.join(root, relative);
    if (!fs.existsSync(name)) return;
    if (fs.lstatSync(name).isSymbolicLink()) throw Error(`Unexpected source link: ${relative}`);
    if (fs.statSync(name).isDirectory()) {
      for (const child of fs.readdirSync(name).sort()) visit(path.join(relative, child));
    } else files.set(relative.replaceAll('\\', '/'), fileIdentity(root, relative).sha256);
  };
  for (const folder of ['src', 'scripts', 'prompts', 'docs', 'automation']) visit(folder);
  for (const entry of fs.readdirSync(root)) if (/^(package.*\.json|.*config\.[cm]?[jt]s|AGENTS\.md|CLAUDE\.md)$/.test(entry)) visit(entry);
  return Object.fromEntries(files);
}

export function changedPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(name => before[name] !== after[name]).sort();
}

export function owns(plan, name) { return plan.writablePaths.some(prefix => overlaps(prefix, name) && (name === prefix || name.replaceAll('\\', '/').startsWith(`${prefix.replaceAll('\\', '/').replace(/\/+$/, '')}/`))); }

export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  // Windows readers and indexing can briefly lock a destination. Preserve the
  // complete old JSON and retry replacement, rather than truncating a live state.
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(temporary, file); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 6) throw error;
      Atomics.wait(pause, 0, 0, 15 * (attempt + 1));
    }
  }
}
