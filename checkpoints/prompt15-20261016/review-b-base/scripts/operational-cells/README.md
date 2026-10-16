# Offline common model (15-11)

`src/lib/operational-cells/model.ts` separates fixed country envelopes, original
administrative identity tuples, operational cells, positive-length adjacency and
the previous catalog geometry parent. IDs use the existing bounded catalog
TerritoryId namespace. Administrative identity never contains a TerritoryId.
Mutable owner/controller fields are excluded from every generation schema.

Generation inputs must pin the previous catalog's complete reference, approved
restoration evidence, pre-selection source inventory, raw/aligned/projected
geometry correspondence, policy, generator, projection and dependency artifacts
(SHA-256 and byte length). An absent administrative source needs explicit evidence;
it cannot manufacture a source region. One partition level per country is supplied;
additional hierarchical memberships require a separate inclusion contract.

The small `common-refinement.mjs` experiment intersects complete administrative
and previous-territory partitions. A north/south administrative partition crossed
by an east/west previous partition yields four base faces, not two new territories
chosen by country or centroid. Every face has one administrative parent and one
previous geometry parent, including the previous catalog ref. Both parent unions,
holes, components, non-overlap and unchanged envelope are checked. Unresolved,
overlapping, missing, outside or ambiguous geometry fails rather than falling back.
The experiment uses exact empty polygon residuals in an explicitly pinned planar
metre coordinate space; it neither approves a numerical tolerance nor interprets
longitude/latitude degrees as physical distance. It does not verify artifact bytes
on disk: the caller must verify pins and restoration certificates before supplying
approved inputs. A declared approval is not itself a restoration gate PASS.

Later mesh generation must subdivide these protected base faces within a common
noded arrangement, preserving both parents and the original envelope. It must
prove cell union against both administrative and previous geometry, preserve all
components/holes, and derive stable IDs from actual immutable inputs. The ID input
contract includes policy, canonical geometry and both parents. Canonicalization,
ID derivation and full provenance determinism are 15-15; physical policy is 15-12;
mesh/edge noding and sliver handling are 15-13 and later generation tasks.

Administrative memberships are complete sets, with no 512 truncation in this
model. This does not change the runtime resolver or turn aggregate cap. Adjacency
requires a positive shared edge length and distinguishes country, administrative
and operational meaning. Point touches, sea gaps and remote components cannot
be adjacency. A frontline is derived later from adjacent controllers.

No runtime hook imports the experiment. No game state, simulation, history,
authority, catalog ref or old asset is migrated or deleted. Downstream migration
must inherit owner/controller from the unique previous parent, never from the
immutable source country, and implement atomic version switching separately.

Manual experiment (Node 24 TypeScript stripping):

```text
node scripts/operational-cells/refinement-cli.mjs .reports/15-11/refinement-input.json .reports/15-11/refinement-output.json
```

The fixture is synthetic planar geometry for the model contract, not source
geography or resolution evidence. No world generation or production publication
is performed. The task's Vitest suite is submitted to the controller for execution.
