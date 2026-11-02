"""Build a separate, conservative render-only LOD for the accepted CHN province arcs.

No game polygons, authoritative edges, parents, catalog or runtime pointers change.
Any simplified arc that changes an original topology contact is restored in full.
"""
import argparse
import bisect
import gzip
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pyproj
import shapely
from shapely.geometry import LineString, Polygon, mapping, shape


ROOT = Path(__file__).resolve().parents[2]
PROVINCE_INDEX = "data/derived/chn-2020/province-render-f1c91c059cdb06f5234f/index.json"
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
    a = np.asarray(coordinates, dtype=float)
    a = a - a[0]
    return float((a[:-1, 0] * a[1:, 1] - a[1:, 0] * a[:-1, 1]).sum() / 2)


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
    detail_pin = artifact("detail-index.json")
    detail = json.loads(checked(detail_pin))
    source_decision_pin = provenance["incremental"]["sourceDecision"]
    decision = json.loads(checked(source_decision_pin))
    game_geometry_pin = provenance["incremental"]["geometry"]
    inputs = {"pointer": pointer_pin, "index": index_pin, "provincePresentationIndex": province_pin,
        "provenance": provenance_pin, "catalog": descriptor_pin, "detailIndex": detail_pin,
        "sourceDecision": source_decision_pin, "gameGeometry": game_geometry_pin,
        "selectedSource": decision["selected"]["artifact"], "topologyShards": []}
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
                    raise ValueError("INVALID_ACCEPTED_PROVINCE_EDGE")
                selected.append(edge)
            elif edge["boundaryClass"] in ("coast", "country"):
                protected.append(edge)
    selected.sort(key=lambda e: e["ordinal"])
    protected.sort(key=lambda e: e["ordinal"])
    if {e["ordinal"] for e in selected} != selected_ordinals:
        raise ValueError("MISSING_ACCEPTED_PROVINCE_EDGE")
    all_edges = selected + protected
    originals = [shape(e["geometry"]) for e in all_edges]
    project = pyproj.Transformer.from_crs("OGC:CRS84", "EPSG:3857", always_xy=True)
    projected_originals = list(shapely.transform(originals, project.transform, interleaved=False))
    if not all(np.isfinite(shapely.get_coordinates(g)).all() for g in projected_originals):
        raise ValueError("NONFINITE_PROTECTED_PROJECTION")
    baseline_native = pair_signatures(originals, len(selected))
    baseline_projected = pair_signatures(projected_originals, len(selected))
    displays, projected_displays, reports = [], [], []
    for i, edge in enumerate(selected):
        original = originals[i]
        old_native = np.asarray(original.coords, dtype=float)
        old_projected = np.asarray(projected_originals[i].coords, dtype=float)
        reasons = []
        try:
            simplified = projected_originals[i].simplify(tolerance, preserve_topology=True)
            if simplified.geom_type != "LineString" or simplified.is_empty or simplified.length <= 0:
                raise ValueError("EMPTY_OR_ZERO_LENGTH_SIMPLIFICATION")
            indices = chain_indices(old_projected, list(simplified.coords))
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
                old_area, new_area = ring_signed_area(old_native), ring_signed_area(native_coordinates)
                if old_area == 0 or new_area == 0 or (old_area > 0) != (new_area > 0):
                    raise ValueError("CLOSED_RING_AREA_OR_WINDING_CHANGED")
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
        reports.append({"ordinal": edge["ordinal"], "originalEdgeId": edge["id"],
            "originalGeometrySha256": geometry_hash(edge["geometry"]), "originalVertices": len(old_native),
            "displayVertices": len(indices), "retainedOriginalVertexIndices": indices,
            "maximumOriginalChainVertexToFiniteChordMeters": deviation, "maximumDeviationWitness": witness,
            "decision": "reverted" if reasons else "original-unchanged" if len(indices) == len(old_native) else "simplified",
            "reasons": reasons})
    iterations = []
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
        iterations.append({"iteration": iteration, "revertedOrdinals": [selected[n]["ordinal"] for n in sorted(changed)]})
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
    geojson_bytes = encoded({"type": "FeatureCollection", "features": features})
    code = pin("scripts/chn-2020/build-province-line-lod.py")
    policy = {"projection": "EPSG:3857", "sourceCRS": "OGC:CRS84", "sourceAxisOrder": "longitude,latitude", "alwaysXY": True,
        "toleranceMeters": tolerance, "maximumDeviationMeters": tolerance, "simplify": "Douglas-Peucker/preserve_topology=True",
        "allOriginalCatalogEdgeEndpointsFixed": True, "retainedNativeCoordinates": "exact ordered original vertex subsequence; never inverse-projected",
        "tileSizeCSSPixels": 512, "worldWidthMeters": WORLD_WIDTH, "maximumApplicableZoomExclusive": 7,
        "continuousDeviationBasis": "For each retained chord, every original subchain vertex is within the finite-segment distance bound. Identical endpoints, convexity along each original segment and continuous longitudinal projection bound both continuous polyline directions. IEEE-double measured values are independently rechecked; no gameplay numeric tolerance changes.",
        "topologyGuard": "Exact normalized intersection geometry of every selected-selected and selected-protected country/coast pair is identical to baseline in both CRS84 and EPSG3857. Related simplified arcs revert in full until stable.",
        "unchanged": ["authoritative-game-cells", "game-edges", "administrative-parents", "catalog", "country-coast-lines", "KOR", "PRK"]}
    for key, value in inputs.items():
        for a in value if key == "topologyShards" else [value]:
            checked(a)
    key = hashlib.sha256(encoded({"geometrySha256": hashlib.sha256(geojson_bytes).hexdigest(), "inputs": inputs, "code": code, "policy": policy})).hexdigest()[:20]
    out = "data/derived/chn-2020/province-line-lod-" + key
    display_pin = immutable(out + "/edges.geojson", geojson_bytes)
    max_error = max(r["maximumOriginalChainVertexToFiniteChordMeters"] for r in reports)
    report = {"schemaVersion": "chn-province-line-lod-producer-v1", "pass": True, "countryId": "CHN", "administrativeTruthClaim": False,
        "catalogRef": descriptor["catalogRef"], "inputs": inputs, "code": code, "policy": policy, "displayGeometry": display_pin,
        "sourceBasis": {"selectedSourceRevision": decision["selected"]["revision"], "license": decision["selected"]["license"]["id"],
            "temporalLimitation": decision["selected"]["temporalLimitation"], "method": "Only existing accepted 994 province presentation arcs are simplified; sources are not reselected."},
        "runtime": {"shapely": shapely.__version__, "GEOS": shapely.geos_version_string, "pyproj": pyproj.__version__, "PROJ": pyproj.proj_version_str},
        "topology": {"protectedCountryCoastEdges": len(protected), "originalNativeContactPairs": len(baseline_native),
            "originalProjectedContactPairs": len(baseline_projected), "finalNativeIntersectionSetsIdentical": True,
            "finalProjectedIntersectionSetsIdentical": True, "iterations": iterations, "newCrossingsContactsOrOverlaps": 0},
        "summary": {"edges": len(selected), "originalVertices": sum(r["originalVertices"] for r in reports),
            "displayVertices": sum(r["displayVertices"] for r in reports), "simplifiedEdges": sum(r["decision"] == "simplified" for r in reports),
            "unchangedEdges": sum(r["decision"] == "original-unchanged" for r in reports), "revertedEdges": sum(r["decision"] == "reverted" for r in reports),
            "maximumChainDeviationMercatorMeters": max_error,
            "CSSPixelDeviationAtPitchZero": [{"zoom": z, "maximumObserved": max_error * 512 * 2 ** z / WORLD_WIDTH,
                "policyUpperBound": tolerance * 512 * 2 ** z / WORLD_WIDTH} for z in [3, 4, 5, 6, 7]]},
        "edges": reports, "geometryHashEncoding": "SHA256 of JSON sorted keys, compact separators, UTF8 and trailing LF",
        "limitations": ["Display line LOD only; it does not change or claim exact fine polygon fill boundaries.",
            "300m DP budget excludes later vector-tile quantization and pitched-view perspective; delivery verifier must audit those separately.",
            "Exact lines remain available at zoom>=7; new normal-mode auxiliary lines must not replace operational fronts or national/coast geometry."]}
    report_pin = immutable(out + "/producer-report.json", encoded(report))
    print(json.dumps({"displayGeometry": display_pin, "report": report_pin, "summary": report["summary"], "topology": report["topology"]}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tolerance", type=float, default=300)
    main(parser.parse_args().tolerance)
