"""Analyze existing whole CHN game families for a presentation-only province view.

No parent, render assignment, edge index, geometry, catalog or runtime is written.
"""

import argparse
import gzip
import importlib.util
import json
from collections import defaultdict
from pathlib import Path

import pyproj
import shapely
from shapely.geometry import shape
from shapely.ops import transform


ROOT = Path(__file__).resolve().parents[2]
HELPER = "scripts/chn-2020/prepare-province-presentation.py"
spec = importlib.util.spec_from_file_location("province_analysis_helpers", ROOT / HELPER)
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
read, pin, checked, immutable, quantiles = helper.read, helper.pin, helper.checked, helper.immutable, helper.quantiles
POINTER = "data/runtime/operational-catalog/current.json"
RAW_ANALYSIS = "reports/chn-province-20261030/newdata/source-overlap-analysis.json"
AEA = "+proj=aea +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +datum=WGS84 +units=m +no_defs"


def only_pin(artifact):
    return {k: artifact[k] for k in ("path", "sha256", "byteLength")}


def analyze(output):
    start_pointer = pin(POINTER)
    pointer = read(POINTER)
    index_pin = {"path": pointer["root"] + "/artifact-index.json", **pointer["index"]}
    checked(index_pin)
    provenance_path = pointer["root"] + "/provenance.json"
    provenance = read(provenance_path)
    hierarchy_pin = only_pin(next(a for a in provenance["hierarchyArtifacts"] if a["countryId"] == "CHN"))
    hierarchy = checked(hierarchy_pin)
    if pin(helper.HIERARCHY) != hierarchy_pin:
        raise ValueError("ACTIVE_HIERARCHY_DIFFERENT_FROM_FIRST_ANALYSIS")
    decision_pin = provenance["incremental"]["sourceDecision"]
    decision = checked(decision_pin)
    raw_analysis_pin = pin(RAW_ANALYSIS)
    raw_analysis = checked(raw_analysis_pin)
    for artifact in list(raw_analysis["inputs"].values()) + raw_analysis["code"]:
        if pin(artifact["path"]) != artifact:
            raise ValueError("RAW_ANALYSIS_INPUT_CHANGED:" + artifact["path"])
    macro_pin = provenance["incremental"]["macroSource"]
    if macro_pin != hierarchy["sourceAdmin1"]["artifact"]:
        raise ValueError("ACTIVE_MACRO_SOURCE_MISMATCH")
    macro_metadata_pin = hierarchy["sourceAdmin1"]["metadata"]
    macro_metadata = checked(macro_metadata_pin)
    macro_source = checked(macro_pin)
    geometry_pin = provenance["incremental"]["geometry"]
    active = checked(geometry_pin)
    metadata_pin = pin(pointer["root"] + "/metadata/countries/CHN.json.gz")
    metadata = json.loads(gzip.decompress((ROOT / metadata_pin["path"]).read_bytes()))
    if metadata["countryId"] != "CHN" or set(row[1] for row in metadata["rows"]) != set(f["id"] for f in active["cells"]):
        raise ValueError("ACTIVE_GEOMETRY_CELL_IDS_DIFFER_FROM_DELIVERY")
    inputs = {"activePointer": start_pointer, "activeIndex": index_pin, "activeProvenance": pin(provenance_path),
              "activeCHNMetadata": metadata_pin, "activeCHNGeometry": geometry_pin,
              "hierarchy": hierarchy_pin, "sourceDecision": decision_pin,
              "rawSourceProvinces": macro_pin, "rawSourceProvinceMetadata": macro_metadata_pin,
              "rawSourceFamilies": hierarchy["sourceFine"], "rawFamilyAnalysis": raw_analysis_pin}
    code = [pin(HELPER), pin("scripts/chn-2020/analyze-active-province-presentation.py")]
    grouped, names, source_free = defaultdict(list), {}, []
    for feature in active["cells"]:
        props = feature["properties"]
        geom = shape(feature["geometry"])
        if props["countryId"] != "CHN" or geom.is_empty or not geom.is_valid:
            raise ValueError("INVALID_ACTIVE_CELL")
        if props.get("fineSourceIdentity"):
            source_id = props["sourceFeatureId"]
            if source_id != props["fineSourceIdentity"]["sourceFeatureId"]:
                raise ValueError("FINE_IDENTITY_MISMATCH")
            grouped[source_id].append((feature["id"], geom))
            names[source_id] = props["name"]
        else:
            source_free.append((feature["id"], geom))
    del active
    if len(grouped) != 2850 or len(source_free) != 7:
        raise ValueError("UNEXPECTED_ACTIVE_FAMILY_COUNTS")
    verified = {a["sourceFeatureId"]: a for a in hierarchy["assignments"]}
    raw_by_id = {a["sourceFeatureId"]: a for a in raw_analysis["families"]}
    macro_by_id = {m["sourceFeatureId"]: m for m in hierarchy["macroGroups"]}
    province_geometries, province_info = [], []
    for feature in macro_source["features"]:
        props = feature["properties"]
        m = macro_by_id[props["shapeID"]]
        geom = shape(feature["geometry"])
        if not geom.is_valid or geom.is_empty or m["sourceISO"] != props["shapeISO"]:
            raise ValueError("INVALID_PROVINCE_SOURCE")
        province_geometries.append(geom)
        province_info.append({"sourceFeatureId": props["shapeID"], "sourceISO": props["shapeISO"], "name": props["shapeName"]})
    tree = shapely.STRtree(province_geometries)
    shapely.prepare(province_geometries)
    province_union = shapely.union_all(province_geometries)
    transformer = pyproj.Transformer.from_crs("OGC:CRS84", pyproj.CRS.from_proj4(AEA), always_xy=True)
    def area_m2(geom):
        return transform(transformer.transform, geom).area
    def overlaps_for(geom):
        planar_area, equal_area = geom.area, area_m2(geom)
        overlaps = []
        for n in sorted(int(i) for i in tree.query(geom)):
            province = province_geometries[n]
            intersection = geom if province.covers(geom) else geom.intersection(province)
            if intersection.area <= 0:
                continue
            intersection_equal_area = area_m2(intersection)
            overlaps.append({**province_info[n], "intersectionAreaDegrees2": intersection.area,
                "intersectionAreaSquareMetersAEA": intersection_equal_area,
                "shareOfFamilyAreaPlanar": intersection.area / planar_area,
                "shareOfFamilyAreaAEA": intersection_equal_area / equal_area})
        overlaps.sort(key=lambda r: (-r["intersectionAreaSquareMetersAEA"], r["sourceFeatureId"]))
        uncovered = geom.difference(province_union)
        top = overlaps[0] if overlaps else None
        second = overlaps[1] if len(overlaps) > 1 else None
        return {"activeFamilyAreaDegrees2": planar_area, "activeFamilyAreaSquareMetersAEA": equal_area,
            "bounds": list(geom.bounds), "positiveProvinceOverlaps": overlaps,
            "uniqueStrictLargestPositiveOverlapAEA": bool(top and (not second or top["intersectionAreaSquareMetersAEA"] > second["intersectionAreaSquareMetersAEA"])),
            "topShareAEA": top["shareOfFamilyAreaAEA"] if top else 0,
            "secondShareAEA": second["shareOfFamilyAreaAEA"] if second else 0,
            "topSharePlanar": max((a["shareOfFamilyAreaPlanar"] for a in overlaps), default=0),
            "uncoveredAreaDegrees2": uncovered.area, "uncoveredSharePlanar": uncovered.area / planar_area,
            "uncoveredAreaSquareMetersAEA": area_m2(uncovered), "uncoveredShareAEA": area_m2(uncovered) / equal_area,
            "sumPositiveOverlapSharesAEA": sum(a["shareOfFamilyAreaAEA"] for a in overlaps)}
    records = []
    for ordinal, (source_id, cells) in enumerate(sorted(grouped.items())):
        if ordinal % 200 == 0:
            print("active-family-overlap", ordinal, "of", len(grouped), flush=True)
        family = shapely.union_all([g for _, g in cells])
        if family.is_empty or not family.is_valid:
            raise ValueError("INVALID_ACTIVE_FAMILY_UNION")
        record = {"sourceFeatureId": source_id, "sourceName": names[source_id],
                  "cellIds": sorted(i for i, _ in cells), "activeCellCount": len(cells),
                  "verifiedMembershipPreserved": source_id in verified,
                  "existingVerifiedSourceMacroIdUnchanged": verified.get(source_id, {}).get("macroId"),
                  "administrativeTruthClaim": False, **overlaps_for(family)}
        if source_id in raw_by_id:
            raw = raw_by_id[source_id]
            record["rawComparison"] = {"rawTopSharePlanar": raw["topShare"],
                "rawSecondSharePlanar": raw["secondShare"], "rawUncoveredSharePlanar": raw["uncoveredShare"],
                "rawTopProvinceSourceFeatureId": raw["positiveProvinceOverlaps"][0]["sourceFeatureId"] if raw["positiveProvinceOverlaps"] else None,
                "activeMinusRawTopSharePlanar": record["topSharePlanar"] - raw["topShare"]}
        records.append(record)
    residual_records = [{"cellId": cell_id, "administrativeTruthClaim": False, "sourceFamilyId": None,
        "disposition": "source-free-unassigned-separate-analysis", **overlaps_for(geom)} for cell_id, geom in source_free]
    unresolved_records = [r for r in records if not r["verifiedMembershipPreserved"]]
    no_longer_present = [r for r in raw_analysis["families"] if r["sourceFeatureId"] not in grouped]
    low_or_changed = [r for r in unresolved_records if r["topShareAEA"] < .999 or not r["positiveProvinceOverlaps"] or
        r["rawComparison"]["rawTopSharePlanar"] < .999 or r["rawComparison"]["rawTopProvinceSourceFeatureId"] != (
            r["positiveProvinceOverlaps"][0]["sourceFeatureId"] if r["positiveProvinceOverlaps"] else None)]
    thresholds = [1, .999999, .9999, .999, .995, .99, .98, .95, .9, .8, .5]
    for artifact in list(inputs.values()) + code:
        if pin(artifact["path"]) != artifact:
            raise ValueError("INPUT_CHANGED_DURING_ANALYSIS:" + artifact["path"])
    report = {"schemaVersion": "chn-active-province-presentation-overlap-analysis-v1", "countryId": "CHN",
        "catalogVersion": pointer["catalogVersion"], "administrativeTruthClaim": False,
        "mode": "analysis-only-no-render-assignment", "inputs": inputs, "code": code,
        "inputPinsVerifiedBeforeAndAfterAnalysis": True,
        "scope": "Union all existing delivered CHN cells for each original fine sourceFeatureId, including recorded game gains. Families remain whole. Seven source-free delivered cells are measured separately. No source outside current CHN is imported and no official or presentation parent is assigned.",
        "areaMeasurement": {"overlayCRS": "OGC:CRS84", "sourceAxisOrder": "longitude,latitude",
            "overlayMethod": "GEOS polygon intersections of existing geographic polygon edges; actual polygon overlay, not bbox/centroid approximation.",
            "equalAreaCRS": AEA, "projectionName": "China-centered custom WGS84 Albers equal-area conic; no official CRS code claimed",
            "alwaysXY": True, "outputAxisOrder": "easting,northing meters", "areaUnits": "square meters",
            "measurementMethod": "Transform each existing family and each actual CRS84 intersection/difference polygon to Albers and measure planar area. Transform preserves input vertices; no densification or geometry mutation. Projection of newly subdivided geographic edges can cause minute area-closure differences, which are not acceptance tolerances.",
            "planarComparison": "CRS84 degree-squared ratios retained to compare like-for-like with the raw-family report. Ratios are geometric area shares, not statistical confidence or administrative proof."},
        "sourceTemporalLimits": {"fine": decision["selected"]["temporalLimitation"],
            "provinceRepresentedYear": macro_metadata["boundaryYear"], "provincePublishedUpdate": macro_metadata["boundaryUpdate"],
            "province2020AdministrativeTruthCertified": False},
        "runtime": {"shapely": shapely.__version__, "GEOS": shapely.geos_version_string, "pyproj": pyproj.__version__, "PROJ": pyproj.proj_version_str},
        "summary": {"activeCHNCells": sum(r["activeCellCount"] for r in records) + len(residual_records),
            "wholeFineFamilies": len(records), "verifiedSourceMembershipsPreserved": len(records) - len(unresolved_records),
            "activeUnresolvedSourceFamilies": len(unresolved_records), "sourceFreeCells": len(residual_records),
            "rawUnresolvedFamiliesNotPresentInActiveCHN": len(no_longer_present),
            "unresolvedNoPositiveOverlap": sum(not r["positiveProvinceOverlaps"] for r in unresolved_records),
            "unresolvedNonUniqueLargestPositiveOverlap": sum(not r["uniqueStrictLargestPositiveOverlapAEA"] for r in unresolved_records),
            "unresolvedTopShareAEAQuantiles": quantiles([r["topShareAEA"] for r in unresolved_records]),
            "unresolvedSecondShareAEAQuantiles": quantiles([r["secondShareAEA"] for r in unresolved_records]),
            "unresolvedUncoveredShareAEAQuantiles": quantiles([r["uncoveredShareAEA"] for r in unresolved_records]),
            "unresolvedTopShareAEAThresholdCounts": [{"minimumTopShareAEA": t, "families": sum(r["topShareAEA"] >= t for r in unresolved_records)} for t in thresholds],
            "rawLowShareOrNoOverlapFamiliesInActive": sum(r["rawComparison"]["rawTopSharePlanar"] < .999 for r in unresolved_records),
            "activeLowShareFamiliesBelowPoint999": sum(r["topShareAEA"] < .999 for r in unresolved_records)},
        "rawLowShareOrNoOverlapFamiliesNotPresentInActiveCHN": [{"sourceFeatureId": r["sourceFeatureId"], "sourceName": r["sourceName"], "rawTopSharePlanar": r["topShare"], "rawUncoveredSharePlanar": r["uncoveredShare"]} for r in no_longer_present],
        "lowShareOrChangedProvinceFamilies": sorted(low_or_changed, key=lambda r: (r["topShareAEA"], r["sourceFeatureId"])),
        "sourceFreeCells": residual_records, "families": records,
        "limitations": ["Even a dominant presentation overlap cannot change the official hierarchy.",
            "Current source-free cells cannot inherit a province from an adjacent family without their own coverage evidence.",
            "No renderProvinceId or macro-edge index is generated by this report.",
            "A future display policy must state uncovered and secondary shares and preserve uncertainty."]}
    artifact = immutable(output, report)
    print(json.dumps({"artifact": artifact, "summary": report["summary"],
        "lowShares": [{"id": r["sourceFeatureId"], "name": r["sourceName"], "activeTopAEA": r["topShareAEA"],
            "rawTopPlanar": r["rawComparison"]["rawTopSharePlanar"], "uncoveredAEA": r["uncoveredShareAEA"],
            "topName": r["positiveProvinceOverlaps"][0]["name"] if r["positiveProvinceOverlaps"] else None} for r in report["lowShareOrChangedProvinceFamilies"]],
        "sourceFree": [{"cellId": r["cellId"], "areaKm2AEA": r["activeFamilyAreaSquareMetersAEA"] / 1e6,
            "topShareAEA": r["topShareAEA"], "uncoveredShareAEA": r["uncoveredShareAEA"],
            "topName": r["positiveProvinceOverlaps"][0]["name"] if r["positiveProvinceOverlaps"] else None} for r in residual_records]}, ensure_ascii=True), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="reports/chn-province-20261030/newdata/active-family-overlap-analysis.json")
    analyze(parser.parse_args().output)
