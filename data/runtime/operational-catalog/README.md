# Operational catalog runtime inputs

`current.json` is the authority for the active catalog. It pins an immutable
artifact index by SHA-256 and byte length; every requested asset is verified and
missing or altered assets fail closed.

The experimental CHN addition is
`catalog-v3-prompt19-incremental-CHN-95ea496a8aa66910a9a7`, packaged under
`data/derived/prompt19/mixed-world-v2-95ea496a8aa66910a9a7/`. It contains 8,005
cells and 26,273 edges. CHN has 3,320 cells (3,313 fine and seven explicit fallback
cells) from 2,850 source families. The KOR 322 and PRK 194 cells retain their IDs,
parents and source lineage. CHN–PRK and KOR–PRK borders have fine cells on both
sides throughout. The candidate and active pointer remain distinct until all
required proofs pass and explicit activation succeeds.

CHN uses the fixed geoBoundaries/OSM ADM3 revision
`9469f09592ced973a3448cf66b6100b741b64c0d`, distributed under
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Attribution: © OpenStreetMap contributors; geoBoundaries / William & Mary geoLab;
Lee Beryman / Wambacher. Public derivative database use must retain notices,
include the ODbL URI and provide the machine-readable derivative or alterations
under its terms. This database license does not license the program code.
The source metadata reports 2017, while its original archive records processing
in 2021. It is an experimental geometry reference for the 2020 scenario, not a
certified 2020 administrative snapshot. The 1,201 source units without a proven
macro parent remain explicitly unresolved. The seven CHN fallback cells are
five retained islands (about 17.30 km²) and two bounded coastal residuals (about
4.58 km²), about 21.89 km² total. These are gameplay residuals, not invented
administrative facts or a claim that all coastal strips disappeared.
See [the source decision](../../../reports/chn-2020/source-decision.json) and
[the fallback classification](../../../reports/chn-2020/final-fallback-classification.json).

Use `git lfs pull` after cloning to obtain immutable joined input snapshots.
`scripts/chn-2020/prepare-china.py` and `incremental-coordinator.mjs` add CHN only
to a hash-pinned active baseline; they are not a generic country-argument tool.
`npm run data:korea` retains its KOR/PRK workflow. `npm run data:world` requires
matching input and verification pins and refuses activation if any currently
fine country would be dropped. Historical `--no-activate` packaging remains
possible. Incremental packaging requires explicit `--activate`; existing
immutable outputs are verified rather than overwritten.

Partition construction and geometry reconciliation happen offline. Runtime topology uses a
hash-verified incidence index and loads only the edge shards required for a
contact. Exact cell-detail shards let turn deltas fetch their requested cells.
Ordinary selection uses the verified vector tiles; optional inspection detail
loads only the settled viewport in debug mode at zoom 7 or higher. Identical
scopes reuse parsed cells and edges without source retessellation. The legacy
explicit full-country loader remains available for tooling. The initial
overview is separate from vector tiles loaded by viewport and zoom. Micro
boundaries are hidden in normal mode and visible in map debug mode. After
execution, measured cold/warm timings and actual tile, play and browser evidence,
together with exact `--no-activate` replay commands, belong in
[the final report](../../../reports/chn-2020/final-report.json).
Proofs must match the candidate bytes; zero overlap alone is insufficient.

Existing games are not migrated to the new IDs. Before activation, local
maintenance writes the initial and current simulation/world plus complete
undo/redo history and original catalog references to the ignored private
`data/runtime/operational-game-checkpoints/` directory and retains old in-memory
pools. The [preservation receipt](../../../reports/chn-2020/live-game-preservation.json)
contains metadata and hashes only. Recovery requires the original catalog and
private checkpoint; continued old-catalog gameplay and automatic disk restoration
after process restart are not promised. The dedicated new-game local app is
`http://127.0.0.1:3002`; the previous running app is retained separately.

CHN's normal-mode province contours use a separately accepted, server-only
presentation index (`province-render-f1c91c059cdb06f5234f/index.json`). Its exact
bytes bind the full source-backed grouping and independent proof. The bootstrap
publishes only 994 shared-edge ordinals and their presentation digest, separate
from verified administrative ordinals. No catalogRef, cell geometry, source
parent, military cap or game state changes. The consumer unions the two display
sets for the existing white line style; county lines remain debug-only.
The 1,663 verified source memberships stay fixed. Another 1,025 families satisfy
active-area presentation coverage, and 150 inherit a strongly matched raw
family's display group through existing gameplay geometry gains. These are not
new official memberships. Twelve uncertain families and seven source-free cells
(33 cells total) stay unassigned. Source dates remain mixed, not certified 2020.
See [the display verification](../../../reports/chn-province-20261030/verification/independent-v2.json)
and [worldwide capacity audit](../../../reports/world-micro-scale-20261030/scaling-audit.json).
Future catalog changes must revalidate and rebind this presentation index;
stale catalog, metadata or incidence identities fail closed.

Debug micro lines are now restricted to the hovered country's current map
identity (owner, otherwise controller) and its direct positive-land neighbors.
The small metadata index is built on first debug hover and caches eight scopes;
ownership changes update only incident edges. Both vector and exact micro layers
use the same edge filter; selection is independent, and sea/no-hover clears it.
Optional high-zoom inspection follows hover and uses cell shards only when
available, retaining existing fine PBF lines otherwise. It never invokes the
whole-country fallback from hover. Base tiles still contain fine geometry.
