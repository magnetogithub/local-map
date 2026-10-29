import {describe, expect, test} from 'vitest';
import {acknowledgeInput, acknowledgeOperatingFailure, afterImplementation, afterVerification, initialState, operatingFailure, stopState} from './state-machine.mjs';
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
const waiting = phase => ({
  ...state(),
  status: 'waiting_input', phase, productAttempt: 2, requiredInput: 'Provide the missing source input',
  implementationTurns: 2, verificationTurns: 1,
  lastImplementation: {
    attempt: 2,
    value: phase === 'implement'
      ? {status: 'external_input', summary: 'Provide the missing source input'}
      : {status: 'complete', summary: 'preserved candidate'},
  },
  lastVerification: {
    attempt: phase === 'verify' ? 2 : 1,
    value: {verdict: 'fail', failureKind: 'external', summary: 'Provide the missing source input'},
  },
  failures: [{attempt: 1, verification: {verdict: 'fail', failureKind: 'product', summary: 'earlier product failure'}}],
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

  test.each(['fail', 'blocked'])('a verifier %s operating result resumes verification without consuming a product attempt', verdict => {
    const verification = {verdict, failureKind: 'operating', summary: 'verification runtime unavailable', failures: []};
    const current = {
      ...state(),
      phase: 'verify',
      productAttempt: 2,
      activeTurn: {role: 'verifier', turnId: 'verification-turn'},
      lastImplementation: {attempt: 2, value: {status: 'complete', summary: 'preserved candidate'}},
      lastVerification: {
        attempt: 2,
        verdictIdentity: {path: 'attempt-002/verification-turn-002/authenticated-verdict.json', sha256: 'verdict-hash', byteLength: 123},
        value: verification,
      },
      failures: [{attempt: 1, verification: {verdict: 'fail', failureKind: 'product', summary: 'earlier product failure'}}],
    };
    const original = structuredClone(current);

    const next = afterVerification(current, verification);

    expect(next.status).toBe('operating_failure');
    expect(next.phase).toBe('operating_failure');
    expect(next.activeTurn).toBeNull();
    expect(next.operatingIncident).toMatchObject({
      message: verification.summary,
      code: 'VERIFICATION_OPERATING_FAILURE',
      resumePhase: 'verify',
      identity: current.lastVerification.verdictIdentity,
    });
    expect(next.operatingIncident.acknowledgedAt).toBeUndefined();
    expect(next.productAttempt).toBe(current.productAttempt);
    expect(next.failures).toBe(current.failures);
    expect(next.lastImplementation).toBe(current.lastImplementation);
    expect(next.lastVerification).toBe(current.lastVerification);
    expect(current).toEqual(original);

    const resumed = acknowledgeOperatingFailure(next);

    expect(resumed.status).toBe('stopped');
    expect(resumed.phase).toBe('verify');
    expect(resumed.productAttempt).toBe(current.productAttempt);
    expect(resumed.failures).toBe(current.failures);
    expect(resumed.lastImplementation).toBe(current.lastImplementation);
    expect(resumed.lastVerification).toBe(current.lastVerification);
    expect(resumed.operatingIncident.identity).toEqual(current.lastVerification.verdictIdentity);
    expect(resumed.operatingIncident.acknowledgedAt).toBeTruthy();
    expect(next.operatingIncident.acknowledgedAt).toBeUndefined();
  });

  test.each(['implement', 'verify'])('an operating exception in %s requires acknowledgement and retains its resume phase', phase => {
    const current = {...state(), phase};
    const next = operatingFailure(current, Object.assign(Error('process exited'), {code: 'TRANSPORT'}));
    expect(next.status).toBe('operating_failure');
    expect(next.phase).toBe('operating_failure');
    expect(next.operatingIncident).toMatchObject({message: 'process exited', code: 'TRANSPORT', resumePhase: phase});
    expect(next.productAttempt).toBe(current.productAttempt);
    expect(next.operatingIncident.acknowledgedAt).toBeUndefined();
    expect(stopState(next).status).toBe('stopped');

    const resumed = acknowledgeOperatingFailure(next);
    expect(resumed.status).toBe('stopped');
    expect(resumed.phase).toBe(phase);
    expect(resumed.productAttempt).toBe(current.productAttempt);
    expect(resumed.operatingIncident.acknowledgedAt).toBeTruthy();
  });

  test.each(['implement', 'verify'])('acknowledged %s input resumes the saved phase and attempt without changing history', phase => {
    const current = waiting(phase);
    const original = structuredClone(current);

    const resumed = acknowledgeInput(current);

    expect(resumed.status).toBe('stopped');
    expect(resumed.phase).toBe(phase);
    expect(resumed.productAttempt).toBe(2);
    expect(resumed.activeTurn).toBeNull();
    expect(resumed).not.toHaveProperty('requiredInput');
    expect(resumed.inputAcknowledgement).toEqual({
      at: expect.any(String), phase, attempt: 2, requiredInput: current.requiredInput,
    });
    expect(new Date(resumed.inputAcknowledgement.at).toISOString()).toBe(resumed.inputAcknowledgement.at);
    expect(resumed.failures).toBe(current.failures);
    expect(resumed.lastImplementation).toBe(current.lastImplementation);
    expect(resumed.lastVerification).toBe(current.lastVerification);
    expect(resumed.implementationTurns).toBe(current.implementationTurns);
    expect(resumed.verificationTurns).toBe(current.verificationTurns);
    expect(current).toEqual(original);
    expect(() => acknowledgeInput(resumed)).toThrow('No input request');
  });

  test.each(['complete', 'blocked'])('verification input accepts its saved %s implementation', status => {
    const current = waiting('verify');
    current.lastImplementation.value.status = status;
    current.lastVerification.value.verdict = 'blocked';

    expect(acknowledgeInput(current)).toMatchObject({status: 'stopped', phase: 'verify', productAttempt: 2});
  });

  test.each([
    ['a different status', current => { current.status = 'operating_failure'; }],
    ['an unsafe phase', current => { current.phase = 'done'; }],
    ['an active turn', current => { current.activeTurn = {turnId: 'unfinished'}; }],
    ['attempt zero', current => { current.productAttempt = 0; }],
    ['an attempt past the limit', current => { current.productAttempt = 3; }],
    ['a fractional attempt', current => { current.productAttempt = 1.5; }],
    ['an invalid attempt limit', current => { current.maxProductAttempts = NaN; }],
    ['a missing request', current => { delete current.requiredInput; }],
    ['an empty request', current => { current.requiredInput = '  '; }],
  ])('input acknowledgement rejects %s without changing state', (_name, alterState) => {
    const current = waiting('verify');
    alterState(current);
    const original = structuredClone(current);

    expect(() => acknowledgeInput(current)).toThrow();
    expect(current).toEqual(original);
  });

  test.each(['implement', 'verify'])('%s input acknowledgement rejects an unrelated saved response', phase => {
    for (const alterSource of [
      source => { source.attempt = 1; },
      source => { source.value.summary = 'a different input request'; },
      source => { delete source.value; },
      source => { source.value = phase === 'implement' ? {status: 'complete', summary: 'Provide the missing source input'} : {verdict: 'fail', failureKind: 'product', summary: 'Provide the missing source input'}; },
    ]) {
      const current = waiting(phase);
      alterSource(phase === 'implement' ? current.lastImplementation : current.lastVerification);
      const original = structuredClone(current);

      expect(() => acknowledgeInput(current)).toThrow();
      expect(current).toEqual(original);
    }
  });

  test.each([
    ['a missing implementation', current => { delete current.lastImplementation; }],
    ['an earlier implementation', current => { current.lastImplementation.attempt = 1; }],
    ['an incomplete implementation', current => { current.lastImplementation.value.status = 'external_input'; }],
    ['a PASS verification', current => { current.lastVerification.value.verdict = 'pass'; }],
  ])('verification input acknowledgement rejects %s', (_name, alterState) => {
    const current = waiting('verify');
    alterState(current);
    const original = structuredClone(current);

    expect(() => acknowledgeInput(current)).toThrow();
    expect(current).toEqual(original);
  });
});
