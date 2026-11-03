"""Independently verify complete-hole merges against an admitted baseline."""
import argparse
import copy
import hashlib
import json
import subprocess
import sys
from pathlib import Path

from pyproj import Geod
from shapely.geometry import Polygon, shape

ROOT = Path(__file__).resolve().parents[1]


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def pin(relative):
    path = (ROOT / relative).resolve()
    path.relative_to(ROOT)
    raw = path.read_bytes()
    return {"path": path.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(raw).hexdigest(), "byteLength": len(raw)}


def checked(identity):
    assert pin(identity["path"]) == identity, "STALE_PIN"
    return json.loads((ROOT / identity["path"]).read_text(encoding="utf-8"))


def verify(input_path, replay=True):
    after_pin = pin(input_path)
    after = checked(after_pin)
    correction = after["report"]["manualCellMerge"]
    assert correction["schemaVersion"] == "catalog-contained-cell-merge-v1"
    assert correction["administrativeTruthClaim"] is False
    before = checked(correction["baseline"]["bundle"])
    pointer = checked(correction["baseline"]["pointer"])
    index = checked({"path": pointer["root"] + "/artifact-index.json", **pointer["index"]})
    # Prove the baseline is precisely the indexed, admitted catalog input.
    for entry in index["artifacts"]:
        assert pin(pointer["root"] + "/" + entry["path"]) == {**entry, "path": pointer["root"] + "/" + entry["path"]}, "BASELINE_ARTIFACT_CHANGED"
    provenance = checked(correction["baseline"]["provenance"])
    assert provenance["inputRoot"] == correction["baseline"]["bundle"]["sha256"]
    assert correction["baseline"]["bundle"] in provenance["inputs"]
    baseline_acceptance = provenance.get("incrementalVerification")
    assert baseline_acceptance and checked(baseline_acceptance)["pass"] is True
    plan = checked(correction["plan"])
    assert len(plan["operations"]) == len(correction["operations"]) > 0
    for identity in correction["code"]:
        checked_code = pin(identity["path"])
        assert checked_code == identity
    expected_features = {f["id"]: copy.deepcopy(f) for f in before["features"]}
    expected_records = {r["id"]: copy.deepcopy(r) for r in before["records"]}
    expected_edges = copy.deepcopy(before["edges"])
    certificates = []
    for request, op in zip(plan["operations"], correction["operations"]):
        assert all(op[k] == value for k, value in request.items()), "PLAN_OPERATION_CHANGED"
        checked(op["evidencePin"])
        a, b, new_id = op["removeCellId"], op["mergeIntoCellId"], op["mergedCellId"]
        small, large = expected_features[a], expected_features[b]
        ar, br = expected_records[a], expected_records[b]
        assert ar["countryId"] == br["countryId"] == op["countryId"]
        assert ar["administrativeParentKey"] == br["administrativeParentKey"]
        assert ar["previousParentId"] == br["previousParentId"]
        assert set(ar["seedParentIds"]).issubset(br["seedParentIds"])
        assert hashlib.sha256(encode(small["geometry"])).hexdigest() == op["expectedRemoveGeometrySha256"]
        assert hashlib.sha256(encode(large["geometry"])).hexdigest() == op["expectedRecipientGeometrySha256"]
        assert small["geometry"]["type"] == large["geometry"]["type"] == "Polygon"
        assert len(small["geometry"]["coordinates"]) == 1
        small_shape, large_shape = shape(small["geometry"]), shape(large["geometry"])
        parcel_area = abs(Geod(ellps="WGS84").geometry_area_perimeter(small_shape)[0]) / 1e6
        assert 0 < parcel_area <= op["maximumRemovedAreaKm2"] and parcel_area == op["removedAreaKm2"]
        holes = [i for i, ring in enumerate(large["geometry"]["coordinates"]) if i and Polygon(ring).equals(small_shape)]
        assert holes == [op["removedHoleIndex"]]
        incident = [e for e in expected_edges if a in [e["leftTerritoryId"], e["rightTerritoryId"]]]
        assert len(incident) == 1
        assert {incident[0]["leftTerritoryId"], incident[0]["rightTerritoryId"]} == {a, b}
        assert [incident[0]["id"]] == op["removedEdgeIds"]
        merged = copy.deepcopy(large)
        merged["geometry"]["coordinates"].pop(holes[0])
        merged["id"] = new_id
        merged["properties"]["manualCellMerge"] = {"operationId": op["id"], "removedCellId": a, "previousRecipientCellId": b, "administrativeTruthClaim": False}
        merged_shape = shape(merged["geometry"])
        assert merged_shape.is_valid and merged_shape.geom_type == "Polygon"
        assert merged_shape.symmetric_difference(small_shape.union(large_shape)).is_empty, "LAND_CHANGED"
        assert small_shape.intersection(large_shape).area == 0
        assert merged_shape.exterior.equals(large_shape.exterior), "OUTER_BOUNDARY_CHANGED"
        assert merged_shape.intersection(small_shape).equals(small_shape), "PARCEL_NOT_ABSORBED"
        for entry in expected_edges:
            for side in ["leftTerritoryId", "rightTerritoryId"]:
                if entry[side] == b:
                    entry[side] = new_id
        expected_edges = [e for e in expected_edges if e["id"] != incident[0]["id"]]
        del expected_features[a], expected_features[b], expected_records[a], expected_records[b]
        expected_features[new_id] = merged
        expected_records[new_id] = {**br, "id": new_id}
        certificates.append({"operationId": op["id"], "landSymmetricDifferenceArea": 0, "exteriorCoordinatesUnchanged": True, "removedCells": [a], "replacedRecipient": b, "mergedCell": new_id, "removedEdges": op["removedEdgeIds"]})
    assert after["features"] == sorted(expected_features.values(), key=lambda f: f["id"]), "UNAUTHORIZED_FEATURE_CHANGE"
    assert after["records"] == sorted(expected_records.values(), key=lambda r: r["id"]), "UNAUTHORIZED_RECORD_CHANGE"
    assert after["edges"] == expected_edges, "UNAUTHORIZED_EDGE_CHANGE"
    assert after["parents"] == before["parents"], "PARENTS_CHANGED"
    expected_report = copy.deepcopy(before["report"])
    expected_report["manualCellMerge"] = correction
    expected_report["topology"]["edges"] = len(expected_edges)
    assert after["report"] == expected_report
    assert {k: v for k, v in after.items() if k not in ["features", "records", "edges", "report"]} == {k: v for k, v in before.items() if k not in ["features", "records", "edges", "report"]}
    assert len(expected_features) == len(before["features"]) - len(certificates)
    ids = set(expected_records)
    assert all(e["leftTerritoryId"] in ids and (e["rightTerritoryId"] is None or e["rightTerritoryId"] in ids) and e["leftTerritoryId"] != e["rightTerritoryId"] for e in expected_edges)
    if replay:
        command = [sys.executable, str(ROOT / "scripts/apply-contained-cell-merges.py"), "--corrections", correction["plan"]["path"], "--baseline-pointer", correction["baseline"]["pointer"]["path"]]
        process = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=True, encoding="utf-8")
        assert json.loads(process.stdout)["output"] == after_pin, "REPLAY_DIFFERS"
    return {"schemaVersion": "catalog-contained-cell-merge-independent-v1", "pass": True, "before": correction["baseline"]["bundle"], "after": after_pin,
        "baselinePointer": correction["baseline"]["pointer"], "plan": correction["plan"], "sourcePins": correction["code"] + [correction["baseline"]["provenance"]],
        "verifier": pin("scripts/verify-contained-cell-merges.py"), "checks": {"scope": True, "coverage": True, "topology": True, "lineage": True, "sourcePreservation": True, "reproducibility": replay}, "certificates": certificates}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    report = verify(args.input)
    destination = (ROOT / args.output).resolve()
    assert destination.is_relative_to(ROOT / "reports")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(encode(report))
    print(json.dumps({"pass": True, "proof": pin(args.output), "certificates": report["certificates"]}))
