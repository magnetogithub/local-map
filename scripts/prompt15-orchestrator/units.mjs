import {GATES} from './protocol.mjs';
import {taskPlanInstructions} from './task-plan.mjs';

export function requireReviewCoverage(review, decision) {
  const gates = GATES[review];
  if (!gates || !Array.isArray(decision.repairCoverage) || new Set(decision.repairCoverage).size !== decision.repairCoverage.length ||
      gates.some(id => !decision.repairCoverage.includes(id))) throw Error(`Repair assignment must cover every REVIEW ${review} gate`);
}

export function reviewUnitInstructions(review) {
  return [
    `현재 실행기 호환 모드의 최종 반환: REVIEW ${review}. 목표 계획은 15-01~15-48 독립 태스크이며 독립 배정·검증·재개 스케줄러 전환이 별도로 필요하다. 필수 REVIEW 범위: ${GATES[review].join(', ')}.`,
    review === 'A' ? '15-1/15-2에서는 북한 큰 구역 점령과 슬로베니아 193→1 소실을 현재 bytes로 재현한다. 전체 fallback/gap 원인 audit, 승인 원본 identity 보존, 복구 후보와 미해결/rollout 차단 조건을 준비한다. B의 미세 분할 구현이나 전체 전 세계 생성은 아직 배정하지 않는다.' : '',
    '총괄은 REVIEW 전체 범위를 유지하되 task ID·선행 조건·산출물·완료 검사를 기준으로 작업을 구분한다. repairCoverage에는 모든 필수 gate id를 기록한다. 계획의 태스크를 빼거나 후속 리뷰를 선행 조건으로 추가하지 않는다.',
    '태스크 하나를 끝낼 때마다 실제 제품 작업본 안의 배정된 .reports/prompt15-tasks 경로에 작은 작업 기록을 저장하고 다음 의존 태스크로 이동한다. 원인 조사·정책·생성·측정을 하나의 무구분 작업으로 처리하지 않는다. 현재 컨트롤러의 최종 반환은 REVIEW 단위이며 태스크마다 별도 모델 세션/전체 독립 REVIEW를 새로 실행하지 않는다.',
    '태스크의 완료 검사는 명시한 Vitest/fast-check/CLI/Playwright 범위로 실행한다. 해당 범위의 첫 오류는 먼저 고치되 같은 입력·같은 방법을 무한 반복하지 않는다. 태스크마다 전 세계 생성·장시간 브라우저·전체 REVIEW를 반복하지 않는다. 현재 입력과 영향 범위가 같은 증거는 hash로 확인해 참조하고 변경된 의존 태스크의 증거만 무효화한다.',
    '진행 중 발견한 구현 오류는 현재 권한과 고정 명세 안에서 수정하고 재실행한다. 검증 결과를 보고 새 기준으로 바꾸거나 무한히 같은 방법을 반복하지 않는다. 결과에 따라 다른 합법적 대안을 검토할 수 있다.',
    '남은 필수 항목과 변경 영향이 모두 보완되고 해당 REVIEW 전체 독립 검증에 필요한 후보·실행기·새 증거가 준비된 뒤 completed로 보고한다. 구현자가 REVIEW 성공/실패를 판정하지 않는다.',
    '현재 권한으로 해결할 수 없는 외부 입력·권한 또는 고정 조건의 실제 양립 불가가 확인되면 막힌 task ID·완료/미완료·검토한 대안·정확한 근거를 blocked로 보고한다. 미실행 후속 태스크를 완료로 표시하지 않는다.',
    review === 'B' ? 'B 범위에는 AIA/LIE의 양의 face/sliver·예외, PRK 및 대표 국가의 실제 후속 진격과 보존, metadata/heap/decode/render 전체 비용 구조 보완, ID/provenance와 필수 24개국의 준비 검사가 모두 포함된다. 최소 재현과 비용 측정은 이 전체 구현 안에서 수행하고 필요한 구조 변경과 통합도 같은 배정에서 완료한다.' : '',
    '완료/blocked 보고는 총괄의 전달 후 독립 검증자에게 넘어간다. 검증자는 원본 보완 프롬프트와 해당 REVIEW 전체 기준을 한 번의 검증 작업에서 함께 판정한다. 부분 태스크 PASS를 전체 REVIEW PASS로 확대하지 않는다.',
    '원문 정책·고정 경계·identity·cap·오차·예산·승인 자산·과거 실패 증거는 보존한다. 후속 checkpoint, 운영 도구 수정, 게시·cutover·Prompt 16은 배정하지 않는다.',
    taskPlanInstructions(review),
  ].filter(Boolean).join('\n\n');
}
