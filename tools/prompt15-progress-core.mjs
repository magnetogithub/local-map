export function operationView(state, config = {}) {
  if(config.executionMode !== 'manual-prompt14')return state;
  return {...state,status:'manual_hold',phase:'manual_baseline',activeRole:null,baselinePending:true,
    executionFailure:null,error:null,nextAction:'Prompt 14 수동 독립 결과 접수 전 자동 실행 정지'};
}

export function reviewActivity(state, activity) {
  if(state.status==='manual_hold')return '자동 실행 정지';
  if (state.status === 'waiting_execution') return '실행 장애 대기 · 검증 정지';
  if (['waiting_recovery', 'waiting_input', 'recovering', 'stopped', 'blocked'].includes(state.status)) return '대기 · 작업 정지';
  return activity[state.phase] ?? '대기';
}

export function executionProgress(state, stageProgress = null) {
  const lines = [];
  if (state.activeVerification) {
    lines.push(`리뷰 검증 배정: 동일 REVIEW ${state.activeVerification.review} · 재개 ${Math.max(0, state.activeVerification.attempt - 1)}회 · 기존 증거 유지`);
    if (stageProgress) {
      lines.push(`리뷰 검증 단계 완료 기록: ${stageProgress.completed}/${stageProgress.total} · 재사용 전 입력·출력 hash 대조`);
      const pending = stageProgress.stages.filter(stage => stage.status !== 'completed');
      lines.push(`남은 단계: ${pending.map(stage => `${stage.id} [${stage.status}]`).join(' · ') || '최종 리뷰 검증 판정 대기'}`);
    } else lines.push('리뷰 검증 단계: 기존 증거의 재사용 적격성 확인 및 단계 계획 등록 대기');
  }
  if (state.executionFailure) lines.push(`실행 장애: ${state.executionFailure.kind}`, `재개 조건: ${state.executionFailure.resumeCondition}`);
  if (state.status !== 'running') lines.push('heartbeat는 운영 프로세스 생존 표시이며 작업 실행을 뜻하지 않습니다.');
  return lines;
}
