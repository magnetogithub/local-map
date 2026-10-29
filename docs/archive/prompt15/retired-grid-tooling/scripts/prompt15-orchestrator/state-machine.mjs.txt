export const TERMINAL = new Set(['passed', 'blocked', 'waiting_input', 'operating_failure', 'stopped']);

export function initialState({runId, taskId, workspace, maxProductAttempts}) {
  return {
    version: 1,
    engine: 'prompt15-simple-loop',
    runId,
    taskId,
    workspace,
    status: 'running',
    phase: 'implement',
    productAttempt: 1,
    maxProductAttempts,
    implementationTurns: 0,
    verificationTurns: 0,
    activeTurn: null,
    failures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
export function strictPassProof(taskId, verification) {
  const failures = [];
  const checks = verification.checks ?? {};
  if (verification.verdict !== 'pass') return failures;
  if (checks.positiveCandidate !== true) failures.push('PASS_PROOF_POSITIVE_CANDIDATE_REQUIRED');
  if (checks.independentCurrentBytes !== true) failures.push('PASS_PROOF_CURRENT_BYTES_REQUIRED');
  if (checks.commandExitCodesAllZero !== true) failures.push('PASS_PROOF_COMMAND_EXIT_REQUIRED');
  if (!Array.isArray(verification.commands) || verification.commands.length === 0) failures.push('PASS_PROOF_COMMANDS_REQUIRED');
  if (!Array.isArray(verification.evidencePaths) || verification.evidencePaths.length === 0) failures.push('PASS_PROOF_EVIDENCE_REQUIRED');
  if (taskId === '15-18') {
    if (checks.buildAllowed !== true) failures.push('V18_BUILD_ALLOWED_REQUIRED');
    if (checks.sourceCountSVN !== 193) failures.push('V18_SVN_SOURCE_193_REQUIRED');
    if (checks.tracedCountSVN !== 193) failures.push('V18_SVN_TRACED_193_REQUIRED');
    for (const key of ['missing', 'duplicate', 'unresolved']) if (checks[key] !== 0) failures.push(`V18_${key.toUpperCase()}_ZERO_REQUIRED`);
    if (checks.componentHoleCorrespondence !== true) failures.push('V18_COMPONENT_HOLE_REQUIRED');
    if (checks.protectedOverlayCorrespondence !== true) failures.push('V18_PROTECTED_OVERLAY_REQUIRED');
    if (checks.missingFixtureRejected !== true) failures.push('V18_MISSING_FIXTURE_REJECTION_REQUIRED');
    if (checks.unresolvedFixtureRejected !== true) failures.push('V18_UNRESOLVED_FIXTURE_REJECTION_REQUIRED');
  }
  return failures;
}

export function afterImplementation(state, implementation) {
  if (!['complete', 'blocked', 'external_input'].includes(implementation.status)) throw Error('Invalid implementation status');
  if (implementation.status === 'external_input') {
    return {...state, status: 'waiting_input', phase: 'implement', requiredInput: implementation.summary, activeTurn: null};
  }
  // A product BLOCKED response is evidence to verify, never an operating incident.
  return {...state, status: 'running', phase: 'verify', activeTurn: null};
}

export function afterVerification(state, verification) {
  if (!['pass', 'fail', 'blocked'].includes(verification.verdict)) throw Error('Invalid verification verdict');
  const proofFailures = strictPassProof(state.taskId, verification);
  if (proofFailures.length) verification = {
    ...verification,
    verdict: 'fail',
    failureKind: 'product',
    failures: [...(verification.failures ?? []), ...proofFailures.map(code => ({code, message: code}))],
    summary: `Verifier claimed PASS without the mandatory positive proof: ${proofFailures.join(', ')}`,
  };
  if (verification.verdict === 'pass') return {...state, status: 'passed', phase: 'done', activeTurn: null, passedAt: new Date().toISOString()};
  if (verification.failureKind === 'operating') return operatingFailure(
    {...state, phase: 'verify'},
    {message: verification.summary, code: 'VERIFICATION_OPERATING_FAILURE'},
    state.lastVerification?.verdictIdentity ?? null,
  );
  if (verification.failureKind === 'external') return {...state, status: 'waiting_input', phase: 'verify', activeTurn: null, requiredInput: verification.summary};
  const failures = [...state.failures, {attempt: state.productAttempt, verification}];
  if (state.productAttempt >= state.maxProductAttempts) {
    return {...state, status: 'blocked', phase: 'done', activeTurn: null, failures, blockedAt: new Date().toISOString()};
  }
  return {...state, status: 'running', phase: 'implement', productAttempt: state.productAttempt + 1, activeTurn: null, failures};
}

export function operatingFailure(state, error, incidentIdentity = null) {
  const resumePhase = state.phase;
  return {
    ...state,
    status: 'operating_failure',
    phase: 'operating_failure',
    activeTurn: null,
    operatingIncident: {
      at: new Date().toISOString(),
      message: error.message,
      code: error.code ?? null,
      identity: incidentIdentity,
      resumePhase,
    },
  };
}

export function acknowledgeOperatingFailure(state) {
  if (state.status !== 'operating_failure') throw Error('No operating failure to acknowledge');
  const resumePhase = state.operatingIncident?.resumePhase;
  if (!['implement', 'verify'].includes(resumePhase)) throw Error('Operating incident has no safe resume phase');
  return {
    ...state,
    status: 'stopped',
    phase: resumePhase,
    activeTurn: null,
    operatingIncident: {
      ...state.operatingIncident,
      acknowledgedAt: new Date().toISOString(),
    },
  };
}

export function acknowledgeInput(state) {
  if (state.status !== 'waiting_input') throw Error('No input request to acknowledge');
  if (!['implement', 'verify'].includes(state.phase)) throw Error('Input request has no safe resume phase');
  if (state.activeTurn !== null) throw Error('Input request still has an active turn');
  if (!Number.isInteger(state.productAttempt) || !Number.isInteger(state.maxProductAttempts)
    || state.productAttempt < 1 || state.productAttempt > state.maxProductAttempts) throw Error('Input request has an invalid product attempt');
  if (typeof state.requiredInput !== 'string' || !state.requiredInput.trim()) throw Error('Input request is empty');

  const source = state.phase === 'implement' ? state.lastImplementation : state.lastVerification;
  if (source?.attempt !== state.productAttempt || source.value?.summary !== state.requiredInput) throw Error('Input request does not match its saved response');
  if (state.phase === 'implement') {
    if (source.value.status !== 'external_input') throw Error('Implementation did not request external input');
  } else {
    if (source.value.failureKind !== 'external' || !['fail', 'blocked'].includes(source.value.verdict)) throw Error('Verification did not request external input');
    if (state.lastImplementation?.attempt !== state.productAttempt
      || !['complete', 'blocked'].includes(state.lastImplementation.value?.status)) throw Error('Verification input request has no implementation for this attempt');
  }

  const {requiredInput, ...resumed} = state;
  return {
    ...resumed,
    status: 'stopped',
    inputAcknowledgement: {
      at: new Date().toISOString(),
      phase: state.phase,
      attempt: state.productAttempt,
      requiredInput,
    },
  };
}

export function stopState(state) {
  return {...state, status: 'stopped', activeTurn: null, stoppedAt: new Date().toISOString()};
}
