# Offline partition prototype — 15-13 REVIEW B repair

The prototype consumes complete projected protected faces. Each face retains its
administrative parent and independent previous-geometry parent. Local ordinals
are experiment references, never production TerritoryIds. No runtime hook, new
catalog, migration, provider tool, world generation or publication is installed.

Candidates are grid (uniform squares retaining slivers), adaptive (boundary
quadtree retaining slivers), and partition (5 km interior squares, 2.5 km squares
in a 5 km boundary band, then deterministic bounded merging). Merging requires
positive shared length inside the same protected parent and unchanged physical
limits with a metric-error guard. Unmergeable cells remain explicit and fail
physical assessment; they are never dropped or assigned by proximity.

Parents and lattice cutters enter common noding and polygonization. T-junctions
and both sides of a shared edge use identical coordinates and opposite directed
half-edges. Point contact does not create adjacency. auditPartition independently
checks arbitrary supplied cells for outside/hole intrusion, overlap, gaps, unique
parents, every component, union hole topology and two-way source correspondence.

The v1 NUMERICAL_CHART_LIMIT is removed. Noding translates the COMPLETE geometry
to a deterministic local metre origin. Numerical precision derives from extent,
IEEE-754 representability and coordinate ulps, keeping scaled coordinates below
2^48. Small witnesses retain their 1e-10 metre representation. Wider charts use
an explicit power-of-two numerical grid with a derived segment displacement
certificate. Coverage tolerance derives from original local input coordinates,
never from a measured residual. No country asset or restoration policy changes.
There is no bounded-window fallback or credit for an unmeshed inland remainder.

loadSourceSamples preserves the small raw-source witnesses. loadFullSourceSamples
adds complete Kangwon, Hwanghae, Loja/Piura, Sukhbaatar, Troms, Fiji Northern and
Grevenmacher identities. Raw bytes are checked against the unchanged source lock.
metric-chart.mjs supplies bounded WGS84 ellipsoidal regional charts with longitude
unwrapping; original vertices become straight projected chords. Fiji's exact
+/-180 file seam is reconnected inside the same identity BEFORE projection. Every
raw component index, geometry and positive area remains traced. This avoids
micro-holes from joining nearly collinear projected seam segments. Unsupported
broad/polar geodetic charts fail explicitly rather than clipping to a window.
These source experiments do not certify production administrative restoration.

prototype-frontier.mjs probes initial and subsequent near advances from actual
positive-length CURRENT controller frontiers. It searches bounded contiguous
contact windows and the shallowest qualifying scope, preferring inland retention.
Depth has Euclidean lower and mesh-path upper bounds; width is contact arclength,
not an exact geodesic buffer. Fixed depth, width, area, 512 aggregate and parent
fraction limits all apply. Retained inland includes only untouched MESHED cells
on the connected land component beyond the selected depth. Owners and input
geometry remain unchanged. No production lookup, token or authority API is added.

compact-partition.mjs provides an exact normalized codec experiment: Float64
shared vertices, Uint32 ring/cell offsets and membership, explicit component/hole
markers, typed edge arrays and a parent/provenance dictionary. Geometry and both
parents round-trip exactly. Measured bytes include dictionaries and indices.
World, delivery and peak-memory costs still require 15-16 and later tasks;
sample bytes and typed-array allocation are not a world-budget PASS.

Preparation from the actual candidate, with NEW output paths:

    node scripts/operational-cells/prototype-cli.mjs .reports/15-13/small.json.gz
    node scripts/operational-cells/full-prototype-cli.mjs .reports/15-13/full-new

The controller-selected acceptance test is copied byte-for-byte and unchanged.
Additional real Vitest assertions cover complete parents, removal/window/coarse
negative fixtures, fixed physical limits, two advances on current frontiers and
exact decoding. The implementer does not run the official suite. CLI evidence
records preparation, not verification verdicts.

Authenticated historical REVIEW B failures and the initial post-projection Fiji
hole failure remain negative evidence. 15-14 through 15-17 must regenerate affected
evidence and receive task verification before REVIEW B is repeated. No threshold,
cap, required witness or frozen assertion is weakened. No later production task
is implemented or approved here.

The compact codec includes its array-layout header and global cell ordinals. Independently decodable shards preserve every cell and edge reference. Shard bytes, initial directory decode, and largest typed-array decode are measured separately; transport sharding never changes a logical commit or its aggregate cap.
