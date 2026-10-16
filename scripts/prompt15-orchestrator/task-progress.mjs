import {productBlockNeedsResolution} from './operating-recovery.mjs';
// Display only: task receipts, verdicts, attempts and scheduling remain authoritative.
// A heartbeat is process liveness and never evidence of an active product turn.
export function taskNextAction(state){
  if(['manual_hold','stopped'].includes(state.status))return '사용자 정지·수동 보류 · 명시적 재개 대기';
  if(state.status==='standby')return 'REVIEW F 통과 후 사용자 지시 대기';
  if(state.status==='blocked'&&state.productBlockedHandoff)return productBlockNeedsResolution(state)?'내부 제품 차단 · 총괄이 원인과 다음 책임 작업 배정 중':'제품 BLOCKED 인계 완료 · 원본 응답·누락 산출물 근거 보존';

  const turns=Object.entries(state.activeTurns??{});
  const active=[];
  for(const [key,turn] of turns){
    const row=state.tasks?.[turn.taskId];
    if(key.startsWith('implementer-')&&row?.status==='running')active.push(`태스크 ${turn.taskId} 구현 중`);
    if(/^(?:verifier-|vitest-verifier-)/.test(key)&&row?.status==='verifying')active.push(`태스크 ${turn.taskId} 태스크 검증 중`);
    if(/^(?:vitest-)?review-verifier(?:-[A-F])?$/.test(key))active.push(`REVIEW ${turn.review??key.match(/-([A-F])$/)?.[1]??state.review} 리뷰 검증 중`);
  }
  const tests=[...Object.values(state.activeOperations??{}),state.activeOperation].filter(operation=>operation?.kind==='vitest');
  for(const operation of tests)active.push(`태스크 ${operation.taskId??(state.currentTasks??[]).join(', ')} 태스크 검증 중 (제어기 Vitest)`);
  if(active.length)return active.join(' · ');
  if(state.status==='waiting_input'||state.requiredUserInput)return '필수 외부 입력 대기 · 기존 제품 판정과 운영 증거 보존';

  const oversight={auditing:'총괄이 운영 감시를 독립 감사 중 · 제품 판정 보존',repair_pending:'총괄 운영 감사 완료 · 안전 지점에서 운영 수리 인계 대기',repair_applied_awaiting_product:'운영 수리 적용 · 새 태스크 검증 또는 PASS 확인 전 사건 유지',failed:'총괄 운영 감사 실패 · 원본 요청·native turn 확인 후 복구',escalation_exhausted:'총괄 운영 감사 복구 한도 도달 · 증거 보존·미해결 원인 확인 필요'}[state.supervisorOversight?.status];
  if(oversight)return oversight;
  if(state.status==='recovering')return '운영 장애 자동 복구 중 · 완료된 구현과 검사 결과 보존';
  if(state.status==='reloading_orchestration')return '운영 수리 검사 통과·제어기 재시작 후 미완료 단계 재개';
  if(['waiting_execution','waiting_input','blocked'].includes(state.status))return '운영 정지·보류: 감시 기록과 미완료 배정을 확인한 뒤 재개 대기';
  if(state.phase==='operating_repair')return '운영 코드 수리 세션이 제어 코드·회귀 검사 수행 중';

  const handoff=['implementation_handoff','verification_handoff'].includes(state.phase);
  const tasks=(state.currentTasks??[]).map(id=>{
    const label=`태스크 ${id}`;
    switch(state.tasks?.[id]?.status){
      case 'implemented':return `${label} 구현 완료·태스크 검증 인계 대기`;
      case 'verifying':return `${label} 태스크 검증 결과 확인 대기`;
      case 'verified':return `${label} 태스크 검증 완료·병합 인계 대기`;
      case 'running':return `${label} 구현 응답 확인·인계 대기`;
      case 'blocked':return `${label} 운영 차단 원인 확인 대기`;
      case 'repair':return `${label} 제품 수리 배정 대기`;
      case 'planning':return `${label} 배정 응답 확인 대기`;
      case 'assigned':return `${label} 구현 시작 대기`;
      default:return null;
    }
  }).filter(Boolean);
  if(tasks.length)return tasks.join(' · ')+(handoff?' · 운영 인계 점검':'');
  return state.nextAction;
}
