# Prompt 15 운영 감시와 총괄 감사

사용자가 요청한 guardian은 프로젝트 기능을 심사하는 검증자와 별개로, 오케스트레이션이 정한 일을 실제로 배정·실행·전달·검증하는지 검사한다. 기존 총괄·구현자·제품 검증자는 유지한다. guardian에게 운영 룰과 제어 코드의 직접 수정 권한을 부여하되 제품 승인 권한은 부여하지 않는다. 역할 원문은 `automation/prompt15/guardian.txt`다.

## 현행 v15 계약

총괄과 운영 감시는 같은 run에서 유지하는 고정 세션이다. 구현 세션은 태스크마다 새로 생성하고 같은 태스크 수리에는 재사용한다. 정상 경로의 태스크 검증은 제어기 소유 suite를 실제 Vitest로 실행하므로 별도 태스크 검증 AI나 모델 인계 감사를 추가하지 않는다. 리뷰 검증은 REVIEW A~F별 독립 세션이 담당한다. 의존성·모든 쌍의 쓰기 경로 비중복·단독 실행 조건을 만족하는 태스크만 최대 4개 병렬 실행한다. 아래 정상 인계별 모델 감사와 독립 태스크 검증 세션은 호환 모드 설명이다.

운영 감시 자신도 총괄의 독립 감사 대상이다. 외부 runtime은 실제 제품 작업 정체 5분, 같은 원인의 감시 판단 3회 반복, 명시적 실행 deadline 초과를 감지한다. heartbeat·감시 메시지·phase 변경은 제품 진척으로 세지 않는다. 고정 총괄 세션은 읽기 전용 감사로 실제 요청·응답·native 소유권을 대조하며 운영 감시의 재승인 없이 수리를 결정할 수 있다. 정확한 운영 turn 중단·terminal 확인과 기존 요청·mirror 보존 후 단일 수리 소유권으로 인계한다. 유효한 deadline의 제품 작업은 안전 지점까지 완료시키며 명시적 사용자 정지·standby·실제 외부 인증/승인 대기는 존중한다.

운영 수리는 사건마다 별도 세션을 만들고 허용된 운영 코드 mirror와 고정 회귀 검사만 사용한다. 수리 적용은 `repair_applied_awaiting_product`이며 원래 흐름에서 새 태스크 검증 결과나 PASS가 나올 때까지 사건을 닫지 않는다. 감사 실패(`failed`)와 복구 한도 도달(`escalation_exhausted`)도 정상 대기와 구분해 표시한다. 총괄 감사와 수리 worker는 제품 PASS 발급·기준 완화·권한 변경을 할 수 없다.

## 역할과 권한

| 구분 | 허용 범위 |
| --- | --- |
| 읽기 | 이번 run의 상태 요약, 태스크 계획, 원본 배정과 확정 결과, 후보와 입력 manifest의 identity, 검증 journal의 실행 사실, 운영 코드·검사 |
| 직접 수정 | 배정된 mirror 안의 운영 룰·제어 코드 allowlist. 실제 목록은 `REPAIR_FILES`이며 기존 고정 검사는 읽기 전용 |
| 설정 보호 | config·모델·권한·실행 활성화·baseline 선택·판정 기준은 변경 불가. 자동 수리는 배정된 운영 코드 allowlist만 수정 |
| 제어 요청 | 이번 run의 hold, 특정 오류의 재현, 안전 지점에서 reload와 기존 세션 resume 요청. 실행 여부는 총괄의 단일 제어 경로가 결정 |
| 금지 | 제품 내용·제품 검사 기준·기능 프롬프트·GATES·source lock·Prompt14 후보/판정/receipt·과거 증거 수정, 제품 PASS 발급, 타 역할 직접 지시, 타 세션/프로세스 종료 |

`src/`, `data/`, `public/`, 제품 `e2e/`·`validation/`, 제품 생성 스크립트, `package.json`과 lockfile은 수정하지 않는다. 공유 입력의 junction이나 symlink를 따라가서 수정하지 않는다. 운영 폴더 내부에서도 기능 기준이나 승인 증거를 바꾸는 변경은 금지다. 비밀·Discord webhook·계정·.env 원문은 감사 입력이나 결과에 포함하지 않는다.

## 어제 반복된 오류와 재발 방지 조건

| 오류 | 관찰해야 할 실제 근거 | 잘못된 처리 | 필요한 처리 |
| --- | --- | --- | --- |
| 원본/후보 경로 혼동 | 배정 cwd, candidateRoot, targetId, source manifest, 테스트 import | 수정한 후보 대신 controlRoot를 반복 검사 | 배정부터 판정까지 후보 identity 대조. 불일치면 handoff hold |
| 같은 입력 재검증 | 제품 revision, 실패 gate, 이전 attempt key | 보고서 폴더 이름만 바꿔 실패 횟수 증가 | 동일 실패 한 번 집계. 실제 보완 전 재검증 차단 |
| 전달 상태 유실 | 원본 request identity, 완료 turn/response, schema, cwd, 사후 source digest | 완료 작업을 다시 구현하거나 불확실한 turn을 완료로 추정 | 확정된 응답 재대조 후 재사용. 불확실한 작업은 hold 후 복구 |
| heartbeat로 실행중 오표시 | controller·모델 turn·실제 도구의 각각 마지막 시각, 실행중 command 근거 | progress 시각만 갱신되어 정상 진행처럼 표시 | 생존과 실행 분리. 실행 근거가 없으면 대기/정체 표시 |
| 환경 장애를 구현 결함으로 집계 | 실제 재현 명령·exitCode·차단 사유·verdict nonPassKind | 승인 차단·transport 오류를 제품 실패로 누적 | 외부/운영 장애 분리. 제품 strike를 증가시키지 않음 |
| 분기 조기 해제/충돌 | 현재 유효한 모든 선행 PASS, 소유 경로, 입력 revision | 구현 completed만으로 다음 태스크 시작 또는 같은 후보에 동시 쓰기 | 독립 태스크 PASS 후 해제. 별도 작업본과 충돌 확인 후 합류 |
| 로그 재폭증 | 명령 로그 cap, 운영 이벤트 관찰 bytes, 보존 정책 | bounded CLI만 두고 raw agent_message/events는 무제한 보관 | 이벤트 내용·빈도·크기를 제한하고 커서/요약만 감사자에게 전달 |

guardian의 정상 판정은 이 운영 계약에만 해당한다. 태스크 PASS는 제어기의 실제 태스크 검증으로, REVIEW A~F PASS는 독립 리뷰 검증의 실제 증거로만 발급한다.

권위 task.status·phase·활성 turn, 확정 응답, target/evidence identity와 권한이 정확한데 nextAction·progress 설명만 낡았다면 severity=low advisory를 summary/reason에 남기고 continue/none으로 다음 미완료 인계를 진행할 수 있다. 문구 오류만으로 제품 전체를 장시간 정지시키거나 완료된 구현을 다시 배정하지 않는다. 실행 상태의 불확실성·후보/증거/소유권/권한/의존성 오류, heartbeat를 실제 실행이나 완료 근거로 사용한 경우는 계속 hold한다. wrapper는 기존 hold를 단어 비교만으로 continue로 바꾸지 않으며 원래 감사는 보존하고 새 근거로 판정한다.

## 지속 세션과 app-server 계약

guardian은 별도 `thread/start`로 만든 독립 root thread다. 다른 역할의 대화·사고 이력을 복사하거나 fork하지 않는다. 같은 run에서는 저장된 guardian thread ID를 `thread/resume`하여 유지한다. 사용된 thread가 복구되지 않으면 기존 ID와 원인을 기록하고 총괄에게 보고하며 새 thread를 조용히 대체하지 않는다. 모델과 effort는 총괄이 명시한 기존 운영 설정을 따르며 감사자가 변경하지 않는다.

세션 표시 이름은 `[Prompt15] 운영 감사`다. threadId가 실제 반환되기 전에는 연결됨·실행중으로 표시하지 않는다. app-server 연결 생존과 guardian turn 실행, guardian의 마지막 실제 검사 시각도 분리한다. guardian heartbeat는 제품의 마지막 실행 시각에 합산하지 않는다.

각 감사 배정에는 작은 `audit-context.json`을 전달한다. 원본 상태를 복제하거나 비밀 필드를 자동 전달하지 않는다. 최소 계약은 다음과 같다.

```json
{
  "version": 1,
  "auditId": "고유 감사 ID",
  "runId": "검사할 run ID",
  "runDirectory": "이 run의 절대 경로",
  "controlRoot": "운영 저장소의 절대 경로",
  "runStatePath": "이 run/state.json의 절대 경로",
  "agentsPath": "controlRoot/AGENTS.md의 절대 경로",
  "guardianThreadId": "실제 생성한 독립 thread ID",
  "observedAt": "UTC 시각",
  "stateIdentity": {"path":"관찰한 상태 snapshot","sha256":"...","byteLength":0},
  "taskId": "15-01",
  "review": "A",
  "phase": "implement",
  "candidateRoot": "배정된 실제 제품 작업본",
  "targetId": null,
  "assignmentIdentity": null,
  "confirmedResponseIdentity": null,
  "lastTurnActivityAt": null,
  "lastToolActivityAt": null,
  "runningCommands": [],
  "eventCursor": {"offset":0,"observedBytes":0},
  "requestedChecks": ["target-binding","verified-dependencies","execution-liveness"],
  "reportDirectory": "이 auditId 전용 새 디렉터리",
  "controllerWriteOwnership": "active"
}
```

배정 전 target이 없으면 null을 쓰며 다른 후보나 이전 태스크 target으로 채우지 않는다. 감사자는 snapshot identity를 대조하고 오래된 snapshot으로 현재 상태를 단정하지 않는다. taskId·review·phase·targetId가 바뀌면 이전 audit-result의 적용 적격성을 다시 확인한다.

차단이 발생하면 기존 guardian 세션에 `snapshot.blockedTask`를 우선 전달한다. 태스크가 BLOCKED라는 요약뿐 아니라 taskId·status·blockerKind·nonPassKind·remainingIssues와 `assignmentIdentity`, `requestIdentity`, `confirmedResponseIdentity`, `inputManifestIdentity`, `artifactIdentities`, `repairEvidenceIdentities`를 포함한다. 모든 identity는 실제 path·sha256·byteLength이며 합계 64개 이하다. 수리 증거에는 제어 코드 hash와 통과한 회귀 검사 보고를 연결한 `repair-ready.json`, 원래 차단 candidate 기준으로 만든 별도의 `repair-input-context.json`을 사용한다. 원래 `.reports` 산출물을 수정해서 수리된 것처럼 보이게 하지 않는다. guardian은 전달 전후 실제 파일 identity를 검사하며 비밀·대량 raw events·다른 역할의 사고 과정은 받지 않는다.

### 입력 전달 차단의 복구 배정 검사

원래 배정의 경로·읽기 범위와 새 수리 context를 대조하여 차단 원인별 공급 근거를 확인한다. 제어 검사 통과만으로 개별 누락 입력이 공급되었다고 추정하지 않는다.

- `candidateRoot`는 실제 구현 attempt이며 supervisor가 조사하는 `readOnlySourceRoot`와 구분한다. 새 원본 배정·구현 request·cwd·확정 response가 같은 candidate를 지목해야 한다. 이전 배정의 REVIEW 작업본 cwd 문구를 그대로 재사용하지 않는다.
- `dirtyInventory.complete`는 그 context가 명시한 제품 source 범위에만 유효하다. 승인 predecessor manifest, 현재 source identity, 변경 목록을 대조하며 source 변경 0개를 controlRoot의 git dirty 전체 또는 공유 data/public의 변경 0개로 해석하지 않는다. 공유 입력은 기존 승인 manifest의 별도 identity로 검사하고 누락은 계속 명시한다.
- 후보 밖의 원문 참조와 과거 최종 보존 증거는 context에 명시적으로 pin된 파일만 읽기 전용으로 전달한다. 구현자의 이전 비교 허용 목록에 없었다는 이유로 새로 공급된 증거를 차단하지 않는다. 과거 보고서의 시작 hash와 최종 hash는 각각 시점·출처를 보존하며 불일치를 지우거나 최종 PASS 기록으로 현재 bytes 검사를 대체하지 않는다.
- dependency는 후보에서의 논리 경로, 승인 링크 체인의 최종 realpath, 공급된 SHA256·byteLength를 대조한다. 승인된 기존 설치의 중첩 junction과 제품 fallback을 구분한다. 임의 controlRoot package나 제품 import를 허용하는 규칙으로 확대하지 않는다.
- 구현 결과와 확정 응답 저장 뒤 controller가 guardian 구현 인계를 요청하고 독립 검증에 중계한다. 미래의 감사·중계 완료는 구현 응답 반환의 선행 조건이 아니다. 다음 attempt에서는 새 candidate에 맞는 `task-input-context.json`을 생성하고 이전 `repair-input-context.json`은 원래 차단 candidate의 증거로 보존한다. 과거 산출물을 덮어쓰거나 그대로 새 후보의 증거로 선언하지 않는다.

이 검사는 운영 입력 공급과 중계 순서에 대한 검사다. 원문 인수 조건과 모든 제품 검사는 유지하고 후속 태스크는 독립 PASS 전까지 대기한다. 실제 재배정 허용에는 아래 복구 계약의 확정 차단 응답·모든 supplied repair evidence·실제 룰 diff가 함께 필요하다.

다음 때 검사한다: 시작 전 preflight, 태스크 배정/확정 응답/검증/합류/승인 전후, 운영 장애, 실행 정체 임계값, 제어 코드 reload 전후. 변화 없는 heartbeat마다 모델 turn을 생성하지 않는다. 같은 guardian thread에 동시에 두 turn을 보내지 않으며 감사 실패의 자기 재시도도 무한 반복하지 않는다. guardian 프로세스/turn이 실패하면 `guardian unavailable`를 명시하고 민감한 다음 배정·승인·합류를 hold한다.

지속 관찰자는 raw `events.jsonl` 전체를 반복 읽거나 guardian에게 전송하지 않는다. offset 커서와 허용 필드 요약을 사용하고, 확인이 필요한 파일 identity를 전달한다. 한 명령 stdout/stderr의 보관은 각각 256KiB 이하다. 감사 파일은 고유 auditId별로 덮어쓰지 않으며 공통 입력은 한 번 pin하고 참조한다. 회전되는 운영 이벤트의 커서 단절은 원인을 기록하고 상태/확정 결과로 재동기화한다. 로그 삭제로 과거 승인 근거를 잃지 않는다.

## Windows 검증 실행 복구

`setup refresh had errors`와 readiness=ready가 함께 나타나면 실제 동일 sandbox 정책의 `command/exec`를 확인한다. 현재 run의 증거 폴더에 대한 `write ACE failed ... open ACL target for update`는 폴더 소유자와 controller 계정을 대조해 진단한다. 다른 sandbox 계정이 만든 증거 폴더라면 원본을 보존하고 controller 계정이 만든 새 검증 revision을 사용한다. Vitest가 시스템 Temp의 변환 파일 생성에서 EPERM을 내면 child의 TEMP/TMP/TMPDIR를 새 증거 폴더 안에 고정한다. sandbox 비활성화·모드 교체·쓰기 범위 확대·전역 ACL 변경은 하지 않는다.

`environment_recovery` 감사의 snapshot.commandEvidence.recoveryReceipt는 현재 복구 ready receipt를 가리킨다. 최신 receipt는 `control/verifier-recovery-current.json`의 pin으로 선택하고 이전 ready 파일은 보존한다. 이름에 environment를 포함한 새 snapshot 필드는 비밀 보호 필터가 제거하므로 이 기존 명령 증거 경로로만 전달한다. 여기서 원래 BLOCKED response, 같은 task/attempt/candidate/target, 동일 sandbox 제한의 실제 Vitest 성공, 현재 제어 코드와 Vitest 회귀 검사를 대조한다. 모두 유효하면 현재 외부 차단은 해결된 것이므로 continue/none으로 미완료 검증을 재개한다. 원래 응답·incident·검사 결과는 보존하고 판정·제품 실패 횟수는 바꾸지 않는다. 새 report의 dispatch/response가 이미 있거나 입력이 달라졌다면 덮어쓰지 않는다. 실제 승인 반려·인증·관리자 조치가 남은 경우는 계속 hold_external이다.

BLOCKED/environment 응답에서 실행 실패로 error 파일의 hash를 얻지 못한 경우 controller가 해당 report 안의 실제 파일 identity를 별도 controller-environment-evidence.json으로 보완할 수 있다. 원본 response는 그대로 보존하고 BLOCKED 분류를 유지한다. 누락된 error evidence 때문에 환경 차단 자체가 미확정 실행처럼 유실되지 않게 하며 이를 제품 PASS나 제품 FAIL의 증거로 쓰지 않는다.

운영 수리의 고정 Vitest 검사에는 verifier-recovery.test.mjs와 compact-vitest-reporter.test.mjs도 포함한다. 환경 복구를 제품 수리로 오집계하지 않는지, 감시 승인 전에 다음 실행을 시작하지 않는지, 수집·suite 오류가 개별 테스트 0건 뒤에 감춰지지 않는지를 검사한다. 실제 목록은 guardian-repair.mjs의 REPAIR_TESTS를 따른다.

## 실행중 직접 수정과 복구

1. 재현 가능한 운영 오류를 고유 incident/auditId로 기록한다. 관찰한 state revision과 해당 request/response/target identity를 고정한다. 제품 결함이면 수정하지 않고 총괄에게 전달한다.
2. 총괄의 단일 제어 경로에 해당 run의 guardian hold를 요청한다. hold 요청에는 발견 근거와 필요한 정지 범위가 있어야 한다. 이미 실행중인 제품 작업은 임의 종료하거나 다른 후보에 재배정하지 않는다.
3. 총괄이 안전 지점·활성 turn·쓰기 소유권을 확인한다. guardian은 `state.json`, active-controller lock, retry.json, 기존 stop marker를 직접 고치지 않는다. 같은 운영 파일을 총괄이 수정중이면 파일 소유권을 먼저 조율한다.
4. 해당 운영 파일만 수정한다. 변경 전/후 hash, 원인, 재현 명령, 영향 범위, 복구 방법을 감사 디렉터리에 남긴다. 제품 입력이나 과거 verdict는 건드리지 않는다.
5. 관련 제어 회귀 검사·구문 검사·린트를 수행한다. 실제 고장을 재현하는 검사를 사용하며 의미 없이 구현을 복제한 테스트만 추가하지 않는다. 검사 실패 시 자신의 운영 변경만 복구하고 hold를 유지한다. 다른 사용자의 변경은 되돌리지 않는다.
6. 검사 통과 결과와 수정 경로를 총괄에 반환한다. 자동 수리 엔진이 검증된 코드만 병합한 뒤 fresh controller 프로세스를 자동 재시작한다. 디스크 파일만 고치고 기존 메모리의 코드로 계속 실행하거나 사용자 재허가 대기로 끝내지 않는다.
7. 총괄이 동일 run의 확정 완료 결과를 대조하여 미완료 작업부터 재개한다. 운영 입력·전달 수리가 실제 증명되고 guardian의 아래 복구 계약을 충족하면 사용자에게 같은 허가를 다시 요청하지 않고 동일 태스크를 새 attempt로 재배정할 수 있다. guardian은 재개 후 실제 배정과 경로를 재감사하고 incident를 닫는다. unresolved approval rejection·필수 외부 입력·사용자 정지·수동 baseline gate는 자동 해제하지 않는다.

감사자에게 넓은 파일 쓰기 권한을 제공하는 경우에도 위 허용 목록을 명시하고 변경 목록을 독립 대조한다. sandbox가 파일 단위 쓰기 제한을 지원하지 않는다고 제품 디렉터리를 허용 범위로 넓히지 않는다. guardian 전용 report 디렉터리와 운영 디렉터리만 turn writableRoots에 넣는다. 총괄은 외부에서 제품 source/config와 승인 입력 identity의 전후 불변성을 대조한다.

일반 `task-guardian.mjs` inspect는 좁은 실행 경계를 유지한다. `automation/prompt15/guardian.txt`, 이 문서, `docs/automation/prompt15-orchestration.md`의 세 파일만 새 mirror에 복제하고 writableRoots는 그 mirror 하나다. 실제 diff, 동시 변경, 보호된 기능 프롬프트·계획·config·GATES와 제품 source 전후 identity를 대조한 뒤 허용 룰만 병합한다. 추가 파일·심볼릭 링크·1MiB 초과 룰·미신고 diff는 hold한다. 규칙 수정은 reload를 요구하고 백업과 확정 응답 pin을 보존한다.

`hold/repair_controller`는 이 inspect의 다음 자동 단계로 `GuardianControllerRepair`에 인계한다. 기존 감시 thread와 원본 감사는 보존하고, 동일 운영 감시가 담당하는 사건별 전용 수리 worker를 `thread/start`로 생성하여 별도 repair mirror cwd와 명시 allowlist를 초기 설정한다. 기존 감시 세션의 세 룰 계약을 `thread/resume`으로 덮어쓰지 않는다. 현재 허용 파일은 task-workflow.mjs·task-inputs.mjs·신규 task-progress.mjs, tools/prompt15-session-progress-core.mjs·prompt15-progress-core.mjs, 위 세 룰 파일이다. 새 파일은 허용 목록의 task-progress.mjs만 가능하며 기존 테스트·프로토콜/GATES·config·제품·상태·과거 증거·수리 엔진·run/runtime·권한은 수정할 수 없다.

worker ID는 `state.guardian.repairThreadId`와 `threads['guardian-repair']`에 기존 감시 ID와 구분해 기록한다. 같은 사건의 최대 두 수리 시도는 그 worker와 mirror에서 수행하고 기존 감시는 진단 및 수리 결과 재감사를 계속 담당한다. worker는 원래 approvalPolicy와 auto_review를 유지한다. 초기 역할의 계약 충돌 때문에 수리 역할을 분리하는 것이며 플랫폼 승인 반려나 권한 제한을 우회하는 경로로 사용할 수 없다.

수리 turn은 계획·정지 요청으로 끝내지 않고 재현된 결함을 mirror 코드에서 실제 고친다. controller가 고정된 task-progress.test.mjs, task-workflow.test.mjs, vitest-acceptance.test.mjs, vitest-transition.test.mjs를 실제 Vitest로 직접 실행하고, 테스트/보호 identity 불변·동시 변경·신고한 실제 diff를 확인한다. Node CLI·node:test·로그 요약은 이를 대체할 수 없다. 모두 통과해야 운영 코드만 병합하고 `OPERATING_REPAIR_APPLIED`로 fresh controller를 자동 재시작하여 기존 attempt의 다음 미완료 인계를 진행한다. 두 번의 수리 시도 후에도 실패하면 원인·증거를 남기고 병합하지 않는다. 새 사용자 허가는 기다리지 않는다. 제품 PASS 권한이나 외부 승인 우회 권한은 추가하지 않는다.

사용자가 요청한 Vitest 전환은 이전 검증 완료를 추정하는 예외가 아니다. controller는 기존 `verification`의 원본 request·dispatch identity, taskId·review·candidateRoot와 불변 target을 확인하고, 기록된 정확한 thread/turn을 API로 조회해 `interrupted`임을 확인한 경우에만 별도 `verification-vitest-*`로 이동한다. 이 사실은 새 디렉터리의 `legacy-turn-transition.json`과 snapshot.tasks의 verificationTransition identity에 남긴다. 이전 request/dispatch와 산출물은 보존하고 response·판정·실패 횟수를 만들지 않는다. 실행 중·미확정·완료됐으나 응답을 잃은 turn, 변경된 입력, 기존 Vitest 작업의 단순 재시도는 이 전환으로 해제하지 않는다. 과거 `repair-ready.json`의 코드 pin이 낡았거나 Node 검사라면 새 수리 통과 근거로 재사용하지 않고 진단을 남긴 뒤 현재 차단을 guardian에게 전달한다.

재시작 감사의 `snapshot.operatingRepair`는 status·sourceAudit·receiptIdentity·summary로 실제 수리 receipt를 연결한다. 원본 감사·완료 구현·판정은 그대로 보존하며 수리 성공 주장만으로 다음 태스크나 REVIEW를 PASS 처리하지 않는다.

## 결과와 총괄 인계

모델의 최종 결과 schema는 기존 `decision`, `summary`, `ruleChanges`, `reason`에 아래 `recovery`를 추가한 다섯 필드를 모두 요구한다.

```json
{
  "action": "none | reassign_task | hold_external | repair_controller",
  "taskId": "15-01 또는 복구 불필요시 빈 문자열",
  "evidencePaths": ["인용한 실제 차단·수리·룰 파일의 경로"],
  "reason": "복구 판단의 실제 근거"
}
```

`reassign_task`는 실제 룰 diff와 `decision=reload`, 같은 taskId의 확정 BLOCKED turn, 원래 차단 응답·모든 supplied repair evidence·변경한 룰 파일의 명시적 인용이 모두 있어야 한다. 구현 `status=blocked`, 배정 `action=blocked`, 검증 `verdict=blocked`는 각각 보존한다. 원문 기준이나 제품을 수정하거나 제품 FAIL을 운영 분류로 바꿔 이 조건을 만족시킬 수 없다. 같은 입력의 반복 구현을 허가하는 신호로 사용하지 않는다.

권한·플랫폼 반려·필수 외부 입력은 `decision=hold`, `action=hold_external`이며 자동 재배정할 수 없다. controller 코드 결함의 `decision=hold`, `action=repair_controller`는 기존 감시 thread를 유지하고 그 감시가 담당하는 전용 수리 worker 세션의 실제 자동 수리로 인계한다. 이는 사용자 입력을 기다리는 최종 정지 상태가 아니다. 단순 문구 오류도 근본 수리할 수 있고, 권위 상태·증거가 모두 정상인 표시만의 문제는 low advisory로 continue할 수 있다. 미해결 blockedTask·자료 부족·예외·확정 완료 응답 부재는 계속 hold한다.

원본 모델 응답은 `guardian-response.json`에 보존한다. 이전 네 필드 결과의 읽기 호환은 recovery=none을 덧붙인 `normalized-response.json`으로만 처리하며 원본을 덮어쓰지 않는다. `recovery-evidence.json`에는 실제 차단/수리/룰 파일 pin과 변경 전후 룰 patch를 연결하고, 이 파일과 정규화 결과의 identity를 최종 audit receipt에 저장한다. 복구 제안은 제품 검증 PASS나 후속 태스크 해제를 대신하지 않는다.

`audit-result.json`은 다음을 포함한다: auditId·runId·guardianThreadId, 관찰 snapshot identity/revision, taskId·review·targetId, 실제 도구/turn 시각, auditStatus(`healthy|issue|repaired|blocked`), severity, findings, requestedAction(`continue|hold|reload|operator-input`), 다음 검사 조건. 각 finding은 원인·재현·실제 결과·영향·증거 identity·수정 파일 before/after hash·검사 결과를 연결한다. guardian turn의 확정 완료 응답 identity도 총괄이 별도로 저장한다.

수정했다고 주장한 파일이 허용 범위를 벗어나면 hold한다. 결과의 auditId/runId/관찰 identity가 배정과 다르면 재사용하지 않는다. 감사 verdict는 제품 acceptance schema에 넣지 않는다. 자료가 부족하면 필요한 증거를 적고 issue/blocked로 반환한다. `healthy`는 모든 프로젝트 검증이 성공했다는 뜻이 아니다.

총괄 외의 제품 구현자·제품 검증자에게는 직접 메시지나 배정을 보내지 않는다. 사용자에게 보이는 progress/Discord는 guardian의 실제 연결/마지막 검사/미해결 운영 문제와 제품 태스크 상태를 구분해 표시한다. 통신 비밀은 출력하지 않는다.
# 과거 v14 운영 변경 (호환 설명)

정상 태스크의 배정·인계는 제어기 기계 검사이며 매번 guardian 모델을 호출하지 않는다. guardian은 장애와 전체 REVIEW 경계에서 판단한다. controller-vitest의 공식 태스크 판정은 제어기 소유의 고정 suite와 실제 실행 결과로 생성한다. 별도 task verifier 세션은 퇴역 기록이다. 코드 수리 allowlist에는 task-workflow/task-inputs/task-progress, task-contracts, controller-task-verification, operating-recovery, turn-reconciliation, run-target-checks, bounded-output, run, tools/prompt15-runtime과 기존 진행 표시·세 운영 룰이 포함된다. 수리 엔진의 `REPAIR_FILES`가 실제 권한 목록이며 제품·기능 기준·config·승인 정책·기존 검사·과거 증거는 계속 보호한다. 수정·검사·fresh reload 뒤 원래 작업의 실제 새 검증/PASS를 확인해야 사건이 해결된다. 아래 과거의 정상 인계별 모델 감사와 좁은 수리 목록은 호환 모드 설명이다.

