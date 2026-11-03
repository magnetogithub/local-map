"""Apply explicit same-country, single-neighbor enclosed-cell corrections offline.

No snapping or general polygon repair: only remove an exactly matching hole.
Run the independent verifier and packager before publishing the result.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path

from pyproj import Geod
from shapely.geometry import Polygon, shape

ROOT = Path(__file__).resolve().parents[1]


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def pin(relative):
    path = (ROOT / relative).resolve()
    path.relative_to(ROOT)
    data = path.read_bytes()
    return {"path": path.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data)}


def checked(identity):
    assert pin(identity["path"]) == identity, "INPUT_PIN_CHANGED"
    return json.loads((ROOT / identity["path"]).read_text(encoding="utf-8"))


def immutable(relative, value):
    path = ROOT / relative
    data = encoded(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        assert path.read_bytes() == data, "IMMUTABLE_OUTPUT_CHANGED"
    else:
        path.write_bytes(data)
    return pin(relative)


def build(plan_path, pointer_path):
    plan_pin = pin(plan_path)
    plan = checked(plan_pin)
    assert plan["schemaVersion"] == "manual-contained-cell-merges-v1"
    assert plan["operations"] and len({p["id"] for p in plan["operations"]}) == len(plan["operations"])
    pointer_pin = pin(pointer_path)
    pointer = checked(pointer_pin)
    # Archive the precise active baseline instead of retaining a mutable current pointer.
    snapshot_path = ROOT / f"data/derived/manual-cell-merges/baseline-{pointer_pin['sha256'][:20]}/active-pointer.json"
    pointer_bytes = (ROOT / pointer_path).read_bytes()
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    if snapshot_path.exists():
        assert snapshot_path.read_bytes() == pointer_bytes, "BASELINE_SNAPSHOT_CHANGED"
    else:
        snapshot_path.write_bytes(pointer_bytes)
    snapshot = pin(snapshot_path.relative_to(ROOT))
    index_pin = {"path": pointer["root"] + "/artifact-index.json", **pointer["index"]}
    index = checked(index_pin)
    provenance_pin = next({**p, "path": pointer["root"] + "/" + p["path"]} for p in index["artifacts"] if p["path"] == "provenance.json")
    provenance = checked(provenance_pin)
    input_pin = next(p for p in provenance["inputs"] if p.get("sha256") == provenance["inputRoot"])
    before = checked(input_pin)
    bundle = copy.deepcopy(before)
    operations = []
    geod = Geod(ellps="WGS84")
    for request in plan["operations"]:
        features = {f["id"]: f for f in bundle["features"]}
        records = {r["id"]: r for r in bundle["records"]}
        removed = features[request["removeCellId"]]
        recipient = features[request["mergeIntoCellId"]]
        a, b = records[removed["id"]], records[recipient["id"]]
        assert a["countryId"] == b["countryId"] == request["countryId"], "CROSS_COUNTRY_MERGE"
        assert a["administrativeParentKey"] == b["administrativeParentKey"], "PARENT_RECONCILIATION_REQUIRED"
        assert a["previousParentId"] == b["previousParentId"], "SEED_RECONCILIATION_REQUIRED"
        assert set(a["seedParentIds"]).issubset(b["seedParentIds"]), "SEED_RECONCILIATION_REQUIRED"
        assert digest(removed["geometry"]) == request["expectedRemoveGeometrySha256"], "REMOVED_GEOMETRY_CHANGED"
        assert digest(recipient["geometry"]) == request["expectedRecipientGeometrySha256"], "RECIPIENT_GEOMETRY_CHANGED"
        assert removed["geometry"]["type"] == recipient["geometry"]["type"] == "Polygon", "POLYGON_REQUIRED"
        raw = shape(removed["geometry"])
        assert raw.is_valid and len(removed["geometry"]["coordinates"]) == 1
        area_km2 = abs(geod.geometry_area_perimeter(raw)[0]) / 1e6
        assert 0 < area_km2 <= request["maximumRemovedAreaKm2"], "REMOVED_AREA_OUT_OF_SCOPE"
        matches = [i for i, ring in enumerate(recipient["geometry"]["coordinates"]) if i > 0 and Polygon(ring).equals(raw)]
        assert len(matches) == 1, "EXACT_ENCLOSED_HOLE_REQUIRED"
        incident = [e for e in bundle["edges"] if removed["id"] in [e["leftTerritoryId"], e["rightTerritoryId"]]]
        assert len(incident) == 1 and {incident[0]["leftTerritoryId"], incident[0]["rightTerritoryId"]} == {a["id"], b["id"]}, "SINGLE_NEIGHBOR_REQUIRED"
        merged = copy.deepcopy(recipient)
        merged["geometry"]["coordinates"].pop(matches[0])
        assert shape(merged["geometry"]).equals(shape(recipient["geometry"]).union(raw)), "MERGE_COVERAGE_CHANGED"
        new_id = "territory:catalog:" + digest({"country": b["countryId"], "family": recipient["properties"]["fineSourceIdentity"], "geometry": merged["geometry"]})
        assert new_id not in features, "DUPLICATE_MERGED_ID"
        merged["id"] = new_id
        merged["properties"]["manualCellMerge"] = {"operationId": request["id"], "removedCellId": a["id"], "previousRecipientCellId": b["id"], "administrativeTruthClaim": False}
        merged_record = {**b, "id": new_id}
        for edge in bundle["edges"]:
            for side in ["leftTerritoryId", "rightTerritoryId"]:
                if edge[side] == b["id"]:
                    edge[side] = new_id
        bundle["edges"] = [e for e in bundle["edges"] if e["id"] != incident[0]["id"]]
        bundle["features"] = sorted([f for f in bundle["features"] if f["id"] not in {a["id"], b["id"]}] + [merged], key=lambda f: f["id"])
        bundle["records"] = sorted([r for r in bundle["records"] if r["id"] not in {a["id"], b["id"]}] + [merged_record], key=lambda r: r["id"])
        operations.append({**request, "evidencePin": pin(request["evidenceReport"]), "mergedCellId": new_id, "removedEdgeIds": [incident[0]["id"]], "removedHoleIndex": matches[0], "removedAreaKm2": area_km2, "mergedGeometrySha256": digest(merged["geometry"])})
    correction = {"schemaVersion": "catalog-contained-cell-merge-v1", "administrativeTruthClaim": False,
        "baseline": {"pointer": snapshot, "bundle": input_pin, "provenance": provenance_pin},
        "plan": plan_pin, "operations": operations,
        "code": [pin("scripts/apply-contained-cell-merges.py"), pin("scripts/verify-contained-cell-merges.py")]}
    bundle["report"]["manualCellMerge"] = correction
    bundle["report"]["topology"] = {**bundle["report"]["topology"], "edges": len(bundle["edges"])}
    folder = "data/derived/manual-cell-merges/candidate-" + digest(bundle)[:20]
    output = immutable(folder + "/joined-world-input.json", bundle)
    return {"output": output, "correction": correction, "counts": {"cells": len(bundle["records"]), "edges": len(bundle["edges"])}}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corrections", required=True)
    parser.add_argument("--baseline-pointer", default="data/runtime/operational-catalog/current.json")
    args = parser.parse_args()
    print(json.dumps(build(args.corrections, args.baseline_pointer), ensure_ascii=True))
