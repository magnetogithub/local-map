"""Independent GEOS verifier for the actual CHN incremental partition.

This file does not import the generator. Run with PYTHONPATH=.tmp/chn-python.
Every acceptance is derived from pinned bytes and geometric measurements.
Unprovided replay, hierarchy, residual classifications, or numeric exceptions
remain failures; a generator's success flag is never treated as evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import defaultdict
from fractions import Fraction
from pathlib import Path
import time

import numpy as np
import shapely
from shapely.geometry import shape, Polygon, MultiPolygon, LineString
from shapely.strtree import STRtree
from pyproj import Geod


def read(file):
    return json.loads(Path(file).read_bytes())


def pin(file):
    file = str(file).replace("\\", "/")
    data = Path(file).read_bytes()
    return {"path": file, "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data)}


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def polygons(g):
    if g is None or g.is_empty:
        return []
    if g.geom_type == "Polygon":
        return [g]
    if g.geom_type == "MultiPolygon":
        return list(g.geoms)
    return [p for part in getattr(g, "geoms", []) for p in polygons(part)]


def segment_key(a, b):
    a, b = tuple(a[:2]), tuple(b[:2])
    return (a, b) if a < b else (b, a)


def segments(geometry):
    coordinates = geometry["coordinates"]
    for poly in [coordinates] if geometry["type"] == "Polygon" else coordinates:
        for ring in poly:
            for a, b in zip(ring, ring[1:]):
                if a != b:
                    yield segment_key(a, b)


def directed_segments(geometry):
    coordinates = geometry["coordinates"]
    for poly in [coordinates] if geometry["type"] == "Polygon" else coordinates:
        for index, ring in enumerate(poly):
            counterclockwise = bool(shapely.is_ccw(LineString(ring)))
            interior_left = counterclockwise if index == 0 else not counterclockwise
            for a, b in zip(ring, ring[1:]):
                if a != b:
                    key = segment_key(a, b)
                    forward = tuple(a[:2]) == key[0]
                    yield key, "left" if forward == interior_left else "right"


def line_segments(g):
    if g.geom_type in ["LineString", "LinearRing"]:
        coordinates = list(g.coords)
        return [LineString([a, b]) for a, b in zip(coordinates, coordinates[1:]) if a != b]
    return [segment for part in getattr(g, "geoms", []) for segment in line_segments(part)]


def certify_line_coverage(reference, actual, one_way=False):
    """Two-way interval coverage, not merely endpoint Hausdorff distance.

    In particular, a missing interval inside a single original border segment
    fails even when every surviving endpoint lies exactly on that segment.
    """
    if reference.equals(actual):
        return {"pass": True, "exact": True, "subdivisionExceptions": []}
    numerical_policy = 1e-12
    exceptions = []
    failures = []
    directions = [("reference-to-actual", reference, actual)]
    if not one_way:
        directions.append(("actual-to-reference", actual, reference))
    for direction, source, target in directions:
        target_segments = line_segments(target)
        if not target_segments:
            failures.append({"direction": direction, "reason": "missing complete line"})
            continue
        target_tree = STRtree(target_segments)
        for segment in line_segments(source):
            a, b = list(segment.coords)
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            squared = length * length
            intervals = []
            west, south, east, north = segment.bounds
            search_bounds = shapely.box(west - numerical_policy, south - numerical_policy, east + numerical_policy, north + numerical_policy)
            for index in target_tree.query(search_bounds):
                c, d = list(target_segments[int(index)].coords)
                tc = ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / squared
                td = ((d[0] - a[0]) * dx + (d[1] - a[1]) * dy) / squared
                low, high = max(0, min(tc, td)), min(1, max(tc, td))
                if high > low:
                    # Compare only the overlapping subsegment. Extrapolating
                    # a 1e-5-degree noded piece's rounded heading over a long
                    # old segment magnifies angular roundoff into a false gap.
                    overlap_points = [shapely.Point(a[0] + t * dx, a[1] + t * dy) for t in [low, high]]
                    displacement = max(p.distance(target_segments[int(index)]) for p in overlap_points)
                    if displacement > numerical_policy:
                        continue
                    intervals.append((low, high))
                    if displacement:
                        exceptions.append({"direction": direction, "originalSegment": [a, b], "matchingSegment": [c, d], "maximumPerpendicularDistanceDegrees": displacement})
            cursor = 0.0
            gaps = []
            for low, high in sorted(intervals):
                if low > cursor:
                    gaps.append((cursor, low))
                cursor = max(cursor, high)
            if cursor < 1:
                gaps.append((cursor, 1.0))
            for low, high in gaps:
                distance = (high - low) * length
                item = {"direction": direction, "originalSegment": [a, b], "missingInterval": [low, high], "lengthDegrees": distance}
                if distance > numerical_policy:
                    failures.append(item)
                elif distance > 0:
                    exceptions.append(item)
    return {"pass": not failures, "exact": False, "existingRepresentationPolicyDegrees": numerical_policy, "subdivisionExceptions": exceptions, "failures": failures}


def indexed_discrete_hausdorff(left, right):
    """GEOS default discrete Hausdorff, with an indexed nearest-segment query.

    The full national coast has too many vertices for GEOS's unindexed
    point-to-whole-line loop. Every original boundary vertex is still checked.
    """
    maximum = 0.0
    for source, target in [(left, right), (right, left)]:
        segments_array = np.array(line_segments(target), dtype=object)
        coordinates = shapely.get_coordinates(source)
        if not len(segments_array):
            return math.inf if len(coordinates) else maximum
        tree = STRtree(segments_array)
        for offset in range(0, len(coordinates), 4096):
            points = shapely.points(coordinates[offset:offset + 4096])
            nearest = tree.nearest(points)
            maximum = max(maximum, float(np.max(shapely.distance(points, segments_array[nearest]))))
    return maximum


def partition_boundary_rings(features):
    """Cancel exact internal incidence before walking national boundary cycles.

    This is an independent graph check and performs no overlay, snap, union,
    simplification, or buffering of the supplied shared mesh.
    """
    boundary = {}
    for f in features:
        for segment, side in directed_segments(f["geometry"]):
            a, b = segment if side == "left" else tuple(reversed(segment))
            if segment in boundary:
                if boundary[segment] != (b, a):
                    raise ValueError("NON_MANIFOLD_NATIONAL_BOUNDARY_DIRECTION")
                del boundary[segment]
            else:
                boundary[segment] = (a, b)
    outgoing = defaultdict(list)
    for a, b in boundary.values():
        outgoing[a].append(b)
    remaining = set(boundary.values())
    rings = []
    while remaining:
        a, b = min(remaining)
        first = (a, b)
        ring = [a]
        while True:
            remaining.remove((a, b))
            ring.append(b)
            reverse = math.atan2(a[1] - b[1], a[0] - b[0])
            candidates = outgoing[b]
            if not candidates:
                raise ValueError("OPEN_NATIONAL_BOUNDARY")
            c = min(candidates, key=lambda point: ((reverse - math.atan2(point[1] - b[1], point[0] - b[0])) % (2 * math.pi), point))
            if (b, c) == first:
                break
            if (b, c) not in remaining:
                raise ValueError("NATIONAL_BOUNDARY_CYCLE_REUSED")
            a, b = b, c
        # Split exact point-touch cycles; each positive component is retained.
        stack, positions = [], {}
        for point in ring:
            if point in positions:
                position = positions[point]
                cycle = stack[position:] + [point]
                if len(cycle) < 4:
                    raise ValueError("COLLAPSED_NATIONAL_BOUNDARY_CYCLE")
                rings.append(cycle)
                for removed in stack[position + 1:]:
                    positions.pop(removed, None)
                stack = stack[:position + 1]
            else:
                positions[point] = len(stack)
                stack.append(point)
    return rings


def geometry_from_boundary_rings(rings):
    shells = [ring for ring in rings if shapely.LinearRing(ring).is_ccw]
    holes = [ring for ring in rings if not shapely.LinearRing(ring).is_ccw]
    polygons_ = [Polygon(ring) for ring in shells]
    assigned = [[] for _ in shells]
    for ring in holes:
        candidates = [i for i, polygon in enumerate(polygons_) if polygon.covers(shapely.Point(ring[0]))]
        if not candidates:
            raise ValueError("NATIONAL_HOLE_WITHOUT_SHELL")
        parent = min(candidates, key=lambda i: polygons_[i].area)
        assigned[parent].append(ring)
    polygons_ = [Polygon(shell, contained) for shell, contained in zip(shells, assigned)]
    return polygons_[0] if len(polygons_) == 1 else MultiPolygon(polygons_)


def certify_exact_source_gap(gap, raw_features, requested_pair, country):
    """Certify one finite native-coordinate triangular gap, using exact rationals.

    This is an ordinary explicit gameplay residual, not a numeric tolerance.
    All candidate raw polygons must be checked, including third-party sources.
    """
    if gap.geom_type != "Polygon" or len(gap.interiors) or len(gap.exterior.coords) != 4:
        return {"pass": False, "reason": "Only explicitly pinned finite triangles are supported"}
    native = [tuple(p) for p in list(gap.exterior.coords)[:-1]]
    vertices = [tuple(Fraction(value) for value in p) for p in native]

    def orient(a, b, p):
        return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])

    determinant = orient(vertices[0], vertices[1], vertices[2])
    if determinant == 0:
        return {"pass": False, "reason": "Collapsed triangle"}
    sign = 1 if determinant > 0 else -1

    def strictly_inside_triangle(p):
        return all(sign * orient(a, b, p) > 0 for a, b in zip(vertices, vertices[1:] + vertices[:1]))

    def ring_contains(ring, p):
        inside = False
        for aa, bb in zip(ring, ring[1:]):
            a, b = tuple(Fraction(x) for x in aa), tuple(Fraction(x) for x in bb)
            if orient(a, b, p) == 0 and min(a[0], b[0]) <= p[0] <= max(a[0], b[0]) and min(a[1], b[1]) <= p[1] <= max(a[1], b[1]):
                return True
            if (a[1] > p[1]) != (b[1] > p[1]):
                crossing = a[0] + (p[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
                if crossing > p[0]:
                    inside = not inside
        return inside

    center = tuple(sum(p[k] for p in vertices) / 3 for k in [0, 1])
    native_points, native_edge_witnesses, owners, crossings, inside_vertices = set(), [], [], [], []
    for f in raw_features:
        sid = source_id(f)
        geometry = f["geometry"]
        ps = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        if any(ring_contains(p[0], center) and not any(ring_contains(hole, center) for hole in p[1:]) for p in ps):
            owners.append(sid)
        for component_index, polygon in enumerate(ps):
            for ring_index, ring in enumerate(polygon):
                if sid in requested_pair:
                    native_points.update(tuple(p) for p in ring)
                for edge_index, (aa, bb) in enumerate(zip(ring, ring[1:])):
                    a, b = tuple(Fraction(x) for x in aa), tuple(Fraction(x) for x in bb)
                    if strictly_inside_triangle(a):
                        inside_vertices.append({"sourceFeatureId": sid, "coordinate": aa})
                    for triangle_index, (c, d) in enumerate(zip(vertices, vertices[1:] + vertices[:1])):
                        if orient(a, b, c) * orient(a, b, d) < 0 and orient(c, d, a) * orient(c, d, b) < 0:
                            crossings.append({"sourceFeatureId": sid, "sourceSegment": [aa, bb], "triangleEdge": triangle_index})
                        if sid in requested_pair and {tuple(aa), tuple(bb)} == {native[triangle_index], native[(triangle_index + 1) % 3]}:
                            native_edge_witnesses.append({"sourceFeatureId": sid, "componentIndex": component_index, "ringIndex": ring_index, "edgeIndex": edge_index, "triangleEdge": triangle_index, "coordinates": [aa, bb]})
    area = abs(determinant) / 2
    native_verified = set(native) <= native_points
    pair_verified = set(requested_pair) <= {w["sourceFeatureId"] for w in native_edge_witnesses}
    within_country = bool(country.covers(gap))
    return {"pass": native_verified and pair_verified and within_country and not owners and not crossings and not inside_vertices,
            "method": "exact Fraction arithmetic on the original IEEE-754 coordinate rationals; no epsilon",
            "requestedSourcePair": requested_pair, "allRawBoundingBoxCandidates": [source_id(f) for f in raw_features],
            "nativeVerticesVerified": native_verified, "nativeEdgeWitnesses": native_edge_witnesses,
            "exactAreaDegreesSquared": float(area), "exactAreaNumerator": str(area.numerator), "exactAreaDenominator": str(area.denominator),
            "exactInteriorWitness": [{"numerator": str(value.numerator), "denominator": str(value.denominator)} for value in center],
            "rawInteriorOwners": owners, "properRawEdgeCrossings": crossings, "rawVerticesInOpenTriangle": inside_vertices, "withinUnchangedCountry": within_country}


def family(feature):
    p = feature.get("properties", {})
    identity = p.get("fineSourceIdentity")
    if identity:
        return str(identity["sourceFeatureId"])
    return None


def source_id(feature):
    p = feature.get("properties", {})
    return str(p.get("sourceFeatureId", p.get("shapeID", feature.get("id", ""))))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--baseline-pointer", required=True)
    parser.add_argument("--cells")
    parser.add_argument("--normalized", required=True)
    parser.add_argument("--hierarchy", required=True)
    parser.add_argument("--macro-source")
    parser.add_argument("--replay")
    parser.add_argument("--numeric-exceptions")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    started = time.monotonic()
    failures = []
    print("verification: loading pinned baseline/candidate/source", flush=True)

    def check(ok, code, details=None):
        if not ok:
            failures.append({"code": code, "details": details})
            if len(failures) <= 8:
                print("verification: failure " + code, flush=True)
        return bool(ok)

    before = read(args.baseline)
    after = read(args.candidate)
    baseline_pointer = read(args.baseline_pointer)
    normalized = read(args.normalized)
    hierarchy = read(args.hierarchy)
    record_before = {r["id"]: r for r in before["records"]}
    record_after = {r["id"]: r for r in after["records"]}
    features_before = {f["id"]: f for f in before["features"]}
    features_after = {f["id"]: f for f in after["features"]}
    check(len(record_after) == len(after["records"]) == len(features_after) == len(after["features"]), "DUPLICATE_ID_OR_RECORD_COUNT")
    check(set(record_after) == set(features_after), "FEATURE_RECORD_IDS_DIFFER")
    geometries_before = {key: shape(f["geometry"]) for key, f in features_before.items()}
    geometries_after = {key: shape(f["geometry"]) for key, f in features_after.items()}
    target_before = {key for key, r in record_before.items() if r["countryId"] == "CHN"}
    target_after = {key for key, r in record_after.items() if r["countryId"] == "CHN"}
    check(bool(target_before) and len(target_after) > len(target_before), "TARGET_NOT_INCREMENTALLY_REFINED")
    print("verification: national unions", flush=True)
    target_union_before = shapely.union_all([geometries_before[key] for key in target_before])
    target_union_after = shapely.union_all([geometries_after[key] for key in target_after])
    overlay_union_counts = {"before": len(polygons(target_union_before)), "after": len(polygons(target_union_after))}
    exact_union_error = None
    try:
        exact_before = geometry_from_boundary_rings(partition_boundary_rings([features_before[key] for key in target_before]))
        exact_after = geometry_from_boundary_rings(partition_boundary_rings([features_after[key] for key in target_after]))
        if not exact_before.is_valid or not exact_after.is_valid:
            raise ValueError("INVALID_EXACT_NATIONAL_BOUNDARY")
        target_union_before, target_union_after = exact_before, exact_after
    except (ValueError, KeyError) as error:
        exact_union_error = str(error)

    exception_list = read(args.numeric_exceptions) if args.numeric_exceptions else []
    if isinstance(exception_list, dict):
        exception_list = exception_list.get("exceptions", [])
    exceptions = {e["id"]: e for e in exception_list}
    numerical = []
    boundary_segment_cache = {}
    containment_domain_cache = {}

    def input_segments_near_delta(boundaries, delta):
        west, south, east, north = delta.bounds
        window = shapely.box(west - 1e-12, south - 1e-12, east + 1e-12, north + 1e-12)
        selected = []
        for boundary in boundaries:
            if shapely.get_num_coordinates(boundary) > 10000:
                cached = boundary_segment_cache.get(id(boundary))
                if cached is None:
                    values = np.array(line_segments(boundary), dtype=object)
                    cached = (boundary, values, STRtree(values))
                    boundary_segment_cache[id(boundary)] = cached
                selected.extend(cached[1][cached[2].query(window)])
            else:
                selected.extend(line_segments(boundary))
        return np.array(selected, dtype=object)

    def boundary_node_correspondence(reference, actual):
        old_coordinates = {tuple(p) for p in shapely.get_coordinates(reference.boundary)}
        changed = sorted({tuple(p) for p in shapely.get_coordinates(actual.boundary)} - old_coordinates)
        if not changed:
            return []
        reference_segments = []
        for poly in polygons(reference):
            for ring in [poly.exterior, *poly.interiors]:
                coords = list(ring.coords)
                reference_segments.extend(LineString([a, b]) for a, b in zip(coords, coords[1:]) if a != b)
        segment_array = np.array(reference_segments, dtype=object)
        point_array = shapely.points(changed)
        nearest = STRtree(segment_array).nearest(point_array)
        distances = shapely.distance(point_array, segment_array[nearest])
        return [{"coordinate": list(coordinate), "originalSegment": list(segment_array[int(index)].coords), "distanceDegrees": float(distance)} for coordinate, index, distance in zip(changed, nearest, distances)]

    def physical_equal(a, b, identity, input_boundaries=None, protected_holes=None, containment_domain=None):
        # GEOS can return polygon+line GeometryCollections for a microscopic
        # overlay. Territory acceptance concerns the polygonal partition; an
        # empty polygonal intersection still fails rather than raising.
        if a.geom_type not in ["Polygon", "MultiPolygon"]:
            a = MultiPolygon(polygons(a))
        if b.geom_type not in ["Polygon", "MultiPolygon"]:
            b = MultiPolygon(polygons(b))
        # A native raw-source hole that is present in the reconstructed
        # source+ledger input cannot be erased by any numerical acceptance
        # branch, however small its area is.
        if protected_holes:
            input_holes = [Polygon(ring) for p in polygons(a) for ring in p.interiors]
            output_holes = [Polygon(ring) for p in polygons(b) for ring in p.interiors]
            for hole in protected_holes:
                if any(hole.equals(old) for old in input_holes) and not any(hole.equals(new) or certify_line_coverage(hole.boundary, new.boundary)["pass"] for new in output_holes):
                    numerical.append({"id": identity, "accepted": False, "reason": "A native source hole was removed without a recorded input gain", "nativeHoleSha256WKB": hashlib.sha256(hole.wkb).hexdigest()})
                    return False
        if a.equals(b):
            return True
        containment_proof = None
        containment_ok = True
        if containment_domain is not None:
            coordinates = [tuple(p) for p in shapely.get_coordinates(a)]
            for p in polygons(a):
                for ring in [p.exterior, *p.interiors]:
                    values = list(ring.coords)
                    coordinates.extend(((x[0] + y[0]) / 2, (x[1] + y[1]) / 2) for x, y in zip(values, values[1:]))
            points = shapely.points(coordinates)
            outside = np.where(~shapely.covers(containment_domain, points))[0]
            witnesses = []
            if len(outside):
                cached = containment_domain_cache.get(id(containment_domain))
                if cached is None:
                    values = np.array(line_segments(containment_domain.boundary), dtype=object)
                    cached = (containment_domain, values, STRtree(values))
                    containment_domain_cache[id(containment_domain)] = cached
                _, values, tree = cached
                nearest = tree.nearest(points[outside])
                distances = shapely.distance(points[outside], values[nearest])
                witnesses = [{"coordinate": list(coordinates[int(index)]), "originalDomainSegment": list(values[int(segment_index)].coords), "distanceDegrees": float(distance)}
                             for index, segment_index, distance in zip(outside, nearest, distances)]
                containment_ok = bool(np.max(distances) <= 1e-12)
            containment_proof = {"allVerticesAndSegmentMidpointsInsideOrIndividuallyBounded": containment_ok, "existingRepresentationPolicyDegrees": 1e-12,
                                 "outsidePointWitnesses": witnesses}
        delta = a.symmetric_difference(b)
        displacement = indexed_discrete_hausdorff(a.boundary, b.boundary)
        measured = {"id": identity, "symmetricDifferenceAreaDegreesSquared": delta.area, "boundaryDisplacementDegrees": displacement if math.isfinite(displacement) else None}
        allowed = exceptions.get(identity)
        accepted = bool(allowed and allowed.get("reason") and
                        delta.area <= allowed.get("maximumSymmetricDifferenceAreaDegreesSquared", -1) and
                        displacement <= allowed.get("maximumBoundaryDisplacementDegrees", -1))
        noding_proof = None
        if not accepted and (identity.startswith("source-family:") or identity.startswith("residual-gain:") or identity.startswith("numerical-face:") or identity in ["CHN:national-union", "CHN:active-edge-envelope"] or (allowed is not None and identity.startswith("territory:catalog:"))):
            # The pre-existing representation policy is checked independently
            # for this specific changed boundary. This does not relax strict
            # overlap, shared-segment, incidence, or national component checks.
            policy = 1e-12
            delta_parts = polygons(delta)
            widths = [2 * p.area / p.length if p.length else math.inf for p in delta_parts]
            same_structure = len(polygons(a)) == len(polygons(b)) and sum(len(p.interiors) for p in polygons(a)) == sum(len(p.interiors) for p in polygons(b))
            if same_structure and displacement <= policy and all(width <= policy for width in widths):
                inserted = boundary_node_correspondence(a, b)
                removed = boundary_node_correspondence(b, a)
                maximum = max([entry["distanceDegrees"] for entry in [*inserted, *removed]], default=0)
                accepted = maximum <= policy
                noding_proof = {"method": "individual straight-segment correspondence of every inserted/removed boundary coordinate", "existingRepresentationPolicyDegrees": policy,
                                "maximumMeasuredCoordinateDistanceDegrees": maximum, "symmetricDifferenceComponentWidthsDegrees": widths,
                                "insertedCoordinates": inserted, "removedCoordinates": removed,
                                "deltaGeometry": shapely.geometry.mapping(delta), "deltaGeometrySha256WKB": hashlib.sha256(delta.wkb).hexdigest(),
                                "componentsAndHolesUnchanged": same_structure}
            if not accepted and input_boundaries is not None and all(width <= policy for width in widths):
                # A floating overlay can create a microscopic internal hole
                # on a raw/gain contact. Its distance to the final OUTER ring
                # is immaterial; prove every delta coordinate against the
                # unchanged approved input segments instead.
                coordinates = shapely.get_coordinates(delta)
                segment_array = input_segments_near_delta(input_boundaries, delta) if len(coordinates) else np.array([], dtype=object)
                if len(segment_array) and len(coordinates):
                    points = shapely.points(coordinates)
                    nearest = STRtree(segment_array).nearest(points)
                    distances = shapely.distance(points, segment_array[nearest])
                    maximum = float(np.max(distances))
                    accepted = maximum <= policy
                    if accepted:
                        noding_proof = {"method": "individual microscopic overlay delta traced to unchanged raw-source/recorded-gain boundary segments", "existingRepresentationPolicyDegrees": policy,
                                        "maximumMeasuredCoordinateDistanceDegrees": maximum, "symmetricDifferenceComponentWidthsDegrees": widths,
                                        "deltaCoordinateWitnesses": [{"coordinate": list(coordinate), "originalSegment": list(segment_array[int(index)].coords), "distanceDegrees": float(distance)} for coordinate, index, distance in zip(coordinates, nearest, distances)],
                                        "deltaGeometry": shapely.geometry.mapping(delta), "deltaGeometrySha256WKB": hashlib.sha256(delta.wkb).hexdigest(),
                                        "componentsAndHolesUnchanged": same_structure, "structureDifferenceConfinedToRecordedNumericalDelta": True}
            if not accepted and input_boundaries is not None:
                # GEOS may return an EMPTY area delta while retaining false
                # microscopic internal boundary cycles. Prove actual boundary
                # intervals directly against the unchanged approved input
                # network, rather than treating empty as a tolerance or using
                # a kilometer-scale distance to an unrelated outer ring.
                area_bound = policy * (a.length + b.length)
                if delta.area <= area_bound:
                    network_segments = [segment for boundary in input_boundaries for segment in line_segments(boundary)]
                    network = shapely.MultiLineString(network_segments)
                    actual_intervals = certify_line_coverage(b.boundary, network, one_way=True)
                    expected_intervals = certify_line_coverage(a.boundary, network, one_way=True)
                    protected = []
                    a_holes = [Polygon(ring) for p in polygons(a) for ring in p.interiors]
                    b_holes = [Polygon(ring) for p in polygons(b) for ring in p.interiors]
                    for hole in protected_holes or []:
                        expected_present = any(hole.equals(old) for old in a_holes)
                        if not expected_present:
                            continue  # Explicit recorded gameplay gain may fill a land residual.
                        final_present = any(hole.equals(new) or certify_line_coverage(hole.boundary, new.boundary)["pass"] for new in b_holes)
                        protected.append({"nativeHoleSha256WKB": hashlib.sha256(hole.wkb).hexdigest(), "retained": final_present})
                    accepted = actual_intervals["pass"] and expected_intervals["pass"] and all(p["retained"] for p in protected)
                    noding_proof = {"pass": accepted, "method": "complete per-interval correspondence of both polygon boundaries to the unchanged approved raw-source/recorded-gain segment network",
                                    "existingRepresentationPolicyDegrees": policy, "actualBoundaryIntervals": actual_intervals, "expectedBoundaryIntervals": expected_intervals,
                                    "observedSymmetricDifferenceAreaDegreesSquared": delta.area, "perCaseAreaBoundDerivedFromCoordinateBoundAndPerimeters": area_bound,
                                    "nativeSourceHoles": protected, "originalSourceComponentsIndependentlyGuarded": True,
                                    "componentsAndHolesUnchanged": same_structure, "overlayCycleDifferencesIndividuallyBoundedByInputSegments": accepted}
        accepted = accepted and containment_ok
        numerical.append({**measured, "accepted": accepted, "exception": allowed, "independentNodingProof": noding_proof, "containmentCertificate": containment_proof})
        return accepted

    non_target_before = set(record_before) - target_before
    non_target_after = set(record_after) - target_after
    preserve_failures_start = len(failures)
    check(non_target_before == non_target_after, "NON_TARGET_IDS_CHANGED", {"removed": sorted(non_target_before - non_target_after), "added": sorted(non_target_after - non_target_before)})
    representation_changes = []
    print("verification: non-target IDs/records/geometry/lineage", flush=True)
    for key in sorted(non_target_before & non_target_after):
        check(record_before[key] == record_after[key], "NON_TARGET_RECORD_CHANGED", key)
        check(features_before[key].get("properties", {}) == features_after[key].get("properties", {}), "NON_TARGET_FEATURE_PROVENANCE_CHANGED", key)
        if features_before[key]["geometry"] != features_after[key]["geometry"]:
            check(physical_equal(geometries_before[key], geometries_after[key], key), "NON_TARGET_PHYSICAL_TERRITORY_CHANGED", key)
            representation_changes.append(key)
    for group in ["administrative", "previous"]:
        key_name = "parentKey" if group == "administrative" else "oldTerritoryId"
        old = {p[key_name]: p for p in before["parents"][group] if p["sourceCountryId"] != "CHN"}
        new = {p[key_name]: p for p in after["parents"][group] if p["sourceCountryId"] != "CHN"}
        check(old == new, "NON_TARGET_PARENT_OR_LINEAGE_CHANGED", group)
    non_target_pass = len(failures) == preserve_failures_start

    print("verification: validity, national coverage and strict overlaps", flush=True)
    invalid = [{"id": key, "reason": shapely.is_valid_reason(g)} for key, g in geometries_after.items() if not g.is_valid]
    check(not invalid, "INVALID_GEOMETRY", invalid[:50])
    duplicate_geometries = defaultdict(list)
    for key in target_after:
        duplicate_geometries[shapely.normalize(geometries_after[key]).wkb].append(key)
    duplicates = [ids for ids in duplicate_geometries.values() if len(ids) > 1]
    check(not duplicates, "DUPLICATE_TARGET_GEOMETRY", duplicates[:20])
    coverage_start = len(failures)
    check(exact_union_error is None, "EXACT_NATIONAL_BOUNDARY_CANCELLATION_FAILED", exact_union_error)
    check(physical_equal(target_union_before, target_union_after, "CHN:national-union"), "TARGET_NATIONAL_UNION_CHANGED")
    check(len(polygons(target_union_before)) == len(polygons(target_union_after)), "NATIONAL_COMPONENTS_CHANGED")
    check(sum(len(p.interiors) for p in polygons(target_union_before)) == sum(len(p.interiors) for p in polygons(target_union_after)), "NATIONAL_HOLES_CHANGED")
    original_country_component_audit = []
    final_country_components = polygons(target_union_after)
    final_component_tree = STRtree(final_country_components)
    for index, component in enumerate(polygons(target_union_before)):
        retained = sum(component.intersection(final_country_components[int(i)]).area for i in final_component_tree.query(component))
        check(retained > 0, "ORIGINAL_COUNTRY_COMPONENT_REMOVED", index)
        original_country_component_audit.append({"index": index, "originalGeometrySha256WKB": hashlib.sha256(component.wkb).hexdigest(), "originalAreaDegreesSquared": component.area, "retainedIntersectionAreaDegreesSquared": retained})
    target_keys = sorted(target_after)
    target_geometries = [geometries_after[key] for key in target_keys]
    tree = STRtree(target_geometries)
    overlap_pairs = []
    for i, g in enumerate(target_geometries):
        for j in tree.query(g, predicate="intersects"):
            j = int(j)
            if j <= i:
                continue
            # DE-9IM's first matrix entry is interior/interior intersection.
            relation = g.relate(target_geometries[j])
            if relation[0] == "2":
                area = g.intersection(target_geometries[j]).area
                if area > 0:
                    overlap_pairs.append({"left": target_keys[i], "right": target_keys[j], "areaDegreesSquared": area, "de9im": relation})
    check(not overlap_pairs, "POSITIVE_AREA_TARGET_OVERLAPS", overlap_pairs[:50])
    coverage_pass = len(failures) == coverage_start and not invalid and not duplicates

    # Validate acquired input and all declared evidence pins independently.
    source_start = len(failures)
    print("verification: all declared source/hierarchy/license/baseline pins", flush=True)
    seen_pins = {}
    input_pin_aliases = []

    def verify_pin(identity):
        file = identity["path"]
        if file in seen_pins:
            check(seen_pins[file] == identity, "CONTRADICTORY_INPUT_PINS", file)
            return
        try:
            actual = pin(file)
            ok = actual["sha256"] == identity["sha256"] and actual["byteLength"] == identity["byteLength"]
        except OSError:
            actual, ok = None, False
        seen_pins[file] = identity
        check(ok, "INPUT_PIN_CHANGED_OR_MISSING", {"expected": identity, "actual": actual})

    def walk_pins(value):
        if isinstance(value, dict):
            if all(k in value for k in ["path", "sha256", "byteLength"]):
                verify_pin({k: value[k] for k in ["path", "sha256", "byteLength"]})
            for child in value.values():
                walk_pins(child)
        elif isinstance(value, list):
            for child in value:
                walk_pins(child)

    report = after.get("report", {})
    for name in ["sourceLockArtifacts", "hierarchyArtifacts", "incremental"]:
        walk_pins(report.get(name, {}))
    for artifact in report.get("hierarchyArtifacts", []):
        walk_pins(read(artifact["path"]))
    if report.get("incremental", {}).get("sourceDecision"):
        walk_pins(read(report["incremental"]["sourceDecision"]["path"]))
    baseline_claim = report.get("incremental", {}).get("baseline", {})
    check(baseline_claim.get("bundle") == pin(args.baseline), "DECLARED_BASELINE_BUNDLE_DIFFERS")
    check(baseline_claim.get("pointer") == pin(args.baseline_pointer), "DECLARED_BASELINE_POINTER_DIFFERS")
    try:
        index_file = Path(baseline_pointer["root"]) / "artifact-index.json"
        index_identity = pin(index_file)
        check(index_identity["sha256"] == baseline_pointer["index"]["sha256"] and index_identity["byteLength"] == baseline_pointer["index"]["byteLength"], "BASELINE_INDEX_PIN_CHANGED")
        for artifact in read(index_file)["artifacts"]:
            verify_pin({**artifact, "path": str(Path(baseline_pointer["root"]) / artifact["path"]).replace("\\", "/")})
        provenance = read(Path(baseline_pointer["root"]) / "provenance.json")
        check(provenance.get("inputRoot") == pin(args.baseline)["sha256"], "BASELINE_PROVENANCE_INPUT_MISMATCH")
    except (OSError, KeyError) as error:
        check(False, "BASELINE_DELIVERY_LINK_UNREADABLE", str(error))
    lock_countries = []
    for artifact in report.get("sourceLockArtifacts", []):
        lock = read(artifact["path"])
        lock_countries.append(lock.get("countryId"))
        walk_pins(lock)
        for source in lock.get("sources", []):
            check(source.get("license", {}).get("redistributionAllowed") is True, "SOURCE_LICENSE_NOT_CONFIRMED", source.get("sourceId"))
    check(set(lock_countries) == {"CHN", "KOR", "PRK"}, "SOURCE_LOCK_SCOPE", lock_countries)
    for file in [args.normalized, args.hierarchy, args.macro_source, args.numeric_exceptions]:
        if file:
            identity = pin(file)
            matching = [value for value in seen_pins.values() if value["sha256"] == identity["sha256"] and value["byteLength"] == identity["byteLength"]]
            check(bool(matching), "VERIFIER_INPUT_NOT_PINNED_BY_CANDIDATE", file)
            if matching and identity["path"] not in seen_pins:
                input_pin_aliases.append({"verifierInput": identity, "pinnedEquivalent": matching[0]})
    source_pass = len(failures) == source_start

    baseline_cells_artifact = baseline_claim.get("cells")
    baseline_cells = read(baseline_cells_artifact["path"])["features"] if baseline_cells_artifact else before["features"]
    inherited_fine = {}
    for f in baseline_cells:
        local_id = f.get("id", "")
        global_id = local_id if local_id in features_before else "territory:catalog:" + hashlib.sha256(("prompt19-global-cell.v1\0" + canonical(local_id)).encode()).hexdigest()
        if family(f) and f.get("properties", {}).get("countryId") in ["KOR", "PRK"]:
            check(global_id in features_before, "BASELINE_FINE_CELL_ID_UNMAPPED", local_id)
            if global_id in features_before:
                check(shape(f["geometry"]).equals(geometries_before[global_id]), "BASELINE_FINE_CELL_GEOMETRY_MISMATCH", global_id)
                inherited_fine[global_id] = f

    # Source parents must come from the pinned crosswalk, never a fresh spatial
    # guess in this verifier. Full containment measurements remain in the lock.
    hierarchy_start = len(failures)
    print("verification: raw source containment and source-family registry", flush=True)
    active_outline = [shape(e["geometry"]) for e in before["edges"] if
                      (record_before[e["leftTerritoryId"]]["countryId"] == "CHN") !=
                      (record_before[e["rightTerritoryId"]]["countryId"] == "CHN" if e.get("rightTerritoryId") else False)]
    active_faces = list(shapely.polygonize(np.array(active_outline, dtype=object)).geoms)
    active_land_faces = [p for p in active_faces if target_union_before.covers(p.representative_point())]
    source_reference_envelope = MultiPolygon(active_land_faces)
    check(source_reference_envelope.is_valid and physical_equal(target_union_before, source_reference_envelope, "CHN:active-edge-envelope"), "ACTIVE_EDGE_ENVELOPE_DIFFERS_FROM_PINNED_FILL")
    macro_groups = {group["macroId"]: group for group in hierarchy.get("macroGroups", [])}
    parent_raw_features = {source_id(f): f for f in read(hierarchy["sourceFine"]["path"])["features"]} if hierarchy.get("sourceFine") else {}
    floating = read(hierarchy["floatingPrecisionExceptions"]["path"]).get("exceptions", []) if hierarchy.get("floatingPrecisionExceptions") else []
    floating_by_source = {e["sourceFeatureId"]: e for e in floating}
    floating_parent_measurements = []
    administrative_parents = {p["parentKey"]: p for p in after["parents"]["administrative"]}
    macro_by_id = {}
    if args.macro_source:
        for f in read(args.macro_source)["features"]:
            p = f.get("properties", {})
            for key in [f.get("id"), p.get("sourceFeatureId"), p.get("shapeID"), p.get("shapeISO"), p.get("sourceParentId")]:
                if key:
                    macro_by_id[str(key)] = shape(f["geometry"])
    check(bool(macro_by_id), "COMPATIBLE_MACRO_POLYGONS_MISSING")
    assignments = hierarchy.get("assignments", hierarchy.get("fineToMacro", hierarchy.get("entries", hierarchy.get("crosswalk", []))))
    if isinstance(assignments, dict):
        assignments = [{"sourceFeatureId": key, **(value if isinstance(value, dict) else {"sourceParentId": value})} for key, value in assignments.items()]
    assignments = [*assignments, *hierarchy.get("unresolved", [])]
    by_source = {str(a.get("sourceFeatureId", a.get("fineSourceFeatureId", ""))): a for a in assignments}
    fine_features = {key: f for key, f in features_after.items() if key in target_after and family(f)}
    if args.cells:
        cell_features = read(args.cells)["features"]
        for f in cell_features:
            if f.get("id") in target_after and family(f):
                fine_features[f["id"]] = f
    check(bool(by_source), "HIERARCHY_ASSIGNMENTS_MISSING")
    source_families = defaultdict(list)
    for key, f in fine_features.items():
        source_families[family(f)].append(key)
        assignment = by_source.get(family(f))
        check(assignment is not None, "FINE_FAMILY_WITHOUT_CROSSWALK", family(f))
        if assignment:
            p = f.get("properties", {})
            expected_parent = assignment.get("sourceParentId", assignment.get("macroId", assignment.get("macroSourceFeatureId", assignment.get("parentSourceFeatureId"))))
            if expected_parent is not None:
                check(str(p.get("sourceParentId")) == str(expected_parent), "SOURCE_PARENT_CHANGED", key)
            else:
                check(administrative_parents[record_after[key]["administrativeParentKey"]]["kind"] == "country-envelope-residual", "UNCONFIRMED_PARENT_CLAIMED_ADMINISTRATIVE", key)
            expected_key = assignment.get("administrativeParentKey")
            if expected_key:
                check(record_after[key]["administrativeParentKey"] == expected_key, "ADMINISTRATIVE_PARENT_CROSSWALK_MISMATCH", key)
    normalized_by_id = {source_id(f): f for f in normalized["features"]}
    check(len(normalized_by_id) == len(normalized["features"]), "DUPLICATE_NORMALIZED_SOURCE_ID")
    check(set(source_families) <= set(normalized_by_id), "UNREGISTERED_SOURCE_FAMILY")
    original_clips = {}
    normalized_geometry_by_id = {}
    original_scope_components = defaultdict(list)
    missing_in_envelope_sources = []
    for sid, f in normalized_by_id.items():
        g = shape(f["geometry"])
        normalized_geometry_by_id[sid] = g
        if not g.is_valid:
            check(False, "INVALID_NORMALIZED_SOURCE", sid)
            continue
        clipped = g.intersection(source_reference_envelope)
        for raw_component_index, raw_component in enumerate(polygons(g)):
            fixed_scope = raw_component.intersection(target_union_before)
            for clipped_component_index, original_part in enumerate(polygons(fixed_scope)):
                if original_part.area > 0:
                    original_scope_components[sid].append((raw_component_index, clipped_component_index, original_part))
        assignment = by_source.get(sid)
        expected_parent = assignment.get("sourceParentId", assignment.get("macroId", assignment.get("macroSourceFeatureId", assignment.get("parentSourceFeatureId")))) if assignment else None
        if expected_parent is not None:
            parent_geometry_id = assignment.get("evidence", {}).get("parentSourceFeatureId", macro_groups.get(expected_parent, {}).get("sourceFeatureId", str(expected_parent)))
            parent_geometry = macro_by_id.get(str(parent_geometry_id))
            check(parent_geometry is not None, "CROSSWALK_PARENT_POLYGON_MISSING", {"sourceFeatureId": sid, "sourceParentId": expected_parent})
            if parent_geometry is not None:
                raw_g = shape(parent_raw_features[sid]["geometry"]) if sid in parent_raw_features else g
                if not raw_g.covered_by(parent_geometry):
                    outside = raw_g.difference(parent_geometry)
                    coordinates = shapely.get_coordinates(outside)
                    max_distance = float(np.max(shapely.distance(shapely.points(coordinates), parent_geometry))) if len(coordinates) else 0
                    wkb_hash = hashlib.sha256(outside.wkb).hexdigest()
                    exception = floating_by_source.get(sid)
                    accepted = bool(exception and exception.get("parentSourceFeatureId") == parent_geometry_id and exception.get("reason") and
                                    outside.area <= exception.get("areaAcceptanceBoundDegrees2", -1) and max_distance <= exception.get("distanceAcceptanceBoundDegrees", -1) and
                                    wkb_hash == exception.get("outsideGeometrySha256WKB"))
                    floating_parent_measurements.append({"sourceFeatureId": sid, "parentSourceFeatureId": parent_geometry_id, "outsideAreaDegreesSquared": outside.area, "maximumOutsideVertexDistanceDegrees": max_distance, "outsideGeometrySha256WKB": wkb_hash, "accepted": accepted})
                    check(accepted, "SOURCE_NOT_CONTAINED_BY_DECLARED_PARENT", floating_parent_measurements[-1])
        if clipped.area > 0:
            original_clips[sid] = clipped
            if sid not in source_families:
                missing_in_envelope_sources.append({"sourceFeatureId": sid, "areaDegreesSquared": clipped.area})
    check(not missing_in_envelope_sources, "MISSING_IN_ENVELOPE_SOURCE_FAMILY", missing_in_envelope_sources)
    hierarchy_pass = len(failures) == hierarchy_start

    # Rebuild exact incidence from polygon mesh segments, then compare every
    # edge touching CHN against those very segments. This catches unpaired
    # border noding even when a renderer hides the seam.
    topology_start = len(failures)
    print("verification: exact mesh/edge directional incidence and fine adjacency", flush=True)
    edges = after["edges"]
    check(len({e["id"] for e in edges}) == len(edges), "DUPLICATE_EDGE_ID")
    relevant_ids = set(target_after)
    edge_pairs = set()
    for e in edges:
        left, right = e.get("leftTerritoryId"), e.get("rightTerritoryId")
        check(left in record_after and (right is None or right in record_after) and left != right, "INVALID_EDGE_OWNERS", e["id"])
        if right:
            edge_pairs.add(tuple(sorted((left, right))))
        if left in target_after or right in target_after:
            relevant_ids.update(key for key in [left, right] if key)
    mesh = defaultdict(set)
    mesh_sides = defaultdict(lambda: {"left": set(), "right": set()})
    for key in relevant_ids:
        for segment, side in directed_segments(features_after[key]["geometry"]):
            mesh[segment].add(key)
            mesh_sides[segment][side].add(key)
    ambiguous_mesh = [{"segment": s, "owners": sorted(ids)} for s, ids in mesh.items() if len(ids) > 2]
    check(not ambiguous_mesh, "NON_MANIFOLD_MESH_SEGMENT", ambiguous_mesh[:30])
    edge_segments = defaultdict(list)
    border_stats = defaultdict(lambda: {"edges": 0, "segments": 0, "lengthDegrees": 0.0, "lengthKm": 0.0, "bothFineLengthKm": 0.0})
    geod = Geod(ellps="WGS84")
    for e in edges:
        left, right = e.get("leftTerritoryId"), e.get("rightTerritoryId")
        if left not in target_after and right not in target_after:
            continue
        owners = {key for key in [left, right] if key}
        coords = e["geometry"]["coordinates"]
        check(len(coords) >= 2 and LineString(coords).length > 0, "ZERO_EDGE", e["id"])
        expected_class = "coast" if right is None else "country" if record_after[left]["countryId"] != record_after[right]["countryId"] else "administrative" if record_after[left]["administrativeParentKey"] != record_after[right]["administrativeParentKey"] else "operational"
        check(e["boundaryClass"] in ([expected_class, "residual"] if expected_class in ["administrative", "operational"] else [expected_class]), "EDGE_CLASS_DISAGREES_WITH_PARTITION", e["id"])
        if right and left in fine_features and right in fine_features and family(fine_features[left]) == family(fine_features[right]):
            check(record_after[left]["administrativeParentKey"] == record_after[right]["administrativeParentKey"], "FAKE_MACRO_LINE_CUTS_FINE_FAMILY", e["id"])
        for a, b in zip(coords, coords[1:]):
            segment = segment_key(a, b)
            check(mesh.get(segment) == owners, "EDGE_MESH_INCIDENCE_MISMATCH", {"edgeId": e["id"], "segment": segment, "expectedOwners": sorted(owners), "meshOwners": sorted(mesh.get(segment, set()))})
            direction = tuple(a[:2]) == segment[0]
            left_side, right_side = ("left", "right") if direction else ("right", "left")
            check(mesh_sides[segment][left_side] == {left} and mesh_sides[segment][right_side] == ({right} if right else set()), "EDGE_MESH_DIRECTIONAL_INCIDENCE_MISMATCH", {"edgeId": e["id"], "segment": segment, "left": left, "right": right, "meshLeft": sorted(mesh_sides[segment][left_side]), "meshRight": sorted(mesh_sides[segment][right_side])})
            edge_segments[segment].append(e["id"])
        if right and record_after[left]["countryId"] != record_after[right]["countryId"]:
            countries = "|".join(sorted([record_after[left]["countryId"], record_after[right]["countryId"]]))
            border_stats[countries]["edges"] += 1
            border_stats[countries]["segments"] += len(coords) - 1
            border_stats[countries]["lengthDegrees"] += LineString(coords).length
            km = geod.geometry_length(LineString(coords)) / 1e3
            border_stats[countries]["lengthKm"] += km
            if (left in fine_features or left in inherited_fine) and (right in fine_features or right in inherited_fine):
                border_stats[countries]["bothFineLengthKm"] += km
    for segment, owners in mesh.items():
        if owners & target_after:
            check(len(edge_segments.get(segment, [])) == 1, "MISSING_OR_DUPLICATE_TARGET_MESH_EDGE", {"segment": segment, "owners": sorted(owners), "edgeIds": edge_segments.get(segment, [])})
    positive_pairs = set()
    for segment, owners in mesh.items():
        if len(owners) == 2 and owners & target_after:
            positive_pairs.add(tuple(sorted(owners)))
    check(positive_pairs <= edge_pairs, "MISSING_POSITIVE_LENGTH_ADJACENCY", list(positive_pairs - edge_pairs)[:30])
    original_korean_pairs = {tuple(sorted([e["leftTerritoryId"], e["rightTerritoryId"]])) for e in before["edges"] if e.get("rightTerritoryId") and {record_before[e["leftTerritoryId"]]["countryId"], record_before[e["rightTerritoryId"]]["countryId"]} == {"KOR", "PRK"}}
    current_korean_pairs = {pair for pair in edge_pairs if {record_after[pair[0]]["countryId"], record_after[pair[1]]["countryId"]} == {"KOR", "PRK"}}
    check(original_korean_pairs == current_korean_pairs, "KOREAN_BORDER_FINE_CONNECTIONS_CHANGED")
    check("CHN|PRK" in border_stats, "CHINA_DPRK_BORDER_MISSING")
    if "CHN|PRK" in border_stats:
        china_korea = border_stats["CHN|PRK"]
        check(china_korea["bothFineLengthKm"] == china_korea["lengthKm"], "CHINA_DPRK_BORDER_NOT_FINE_BOTH_SIDES_100_PERCENT", china_korea)
    korean_border = {"lengthKm": 0.0, "bothFineLengthKm": 0.0}
    for e in edges:
        left, right = e.get("leftTerritoryId"), e.get("rightTerritoryId")
        if right and {record_after[left]["countryId"], record_after[right]["countryId"]} == {"KOR", "PRK"}:
            km = geod.geometry_length(shape(e["geometry"])) / 1e3
            korean_border["lengthKm"] += km
            if left in inherited_fine and right in inherited_fine:
                korean_border["bothFineLengthKm"] += km
    check(korean_border["bothFineLengthKm"] == korean_border["lengthKm"] and korean_border["lengthKm"] > 0, "KOREAN_BORDER_NOT_FINE_BOTH_SIDES_100_PERCENT", korean_border)
    old_outlines, new_outlines = defaultdict(list), defaultdict(list)
    print("verification: complete border and coast interval coverage", flush=True)
    for state, records, destination in [(before, record_before, old_outlines), (after, record_after, new_outlines)]:
        for e in state["edges"]:
            left, right = e.get("leftTerritoryId"), e.get("rightTerritoryId")
            countries = {records[left]["countryId"]} | ({records[right]["countryId"]} if right else set())
            if "CHN" not in countries:
                continue
            if right is None:
                destination["CHN:coast"].append(shape(e["geometry"]))
            elif len(countries) == 2:
                destination["|".join(sorted(countries))].append(shape(e["geometry"]))
    outline_reports = {}
    for identity in sorted(set(old_outlines) | set(new_outlines)):
        old_line = shapely.union_all(old_outlines[identity])
        new_line = shapely.union_all(new_outlines[identity])
        certificate = certify_line_coverage(old_line, new_line)
        outline_reports[identity] = {**certificate, "beforeLengthKm": geod.geometry_length(old_line) / 1e3, "afterLengthKm": geod.geometry_length(new_line) / 1e3}
        check(certificate["pass"], "COUNTRY_BORDER_OR_COAST_COVERAGE_CHANGED", identity)
    topology_pass = len(failures) == topology_start

    residual_start = len(failures)
    print("verification: residual gain ledger and original fine-family preservation", flush=True)
    source_union = shapely.union_all(list(original_clips.values()))
    original_residual = source_reference_envelope.difference(source_union)
    shapely.prepare(original_residual)
    original_residual_boundary = original_residual.boundary
    source_contact_cache = {}

    def original_positive_contact(candidate, sid):
        original = original_clips[sid]
        exact_contact = candidate.boundary.intersection(original.boundary)
        if exact_contact.length > 0:
            return {"lengthDegrees": exact_contact.length, "method": "exact raw-family boundary intersection"}
        cached = source_contact_cache.get(sid)
        if cached is None:
            values = np.array(line_segments(original.boundary), dtype=object)
            cached = (values, STRtree(values))
            source_contact_cache[sid] = cached
        values, tree = cached
        for segment in line_segments(candidate.boundary):
            a, b = list(segment.coords)
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            squared = length * length
            west, south, east, north = segment.bounds
            for index in tree.query(shapely.box(west - 1e-12, south - 1e-12, east + 1e-12, north + 1e-12)):
                source_segment = values[int(index)]
                c, d = list(source_segment.coords)
                tc, td = [((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / squared for p in [c, d]]
                low, high = max(0, min(tc, td)), min(1, max(tc, td))
                if (high - low) * length <= 1e-12:
                    continue
                contacts = [shapely.Point(a[0] + t * dx, a[1] + t * dy) for t in [low, high]]
                maximum = max(point.distance(source_segment) for point in contacts)
                if maximum <= 1e-12:
                    return {"lengthDegrees": (high - low) * length, "method": "positive subsegment individually traced to original raw-family straight boundary",
                            "originalSourceSegment": [c, d], "candidateSegment": [a, b], "contactCoordinates": [list(point.coords)[0] for point in contacts],
                            "maximumEndpointDistanceDegrees": maximum, "existingRepresentationPolicyDegrees": 1e-12}
        return None
    gain_ledger_artifact = report.get("incremental", {}).get("residualGainLedger")
    gain_payload = read(gain_ledger_artifact["path"]) if gain_ledger_artifact else {}
    gain_ledger = gain_payload.get("residuals", [])
    numerical_faces = gain_payload.get("numericalFaces", [])
    numerical_face_stages = gain_payload.get("numericalFaceStages", [])
    final_numerical_stage = max([stage["stage"] for stage in numerical_face_stages], default=0)
    excluded_components = gain_payload.get("numericalComponentExclusions", [])
    del gain_payload
    recorded_gains = defaultdict(list)
    gain_part_audit = []
    normalized_order = [source_id(f) for f in normalized["features"]]
    residual_by_id = {}
    for entry in gain_ledger:
        residual_by_id.setdefault(entry["residualId"], entry)

    def bounded_existing_family_contact(part, sid, entry):
        if entry.get("stage") != "bounded-connected-family-cleanup":
            return None
        original_entry = residual_by_id.get(entry.get("originalResidualId"))
        anchor = entry.get("originalDistanceContact", {})
        index = anchor.get("sourceIndex")
        if original_entry is None or not isinstance(index, int) or normalized_order[index] != sid or index not in original_entry.get("contacts", []):
            return None
        projection = anchor.get("projection", {})
        if projection != original_entry.get("distanceProjection") or anchor.get("maximumContactDistanceKm") != 10 or entry.get("gameplayGainsUsedAsNewDistanceSeeds") is not False:
            return None
        scope = shape(original_entry["geometry"])
        shapely.prepare(scope)
        latitude = projection["latitude"]
        xs, ys = projection["xKmPerDegree"], projection["yKmPerDegree"]
        if xs != 111.195 * math.cos(math.radians(latitude)) or ys != 111.195 or abs(latitude - scope.representative_point().y) > 1e-12:
            return None
        line = LineString(anchor["coordinates"])
        source_trace = certify_line_coverage(line, original_clips[sid].boundary, one_way=True)
        scope_trace = certify_line_coverage(line, scope.boundary, one_way=True)
        if not source_trace["pass"] or not scope_trace["pass"]:
            return None
        projected_line = LineString([(x * xs, y * ys) for x, y in line.coords])
        projected_vertices = shapely.points([(x * xs, y * ys) for x, y in shapely.get_coordinates(part)])
        maximum_distance = float(np.max(shapely.distance(projected_vertices, projected_line)))
        if maximum_distance > 10:
            return None
        scope_ok = physical_equal(part, part.intersection(scope), f"residual-gain:{entry['residualId']}:original-scope",
                                  input_boundaries=[part.boundary, scope.boundary], containment_domain=scope)
        if not scope_ok:
            return None
        prior = shapely.union_all([original_clips[sid], *recorded_gains[sid]])
        for witness in entry.get("existingFamilyContactWitnesses", []):
            if witness.get("sourceIndex") != index:
                continue
            contact = LineString(witness["coordinates"])
            if contact.length <= 1e-12:
                continue
            part_trace = certify_line_coverage(contact, part.boundary, one_way=True)
            if not part_trace["pass"]:
                continue
            for component in polygons(prior):
                family_trace = certify_line_coverage(contact, component.boundary, one_way=True)
                if not family_trace["pass"] or component.intersection(original_clips[sid]).area <= 0:
                    continue
                anchor_points = [shapely.Point(p) for p in line.coords]
                if any(point.distance(component) > 1e-12 for point in anchor_points):
                    continue
                return {"method": "bounded completion through positively contacting accepted family; distance seed remains the pinned original raw contact",
                        "originalResidualId": original_entry["residualId"], "originalContactCoordinates": anchor["coordinates"], "originalProjection": projection,
                        "maximumWholePartDistanceKm": maximum_distance, "unchangedMaximumDistanceKm": 10,
                        "wholePartProof": "Distance to a finite segment is convex; polygon vertex maximum bounds the entire polygon and its convex hull",
                        "originalRawSourceTrace": source_trace, "originalScopeTrace": scope_trace,
                        "existingFamilyContactCoordinates": witness["coordinates"], "partContactTrace": part_trace, "priorFamilyContactTrace": family_trace,
                        "priorReceivingComponentOriginalCoreAreaDegreesSquared": component.intersection(original_clips[sid]).area,
                        "lengthDegrees": contact.length, "gameplayGainsUsedAsNewDistanceSeeds": False}
        return None
    component_exclusion_audit = []
    for n, entry in enumerate(excluded_components):
        g = shape(entry["geometry"])
        original_segment = LineString(entry["originalSegment"])
        width = 2 * g.area / g.length if g.length else math.inf
        distances = [shapely.Point(coordinate).distance(original_segment) for coordinate in shapely.get_coordinates(g)]
        old_intersection_area = g.intersection(target_union_before).area
        new_intersection_area = g.intersection(target_union_after).area
        outline_certificate = certify_line_coverage(original_segment, target_union_before.boundary, one_way=True)
        actual_hash = hashlib.sha256(g.wkb).hexdigest()
        named = entry.get("namedRepresentationException")
        named_ok = bool(named and named.get("id") and named.get("reason") and named.get("maximumCoordinateDistanceDegrees") == 1e-12 and
                        named.get("originalFiniteSegment") == entry["originalSegment"] and named.get("newlyCreatedCycle") is True)
        native_component_match = any(g.equals(original) for original in polygons(target_union_before))
        check(width <= 1e-12 and max(distances, default=math.inf) <= 1e-12 and (old_intersection_area == 0 or named_ok) and new_intersection_area == 0 and
              outline_certificate["pass"] and actual_hash == entry["geometrySha256WKB"] and not native_component_match and len(polygons(target_union_before)) == len(polygons(target_union_after)),
              "UNPROVED_NUMERICAL_COMPONENT_EXCLUSION", n)
        component_exclusion_audit.append({"index": n, "geometrySha256WKB": actual_hash, "areaDegreesSquared": g.area, "effectiveWidthDegrees": width,
                                          "originalCanonicalIntersectionAreaDegreesSquared": old_intersection_area, "finalIntersectionAreaDegreesSquared": new_intersection_area,
                                          "maximumOriginalSegmentDistanceDegrees": max(distances, default=None), "originalSegment": entry["originalSegment"], "originalOutlineCoverage": outline_certificate,
                                          "namedRepresentationException": named, "matchesOriginalCountryComponent": native_component_match,
                                          "allOriginalCountryComponentsIndependentlyRetained": all(p["retainedIntersectionAreaDegreesSquared"] > 0 for p in original_country_component_audit),
                                          "originalNativeCountryComponentDeleted": False,
                                          "interpretation": "Any nonzero original intersection is reported explicitly as this named finite-line representation corridor; it is not treated as exact zero"})
    verified_source_gaps = {}
    source_gap_certificates = []
    special_gap_entries = [entry for entry in gain_ledger if entry.get("stage") == "exact-source-pair-gap"]
    if special_gap_entries:
        raw_ids = list(normalized_geometry_by_id)
        raw_geometries = list(normalized_geometry_by_id.values())
        raw_tree = STRtree(raw_geometries)
        for entry in special_gap_entries:
            gap = shape(entry["geometry"])
            candidates = [normalized_by_id[raw_ids[int(i)]] for i in raw_tree.query(gap)]
            certificate = certify_exact_source_gap(gap, candidates, entry["originalSourceFeatureIds"], target_union_before)
            check(certificate["pass"], "EXACT_NATIVE_SOURCE_GAP_NOT_PROVED", certificate)
            source_gap_certificates.append({"residualId": entry["residualId"], "certificate": certificate, "geometry": entry["geometry"]})
            if certificate["pass"]:
                verified_source_gaps[entry["residualId"]] = gap
    for residual_entry in gain_ledger:
        residual_id = residual_entry.get("residualId")
        for index, entry in enumerate(residual_entry.get("gains", [])):
            sid = normalized_order[entry["sourceIndex"]]
            g = shape(entry["assignedPartGeometry"])
            outside = g.difference(original_residual)
            contact = original_positive_contact(g, sid)
            if contact is None:
                contact = bounded_existing_family_contact(g, sid, residual_entry)
            identity = f"residual-gain:{residual_id}:{index}"
            exact_gap = verified_source_gaps.get(residual_id)
            if exact_gap is not None:
                check(g.equals(exact_gap), "EXACT_SOURCE_GAP_GAIN_DIFFERS_FROM_PROVED_TRIANGLE", identity)
            else:
                check(physical_equal(g, g.intersection(original_residual), identity, input_boundaries=[g.boundary, original_residual_boundary], containment_domain=original_residual), "LEDGER_GAIN_OUTSIDE_ORIGINAL_RESIDUAL", identity)
            check(g.is_valid and contact is not None, "LEDGER_GAIN_WITHOUT_POSITIVE_ORIGINAL_FAMILY_CONTACT", identity)
            recorded_gains[sid].append(g)
            gain_part_audit.append({"id": identity, "sourceFeatureId": sid, "areaDegreesSquared": g.area, "outsideAggregateGeosResidualAreaDegreesSquared": outside.area, "independentlyCertifiedExactNativeSourceGap": exact_gap is not None, "contactEvidence": contact})
    expected_families = {sid: shapely.union_all([original, *recorded_gains[sid]]) for sid, original in original_clips.items()}
    actual_family_geometries = {}
    for sid, ids in source_families.items():
        pieces = [p for key in ids for p in polygons(geometries_after[key])]
        actual_family_geometries[sid] = pieces[0] if len(pieces) == 1 else MultiPolygon(pieces)
    fallback_expected = original_residual.difference(shapely.union_all([g for values in recorded_gains.values() for g in values]))
    numerical_face_audit = []
    for n, entry in enumerate(numerical_faces):
        g = shape(entry["geometry"])
        candidate_indexes = entry["candidateFamilies"]
        candidates = [expected_families.get(normalized_order[i], Polygon()) if i is not None else fallback_expected for i in candidate_indexes]
        boundaries = shapely.union_all([candidate.boundary for candidate in candidates])
        maximum_distance = float(np.max(shapely.distance(shapely.points(shapely.get_coordinates(g)), boundaries)))
        width = 2 * g.area / g.length if g.length else math.inf
        recipient = entry["recipientSourceIndex"]
        expected_recipient = min([i for i in candidate_indexes if i is not None], default=None)
        check(recipient == expected_recipient and width <= 1e-12 and maximum_distance <= 1e-12 and bool(entry.get("reason")), "INVALID_RECORDED_NUMERICAL_FACE", n)
        def receiving_geometry(index):
            return actual_family_geometries.get(normalized_order[index], Polygon()) if index is not None else MultiPolygon([p for key in target_after - set(fine_features) for p in polygons(geometries_after[key])])

        def receiver_certificate(index):
            receiver = receiving_geometry(index)
            if receiver.covers(g):
                return {"pass": True, "exactPolygonCoverage": True}
            return {**certify_line_coverage(g.boundary, receiver.boundary, one_way=True), "exactPolygonCoverage": False,
                    "meaning": "Every boundary interval of this individually recorded microscopic face remains on the receiving partition boundary within the pre-existing numerical representation bound"}

        actual_recipient = recipient
        receiver_proof = receiver_certificate(recipient)
        disposition = "intended-current-receiver"
        # Earlier-stage floating assignments are history, not final ownership.
        # Renoding can resolve them to another already-recorded candidate;
        # arbitrary new families and final-stage substitutions still fail.
        if not receiver_proof["pass"] and entry.get("stage", final_numerical_stage) < final_numerical_stage:
            for alternative in candidate_indexes:
                if alternative == recipient:
                    continue
                alternative_proof = receiver_certificate(alternative)
                if alternative_proof["pass"]:
                    actual_recipient, receiver_proof = alternative, alternative_proof
                    disposition = "historical-stage-superseded-by-an-original-recorded-candidate"
                    break
        check(receiver_proof["pass"], "RECORDED_NUMERICAL_FACE_NOT_PRESERVED", n)
        numerical_face_audit.append({"index": n, "recordedStage": entry.get("stage"), "finalStage": final_numerical_stage,
                                     "areaDegreesSquared": g.area, "effectiveWidthDegrees": width, "maximumVertexDistanceToRecordedCandidateBoundariesDegrees": maximum_distance,
                                     "historicalRecipientSourceIndex": recipient, "finalRecipientSourceIndex": actual_recipient, "disposition": disposition,
                                     "receiverCertificate": receiver_proof, "geometrySha256WKB": hashlib.sha256(g.wkb).hexdigest()})
    family_gains, family_losses = [], []
    original_component_audit = []
    print("verification: comparing reconstructed fine families", flush=True)
    for sid, ids in source_families.items():
        final = actual_family_geometries[sid]
        original = original_clips.get(sid, Polygon())
        expected = expected_families.get(sid, Polygon())
        for raw_index, clipped_index, original_part in original_scope_components[sid]:
            retained_area = original_part.intersection(final).area
            check(retained_area > 0, "ORIGINAL_SOURCE_COMPONENT_NOT_REPRESENTED", {"sourceFeatureId": sid, "rawComponentIndex": raw_index, "inFixedScopeComponentIndex": clipped_index})
            original_component_audit.append({"sourceFeatureId": sid, "rawComponentIndex": raw_index, "inFixedScopeComponentIndex": clipped_index, "originalAreaDegreesSquared": original_part.area, "retainedIntersectionAreaDegreesSquared": retained_area, "originalGeometrySha256WKB": hashlib.sha256(original_part.wkb).hexdigest()})
        loss = original.difference(final)
        gain = final.difference(original)
        native_holes = [Polygon(ring) for p in polygons(normalized_geometry_by_id[sid]) for ring in p.interiors]
        check(physical_equal(expected, final, f"source-family:{sid}", input_boundaries=[original.boundary, *[g.boundary for g in recorded_gains[sid]]], protected_holes=native_holes), "FINAL_FINE_FAMILY_DIFFERS_FROM_SOURCE_PLUS_LEDGER", sid)
        # Raw/final differences are reported even for individually accepted
        # floating noding exceptions. The source+gain equation above is the
        # acceptance proof, so an unrecorded gameplay reassignment cannot pass.
        if loss.area > 0:
            family_losses.append({"sourceFeatureId": sid, "areaDegreesSquared": loss.area})
        if gain.area > 0:
            stolen = gain.difference(original_residual)
            contact = [part.boundary.intersection(original.boundary).length for part in polygons(gain)]
            family_gains.append({"sourceFeatureId": sid, "areaDegreesSquared": gain.area, "outsideOriginalResidualAreaDegreesSquared": stolen.area, "componentContactDegrees": contact})
    residual_ids = target_after - set(fine_features)
    residual_ledger = report.get("incremental", {}).get("residualLedger", report.get("residualLedger", []))
    if isinstance(residual_ledger, dict):
        residual_ledger = residual_ledger.get("remaining", residual_ledger.get("entries", []))
    classified = {entry.get("cellId", entry.get("id")): entry for entry in residual_ledger}
    residuals = []
    geod = Geod(ellps="WGS84")
    original_clip_ids = list(original_clips)
    original_clip_geometries = list(original_clips.values())
    original_clip_tree = STRtree(original_clip_geometries)
    for key in sorted(residual_ids):
        g = geometries_after[key]
        area_km2 = abs(geod.geometry_area_perimeter(g)[0]) / 1e6
        perimeter_km = geod.geometry_length(g.boundary) / 1e3
        entry = classified.get(key)
        west, south, east, north = g.bounds
        raw_contact_evidence = {original_clip_ids[int(i)]: evidence for i in original_clip_tree.query(shapely.box(west - 1e-12, south - 1e-12, east + 1e-12, north + 1e-12))
                                if (evidence := original_positive_contact(g, original_clip_ids[int(i)])) is not None}
        raw_contacts = list(raw_contact_evidence)
        residuals.append({"cellId": key, "areaKm2": area_km2, "perimeterKm": perimeter_km, "effectiveWidthKm": 2 * area_km2 / perimeter_km if perimeter_km else None, "bounds": list(g.bounds), "originalFinePositiveContacts": raw_contacts, "originalFineContactEvidence": raw_contact_evidence, "ledger": entry})
        check(bool(entry and (entry.get("reason") or entry.get("disposition"))), "UNCLASSIFIED_RESIDUAL", key)
        check(not raw_contacts, "UNRECONCILED_RESIDUAL_WITH_ORIGINAL_FINE_CONTACT", {"cellId": key, "families": raw_contacts})
    residual_pass = len(failures) == residual_start

    replay_pin = pin(args.replay) if args.replay else None
    print("verification: exact replay and final evidence", flush=True)
    reproducibility_pass = check(bool(replay_pin and replay_pin["sha256"] == pin(args.candidate)["sha256"] and replay_pin["byteLength"] == pin(args.candidate)["byteLength"]), "EXACT_REPLAY_MISSING_OR_DIFFERENT", replay_pin)
    areas = [abs(geod.geometry_area_perimeter(g)[0]) / 1e6 for g in target_geometries]
    result = {"schemaVersion": "chn-2020-independent-incremental-v1", "pass": not failures,
              "before": pin(args.baseline), "after": pin(args.candidate), "baselinePointer": pin(args.baseline_pointer),
              "checks": {"nonTargetPreservation": non_target_pass, "sourcePins": source_pass, "hierarchy": hierarchy_pass, "topology": topology_pass, "coverage": coverage_pass, "residualAudit": residual_pass, "reproducibility": reproducibility_pass},
              "environment": {"shapely": shapely.__version__, "axisOrder": "GeoJSON longitude,latitude; no coordinate transformation in verification", "areaBasis": "GEOS planar degrees squared for exact coverage; WGS84 ellipsoidal geodesic km² for size reporting", "globalToleranceChanged": False},
              "counts": {"beforeCells": len(record_before), "afterCells": len(record_after), "targetBefore": len(target_before), "targetAfter": len(target_after), "edges": len(edges), "fineFamilies": len(source_families), "remainingResiduals": len(residual_ids), "pinnedArtifacts": len(seen_pins)},
              "nonTargetPreservation": {"countries": len({record_after[key]["countryId"] for key in non_target_after}), "ids": len(non_target_after), "representationChanges": representation_changes, "koreanBorderAdjacencyPairsBefore": len(original_korean_pairs), "koreanBorderAdjacencyPairsAfter": len(current_korean_pairs)},
              "coverage": {"missingAreaDegreesSquared": target_union_before.difference(target_union_after).area, "extraAreaDegreesSquared": target_union_after.difference(target_union_before).area, "overlaps": overlap_pairs, "invalid": invalid, "duplicateGeometries": duplicates, "beforeComponents": len(polygons(target_union_before)), "afterComponents": len(polygons(target_union_after)),
                           "nationalGeometryMethod": "Independent exact directed shared-segment cancellation and boundary-cycle reconstruction, without overlay", "geosOverlayComponentCountsForComparison": overlay_union_counts,
                           "originalCountryComponents": original_country_component_audit},
              "borders": {**dict(border_stats), "KOR|PRK": korean_border}, "outlineCoverage": outline_reports, "inputPinAliases": input_pin_aliases,
              "hierarchy": {"assignments": len(by_source), "representedFamilies": len(source_families), "missingInEnvelopeSources": missing_in_envelope_sources, "floatingParentMeasurements": floating_parent_measurements,
                            "clippingEnvelope": {"method": "Independent polygonization of pinned active country/coast edge incidences; no noding or coordinate movement", "components": len(active_land_faces), "comparisonToPinnedFill": "Every changed coordinate separately traced under existing 1e-12 representation policy", "geometrySha256WKB": hashlib.sha256(source_reference_envelope.wkb).hexdigest()}},
              "residualAudit": {"originalAggregateGeosResidualAreaDegreesSquared": original_residual.area, "exactNativeSourcePairGaps": source_gap_certificates, "remaining": residuals, "familyLosses": family_losses, "familyGains": family_gains, "assignedPartAudit": gain_part_audit, "originalSourceComponentAudit": original_component_audit,
                                "numericalFaces": numerical_face_audit, "numericalComponentExclusions": component_exclusion_audit},
              "granularity": {"areaKm2Quantiles": {str(q): float(np.quantile(areas, q)) for q in [0, .1, .5, .9, .95, .99, 1]}, "largest": [{"cellId": target_keys[i], "areaKm2": areas[i], "bounds": list(target_geometries[i].bounds)} for i in sorted(range(len(areas)), key=lambda i: areas[i], reverse=True)[:15]]},
              "numericExceptions": numerical, "replay": replay_pin, "failures": failures, "elapsedSeconds": time.monotonic() - started,
              "verifier": pin(__file__)}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    print(json.dumps({"pass": result["pass"], "checks": result["checks"], "counts": result["counts"], "failures": len(failures), "report": args.output, "elapsedSeconds": result["elapsedSeconds"]}))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
