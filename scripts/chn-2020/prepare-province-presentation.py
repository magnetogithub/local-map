"""Offline source-overlap analysis for a separate CHN map presentation contract.

This does not change administrative membership, game geometry, or the active catalog.
The analysis mode intentionally does not emit renderProvinceId assignments. A later
presentation decision must name a threshold and preserve unresolved uncertainty.
"""

import argparse
import hashlib
import json
import math
from pathlib import Path

import shapely
from shapely.geometry import shape


ROOT = Path(__file__).resolve().parents[2]
HIERARCHY = "data/source-locks/chn-2020/CHN-hierarchy.json"
DECISION = "reports/chn-2020/source-decision.json"
POINTER = "data/runtime/operational-catalog/current.json"
DEFAULT_OUTPUT = "reports/chn-province-20261030/newdata/source-overlap-analysis.json"


def read(file):
    return json.loads((ROOT / file).read_text("utf-8"))


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def pin(file):
    data = (ROOT / file).read_bytes()
    return {"path": file, "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data)}


def checked(artifact):
    if pin(artifact["path"]) != artifact:
        raise ValueError("PIN_CHANGED:" + artifact["path"])
    return read(artifact["path"])


def immutable(file, value):
    target = ROOT / file
    allowed = ROOT / "reports/chn-province-20261030/newdata"
    if not target.resolve().is_relative_to(allowed.resolve()):
        raise ValueError("OUTPUT_OUTSIDE_OWNED_NEWDATA_DIRECTORY")
    target.parent.mkdir(parents=True, exist_ok=True)
    data = encoded(value)
    if target.exists():
        if target.read_bytes() != data:
            raise ValueError("IMMUTABLE_OUTPUT_CHANGED:" + file)
    else:
        target.write_bytes(data)
    return pin(file)


def quantiles(values):
    values = sorted(values)
    def value(q):
        if not values:
            return None
        t = q * (len(values) - 1)
        lo, hi = math.floor(t), math.ceil(t)
        return values[lo] + (values[hi] - values[lo]) * (t - lo)
    return {k: value(q) for k, q in [("min", 0), ("p01", .01), ("p05", .05),
            ("p10", .1), ("p25", .25), ("p50", .5), ("p75", .75),
            ("p90", .9), ("p95", .95), ("p99", .99), ("max", 1)]}


def analyze(output):
    hierarchy = read(HIERARCHY)
    decision = read(DECISION)
    checked(decision["hierarchy"])
    fine_pin = hierarchy["sourceFine"]
    province_pin = hierarchy["sourceAdmin1"]["artifact"]
    fine_source = checked(fine_pin)
    province_source = checked(province_pin)
    macro_by_source = {m["sourceFeatureId"]: m for m in hierarchy["macroGroups"]}
    if len(fine_source["features"]) != 2864 or len(province_source["features"]) != 31:
        raise ValueError("UNEXPECTED_PINNED_SOURCE_COUNTS")
    verified = {a["sourceFeatureId"]: a for a in hierarchy["assignments"]}
    unresolved = {a["sourceFeatureId"]: a for a in hierarchy["unresolved"]}
    if len(verified) != 1663 or len(unresolved) != 1201 or set(verified) & set(unresolved):
        raise ValueError("UNEXPECTED_HIERARCHY_COUNTS")
    province_geometries, province_info = [], []
    for feature in province_source["features"]:
        p = feature["properties"]
        m = macro_by_source[p["shapeID"]]
        if m["sourceISO"] != p["shapeISO"] or m["name"] != p["shapeName"]:
            raise ValueError("PROVINCE_IDENTITY_MISMATCH")
        geom = shape(feature["geometry"])
        if not geom.is_valid or geom.is_empty or geom.area <= 0:
            raise ValueError("INVALID_PINNED_PROVINCE")
        province_geometries.append(geom)
        province_info.append({"sourceFeatureId": p["shapeID"], "sourceISO": p["shapeISO"], "name": p["shapeName"]})
    tree = shapely.STRtree(province_geometries)
    source_union = shapely.union_all(province_geometries)
    records, seen_ids = [], set()
    for source_index, feature in enumerate(fine_source["features"]):
        p = feature["properties"]
        source_id = p["shapeID"]
        if source_id in seen_ids or (source_id in verified) == (source_id in unresolved):
            raise ValueError("INVALID_FINE_SOURCE_ID_OR_HIERARCHY")
        seen_ids.add(source_id)
        if source_id not in unresolved:
            continue
        if len(records) % 100 == 0:
            print("source-overlap-analysis", len(records), "of", len(unresolved), flush=True)
        geom = shape(feature["geometry"])
        if not geom.is_valid or geom.is_empty or geom.area <= 0:
            raise ValueError("INVALID_PINNED_FINE:" + source_id)
        area = geom.area
        overlaps = []
        for province_index in sorted(int(i) for i in tree.query(geom)):
            intersection = geom.intersection(province_geometries[province_index])
            if intersection.area > 0:
                overlaps.append({**province_info[province_index], "intersectionAreaDegrees2": intersection.area,
                                 "shareOfRawFamilyArea": intersection.area / area})
        overlaps.sort(key=lambda item: (-item["intersectionAreaDegrees2"], item["sourceFeatureId"]))
        uncovered = geom.difference(source_union)
        top = overlaps[0] if overlaps else None
        second = overlaps[1] if len(overlaps) > 1 else None
        top_area = top["intersectionAreaDegrees2"] if top else 0
        second_area = second["intersectionAreaDegrees2"] if second else 0
        records.append({"sourceIndex": source_index, "sourceFeatureId": source_id, "sourceName": p["shapeName"],
            "rawFamilyAreaDegrees2": area, "rawFamilyBounds": list(geom.bounds),
            "positiveProvinceOverlaps": overlaps, "topShare": top_area / area,
            "secondShare": second_area / area, "topMinusSecondShare": (top_area - second_area) / area,
            "uniqueStrictLargestPositiveOverlap": top_area > second_area,
            "exactAreaTieAtTop": bool(top and second and top_area == second_area),
            "uncoveredAreaDegrees2": uncovered.area, "uncoveredShare": uncovered.area / area,
            "sumPositiveOverlapShares": sum(o["shareOfRawFamilyArea"] for o in overlaps),
            "officialParentId": None, "administrativeTruthClaim": False})
    if len(records) != 1201 or len(seen_ids) != 2864:
        raise ValueError("INCOMPLETE_SOURCE_ANALYSIS")
    thresholds = [1, .999999999999, .999999, .9999, .999, .995, .99, .98, .95, .9, .8, 2 / 3, .5]
    low = sorted(records, key=lambda r: (r["topShare"], r["sourceFeatureId"]))
    pointer = read(POINTER)
    pins = {"activePointer": pin(POINTER), "hierarchy": pin(HIERARCHY), "sourceDecision": pin(DECISION),
            "rawFineFamilies": fine_pin, "rawSourceProvinces": province_pin,
            "activeIndex": pin(pointer["root"] + "/artifact-index.json"),
            "activeCHNMetadata": pin(pointer["root"] + "/metadata/countries/CHN.json.gz"),
            "activeParents": pin(pointer["root"] + "/metadata/parents.json.gz")}
    report = {"schemaVersion": "chn-province-presentation-source-overlap-analysis-v1", "countryId": "CHN",
        "catalogVersion": pointer["catalogVersion"], "administrativeTruthClaim": False,
        "mode": "analysis-only-no-render-assignment", "scenarioDate": hierarchy["scenarioDate"],
        "inputs": pins, "code": [pin("scripts/chn-2020/prepare-province-presentation.py")],
        "runtime": {"shapely": shapely.__version__, "GEOS": shapely.geos_version_string},
        "method": "Actual pinned whole raw ADM3 polygons intersect actual pinned OSM31 ADM1 polygons in CRS84 longitude/latitude. GEOS polygon overlay area in square degrees, not bounding-box or centroid approximation; IEEE-double overlay is not exact rational arithmetic. No tolerance, buffer, snapping, coordinate transform, parent inference or geometry mutation. Top and second use actual positive area; shares use each raw family area as denominator.",
        "scope": "All 1201 unresolved raw source families, including any portions outside the active CHN envelope. Verified 1663 memberships remain fixed and are not reassigned. This report is evidence for a future separate renderProvinceId contract, not that contract itself; no officialParentId is inferred.",
        "temporalLimitation": decision["selected"]["temporalLimitation"],
        "summary": {"sourceFamilies": 2864, "verifiedMembershipsRetained": 1663, "analyzedUnresolved": len(records),
            "rawProvinceFeatures": 31,
            "noPositiveOverlap": sum(not r["positiveProvinceOverlaps"] for r in records),
            "onePositiveProvince": sum(len(r["positiveProvinceOverlaps"]) == 1 for r in records),
            "twoOrMorePositiveProvinces": sum(len(r["positiveProvinceOverlaps"]) >= 2 for r in records),
            "nonUniqueTop": sum(not r["uniqueStrictLargestPositiveOverlap"] for r in records),
            "exactAreaTiesAtTop": sum(r["exactAreaTieAtTop"] for r in records),
            "topShareQuantiles": quantiles([r["topShare"] for r in records]),
            "secondShareQuantiles": quantiles([r["secondShare"] for r in records]),
            "uncoveredShareQuantiles": quantiles([r["uncoveredShare"] for r in records]),
            "topShareThresholdCounts": [{"minimumTopShare": t, "families": sum(r["topShare"] >= t for r in records)} for t in thresholds],
            "substantialSecondShareCounts": [{"minimumSecondShare": t, "families": sum(r["secondShare"] >= t for r in records)} for t in [.5, .25, .1, .05, .01, .001, .000001]],
            "uncoveredShareThresholdCounts": [{"minimumUncoveredShare": t, "families": sum(r["uncoveredShare"] >= t for r in records)} for t in [1, .5, .1, .05, .01, .001, .000001]],
            "totalUnresolvedRawAreaDegrees2": sum(r["rawFamilyAreaDegrees2"] for r in records),
            "totalUncoveredAreaDegrees2": sum(r["uncoveredAreaDegrees2"] for r in records)},
        "lowestTopShareFamilies": low[:30], "families": records,
        "limitations": ["A unique largest overlap alone does not prove an administrative parent.",
            "A future presentation mapping must carry its explicit confidence policy and leave unsupported families unassigned.",
            "Whole current fine families cannot be split to improve the province view.",
            "Source-free game cells need their own coverage audit; this raw-source-family analysis does not assign them.",
            "Current CHN administrativeParents, source hierarchy, old seed lineage and gameplay caps remain unchanged."]}
    artifact = immutable(output, report)
    print(json.dumps({"artifact": artifact, "summary": report["summary"], "lowestTopShareFamilies": [
        {"sourceFeatureId": r["sourceFeatureId"], "sourceName": r["sourceName"], "topShare": r["topShare"],
         "secondShare": r["secondShare"], "uncoveredShare": r["uncoveredShare"],
         "overlaps": r["positiveProvinceOverlaps"][:2]} for r in low[:12]]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    analyze(args.output)
