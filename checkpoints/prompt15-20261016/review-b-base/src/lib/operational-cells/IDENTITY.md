# Offline cell identity and provenance v1 (15-15)

`identity.ts` implements the offline contract in `model.ts`. It neither chooses
a partition policy nor changes the prerequisite partition prototype or runtime.

`createCellIdentity(face, provenance)` produces a SHA-256 TerritoryId with the
existing `territory:catalog:` prefix. It binds the source country, exact source
administrative tuple (or explicit no-source evidence), unique protected previous
geometry parent/catalog reference, canonical geometry, and content provenance.
The two parents remain distinct. Source-only prototype samples have no approved
previous parent and cannot masquerade as migration-ready cells.

Canonicalization validates the supplied planar polygon with JSTS. It normalizes
negative zero, ring start and winding, hole order, component order and the
Polygon/singleton MultiPolygon wrapper. Shell and hole roles remain distinct.
Every coordinate and every collinear noding vertex is retained. There is no
epsilon, rounding, simplification, topology repair or component removal. A changed
vertex/segmentation therefore changes identity, even if a geometric union could
be equivalent. Invalid, empty, nonfinite, nonclosed or repeated-vertex rings fail.
Projection is already completed before this API; its exact definition including
all chart parameters must be pinned. Degrees are never interpreted as metres.

The preimage uses sorted UTF-16 object keys, exact Unicode strings and finite
ECMAScript JSON numbers encoded as UTF-8. Dependencies are sorted by exact name;
duplicate names fail. No locale comparator is used. The canonicalization version
and independent identity/immutable-input domain tags version this rule. Full
256-bit hashes are retained. `createCellIdentitySet` sorts IDs and rejects duplicate
identities. Neither generation order nor prototype ordinals are part of identity.

Provenance separately retains raw source, approved source geometry, correspondence,
approved country envelope, previous geometry, policy version/artifact, generator
version/artifact, projection id/metre unit/definition, and every exact dependency
name/version/artifact. Artifact identity is SHA-256 plus byte length. Paths remain
in the returned provenance for retrieval but do not enter ID content, allowing
independent isolated copies to agree. The generator pin must cover the actual
generator closure/configuration; dependency pins must cover its exact installed
inputs, not just a floating package range. A policy label alone is insufficient.

`verifyArtifactBytes` rejects mismatching content or length before consumption;
callers must verify all supplied artifacts. This module cannot certify approval,
source correspondence or geometric coverage from a pin alone. Those remain
the prerequisite/later generation gates. `verifyCellIdentity` recomputes and
compares the complete detached record, rejecting altered geometry, parents,
provenance or ID. Inputs are never mutated; records are recursively frozen.

Owner/controller, names, local keys/ordinals, timestamps, random seeds and locale
are excluded by explicitly projecting immutable face fields. The module has no
filesystem discovery, runtime generation, global selection state or world writes.
No catalog version is overwritten and no immutable shared input is modified.
