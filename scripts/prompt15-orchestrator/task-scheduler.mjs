import {disjointAssignments, readyTasks} from './task-protocol.mjs';

const unfinishedStatuses = new Set(['planning', 'assigned', 'running', 'implemented', 'verifying', 'verified']);
const defaultExclusiveTaskIds = ['15-06', '15-47'];

function validLimit(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(4, value) : null;
}

// Invalid configuration never becomes an unbounded fan-out or zero-worker stall.
export function concurrencyLimit(config = {}, plan = {}) {
  return validLimit(config?.maxConcurrentTasks)
    ?? validLimit(plan?.parallelPolicy?.maxConcurrentTasks)
    ?? 4;
}

// Keep an in-flight legacy session intact. New tasks have their own history;
// retries of that task resolve to the same identity instead of another lane.
export function implementationSessionKey(taskId, existingKey) {
  if (typeof existingKey === 'string' && existingKey.trim()) return existingKey;
  if (!/^15-\d{2}$/.test(taskId)) throw Error('Invalid task implementation session identity');
  return `implementer-${taskId}`;
}

function scopeOf(task, state, assignmentFor) {
  const assignment = state.tasks[task.id]?.assignment ?? assignmentFor?.(task);
  if (!Array.isArray(assignment?.writablePaths)
    || assignment.writablePaths.some(name => typeof name !== 'string' || !name)) return null;
  return assignment;
}

/**
 * Return a deterministic admission batch without changing task state.
 * Existing work goes first, with the original assignment retaining authority.
 * Missing scope is conservative: that task can run alone, never concurrently.
 */
export function selectTaskBatch(plan, state, review, {limit = 4, assignmentFor, activeTaskIds = []} = {}) {
  const maximum = validLimit(limit) ?? 4;
  const checkpoints = new Map(plan.checkpoints.map(checkpoint => [checkpoint.id, checkpoint]));
  const eligible = task => {
    const checkpoint = checkpoints.get(task.checkpoint);
    return checkpoint?.review === review
      && (checkpoint.requiresReviews ?? []).every(id => state.certificates?.[id])
      && task.dependsOn.every(id => state.tasks[id]?.status === 'pass');
  };
  const unfinished = plan.tasks.filter(task => eligible(task) && unfinishedStatuses.has(state.tasks[task.id]?.status));
  const ready = readyTasks(plan, state, review).filter(eligible);
  const exclusive = new Set([...defaultExclusiveTaskIds, ...(plan.parallelPolicy?.exclusiveTaskIds ?? [])]);
  const active = new Set(activeTaskIds);
  const selected = plan.tasks.filter(task => active.has(task.id));
  if (selected.length !== active.size || selected.length > maximum) throw Error('Invalid active task admission');
  const scopes = selected.map(task => scopeOf(task, state, assignmentFor));
  if (selected.length === maximum || selected.some(task => exclusive.has(task.id))) return selected;
  for (const task of [...unfinished, ...ready]) {
    if (active.has(task.id)) continue;
    const session=state.tasks[task.id]?.implementationKey;
    if(session&&selected.some(other=>state.tasks[other.id]?.implementationKey===session))continue;
    // An exclusive task is a fair admission barrier; do not keep filling slots
    // with later tasks while this earlier task waits to run on its own.
    if (exclusive.has(task.id)) {
      if (!selected.length) selected.push(task);
      break;
    }
    const scope = scopeOf(task, state, assignmentFor);
    if (selected.length && (!scope || scopes.some(other => !other || !disjointAssignments(scope, other)))) continue;
    selected.push(task);
    scopes.push(scope);
    if (selected.length === maximum) break;
  }
  return selected;
}
