# Prompt 15 simple-loop orchestrator

The 2026-10-28 user decision in
[prompt15-numerical-deferral.json](prompt15-numerical-deferral.json) defers
the known six-country numerical micro-geometry findings. Do not resume a
repair loop for those findings alone. Subsequent development is authorized
under that recorded debt; historical FAIL receipts are not converted to
PASS. This documentation does not change the controller state machine or
automatically advance a stopped run.

This is the second-generation Prompt 15 controller. It intentionally implements the same loop used during successful manual work:

```text
implement -> independently verify -> pass
                     |
                     +-> product fail -> implement next bounded attempt
```

## Non-negotiable routing

- An implementation `blocked` result always goes to verification.
- A verifier `product` failure returns directly to a fresh implementer session.
- A verifier `operating` failure stops the controller as `operating_failure`.
- There is no automatic recovery, Guardian call, Supervisor audit, task advancement, or REVIEW decision.
- A stopped or operating-failure run stays stopped until an explicit command.

## Roles

- Implementer and verifier are the only roles on the normal path.
- Supervisor is optional for an explicitly requested plan or final summary.
- Test preparer is optional when a task has no executable verification contract.
- Guardian is optional and human-triggered after an operating failure.

Each product attempt gets fresh model sessions and receives only the task contract plus the latest compact verifier failure. Conversation history is not reused across attempts.

## PASS

The controller rejects a verifier PASS that lacks positive current-byte command evidence. Task 15-18 additionally requires:

- `buildAllowed=true`
- SVN source and traced counts both 193
- missing, duplicate, and unresolved counts all zero
- component/hole and protected-overlay correspondence
- missing-identity and unresolved fixtures rejected

The verifier must save a separate JSON verdict artifact. The controller reads it, compares it with the structured response, and hashes all evidence before applying the state transition.

## Commands

```powershell
node scripts/prompt15-orchestrator/run.mjs start --task 15-18 --seed <preserved-candidate>
node scripts/prompt15-orchestrator/run.mjs status
node scripts/prompt15-orchestrator/run.mjs stop
node scripts/prompt15-orchestrator/run.mjs resume
node tools/prompt15-progress.mjs once
node tools/prompt15-discord.mjs watch
```

An `operating_failure` requires `resume --ack-operating` after a human has fixed the cause. This flag does not grant product PASS or change acceptance criteria.

A `waiting_input` run stays idle without model calls until a human supplies the requested input and runs `resume --ack-input`. `status` and an unacknowledged `resume` show the pending `requiredInput`. Acknowledgement checks only the saved waiting response identities and the matching phase/attempt, then resumes that same phase in that same attempt. It does not infer that inputs are ready, revalidate every product artifact, advance the task, or grant PASS. The original request and acknowledgement are retained in state and events; `requiredInput` is cleared only after the checks succeed.

The progress renderer reports every session's status and latest five messages plus the global latest five. The Discord watcher edits one fixed message every 20 seconds; it refuses to create additional messages when the fixed message ID is unavailable. Operating-error text is bounded to a short prefix.

## Preserved legacy evidence

Legacy runs under `reports/prompt15/orchestration/` are immutable historical evidence. The v2 controller writes only under `reports/prompt15/orchestrator-v2/` and never imports legacy status as a PASS basis.
