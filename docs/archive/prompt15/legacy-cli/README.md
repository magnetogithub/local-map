# Retired Prompt 15 recovery commands

These five commands belonged to the historical controller under
`reports/prompt15/orchestration/`. They depended on the removed `atomicJSON`
and `validateIdentities` APIs and an incompatible controller-state model.
Two also imported the retired `product-target.mjs` or `app-server.mjs` modules.
No current package command or live source import uses these recovery helpers.

| Retired command | Former operation |
| --- | --- |
| `scripts/prompt15-prepare-15-18-resume.mjs` | Prepare the old 15-18 repair and reset stale runtime owners |
| `scripts/prompt15-reconcile-review-b.mjs` | Adopt the historical REVIEW B certificate |
| `scripts/prompt15-reconcile-15-18-restart.mjs` | Invalidate the old 15-18 result and reset later tasks |
| `scripts/prompt15-reconcile-stopped-dispatch.mjs` | Inspect and interrupt an old native dispatch |
| `scripts/prompt15-record-v18-result.mjs` | Write the historical V18 failure into old controller state |

The existing paths now print `LEGACY_CLI_UNSUPPORTED` and exit with code 1.
They ignore former arguments, read no run state, write no receipts, and start
no controller or Codex process. Importing a stub has no effect. Historical
reports, FAIL verdicts and controller states remain unchanged.

Current second-generation runs use `scripts/prompt15-orchestrator/run.mjs`
and the existing package commands. Inspect a current run with:

```powershell
node scripts/prompt15-orchestrator/run.mjs status --run <v2-run>
```

The same entry point owns `start`, `stop` and `resume`. The current workflow and
human acknowledgement rules are documented in
[prompt15-orchestration.md](../../../automation/prompt15-orchestration.md).
These commands operate on `reports/prompt15/orchestrator-v2/`; they do not
migrate a historical run or replace the retired manual reconciliation steps.
Support retirement does not authorize starting or resuming any run.

The original five files are preserved in Git at commit
`c7eb273198925d5f12ce1b0946174e86f1e3f0f4`, each under its original path above.
For example, inspect the original source without restoring an executable:

```powershell
git show c7eb273198925d5f12ce1b0946174e86f1e3f0f4:scripts/prompt15-prepare-15-18-resume.mjs
```
