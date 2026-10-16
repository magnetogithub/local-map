# Prompt15 태스크 실행기 v15

현재 운영은 `taskVerificationMode: controller-vitest`를 사용한다. 48개 태스크와 REVIEW A~F의 원래 요구사항을 유지하며, 정상 태스크는 제어기 배정 → 구현 → 태스크 검증(제어기 Vitest) → 병합 순서다. 별도 태스크 검증 AI와 총괄 중계는 실행하지 않는다. 각 REVIEW의 모든 태스크 PASS 뒤에는 독립 세션이 리뷰 검증을 수행한다. 상세한 현행 계약은 `prompt15-orchestration.md`를 따른다. 별도 독립 태스크 검증 세션과 태스크 stage journal은 과거 호환 모드다.

48개 독립 태스크의 실제 실행기는 `task-workflow.mjs`다. `implementationUnit: task`에서만 선택된다. 기존 REVIEW 실행기는 과거 기록/회귀검사 용도로 유지한다. 제품 요구사항과 REVIEW A~F의 gate는 원문 그대로다.

태스크 검증·리뷰 검증은 실제 Vitest `test`·`expect`를 사용한다. 태스크 검증은 제어기가 후보 밖에 고정한 suite와 정확한 후보를 결속해 직접 실행하고 compact JSON 결과를 남긴다. 리뷰 검증에서는 독립 세션이 `run-target-checks.mjs`로 후보 결속 테스트를 실행하고 제어기의 `vitest-acceptance.mjs`가 제출 테스트 identity를 대조해 직접 재실행한다. 유효한 Vitest 결과가 없으면 PASS할 수 없다. Node 감사 CLI·node:test·로그 요약·exit code 래퍼는 대체 검증 도구로 허용하지 않는다. 로그는 스트림당 256KiB 이하의 보조 기록이다.

```text
수동 Prompt14 전체 PASS + 후보 bytes 확인
                    ↓
제어기 상태 점검 (운영 장애 때 고정 운영 감시·가변 수리 세션)
                    ↓
태스크 고정 계약 → 태스크별 구현 세션 → 태스크 검증 (제어기 Vitest)
                                                ├─ PASS → 후보 병합 → 의존 작업 해제
                                                ├─ FAIL → 같은 태스크 수리
                                                └─ 운영 장애 → 원인 보존·자동 수리·재개
                    ↓
의존성 PASS 태스크 선택 (최대 4개, 모든 쌍의 쓰기 소유권 비중복)
                    ↓
각 REVIEW의 모든 태스크 PASS → 리뷰 검증 (독립 세션) → 총괄 승인
                    ↓
REVIEW F PASS → 사용자 지시 대기
```

실제 복사된 태스크 후보에서만 구현/검증한다. 승인된 baseline과 통과한 태스크 후보는 보존한다. 병렬 후보의 변경은 사전 파일 소유권·기준 hash를 대조하여 REVIEW 통합 복사본에 병합한다. 최대 4개는 상한이며 의존성이나 소유권이 겹치면 순차 실행한다. 15-06, 15-47은 단독 실행한다. D의 15-30/15-35 양쪽 PASS 전에는 전체 D를 시작하지 않는다. 구현의 원본 request와 확정 response를 태스크 검증·리뷰 검증까지 계속 연결한다. 구현 세션은 태스크마다 새로 만들고 같은 태스크 수리에는 재사용한다. 기존 진행 중인 세션의 정확한 native 요청은 유지한다.

정상 startup·배정·인계는 제어기가 점검하고 고정 운영 감시 세션은 운영 장애와 REVIEW 경계에서 호출한다. 제품 heartbeat, 실제 제품 작업 시각, 감시 활동 시각은 별개로 기록한다. 감시자는 운영 규칙 3개를 격리된 mirror에서 고칠 수 있고 코드 결함은 사건별 수리 세션에 인계한다. 허용 diff·실제 회귀 검사·동시변경 여부를 확인한 뒤만 적용하고 fresh controller로 재개한다. 제품 코드·명세·계획·gate·상태/판정은 수정할 수 없다. 자세한 권한은 `prompt15-guardian.md`에 있다.

외부 runtime은 제품 작업 정체 5분, 같은 원인의 감시 판단 3회 반복, 실행 deadline 초과를 독립 관찰하고 고정 총괄 세션에 읽기 전용 운영 감사를 요청한다. 총괄은 감시자의 허가를 다시 기다리지 않고 정확한 운영 turn 중단·terminal 확인·원본 소유권 복구 뒤 단일 수리 경로에 인계한다. 제품 작업은 안전 지점까지 완료시키며 명시적 사용자 정지·standby·실제 외부 인증/승인 대기는 존중한다. 감사나 코드 수리 적용만으로 사건을 해결 처리하지 않고 원래 흐름의 새 태스크 검증/PASS를 확인한다. 감사 실패·복구 한도 도달도 별도 상태로 표시하며 제품 PASS를 부여하거나 기준을 바꾸지 않는다.

태스크별 request/dispatch/확정 response, 후보 manifest, 실제 Vitest 결과와 verdict를 `tasks/<taskId>/attempt-NNN`에 저장한다. stage journal은 리뷰 검증과 과거 호환 검증에서 사용한다. 미확정 dispatch는 맹목적으로 재발송하지 않고 정확한 thread/read로 실제 turn을 대조한다. 이미 확정된 구현은 원본 요청·schema·cwd·제품 hash를 확인한 뒤 재사용하며 중단/실패는 이전 기록을 보존한 continuation으로 이어간다. 환경 오류는 제품 실패 횟수에서 제외한다. 실패 후보 revision이 변하지 않으면 재검증하지 않는다. REVIEW 수리에서는 책임 태스크와 후손만 무효화하고 이전 승인에서 통합 복사본을 재구성한다.

명령 로그는 스트림당 256KiB, 이벤트 요약은 항목당 8KiB·현재/직전 파일 각 8MiB로 제한한다. 모델 추론과 명령 원문 출력 전체를 진행 로그에 복사하지 않는다. compact JSON 결과, 실제 exit code, SHA256, byteLength를 증거로 사용한다. 사라진 tool/completed 때문에 watchdog가 영구 유예되지 않도록 실행 중 도구에도 최대 60분 또는 idle 설정의 2배 상한을 적용한다.

진행 위치는 `reports/prompt15/orchestration/latest.json`이 가리키는 `progress.txt`다. 태스크별 상태/실제 후보/감시 thread ID/마지막 도구 활동/REVIEW 승인 상태를 표시한다. 기존 Discord observer는 latest를 따라 같은 메시지를 갱신한다. baseline 접수나 사전 점검 완료 자체는 제품 구현 시작이 아니다.
