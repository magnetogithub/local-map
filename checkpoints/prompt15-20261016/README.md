# Prompt 15 source checkpoint — 2026-10-16

The user stopped orchestration before REVIEW B passed. This checkpoint preserves
the implementation sources without generated catalogs, command logs, model
transcripts, native session state, or experiment output data.

## State at the stop

- REVIEW A has an approval certificate. The latest independent REVIEW B result
  is B-3 FAIL; no B approval was issued and task 15-18 has not started.
- Task 15-13 attempt 005 returned BLOCKED. Its own Troms measurements report
  generation time changing from 42.35 s to 4.19 s and maximum aspect ratio from
  19.85 to 19.00. These are candidate measurements, not independent acceptance.
- Troms still fails depth, contact width, connectivity, and retained interior
  checks. The candidate also lacks `source-samples.mjs`, which its frozen suite
  imports. No official task Vitest result exists for that candidate.
- The latest operating repair returned a patch, but its controller regression
  run was interrupted by the user stop. That patch was not applied to the live
  operating sources and is not verified for release.

## Saved sources

- `review-b-base/` contains 34 operational-cell source/configuration/documentation
  files and three identity/model files copied from `work/review-B-4`. This is the
  preserved integration source, including the implementations that failed B-3;
  its directory name does not imply REVIEW B approval.
- `task-13-attempt-005/` contains exactly the four changed implementation source
  files from the blocked repair candidate. It is a draft delta, not a runnable
  standalone checkout. It has not been merged into `review-b-base/`.
- `pending-operating-repair/` contains the two returned operating source files
  whose full regression run was interrupted. They are not replacements for the
  root orchestrator files until separately verified.
- `source-manifest.json` records the SHA256 and byte count of each copied file,
  together with its relative location in the original local run.

The original run is `20261015T115644-KST-eae9ad74`. Its local receipts, inputs,
frozen suites, artifacts, and stop marker remain under the ignored
`reports/prompt15/orchestration/` tree. They are required to resume that exact
run. A fresh Git clone cannot reconstruct approvals or resume the run from this
source checkpoint. Do not manufacture receipts, reduce thresholds, or restart
automatically. Continue only after an explicit user request.

The root `scripts/prompt15-orchestrator/`, `automation/prompt15/`, and `tools/`
contain the operating implementation saved at the stop. See
`docs/automation/prompt15-orchestration.md` for its execution contract.

## Checkpoint validation

The root operating implementation passed its existing 25-file regression suite:
308 tests passed, with zero failures, skips, pending tests, or errors. Selected
test inputs were unchanged and every selected file executed. Syntax checks passed
for 135 saved JavaScript modules. This validates the operating checkpoint, not
REVIEW B or the pending operating repair.
