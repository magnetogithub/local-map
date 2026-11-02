"""Independent whole-network proof for auxiliary CHN internal line LOD.

No producer modules are imported. Authoritative package files are checked before
and after; only this verifier's reports directory is written.
"""
import argparse
import bisect
import gzip
import hashlib
import json
import math
import subprocess
import sys
import time
from collections import Counter, defaultdict
from fractions import Fraction
from functools import cmp_to_key
from pathlib import Path

import pyproj
import shapely
from shapely.geometry import LineString, Point, shape
from shapely.ops import transform, unary_union

ROOT = Path(__file__).resolve().parents[2]
REPORT_ROOT = ROOT / "reports/chn-internal-render-lod-20261030/verification"
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


def exact_area_sign(coords):
    area = Fraction(0)
    for a, b in zip(coords, coords[1:]):
        area += Fraction(a[0]) * Fraction(b[1]) - Fraction(b[0]) * Fraction(a[1])
    return (area > 0) - (area < 0)


def closed_loop_orientation(old, new):
    if old[0] != old[-1]:
        return None
    result = []
    for name, a, b in (("OGC:CRS84", old, new), ("EPSG:3857", project_coordinates(old), project_coordinates(new))):
        before, after = exact_area_sign(a), exact_area_sign(b)
        if before != after:
            raise ValueError("CLOSED_INTERNAL_LOOP_ORIENTATION_OR_DIMENSION_CHANGED:" + json.dumps({"crs": name, "before": before, "after": after}))
        result.append({"crs": name, "originalExactSignedAreaSign": before, "candidateExactSignedAreaSign": after})
    return result


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


def cyclic_port_order(ports):
    """Exact dyadic orientation of the supplied floating-point ray endpoints.

    Groups retain equal-direction ports; ties cannot appear/disappear silently.
    The order is canonical up to rotation, not up to reflection.
    """
    vectors = []
    for token, anchor, point in ports:
        x = Fraction(point[0]) - Fraction(anchor[0])
        y = Fraction(point[1]) - Fraction(anchor[1])
        if x == 0 and y == 0:
            raise ValueError("ZERO_LENGTH_NODE_PORT")
        half = 0 if y > 0 or y == 0 and x > 0 else 1
        vectors.append((token, x, y, half))
    def compare(a, b):
        if a[3] != b[3]:
            return -1 if a[3] < b[3] else 1
        cross = a[1] * b[2] - a[2] * b[1]
        return -1 if cross > 0 else 1 if cross < 0 else 0
    vectors.sort(key=cmp_to_key(compare))
    groups = []
    previous = None
    for value in vectors:
        if previous is None or compare(previous, value) != 0:
            groups.append([])
        groups[-1].append(value[0])
        previous = value
    groups = [sorted(g) for g in groups]
    if not groups:
        return groups
    first = min(range(len(groups)), key=lambda i: tuple(groups[i]))
    return groups[first:] + groups[:first]


def endpoint_star_checks(originals, display, protected):
    """Preserve clockwise sector order at every endpoint, including protected
    country/coast vertices inside a longer protected edge. Port identities come
    from original edge IDs/vertex positions, never nearest-neighbor matching.
    """
    anchors = {tuple(e["geometry"]["coordinates"][i]) for e in originals.values() for i in (0, -1)}
    native_stars = defaultdict(lambda: [[], []])
    projected_stars = defaultdict(lambda: [[], []])
    projected_points = {}
    def projected(p):
        key = tuple(p)
        if key not in projected_points:
            projected_points[key] = PROJECT.transform(*key)
        return projected_points[key]
    specs = [(n, e["geometry"]["coordinates"], display[n]["geometry"]["coordinates"])
             for n, e in sorted(originals.items())]
    specs += [(e["ordinal"], e["geometry"]["coordinates"], e["geometry"]["coordinates"]) for e in protected]
    for ordinal, old, new in specs:
        retained = native_subsequence(old, new)
        retained_positions = {i: j for j, i in enumerate(retained)}
        for i, anchor in enumerate(old):
            node = tuple(anchor)
            if node not in anchors:
                continue
            # Consecutive duplicate coordinates have no independent sector.
            if i and old[i - 1] == anchor and i != len(old) - 1:
                continue
            at = retained_positions.get(i)
            if at is None:
                pos = bisect.bisect_left(retained, i)
                if pos == 0 or pos == len(retained) or Point(anchor).distance(LineString([new[pos - 1], new[pos]])) != 0:
                    raise ValueError("ENDPOINT_STAR_ANCHOR_REMOVED_OR_MOVED:" + json.dumps({"ordinal": ordinal, "coordinate": anchor}))
            for direction in (-1, 1):
                before = i + direction
                while 0 <= before < len(old) and old[before] == anchor:
                    before += direction
                if not 0 <= before < len(old):
                    continue
                after = at + direction if at is not None else pos - 1 if direction < 0 else pos
                while 0 <= after < len(new) and new[after] == anchor:
                    after += direction
                if not 0 <= after < len(new):
                    raise ValueError("ENDPOINT_STAR_PORT_LOST")
                token = f"{ordinal}:{i}:{direction}"
                native_stars[node][0].append((token, anchor, old[before]))
                native_stars[node][1].append((token, anchor, new[after]))
                projected_stars[node][0].append((token, projected(anchor), projected(old[before])))
                projected_stars[node][1].append((token, projected(anchor), projected(new[after])))
    results = []
    for name, stars in (("OGC:CRS84", native_stars), ("EPSG:3857", projected_stars)):
        cases = []
        for node, (old, new) in sorted(stars.items()):
            if len(old) < 3:
                continue
            a, b = cyclic_port_order(old), cyclic_port_order(new)
            if a != b:
                raise ValueError("SHARED_NODE_CYCLIC_ORDER_CHANGED:" + json.dumps({"crs": name, "coordinate": node, "old": a, "new": b}))
            cases.append({"coordinate": node, "ports": len(old), "cyclicGroups": a})
        results.append({"crs": name, "selectedEndpointCoordinates": len(anchors), "degreeThreeOrHigherNodesChecked": len(cases),
            "canonicalCyclicOrderSha256": hashlib.sha256(encoded(cases)).hexdigest(), "cyclicOrderChanges": 0,
            "orientationPolicy": "Exact rational determinant of stored binary64 coordinates; rotations equivalent, reflections and equal-direction group changes rejected."})
    return results


def closed_loop_nesting_checks(originals, display, protected):
    """A fixed endpoint from every other network component witnesses whether
    it is inside a disjoint closed arc. Check ALL internal endpoint anchors,
    not only representative points invented from candidate geometry.
    """
    anchors = sorted({tuple(e["geometry"]["coordinates"][i]) for e in originals.values() for i in (0, -1)})
    loops = [(n, e["geometry"]["coordinates"], display[n]["geometry"]["coordinates"])
             for n, e in sorted(originals.items()) if e["geometry"]["coordinates"][0] == e["geometry"]["coordinates"][-1]]
    loops += [(e["ordinal"], e["geometry"]["coordinates"], e["geometry"]["coordinates"])
              for e in protected if e["geometry"]["coordinates"][0] == e["geometry"]["coordinates"][-1]]
    results = []
    for name in ("OGC:CRS84", "EPSG:3857"):
        coordinates = anchors if name == "OGC:CRS84" else project_coordinates(anchors)
        points = [Point(p) for p in coordinates]
        tree = shapely.STRtree(points)
        cases = []
        for ordinal, a, b in loops:
            if name == "EPSG:3857":
                a, b = project_coordinates(a), project_coordinates(b)
            if a == b:
                cases.append({"ordinal": ordinal, "unchangedExactClosedArc": True})
                continue
            old, new = shapely.Polygon(a), shapely.Polygon(b)
            if not old.is_valid or not new.is_valid:
                raise ValueError("CHANGED_NON_SIMPLE_NESTING_LOOP:" + str(ordinal))
            candidates = set(map(int, tree.query(old))) | set(map(int, tree.query(new)))
            evidence = []
            for index in sorted(candidates):
                point = points[index]
                before = "interior" if old.contains(point) else "boundary" if old.covers(point) else "exterior"
                after = "interior" if new.contains(point) else "boundary" if new.covers(point) else "exterior"
                if before != after:
                    raise ValueError("CLOSED_LOOP_NESTING_CHANGED:" + json.dumps({"crs": name, "loopOrdinal": ordinal,
                        "fixedOriginalEndpoint": anchors[index], "before": before, "after": after}))
                evidence.append([anchors[index], before])
            cases.append({"ordinal": ordinal, "anchorsCompared": len(candidates), "anchorRelationshipSha256": hashlib.sha256(encoded(evidence)).hexdigest()})
        results.append({"crs": name, "closedInternalArcs": sum(1 for n, _, _ in loops if n in originals),
            "closedProtectedArcs": sum(1 for n, _, _ in loops if n not in originals), "allFixedInternalEndpointAnchors": len(anchors),
            "nestingChanges": 0, "cases": cases,
            "scope": "Every individual closed internal/protected arc against every fixed internal endpoint anchor in its before/after bounds; does not claim polygon-fill simplification."})
    return results


def delivery_sample_selection(manifest, presentation, originals, categories):
    required = ("inland", "city", "coast", "china-dprk-border")
    raw = decode(manifest["source"])
    wanted = {s["sourceFeatureId"] for s in manifest["samples"] if s["windowType"] in required}
    source = {f["properties"]["shapeID"]: f for f in raw["features"] if f["properties"].get("shapeID") in wanted}
    cases = []
    for kind in required:
        sample = next(s for s in manifest["samples"] if s["windowType"] == kind)
        source_id = sample["sourceFeatureId"]
        feature = source[source_id]
        actual_wkb = hashlib.sha256(shape(feature["geometry"]).wkb).hexdigest()
        if actual_wkb != sample["sourceGeometrySha256WKB"]:
            raise ValueError("REPRESENTATIVE_SOURCE_FEATURE_PIN_CHANGED:" + source_id)
        cells = sorted(c["ordinal"] for c in presentation["cells"] if c["sourceFeatureId"] == source_id)
        edges = sorted(n for n, e in originals.items() if e["left"] in cells or e["right"] in cells)
        if not cells or not edges:
            raise ValueError("REPRESENTATIVE_SOURCE_HAS_NO_ACTUAL_INTERNAL_EDGES:" + source_id)
        cases.append({"windowType": kind, "sourceName": sample["sourceName"], "sourceFeatureId": source_id,
            "sourceGeometrySha256WKB": actual_wkb, "source": manifest["source"],
            "bboxLongitudeLatitude": sample["bboxLongitudeLatitude"], "currentCellOrdinals": cells,
            "internalEdgeOrdinals": edges, "categoryCounts": dict(Counter(categories[n] for n in edges)),
            "selectionMethod": "All actual candidate internal edges incident to every current cell with this pinned original source feature identity."})
    return cases


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
    selected = sorted(ctx["deliverySampleOrdinals"])
    originals = {n: originals[n] for n in selected}
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
    return {"pass": True, "coverage": "representative-source-pinned-sample-only",
        "nationalAllArcPBFClaim": False, "sampledEdgeOrdinals": selected,
        "selection": ctx["deliverySampleSelection"], "zooms": reports,
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
    native_ports = [("a", (0., 0.), (1., 0.)), ("b", (0., 0.), (0., 1.)), ("c", (0., 0.), (-1., 0.))]
    flipped_ports = [("a", (0., 0.), (1., 0.)), ("c", (0., 0.), (0., 1.)), ("b", (0., 0.), (-1., 0.))]
    if cyclic_port_order(native_ports) == cyclic_port_order(flipped_ports):
        raise ValueError("NEGATIVE_CONTROL_NODE_SECTOR_FLIP_FALSE_ACCEPT")
    return {"movedEndpoint": rejects(lambda: native_subsequence([[0, 0], [1, 0]], [[0, 0], [1.001, 0]])),
        "inventedCoordinate": rejects(lambda: native_subsequence([[0, 0], [.5, .1], [1, 0]], [[0, 0], [.6, .1], [1, 0]])),
        "over300mChord": rejects(lambda: finite_chord_certificate([[0, 0], [.005, .01], [.01, 0]], [[0, 0], [.01, 0]])),
        "hiddenInteriorDistancePeak": rejects(lambda: directed_distance_bound([[(0, 0), (2, 0)]], shapely.MultiPoint([(0, 0), (2, 0)]), .5)),
        "sharedNodeSectorFlip": True,
        "closedLoopInversion": rejects(lambda: closed_loop_orientation([[0, 0], [1, 0], [1, 1], [0, 0]], [[0, 0], [1, 1], [1, 0], [0, 0]])),
        "newProtectedContact": rejects(lambda: intersection_check([LineString([(0, 0), (2, 0)])],
            [LineString([(0, 0), (1, 1), (2, 0)])], [LineString([(.5, .5), (1.5, .5)])], "negative-control"))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--producer-report", required=True)
    parser.add_argument("--pointer", default="data/runtime/operational-catalog/current.json")
    parser.add_argument("--output", default="reports/chn-internal-render-lod-20261030/verification/independent.json")
    args = parser.parse_args()
    output = local(args.output)
    if not output.is_relative_to(REPORT_ROOT):
        raise ValueError("REPORT_OUTPUT_OUTSIDE_OWNED_DIRECTORY")
    output.parent.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    report = {"schemaVersion": "chn-internal-line-lod-independent-v1", "countryId": "CHN",
        "administrativeTruthClaim": False, "pass": False, "failures": []}
    try:
        producer_pin = pin(args.producer_report)
        producer = decode(producer_pin)
        if producer.get("schemaVersion") != "chn-internal-line-lod-producer-v1" or producer.get("pass") is not True:
            raise ValueError("PRODUCER_CONTRACT_NOT_PASSING_INTERNAL_LOD")
        pins = all_pins({"inputs": producer["inputs"], "code": producer["code"],
            "provinceGeometry": producer["provinceGeometry"], "microGeometry": producer["microGeometry"]})
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
        province_ordinals = presentation["addedBoundaryOrdinals"]
        if len(province_ordinals) != 994 or len(set(province_ordinals)) != 994:
            raise ValueError("PROVINCE_994_SOURCE_SET")
        display, categories = {}, {}
        for name, expected in (("province", 994), ("micro", 7568)):
            features = decode(producer[name + "Geometry"])
            if features.get("type") != "FeatureCollection" or len(features["features"]) != expected:
                raise ValueError("DISPLAY_CATEGORY_FEATURE_COUNT:" + name)
            for f in features["features"]:
                if f["id"] in display:
                    raise ValueError("DUPLICATE_INTERNAL_DISPLAY_ID")
                display[f["id"]] = f
                categories[f["id"]] = name
        if sorted(n for n in categories if categories[n] == "province") != province_ordinals:
            raise ValueError("PROVINCE_ID_SET_CHANGED")
        policy = producer["policy"]
        if policy["projection"] != "EPSG:3857" or policy["alwaysXY"] is not True or policy["toleranceMeters"] != TOLERANCE or policy["maximumDeviationMeters"] != TOLERANCE or policy["tileSizeCSSPixels"] != 512 or policy["worldWidthMeters"] != WORLD or policy["maximumApplicableZoomExclusive"] != 7:
            raise ValueError("DISPLAY_POLICY_CHANGED")
        rows = {row[0]: c["countryId"] for c in detail["countries"] for row in asset_json(c["metadata"]["path"])["rows"]}
        all_edges = [e for s in detail["edgeDetails"] for e in asset_json(s["artifact"]["path"])["edges"]]
        selected = sorted(e["ordinal"] for e in all_edges if rows.get(e["left"]) == "CHN" and rows.get(e["right"]) == "CHN")
        if len(selected) != 8562 or sorted(display) != selected:
            raise ValueError("ALL_CURRENT_INTERNAL_CHN_EDGE_SET_CHANGED")
        originals = {e["ordinal"]: e for e in all_edges if e["ordinal"] in display}
        protected_edges = [e for e in all_edges if e["boundaryClass"] in ("country", "coast") or e["flags"]["country"]]
        claims = {e["ordinal"]: e for e in producer["edges"]}
        if set(claims) != set(display) or len(producer["edges"]) != 8562:
            raise ValueError("CLAIM_ID_SET_CHANGED")
        independent = []
        native_old, native_new = [], []
        for n in selected:
            source, feature, claim = originals[n], display[n], claims[n]
            if claim["category"] != categories[n]:
                raise ValueError("CLAIM_CATEGORY_CHANGED")
            if claim["decision"] not in ("simplified", "original-unchanged", "reverted"):
                raise ValueError("UNKNOWN_DISPLAY_DECISION")
            if feature["type"] != "Feature" or feature["properties"] != {} or feature["geometry"]["type"] != "LineString" or rows[source["left"]] != "CHN" or rows.get(source["right"]) != "CHN":
                raise ValueError("DISPLAY_NOT_ORIGINAL_INTERNAL_CHN_ARC")
            a, b = source["geometry"]["coordinates"], feature["geometry"]["coordinates"]
            if any(len(p) != 2 or not all(math.isfinite(v) for v in p) for p in b):
                raise ValueError("BAD_DISPLAY_COORDINATE")
            certificate = finite_chord_certificate(a, b)
            loop_orientation = closed_loop_orientation(a, b)
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
            independent.append({"ordinal": n, "category": categories[n], "originalEdgeId": source["id"], "originalVertices": len(a), "displayVertices": len(b),
                "originalGeometrySha256": geom_hash(source["geometry"]), "displayGeometrySha256": geom_hash(feature["geometry"]),
                "nativeExactEndpointsAndOrderedSubset": True, "candidateSimple": new_line.is_simple,
                "closedLoopOrientation": loop_orientation, "decision": claim["decision"], **certificate})
        print("Verify ALL internal and protected coast/country topology", flush=True)
        protected_native = [shape(e["geometry"]) for e in protected_edges]
        native_topology = intersection_check(native_old, native_new, protected_native, "OGC:CRS84")
        projected_old = [transform(PROJECT.transform, g) for g in native_old]
        projected_new = [transform(PROJECT.transform, g) for g in native_new]
        projected_protected = [transform(PROJECT.transform, g) for g in protected_native]
        projected_topology = intersection_check(projected_old, projected_new, projected_protected, "EPSG:3857")
        print("Verify shared-node cyclic orders", flush=True)
        star_checks = endpoint_star_checks(originals, display, protected_edges)
        print("Verify closed-loop nesting against all fixed endpoints", flush=True)
        nesting_checks = closed_loop_nesting_checks(originals, display, protected_edges)
        sample_pin = pin("reports/chn-2020/sample-validation-source.json")
        sample_manifest = decode(sample_pin)
        pins.update(all_pins(sample_manifest))
        pins[sample_pin["path"]] = sample_pin
        sample_selection = delivery_sample_selection(sample_manifest, presentation, originals, categories)
        ctx = {"detail": detail, "asset_json": asset_json, "artifact_pin": artifact_pin,
            "deliverySampleOrdinals": sorted({n for case in sample_selection for n in case["internalEdgeOrdinals"]}),
            "deliverySampleSelection": {"manifest": sample_pin, "cases": sample_selection}}
        delivery = pbf_check(ctx, display, originals)
        print("Recheck original catalog assets", flush=True)
        for p in [current_pin, index_pin, *ledger, *pins.values(), producer_pin]:
            checked(p)
        report.update({"pass": True, "producer": producer_pin,
            "artifacts": {"province": producer["provinceGeometry"], "micro": producer["microGeometry"]}, "baselinePointer": current_pin,
            "baseCatalogRef": descriptor["catalogRef"], "authorityUnchanged": {"allPublishedArtifactsRechecked": len(ledger),
              "packageBytes": sum(p["byteLength"] for p in ledger), "catalogOrderAdministrativeParentsCountryGeometryAndMilitaryInputsUnchanged": True,
              "originalCatalogLedgerSha256": hashlib.sha256(encoded(ledger)).hexdigest()}, "sourcePins": list(pins.values()),
            "checks": {"exactAll8562IdsAndSourceIdentity": True, "exactProvince994Micro7568Partition": True,
              "nativeCoordinateSubsetEndpointsAllArcs": True, "continuousDP300MetersAllArcs": True,
              "wholeNetworkNoNewSelfCrossOrInternalCountryCoastContacts": True, "sharedNodeCyclicOrders": True,
              "closedLoopOrientationAndDimension": True,
              "individualClosedLoopNestingAgainstAllFixedEndpoints": True,
              "representativeActualPBFDistanceAndFillRingBudgets": True, "originalCatalogFilesUnchanged": True},
            "edges": independent, "topology": [native_topology, projected_topology], "endpointStars": star_checks, "closedLoopNesting": nesting_checks,
            "actualDelivery": delivery, "negativeControls": negative_controls(),
            "summary": {"edges": 8562, "provinceEdges": 994, "microEdges": 7568,
              "originalVertices": sum(e["originalVertices"] for e in independent), "displayVertices": sum(e["displayVertices"] for e in independent),
              "maximumFiniteChordDeviationMeters": max(e["maximumOriginalSubchainVertexToFiniteChordMeters"] for e in independent), "decisions": dict(Counter(e["decision"] for e in independent))},
            "limitations": ["All 8562 internal arcs and complete internal/protected contact network are verified; actual PBF decoding is explicitly source-pinned representative samples only, not a national all-arc delivery claim.",
              "Verifies auxiliary display lines, not a change in administrative facts or authoritative cell footprints.",
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
