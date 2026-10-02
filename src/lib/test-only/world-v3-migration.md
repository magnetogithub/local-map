# Prompt 14-3: World V3 contract and migration dry run

`world-v2-to-v3-migration.ts` and `world-v3-synthetic-fixture.ts` are test-only.
The V3 contracts in `../world/` are not imported by production consumers. V2
bootstrap, stores, commands, projections and simulation remain the production
authority during this stage. The 14-5 schema checkpoint now validates atomic
world/simulation integration through a test-only adapter.

The mutable V3 snapshot has no geometry, topology or cached geometry hash roots.
It holds `catalogRef`, every catalog territory ID in bytewise order, country
entities with authoritative uppercase `mapColor`, and territory source/owner/
controller IDs. Deserialization requires a validated catalog view and rejects
any version/root/path, membership or source-country disagreement. Owner and
controller must be active; immutable source-country provenance can survive
retirement. An owned territory must have a controller.

Catalog IDs use `territory:catalog:` followed by 64 lowercase hexadecimal digits.
This stage defines the ID format only. Domain-separated canonical atom key
derivation and production catalog generation belong to 14-6 onward. The minimal
`WorldGeometryCatalogContract` is a validation view, not a generated catalog or
an alternative geometry authority. A later adapter must obtain it from the
validated production catalog and approved manifest.

Migration requires an explicit one-to-many mapping covering every legacy and
target territory exactly once. Entries may arrive in any order; each target list
must already be sorted and unique. Source coverage is never inferred from the
current owner. The mandatory `CanonicalTerritoryCoverageValidator` build/CI port
must prove full canonical coverage, absence of overlap/cross-border targets, and
the original source country against the locked P0 policy and exact catalog ref.
The synthetic implementation checks complete rectangular partition coverage.
Production coverage evidence and its adapter remain required before a real dry
run in 14-8 and cutover in 14-10.

V2 has only `ownerCountryId` and explicitly rejects a separate controller. The
lossless initial V3 interpretation is `controllerCountryId = ownerCountryId`,
including null. Existing V2 country entities do not contain colors. Callers must
provide a complete explicit country-color record from the existing seed/map
projection path, including colors for created countries. Migration changes hex
letter case only; it neither invents colors nor allocates a fallback palette.

Canonical serialization includes the catalog ref, never catalog geometry bytes.
`worldStateV3ContentHash` uses the existing SHA-256/canonical serializer with an
explicit V3 namespace; it includes color, control and retired identities and
excludes bookkeeping revision. This is an offline schema hash, not a camera or
render hook. Incremental hash integration remains a production consumer/cutover
port. Simulation pairing, history and undo/redo are verified by the 14-5 dry run.

Validation covers strict schema/IDs/records/order/ref, deterministic round trips,
all allowed control combinations, forbidden references, incomplete/duplicate/
many-to-one mapping, actual synthetic containment/partition failure, rollback
of the dry run, RGB preservation for every 2020 metadata seed country and
production-import isolation. No additional checkpoint JSON is created for
14-3. The 14-5 checkpoint combines this validation with the 14-4 authority schema.

`world-simulation-schema-checkpoint.ts` prepares both migrated candidates before
returning a pair. It injects a catalog-bound validation/hash/restoration port into
the existing atomic turn engine; there is no second commit/history implementation.
Both schema versions, revisions, catalog references, simulation authority scopes,
and offline pair hashes are checked together. Its serialization contains catalog
references only. This adapter and synthetic state transitions are test-only and
do not authorize production occupation or color effects.

The checkpoint verifies lossless empty-authority migration, independent
byte-identical serialization, strict references/hash/caps, commit failure rollback,
world/simulation undo and redo, history branching, and failed publication or
catalog restoration. Production bootstrap, store, application runtime, resolver
and seed still use World V2 / Simulation V1. No browser persistence is added.

The exact remaining ports and validation evidence are recorded in
`reports/prompt14/14-05-schema-migration-checkpoint.json`. They include the real
catalog/manifest adapter, source-grounded migration mapping and coverage proof,
the complete production color record, V3 command and projection consumers,
incremental hashing, atomic application/store publication, and the final seed/API
cutover. World V3 / Simulation V2 production authority begins only at 14-10.
