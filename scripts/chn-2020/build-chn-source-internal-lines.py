"""Generalize the unsimplified CHN shared source network before rendering.

Join degree-two provincial arcs, filter their original paths in arclength, then
resample with a small rendering error. Never use a previously simplified shape.
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


class SourcePath:
    def __init__(self, members, arrays, anchors, supports, args):
        self.members, self.spans, self.args = members, {}, args
        points = []
        for edge, reverse in members:
            coords = arrays[edge][::-1] if reverse else arrays[edge]
            first = len(points) - 1 if points else 0
            points.extend(coords[1:].tolist() if points else coords.tolist())
            self.spans[edge] = (first, len(points) - 1, reverse)
        self.native = np.asarray(points)
        self.projected = np.asarray(list(zip(*PROJECT.transform(self.native[:, 0], self.native[:, 1]))))
        self.distance = np.r_[0., np.cumsum(np.linalg.norm(np.diff(self.projected, axis=0), axis=1))]
        self.locked = {j for j, p in enumerate(self.native) if tuple(p) in anchors} | {0, len(points) - 1}
        self.supports = set()
        for edge, (lo, hi, reverse) in self.spans.items():
            for segment in supports[edge]:
                at = hi - segment - 1 if reverse else lo + segment
                self.supports.add((float(self.distance[at]), float(self.distance[at + 1])))
                self.locked.update((at, at + 1))
        self.cache = {}

    def generate(self, factor, keep_rays):
        key = (factor, keep_rays)
        if key in self.cache:
            return self.cache[key]
        length = float(self.distance[-1])
        if length <= 0:
            raise ValueError("ZERO_SOURCE_PATH_LENGTH")
        spacing = min(self.args.sample_spacing, self.args.sigma * factor / 2)
        steps = max(2, math.ceil(length / spacing))
        uniform = np.linspace(0, length, steps + 1)
        raw = np.column_stack([np.interp(uniform, self.distance, self.projected[:, k]) for k in (0, 1)])
        sigma = self.args.sigma * factor / (length / steps)
        radius = max(1, math.ceil(3 * sigma))
        offsets = np.arange(-radius, radius + 1, dtype=float)
        kernel = np.exp(-.5 * (offsets / max(sigma, .01)) ** 2)
        kernel /= kernel.sum()
        closed = np.array_equal(self.native[0], self.native[-1])
        values = raw[:-1] if closed else raw
        padded = np.pad(values, ((radius, radius), (0, 0)), mode="wrap" if closed else "reflect")
        smooth = np.column_stack([np.convolve(padded[:, k], kernel, mode="valid") for k in (0, 1)])
        if closed:
            smooth = np.vstack([smooth, smooth[0]])
        locked = set(self.locked)
        if keep_rays:
            locked.update(j + direction for j in self.locked for direction in (-1, 1) if 0 <= j + direction < len(self.native))
        # All shared junctions retain their exact source positions. Smoothstep
        # correction has zero derivative at each junction, so the global filtered
        # path keeps a common direction across degree-two provincial joins.
        by_distance = {float(self.distance[j]): j for j in sorted(locked)}
        anchor_s = np.asarray(sorted(by_distance))
        anchor_indices = [by_distance[float(s)] for s in anchor_s]
        anchor_xy = self.projected[anchor_indices]
        smooth_at_anchors = np.column_stack([np.interp(anchor_s, uniform, smooth[:, k]) for k in (0, 1)])
        correction = anchor_xy - smooth_at_anchors
        samples = np.unique(np.r_[uniform, anchor_s])
        segment = np.clip(np.searchsorted(anchor_s, samples, side="right") - 1, 0, len(anchor_s) - 2)
        t = (samples - anchor_s[segment]) / (anchor_s[segment + 1] - anchor_s[segment])
        blend = (t * t * (3 - 2 * t))[:, None]
        result = np.column_stack([np.interp(samples, uniform, smooth[:, k]) for k in (0, 1)])
        result += correction[segment] * (1 - blend) + correction[segment + 1] * blend
        for s, xy in zip(anchor_s, anchor_xy):
            result[np.searchsorted(samples, s)] = xy
        output = {}
        for edge, (lo, hi, reverse) in self.spans.items():
            start, end = self.distance[lo], self.distance[hi]
            fixed = anchor_s[(anchor_s >= start) & (anchor_s <= end)]
            coords = []
            for a, b in zip(fixed[:-1], fixed[1:]):
                if (float(a), float(b)) in self.supports:
                    native = [self.native[by_distance[float(a)]].tolist(), self.native[by_distance[float(b)]].tolist()]
                    coords.extend(native[1:] if coords else native)
                    continue
                first, last = np.searchsorted(samples, [a, b])
                piece = LineString(result[first:last + 1]).simplify(self.args.render_error * factor, preserve_topology=True)
                xy = list(piece.coords)
                native = [list(INVERSE.transform(*p)) for p in xy]
                native[0] = self.native[by_distance[float(a)]].tolist()
                native[-1] = self.native[by_distance[float(b)]].tolist()
                coords.extend(native[1:] if coords else native)
            output[edge] = coords[::-1] if reverse else coords
        self.cache[key] = output
        return output


def source_paths(selected, arrays, anchors, supports, categories, args):
    province = {i for i, f in enumerate(selected) if categories[f["id"]] == "province"}
    incident = {}
    for i in province:
        for p in (arrays[i][0], arrays[i][-1]):
            incident.setdefault(tuple(p), []).append(i)
    seen, chains = set(), []
    starts = sorted(province, key=lambda i: (all(len(incident[tuple(p)]) == 2 for p in (arrays[i][0], arrays[i][-1])), selected[i]["id"]))
    for first in starts:
        if first in seen:
            continue
        a, b = tuple(arrays[first][0]), tuple(arrays[first][-1])
        node = a if len(incident[a]) != 2 else b
        edge, members = first, []
        while edge not in seen:
            seen.add(edge)
            reverse = tuple(arrays[edge][-1]) == node
            members.append((edge, reverse))
            node = tuple(arrays[edge][0] if reverse else arrays[edge][-1])
            choices = [n for n in incident[node] if n not in seen]
            if len(incident[node]) != 2 or not choices:
                break
            edge = choices[0]
        chains.append(members)
    chains.extend([(i, False)] for i in range(len(selected)) if i not in province)
    paths, by_edge = [], {}
    for members in chains:
        path = SourcePath(members, arrays, anchors, supports, args)
        paths.append(path)
        for edge, _ in members:
            by_edge[edge] = path
    return paths, by_edge


def main(args):
    if not 0 < args.sigma <= 3000 or not 0 < args.max_offset <= 3000 or not 0 < args.render_error <= 100:
        raise ValueError("SOURCE_GENERALIZATION_BUDGET_OUT_OF_RANGE")
    baseline_pin = pin(args.baseline_delivery)
    baseline = json.loads(checked(baseline_pin))
    producer = json.loads(checked(baseline["producer"]))
    proof = json.loads(checked(baseline["verification"]))
    if (producer["schemaVersion"] != "chn-internal-line-lod-producer-v1" or not proof["pass"]
            or proof["producer"] != baseline["producer"] or proof["baseCatalogRef"] != baseline["catalogRef"]):
        raise ValueError("CURVE_BASELINE_NOT_INDEPENDENTLY_ACCEPTED")
    inputs = dict(producer["inputs"])
    inputs = {k: v for k, v in inputs.items() if not k.startswith("previousDisplay")}
    inputs.update({"sourceReferenceDelivery": baseline_pin, "sourceReferenceProducer": baseline["producer"],
        "sourceReferenceProof": baseline["verification"], "sourceGeneralizationHelper": pin("scripts/chn-2020/build-chn-internal-line-lod.py")})
    selected, categories = [], {}
    for category in ("province", "micro"):
        for ordinal in baseline[category]["edgeOrdinals"]:
            categories[ordinal] = category
    if len(categories) != 8562:
        raise ValueError("CURVE_BASELINE_SCOPE_CHANGED")
    protected = []
    for shard in inputs["topologyShards"]:
        import gzip
        for e in json.loads(gzip.decompress(checked(shard)))["edges"]:
            if e["ordinal"] in categories:
                selected.append({"type": "Feature", "id": e["ordinal"], "properties": {}, "geometry": e["geometry"]})
            elif e["boundaryClass"] in ("country", "coast"):
                protected.append(e)
    selected.sort(key=lambda f: f["id"])
    if len(selected) != 8562:
        raise ValueError("UNSIMPLIFIED_SOURCE_NETWORK_MISSING")
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
    print("unsimplified source", count, "vertices", sum(len(a) for a in arrays[:count]), flush=True)
    contacts = [lod.pair_signatures(originals, count), lod.pair_signatures(projected, count)]
    # Some accepted junctions meet the interior of a source segment without an
    # explicit vertex on that segment. Preserve just that supporting segment,
    # allowing the rest of its source arc to be filtered instead of reverting it.
    supports = {i: set() for i in range(count)}
    coordinate_sets = [[set(map(tuple, a)) for a in space[:count]] for space in (arrays, projected_arrays)]
    for space, signatures in enumerate(contacts):
        coordinates = arrays if space == 0 else projected_arrays
        for pair, signature in signatures.items():
            points = shapely.get_coordinates(shapely.from_wkb(bytes.fromhex(signature)))
            for i in pair:
                if i >= count:
                    continue
                for point in points:
                    if tuple(point) in coordinate_sets[space][i]:
                        continue
                    a, b = coordinates[i][:-1], coordinates[i][1:]
                    v = b - a
                    norm = np.sum(v * v, axis=1)
                    t = np.divide(np.sum((point - a) * v, axis=1), norm, out=np.zeros(len(norm)), where=norm > 0)
                    distance = np.sum((point - a - np.clip(t, 0, 1)[:, None] * v) ** 2, axis=1)
                    supports[i].add(int(np.argmin(distance)))
    paths, path_for_edge = source_paths(selected, arrays, anchors, supports, categories, args)
    print("joined provincial paths", sum(len(p.members) > 1 for p in paths), "contact support segments", sum(map(len, supports.values())), flush=True)
    trees = [shapely.STRtree([g.envelope.buffer(args.max_offset / 111319.49079327358) for g in originals]),
        shapely.STRtree([g.envelope.buffer(args.max_offset) for g in projected])]
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
        for factor in (1, .6666666666666666, .4, .25, .125, .0625, .03125):
            for keep_rays in (False, True):
                try:
                    coords = path_for_edge[i].generate(factor, keep_rays)[i]
                    corners = max(0, len(coords) - 2)
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
            "decision": "source-generalized" if accepted else "source-retained", "rejectedCandidateReasons": sorted(set(failures)),
            "baselineGeometrySha256": lod.geometry_hash(feature["geometry"]), "displayGeometrySha256": lod.geometry_hash(geometry)})
    for key, value in inputs.items():
        for identity in value if isinstance(value, list) else [value]:
            checked(identity)
    policy = {"displayUse": "single source-generalized internal-boundary representation at every zoom", "projection": "EPSG:3857",
        "method": "Arclength Gaussian filtering of unsimplified source paths before small-error render resampling; degree-two provincial arcs join before filtering, with zero-derivative shared-junction corrections.",
        "sourceGaussianSigmaMercatorMeters": args.sigma, "sourceSamplingSpacingMercatorMeters": args.sample_spacing,
        "maximumOriginalSourceDeviationMercatorMeters": args.max_offset, "maximumRenderResamplingErrorMercatorMeters": args.render_error,
        "fixedSharedNodes": True, "exactNativeAndProjectedContactSets": True, "endpointCyclicOrderAndRayTiesPreserved": True,
        "closedLoopOrientationAndNestingPreserved": True, "authoritativeGeometryChanged": False,
        "coordinateDerivation": "New samples from the filtered unsimplified shared source network; never read previous simplified geometries. Exact source coordinates retained at all shared junctions."}
    code = pin("scripts/chn-2020/build-chn-source-internal-lines.py")
    geometry_bytes = {kind: encoded({"type": "FeatureCollection", "features": [f for f in output if categories[f["id"]] == kind]}) for kind in ("province", "micro")}
    import hashlib
    key = hashlib.sha256(encoded({"geometry": {k: hashlib.sha256(v).hexdigest() for k, v in geometry_bytes.items()}, "inputs": inputs, "code": code, "policy": policy})).hexdigest()[:20]
    folder = "data/derived/chn-2020/internal-line-source-" + key
    artifacts = {kind + "Geometry": immutable(folder + "/" + kind + ".geojson", data) for kind, data in geometry_bytes.items()}
    report = {"schemaVersion": "chn-internal-line-source-producer-v1", "pass": True, "countryId": "CHN", "administrativeTruthClaim": False,
        "catalogRef": baseline["catalogRef"], "inputs": inputs, "code": code, "policy": policy, **artifacts,
        "summary": {"edges": count, "generalizedEdges": sum(r["decision"] == "source-generalized" for r in reports),
            "originalVertices": sum(r["baselineVertices"] for r in reports),
            "joinedProvincialPaths": sum(len(p.members) > 1 for p in paths),
            "provincialJoinsProcessedTogether": sum(len(p.members) - 1 for p in paths),
            "originalContactSupportSegmentsRetained": sum(map(len, supports.values())),
            "displayVertices": sum(r["displayVertices"] for r in reports),
            "provinceVertices": sum(r["displayVertices"] for r in reports if r["category"] == "province"),
            "microVertices": sum(r["displayVertices"] for r in reports if r["category"] == "micro")}, "edges": reports,
        "limitations": ["Presentation curves only; independent verification must certify the actual delivered polylines before packaging.",
            "The deviation budget is measured directly against the original unsimplified shared network, not against a previous simplified version.",
            "Narrow contacts can require locally weaker filtering or exact source retention."]}
    identity = immutable(folder + "/producer-report.json", encoded(report))
    print(json.dumps({"report": identity, "summary": report["summary"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-delivery", required=True)
    parser.add_argument("--sigma", type=float, default=1800)
    parser.add_argument("--sample-spacing", type=float, default=600)
    parser.add_argument("--max-offset", type=float, default=2500)
    parser.add_argument("--render-error", type=float, default=70)
    main(parser.parse_args())
