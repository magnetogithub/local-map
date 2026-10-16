const roles = {supervisor: '총괄', implementer: '구현', verifier: '검증'};
const outcomes = {completed: '작업 종료', pass: 'PASS', fail: 'FAIL', blocked: '진행 제약 보고', repair: '보완 지시 작성', advance: '다음 단계 배정', wait: '대기 전환', reverify: '재검증 배정', verify_b: '선행 B 검증 배정'};

export function taskNotification(event, metadata = {}, finalText = '') {
  if (event.kind !== 'event' || event.method !== 'turn/completed' || !event.turnId) return null;
  let result;
  try { result = JSON.parse(finalText); } catch { result = {}; }
  const role = metadata.sessionName ?? (metadata.key?.startsWith('branch-') ? `[${metadata.key.slice(7)}] 구현` : roles[metadata.role] ?? 'Codex');
  const review = metadata.reportDirectory?.match(/\/(?:\d+)-([BCDEF])(?:[-/]|$)/)?.[1] ?? metadata.review;
  const outcome = event.status !== 'completed' ? event.status === 'failed' ? '실행 실패' : '중단됨' : outcomes[result.verdict ?? result.action ?? result.status] ?? '작업 종료';
  const summary = String(result.summary ?? '').replace(/\s+/g, ' ').slice(0, 180);
  const scopedTask = metadata.key?.startsWith('task-verifier-');
  return {
    id: `turn:${event.turnId}`, at: event.at,
    title: `Prompt 15 · ${role}${scopedTask ? ' 프롬프트 수행' : ''} ${outcome}`,
    body: `${review ? `REVIEW ${review} · ` : ''}${scopedTask ? '태스크 판정 (전체 REVIEW 판정과 별도) · ' : ''}${outcome}${summary ? `\n${summary}` : ''}`,
    role, review: review ?? null, outcome,
  };
}

function isPlannedModelRestart(event, change) {
  if (event.kind !== 'workflow_stopped' || event.status !== 'stopped') return false;
  const correctedTurn = change?.type === 'runtime_update' && change.checkpointCorrection?.turnId;
  if (event.reason !== 'Workflow stop requested' && (!correctedTurn || event.reason !== `Turn interrupted: ${correctedTurn}`)) return false;
  if (!change || !['pausing_at_task_boundary', 'resuming_with_high', 'resuming_runtime', 'applied'].includes(change.status)) return false;
  const stoppedAt = Date.parse(event.at);
  const requestedAt = Date.parse(change.stopRequestedAt ?? change.requestedAt);
  const resumedAt = Date.parse(change.resumedAt ?? (['resuming_with_high', 'resuming_runtime'].includes(change.status) ? change.updatedAt : ''));
  const deadline = Number.isFinite(resumedAt) ? resumedAt : change.status === 'pausing_at_task_boundary' ? requestedAt + 300000 : NaN;
  return Boolean(change.model && change.effort && Number.isFinite(stoppedAt) && stoppedAt >= requestedAt && stoppedAt <= deadline);
}

export function workflowNotification(event, modelChange = null) {
  if (event.kind === 'checkpoint_correction_applied' && event.origin === 'orchestration-control') return {
    id: `checkpoint-corrected:${event.at}`, at: event.at, title: 'Prompt 15 · B 배정 정정 완료',
    body: '새 [15-3] 구현 세션으로 B 보완을 배정했습니다. 기존 [15-4] 세션과 중간 산출물은 보존하며 C는 B 통과를 기다립니다.', role: '총괄', review: 'B', outcome: '배정 정정 완료',
  };
  if (event.kind === 'workflow_waiting') return {
    id: `waiting:${event.at}`, at: event.at, title: `Prompt 15 · ${event.status === 'recovering' ? '실행 도구 복구 중' : event.status === 'waiting_execution' ? '실행 장애 대기 · 작업 정지' : '확인 대기 · 운영 유지'}`,
    body: String(event.reason ?? event.status).slice(0, 230), role: '총괄', review: event.review ?? null, outcome: event.status,
  };
  if (event.kind === 'standby_after_review_f') return {
    id: `standby:${event.at}`, at: event.at, title: 'Prompt 15 · REVIEW F 통과',
    body: '후보 검증을 완료했습니다. 게시 없이 사용자 지시를 기다립니다.', role: '총괄', review: 'F', outcome: '대기',
  };
  const operatorChanges = modelChange?.operatorVerificationChanges;
  const transitionEnd = modelChange?.resumedAt;
  if (modelChange?.type === 'runtime_update' && event.kind === 'workflow_stopped' &&
    event.at >= modelChange.requestedAt && (!transitionEnd || event.at <= transitionEnd) &&
    event.reason?.startsWith('Source changed during independent verification') &&
    operatorChanges?.length && operatorChanges.every(name => ['scripts/prompt15-orchestrator/', 'automation/prompt15/', 'docs/automation/'].some(prefix => name.startsWith(prefix)))) return {
    id: `stopped:${event.at}`, at: event.at, title: 'Prompt 15 · 운영 규칙 일괄 적용 중',
    body: '운영 코드 변경으로 이전 검증의 승인을 보류했습니다. 보고를 보존하고 새 규칙으로 재개합니다.', role: '총괄', review: event.review ?? null, outcome: '운영 규칙 적용',
  };
  if (isPlannedModelRestart(event, modelChange)) return {
    id: `stopped:${event.at}`, at: event.at, title: modelChange.type === 'runtime_update' ? 'Prompt 15 · 운영 규칙 일괄 적용 중' : 'Prompt 15 · 모델 설정 적용 중',
    body: modelChange.checkpointCorrection ? '기존 대화와 미완료 산출물을 보존하고 총괄을 통해 15-3을 다시 배정합니다.' : modelChange.type === 'runtime_update' ? '완료 보고와 현재 리뷰 세션을 보존하고 새 운영 규칙으로 자동 재개합니다.' : `완료 보고를 보존하고 ${modelChange.model} / ${modelChange.effort} 설정으로 자동 재개합니다.`, role: '총괄', review: event.review ?? null, outcome: '운영 설정 적용',
  };
  if (event.kind === 'workflow_stopped') return {
    id: `stopped:${event.at}`, at: event.at, title: `Prompt 15 · ${event.status === 'blocked' ? '진행 차단' : '운영 중단'}`,
    body: String(event.reason ?? event.status).slice(0, 230), role: '총괄', review: event.review ?? null, outcome: event.status,
  };
  return null;
}

export function consumeEvent(event, checkpoint, modelChange = null) {
  checkpoint.tasks ??= {};
  checkpoint.finalMessages ??= {};
  checkpoint.seen ??= [];
  checkpoint.runtimeInterruptions ??= {};
  if (event.kind === 'workflow_waiting') {
    const timedThread = event.reason?.match(/^Turn timeout for ([^;]+);/)?.[1];
    if (timedThread) checkpoint.runtimeInterruptions[timedThread] = {at:event.at, kind:'timeout'};
  }
  if (event.kind === 'dispatch') {
    checkpoint.tasks[event.threadId] = event;
    delete checkpoint.finalMessages[event.threadId];
  }
  if (event.kind === 'agent_message' && event.phase !== 'commentary') checkpoint.finalMessages[event.threadId] = event.text;
  const notification = taskNotification(event, checkpoint.tasks[event.threadId], checkpoint.finalMessages[event.threadId]) ?? workflowNotification(event, modelChange);
  if (!notification || checkpoint.seen.includes(notification.id)) return null;
  if (event.method === 'turn/completed' && event.status === 'interrupted') {
    const timed = checkpoint.runtimeInterruptions[event.threadId];
    const role = checkpoint.tasks[event.threadId]?.role;
    const planned = modelChange?.checkpointCorrection?.turnId === event.turnId && isPlannedModelRestart({kind:'workflow_stopped', status:'stopped', at:event.at, reason:`Turn interrupted: ${event.turnId}`},modelChange);
    if (planned) {
      notification.title = `Prompt 15 · ${notification.role} 운영 규칙 적용`;
      notification.body = '사용자 지시 변경에 따라 태스크를 전환합니다. 기존 세션과 중간 산출물을 보존하여 재배정합니다.';
      notification.outcome = '운영 규칙 적용';
    } else if (role === 'implementer' && timed && Date.parse(event.at) - Date.parse(timed.at) >= 0 && Date.parse(event.at) - Date.parse(timed.at) < 300000) {
      notification.title = `Prompt 15 · ${notification.role} 시간 제한 · 이어가기`;
      notification.body = `REVIEW ${notification.review ?? ''} · 구현 태스크가 시간 제한에 도달했습니다. 완료로 판정하지 않고 저장된 코드·산출물에서 이어 구현하도록 자동 복구합니다.`;
      notification.outcome = '시간 제한 · 구현 이어가기';
    }
  }
  checkpoint.seen.push(notification.id);
  if (checkpoint.seen.length > 5000) checkpoint.seen.splice(0, checkpoint.seen.length - 5000);
  return notification;
}
