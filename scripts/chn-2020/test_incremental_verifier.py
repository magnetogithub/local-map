"""Small corruption controls for the real independent verifier, no runtime writes."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import importlib.util


class IncrementalVerifierControls(unittest.TestCase):
    def test_exact_source_gap_checks_third_party_interiors_and_native_coordinates(self):
        spec = importlib.util.spec_from_file_location("chn_gap_verifier", Path(__file__).with_name("verify-incremental.py"))
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

        def source(identity, points):
            return {"type": "Feature", "properties": {"sourceFeatureId": identity}, "geometry": {"type": "Polygon", "coordinates": [points + [points[0]]]}}

        gap = verifier.Polygon([(0, 0), (1, 0), (0, 1)])
        first = source("s1", [(0, -1), (1, -1), (1, 0), (0, 0)])
        second = source("s2", [(-1, 0), (0, 0), (0, 1), (-1, 1)])
        country = verifier.Polygon([(-2, -2), (2, -2), (2, 2), (-2, 2)])
        self.assertTrue(verifier.certify_exact_source_gap(gap, [first, second], ["s1", "s2"], country)["pass"])
        third = source("s3", [(.2, .2), (.4, .2), (.4, .4), (.2, .4)])
        self.assertFalse(verifier.certify_exact_source_gap(gap, [first, second, third], ["s1", "s2"], country)["pass"])
        crossing = source("s3", [(-1, .2), (2, .2), (2, .3), (-1, .3)])
        proof = verifier.certify_exact_source_gap(gap, [first, second, crossing], ["s1", "s2"], country)
        self.assertFalse(proof["pass"])
        self.assertTrue(proof["properRawEdgeCrossings"])
        moved = verifier.Polygon([(0, 0), (1.00001, 0), (0, 1)])
        self.assertFalse(verifier.certify_exact_source_gap(moved, [first, second], ["s1", "s2"], country)["pass"])

    def test_border_interval_gap_is_rejected_even_with_collinear_endpoints(self):
        spec = importlib.util.spec_from_file_location("chn_independent_verifier", Path(__file__).with_name("verify-incremental.py"))
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)
        original = verifier.LineString([(0, 0), (1, 0)])
        missing_middle = verifier.shapely.MultiLineString([[(0, 0), (.4, 0)], [(.6, 0), (1, 0)]])
        result = verifier.certify_line_coverage(original, missing_middle)
        self.assertFalse(result["pass"])
        self.assertTrue(any(failure.get("lengthDegrees", 0) >= .19 for failure in result["failures"]))
        curved = verifier.LineString([(0, .2), (.4, -.1), (.8, .3), (1, .1)])
        self.assertAlmostEqual(verifier.indexed_discrete_hausdorff(original, curved), original.hausdorff_distance(curved), places=15)

    def test_valid_partition_and_corruptions(self):
        repo = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="chn-verifier-controls-", dir=repo / ".tmp") as directory:
            root = Path(directory)

            def write(name, value):
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text(json.dumps(value, separators=(",", ":")) + "\n", encoding="utf8")
                return {"path": str(file).replace("\\", "/"), "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "byteLength": file.stat().st_size}

            def feature(identity, country, west, south, east, north, source=None):
                props = {"countryId": country}
                if source:
                    props.update(fineSourceIdentity={"sourceId": "fixture", "sourceFeatureId": source}, sourceParentId="CN-A")
                return {"type": "Feature", "id": identity, "properties": props, "geometry": {"type": "Polygon", "coordinates": [[[west, south], [east, south], [east, north], [west, north], [west, south]]]}}

            def edges(features, records):
                mesh = {}
                for f in features:
                    ring = f["geometry"]["coordinates"][0]
                    for a, b in zip(ring, ring[1:]):
                        key = tuple(sorted([tuple(a), tuple(b)]))
                        sides = mesh.setdefault(key, {"left": None, "right": None})
                        sides["left" if tuple(a) == key[0] else "right"] = f["id"]
                result = []
                country = {r["id"]: r["countryId"] for r in records}
                for n, (coordinates, sides) in enumerate(mesh.items()):
                    a, b = sides["left"], sides["right"]
                    if a is None:
                        a, b = b, a
                        coordinates = tuple(reversed(coordinates))
                    result.append({"id": f"edge.{n}", "leftTerritoryId": a, "rightTerritoryId": b, "geometry": {"type": "LineString", "coordinates": coordinates}, "boundaryClass": "coast" if b is None else "country" if country[a] != country[b] else "operational"})
                return result

            countries = ["CHN", "PRK", "KOR"]
            parents = {"administrative": [{"parentKey": f"parent.{c}", "sourceCountryId": c, "kind": "administrative"} for c in countries], "previous": [{"oldTerritoryId": f"old.{c}", "sourceCountryId": c} for c in countries]}
            common = [feature("prk", "PRK", 2, 0, 3, 1, "fixture.prk"), feature("kor", "KOR", 2, -1, 3, 0, "fixture.kor")]
            old_features = [feature("chn", "CHN", 0, 0, 2, 1), *common]
            new_features = [feature("chn1", "CHN", 0, 0, 1, 1, "s1"), feature("chn2", "CHN", 1, 0, 2, 1, "s2"), *common]

            def records(features):
                return [{"id": f["id"], "countryId": f["properties"]["countryId"], "administrativeParentKey": f"parent.{f['properties']['countryId']}", "previousParentId": f"old.{f['properties']['countryId']}"} for f in features]

            baseline = {"features": old_features, "records": records(old_features), "parents": parents, "edges": edges(old_features, records(old_features))}
            baseline_pin = write("baseline.json", baseline)
            provenance_pin = write("delivery/provenance.json", {"inputRoot": baseline_pin["sha256"]})
            index_pin = write("delivery/artifact-index.json", {"artifacts": [{**provenance_pin, "path": "provenance.json"}]})
            pointer_pin = write("baseline-pointer.json", {"root": str(root / "delivery").replace("\\", "/"), "index": index_pin})
            source_features = [{**f, "properties": {"sourceFeatureId": f"s{i+1}"}} for i, f in enumerate(new_features[:2])]
            normalized_pin = write("normalized.json", {"type": "FeatureCollection", "features": source_features})
            macro_pin = write("macro.json", {"type": "FeatureCollection", "features": [{**old_features[0], "properties": {"shapeISO": "CN-A"}}]})
            hierarchy_pin = write("hierarchy.json", {"assignments": [{"sourceFeatureId": sid, "sourceParentId": "CN-A", "administrativeParentKey": "parent.CHN"} for sid in ["s1", "s2"]]})
            locks = []
            for country in countries:
                locks.append(write(f"{country}-lock.json", {"countryId": country, "sources": [{"artifact": normalized_pin, "license": {"redistributionAllowed": True}}], "normalizedInput": normalized_pin}))
            candidate = {"features": new_features, "records": records(new_features), "parents": parents, "edges": edges(new_features, records(new_features)), "report": {"sourceLockArtifacts": locks, "hierarchyArtifacts": [hierarchy_pin], "incremental": {"baseline": {"pointer": pointer_pin, "bundle": baseline_pin}, "macroSource": macro_pin}}}
            good_pin = write("candidate.json", candidate)
            write("replay.json", candidate)
            command = [sys.executable, str(repo / "scripts/chn-2020/verify-incremental.py"), "--candidate", good_pin["path"], "--baseline", baseline_pin["path"], "--baseline-pointer", pointer_pin["path"], "--normalized", normalized_pin["path"], "--hierarchy", hierarchy_pin["path"], "--macro-source", macro_pin["path"], "--replay", str(root / "replay.json"), "--output", str(root / "result.json")]
            result = subprocess.run(command, cwd=repo, text=True, capture_output=True, env=os.environ)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            noded = copy.deepcopy(candidate)
            for coordinate in noded["features"][0]["geometry"]["coordinates"][0]:
                if coordinate[0] == 1:
                    coordinate[0] = 1 + 1e-14
            for coordinate in noded["features"][1]["geometry"]["coordinates"][0]:
                if coordinate[0] == 1:
                    coordinate[0] = 1 + 1e-14
            noded["edges"] = edges(noded["features"], noded["records"])
            write("candidate.json", noded)
            write("replay.json", noded)
            result = subprocess.run(command, cwd=repo, text=True, capture_output=True, env=os.environ)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            noded_report = json.loads((root / "result.json").read_text(encoding="utf8"))
            self.assertTrue(noded_report["numericExceptions"])
            write("replay.json", candidate)
            for mutation, expected in [("border", "MISSING_OR_DUPLICATE_TARGET_MESH_EDGE"), ("border-to-coast", "COUNTRY_BORDER_OR_COAST_COVERAGE_CHANGED"), ("record", "NON_TARGET_RECORD_CHANGED"), ("overlap", "POSITIVE_AREA_TARGET_OVERLAPS"), ("coherent-boundary-move", "FINAL_FINE_FAMILY_DIFFERS_FROM_SOURCE_PLUS_LEDGER")]:
                bad = copy.deepcopy(candidate)
                if mutation == "border":
                    bad["edges"] = [e for e in bad["edges"] if not {e["leftTerritoryId"], e["rightTerritoryId"]} == {"chn2", "prk"}]
                elif mutation == "border-to-coast":
                    for e in bad["edges"]:
                        if {e["leftTerritoryId"], e["rightTerritoryId"]} == {"chn2", "prk"}:
                            e["rightTerritoryId"] = None
                            e["boundaryClass"] = "coast"
                elif mutation == "record":
                    bad["records"][-1]["previousParentId"] = "wrong"
                elif mutation == "coherent-boundary-move":
                    for f in bad["features"][:2]:
                        for coordinate in f["geometry"]["coordinates"][0]:
                            if coordinate[0] == 1:
                                coordinate[0] = 1.05
                    bad["edges"] = edges(bad["features"], bad["records"])
                else:
                    bad["features"][0]["geometry"]["coordinates"][0][1][0] = 1.2
                    bad["features"][0]["geometry"]["coordinates"][0][2][0] = 1.2
                write("candidate.json", bad)
                result = subprocess.run(command, cwd=repo, text=True, capture_output=True, env=os.environ)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                report = json.loads((root / "result.json").read_text(encoding="utf8"))
                self.assertIn(expected, {failure["code"] for failure in report["failures"]}, result.stdout + result.stderr)

            # Overlap-free, completely covered land can still contain a bogus
            # parallel strip. A classification string alone must not accept it.
            strip = copy.deepcopy(candidate)
            strip["features"][:2] = [feature("chn1", "CHN", 0, 0, .95, 1, "s1"), feature("chn2", "CHN", 1.05, 0, 2, 1, "s2")]
            strip["features"].append(feature("strip", "CHN", .95, 0, 1.05, 1))
            strip["records"] = records(strip["features"])
            strip["records"][-1]["administrativeParentKey"] = "fallback.CHN"
            strip["parents"]["administrative"].append({"parentKey": "fallback.CHN", "sourceCountryId": "CHN", "kind": "country-envelope-residual"})
            strip["edges"] = edges(strip["features"], strip["records"])
            for e in strip["edges"]:
                if e["rightTerritoryId"] and "strip" in [e["leftTerritoryId"], e["rightTerritoryId"]]:
                    e["boundaryClass"] = "residual"
            source_features = [{**f, "properties": {"sourceFeatureId": f"s{i+1}"}} for i, f in enumerate(strip["features"][:2])]
            strip_normalized = write("normalized.json", {"type": "FeatureCollection", "features": source_features})
            strip["report"]["sourceLockArtifacts"] = [write(f"{country}-lock.json", {"countryId": country, "sources": [{"artifact": strip_normalized, "license": {"redistributionAllowed": True}}], "normalizedInput": strip_normalized}) for country in countries]
            strip["report"]["incremental"]["residualLedger"] = [{"cellId": "strip", "reason": "Deliberately retained parallel strip; this reason cannot make it pass"}]
            write("candidate.json", strip)
            write("replay.json", strip)
            result = subprocess.run(command, cwd=repo, text=True, capture_output=True, env=os.environ)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = json.loads((root / "result.json").read_text(encoding="utf8"))
            self.assertTrue(report["checks"]["coverage"])
            self.assertIn("UNRECONCILED_RESIDUAL_WITH_ORIGINAL_FINE_CONTACT", {failure["code"] for failure in report["failures"]})


if __name__ == "__main__":
    unittest.main()
