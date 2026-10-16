# Prompt15 태스크 실행기 v15

현재 기본값은 `taskVerificationMode: controller-vitest`다. 48개 태스크와 원문 요구사항, 의존성, REVIEW A~F gate는 유지한다. 정상 태스크의 총괄 배정·중계·별도 검증 AI·모델 운영 감사 호출을 제거한다. 고정 계약을 제어기가 배정하고 구현 모델 한 번의 완료 응답 뒤 **태스크 검증**으로 제어기가 실제 Vitest를 실행한다. A~F의 독립 통합 판단은 **리뷰 검증**이며, 해당 REVIEW의 모든 태스크 PASS 뒤 별도 세션이 수행한다. 최종 승인은 총괄이 맡는다. 아래의 과거 독립 태스크 검증 세션·stage journal 설명은 호환 실행 경로에만 적용한다.

48개 독립 태스크의 실제 실행기는 `task-workflow.mjs`다. `implementationUnit: task`에서만 선택된다. 기존 REVIEW 실행기는 과거 기록/회귀검사 용도로 유지한다. 제품 요구사항과 REVIEW A~F의 gate는 원문 그대로다.

```text
수동 Prompt14 전체 PASS + 후보 bytes 확인
                    ↓
제어기 상태 점검 (운영 장애 때 감시·수리 호출)
                    ↓
태스크 고정 계약 → 구현 후보 → 태스크 검증 (제어기 Vitest 1회)
                                                ├─ PASS → 후보 병합 → 의존 작업 해제
                                                ├─ FAIL → 같은 태스크 수리
                                                └─ 운영 장애 → 결과 보존·자동 수리·중단 지점 재개
                    ↓
의존성 PASS 태스크 선택 (최대 4개, 모든 쌍의 쓰기 소유권 비중복)
                    ↓
각 REVIEW의 모든 태스크 PASS → 리뷰 검증 (독립 세션) → 총괄 승인
                    ↓
REVIEW F PASS → 사용자 지시 대기
```

실제 복사된 태스크 후보에서만 구현/검증한다. 승인된 baseline과 통과한 태스크 후보는 보존한다. 실행기는 의존성 PASS, 모든 쌍의 writablePaths 비중복, 단독 실행 조건을 만족하는 작업을 최대 4개 선택한다. 이는 실행 상한이며 의존성이나 소유권이 겹치면 1~3개만 실행한다. 병렬 후보의 변경은 사전 파일 소유권·기준 hash를 대조하여 REVIEW 통합 복사본에 병합한다. 15-06, 15-47은 단독 실행한다. D의 15-30/15-35 양쪽 PASS 전에는 전체 D를 시작하지 않는다. 구현의 원본 request와 확정 response는 태스크 검증·리뷰 검증까지 계속 연결한다.

총괄과 운영 감시는 고정 세션이다. 구현은 태스크마다 새 세션(`implementer-15-XX`)을 만들고 같은 태스크의 수리에는 재사용한다. 태스크 간 세션 재사용이 구현 능력을 유지한다는 근거가 없으므로 서로 다른 후보·요구사항·실패 이력의 혼입을 줄이는 방식으로 정한다. 이미 시작한 기존 `implementer-N` 세션은 정확한 native 요청 복구를 위해 유지한다. 검증 세션은 배정한 태스크 또는 리뷰의 PASS까지 유지하며, controller-vitest 모드에는 별도 태스크 검증 AI 세션이 없다. 운영 코드 수리 세션은 사건별로 생성한다.

정상 startup·배정·인계는 제어기가 점검한다. 운영 감시 모델은 장애 및 REVIEW 승인 경계에서 호출한다. 제품 heartbeat, 실제 제품 작업 시각, 감시 활동 시각은 별개로 기록한다. 감시자는 허용된 운영 코드와 규칙을 격리된 mirror에서 고칠 수 있다. 실제 검사·허용 diff·동시변경 확인 뒤 fresh controller로 재시작한다. 제품 코드·명세·계획·gate·상태/판정은 수정할 수 없다. 자세한 권한은 `prompt15-guardian.md`에 있다.

총괄은 운영 감시를 독립적으로 감사한다. 외부 runtime은 제어기와 별개로 실제 제품 작업 정체 5분, 같은 원인의 운영 감시 판단 3회 반복, 명시적 실행 deadline 초과를 감지해 감사 요청을 남긴다. heartbeat·운영 메시지·phase 변경은 제품 정체 시계를 초기화하지 않는다. 유효한 deadline 안의 장시간 제품 실행, 명시적 사용자 정지·standby, 실제 외부 인증/승인 대기는 자동 중단하지 않는다.

새 총괄 감사의 증거 경로는 제어기가 확인한 불변 파일 목록으로 제한한다. 감사 시작 시 저장한 schema와 원래 요청의 hash를 복구 시에도 대조한다. 계속 변하는 `state.json`이나 모델이 만들어 낸 경로를 수리 권한의 증거로 쓰지 않는다.

감사는 고정 총괄 세션의 읽기 전용 작업이다. 운영 감시의 승인을 다시 기다리지 않고 원본 요청·응답, 정확한 native thread/turn, 현재 수리 소유권을 대조해 계속 실행·운영 조정·수리 인계를 결정한다. 필요한 운영 turn은 중단과 terminal 상태를 확인하고 기존 증거를 보존한 뒤 제어기의 단일 수리 소유권으로 넘긴다. 제어기가 감사 요청에도 응답하지 않으면 runtime이 자신이 시작한 제어기만 복구하며 미확정 native 요청을 먼저 대조한다. 감사와 수리는 별도 deadline을 가지며 같은 원인 반복을 영구 대기로 처리하지 않는다. 총괄 감사는 제품 PASS를 부여하거나 frozen 검사·contract·기능 요구사항·gate·승인 정책을 완화할 권한이 없다.

태스크별 request/dispatch/확정 response, 후보 manifest, Vitest 결과와 verdict를 `tasks/<taskId>/attempt-NNN`에 저장한다. stage journal은 전체 REVIEW 및 과거 호환 검증에 사용한다. 미확정 dispatch는 정확한 thread/read로 실제 turn을 조회한다. 완료 응답은 원본 요청·schema·cwd·제품 hash 확인 뒤 복원하고, 중단/실패 turn은 기록을 보존한 continuation으로 이어간다. 환경 오류는 제품 실패 횟수에서 제외한다. 실패 제품 revision이 변하지 않으면 제품 검증을 반복하지 않는다. REVIEW 수리에서는 책임 태스크와 후손만 무효화하고 이전 승인에서 통합 복사본을 재구성한다.

명령 로그는 스트림당 256KiB, 이벤트 요약은 항목당 8KiB·현재/직전 파일 각 8MiB로 제한한다. 모델 추론과 명령 원문 출력 전체를 진행 로그에 복사하지 않는다. compact JSON 결과, 실제 exit code, SHA256, byteLength를 증거로 사용한다. 사라진 tool/completed 때문에 watchdog가 영구 유예되지 않도록 실행 중 도구에도 최대 60분 또는 idle 설정의 2배 상한을 적용한다.

진행 위치는 `reports/prompt15/orchestration/latest.json`이 가리키는 `progress.txt`다. 태스크별 상태/실제 후보/감시 thread ID/마지막 도구 활동/REVIEW 승인 상태와 총괄의 운영 감사 상태를 표시한다. 세션별 최근 메시지 5개와 모든 태스크를 합친 최근 메시지 5개는 유지하며 새 태스크 세션은 슬롯 번호 대신 taskId로 표시한다. 기존 Discord observer는 latest를 따라 같은 메시지를 갱신한다. baseline 접수나 사전 점검 완료 자체는 제품 구현 시작이 아니다.

컨트롤러가 살아 있는 동안 `progress.txt`의 작성자는 컨트롤러 하나다. 표시기는 세션 메시지 캐시만 갱신하고 컨트롤러 종료 뒤에만 진행 파일을 대신 쓴다. Windows 파일 접근 경합이나 표시 실패는 제품 상태 저장과 구현·검증을 중단시키지 않는다. 운영 코드를 수동 수리한 뒤의 재개도 실제 전체 회귀 검사와 소스 hash가 결속된 운영 유지보수 영수증을 요구하며, 새 사용자 승인이나 제품 PASS를 만들어 내지 않는다.

## 실행·복구 계약

- 감사 요청 횟수(`count`)는 호출 통계다. 구현 실패는 실제 제품 assertion FAIL에서만 증가한다. 운영 실패는 실제 실행된 감사·수리의 실패 receipt를 같은 사건에 SHA256으로 한 번만 집계한 `failureCount`로 제한한다. 요청·대기·진행 중·정상 감사 완료는 운영 실패가 아니다. 기존 `maxAuditsPerIncident` 설정은 호환 운영 실패 한도로 사용하며, 마지막 허용 감사도 명시 기한 안에서는 완료까지 기다린다.
- 외부 runtime과 내부 제어기는 공통 execution-lifecycle의 작업·수리 소유권 판정을 쓴다. 검증 응답 저장 뒤의 입력 hash 대조·제어기 Vitest·총괄 승인 인계도 기한을 가진 product-handoff로 기록한다. native turn 소유권을 해제하기 전에 결과 확인 단계로 전환한다. 단계·heartbeat만으로 제품 진척 시각을 갱신하지 않는다. guardian 수리도 감사 출처와 무관하게 자기 실행·입력 검사·회귀 검사 기한 안에서 보호한다.
- 실제 제품 실행이나 원본 요청·native ID·schema·후보 bytes가 확인된 응답이 과거 정체를 대체하면, 이전 감사 요청은 원본 및 새 진척 증거를 연결한 audit-retirement receipt로 보존한다. 실행 중이거나 미확정인 감사는 정확한 native 실행의 종료를 먼저 확인한다. 해당 정체 사건의 소진 표시는 이력에 남기고 현재 차단 조건을 재평가한다. 제품 PASS나 REVIEW 승인을 발급하지 않는다.
- 운영 수리가 대기하면 새 태스크 배정을 막고 이미 배정된 작업의 검증·병합을 끝낸 뒤 수리한다. 수리의 native ID 저장 전에 중단된 경우 원본 dispatch·request·schema와 전용 thread의 실제 요청을 대조한다. 유일한 정확한 요청만 복원하며 모호한 이력·다른 활성 작업은 소유권을 보존한 채 거부한다. 검사되지 않은 mirror 변경은 적용하지 않는다.
- controller-vitest의 병렬 배정은 태스크별 완료 이벤트마다 빈 슬롯과 의존성을 다시 계산한다. 빠른 태스크가 PASS하면 다른 형제 태스크의 완료를 기다리지 않고 새 의존 태스크를 배정한다. 활성 태스크의 세션·쓰기 범위는 계속 예약하며, 15-06·15-47은 활성 작업이 모두 끝난 뒤 단독 실행한다. 15-10은 기존대로 15-02·15-06·15-09 PASS를 모두 요구한다.
- 15-14·15-15는 13 PASS 뒤 함께 배정한다. 14는 `scripts/operational-cells/representative-experiments`에 실험기를 작성하고 공유 prototype·고정 정책은 읽기만 한다. 15는 `src/lib/operational-cells`와 `scripts/operational-cells/identity-provenance`에 ID·provenance를 구현한다. 39·41도 38 PASS 뒤 함께 배정하며, 39·40은 `e2e/prompt15/korea`·`src/lib/test-only/prompt15/korea`, 41은 각각의 `slovenia` 경로를 소유한다. 39 PASS 뒤에는 41이 실행 중이어도 40을 배정한다. E2E는 각 후보의 서버·포트·브라우저 context·게임/저장 상태·출력을 분리하고 공유 runtime은 읽기만 한다. 공유 선행 구현의 결함은 실제 실패 증거로 보고한다. 기존에 배정된 계약은 소급 변경하지 않는다.
- 입력 context는 경로(`PROMPT15_TASK_INPUT_CONTEXT_PATH`)와 identity JSON(`PROMPT15_TASK_INPUT_CONTEXT_IDENTITY`)을 분리해 제공한다. 기존 변수는 동결된 15-06·15-07 suite에는 검증된 경로, 나머지 기존 소비자에는 identity JSON을 전달한다. 경로 전달 오류는 제품 실패가 아닌 운영 차단으로 분류한다.
- 운영 수리는 감사 admission을 먼저 예약하고 기존 총괄 감사가 끝난 뒤 시작한다. 수리 중에는 새 감사를 시작하지 않는다. transport 종료도 admission을 닫은 뒤 기존 감사를 기다리므로 종료 직전에 새 감사 요청이 만들어지지 않는다. turn/start 응답의 native ID를 notification과 별개로 저장한다. 과거 ID 미확정 읽기 전용 감사는 원본 요청과 실제 native 이력을 대조하고, 활성 작업이 없음을 확인한 경우에만 미채택 상태로 보존한다. 제품 PASS나 감사 결정을 추정하지 않는다.

- `tasks/<id>/contract.json`은 원문 태스크 전체·check·gate·보존 조건을 고정한다. 구현자는 이를 수정하지 못한다.
- 구현자는 후보 `.reports`에 실제 Vitest 테스트와 명시적 test-plan을 제출한다. 제어기는 suite를 후보 밖에 복사·pin하고 수집 및 필수 criterion 실행이 확인된 뒤 정식 동결한다. 준비 오류는 읽기 전용 후보와 별도 쓰기 report를 가진 testPreparer가 새 파일로 수정한다. 정상 경로에는 이 모델 호출이 없다. 제품 assertion 실패가 실제로 실행된 정식 suite는 제품 수리에도 그대로 사용하며 기대값을 낮출 수 없다. 태스크 PASS는 빠른 작업 인수 결과이며, 전체 요구사항의 독립 통합 판단은 REVIEW에 남는다.
- 공식 실행은 `verification-controller` 아래에서 제어기가 직접 수행한다. 후보 cwd/root와 @ alias를 결속하고, 정확한 테스트 디렉터리만 검색한다. 완료된 실행은 입력·테스트·도구 hash가 동일한 경우 재사용한다. 중단되거나 도구가 바뀐 그룹만 새 디렉터리에서 실행하고 이전 결과는 보존한다.
- runtime watchdog는 heartbeat와 실제 상태 진척을 구분한다. 제어기 정체·명령 deadline 초과를 감지하고 자신이 시작한 제어기만 복구한다. 로컬 운영 오류는 retry.json을 기다리지 않는다. 실제 외부 인증·승인 반려·수동 baseline gate는 계속 대기한다.
- 운영 수리 적용과 회귀 검사 PASS만으로 사건을 닫지 않는다. 원래 흐름에서 새 검증 결과나 태스크 PASS가 나온 뒤 `operatingRecovery.status=resolved`로 기록한다.
- `.reports` 산출물도 제어기가 완료 시 hash/bytes를 input manifest에 자동 결속한다. 재사용·병합·선행 검사에서 변경을 거부한다. 전체 REVIEW와 승인 모델의 미확정 turn도 정확한 native thread/turn과 schema·후보를 대조하고 복원하며, 확정 완료를 중복 호출하지 않는다.
- 병렬 태스크의 세션 key는 attempt에 고정한다. 정상 형제 병합 뒤 남은 태스크의 배열 위치가 바뀌어도 같은 native 요청을 복구한다. verifier continuation은 원래 요청에 결속된 증거 루트와 새 응답 디렉터리만 쓴다.
- 전체 REVIEW의 제어기 확정 verdict는 응답·context·제품·증거·실행 입력 pin을 확인해 재사용한다. 승인 응답 전달 실패만으로 Vitest를 반복하거나 승인 요청 내용을 바꾸지 않는다. 환경 BLOCKED는 실제 운영 수리 receipt 또는 명시적 사용자 재개 receipt 이후에 새 verification revision으로 이어가며 과거 응답을 보존한다.
- 외부 대기 태스크가 있어도 독립 작업은 계속한다. 사용자 resume/retry 원문은 `control/explicit-resume` receipt에 보존한다. 해당 태스크의 외부 대기 뒤에 제출된 재개 입력만 같은 attempt를 한 번 이어가게 한다. 외부 조건이 여전히 해결되지 않았다면 새로 대기하며 같은 receipt로 무한 재시도하지 않는다. 자동 프로세스 재시작은 사용자 입력으로 간주하지 않는다.

## 중단된 운영 수리와 명시적 harness 복구

재시작 시 기존 guardian-repair 소유권을 먼저 복원한다. 원본 request·audit pin·정확한 native thread/turn을 대조하고, 실행 중이면 중단 확정까지 기다린다. terminal native 기록을 새 reconciliation receipt로 남긴 뒤에만 활성 수리 기록을 이력으로 옮긴다. 기존 mirror·요청·응답은 보존하며 검사되지 않은 patch를 적용하지 않는다. 수리 입력 hash 검사는 명시적 deadline을 가진 operation이고, watchdog는 그 범위 안의 동기 검사만으로 수리 프로세스를 종료하지 않는다.

현재 attempt의 확정 BLOCKED 응답은 과거 attempt의 verdict보다 우선한다. target이 없거나 구현이 미완료이면 검증·준비 수리를 시작하지 않는다. 구현 재개를 허용하는 수리 receipt는 해당 task_blocked 감사와 정확한 차단 response에 연결돼야 한다.

동결 suite의 어댑터 자체에 오류가 입증되고 사용자가 수동 복구를 명시적으로 허용한 경우, 총괄은 원본 frozen·실패·차단 기록을 보존하고 `harness-revisions`에 별도 검토 revision을 만들 수 있다. controller-owned authorization은 원본 frozen/suite·사용자 지시·수리 사유·새 suite pin을 연결하며 contractDigest와 원래 requirements는 같아야 한다. 구현자와 자동 testPreparer에게 동결 테스트 변경 권한을 주지 않는다. 현재 attempt의 context identity는 제어기가 `PROMPT15_TASK_INPUT_CONTEXT`로 제공하므로 과거 attempt 해시를 새 후보의 인수 조건에 고정하지 않는다. 수동 완료 receipt는 native turn과 구분해 기록하고 실제 제어기 Vitest 통과 후에만 병합한다.
- 실행기·runner·bounded command·전달·진행 표시 코드는 명시 allowlist mirror에서 자동 수리할 수 있다. 제품·기능 프롬프트·계획·GATES·config·승인 정책·기존 증거와 고정 검사는 수리 worker의 수정 대상이 아니다.

## REVIEW 실패 뒤 재배정

REVIEW의 제품 FAIL은 과거 태스크 PASS와 별도로 취급한다. 새 attempt는 이전 workspace·target·구현·검증 연결을 이력으로 보존하고 실행 권한을 새로 만든다. 배정 candidateRoot, 입력 context, 실제 cwd, 요청·응답·target은 같은 attempt에 결속돼야 하며 dispatch 전에 불일치를 차단한다. 총괄의 원본 수리 결정과 실패 verdict를 pin해 배정 및 입력 context에 함께 전달한다.

이미 혼합된 과거 attempt는 원본 REVIEW request·dispatch·완료 응답·schema·제품 FAIL·후보와 증거 bytes를 확인한 뒤에만 repair 상태로 복구한다. 잘못된 후보의 응답을 새 후보에 재결속하지 않는다. 수리 승인은 원래 실패한 REVIEW에만 적용하고, 다음 REVIEW에는 이전 단계의 중단 지시를 상속하지 않는다. 이후 REVIEW 재심사가 시작돼도 원본 수리 영수증의 경로를 유지한다.

인수 검사는 원래 요구사항과 불변 조건을 검증한다. 특정 후보의 실패, 과거 context hash, 작은 chart, 정책 미선택을 현재 후보의 영구 합격 조건으로 고정하지 않는다. 확인된 harness 오류를 사용자가 교정하도록 지시하면 원본 frozen suite를 보존한 별도 revision과 음성 fixture를 만들고, 동일 contractDigest·requirements와 기준 아래 검증한다. 정책 선택 태스크는 실제 적합 정책의 선택을 요구한다. 보고서의 정확성과 전체 정책 승인은 별도 판정이다.

운영 수리 worker는 수정 및 최소 재현에 집중하고 전체 고정 회귀의 완료를 기다리지 않는다. 패치 반환 뒤 controller가 별도 10분 예산으로 전체 고정 회귀를 한 번 실행한다. 검증 전후 source identity가 같고 실제 완료된 검사만 수리 적용 근거로 사용한다. 사용자 stop은 유지되며 수동 교정 완료가 자동 재개를 뜻하지 않는다.
# 2026-10-16 context and queued-audit recovery

Acceptance context hashes must come from the current controller-pinned identity, not a historical attempt constant. Explicit operator harness revisions retain original suites and contract requirements. A blocked candidate with such a validated revision receives a new supervisor routing report bound to that revision; its original implementation and previous decisions remain immutable. Routing never grants product PASS.

A queued audit is admitted at controller startup before replaying blocked routing. Recovery waits reopen admission for pending audits unless external input or exhausted recovery forbids it. The native-audit watchdog starts from actual audit admission, not the mailbox's requested deadline; queued requests cannot consume the three native reconciliation replacements. Actual admitted audit deadlines and bounded product/repair protection remain enforced.
# Task 17 diagnostic completion and verified harness recovery

Internal product BLOCKED handoffs retain the exact original response, candidate,
pins and routing decision, but do not exempt an unresolved internal block from
recovery or oversight. A bounded supervisor resolution inspects the selected
suite's artifact reads and assigns completion of the same unaccepted task in a
fresh attempt. It cannot revoke accepted work or increment product failure
counters. The new assignment carries the authenticated resolution and historical
read-only candidate; every current artifact is regenerated and controller Vitest
still decides acceptance. Repeated unchanged-source omissions receive a concrete
input/decision question with evidence, never a silent unowned hold. External
approval/authentication and explicit user stop remain protected. Task 14 must
complete its comparison matrix even when whole-REVIEW policy gates fail; honest
infeasible scopes remain in that matrix. Policy selection and REVIEW B approval
still require their original unchanged gates.

Task 17 must produce a complete current-candidate summary and failure-return handoff when no policy qualifies. Its unit acceptance does not approve the policy: independent whole REVIEW B still enforces all physical, scope and budget gates and routes the smallest verified responsible-task repair. Do not replace this handoff with repeated operating continuations on identical prerequisite data.

Additional authorized harness revisions use immutable numbered revision files selected through `harness-selection.json`. Earlier revision files remain byte-identical because historical target manifests may pin them. New routing targets pin the selected immutable revision, never the mutable selector.

An explicit operator harness recovery requires actual complete Vitest on the exact previously failed target under the corrected suite. Preserve the original failed verdict and record a one-time counter resolution tied to that counted content revision; it grants only a fresh scoped assignment. Fresh assignments archive and clear old per-attempt continuation/handoff ownership. A saved-state regression must exercise diagnostic acceptance, a real independent B failure, authenticated supervisor repair routing and the next responsible-task implementation dispatch.
