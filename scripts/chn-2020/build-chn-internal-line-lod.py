"""Build a combined CHN internal render network, delivered as two separate layers.

No game polygons, authoritative edges, parents, catalog or runtime pointers change.
Any simplified arc that changes an original topology contact is restored in full.
"""
import argparse
import bisect
import gzip
import hashlib
import json
import math
from fractions import Fraction
from functools import cmp_to_key
from pathlib import Path

import numpy as np
import pyproj
import shapely
from shapely.geometry import LineString, Point, Polygon, mapping, shape


ROOT = Path(__file__).resolve().parents[2]
PROVINCE_INDEX = "data/derived/chn-2020/province-render-f1c91c059cdb06f5234f/index.json"
PREVIOUS_PROVINCE_LOD = "data/derived/chn-2020/province-line-lod-6e0c718ffe8a5495750e/edges.geojson"
WORLD_WIDTH = 2 * math.pi * 6378137


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def pin(file):
    data = (ROOT / file).read_bytes()
    return {"path": file, "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data)}


def checked(a):
    data = (ROOT / a["path"]).read_bytes()
    if len(data) != a["byteLength"] or hashlib.sha256(data).hexdigest() != a["sha256"]:
        raise ValueError("PIN_CHANGED:" + a["path"])
    return data


def immutable(file, data):
    target = ROOT / file
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        if target.read_bytes() != data:
            raise ValueError("IMMUTABLE_ARTIFACT_CHANGED:" + file)
    else:
        target.write_bytes(data)
    return pin(file)


def geometry_hash(geometry):
    return hashlib.sha256(encoded(geometry)).hexdigest()


def intersection_signature(a, b):
    intersection = a.intersection(b)
    return None if intersection.is_empty else shapely.normalize(intersection).wkb_hex


def pair_signatures(lines, selected_count):
    tree = shapely.STRtree(lines)
    result = {}
    for i in range(selected_count):
        for j in sorted(int(n) for n in tree.query(lines[i], predicate="intersects")):
            if j <= i:
                continue
            signature = intersection_signature(lines[i], lines[j])
            if signature is not None:
                result[(i, j)] = signature
    return result


def chain_indices(original, simplified):
    positions = {}
    for i, coordinate in enumerate(original):
        positions.setdefault(tuple(coordinate), []).append(i)
    if tuple(simplified[0]) != tuple(original[0]) or tuple(simplified[-1]) != tuple(original[-1]):
        raise ValueError("ORIGINAL_ENDPOINT_NOT_RETAINED")
    indices = [0]
    for point in simplified[1:-1]:
        available = positions.get(tuple(point), [])
        at = bisect.bisect_right(available, indices[-1])
        if at == len(available) or available[at] >= len(original) - 1:
            raise ValueError("NOT_AN_ORDERED_ORIGINAL_VERTEX_SUBSEQUENCE")
        indices.append(available[at])
    indices.append(len(original) - 1)
    return indices


def maximum_chain_deviation(original_projected, indices):
    maximum, witness = 0.0, None
    for lo, hi in zip(indices[:-1], indices[1:]):
        a, b = original_projected[lo], original_projected[hi]
        chain = original_projected[lo:hi + 1]
        vector = b - a
        length2 = float(np.dot(vector, vector))
        if length2:
            t = np.clip(((chain - a) @ vector) / length2, 0, 1)
            distances = np.linalg.norm(chain - a - t[:, None] * vector, axis=1)
        else:
            distances = np.linalg.norm(chain - a, axis=1)
        k = int(np.argmax(distances))
        distance = float(distances[k])
        if distance > maximum:
            maximum, witness = distance, {"originalVertexIndex": lo + k, "chordStartOriginalIndex": lo,
                "chordEndOriginalIndex": hi, "distanceMeters": distance}
    return maximum, witness


def ring_signed_area(coordinates):
    a = [(Fraction.from_float(float(x)), Fraction.from_float(float(y))) for x, y in coordinates]
    return sum((x * v - u * y for (x, y), (u, v) in zip(a[:-1], a[1:])), Fraction(0)) / 2


def simplify_locked(original_projected, locked, tolerance):
    indices = []
    for lo, hi in zip(locked[:-1], locked[1:]):
        simplified = LineString(original_projected[lo:hi + 1]).simplify(tolerance, preserve_topology=True)
        if simplified.geom_type != "LineString" or simplified.is_empty or simplified.length <= 0:
            raise ValueError("EMPTY_OR_ZERO_LENGTH_SIMPLIFICATION")
        local = chain_indices(original_projected[lo:hi + 1], list(simplified.coords))
        indices.extend([lo + n for n in local][1:] if indices else [lo + n for n in local])
    return indices


def cyclic_signature(ports):
    """Exact binary-coordinate angular order, with no angular epsilon."""
    vectors = []
    for label, node, endpoint in ports:
        x = Fraction.from_float(float(endpoint[0])) - Fraction.from_float(float(node[0]))
        y = Fraction.from_float(float(endpoint[1])) - Fraction.from_float(float(node[1]))
        if not x and not y:
            raise ValueError("ZERO_LENGTH_ENDPOINT_STAR_RAY")
        vectors.append((label, x, y))
    def half(v):
        return 0 if v[2] > 0 or v[2] == 0 and v[1] >= 0 else 1
    def compare(a, b):
        ha, hb = half(a), half(b)
        if ha != hb:
            return ha - hb
        cross = a[1] * b[2] - a[2] * b[1]
        if cross:
            return -1 if cross > 0 else 1
        return -1 if a[0] < b[0] else 1 if a[0] > b[0] else 0
    ordered = sorted(vectors, key=cmp_to_key(compare))
    labels = [v[0] for v in ordered]
    if labels:
        at = labels.index(min(labels))
        labels = labels[at:] + labels[:at]
    ties = []
    for i, a in enumerate(ordered):
        for b in ordered[i + 1:]:
            if a[1] * b[2] == a[2] * b[1] and a[1] * b[1] + a[2] * b[2] > 0:
                ties.append(tuple(sorted([a[0], b[0]])))
    # Cyclic order for degree 2 has no handedness; tie creation/loss still matters.
    return tuple(labels) if len(labels) >= 3 else tuple(sorted(labels)), tuple(sorted(ties))


def main(tolerance):
    if not 0 < tolerance <= 300:
        raise ValueError("RENDER_ONLY_TOLERANCE_MUST_NOT_EXCEED_300_METERS")
    pointer_pin = pin("data/runtime/operational-catalog/current.json")
    pointer = json.loads(checked(pointer_pin))
    index_pin = {"path": pointer["root"] + "/artifact-index.json", **pointer["index"]}
    index = json.loads(checked(index_pin))
    artifacts = {a["path"]: a for a in index["artifacts"]}
    def artifact(file):
        return {**artifacts[file], "path": pointer["root"] + "/" + file}
    provenance_pin, descriptor_pin = artifact("provenance.json"), artifact("catalog.json")
    provenance = json.loads(checked(provenance_pin))
    descriptor = json.loads(checked(descriptor_pin))
    province_pin = pin(PROVINCE_INDEX)
    province = json.loads(checked(province_pin))
    if province["catalogRef"] != descriptor["catalogRef"]:
        raise ValueError("PROVINCE_PRESENTATION_CATALOG_MISMATCH")
    selected_ordinals = set(province["addedBoundaryOrdinals"])
    if len(selected_ordinals) != 994:
        raise ValueError("UNEXPECTED_ACCEPTED_PROVINCE_EDGE_SCOPE")
    province_ordinals = selected_ordinals
    metadata_pin = artifact("metadata/countries/CHN.json.gz")
    chn_metadata = json.loads(gzip.decompress(checked(metadata_pin)))
    chn_ordinals = set(row[0] for row in chn_metadata["rows"])
    incidence_pin = artifact("metadata/edge-incidence.bin.gz")
    incidence = np.frombuffer(gzip.decompress(checked(incidence_pin)), dtype="<u4").reshape((-1, 2))
    selected_ordinals = {n + 1 for n, (a, b) in enumerate(incidence) if int(a) in chn_ordinals and int(b) in chn_ordinals}
    if len(selected_ordinals) != 8562 or not province_ordinals <= selected_ordinals:
        raise ValueError("UNEXPECTED_CHN_INTERNAL_NETWORK_SCOPE")
    detail_pin = artifact("detail-index.json")
    detail = json.loads(checked(detail_pin))
    source_decision_pin = provenance["incremental"]["sourceDecision"]
    decision = json.loads(checked(source_decision_pin))
    game_geometry_pin = provenance["incremental"]["geometry"]
    inputs = {"pointer": pointer_pin, "index": index_pin, "provincePresentationIndex": province_pin,
        "metadata": metadata_pin, "parents": artifact("metadata/parents.json.gz"), "incidence": incidence_pin,
        "provenance": provenance_pin, "catalog": descriptor_pin, "detailIndex": detail_pin,
        "sourceDecision": source_decision_pin, "gameGeometry": game_geometry_pin,
        "selectedSource": decision["selected"]["artifact"], "previousProvinceGeometry": pin(PREVIOUS_PROVINCE_LOD), "topologyShards": []}
    for key, value in inputs.items():
        if key != "topologyShards":
            checked(value)
    selected, protected = [], []
    for shard in detail["edgeDetails"]:
        a = artifact(shard["artifact"]["path"])
        if a["sha256"] != shard["artifact"]["sha256"] or a["byteLength"] != shard["artifact"]["byteLength"]:
            raise ValueError("TOPOLOGY_SHARD_BINDING")
        inputs["topologyShards"].append(a)
        for edge in json.loads(gzip.decompress(checked(a)))["edges"]:
            if edge["ordinal"] in selected_ordinals:
                if edge["geometry"]["type"] != "LineString" or not edge["right"]:
                    raise ValueError("INVALID_ACCEPTED_CHN_INTERNAL_EDGE")
                if tuple(int(v) for v in incidence[edge["ordinal"] - 1]) != (edge["left"], edge["right"]):
                    raise ValueError("INTERNAL_EDGE_INCIDENCE_MISMATCH")
                selected.append(edge)
            elif edge["boundaryClass"] in ("coast", "country"):
                protected.append(edge)
    selected.sort(key=lambda e: e["ordinal"])
    protected.sort(key=lambda e: e["ordinal"])
    if {e["ordinal"] for e in selected} != selected_ordinals:
        raise ValueError("MISSING_ACCEPTED_CHN_INTERNAL_EDGE")
    all_edges = selected + protected
    originals = [shape(e["geometry"]) for e in all_edges]
    project = pyproj.Transformer.from_crs("OGC:CRS84", "EPSG:3857", always_xy=True)
    projected_originals = list(shapely.transform(originals, project.transform, interleaved=False))
    if not all(np.isfinite(shapely.get_coordinates(g)).all() for g in projected_originals):
        raise ValueError("NONFINITE_PROTECTED_PROJECTION")
    if any(g.geom_type != "LineString" for g in originals):
        raise ValueError("UNSUPPORTED_NON_LINESTRING_NETWORK_EDGE")
    native_arrays = [np.asarray(g.coords, dtype=float) for g in originals]
    projected_arrays = [np.asarray(g.coords, dtype=float) for g in projected_originals]
    node_keys = {tuple(a[j]) for a in native_arrays[:len(selected)] for j in [0, -1]}
    node_ports, locked_by_edge = {}, {}
    for i, coordinates in enumerate(native_arrays):
        locked = set()
        for j, coordinate in enumerate(coordinates):
            node = tuple(coordinate)
            if node not in node_keys:
                continue
            locked.add(j)
            for direction in [-1, 1]:
                other = j + direction
                while 0 <= other < len(coordinates) and tuple(coordinates[other]) == node:
                    other += direction
                if 0 <= other < len(coordinates):
                    node_ports.setdefault(node, []).append((i, j, direction, other, f'{all_edges[i]["ordinal"]}:{j}:{direction}'))
        if i < len(selected):
            locked_by_edge[i] = sorted(locked | {0, len(coordinates) - 1})
    def star_signatures(arrays, retained_positions=None):
        signatures = {}
        for node, ports in node_ports.items():
            rays = []
            for i, j, direction, original_other, label in ports:
                if retained_positions is not None and i < len(selected):
                    at = retained_positions[i].get(j)
                    if at is None:
                        raise ValueError("SHARED_NETWORK_NODE_REMOVED")
                    other = at + direction
                    while 0 <= other < len(arrays[i]) and np.array_equal(arrays[i][other], arrays[i][at]):
                        other += direction
                    if not 0 <= other < len(arrays[i]):
                        raise ValueError("SHARED_NETWORK_RAY_REMOVED")
                    rays.append((label, arrays[i][at], arrays[i][other]))
                else:
                    rays.append((label, arrays[i][j], arrays[i][original_other]))
            signatures[node] = cyclic_signature(rays)
        return signatures
    print("internal network", len(selected), "protected", len(protected), "nodes", len(node_keys), flush=True)
    baseline_native = pair_signatures(originals, len(selected))
    baseline_projected = pair_signatures(projected_originals, len(selected))
    baseline_stars_native = star_signatures(native_arrays)
    baseline_stars_projected = star_signatures(projected_arrays)
    print("baseline contacts", len(baseline_native), "degree>=3", sum(len(p) >= 3 for p in node_ports.values()), flush=True)
    displays, projected_displays, reports = [], [], []
    for i, edge in enumerate(selected):
        original = originals[i]
        old_native = native_arrays[i]
        old_projected = projected_arrays[i]
        reasons = []
        try:
            indices = simplify_locked(old_projected, locked_by_edge[i], tolerance)
            native_coordinates = [edge["geometry"]["coordinates"][n] for n in indices]
            display = LineString(native_coordinates)
            projected_display = shapely.transform(display, project.transform, interleaved=False)
            if not display.is_valid or display.length <= 0 or original.is_closed != display.is_closed:
                raise ValueError("INVALID_OR_CHANGED_CLOSURE")
            if (original.is_simple and not display.is_simple) or (projected_originals[i].is_simple and not projected_display.is_simple):
                raise ValueError("NEW_SELF_INTERSECTION")
            if original.is_closed:
                if len(set(tuple(p) for p in native_coordinates)) < 3 or not Polygon(native_coordinates).is_valid:
                    raise ValueError("CLOSED_RING_COLLAPSED")
                for space, before, after in [("native", old_native, native_coordinates), ("3857", old_projected, list(projected_display.coords))]:
                    old_area, new_area = ring_signed_area(before), ring_signed_area(after)
                    if old_area == 0 or new_area == 0 or (old_area > 0) != (new_area > 0):
                        raise ValueError("CLOSED_RING_AREA_OR_WINDING_CHANGED:" + space)
            deviation, witness = maximum_chain_deviation(old_projected, indices)
            if deviation > tolerance:
                raise ValueError("FINITE_CHORD_DEVIATION_EXCEEDS_TOLERANCE")
        except ValueError as error:
            reasons.append({"code": str(error)})
            indices = list(range(len(old_native)))
            display, projected_display = original, projected_originals[i]
            deviation, witness = 0.0, None
        displays.append(display)
        projected_displays.append(projected_display)
        reports.append({"ordinal": edge["ordinal"], "category": "province" if edge["ordinal"] in province_ordinals else "micro", "originalEdgeId": edge["id"],
            "originalGeometrySha256": geometry_hash(edge["geometry"]), "originalVertices": len(old_native),
            "displayVertices": len(indices), "retainedOriginalVertexIndices": indices,
            "protectedNetworkVertexIndices": locked_by_edge[i], "closed": bool(original.is_closed),
            "maximumOriginalChainVertexToFiniteChordMeters": deviation, "maximumDeviationWitness": witness,
            "decision": "reverted" if reasons else "original-unchanged" if len(indices) == len(old_native) else "simplified",
            "reasons": reasons})
    iterations = []
    print("DP candidates ready", len(selected), flush=True)
    for iteration in range(len(selected) + 1):
        current_native = displays + originals[len(selected):]
        current_projected = projected_displays + projected_originals[len(selected):]
        changed = {}
        for space, baseline, current in [("OGC:CRS84", baseline_native, current_native), ("EPSG:3857", baseline_projected, current_projected)]:
            actual = pair_signatures(current, len(selected))
            for pair in sorted(set(baseline) | set(actual)):
                if baseline.get(pair) == actual.get(pair):
                    continue
                for n, other in [(pair[0], pair[1]), (pair[1], pair[0])]:
                    if n < len(selected) and reports[n]["decision"] == "simplified":
                        changed.setdefault(n, []).append({"code": "TOPOLOGY_CONTACT_CHANGED", "coordinateSpace": space,
                            "otherEdgeOrdinal": all_edges[other]["ordinal"], "otherProtectedCountryOrCoast": other >= len(selected),
                            "change": "new-contact" if pair not in baseline else "lost-contact" if pair not in actual else "changed-intersection-point-or-overlap-set"})
                if not any(n < len(selected) and reports[n]["decision"] == "simplified" for n in pair):
                    raise ValueError("UNRESOLVED_ORIGINAL_TOPOLOGY_MISMATCH")
        retained_positions = [{j: at for at, j in enumerate(r["retainedOriginalVertexIndices"])} for r in reports]
        current_native_arrays = [np.asarray(g.coords, dtype=float) for g in displays] + native_arrays[len(selected):]
        current_projected_arrays = [np.asarray(g.coords, dtype=float) for g in projected_displays] + projected_arrays[len(selected):]
        for space, baseline, current in [("OGC:CRS84", baseline_stars_native, current_native_arrays), ("EPSG:3857", baseline_stars_projected, current_projected_arrays)]:
            actual = star_signatures(current, retained_positions)
            for node in sorted(node_ports):
                if actual[node] == baseline[node]:
                    continue
                involved = sorted({p[0] for p in node_ports[node] if p[0] < len(selected) and reports[p[0]]["decision"] == "simplified"})
                if not involved:
                    raise ValueError("UNRESOLVED_ORIGINAL_ENDPOINT_STAR_MISMATCH")
                for n in involved:
                    changed.setdefault(n, []).append({"code": "ENDPOINT_STAR_CYCLIC_ORDER_OR_TIE_CHANGED", "coordinateSpace": space,
                        "node": list(node), "incidentEdgeOrdinals": sorted({all_edges[p[0]]["ordinal"] for p in node_ports[node]})})
        iterations.append({"iteration": iteration, "revertedOrdinals": [selected[n]["ordinal"] for n in sorted(changed)]})
        print("network guard", iteration, "reverts", len(changed), flush=True)
        if not changed:
            break
        for n in sorted(changed):
            displays[n], projected_displays[n] = originals[n], projected_originals[n]
            reports[n].update({"decision": "reverted", "displayVertices": reports[n]["originalVertices"],
                "retainedOriginalVertexIndices": list(range(reports[n]["originalVertices"])),
                "maximumOriginalChainVertexToFiniteChordMeters": 0.0, "maximumDeviationWitness": None})
            reports[n]["reasons"].extend(changed[n])
    else:
        raise ValueError("TOPOLOGY_REVERSION_DID_NOT_CONVERGE")
    features = []
    for edge, geometry, report in zip(selected, displays, reports):
        output_geometry = mapping(geometry)
        # Preserve actual original native JSON numbers, rather than inverse-projecting.
        output_geometry["coordinates"] = [edge["geometry"]["coordinates"][n] for n in report["retainedOriginalVertexIndices"]]
        report["displayGeometrySha256"] = geometry_hash(output_geometry)
        features.append({"type": "Feature", "id": edge["ordinal"], "properties": {}, "geometry": output_geometry})
    province_features = [f for f in features if f["id"] in province_ordinals]
    micro_features = [f for f in features if f["id"] not in province_ordinals]
    if len(province_features) != 994 or len(micro_features) != 7568:
        raise ValueError("OUTPUT_LAYER_PARTITION_CHANGED")
    province_bytes = encoded({"type": "FeatureCollection", "features": province_features})
    micro_bytes = encoded({"type": "FeatureCollection", "features": micro_features})
    previous_province = {f["id"]: f["geometry"] for f in json.loads(checked(inputs["previousProvinceGeometry"]))["features"]}
    previous_changed, additional_reverts = [], []
    for r in reports:
        if r["category"] != "province":
            continue
        previous_geometry = previous_province[r["ordinal"]]
        r["previousProvinceGeometrySha256"] = geometry_hash(previous_geometry)
        r["previousProvinceVertices"] = len(previous_geometry["coordinates"])
        r["sameAsPreviousProvinceGeometry"] = r["displayGeometrySha256"] == r["previousProvinceGeometrySha256"]
        if not r["sameAsPreviousProvinceGeometry"]:
            previous_changed.append(r["ordinal"])
            if r["decision"] == "reverted":
                additional_reverts.append(r["ordinal"])
    code = pin("scripts/chn-2020/build-chn-internal-line-lod.py")
    policy = {"projection": "EPSG:3857", "sourceCRS": "OGC:CRS84", "sourceAxisOrder": "longitude,latitude", "alwaysXY": True,
        "toleranceMeters": tolerance, "maximumDeviationMeters": tolerance, "simplify": "Douglas-Peucker/preserve_topology=True",
        "allOriginalCatalogEdgeEndpointsFixed": True, "allOriginalSharedNetworkVerticesFixed": True,
        "retainedNativeCoordinates": "exact ordered original vertex subsequence; never inverse-projected",
        "tileSizeCSSPixels": 512, "worldWidthMeters": WORLD_WIDTH, "maximumApplicableZoomExclusive": 7,
        "continuousDeviationBasis": "For each retained chord, every original subchain vertex is within the finite-segment distance bound. Identical endpoints, convexity along each original segment and continuous longitudinal projection bound both continuous polyline directions. IEEE-double measured values are independently rechecked; no gameplay numeric tolerance changes.",
        "topologyGuard": "Exact normalized intersection geometry of every selected-selected and selected-protected country/coast pair is identical to baseline in both CRS84 and EPSG3857. Related simplified arcs revert in full until stable.",
        "endpointStarGuard": "Cyclic port order and exact ray-tie sets at every original internal-edge endpoint are identical in native and EPSG3857 coordinates. Protected country/coast edge interior vertices contribute both ray ports. Angular predicates use exact dyadic Fraction arithmetic; no angular epsilon.",
        "closedLoopGuard": "Original closed individual-edge rings retain validity, nonzero exact-dyadic signed shoelace area and winding in native and EPSG3857 coordinates.",
        "unchanged": ["authoritative-game-cells", "game-edges", "administrative-parents", "catalog", "country-coast-lines", "KOR", "PRK"]}
    for key, value in inputs.items():
        for a in value if key == "topologyShards" else [value]:
            checked(a)
    key = hashlib.sha256(encoded({"provinceGeometrySha256": hashlib.sha256(province_bytes).hexdigest(),
        "microGeometrySha256": hashlib.sha256(micro_bytes).hexdigest(), "inputs": inputs, "code": code, "policy": policy})).hexdigest()[:20]
    out = "data/derived/chn-2020/internal-line-lod-" + key
    province_geometry_pin = immutable(out + "/province.geojson", province_bytes)
    micro_geometry_pin = immutable(out + "/micro.geojson", micro_bytes)
    max_error = max(r["maximumOriginalChainVertexToFiniteChordMeters"] for r in reports)
    def category_summary(category):
        selected_reports = [r for r in reports if r["category"] == category]
        return {"edges": len(selected_reports), "originalVertices": sum(r["originalVertices"] for r in selected_reports),
            "displayVertices": sum(r["displayVertices"] for r in selected_reports),
            "simplifiedEdges": sum(r["decision"] == "simplified" for r in selected_reports),
            "unchangedEdges": sum(r["decision"] == "original-unchanged" for r in selected_reports),
            "revertedEdges": sum(r["decision"] == "reverted" for r in selected_reports),
            "maximumChainDeviationMercatorMeters": max(r["maximumOriginalChainVertexToFiniteChordMeters"] for r in selected_reports)}
    report = {"schemaVersion": "chn-internal-line-lod-producer-v1", "pass": True, "countryId": "CHN", "administrativeTruthClaim": False,
        "catalogRef": descriptor["catalogRef"], "inputs": inputs, "code": code, "policy": policy,
        "provinceGeometry": province_geometry_pin, "microGeometry": micro_geometry_pin,
        "sourceBasis": {"selectedSourceRevision": decision["selected"]["revision"], "license": decision["selected"]["license"]["id"],
            "temporalLimitation": decision["selected"]["temporalLimitation"], "method": "All 8562 accepted CHN internal arcs share one offline simplification/topology pass; source identities and resolution are unchanged. Delivery is separated into province994 and debugmicro7568."},
        "runtime": {"shapely": shapely.__version__, "GEOS": shapely.geos_version_string, "pyproj": pyproj.__version__, "PROJ": pyproj.proj_version_str},
        "topology": {"protectedCountryCoastEdges": len(protected), "originalNativeContactPairs": len(baseline_native),
            "originalProjectedContactPairs": len(baseline_projected), "finalNativeIntersectionSetsIdentical": True,
            "finalProjectedIntersectionSetsIdentical": True, "internalEndpointNodes": len(node_keys),
            "degreeThreePlusEndpointStars": sum(len(p) >= 3 for p in node_ports.values()),
            "finalNativeEndpointStarOrderAndTiesIdentical": True, "finalProjectedEndpointStarOrderAndTiesIdentical": True,
            "iterations": iterations, "newCrossingsContactsOrOverlaps": 0},
        "summary": {"edges": len(selected), "originalVertices": sum(r["originalVertices"] for r in reports),
            "displayVertices": sum(r["displayVertices"] for r in reports), "simplifiedEdges": sum(r["decision"] == "simplified" for r in reports),
            "unchangedEdges": sum(r["decision"] == "original-unchanged" for r in reports), "revertedEdges": sum(r["decision"] == "reverted" for r in reports),
            "maximumChainDeviationMercatorMeters": max_error,
            "categoryProvince": category_summary("province"), "categoryMicro": category_summary("micro"),
            "CSSPixelDeviationAtPitchZero": [{"zoom": z, "maximumObserved": max_error * 512 * 2 ** z / WORLD_WIDTH,
                "policyUpperBound": tolerance * 512 * 2 ** z / WORLD_WIDTH} for z in [3, 4, 5, 6, 7]]},
        "provinceChangeFromPrevious": {"previousGeometry": inputs["previousProvinceGeometry"],
            "changedOrdinals": previous_changed, "additionalRevertedOrdinals": additional_reverts,
            "method": "New combined-network safety may restore or retain more original province vertices; original province-only artifact and proof remain unchanged."},
        "provinceEdgeOrdinals": sorted(province_ordinals), "microEdgeOrdinals": sorted(selected_ordinals - province_ordinals),
        "edges": reports, "geometryHashEncoding": "SHA256 of JSON sorted keys, compact separators, UTF8 and trailing LF",
        "limitations": ["Display line LOD only; it does not change or claim exact fine polygon fill boundaries.",
            "300m DP budget excludes later vector-tile quantization and pitched-view perspective; delivery verifier must audit those separately.",
            "Exact lines remain available at zoom>=7. Province loading and debug-micro loading must remain separate. No auxiliary line replaces operational fronts or national/coast geometry."]}
    report_pin = immutable(out + "/producer-report.json", encoded(report))
    print(json.dumps({"provinceGeometry": province_geometry_pin, "microGeometry": micro_geometry_pin, "report": report_pin,
        "summary": report["summary"], "topology": report["topology"], "provinceChangeFromPrevious": report["provinceChangeFromPrevious"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tolerance", type=float, default=300)
    main(parser.parse_args().tolerance)
