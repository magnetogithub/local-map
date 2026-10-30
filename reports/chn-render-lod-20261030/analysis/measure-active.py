"""Read-only measurement of pinned CHN render edges and coverage suitability."""
import gzip
import hashlib
import json
import math
from pathlib import Path

import numpy as np
import pyproj
import shapely
from shapely.geometry import shape, mapping

ROOT = Path(__file__).resolve().parents[3]
HERE = "reports/chn-render-lod-20261030/analysis"

def read(file):
    return json.loads((ROOT / file).read_bytes())

def pin(file):
    data = (ROOT / file).read_bytes()
    return {"path": file, "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data)}

def checked(a):
    b = (ROOT / a["path"]).read_bytes()
    if len(b) != a["byteLength"] or hashlib.sha256(b).hexdigest() != a["sha256"]:
        raise ValueError("PIN_CHANGED:" + a["path"])
    return b

def quantiles(values):
    a = np.asarray(values, dtype=float)
    return {name: float(np.quantile(a, q)) if len(a) else None for name, q in
        [("min", 0), ("p10", .1), ("p25", .25), ("p50", .5), ("p75", .75), ("p90", .9), ("p99", .99), ("max", 1)]}

pointer_pin = pin("data/runtime/operational-catalog/current.json")
pointer = read(pointer_pin["path"])
index_pin = {"path": pointer["root"] + "/artifact-index.json", **pointer["index"]}
index = json.loads(checked(index_pin))
artifacts = {a["path"]: a for a in index["artifacts"]}
def artifact(file):
    return {**artifacts[file], "path": pointer["root"] + "/" + file}

provenance_pin = artifact("provenance.json")
provenance = json.loads(checked(provenance_pin))
decision_pin = provenance["incremental"]["sourceDecision"]
decision = json.loads(checked(decision_pin))
checked(decision["selected"]["artifact"])
geometry_pin = provenance["incremental"]["geometry"]
metadata_pin = artifact("metadata/countries/CHN.json.gz")
metadata = json.loads(gzip.decompress(checked(metadata_pin)))
incidence_pin = artifact("metadata/edge-incidence.bin.gz")
incidence = np.frombuffer(gzip.decompress(checked(incidence_pin)), dtype="<u4").reshape((-1, 2))
render_pin = pin("data/derived/chn-2020/province-render-f1c91c059cdb06f5234f/index.json")
render = json.loads(checked(render_pin))
macro_ordinals = set(render["addedBoundaryOrdinals"])
chn_ordinals = set(row[0] for row in metadata["rows"])
internal_ordinals = {n + 1 for n, (a, b) in enumerate(incidence) if int(a) in chn_ordinals and int(b) in chn_ordinals}
if len(macro_ordinals) != 994 or len(internal_ordinals) != 8562 or not macro_ordinals <= internal_ordinals:
    raise ValueError("UNEXPECTED_PINNED_CHN_EDGE_SCOPE")
inputs = [pointer_pin, index_pin, provenance_pin, decision_pin, decision["selected"]["artifact"],
          geometry_pin, metadata_pin, incidence_pin, render_pin]
transformer = pyproj.Transformer.from_crs("OGC:CRS84", "EPSG:3857", always_xy=True)
edge_rows, all_lengths, macro_lengths = [], [], []
detail_pin = artifact("detail-index.json")
detail = json.loads(checked(detail_pin))
inputs.append(detail_pin)
province_names = {p["id"]: p["name"] for p in render["provinces"]}
province_by_cell = {c["ordinal"]: c["renderProvinceId"] for c in render["cells"]}
for shard in detail["edgeDetails"]:
    a = artifact(shard["artifact"]["path"])
    inputs.append(a)
    data = json.loads(gzip.decompress(checked(a)))
    for edge in data["edges"]:
        n = edge["ordinal"]
        if n not in internal_ordinals:
            continue
        if tuple(int(x) for x in incidence[n - 1]) != (edge["left"], edge["right"]):
            raise ValueError("EDGE_INCIDENCE_MISMATCH")
        parts = [edge["geometry"]["coordinates"]] if edge["geometry"]["type"] == "LineString" else edge["geometry"]["coordinates"]
        vertices, sharp, zigzag = 0, 0, 0
        sample, sample_score = None, -1
        for coords in parts:
            raw = np.asarray(coords, dtype=float)
            xy = np.column_stack(transformer.transform(raw[:, 0], raw[:, 1]))
            segments = np.diff(xy, axis=0)
            length = np.hypot(segments[:, 0], segments[:, 1])
            all_lengths.append(length)
            if n in macro_ordinals:
                macro_lengths.append(length)
            vertices += len(coords)
            if len(segments) < 2:
                continue
            u, v = segments[:-1], segments[1:]
            turns = np.arctan2(u[:, 0] * v[:, 1] - u[:, 1] * v[:, 0], (u * v).sum(axis=1))
            short_sharp = (np.abs(turns) >= math.pi / 3) & (np.maximum(length[:-1], length[1:]) <= 250)
            sharp += int(short_sharp.sum())
            if len(turns) < 2:
                continue
            alternating = (turns[:-1] * turns[1:] < 0) & (np.abs(turns[:-1]) >= math.pi / 6) & (np.abs(turns[1:]) >= math.pi / 6)
            alternating &= np.maximum.reduce([length[:-2], length[1:-1], length[2:]]) <= 250
            zigzag += int(alternating.sum())
            if alternating.any():
                k = int(np.flatnonzero(alternating)[0])
                if int(alternating.sum()) > sample_score:
                    sample_score = int(alternating.sum())
                    sample = {"coordinates": coords[max(0, k - 2):min(len(coords), k + 6)],
                        "firstAlternatingTurnsDegrees": [float(math.degrees(turns[k])), float(math.degrees(turns[k + 1]))],
                        "threeSegmentLengthsMercatorMeters": [float(x) for x in length[k:k + 3]]}
        bounds = shape(edge["geometry"]).bounds
        row = {"ordinal": n, "id": edge["id"], "macro": n in macro_ordinals, "vertices": vertices,
            "lengthKmCatalog": edge["lengthKm"], "verticesPerCatalogKm": vertices / edge["lengthKm"],
            "shortSharpTurns": sharp, "shortAlternatingZigzags": zigzag, "bounds": list(bounds),
            "provinceNames": [province_names.get(province_by_cell.get(side)) for side in [edge["left"], edge["right"]]],
            "sample": sample}
        edge_rows.append(row)

def edge_summary(rows, lengths):
    a = np.concatenate(lengths)
    return {"edges": len(rows), "serializedVertices": sum(r["vertices"] for r in rows),
        "verticesPerEdge": quantiles([r["vertices"] for r in rows]), "segmentLengthsMercatorMeters": quantiles(a),
        "segmentCountsBelowMercatorMeters": [{"meters": m, "segments": int((a < m).sum()), "fraction": float((a < m).mean())} for m in [1, 10, 50, 100, 250, 500, 1000]],
        "shortSharpTurns": sum(r["shortSharpTurns"] for r in rows), "shortAlternatingZigzags": sum(r["shortAlternatingZigzags"] for r in rows),
        "totalCatalogLengthKm": sum(r["lengthKmCatalog"] for r in rows)}

print("edge measurement complete", len(edge_rows), flush=True)
partition = json.loads(checked(geometry_pin))
features = partition["cells"]
if set(f["id"] for f in features) != set(row[1] for row in metadata["rows"]):
    raise ValueError("ACTIVE_CELL_SET_MISMATCH")
geometries = np.asarray([shape(f["geometry"]) for f in features], dtype=object)
cell_ids = [f["id"] for f in features]
del partition, features
def coverage_record(geoms):
    valid = bool(shapely.coverage_is_valid(geoms))
    invalid = shapely.coverage_invalid_edges(geoms) if not valid else []
    invalid_indexes = [i for i, g in enumerate(invalid) if not g.is_empty]
    return {"coverageIsValidGapWidthZero": valid, "invalidIndividualPolygons": int((~shapely.is_valid(geoms)).sum()),
        "coordinateCount": int(shapely.count_coordinates(geoms)), "invalidEdgeCells": len(invalid_indexes),
        "invalidEdgeSamples": [{"cellId": cell_ids[i], "coordinateCount": int(shapely.count_coordinates(invalid[i])),
            "bounds": list(invalid[i].bounds), "geometry": mapping(invalid[i])} for i in invalid_indexes[:8]]}

print("native coverage check", flush=True)
native = coverage_record(geometries)
print("native coverage", native["coverageIsValidGapWidthZero"], native["invalidEdgeCells"], flush=True)
mercator = shapely.transform(geometries, transformer.transform, interleaved=False)
print("Mercator coverage check", flush=True)
projected = coverage_record(mercator)
print("Mercator coverage", projected["coverageIsValidGapWidthZero"], projected["invalidEdgeCells"], flush=True)
for a in inputs:
    checked(a)
code = pin(HERE + "/measure-active.py")
report = {"schemaVersion": "chn-render-lod-active-measurement-v1", "catalogVersion": pointer["catalogVersion"],
    "inputs": inputs, "code": code, "runtime": {"shapely": shapely.__version__, "GEOS": shapely.geos_version_string, "pyproj": pyproj.__version__},
    "scope": "Measurement only; no source, game cell, authoritative edge, catalog, runtime, Korean or DPRK geometry is changed.",
    "sourceBasis": {"decision": decision["decision"], "revision": decision["selected"]["revision"], "crs": decision["selected"]["crs"],
        "axisOrder": decision["selected"]["axisOrder"], "license": decision["selected"]["license"]["id"], "temporalLimitation": decision["selected"]["temporalLimitation"]},
    "edgeMetric": "Current accepted delivered exact edge coordinates. Project CRS84 longitude/latitude to EPSG:3857 with always_xy. Short-sharp means adjacent projected segments<=250m and turn>=60deg; alternating zigzag means two opposite turns each>=30deg and all three projected segments<=250m. This detects subpixel line complexity, not erroneous geography.",
    "macro": edge_summary([r for r in edge_rows if r["macro"]], macro_lengths),
    "allInternal": edge_summary(edge_rows, all_lengths),
    "macroSamplesByZigzagCount": sorted([r for r in edge_rows if r["macro"]], key=lambda r: (-r["shortAlternatingZigzags"], r["ordinal"]))[:15],
    "macroSamplesByVertexCount": sorted([r for r in edge_rows if r["macro"]], key=lambda r: (-r["vertices"], r["ordinal"]))[:10],
    "coverage": {"cells": len(geometries), "nativeCRS84": native, "projectedEPSG3857": projected,
        "meaning": "coverage_is_valid checks non-overlap and exactly edge-matched polygon coverage. gap_width=0 alone does not certify national coverage or hole preservation; those remain prior independent proof plus later render candidate checks.",
        "coverageSimplifyAvailable": hasattr(shapely, "coverage_simplify"),
        "simplificationSafety": "Do not use coverage_simplify on invalid coverage; its documented validity preservation assumes valid input. simplify_boundary=False preserves outer country/coast boundaries in the input coordinate space. VW tolerance approximates square root triangle area and is not a Hausdorff/pixel displacement bound."},
    "screenTolerance": {"projection": "EPSG:3857", "tileSizeCSSPixels": 512, "worldCircumferenceMeters": 2 * math.pi * 6378137,
        "formula": "Mercator meters per CSS pixel = 2*pi*6378137/(512*2^zoom); ground meters approx times cos(latitude). CSS pixels independent of devicePixelRatio.",
        "levels": [{"zoom": z, "mercatorMetersPerCSSPixel": 2 * math.pi * 6378137 / (512 * 2 ** z),
                    "quarterPixelMeters": 2 * math.pi * 6378137 / (512 * 2 ** z) * .25,
                    "halfPixelMeters": 2 * math.pi * 6378137 / (512 * 2 ** z) * .5} for z in [2.2, 3, 4, 5, 6, 7, 8]]},
    "edges": edge_rows}
out = ROOT / HERE / "active-edge-and-coverage.json"
data = (json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()
if out.exists() and out.read_bytes() != data:
    raise ValueError("IMMUTABLE_ANALYSIS_CHANGED")
out.parent.mkdir(parents=True, exist_ok=True)
if not out.exists():
    out.write_bytes(data)
print(json.dumps({"artifact": pin(HERE + "/active-edge-and-coverage.json"), "macro": report["macro"], "allInternal": report["allInternal"],
    "coverage": {"native": {k: v for k, v in native.items() if k != "invalidEdgeSamples"}, "mercator": {k: v for k, v in projected.items() if k != "invalidEdgeSamples"}}}, ensure_ascii=True), flush=True)
