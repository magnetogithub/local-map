export const TERMINAL_STATUSES = ['stopped', 'standby'];
export const RUNTIME_VERSION = 12;

export function failureKind(error) {
  const message = error.message ?? String(error);
  if (/Manual baseline gate:/i.test(message)) return 'manual_gate';
  if (/Orchestration guardian hold:|Task assignment|Task PASS|whole REVIEW|Invalid REVIEW|Parallel write outside|Branch reported an unowned/i.test(message)) return 'orchestration';
  if (/Target binding:|Candidate unchanged after repair/i.test(message)) return 'handoff';
  if (/Supervisor requires (permission|user_decision|missing_external_input)/i.test(message)) return 'external_input';
  if (/flagged for possible cybersecurity risk|content.*flagged|safety.*(block|reject)|automatic approval.*reject/i.test(message)) return 'platform_rejection';
  if (/Turn timeout|timed out|timeout/i.test(message)) return 'timeout';
  if (/Stage input changed|Source changed during independent verification|Incomplete\/stale independent stage/i.test(message)) return 'evidence_changed';
  if (/Stage execution|Stage result|stage plan|stage context/i.test(message)) return 'verification_tool';
  return 'transport';
}

export function recordRuntimeFailure(state, error) {
  const kind = failureKind(error);
  state.executionFailure = {kind, reason: error.message, at: new Date().toISOString(), review: state.review, phase: state.phase,
    resumeCondition: kind === 'manual_gate' ? 'Prompt 14 수동 독립 PASS와 후보를 접수하고 사용자 재개 지시를 확인. 자동 실행 없음.' :
      kind === 'handoff' ? '후보·원본 배정·완료 보고의 연결을 수정. 동일 입력의 검증을 반복하지 않음.' :
      kind === 'external_input' ? '기록된 외부 결정·권한·입력을 확인한 뒤 명시적으로 재개.' :
      kind === 'platform_rejection' ? '실행 차단 조건을 해결한 뒤 명시적으로 재개. 동일 요청 자동 재시도 없음.' : kind === 'evidence_changed' ? '변경된 입력과 영향 범위를 확인하고 해당 단계를 다시 검증.' : '완료된 단계를 보존하고 미완료 실행부터 복구.'};
  return state.executionFailure;
}

export function classifyFailure(error, state, userStopped = false) {
  if (userStopped) return 'stopped';
  if (state.requiredUserInput || /Human input required:|Unauthorized|not authenticated|authentication required/i.test(error.message)) return 'waiting_input';
  if (['platform_rejection', 'evidence_changed', 'manual_gate', 'handoff','orchestration','verification_tool'].includes(failureKind(error))) return 'waiting_execution';
  return 'recovering';
}

export function recordReviewResult(state, verification, identity) {
  return recordVerificationResult(state, verification, identity, 'review');
}

export function recordTaskResult(state, verification, identity) {
  return recordVerificationResult(state, verification, identity, 'task');
}

function recordVerificationResult(state, verification, identity, kind) {
  state.reviewStrikes ??= {};
  state.countedVerifications ??= [];
  state.countedFailureAttempts ??= [];
  state.strikeCountingVersion = 2;
  const attempt = verification.failureAttemptKey ?? verification.taskId ?? verification.implementationTaskId;
  const attemptId = `${verification.review}:${attempt ? `implementation:${attempt}` : `verification:${identity}`}`;
  const nonPass = ['fail', 'blocked'].includes(verification.verdict);
  const implementationFailure = nonPass && verification.nonPassKind !== 'environment';
  if (state.countedVerifications.includes(identity)) {
    // Seed attempt deduplication for previously counted full-review reports.
    if (implementationFailure && !state.countedFailureAttempts.includes(attemptId)) state.countedFailureAttempts.push(attemptId);
    return;
  }
  state.countedVerifications.push(identity);
  const strikes = state.reviewStrikes[verification.review] ??= {totalFailures: 0, sinceStrategyChange: 0, strategyChanges: 0};
  let counted = false;
  if (verification.verdict === 'pass') {
    if (kind === 'review') strikes.sinceStrategyChange = 0;
  } else if (implementationFailure && !state.countedFailureAttempts.includes(attemptId)) {
    state.countedFailureAttempts.push(attemptId);
    strikes.totalFailures++;
    strikes.sinceStrategyChange++;
    counted = true;
  }
  state.strikeHistory ??= [];
  state.strikeHistory.push({review: verification.review, kind, verdict: verification.verdict, nonPassKind: nonPass ? verification.nonPassKind ?? 'implementation' : 'none', identity, attemptId, counted});
  return counted;
}

export function strategyInstruction(state, review) {
  const strikes = state.reviewStrikes?.[review];
  if (!strikes || strikes.sinceStrategyChange < 3) return '';
  return `3스트라이크: 동일 REVIEW ${review}에서 프롬프트 수행 검증 또는 REVIEW 전체 독립 검증이 현재 접근을 ${strikes.sinceStrategyChange}회 미통과로 판정했다. ` +
    '검증 문제가 지속되고 있으므로 실패 증거와 기존 시도의 한계를 충분히 검토하여 해결할 방법을 제대로 자세히 생각하라. ' +
    '같은 수정의 반복을 피하고 다른 구현 접근을 선택하여 그 근거, 수정 범위, 실행 순서, 재현 명령, 재검증 조건을 포함한 상세한 보완 프롬프트 repairPrompt를 작성하라. ' +
    '원본 Prompt 15, 정책 수치와 검증 기준은 수정하지 않는다. 외부 자료가 꼭 없을 때만 근거를 적어 대기하며, 3스트라이크 자체는 중단 이유가 아니다.';
}

export function recordStrategyChange(state, review, decision, responsePath) {
  const strikes = state.reviewStrikes?.[review];
  if (decision.action !== 'repair' || !strikes || strikes.sinceStrategyChange < 3) return;
  state.strategyHistory ??= [];
  state.strategyHistory.push({review, failedAttempts: strikes.sinceStrategyChange, responsePath, assignedAt: new Date().toISOString(), repairPrompt: decision.repairPrompt});
  strikes.strategyChanges++;
  strikes.sinceStrategyChange = 0;
}
