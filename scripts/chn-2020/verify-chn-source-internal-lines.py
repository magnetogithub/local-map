"""Independent proof of source-generalized CHN lines and the unchanged catalog.

No producer module is imported. Reuses the independent intersection, continuous
distance and closed-loop predicates, with a separate explicit shared-node audit
that permits derived curve coordinates instead of weakening the old DP proof.
"""
import argparse
import gzip
import importlib.util
import json
import math
import time
from collections import Counter, defaultdict
from pathlib import Path

import shapely
from shapely.geometry import LineString, shape

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("independent_lod", Path(__file__).with_name("verify-chn-internal-line-lod.py"))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
pin, checked, decode, encoded = audit.pin, audit.checked, audit.decode, audit.encoded


def fixed_nodes(old, new, anchors):
    if len(new) < 2 or old[0] != new[0] or old[-1] != new[-1]:
        raise ValueError("CURVE_ENDPOINT_MOVED")
    before = [(i, tuple(p)) for i, p in enumerate(old) if tuple(p) in anchors]
    after = [(i, tuple(p)) for i, p in enumerate(new) if tuple(p) in anchors]
    if [p for _, p in before] != [p for _, p in after]:
        raise ValueError("CURVE_SHARED_NODE_SEQUENCE_CHANGED")
    return {a[0]: b[0] for a, b in zip(before, after)}


def valid_line(old, new):
    if any(len(p) != 2 or not all(math.isfinite(n) for n in p) for p in new):
        raise ValueError("NONFINITE_CURVE_COORDINATE")
    line = LineString(new)
    if not line.is_valid or line.length <= 0 or (new != old and not line.is_simple):
        raise ValueError("CURVE_SELF_INTERSECTION_OR_INVALID_LINE")
    return line


def node_star_checks(originals, display, protected):
    anchors = {tuple(e["geometry"]["coordinates"][j]) for e in originals.values() for j in (0, -1)}
    stars = [defaultdict(lambda: [[], []]), defaultdict(lambda: [[], []])]
    specs = [(n, e["geometry"]["coordinates"], display[n]["geometry"]["coordinates"]) for n, e in sorted(originals.items())]
    specs.extend((e["ordinal"], e["geometry"]["coordinates"], e["geometry"]["coordinates"]) for e in protected)
    cache = {}
    def projected(p):
        key = tuple(p)
        if key not in cache:
            cache[key] = audit.PROJECT.transform(*key)
        return cache[key]
    for ordinal, old, new in specs:
        positions = fixed_nodes(old, new, anchors)
        for i, at in positions.items():
            point = old[i]
            if i and point == old[i - 1] and i != len(old) - 1:
                continue
            for direction in (-1, 1):
                a, b = i + direction, at + direction
                while 0 <= a < len(old) and old[a] == point:
                    a += direction
                if not 0 <= a < len(old):
                    continue
                while 0 <= b < len(new) and new[b] == point:
                    b += direction
                if not 0 <= b < len(new):
                    raise ValueError("CURVE_SHARED_NODE_PORT_LOST")
                token = f"{ordinal}:{i}:{direction}"
                stars[0][tuple(point)][0].append((token, point, old[a]))
                stars[0][tuple(point)][1].append((token, point, new[b]))
                stars[1][tuple(point)][0].append((token, projected(point), projected(old[a])))
                stars[1][tuple(point)][1].append((token, projected(point), projected(new[b])))
    result = []
    for crs, space in zip(("OGC:CRS84", "EPSG:3857"), stars):
        evidence = []
        for node, (old, new) in sorted(space.items()):
            a, b = audit.cyclic_port_order(old), audit.cyclic_port_order(new)
            if a != b:
                raise ValueError("CURVE_SHARED_NODE_CYCLIC_ORDER_OR_TIES_CHANGED:" + str(node))
            evidence.append({"node": node, "ports": len(old), "groups": a})
        import hashlib
        result.append({"crs": crs, "nodes": len(evidence), "degreeThreePlus": sum(e["ports"] >= 3 for e in evidence),
            "cyclicOrderAndTiesSha256": hashlib.sha256(encoded(evidence)).hexdigest(), "changes": 0})
    return result


def require_scope(actual, expected):
    if actual != expected:
        raise ValueError("CURVE_EDGE_OR_CATEGORY_SCOPE_CHANGED")


def negative_controls():
    def rejects(fn):
        try:
            fn()
        except ValueError:
            return True
        raise ValueError("CURVE_NEGATIVE_CONTROL_ACCEPTED")
    old = [[0, 0], [1, 0], [2, 0]]
    loop = [[0, 0], [2, 0], [2, 2], [0, 0]]
    def fake_edge(n, coords):
        return {"ordinal": n, "geometry": {"type": "LineString", "coordinates": coords}}
    original_stars = {1: fake_edge(1, [[0, 0], [1, 0]]), 2: fake_edge(2, [[0, 0], [0, 1]]), 3: fake_edge(3, [[0, 0], [-1, -1]])}
    flipped = dict(original_stars)
    flipped[2] = fake_edge(2, [[0, 0], [.1, -.1], [0, 1]])
    return {
        "movedEndpoint": rejects(lambda: fixed_nodes(old, [[.1, 0], [2, 0]], {(0, 0), (2, 0)})),
        "removedSharedJunction": rejects(lambda: fixed_nodes(old, [[0, 0], [2, 0]], {(0, 0), (1, 0), (2, 0)})),
        "selfCrossingCurve": rejects(lambda: valid_line(old, [[0, 0], [2, 2], [0, 2], [2, 0]])),
        "curveOutsideDistanceBudget": rejects(lambda: audit.directed_distance_bound([[[0, 0], [1, 100], [2, 0]]], LineString(old), 1)),
        "newProtectedContact": rejects(lambda: audit.intersection_check([LineString([[0, 0], [2, 0]])],
            [LineString([[0, 0], [1, 2], [2, 0]])], [LineString([[0, 1], [2, 1]])], "fixture")),
        "sharedNodeSectorFlip": rejects(lambda: node_star_checks(original_stars, flipped, [])),
        "closedLoopInversion": rejects(lambda: audit.closed_loop_orientation(loop, list(reversed(loop)))),
        "missingEdgeOrChangedCategory": rejects(lambda: require_scope({1: "province"}, {1: "province", 2: "micro"})),
    }


def main(args):
    started = time.monotonic()
    report = {"schemaVersion": "chn-internal-line-source-independent-v1", "pass": False, "failures": []}
    try:
        producer_pin = pin(args.producer_report)
        producer = decode(producer_pin)
        if producer.get("schemaVersion") != "chn-internal-line-source-producer-v1" or producer.get("pass") is not True:
            raise ValueError("UNACCEPTED_CURVE_PRODUCER")
        pins = audit.all_pins({"inputs": producer["inputs"], "code": producer["code"],
            "provinceGeometry": producer["provinceGeometry"], "microGeometry": producer["microGeometry"]})
        helper = pin("scripts/chn-2020/verify-chn-internal-line-lod.py")
        pins[helper["path"]] = helper
        baseline = decode(producer["inputs"]["sourceReferenceDelivery"])
        baseline_producer = decode(producer["inputs"]["sourceReferenceProducer"])
        baseline_proof = decode(producer["inputs"]["sourceReferenceProof"])
        if (baseline.get("producer") != producer["inputs"]["sourceReferenceProducer"]
                or baseline.get("verification") != producer["inputs"]["sourceReferenceProof"]
                or baseline_proof.get("pass") is not True or baseline_proof["producer"] != baseline["producer"]
                or baseline_proof["baseCatalogRef"] != producer["catalogRef"] or baseline["catalogRef"] != producer["catalogRef"]
                or baseline_producer["schemaVersion"] != "chn-internal-line-lod-producer-v1"):
            raise ValueError("CURVE_BASELINE_ACCEPTANCE_CHAIN_CHANGED")
        pointer_pin = pin("data/runtime/operational-catalog/current.json")
        if pointer_pin != producer["inputs"]["pointer"]:
            raise ValueError("CURVE_CURRENT_POINTER_CHANGED")
        pointer = decode(pointer_pin)
        index = decode({"path": pointer["root"] + "/artifact-index.json", **pointer["index"]})
        ledger = [{**a, "path": pointer["root"] + "/" + a["path"]} for a in index["artifacts"]]
        for identity in ledger:
            checked(identity)
        import hashlib
        ledger_sha = hashlib.sha256(encoded(ledger)).hexdigest()
        if ledger_sha != baseline_proof["authorityUnchanged"]["originalCatalogLedgerSha256"]:
            raise ValueError("CURVE_AUTHORITATIVE_CATALOG_CHANGED")
        all_edges = [e for shard in producer["inputs"]["topologyShards"] for e in decode(shard)["edges"]]
        source_edges = {e["ordinal"]: e for e in all_edges}
        baseline_features, display, categories = {}, {}, {}
        for kind in ("province", "micro"):
            before = [{"type": "Feature", "id": n, "properties": {}, "geometry": source_edges[n]["geometry"]} for n in baseline[kind]["edgeOrdinals"]]
            after = decode(producer[kind + "Geometry"])["features"]
            if [f["id"] for f in before] != [f["id"] for f in after]:
                raise ValueError("CURVE_PARTITION_OR_ORDER_CHANGED")
            for a, b in zip(before, after):
                if b["id"] in display or b["type"] != "Feature" or b["properties"] != {} or b["geometry"]["type"] != "LineString":
                    raise ValueError("CURVE_FEATURE_CONTRACT_CHANGED")
                baseline_features[a["id"]], display[b["id"]], categories[b["id"]] = a, b, kind
        require_scope(categories, {**{n: "province" for n in baseline["province"]["edgeOrdinals"]}, **{n: "micro" for n in baseline["micro"]["edgeOrdinals"]}})
        if len(display) != 8562:
            raise ValueError("CURVE_NOT_ENTIRE_CHINA_NETWORK")
        originals = {e["ordinal"]: e for e in all_edges if e["ordinal"] in display}
        protected = [e for e in all_edges if e["boundaryClass"] in ("country", "coast")]
        claims = {r["ordinal"]: r for r in producer["edges"]}
        require_scope(set(claims), set(display))
        budget = producer["policy"]["maximumOriginalSourceDeviationMercatorMeters"]
        if not 0 < budget <= 3000 or producer["policy"].get("authoritativeGeometryChanged") is not False:
            raise ValueError("CURVE_BUDGET_OR_AUTHORITY_POLICY_CHANGED")
        certificates, native_old, native_new = [], [], []
        print("Verify source-generalized lines directly against unsimplified original", len(display), flush=True)
        for n in sorted(display):
            old = baseline_features[n]["geometry"]["coordinates"]
            new = display[n]["geometry"]["coordinates"]
            if old[0] != new[0] or old[-1] != new[-1]:
                raise ValueError("CURVE_ENDPOINT_MOVED:" + str(n))
            line = valid_line(old, new)
            if claims[n]["baselineGeometrySha256"] != audit.geom_hash(baseline_features[n]["geometry"]) or claims[n]["displayGeometrySha256"] != audit.geom_hash(display[n]["geometry"]):
                raise ValueError("CURVE_GEOMETRY_CLAIM_MISMATCH")
            a, b = audit.project_coordinates(old), audit.project_coordinates(new)
            distances = [] if old == new else [audit.directed_distance_bound([a], LineString(b), budget), audit.directed_distance_bound([b], LineString(a), budget)]
            orientation = audit.closed_loop_orientation(originals[n]["geometry"]["coordinates"], new)
            certificates.append({"ordinal": n, "category": categories[n], "baselineVertices": len(old), "displayVertices": len(new),
                "changed": old != new, "continuousSymmetricDistanceCertificates": distances, "loopOrientation": orientation})
            native_old.append(shape(originals[n]["geometry"])); native_new.append(line)
        print("Verify original complete topology, endpoint sectors and nesting", flush=True)
        protected_lines = [shape(e["geometry"]) for e in protected]
        topology = [audit.intersection_check(native_old, native_new, protected_lines, "OGC:CRS84"),
            audit.intersection_check(list(shapely.transform(native_old, audit.PROJECT.transform, interleaved=False)),
                list(shapely.transform(native_new, audit.PROJECT.transform, interleaved=False)),
                list(shapely.transform(protected_lines, audit.PROJECT.transform, interleaved=False)), "EPSG:3857")]
        stars = node_star_checks(originals, display, protected)
        nesting = audit.closed_loop_nesting_checks(originals, display, protected)
        for identity in [producer_pin, pointer_pin, *pins.values(), *ledger]:
            checked(identity)
        report.update({"pass": True, "countryId": "CHN", "administrativeTruthClaim": False,
            "producer": producer_pin, "artifacts": {kind: producer[kind + "Geometry"] for kind in ("province", "micro")},
            "baselinePointer": pointer_pin, "baseCatalogRef": producer["catalogRef"], "sourcePins": list(pins.values()),
            "authorityUnchanged": {"allPublishedArtifactsRechecked": len(ledger), "originalCatalogLedgerSha256": ledger_sha,
                "packageBytes": sum(p["byteLength"] for p in ledger), "authoritativeCellsParentsCountryCoastAndMilitaryInputsUnchanged": True},
            "checks": {"exactAll8562IdsCategoriesAndEndpoints": True, "allSharedNodeCoordinatesAndCyclicOrders": True,
                "wholeNetworkOriginalContactSetsBothCRSs": True, "closedLoopWindingAndNesting": True,
                "continuousSymmetricCurveDeviationAllChangedArcs": True, "originalCatalog6036ArtifactsUnchanged": True},
            "summary": {"edges": len(display), "changedEdges": sum(r["changed"] for r in certificates),
                "originalVertices": sum(r["baselineVertices"] for r in certificates),
                "displayVertices": sum(r["displayVertices"] for r in certificates), "maximumOriginalSourceDeviationMercatorMeters": budget},
            "topology": topology, "endpointStars": stars, "closedLoopNesting": nesting,
            "edges": certificates, "negativeControls": negative_controls(),
            "limitations": ["Source-generalized display lines only, with explicit new derived coordinates; authoritative source files remain unchanged.",
                "Continuous symmetric bounds apply directly between unsimplified source and delivered lines in Mercator; no geographic survey accuracy claim.",
                "The unchanged fill/tile package retains its accepted proof; browser rendering and performance are verified separately."]})
    except Exception as error:
        report["failures"].append({"type": type(error).__name__, "message": str(error)})
    report["elapsedSeconds"] = time.monotonic() - started
    report["verifier"] = pin(Path(__file__).relative_to(ROOT).as_posix())
    output = audit.local(args.output)
    if not output.is_relative_to(audit.REPORT_ROOT):
        raise ValueError("CURVE_PROOF_OUTPUT_OUTSIDE_OWNED_REPORT_DIRECTORY")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(encoded(report))
    print(json.dumps({"pass": report["pass"], "output": pin(args.output), "failures": report["failures"], "elapsedSeconds": report["elapsedSeconds"]}), flush=True)
    return 0 if report["pass"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--producer-report", required=True)
    parser.add_argument("--output", required=True)
    raise SystemExit(main(parser.parse_args()))
