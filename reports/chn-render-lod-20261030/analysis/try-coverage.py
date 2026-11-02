"""In-memory render-only coverage simplification study; persists metrics, not geometry."""
import gzip
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np
import pyproj
import shapely
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parents[3]
HERE = "reports/chn-render-lod-20261030/analysis"
def read(file):
    return json.loads((ROOT / file).read_bytes())
def pin(file):
    b = (ROOT / file).read_bytes()
    return {"path": file, "sha256": hashlib.sha256(b).hexdigest(), "byteLength": len(b)}
def checked(a):
    b = (ROOT / a["path"]).read_bytes()
    if len(b) != a["byteLength"] or hashlib.sha256(b).hexdigest() != a["sha256"]:
        raise ValueError("PIN_CHANGED:" + a["path"])
    return b

measurement_pin = pin(HERE + "/active-edge-and-coverage.json")
measurement = json.loads(checked(measurement_pin))
for a in measurement["inputs"]:
    checked(a)
inputs = [measurement_pin, *measurement["inputs"]]
pointer = read("data/runtime/operational-catalog/current.json")
provenance = read(pointer["root"] + "/provenance.json")
payload = json.loads(checked(provenance["incremental"]["geometry"]))
features = payload["cells"]
geoms = np.asarray([shape(f["geometry"]) for f in features], dtype=object)
cell_index = {f["id"]: i for i, f in enumerate(features)}
del payload, features
metadata = read(pointer["root"] + "/detail-index.json")
rows = json.loads(gzip.decompress((ROOT / pointer["root"] / "metadata/countries/CHN.json.gz").read_bytes()))["rows"]
ordinal_to_index = {r[0]: cell_index[r[1]] for r in rows}
macro = set(read("data/derived/chn-2020/province-render-f1c91c059cdb06f5234f/index.json")["addedBoundaryOrdinals"])
project = pyproj.Transformer.from_crs("OGC:CRS84", "EPSG:3857", always_xy=True)
projected = shapely.transform(geoms, project.transform, interleaved=False)
native_coords, projected_coords = shapely.get_coordinates(geoms), shapely.get_coordinates(projected)
reverse, ambiguous = {}, set()
for a, b in zip(native_coords, projected_coords):
    k, v = tuple(b), tuple(a)
    old = reverse.get(k)
    if old is not None and old != v:
        ambiguous.add(k)
    else:
        reverse[k] = v
print("projected native collisions", len(ambiguous), flush=True)
native_set = set(tuple(p) for p in native_coords)
edge_rows = []
for shard in metadata["edgeDetails"]:
    for edge in json.loads(gzip.decompress((ROOT / pointer["root"] / shard["artifact"]["path"]).read_bytes()))["edges"]:
        if edge["left"] not in ordinal_to_index or edge["right"] not in ordinal_to_index:
            continue
        if edge["geometry"]["type"] != "LineString":
            raise ValueError("ANALYSIS_EXPECTS_CURRENT_SINGLE_EDGE_CHAINS")
        a = np.asarray(edge["geometry"]["coordinates"], dtype=float)
        p = np.column_stack(project.transform(a[:, 0], a[:, 1]))
        edge_rows.append({"ordinal": edge["ordinal"], "left": ordinal_to_index[edge["left"]], "right": ordinal_to_index[edge["right"]],
            "native": a, "projected": p, "macro": edge["ordinal"] in macro})
del native_coords, projected_coords
native_union = shapely.union_all(geoms)
projected_union = shapely.union_all(projected)

def parts(g):
    if g.geom_type in ("LineString", "LinearRing"):
        return [g]
    return [p for c in getattr(g, "geoms", []) for p in parts(c)]

def maximum_chain_error(old, kept_indexes):
    maximum = 0.0
    for lo, hi in zip(kept_indexes[:-1], kept_indexes[1:]):
        a, b = old[lo], old[hi]
        chain = old[lo:hi + 1]
        vector = b - a
        length2 = float(np.dot(vector, vector))
        if length2:
            t = np.clip(((chain - a) @ vector) / length2, 0, 1)
            distances = np.linalg.norm(chain - a - t[:, None] * vector, axis=1)
        else:
            distances = np.linalg.norm(chain - a, axis=1)
        maximum = max(maximum, float(distances.max(initial=0)))
    return maximum

def cell_holes(g):
    if g.geom_type == "Polygon":
        return len(g.interiors)
    return sum(cell_holes(c) for c in getattr(g, "geoms", []))

results = []
for space, tolerance in [("EPSG:3857", 250), ("EPSG:3857", 500), ("EPSG:3857", 1000), ("CRS84-native", 500 / 111319.49079327358)]:
    started = time.monotonic()
    original = projected if space == "EPSG:3857" else geoms
    print("simplify start", space, tolerance, flush=True)
    simplified = shapely.coverage_simplify(original, tolerance=tolerance, simplify_boundary=False)
    valid = bool(shapely.coverage_is_valid(simplified))
    coords = shapely.get_coordinates(simplified)
    keys = set(tuple(p) for p in coords)
    if space == "EPSG:3857":
        unmatched = keys - reverse.keys()
        ambiguous_used = keys & ambiguous
        restored = None if unmatched or ambiguous_used else shapely.transform(simplified, lambda a: np.asarray([reverse[tuple(p)] for p in a]))
        new_native = restored
        union = shapely.union_all(simplified)
        boundary_equal = projected_union.boundary.equals(union.boundary)
    else:
        unmatched = keys - native_set
        ambiguous_used = set()
        new_native = simplified
        union = shapely.union_all(simplified)
        boundary_equal = native_union.boundary.equals(union.boundary)
    boundaries = shapely.boundary(simplified)
    failures, measurements = [], []
    for e in edge_rows:
        old = e["projected"] if space == "EPSG:3857" else e["native"]
        candidates = parts(shapely.line_merge(shapely.intersection(boundaries[e["left"]], boundaries[e["right"]])))
        start, end = tuple(old[0]), tuple(old[-1])
        matching = [g for g in candidates if (tuple(g.coords[0]), tuple(g.coords[-1])) in [(start, end), (end, start)]]
        if len(matching) != 1:
            failures.append({"ordinal": e["ordinal"], "macro": e["macro"], "reason": "catalog-edge-endpoints-not-preserved-as-one-shared-chain", "candidates": len(candidates)})
            continue
        new = list(matching[0].coords)
        if tuple(new[0]) != start:
            new.reverse()
        indexes = {tuple(v): i for i, v in enumerate(old)}
        if any(tuple(p) not in indexes for p in new):
            failures.append({"ordinal": e["ordinal"], "macro": e["macro"], "reason": "new-shared-chain-node-not-on-original-vertex-list"})
            continue
        retained = [indexes[tuple(p)] for p in new]
        if retained != sorted(set(retained)):
            failures.append({"ordinal": e["ordinal"], "macro": e["macro"], "reason": "original-chain-order-not-preserved"})
            continue
        error = maximum_chain_error(e["projected"], retained)
        measurements.append({"ordinal": e["ordinal"], "macro": e["macro"], "originalVertices": len(old), "simplifiedVertices": len(new),
            "maximumOriginalChainVertexToFiniteChordMeters": error})
    macro_measurements = [m for m in measurements if m["macro"]]
    maximum = max((m["maximumOriginalChainVertexToFiniteChordMeters"] for m in measurements), default=0)
    macro_max = max((m["maximumOriginalChainVertexToFiniteChordMeters"] for m in macro_measurements), default=0)
    record = {"coordinateSpace": space, "tolerance": tolerance, "simplifyBoundary": False,
        "elapsedSeconds": time.monotonic() - started, "coordinateCount": int(shapely.count_coordinates(simplified)),
        "originalCoordinateCount": int(shapely.count_coordinates(original)), "coverageValid": valid,
        "invalidPolygons": int((~shapely.is_valid(simplified)).sum()), "emptyCells": int(shapely.is_empty(simplified).sum()),
        "outerBoundaryTopologicallyEqualInInputCRS": bool(boundary_equal),
        "originalCellHoleCountsPreserved": [cell_holes(g) for g in original] == [cell_holes(g) for g in simplified],
        "unmatchedSurvivingCoordinates": len(unmatched), "ambiguousSurvivingProjectedCoordinates": len(ambiguous_used),
        "nativeRestoreAvailableWithoutInverseProjection": new_native is not None,
        "nativeRestoredCoverageValid": bool(shapely.coverage_is_valid(new_native)) if new_native is not None else None,
        "nativeRestoredOuterBoundaryTopologicallyEqual": native_union.boundary.equals(shapely.union_all(new_native).boundary) if new_native is not None else None,
        "edgeChainsChecked": len(measurements), "protectedEndpointOrChainFailures": len(failures), "endpointFailureSamples": failures[:20],
        "macroEdgeVertices": sum(m["simplifiedVertices"] for m in macro_measurements), "macroOriginalEdgeVerticesChecked": sum(m["originalVertices"] for m in macro_measurements),
        "allInternalEdgeVertices": sum(m["simplifiedVertices"] for m in measurements),
        "maximumChainDeviationMercatorMeters": maximum, "macroMaximumChainDeviationMercatorMeters": macro_max,
        "maximumCSSPixelErrorByZoomPitchZero": [{"zoom": z, "allInternal": maximum * 512 * 2 ** z / (2 * math.pi * 6378137),
            "macro": macro_max * 512 * 2 ** z / (2 * math.pi * 6378137)} for z in [3, 4, 5, 6, 7, 8]],
        "worstMacroChains": sorted(macro_measurements, key=lambda m: -m["maximumOriginalChainVertexToFiniteChordMeters"])[:10]}
    results.append(record)
    print(json.dumps({k: v for k, v in record.items() if k not in ["worstMacroChains", "endpointFailureSamples"]}), flush=True)

for a in inputs:
    checked(a)
report = {"schemaVersion": "chn-render-coverage-simplification-study-v1", "inputs": inputs,
    "code": pin(HERE + "/try-coverage.py"), "runtime": {"shapely": shapely.__version__, "GEOS": shapely.geos_version_string},
    "scope": "Read-only in-memory experiment. Simplified polygons/edges are NOT persisted or admitted. No authoritative geometry, Korean/DPRK land, runtime or pointer is changed.",
    "projectedDistinctNativeCoordinateCollisions": len(ambiguous),
    "deviationMethod": "Match each original catalog edge by exact fixed endpoints to the simplified shared boundary, require surviving vertices to form an ordered subset of that original chain, then measure every original chain vertex to each finite retained chord. With identical endpoints, convexity and continuous projection bound both polyline directions. Reported IEEE-double values are study metrics, not a final exact-arithmetic acceptance certificate.",
    "pixelMeaning": "EPSG3857 deviation*512*2^zoom/40075016.68557849 CSS pixels at pitch0. VW tolerance is not itself a displacement bound. Highest applicable fractional zoom and pitched views still require a render acceptance decision.",
    "results": results}
out = ROOT / HERE / "coverage-simplification-study.json"
b = (json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
if out.exists() and out.read_bytes() != b:
    raise ValueError("IMMUTABLE_STUDY_CHANGED")
if not out.exists():
    out.write_bytes(b)
print(json.dumps({"artifact": pin(HERE + "/coverage-simplification-study.json")}), flush=True)
