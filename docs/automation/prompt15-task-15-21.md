# Task 15-21: immutable LOD and delivery candidate

The offline generator consumes the pinned 15-19 `ae59d85d8dedbafc44f6`
catalog and 15-20 `22406931e1665b6ede05` indices. It checks the complete
indexed file sets, SHA-256 hashes, byte lengths and matching PASS draft
summaries before generating a separate content-addressed directory. Existing
catalogs, production assets and runtime imports are unchanged.

```powershell
node --test scripts/prompt15-world-delivery.node-test.mjs scripts/prompt15-world-indices.node-test.mjs
node --expose-gc --max-old-space-size=8192 scripts/prompt15-world-delivery.mjs
node --expose-gc --max-old-space-size=8192 scripts/verify-prompt15-world-delivery.mjs <output-root> <new-report-path>
```

Generation refuses to overwrite either a finished candidate or its staging
directory. Failed builds retain staging evidence and never rename it to an
admitted candidate. Reports use exclusive writes. The output key includes
input index identities, generator/dependency identities, frozen policy,
runtime versions and the captured upstream verification report identities or
their absence. Repeating the build with those same immutable inputs must use
a different `outputBase`; task 15-23 owns the independent whole-world byte
comparison.

## Assets and identity

| Asset | Contract |
| --- | --- |
| `tiles/{z}/{x}/{y}.pbf.gz` | All 5,461 z0–6 coordinates, including empty tiles; lossless gzip around PBF, extent 4096, tolerance 3, buffer 64. |
| `detail/countries/{countryId}.geojson.gz` | Every original cell polygon and hole, with its global positive cell ordinal as feature ID. No quantization or simplification. |
| `metadata/countries/{countryId}.json.gz` | Sorted cell ordinal → canonical cell ID, administrative parent ordinal and previous geometry parent ordinal. |
| `detail/topology/{bucket}.json.gz` | Every original topology edge, canonical ID, global ordinal, positive adjacency, boundary flags and exact geometry. |
| `metadata/edge-incidence.bin.gz` | Complete left/right cell ordinal pairs, indexed by global edge ordinal; uint32 little-endian pairs, 8 decoded bytes per edge. |
| `metadata/parents.json.gz` | Complete administrative and previous-parent descriptors, preserving residual identities and original source provenance. |
| `lod-coverage.json.gz` | Actual decoded overview coverage and explicit missing cell/edge ordinal lists. Exact coverage must be complete. |
| `manifest.json`, `tile-index.json`, `detail-index.json` | Same immutable catalog ref, source roots and render root; indexed overview and lazy exact detail paths. |
| `delivery-index.json` | SHA-256 and byte length of every delivered asset; delivery root and total. |
| `artifact-index.json` | Complete candidate file census, including build-only summary/provenance and delivery index. |

The `catalog-v3-*` ref and task-specific schema deliberately distinguish this
candidate from the current catalog-v1 browser protocol. Runtime integration
belongs to tasks 15-37/15-38. No API, migration, browser, REVIEW C or production
cutover acceptance is implied by generating or verifying these files.

Generation groups exact topology edges into 16 spatial work buckets before
tiling, instead of tiling each of the 256 globally dispersed topology shards.
Every edge is assigned to one work bucket and is still clipped to all of its
intersecting tiles, including map wraps. Administrative tile features are
selected from the same clipped edge features at zoom 4 and above. Final
features remain sorted by global ordinal; no source boundary or physical
resolution criterion changes. A regression fixture compares the clipped
coordinates, IDs and administrative incidence against unpartitioned tiling.

## Rendering semantics

`territories` uses numeric cell ordinals. `edges` uses numeric edge ordinals,
`c` source boundary class and `a` administrative flag. Resolve its left/right
cell ordinals from the complete binary incidence index at
`(feature.id - 1) * 8`, rather than repeating the pairs in every tile and zoom.
The right ordinal zero denotes coast. Class codes are, in order, coast, country, administrative, operational,
and residual. The manifest declares country/coast styling independently of
real administrative lines. The separate `administrative` layer is absent
below zoom 4. Optional synthetic cell lines default to hidden and have a
minimum display zoom of 8 (overzoom or exact detail).

A current occupation front is **not** a static source boundary class. The
consumer must derive it from `r > 0` and unequal current controllers of the
incident cells. The same-controller internal edges remain invisible. No
owner, controller or occupation colour is baked into the assets.

Serve `.pbf.gz` as a gzip payload (`application/gzip`) without an HTTP
`Content-Encoding: gzip` header. The future protocol must verify the
compressed artifact's indexed hash/length, then decompress it before passing
PBF bytes to MapLibre. This avoids confusing transport identity with the
decoded vector bytes. The manifest specifies this explicitly. Per-zoom
counters report both compressed and decoded byte lengths.

Topology transport uses the task 15-21 schema and records its source schema.
It omits only the coordinate-derived `lengthKm` field, declared in both the
policy and detail index. Exact coordinates, canonical IDs, ordinals, flags
and incidence remain unchanged. Authoritative graph distances remain in the
original 15-20 data; this rendering transport does not replace that index.

Small positive source faces and short edges can collapse under integer tile
quantization, even at geojson-vt's maximum zoom where tolerance becomes zero.
The generator removes zero-length lines, zero-area rings and nonpositive-fill
polygons from overview tiles and reports the resulting omissions. It never
fabricates a minimum-size shape. Exact indexed detail remains authoritative
for detail display and changed-cell projection. A consumer must implement
that path before claiming complete interactive coverage.

## Verification and limits

The verifier reopens the complete candidate and upstream trees, validates
every indexed hash/byte length, rejects extra or missing files and unsafe
paths, compares every exact cell geometry and metadata row to the pinned
catalog/order, and compares all exact topology shards to 15-20. It then
decodes every PBF, checks positive geometry, canonical ordinal ranges, exact
incidence/class flags, zoom visibility, and the actual overview omissions.
It recomputes render/delivery/source roots and byte totals independently of
the summary's PASS flags. Re-tiling independently is reserved for 15-23.

The frozen 512 MiB render budget includes **all** delivered PBF, exact detail,
metadata, manifest and index bytes, including `delivery-index.json`. The
220 MiB initial metadata budget conservatively includes the manifest,
all three delivery indices and the compressed complete incidence index. Full geometry and parent/cell metadata are lazy,
not required bootstrap downloads. Measurements concern offline assets;
server/browser/provider performance remains for the later assigned tasks.

The current checkout lacks the independent V19/V20 report files named by
the preceding pipeline. The generator records their absence explicitly as
`formalDependencyAcceptance: missing-independent-reports`; a draft input
summary and current-byte verification do not substitute for those approvals.
Obtaining those reports and REVIEW C acceptance remains a separate gate.

## Manual country batches and the next gate

The five manual country reports in
`reports/prompt15/15-21-country-batches/batch-01` through `batch-05` cover
50/50/50/50/47 countries in the pinned catalog order. Their scope is
`country-exact-detail-only` and their candidate is the preserved staging
directory `.15-21-staging-c42be73c8e286a29dc47-14340`. Keep that directory and
the reports unchanged. Applying those results to a newly generated candidate
requires matching the corresponding exact asset bytes; shared code changes
alone do not prove or disprove the validity of unchanged per-country assets.

The user's current stop boundary is **before the next independent common
verification**, after generation. At that boundary, record the completed
candidate, generated counts and byte totals, the previous reports and the
remaining common checks. Do not automatically run the full verifier, start
15-22, or declare 15-21/REVIEW C PASS. The common gate must cover the topology
detail, parent transport, PBFs, actual overview omissions, delivery/index roots
and budgets, as well as the identity mapping needed to reuse country evidence.
