# Pre-experiment scoring contract (15-12)

`scoring-policy.json` is the fixed criterion set, not a selected generator or a
measurement result. `policy-validation.mjs` checks its exact SHA-256 before use,
deep-freezes it, and rejects a measurement bound to any other digest. The freeze
CLI verifies the source input manifest and exclusively creates a new receipt with
zero candidate results consumed. The controller pins these bytes before 15-13/14
experiments. Experiments must record the receipt digest before measuring; an
experiment cannot supply its own thresholds. This receipt alone does not prove
external chronology: the controller's immutable handoff provides that ordering.
No candidate has been measured or selected in this task.

Physical resolution is at most 8 km diameter and 32 km2 area for **both border and
interior** cells, maximum aspect ratio 20. Against the representative advance
W=40 km the diameter/W ratio is at most 0.2, with at least five distinct reachable
depth stages in both border and subsequent interior graph experiments. W is a
test scale; user requests are not all interpreted as W or as 50 km. The limits
are chosen to make several advances possible within a large province rather
than consume it as one cell. Two cells alone are insufficient evidence.

Distances are ellipsoidal geodesic measurements or a pinned metric projection
with a certified relative error at most 0.5%, including the actual sample's high
latitude and antimeridian handling. Coordinates in degrees must first be
transformed by the pinned measurement implementation, never relabeled as km.
Use conservative diameter (farthest points including segment interiors), area
and aspect bounds over complete geometry, not only centroids or average cell
size. Aspect is maximum extent divided by minimum positive width. Report both
actual extrema and error bounds; comparisons use conservative upper bounds.
Slivers are cells below 0.01 km2: count fraction <=5%, area fraction <=0.1%,
reported per country and per parent, with every component/hole preserved.
Never merge across protected administrative/previous-territory boundaries.

| Extent | Depth km | Along-front width km | Max area km2 | Max fraction per admin | Min retained interior fraction |
| --- | --- | --- | --- | --- | --- |
| near | 8–40 | 24–120 | 2400 | 0.25 | 0.75 |
| limited | 40–80 | 24–160 | 6400 | 0.50 | 0.50 |
| deeper | 80–120 | 24–200 | 12000 | 0.75 | 0.25 |

Depth is the shortest land-connected advance from the approved starting
frontier; width is contiguous along-front arclength, not longitude or bounding
box width. Supply certified lower and upper bounds, never graph hop count
relabeled as km. Graph approximation must bound the actual geometry depths and
widths. Current-control-frontier evidence is required after the first advance;
source-border evidence is for the initial advance. Point/sea/remote connections
are invalid. The area ratio applies separately to **every affected admin** and
retained interior means actually untouched inward land, not all unselected islands.
Use representative large admin witnesses (area >=9600 km2 AND diameter >=80 km)
in border and interior experiments, plus small-region witnesses. A tiny remainder
cannot satisfy these rules. Whole membership is rejected. A physically impossible
minimum scope fails with a smaller-scope explanation; it is not widened to a whole
small country/province. These are server policy candidates to implement in later
lookup tasks, not runtime lookup behavior added here.

No unsplit exception geometry is approved yet: the explicit approved pin list is
empty. Potential source-small-island/micro-component exceptions must have source
area <=1 km2 AND diameter <=2 km, per-country exception area <=0.1% and cell count
<=5%. Every geometry/source pin and reason must be reported for review, never a
whole country or a failed large province. Eligibility alone is not approval and
does not waive selection ratios, identity, holes, protected overlays or coverage.
15-14 must inventory candidates; 15-17 records an explicitly reviewed version if
necessary, invalidating affected earlier scores. The policy cannot silently grow
an exception list while scoring a failed candidate.

The JSON budget sets independent maxima for cells, vertices, positive edges,
memberships, each artifact category, metadata/index, tiles, generation time/heap,
server decode/lookup/validator/authority/history/undo, browser transfer/decode/heap/
load/pan/zoom/update, and provider tokens/calls. It includes the cost of IDs,
provenance, indexes and complete memberships, not just polygon coordinates. The
world ceiling of 12M cells allows several million cells for roughly tens of km2
granularity; the country ceiling is 1.5M. These are **pre-measurement cost targets**,
not proof of feasibility or permission to raise existing production caps. The
explicit finite byte/time ceilings are rejection criteria for the later cost
comparison (15-16), actual world build and final performance tasks. Do not select
a mesh without measuring its representative cost and reporting extrapolation
uncertainty. Compare actual world counts/bytes later, not extrapolations as PASS.

Aggregate commit remains 512 distinct changed cells across the **whole batch**;
it is independent of stored membership and world/country counts. Near must fit
that cap while satisfying all physical/extent criteria. Pagination, tokens and
multiple effects cannot turn an over-cap selection into success. No truncation.
This task does not change runtime schema, authority or cap. 15-30 and REVIEW D
must demonstrate a real near request. If measured near cannot fit, return to the
policy checkpoint before an explicit consistent contract revision.

Measure p95 over at least 30 warm repetitions, plus cold initialization; record
machine, viewport, device scale, scenario and baseline identity. The final task
must use the same baseline device/scenario and report both absolute results and
deltas. Wall/peak measurements include topology, membership, LOD and indexes.
Provider ceilings reserve two lookups, one initial submit and at most one repair;
tokens are whole-request input/output totals including tool payloads. Budget
metrics must all be supplied: an absent value is not zero and cannot pass.

Required representative coverage: KOR/PRK, SVN, other-continent land neighbours,
large inland country, high latitude, antimeridian, island/hole and small country,
plus all fixed upstream witnesses. 15-14 must apply the physical/sliver gates to
every country/parent sample, and selection gates per affected admin for every
extent at initial and subsequent frontiers. `assessMeasurement` scores one supplied
observation; it does not certify artifact bytes, compute geometry, check witness
coverage or issue a whole-candidate PASS. Its evidence pins must be checked by the
experiment caller. Tests use synthetic scalar observations only to test rejection
logic, not as geography or performance evidence.

Any gate failure rejects the candidate. Do not adjust thresholds after results.
An explicit policy checkpoint revision must retain the old bytes/results and
invalidate dependent measurements before re-generation. No production tool,
migration, map E2E, world build or new publication is required or performed here.

CLI (candidate cwd):

```text
node scripts/operational-cells/policy-cli.mjs freeze .reports/15-12/input-manifest.json .reports/15-12/freeze-receipt.json
```

The submitted Vitest suite is executed by the controller, not by this CLI.
