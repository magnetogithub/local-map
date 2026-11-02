"""Independent admission proof for auxiliary CHN province line LOD.

No producer modules are imported. Authoritative package files are checked before
and after; only this verifier's reports directory is written.
"""
import argparse
import gzip
import hashlib
import json
import math
import subprocess
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

import pyproj
import shapely
from shapely.geometry import LineString, Point, shape
from shapely.ops import transform, unary_union

ROOT = Path(__file__).resolve().parents[2]
REPORT_ROOT = ROOT / "reports/chn-render-lod-20261030/verification"
WORLD = 2 * math.pi * 6378137
TOLERANCE = 300.0
QUANTIZATION_UNITS = 1.5  # Each unchanged published representation comparison.
PROJECT = pyproj.Transformer.from_crs("OGC:CRS84", "EPSG:3857", always_xy=True)


def local(name):
    p = (ROOT / name).resolve()
    if not p.is_relative_to(ROOT):
        raise ValueError("PATH_OUTSIDE_WORKSPACE:" + str(name))
    return p


def pin(name):
    path = local(name)
    b = path.read_bytes()
    return {"path": path.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(b).hexdigest(), "byteLength": len(b)}


def checked(p):
    actual = pin(p["path"])
    if actual != {k: p[k] for k in ("path", "sha256", "byteLength")}:
        raise ValueError("INPUT_PIN_CHANGED:" + p["path"])
    return local(p["path"]).read_bytes()


def decode(p):
    b = checked(p)
    return json.loads(gzip.decompress(b) if p["path"].endswith(".gz") else b)


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def geom_hash(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def all_pins(value):
    result = {}
    def visit(v):
        if isinstance(v, dict):
            if set(("path", "sha256", "byteLength")).issubset(v):
                checked(v)
                result[v["path"]] = {k: v[k] for k in ("path", "sha256", "byteLength")}
            for item in v.values():
                visit(item)
        elif isinstance(v, list):
            for item in v:
                visit(item)
    visit(value)
    return result


def project_coordinates(coords):
    xs, ys = PROJECT.transform([p[0] for p in coords], [p[1] for p in coords])
    return list(zip(xs, ys))


def native_subsequence(old, new):
    if len(new) < 2 or new[0] != old[0] or new[-1] != old[-1]:
        raise ValueError("ENDPOINT_MOVED")
    indices = [0]
    cursor = 1
    for point in new[1:-1]:
        while cursor < len(old) - 1 and old[cursor] != point:
            cursor += 1
        if cursor >= len(old) - 1:
            raise ValueError("NON_NATIVE_OR_REORDERED_COORDINATE")
        indices.append(cursor)
        cursor += 1
    indices.append(len(old) - 1)
    return indices


def finite_chord_certificate(old, new):
    indices = native_subsequence(old, new)
    projected = project_coordinates(old)
    maximum = 0.0
    witness = None
    for first, last in zip(indices, indices[1:]):
        a, b = projected[first], projected[last]
        dx, dy = b[0] - a[0], b[1] - a[1]
        norm = dx * dx + dy * dy
        for i in range(first, last + 1):
            p = projected[i]
            t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / norm)) if norm else 0.0
            distance = math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
            if distance > maximum:
                maximum = distance
                witness = {"originalVertexIndex": i, "firstIndex": first, "lastIndex": last, "distanceMeters": distance}
    if maximum > TOLERANCE:
        raise ValueError("DP_FINITE_CHORD_BOUND:" + json.dumps(witness))
    return {"maximumOriginalSubchainVertexToFiniteChordMeters": maximum, "witness": witness, "retainedIndices": indices}


def intersection_check(original, candidate, protected, label):
    """Compare actual sets, not the producer's success flags or stored hashes."""
    old = original + protected
    new = candidate + protected
    old_tree, new_tree = shapely.STRtree(old), shapely.STRtree(new)
    checked_pairs = set()
    existing = 0
    maximum_contact_dimension = -1
    for i in range(len(candidate)):
        neighbors = set(map(int, old_tree.query(old[i], predicate="intersects")))
        neighbors.update(map(int, new_tree.query(new[i], predicate="intersects")))
        for j in neighbors:
            if j == i or j < len(candidate) and j < i:
                continue
            before, after = old[i].intersection(old[j]), new[i].intersection(new[j])
            if not before.equals(after):
                raise ValueError("NEW_OR_CHANGED_CONTACT:" + json.dumps({"crs": label, "selectedIndex": i, "otherIndex": j,
                    "before": shapely.to_geojson(before), "after": shapely.to_geojson(after)}))
            checked_pairs.add((i, j))
            if not before.is_empty:
                existing += 1
                maximum_contact_dimension = max(maximum_contact_dimension, int(shapely.get_dimensions(before)))
    return {"crs": label, "selectedLines": len(candidate), "protectedCountryCoastLines": len(protected),
            "actualIntersectingPairsCompared": len(checked_pairs), "retainedContacts": existing,
            "maximumRetainedContactDimension": maximum_contact_dimension, "newOrChangedContacts": 0}


def line_parts(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == "LineString":
        return [list(geometry.coords)]
    if hasattr(geometry, "geoms"):
        return [p for g in geometry.geoms for p in line_parts(g)]
    return []


def directed_distance_bound(parts, target, limit):
    """Continuous bound using distance-to-set's 1-Lipschitz property.

    For a segment of length L, endpoint distances da/db give the upper bound
    (da+db+L)/2. Subdivision proves the ENTIRE segment, not just sampled points.
    """
    if target.is_empty:
        raise ValueError("DISTANCE_TARGET_EMPTY")
    cache = {}
    measured = 0.0
    upper_max = 0.0
    subdivisions = 0
    def distance(p):
        nonlocal measured
        key = tuple(p)
        if key not in cache:
            cache[key] = Point(key).distance(target)
        measured = max(measured, cache[key])
        if cache[key] > limit:
            raise ValueError("CONTINUOUS_DISTANCE_WITNESS:" + json.dumps({"point": key, "distance": cache[key], "limit": limit}))
        return cache[key]
    for coords in parts:
        for a, b in zip(coords, coords[1:]):
            stack = [(a, b, distance(a), distance(b), 0)]
            while stack:
                p, q, dp, dq, depth = stack.pop()
                length = math.dist(p, q)
                upper = (dp + dq + length) / 2
                if upper <= limit:
                    upper_max = max(upper_max, upper)
                    continue
                if depth >= 40 or len(cache) > 1000000:
                    raise ValueError("DISTANCE_CERTIFICATE_DID_NOT_CONVERGE")
                mid = ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2)
                dm = distance(mid)
                stack.append((p, mid, dp, dm, depth + 1))
                stack.append((mid, q, dm, dq, depth + 1))
                subdivisions += 1
    return {"continuousUpperBound": upper_max, "maximumMeasuredDistance": measured, "pointEvaluations": len(cache), "subdivisions": subdivisions}


NODE_DECODE = r"""
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {VectorTile,classifyRings} from '@mapbox/vector-tile';
import {PbfReader} from 'pbf';
let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input),edgeIds=new Set(request.edgeIds),cellIds=new Set(request.cellIds),edges={},cells={},seenCells=new Set(),zeroAreaRings=[];
let decodedTiles=0,edgeFeatureCopies=0,fillFeatureCopies=0;
for(const a of request.tiles){
 const bytes=fs.readFileSync(a.path);if(bytes.length!==a.byteLength||createHash('sha256').update(bytes).digest('hex')!==a.sha256)throw Error('PBF_HASH_CHANGED:'+a.path);
 const tile=new VectorTile(new PbfReader(gunzipSync(bytes)));decodedTiles++;
 const add=(p,extent)=>[a.x*extent+p.x,a.y*extent+p.y];
 const lines=tile.layers.edges;
 for(let i=0;i<(lines?.length??0);i++){const f=lines.feature(i);if(!edgeIds.has(f.id))continue;if(lines.extent!==4096)throw Error('UNEXPECTED_EXTENT');
  (edges[f.id]??=[]).push(...f.loadGeometry().map(line=>line.map(p=>add(p,lines.extent))));edgeFeatureCopies++;
 }
 const fills=tile.layers.territories;
 for(let i=0;i<(fills?.length??0);i++){const f=fills.feature(i);if(!cellIds.has(f.id))continue;if(fills.extent!==4096)throw Error('UNEXPECTED_EXTENT');seenCells.add(f.id);
  const raw=f.loadGeometry().map(ring=>ring.map(p=>add(p,fills.extent)));
  (cells[f.id]??=[]).push(raw);fillFeatureCopies++;
  for(let r=0;r<raw.length;r++){const ring=raw[r];let area=0n;for(let j=1;j<ring.length;j++)area+=BigInt(ring[j-1][0])*BigInt(ring[j][1])-BigInt(ring[j][0])*BigInt(ring[j-1][1]);
   if(area===0n)zeroAreaRings.push({cellOrdinal:f.id,tile:[request.zoom,a.x,a.y],ringIndex:r,coordinates:ring,integerAreaTwice:'0'});
  }
 }
}
console.log(JSON.stringify({edges,cells,zeroAreaRings,seenCells:[...seenCells],decodedTiles,edgeFeatureCopies,fillFeatureCopies}));
"""


def grid_coords(coords, quantum):
    return [[(x + WORLD / 2) / quantum, (WORLD / 2 - y) / quantum] for x, y in project_coordinates(coords)]


def ring_network(polygons):
    return line_network([r for poly in polygons for r in poly])


def line_network(parts):
    # GEOS union discards zero-length LineStrings. MVT legitimately retains
    # retraced integer-point lines at low zoom; their actual set is a point.
    pieces = []
    for coords in parts:
        if not coords:
            continue
        pieces.append(LineString(coords) if len(set(map(tuple, coords))) > 1 else Point(coords[0]))
    return unary_union(pieces) if pieces else shapely.GeometryCollection()


def quantized_area_twice(geometry, quantum):
    total = 0
    polys = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    for poly in polys:
        for i, ring in enumerate(poly):
            points = [(math.floor(x + .5), math.floor(y + .5)) for x, y in grid_coords(ring, quantum)]
            area = abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:])))
            total += area if i == 0 else -area
    return total


def pbf_check(ctx, display, originals):
    selected = sorted(display)
    adjacent = sorted({e[side] for e in originals.values() for side in ("left", "right") if e[side]})
    # Only the unchanged incident CHN fill records are retained, for explicit
    # existing integer-area-collapse classification if a tile omits a tiny cell.
    country = next(c for c in ctx["detail"]["countries"] if c["countryId"] == "CHN")
    all_cells = ctx["asset_json"](country["detail"]["path"])["features"]
    original_cells = {f["id"]: f["geometry"] for f in all_cells if f["id"] in set(adjacent)}
    del all_cells
    reports = []
    for z in range(2, 7):
        print("PBF zoom", z, flush=True)
        quantum = WORLD / ((2 ** z) * 4096)
        tiles = set()
        for edge in originals.values():
            coords = grid_coords(edge["geometry"]["coordinates"], quantum)
            xs, ys = [p[0] for p in coords], [p[1] for p in coords]
            for x in range(max(0, math.floor((min(xs) - 64) / 4096)), min(2 ** z - 1, math.floor((max(xs) + 64) / 4096)) + 1):
                for y in range(max(0, math.floor((min(ys) - 64) / 4096)), min(2 ** z - 1, math.floor((max(ys) + 64) / 4096)) + 1):
                    tiles.add((x, y))
        tile_pins = []
        for x, y in sorted(tiles):
            p = ctx["artifact_pin"](f"tiles/{z}/{x}/{y}.pbf.gz")
            tile_pins.append({**p, "z": z, "x": x, "y": y})
        task = {"zoom": z, "tiles": tile_pins, "edgeIds": selected, "cellIds": adjacent}
        child = subprocess.run(["node", "--input-type=module", "-e", NODE_DECODE], input=json.dumps(task), capture_output=True, text=True, cwd=ROOT, timeout=180)
        if child.returncode:
            raise ValueError("ACTUAL_PBF_DECODE_FAILED:" + child.stderr[-5000:])
        decoded = json.loads(child.stdout)
        fill_targets = {int(n): ring_network(polys) for n, polys in decoded["cells"].items()}
        lod_limit = TOLERANCE / quantum + QUANTIZATION_UNITS
        records, collapsed = [], []
        for n in selected:
            old = grid_coords(originals[n]["geometry"]["coordinates"], quantum)
            new = grid_coords(display[n]["geometry"]["coordinates"], quantum)
            raw_curve, lod_curve = LineString(old), LineString(new)
            parts = decoded["edges"].get(str(n), [])
            entry = {"ordinal": n}
            def bound(label, source, target, limit, cell=None):
                try:
                    return directed_distance_bound(source, target, limit)
                except ValueError as error:
                    diagnostic = {"zoom": z, "edgeOrdinal": n, "operation": label, "cellOrdinal": cell,
                        "originalEdgeId": originals[n]["id"], "originalNativeCoordinates": originals[n]["geometry"]["coordinates"],
                        "deliveredEdgePartsGlobalGrid": parts, "targetWKT": target.wkt,
                        "sourcePartsGlobalGrid": source, "tilePins": tile_pins, "error": str(error)}
                    name = REPORT_ROOT / f"quantization-diagnostic-z{z}-edge{n}-{label}-cell{cell}.json"
                    name.write_bytes(encoded(diagnostic))
                    raise ValueError("ACTUAL_PBF_CONTEXT:" + json.dumps({"zoom": z, "edgeOrdinal": n, "operation": label, "cellOrdinal": cell,
                        "diagnostic": pin(name.relative_to(ROOT).as_posix()), "error": str(error)})) from error
            if parts:
                delivered = line_network(parts)
                entry["nativeToActualPBF"] = bound("nativeToActualPBF", [old], delivered, QUANTIZATION_UNITS)
                entry["actualPBFToNative"] = bound("actualPBFToNative", parts, raw_curve, QUANTIZATION_UNITS)
                entry["lodToActualPBF"] = bound("lodToActualPBF", [new], delivered, lod_limit)
                entry["actualPBFToLOD"] = bound("actualPBFToLOD", parts, lod_curve, lod_limit)
            else:
                points = {(math.floor(x + .5), math.floor(y + .5)) for x, y in old}
                if len(points) != 1:
                    raise ValueError(f"MISSING_NONCOLLAPSED_PBF_EDGE:{z}:{n}:{len(points)}")
                collapsed.append({"ordinal": n, "kind": "all-original-vertices-collapse-to-one-existing-integer-grid-point", "point": next(iter(points))})
                entry["pbfCollapsed"] = True
            entry["bothDeliveredFillRings"] = []
            for side in ("left", "right"):
                cell = originals[n][side]
                target = fill_targets.get(cell, shapely.GeometryCollection())
                if target.is_empty:
                    area = quantized_area_twice(original_cells[cell], quantum)
                    if area != 0:
                        raise ValueError(f"MISSING_NONCOLLAPSED_PBF_FILL:{z}:{n}:{cell}:{area}")
                    entry["bothDeliveredFillRings"].append({"cellOrdinal": cell, "existingWholeCellIntegerAreaCollapse": True, "integerAreaTwice": area})
                else:
                    entry["bothDeliveredFillRings"].append({"cellOrdinal": cell,
                        "actualPBFLineToActualFill": bound("actualPBFLineToActualFill", parts, target, QUANTIZATION_UNITS, cell),
                        "nativeToActualFill": bound("nativeToActualFill", [old], target, QUANTIZATION_UNITS, cell),
                        "lodToActualFill": bound("lodToActualFill", [new], target, lod_limit, cell)})
            records.append(entry)
        reports.append({"zoom": z, "tileExtent": 4096, "actualDecodedTiles": decoded["decodedTiles"], "tilePins": tile_pins,
            "edgeFeatureCopies": decoded["edgeFeatureCopies"], "fillFeatureCopies": decoded["fillFeatureCopies"], "quantumMercatorMeters": quantum,
            "existingQuantizationBudgetGridUnits": QUANTIZATION_UNITS, "dpBudgetMercatorMeters": TOLERANCE,
            "nativeToPBFLineBudgetGridUnits": QUANTIZATION_UNITS,
            "actualPBFLineToActualFillRingBudgetGridUnits": QUANTIZATION_UNITS,
            "lodToPBFLineComposedBudgetGridUnits": lod_limit,
            "nativeToActualFillRingBudgetGridUnits": QUANTIZATION_UNITS,
            "lodToActualFillRingBudgetGridUnits": lod_limit,
            "dpCSSPixelsAtNativeZoom": TOLERANCE / WORLD * 512 * 2 ** z,
            "quantizationCSSPixelsAtNativeZoom": QUANTIZATION_UNITS * 512 / 4096,
            "existingCollapsedEdges": collapsed,
            "existingZeroIntegerAreaFillRings": decoded["zeroAreaRings"], "edges": records})
    return {"pass": True, "zooms": reports,
        "method": "Decode actual hashed MVT lines and both literal incident fill-ring networks including zero-area integer rings, matching the existing published delivery proof. Continuous distance-to-set bounds use adaptive 1-Lipschitz segment envelopes, not samples alone. Native/PBF-line, native/fill-ring and actual-PBF-line/fill-ring each retain their separate 1.5-grid-unit limits; display/line and display/fill have DP300m plus that original limit. The unchanged base package's full surface coverage remains the separately pinned original delivery proof.",
        "renderingLimitation": "Installed classifyRings skips exactly zero integer signed-area rings. Their bytes and integer-zero certificates are retained in the ledger; the literal-ring distance gate does not claim those degenerate rings enclose rendered pixels. This is an unchanged base-PBF representation effect, not an administrative or gameplay footprint modification.",
        "dpOnlyCSSPixelBoundAtZoom5": TOLERANCE / WORLD * 512 * 2 ** 5,
        "dpOnlySupremumCSSPixelBoundBelowZoom7": TOLERANCE / WORLD * 512 * 2 ** 7,
        "lodToPBFLineSupremumCSSPixelBoundBelowZoom7UsingSourceZ6": TOLERANCE / WORLD * 512 * 2 ** 7 + QUANTIZATION_UNITS * 512 / 4096 * 2,
        "lodToLiteralFillRingSupremumCSSPixelBoundBelowZoom7UsingSourceZ6": TOLERANCE / WORLD * 512 * 2 ** 7 + QUANTIZATION_UNITS * 512 / 4096 * 2}


def negative_controls():
    def rejects(fn):
        try:
            fn()
        except ValueError:
            return True
        raise ValueError("NEGATIVE_CONTROL_FALSE_ACCEPT")
    return {"movedEndpoint": rejects(lambda: native_subsequence([[0, 0], [1, 0]], [[0, 0], [1.001, 0]])),
        "inventedCoordinate": rejects(lambda: native_subsequence([[0, 0], [.5, .1], [1, 0]], [[0, 0], [.6, .1], [1, 0]])),
        "over300mChord": rejects(lambda: finite_chord_certificate([[0, 0], [.005, .01], [.01, 0]], [[0, 0], [.01, 0]])),
        "hiddenInteriorDistancePeak": rejects(lambda: directed_distance_bound([[(0, 0), (2, 0)]], shapely.MultiPoint([(0, 0), (2, 0)]), .5))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--producer-report", required=True)
    parser.add_argument("--pointer", default="data/runtime/operational-catalog/current.json")
    parser.add_argument("--output", default="reports/chn-render-lod-20261030/verification/independent.json")
    args = parser.parse_args()
    output = local(args.output)
    if not output.is_relative_to(REPORT_ROOT):
        raise ValueError("REPORT_OUTPUT_OUTSIDE_OWNED_DIRECTORY")
    output.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    report = {"schemaVersion": "chn-province-line-lod-independent-v1", "pass": False, "failures": []}
    try:
        producer_pin = pin(args.producer_report)
        producer = decode(producer_pin)
        pins = all_pins({"inputs": producer["inputs"], "code": producer["code"], "displayGeometry": producer["displayGeometry"]})
        original_delivery_pin = pin("reports/chn-2020/delivery-verification.json")
        original_delivery = decode(original_delivery_pin)
        if original_delivery.get("pass") is not True or original_delivery["catalogVersion"] != producer["catalogRef"]["catalogVersion"]:
            raise ValueError("ORIGINAL_PUBLISHED_DELIVERY_PROOF_NOT_PASSING_THIS_CATALOG")
        pins[original_delivery_pin["path"]] = original_delivery_pin
        current_pin = pin(args.pointer)
        if current_pin != producer["inputs"]["pointer"]:
            raise ValueError("ACTIVE_POINTER_NOT_PINNED_PRODUCER_BASELINE")
        pointer = decode(current_pin)
        index_pin = {**pointer["index"], "path": pointer["root"] + "/artifact-index.json"}
        index = decode(index_pin)
        assets = {p["path"]: p for p in index["artifacts"]}
        def artifact_pin(name):
            return {**assets[name], "path": pointer["root"] + "/" + name}
        def asset_json(name):
            return decode(artifact_pin(name))
        ledger = [artifact_pin(name) for name in assets]
        print("Verify original catalog assets", len(ledger), flush=True)
        for p in ledger:
            checked(p)
        descriptor, detail = asset_json("catalog.json"), asset_json("detail-index.json")
        if producer["catalogRef"] != descriptor["catalogRef"] or producer.get("administrativeTruthClaim") is not False:
            raise ValueError("AUTHORITATIVE_REFERENCE_CHANGED")
        presentation = decode(producer["inputs"]["provincePresentationIndex"])
        selected = presentation["addedBoundaryOrdinals"]
        if len(selected) != 994 or len(set(selected)) != 994:
            raise ValueError("PROVINCE_994_SOURCE_SET")
        features = decode(producer["displayGeometry"])
        display = {f["id"]: f for f in features["features"]}
        if len(display) != 994 or sorted(display) != selected or len(features["features"]) != 994:
            raise ValueError("DISPLAY_ID_SET_CHANGED")
        policy = producer["policy"]
        if policy["projection"] != "EPSG:3857" or policy["alwaysXY"] is not True or policy["toleranceMeters"] != TOLERANCE or policy["maximumDeviationMeters"] != TOLERANCE or policy["tileSizeCSSPixels"] != 512 or policy["worldWidthMeters"] != WORLD:
            raise ValueError("DISPLAY_POLICY_CHANGED")
        rows = {row[0]: c["countryId"] for c in detail["countries"] for row in asset_json(c["metadata"]["path"])["rows"]}
        all_edges = [e for s in detail["edgeDetails"] for e in asset_json(s["artifact"]["path"])["edges"]]
        originals = {e["ordinal"]: e for e in all_edges if e["ordinal"] in display}
        protected_edges = [e for e in all_edges if e["boundaryClass"] in ("country", "coast") or e["flags"]["country"]]
        claims = {e["ordinal"]: e for e in producer["edges"]}
        if set(claims) != set(display) or len(producer["edges"]) != 994:
            raise ValueError("CLAIM_ID_SET_CHANGED")
        independent = []
        native_old, native_new = [], []
        for n in selected:
            source, feature, claim = originals[n], display[n], claims[n]
            if feature["type"] != "Feature" or feature["properties"] != {} or feature["geometry"]["type"] != "LineString" or rows[source["left"]] != "CHN" or rows.get(source["right"]) != "CHN":
                raise ValueError("DISPLAY_NOT_ORIGINAL_INTERNAL_CHN_ARC")
            a, b = source["geometry"]["coordinates"], feature["geometry"]["coordinates"]
            if any(len(p) != 2 or not all(math.isfinite(v) for v in p) for p in b):
                raise ValueError("BAD_DISPLAY_COORDINATE")
            certificate = finite_chord_certificate(a, b)
            if claim["originalEdgeId"] != source["id"] or claim["originalGeometrySha256"] != geom_hash(source["geometry"]) or claim["displayGeometrySha256"] != geom_hash(feature["geometry"]) or claim["retainedOriginalVertexIndices"] != certificate["retainedIndices"]:
                raise ValueError("EDGE_SOURCE_ID_OR_GEOMETRY_CERTIFICATE_CHANGED")
            if claim["decision"] in ("original-unchanged", "reverted") and a != b:
                raise ValueError("REVERT_OR_UNCHANGED_CLAIM_NOT_ORIGINAL")
            if claim["decision"] == "reverted" and not claim["reasons"]:
                raise ValueError("REVERT_WITHOUT_LEDGER_REASON")
            old_line, new_line = LineString(a), LineString(b)
            if not new_line.is_simple and a != b:
                raise ValueError("NEW_DISPLAY_SELF_INTERSECTION")
            native_old.append(old_line); native_new.append(new_line)
            independent.append({"ordinal": n, "originalEdgeId": source["id"], "originalVertices": len(a), "displayVertices": len(b),
                "originalGeometrySha256": geom_hash(source["geometry"]), "displayGeometrySha256": geom_hash(feature["geometry"]),
                "nativeExactEndpointsAndOrderedSubset": True, "candidateSimple": new_line.is_simple, "decision": claim["decision"], **certificate})
        print("Verify macro and coast/country topology", flush=True)
        protected_native = [shape(e["geometry"]) for e in protected_edges]
        native_topology = intersection_check(native_old, native_new, protected_native, "OGC:CRS84")
        projected_old = [transform(PROJECT.transform, g) for g in native_old]
        projected_new = [transform(PROJECT.transform, g) for g in native_new]
        projected_protected = [transform(PROJECT.transform, g) for g in protected_native]
        projected_topology = intersection_check(projected_old, projected_new, projected_protected, "EPSG:3857")
        ctx = {"detail": detail, "asset_json": asset_json, "artifact_pin": artifact_pin}
        delivery = pbf_check(ctx, display, originals)
        print("Recheck original catalog assets", flush=True)
        for p in [current_pin, index_pin, *ledger, *pins.values(), producer_pin]:
            checked(p)
        report.update({"pass": True, "producer": producer_pin, "artifact": producer["displayGeometry"], "displayGeometry": producer["displayGeometry"], "baselinePointer": current_pin,
            "baseCatalogRef": descriptor["catalogRef"], "authorityUnchanged": {"allPublishedArtifactsRechecked": len(ledger),
              "packageBytes": sum(p["byteLength"] for p in ledger), "catalogOrderAdministrativeParentsCountryGeometryAndMilitaryInputsUnchanged": True,
              "originalCatalogLedgerSha256": hashlib.sha256(encoded(ledger)).hexdigest()}, "sourcePins": list(pins.values()),
            "checks": {"exact994IdsAndSourceIdentity": True, "nativeCoordinateSubsetEndpoints": True, "continuousDP300Meters": True,
              "noNewSelfCrossOrMacroCountryCoastContacts": True, "actualPBFDistanceAndFillRingBudgets": True, "originalCatalogFilesUnchanged": True},
            "edges": independent, "topology": [native_topology, projected_topology], "actualDelivery": delivery, "negativeControls": negative_controls(),
            "summary": {"edges": 994, "originalVertices": sum(e["originalVertices"] for e in independent), "displayVertices": sum(e["displayVertices"] for e in independent),
              "maximumFiniteChordDeviationMeters": max(e["maximumOriginalSubchainVertexToFiniteChordMeters"] for e in independent), "decisions": dict(Counter(e["decision"] for e in independent))},
            "limitations": ["Verifies auxiliary display lines, not a change in administrative facts or authoritative cell footprints.",
              "CSS conversion is for pitch-zero Mercator,512CSSpx world tile at zoom0,DPR independent. Parent owns actual browser/source masking and high-zoom return tests.",
              "PBF fill-ring distance is checked against literal delivered ring networks including tile clipping; the unchanged base package's complete fill coverage is a separate existing proof."]})
    except Exception as error:
        report["failures"].append({"type": type(error).__name__, "message": str(error)})
    report["elapsedSeconds"] = time.monotonic() - start
    report["environment"] = {"python": sys.version, "shapely": shapely.__version__, "GEOS": shapely.geos_version_string, "pyproj": pyproj.__version__, "PROJ": pyproj.proj_version_str}
    report["verifier"] = pin(Path(__file__).resolve().relative_to(ROOT).as_posix())
    output.write_bytes(encoded(report))
    print(json.dumps({"pass": report["pass"], "output": pin(output.relative_to(ROOT).as_posix()), "failures": report["failures"], "elapsedSeconds": report["elapsedSeconds"]}), flush=True)
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
