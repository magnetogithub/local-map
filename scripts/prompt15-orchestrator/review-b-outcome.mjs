import fs from 'node:fs';
import path from 'node:path';
import {inside, resolveInside, validateIdentities} from './protocol.mjs';

export function reviewBOutcome(root, directory, state, verification) {
  const file = path.join(directory, 'control/review-b-outcome-policy.json');
  if (!fs.existsSync(file)) return null;
  const policy = JSON.parse(fs.readFileSync(file, 'utf8')), job = state.lastVerificationJob;
  if (policy.version !== 1 || policy.origin !== 'user-instruction' || policy.review !== 'B' ||
    typeof policy.id !== 'string' || !policy.id.trim() || !Number.isInteger(policy.round) ||
    ![policy.jobId, policy.taskId, policy.verificationPath].every(value => typeof value === 'string' && value.trim())) throw Error('Invalid user B outcome policy');
  if (verification.review !== 'B' || state.review !== 'B' || job?.review !== 'B' || !job.completedAt ||
    job.jobId !== policy.jobId || job.taskId !== policy.taskId || job.round !== policy.round ||
    verification.implementationTaskId !== policy.taskId || job.verdict !== verification.verdict ||
    state.latestPrerequisiteVerification !== policy.verificationPath) return null;
  if (verification.verdict === 'pass') return {instructionId: policy.id, jobId: job.jobId, taskId: job.taskId, round: job.round,
    verdict: 'pass', action: 'continue-C-with-compact-verification', cleanupAuthorized: false,
    instructions: '현재 사용자의 결과 분기 지시: 이번 B는 독립 전체 PASS다. B의 승인 후보·정책·원본·인증·검증 증거를 보존하고 action=advance로 보관한 15-4/C 작업에 복귀한다. C부터 Node 내장 테스트/제한된 로그/공통 pin manifest/작은 fixture의 새 검증 방식을 사용한다. C의 두 독립 전 세계 생성 및 모든 원문 통과 조건은 유지한다. 이 PASS 분기에서는 B 중복 자료를 자동 삭제하거나 B를 재구현하지 않는다.'};
  if (verification.verdict !== 'fail' || verification.nonPassKind !== 'implementation') return null;
  const cleanupManifest = resolveInside(root, policy.cleanupManifest);
  if (!inside(path.join(root, 'reports/maintenance'), cleanupManifest)) throw Error('B cleanup assessment escapes authorized maintenance reports');
  if (policy.cleanupIdentity?.path !== policy.cleanupManifest) throw Error('B cleanup assessment lacks its authorized identity');
  validateIdentities(root, [policy.cleanupIdentity]);
  return {instructionId: policy.id, jobId: job.jobId, taskId: job.taskId, round: job.round,
    verdict: 'fail', action: 'compact-evidence-cleanup-and-selective-B-rebuild', cleanupAuthorized: true,
    cleanupManifest: policy.cleanupManifest,
    instructions: [
      '현재 사용자의 결과 분기 지시: 이번 B의 실제 구현 FAIL이 확정됐으므로 action=repair, repairReview=B, checkpoint=15-3으로 기존 기반 보존·선택적 재구현을 배정한다. 같은 구조에 revision wrapper를 계속 붙이는 보완을 반복하지 않는다.',
      'Prompt 14 게임/UI/atomic commit/history/undo/redo/국가 색상과 검증된 원본 data/public, r35 승인 기준, 현재 r38 canonical 후보, 필수 witness/state와 원래 FAIL 판정·명령·hash를 보존한다. 저장소 전체 삭제나 Prompt 14로 강제 reset하는 지시가 아니다.',
      `정리 대상은 ${cleanupManifest}의 명시된 중복 negative fixture·재생성 가능 캐시다. 먼저 실제 실패별 변경 파일·원본 참조·코드 snapshot·재현 명령을 작은 증거 묶음으로 보존하고, 새 실행 경로가 이전 복사본에 의존하지 않도록 정리한다. 그 뒤 관련 과거 실행/worker가 종료됐는지 확인하고 해당 대상만 삭제한다. 상위 rounds/후보/원본 폴더를 통째로 삭제하지 않는다.`,
      '재귀 삭제마다 resolved absolute path가 프로젝트 내부이고 명시 대상과 정확히 일치하는지 확인한다. reparse link의 대상은 따라 삭제하지 않는다. 삭제된 옛 payload는 별도 정리 기록에 경로·원래 크기·남긴 재현 자료·회수량을 기록하고, 원래 판정 보고서를 수정하거나 여전히 보존됐다고 주장하지 않는다.',
      '생성·선택·승인·소비 경로를 정리하여 동일한 독립 승인 source/정책과 중앙 판정으로 연결한다. 과다 점령·필수 역할 누락·정상 재pin한 binding ordinal/edge 좌우 변조를 작은 실제 소비 함수 회귀로 고정하고, 정상/변조 CLI 연결과 최종 전체 검증을 분리한다. 데이터 전체 복제와 전체 CLI의 사례별 반복은 금지한다.',
      '조사·소형 증거 보존·경로 의존성 해제·중복 정리·핵심 재구현·준비 검증·정리 결과 보고를 같은 전체 B 보완 배정 안에서 수행한다. 구현 결과는 총괄을 통한 독립 B 검증으로 전달한다. B 통과 전 C는 대기하며 원문 PASS 기준은 유지한다.',
    ].join('\n\n')};
}
