# Task 15-22: country preservation, geometry and topology audit

## Current user decision — 2026-10-28

The user explicitly deferred the known numerical micro-geometry findings and
authorized subsequent development, reopening them only if an actual problem
appears during that work. The decision is recorded in
[prompt15-numerical-deferral.json](prompt15-numerical-deferral.json) and in
the source Prompt 15. It takes precedence over repair-before-continuation
instructions for these known findings.

CIV, FRA, GBR, MYS, UKR and VNM are tracked as `DEFERRED_BY_USER` for the
investigated numerical findings. Do not repeat country generation/audits or
extend exact-intersection repair merely to eliminate the same microscopic
differences. Repetition of a known strict audit/guard failure alone is not
a reason to reopen the issue. Use the existing admitted 15-21 artifacts as
the development baseline; incomplete regeneration proofs are not replacements.

Reopen on an observed map, occupation/front, ownership, connectivity,
adjacency or runtime problem attributable to the deferred finding. Other new
failures still need their own assessment. The 23 sliver countries are not
automatically deferred. Historical tracking remains 29 unpassed countries,
with 6 numerical countries deferred and 23 sliver countries pending; this
is not a fresh current-code world census.

This is a development scheduling decision, not a rewritten audit verdict.
Strict runner implementations, frozen policy, approved pins/artifacts and
existing reports remain unchanged. They may still report FAIL. Do not forge
a PASS, claim task 15-22 complete, or start a world audit/final join simply
to implement the deferral. Carry this decision into later task handoffs.

The audit consumes the admitted task 15-21 candidate
`data/derived/prompt15/15-21-world-delivery-v1-56fc6c79c216e6bd1a11`.
It never regenerates cells, repairs a boundary, changes a candidate, or
publishes anything. Application runtime, API, browser and migration are
outside this task.

## Admission and state

Read the decision pointer first:
`reports/prompt15/15-21-final-join/20261027T122926152KST-receipt-intake/final-admission.json`.
It names `admitted/verdict.json` as authoritative. That verdict is PASS,
upstream verification is VERIFIED, and its native command exited 0. Previous
BLOCKED attempts remain historical evidence; directory names such as `final`
do not determine which decision is current. The audit pins both the admitted
verdict hash/length and the candidate artifact-index hash/length.

Do not reclassify the candidate because its immutable generation-time
provenance records missing upstream reports. The later admitted decision
receives those reports without rewriting the candidate's historical bytes.

Task 15-22 has distinct states:

1. `READY_FOR_COUNTRY_AUDIT`: code/fixtures and input preparation are ready;
   no country geometry audit has run.
2. Batch `PASS`/`FAIL`: only the explicitly assigned countries were audited.
3. Final task `PASS`/`FAIL`: five eligible batches were joined and their
   country/cell/edge universes and global caps checked.

The user runs the five country batches manually in separate sessions. Stop
after preparation before executing the 247-country audit. No implicit world
audit command exists; single-country execution is explicitly marked smoke
scope and cannot be admitted as a batch. A successful join does not start
15-23 or REVIEW C.

## Commands

Run fixture and implementation checks:

```powershell
node --test scripts/prompt15-preservation-audit.node-test.mjs
node node_modules/eslint/bin/eslint.js scripts/prompt15-preservation-audit-core.mjs scripts/prompt15-preservation-audit.mjs scripts/prompt15-preservation-join.mjs scripts/prompt15-preservation-audit.node-test.mjs
```

Prepare a new input snapshot and the five assignment manifests. This reads
admission and indexed directory metadata, not the full country geometry:

```powershell
node --expose-gc --max-old-space-size=4096 scripts/prompt15-preservation-audit.mjs --prepare --out reports/prompt15/15-22-preparation/<unique-run>
```

Each manual session executes exactly one batch using a new output directory:

```powershell
node --expose-gc --max-old-space-size=4096 scripts/prompt15-preservation-audit.mjs --batch 1 --out reports/prompt15/15-22-country-batches/batch-01/<unique-run>
node --expose-gc --max-old-space-size=4096 scripts/prompt15-preservation-audit.mjs --batch 2 --out reports/prompt15/15-22-country-batches/batch-02/<unique-run>
node --expose-gc --max-old-space-size=4096 scripts/prompt15-preservation-audit.mjs --batch 3 --out reports/prompt15/15-22-country-batches/batch-03/<unique-run>
node --expose-gc --max-old-space-size=4096 scripts/prompt15-preservation-audit.mjs --batch 4 --out reports/prompt15/15-22-country-batches/batch-04/<unique-run>
node --expose-gc --max-old-space-size=4096 scripts/prompt15-preservation-audit.mjs --batch 5 --out reports/prompt15/15-22-country-batches/batch-05/<unique-run>
```

Do not paste `<unique-run>` literally: replace it with that session's unique
run name. Existing output directories are never overwritten. Writes are
restricted to new directories below `reports/prompt15/` in the workspace.

| Batch | Source countryOrder slice | Countries | Endpoints |
| --- | --- | --- | --- |
| 1 | `[0,50)` | 50 | ABW–COL |
| 2 | `[50,100)` | 50 | COM–HTI |
| 3 | `[100,150)` | 50 | HUN–MNG |
| 4 | `[150,200)` | 50 | MNP–SMR |
| 5 | `[200,247)` | 47 | SOL–ZWE |

After all five batches pass, supply their **exact** verdict files to the join:

```powershell
node scripts/prompt15-preservation-join.mjs <batch-01/verdict.json> <batch-02/verdict.json> <batch-03/verdict.json> <batch-04/verdict.json> <batch-05/verdict.json> --out reports/prompt15/15-22-final-join/<unique-run>
```

The join does not discover the newest files by timestamp or select an older
PASS over a newer failure. It requires five distinct batch IDs, the pinned
candidate, current implementation and input bytes, successful negative
fixtures, passing per-country check details, and complete disjoint cell/edge
ordinal sets. A failed or smoke-only report cannot substitute for a batch.

## Country checks

### Explicit SVN prepared-source evidence intake

When the logical `reports/prompt15/candidates/SVN-first.json` and
`SVN-second.json` files no longer match the original 15-18 provenance pins,
do not overwrite them or substitute matching geometry alone. A separately
accepted pair of new independent replay outputs may be supplied explicitly:

```powershell
node --expose-gc --max-old-space-size=4096 scripts/prompt15-preservation-audit.mjs --country SVN --prepared-evidence-map reports/prompt15/15-22-svn-evidence/<run>/prepared-evidence-map.json --out reports/prompt15/15-22-svn-evidence/<run>/svn-country
```

The `prompt15-prepared-source-evidence-map-v1` receipt binds the original
logical paths and unchanged approved SHA-256/byte lengths to actual relocated
paths. Both complete report files must match the original pins exactly and
retain the approved v2 policy, all approved checks and the source ID/geometry
trace. The receipt also pins two distinct replay execution records, successful
native command records, the importing wrapper, original replay input files
and dependency identities. Reused process IDs, missing or failed execution
evidence, changed input bytes, incomplete pairs and circular sources block
the audit. The mapping and all consumed evidence are recorded as audit inputs
and checked again before the verdict. New replay provenance must be described
as new independent executions with bytes identical to the old approval,
never as recovered historical executions.

The option is restricted to `--country SVN`. It does not authorize batches,
change approved pins, alter candidate data or make a smoke report eligible
for final join. Do not create the `--out` directory before running the audit.

The runner uses pinned task 15-18 restoration/trace/protected-overlay inputs,
15-19 country catalog and geometry, task 15-20 membership/adjacency/topology,
and task 15-21 exact transport. Every consumed indexed file is hash/length
checked; all consumed inputs are checked again before a batch verdict.

Each country audit performs these checks against actual data:

- Raw and prepared source IDs/hashes connect to restored administrative
  identities and component/hole traces. Administrative and residual parents
  remain separate. The complete ID set is checked, including the fixed SVN
  set of 193; a matching count alone cannot pass.
- Each actual cell resolves to the expected source ID, ordinal, country,
  administrative parent and unique previous geometry parent. Delivered
  metadata and parent descriptors must match full membership. Stored
  memberships are never truncated to the per-action limit of 512.
- Every cell is a positive valid single Polygon component. Physical area,
  conservative diameter and aspect ratio are recomputed in km/km² using the
  fixed authalic sphere. Declared classification and tiny-source exceptions
  are checked against source component geometry.
- Actual cell unions are compared to administrative, residual, protected
  previous and fixed country envelopes. Gap, overlap, outside area, missing
  positive components, filled holes and changed component/hole counts are
  reported. Coverage thresholds are fixed in code before execution. Parent
  coverage uses absolute/relative 1e-9; previous-parent coverage uses absolute
  2e-11 with no relative widening. Boundary distance is 1e-12 degrees and the
  noded interval coverage bound is sqrt(2)*1e-12 + 1e-15.
- Every incident topology edge is checked for source transport identity,
  canonical edge ID, owner references and independent boundary classification.
  Its positive segment must cover a real boundary interval on each audited
  incident cell. Point-only contacts and remote lines cannot become adjacency.
  Ordinary cell boundary coverage and adjacency CSR agreement are checked.
  Exact longitude/pole map-cut closure segments are separately counted;
  canonicalizing a vertical +180 cut must not wrap a horizontal segment.
- Shared binary incidence records must equal the source left/right ordinals.
  Every incident side is audited in its country's batch; an edge is assigned
  for final census only to the source country of its left cell.
- Country cell caps, physical resolution and frozen sliver gates are applied.
  A prior generation summary PASS does not override a newly failed audit.

These are computations on immutable inputs. JSTS union/overlay results are
temporary audit evidence, never new authoritative source geometry. Geometry
exceptions become explicit failures; the audit never drops a positive
component, merges source identities, guesses ownership or raises a tolerance.
Numerical repair ledgers do not automatically excuse component/hole loss.
Such a failure needs review at its originating policy/input checkpoint.

### Previous-parent metric and local numerical correspondence

The approved V20 `2e-11` area bound is applied to
`abs(Kahan(sum(cell polygon area)) - (source old-parent area + signed pinned repair delta))`
in degrees squared. The legacy V22 gap/outside overlay checks remain the
default. If only those two checks fail, all component/hole/support/nonempty
and overlap checks already pass, and complete pinned V19/V20 evidence is
available, V22 can reconcile the different metrics without raising a bound:

- Recompute the V20 formula and require exact correspondence with its pinned
  old-parent descriptor, geometry hash, country/parent identity, signed ledger
  and cell sum. Duplicate, changed or unsupported repair evidence fails.
- Require the admitted independent V20 receipt, its matching repair/area roots
  and all relevant approval/noding checks. The historical verifier identity
  stays in that receipt; the current verifier is not executed or reapproved.
  The actually reused boundary helper code must match the original V20 pins.
- Check every edge of every positive gap and outside polygon separately
  against the original old-parent boundary with the existing `1e-12` degree
  distance and fixed-grid interval bounds. Area cancellation is insufficient.
- An unmatched edge can use only a specific pinned V20 protected-transfer
  segment, with matching owners, old parents, source-component hash chain,
  repair geometry hash and area. Recompute that witness's source/assigned
  boundary correspondence within its already-approved local repair policy.
  The wider local bound never applies to unrelated edges or geometry.

Unsupported or missing evidence cannot excuse a difference. Positive source
component loss and hole fill remain failures regardless of area or ledger.
The additive V20 descriptor field `cellUnionArea` is an area sum, not a newly
computed union; V22 continues reporting actual union, gap/outside and overlap
separately. Existing PASS receipts retain their original implementation pins
and are not automatically reapproved by this reconciliation.

## Bounded execution and evidence

Each batch streams topology shards into private country cache files and
loads one country's incident edges for its geometry audit. Global ordinal
metadata is compacted with shared parent/country strings. Other-country cell
metadata is reference context; it is not counted as audited country geometry.
The source/candidate folders remain read-only. Actual peak RSS and elapsed
time are recorded; `--max-old-space-size` is a process heap setting, not an
assertion that a memory budget passed.

Each batch output contains native fixture execution evidence, private
`topology-inputs`, one country JSON result per assignment, and `verdict.json`.
Country failures are saved and remaining assigned countries continue. A
shared input failure makes every affected result explicitly fail. Reports
include actual geometry check evidence and cell/owned-edge ordinal arrays;
the final join verifies their whole-world union and fixed world caps.

The synthetic fixture suite exercises positive partitions and rejects:
193-count ID substitution, shared/empty/wrong-parent membership, 512
truncation, province-sized cells, gap/overlap/cross-border faces, missing tiny
islands, filled holes, nonshared/remote edges, missing topology boundaries,
wrong adjacency, fabricated tiny-source claims, dateline false contacts,
invalid batch selection and missing/duplicate/out-of-range join evidence.
The raw/restored/delivered adapter also has a fixture that rejects altered
metadata and source geometry hashes before the geometry audit.

Unit tests and preparation alone do **not** establish task 15-22 PASS.
Actual country audits and the final join remain required. Render regeneration
and independent byte determinism belong to 15-23, not this runner.
