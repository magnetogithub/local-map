"""Round accepted CHN display corners offline, keeping the shared network fixed.

This is a display-only successor to an independently accepted simplification.
It intentionally derives Bezier coordinates; authoritative cell/edge geometry
and the previous original-coordinate-subsequence proof remain unchanged.
"""
import argparse
import importlib.util
import json
import math
from pathlib import Path

import numpy as np
import pyproj
import shapely
from shapely.geometry import LineString, Point, Polygon, mapping, shape

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("lod_builder", Path(__file__).with_name("build-chn-internal-line-lod.py"))
lod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lod)
pin, checked, encoded, immutable = lod.pin, lod.checked, lod.encoded, lod.immutable
PROJECT = pyproj.Transformer.from_crs("OGC:CRS84", "EPSG:3857", always_xy=True)
INVERSE = pyproj.Transformer.from_crs("EPSG:3857", "OGC:CRS84", always_xy=True)


def round_corners(native, locked, fraction, max_cutback, flatness):
    projected = np.asarray(list(zip(*PROJECT.transform(native[:, 0], native[:, 1]))))
    output, rounded = [native[0].tolist()], 0
    for i in range(1, len(native) - 1):
        a, v, b = projected[i - 1:i + 2]
        incoming, outgoing = v - a, b - v
        la, lb = float(np.linalg.norm(incoming)), float(np.linalg.norm(outgoing))
        if i in locked or min(la, lb) <= 0:
            output.append(native[i].tolist())
            continue
        u, w = incoming / la, outgoing / lb
        # Nearly straight stretches stay straight; no invented waviness.
        if float(np.dot(u, w)) >= math.cos(math.radians(6)):
            output.append(native[i].tolist())
            continue
        cut = min(la * fraction, lb * fraction, max_cutback)
        entry, exit = v - u * cut, v + w * cut
        curvature = float(np.linalg.norm(entry - 2 * v + exit))
        samples = max(4, math.ceil(math.sqrt(curvature / (4 * flatness))))
        for n in range(samples + 1):
            t = n / samples
            point = (1 - t) ** 2 * entry + 2 * t * (1 - t) * v + t ** 2 * exit
            output.append(list(INVERSE.transform(*point)))
        rounded += 1
    output.append(native[-1].tolist())
    return output, rounded


def main(args):
    if not 0 < args.fraction <= .3 or not 0 < args.max_offset <= 1500:
        raise ValueError("DISPLAY_CURVE_BUDGET_OUT_OF_RANGE")
    baseline_pin = pin(args.baseline_delivery)
    baseline = json.loads(checked(baseline_pin))
    producer = json.loads(checked(baseline["producer"]))
    proof = json.loads(checked(baseline["verification"]))
    if (producer["schemaVersion"] != "chn-internal-line-lod-producer-v1" or not proof["pass"]
            or proof["producer"] != baseline["producer"] or proof["baseCatalogRef"] != baseline["catalogRef"]):
        raise ValueError("CURVE_BASELINE_NOT_INDEPENDENTLY_ACCEPTED")
    inputs = dict(producer["inputs"])
    inputs.update({"smoothingBaselineDelivery": baseline_pin, "smoothingBaselineProducer": baseline["producer"],
        "smoothingBaselineProof": baseline["verification"], "smoothingHelper": pin("scripts/chn-2020/build-chn-internal-line-lod.py")})
    selected, categories = [], {}
    for category in ("province", "micro"):
        identity = producer[category + "Geometry"]
        if proof["artifacts"][category] != identity:
            raise ValueError("CURVE_BASELINE_PROOF_OUTPUT_MISMATCH")
        inputs["smoothingBaseline" + category.title() + "Geometry"] = identity
        for feature in json.loads(checked(identity))["features"]:
            selected.append(feature)
            categories[feature["id"]] = category
    selected.sort(key=lambda f: f["id"])
    if len(selected) != 8562 or len(categories) != 8562:
        raise ValueError("CURVE_BASELINE_SCOPE_CHANGED")
    protected = []
    for shard in inputs["topologyShards"]:
        import gzip
        protected.extend(e for e in json.loads(gzip.decompress(checked(shard)))["edges"]
            if e["boundaryClass"] in ("country", "coast"))
    originals = [shape(f["geometry"]) for f in selected] + [shape(e["geometry"]) for e in protected]
    projected = list(shapely.transform(originals, PROJECT.transform, interleaved=False))
    arrays = [np.asarray(g.coords) for g in originals]
    projected_arrays = [np.asarray(g.coords) for g in projected]
    count = len(selected)
    anchors = {tuple(p) for a in arrays[:count] for p in (a[0], a[-1])}
    locks, node_ports, affected = {}, {}, {i: set() for i in range(count)}
    for i, coordinates in enumerate(arrays):
        fixed = {0, len(coordinates) - 1}
        for j, coordinate in enumerate(coordinates):
            node = tuple(coordinate)
            if node not in anchors:
                continue
            fixed.add(j)
            for direction in (-1, 1):
                other = j + direction
                while 0 <= other < len(coordinates) and np.array_equal(coordinates[other], coordinate):
                    other += direction
                if 0 <= other < len(coordinates):
                    node_ports.setdefault(node, []).append((i, j, direction, other, f"{i}:{j}:{direction}"))
                    if i < count:
                        affected[i].add(node)
        if i < count:
            locks[i] = fixed
    baseline_stars = []
    for space in (arrays, projected_arrays):
        baseline_stars.append({node: lod.cyclic_signature([(label, space[i][j], space[i][other])
            for i, j, _, other, label in ports]) for node, ports in node_ports.items()})
    print("curved display baseline", count, "protected", len(protected), flush=True)
    contacts = [lod.pair_signatures(originals, count), lod.pair_signatures(projected, count)]
    trees = [shapely.STRtree(originals), shapely.STRtree(projected)]
    neighbors = {i: set() for i in range(count)}
    for a, b in set(contacts[0]) | set(contacts[1]):
        if a < count:
            neighbors[a].add(b)
        if b < count:
            neighbors[b].add(a)
    anchor_points = [[Point(p) for p in sorted(anchors)], [Point(PROJECT.transform(*p)) for p in sorted(anchors)]]
    anchor_trees = [shapely.STRtree(points) for points in anchor_points]
    current = [list(originals), list(projected)]
    current_arrays = [list(arrays), list(projected_arrays)]
    positions = [{j: j for j in range(len(a))} for a in arrays]

    def validate(i, coords):
        candidate = [LineString(coords)]
        candidate.append(shapely.transform(candidate[0], PROJECT.transform, interleaved=False))
        retained = {}
        cursor = 0
        for j in sorted(locks[i]):
            point = arrays[i][j]
            while cursor < len(coords) and not np.array_equal(coords[cursor], point):
                cursor += 1
            if cursor == len(coords):
                raise ValueError("SHARED_NODE_MOVED")
            retained[j] = cursor
            cursor += 1
        for space in range(2):
            geometry = candidate[space]
            before = originals[i] if space == 0 else projected[i]
            if not geometry.is_valid or geometry.length <= 0 or geometry.is_closed != before.is_closed or (before.is_simple and not geometry.is_simple):
                raise ValueError("INVALID_OR_SELF_CROSSING_CURVE")
            if before.is_closed:
                old_polygon, new_polygon = Polygon(before), Polygon(geometry)
                if not new_polygon.is_valid or lod.ring_signed_area(before.coords) * lod.ring_signed_area(geometry.coords) <= 0:
                    raise ValueError("CURVE_LOOP_INVERTED")
                for k in set(map(int, anchor_trees[space].query(old_polygon))) | set(map(int, anchor_trees[space].query(new_polygon))):
                    point = anchor_points[space][k]
                    if (old_polygon.contains(point), old_polygon.covers(point)) != (new_polygon.contains(point), new_polygon.covers(point)):
                        raise ValueError("CURVE_LOOP_NESTING_CHANGED")
            for j in sorted((neighbors[i] | set(map(int, trees[space].query(geometry)))) - {i}):
                pair = (min(i, j), max(i, j))
                signature = lod.intersection_signature(geometry, current[space][j]) if i < j else lod.intersection_signature(current[space][j], geometry)
                if signature != contacts[space].get(pair):
                    raise ValueError("CURVE_CONTACT_CHANGED")
            candidate_array = np.asarray(geometry.coords)
            for node in affected[i]:
                ports = []
                for edge, j, direction, original_other, label in node_ports[node]:
                    a = candidate_array if edge == i else current_arrays[space][edge]
                    at = retained[j] if edge == i else positions[edge][j]
                    other = at + direction
                    while 0 <= other < len(a) and np.array_equal(a[other], a[at]):
                        other += direction
                    if not 0 <= other < len(a):
                        raise ValueError("CURVE_NODE_PORT_LOST")
                    ports.append((label, a[at], a[other]))
                if lod.cyclic_signature(ports) != baseline_stars[space][node]:
                    raise ValueError("CURVE_NODE_ORDER_CHANGED")
        estimate = float(shapely.hausdorff_distance(projected[i], candidate[1], densify=.25))
        if estimate > args.max_offset:
            raise ValueError("CURVE_OFFSET_EXCEEDED")
        return candidate, retained, estimate

    reports, output = [], []
    for i, feature in enumerate(selected):
        accepted, failures = None, []
        # Uniform nationwide backoff, including narrow city/enclave boundaries.
        for factor in (1, .5, .25, .125, .0625):
            for keep_rays in (False, True):
                locked = set(locks[i])
                if keep_rays:
                    for node in affected[i]:
                        locked.update(p[3] for p in node_ports[node] if p[0] == i)
                coords, corners = round_corners(arrays[i], locked, args.fraction * factor,
                    min(args.max_cutback, args.max_offset * 1.5) * factor, args.flatness)
                if not corners:
                    continue
                try:
                    candidate, retained, estimate = validate(i, coords)
                    accepted = (coords, corners, candidate, retained, estimate, factor, keep_rays)
                    break
                except ValueError as error:
                    failures.append(str(error))
            if accepted:
                break
        if accepted:
            coords, corners, candidate, retained, estimate, factor, keep_rays = accepted
            for space in range(2):
                current[space][i] = candidate[space]
                current_arrays[space][i] = np.asarray(candidate[space].coords)
            positions[i] = retained
        else:
            coords, corners, estimate, factor, keep_rays = arrays[i].tolist(), 0, 0, 0, False
        geometry = {"type": "LineString", "coordinates": coords}
        output.append({"type": "Feature", "id": feature["id"], "properties": {}, "geometry": geometry})
        reports.append({"ordinal": feature["id"], "category": categories[feature["id"]], "baselineVertices": len(arrays[i]),
            "displayVertices": len(coords), "roundedCorners": corners, "strengthFactor": factor,
            "originalJunctionRaysFixed": keep_rays, "estimatedHausdorffMercatorMeters": estimate,
            "decision": "curved" if corners else "baseline-retained", "rejectedCandidateReasons": sorted(set(failures)),
            "baselineGeometrySha256": lod.geometry_hash(feature["geometry"]), "displayGeometrySha256": lod.geometry_hash(geometry)})
    for key, value in inputs.items():
        for identity in value if isinstance(value, list) else [value]:
            checked(identity)
    policy = {"displayUse": "single curved internal-boundary representation at every zoom", "projection": "EPSG:3857",
        "method": "Quadratic Bezier fillets on accepted simplified interior corners; no extrapolation or waviness on straight segments.",
        "cornerFraction": args.fraction, "maximumCutbackMercatorMeters": args.max_cutback,
        "maximumAdditionalDeviationMercatorMeters": args.max_offset, "maximumBezierChordErrorMercatorMeters": args.flatness,
        "fixedSharedNodes": True, "exactNativeAndProjectedContactSets": True, "endpointCyclicOrderAndRayTiesPreserved": True,
        "closedLoopOrientationAndNestingPreserved": True, "authoritativeGeometryChanged": False,
        "coordinateDerivation": "New samples on local quadratic Bezier arcs in Mercator, inverse-projected once offline; all fixed junction coordinates retain exact baseline JSON numbers."}
    code = pin("scripts/chn-2020/build-chn-curved-internal-lines.py")
    geometry_bytes = {kind: encoded({"type": "FeatureCollection", "features": [f for f in output if categories[f["id"]] == kind]}) for kind in ("province", "micro")}
    import hashlib
    key = hashlib.sha256(encoded({"geometry": {k: hashlib.sha256(v).hexdigest() for k, v in geometry_bytes.items()}, "inputs": inputs, "code": code, "policy": policy})).hexdigest()[:20]
    folder = "data/derived/chn-2020/internal-line-curves-" + key
    artifacts = {kind + "Geometry": immutable(folder + "/" + kind + ".geojson", data) for kind, data in geometry_bytes.items()}
    report = {"schemaVersion": "chn-internal-line-curves-producer-v1", "pass": True, "countryId": "CHN", "administrativeTruthClaim": False,
        "catalogRef": baseline["catalogRef"], "inputs": inputs, "code": code, "policy": policy, **artifacts,
        "summary": {"edges": count, "curvedEdges": sum(r["decision"] == "curved" for r in reports),
            "roundedCorners": sum(r["roundedCorners"] for r in reports), "baselineVertices": sum(r["baselineVertices"] for r in reports),
            "displayVertices": sum(r["displayVertices"] for r in reports),
            "provinceVertices": sum(r["displayVertices"] for r in reports if r["category"] == "province"),
            "microVertices": sum(r["displayVertices"] for r in reports if r["category"] == "micro")}, "edges": reports,
        "limitations": ["Presentation curves only; independent verification must certify the actual delivered polylines before packaging.",
            "The curve budget is additional to the accepted 2500m simplified display. It is not a geographic survey accuracy claim.",
            "Two-point straight arcs and fixed junctions remain straight; narrow contacts can require smaller local fillets."]}
    identity = immutable(folder + "/producer-report.json", encoded(report))
    print(json.dumps({"report": identity, "summary": report["summary"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-delivery", required=True)
    parser.add_argument("--fraction", type=float, default=.22)
    parser.add_argument("--max-cutback", type=float, default=3000)
    parser.add_argument("--max-offset", type=float, default=1200)
    parser.add_argument("--flatness", type=float, default=40)
    main(parser.parse_args())
