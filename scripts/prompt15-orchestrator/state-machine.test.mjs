import {describe, expect, test} from 'vitest';
import {afterImplementation, afterVerification, initialState, operatingFailure, stopState} from './state-machine.mjs';
import {IMPLEMENTATION_SCHEMA, VERIFICATION_SCHEMA} from './orchestrator.mjs';

const state = (taskId = '15-18') => initialState({runId: 'run', taskId, workspace: 'workspace', maxProductAttempts: 2});
const pass = taskId => ({
  verdict: 'pass', failureKind: null, summary: 'pass', commands: [{command: 'verify', exitCode: 0}], evidencePaths: ['v18.json'],
  checks: taskId === '15-18' ? {
    positiveCandidate: true, independentCurrentBytes: true, commandExitCodesAllZero: true, buildAllowed: true,
    sourceCountSVN: 193, tracedCountSVN: 193, missing: 0, duplicate: 0, unresolved: 0,
    componentHoleCorrespondence: true, protectedOverlayCorrespondence: true,
    missingFixtureRejected: true, unresolvedFixtureRejected: true,
  } : {positiveCandidate: true, independentCurrentBytes: true, commandExitCodesAllZero: true},
});

describe('minimal product loop', () => {
  test('structured output schemas satisfy strict required-property rules recursively', () => {
    const inspect = schema => {
      if (!schema || typeof schema !== 'object') return;
      if (schema.type === 'object' && schema.properties) {
        expect(new Set(schema.required ?? [])).toEqual(new Set(Object.keys(schema.properties)));
        for (const child of Object.values(schema.properties)) inspect(child);
      }
      if (schema.items) inspect(schema.items);
      for (const branch of schema.anyOf ?? []) inspect(branch);
      for (const branch of schema.oneOf ?? []) inspect(branch);
    };
    inspect(IMPLEMENTATION_SCHEMA);
    inspect(VERIFICATION_SCHEMA);
  });

  test('implementation BLOCKED goes to verification, never Guardian', () => {
    const next = afterImplementation(state(), {status: 'blocked', summary: 'unresolved geometry'});
    expect(next.phase).toBe('verify');
    expect(next.status).toBe('running');
    expect(next.operatingIncident).toBeUndefined();
  });

  test('product failure returns directly to a fresh implementation attempt', () => {
    const verifying = afterImplementation(state(), {status: 'complete', summary: 'candidate'});
    const next = afterVerification(verifying, {verdict: 'fail', failureKind: 'product', summary: 'V18 failed', failures: []});
    expect(next.phase).toBe('implement');
    expect(next.productAttempt).toBe(2);
    expect(next.failures).toHaveLength(1);
  });

  test('same product loop stops at its bounded attempt limit', () => {
    const current = {...state(), phase: 'verify', productAttempt: 2};
    const next = afterVerification(current, {verdict: 'fail', failureKind: 'product', summary: 'still fails', failures: []});
    expect(next.status).toBe('blocked');
  });

  test('generic PASS requires positive current-byte command evidence', () => {
    const next = afterVerification({...state('15-20'), phase: 'verify'}, {verdict: 'pass', commands: [], evidencePaths: [], checks: {}});
    expect(next.status).toBe('running');
    expect(next.failures[0].verification.failures.map(row => row.code)).toContain('PASS_PROOF_POSITIVE_CANDIDATE_REQUIRED');
  });

  test('15-18 PASS requires the complete V18 proof', () => {
    expect(afterVerification({...state(), phase: 'verify'}, pass('15-18')).status).toBe('passed');
    const invalid = pass('15-18');
    invalid.checks.unresolved = 1;
    expect(afterVerification({...state(), phase: 'verify'}, invalid).status).toBe('running');
  });

  test('only an operating failure enters operating_failure and it never auto-recovers', () => {
    const next = operatingFailure(state(), Object.assign(Error('process exited'), {code: 'TRANSPORT'}));
    expect(next.status).toBe('operating_failure');
    expect(next.phase).toBe('operating_failure');
    expect(stopState(next).status).toBe('stopped');
  });
});
