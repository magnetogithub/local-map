"""Recompute the parcel comparison. Read-only with respect to application data."""
import base64
import gzip
import hashlib
import json
from pathlib import Path

from pyproj import Geod, Transformer
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import transform


ROOT = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent
GEOD = Geod(ellps="WGS84")


def read(relative):
    return json.loads((ROOT / relative).read_text(encoding="utf-8"))


def pin(path):
    data = path.read_bytes()
    return {
        "path": path.relative_to(ROOT).as_posix(),
        "sha256": hashlib.sha256(data).hexdigest(),
        "byteLength": len(data),
    }


def area(geometry):
    return abs(GEOD.geometry_area_perimeter(geometry)[0]) / 1e6


source_path = "data/raw/chn-2020/references/geoBoundaries-CHN-ADM3.geojson"
source = read(source_path)
feature = next(f for f in source["features"] if f["properties"]["shapeID"] == "62558664B17454932046206")
parts = list(shape(feature["geometry"]).geoms)
parcel, mainland = sorted(parts, key=lambda p: p.area)
projection = Transformer.from_crs(4326, 32650, always_xy=True).transform

comparisons = []
for relative in [
    "data/raw/chn-2020/references/geoBoundaries-CHN-ADM1.geojson",
    "data/raw/chn-2020/references/gb3-CHN-ADM1.geojson",
    "data/raw/ne_10m_admin_1_states_provinces.geojson",
]:
    assignments = []
    for candidate in read(relative)["features"]:
        boundary = shape(candidate["geometry"])
        if boundary.is_empty or not boundary.intersects(parcel):
            continue
        overlap = boundary.intersection(parcel)
        if overlap.area <= 1e-14:
            continue
        properties = candidate["properties"]
        assignments.append({
            "name": properties.get("shapeName", properties.get("name")),
            "shapeId": properties.get("shapeID", properties.get("adm1_code")),
            "intersectionKm2": area(overlap),
            "parcelCoverageFraction": area(overlap) / area(parcel),
        })
    comparisons.append({**pin(ROOT / relative), "assignments": assignments})

delivery_path = "data/derived/chn-2020/internal-line-delivery-cc56e4efba11544ae484/delivery.json"
delivery = read(delivery_path)
lines = json.loads(gzip.decompress(base64.b64decode(delivery["province"]["payloadBase64"])))
display_feature = next(f for f in lines["features"] if f["id"] == 7473)
display_polygon = Polygon(display_feature["geometry"]["coordinates"])
assert display_polygon.is_valid
assert parcel.is_valid

official = []
for year in [2022, 2024]:
    relative = ("2022/" if year == 2022 else "") + "bhxq.jpg"
    official.append({
        **pin(OUT / "references" / f"binhai-standard-{year}.jpg"),
        "year": year,
        "publisher": "Tianjin Planning and Natural Resources Bureau / Tianjin Surveying and Mapping Institute",
        "url": "https://tianjin.tianditu.gov.cn/static/html/img/big/" + relative,
        "observation": "The published Binhai map shows the mainland southern administrative boundary but no detached Tianjin polygon at the target location.",
    })

report = {
    "schemaVersion": "tianjin-detached-parcel-audit-v1",
    "auditDate": "2026-11-03",
    "scope": "Comparison only; no application geometry, assignment, source lock, or runtime pointer changed by this audit.",
    "target": {
        "sourceFeatureId": feature["properties"]["shapeID"],
        "sourceName": feature["properties"]["shapeName"],
        "sourcePin": pin(ROOT / source_path),
        "edgeOrdinal": 7473,
        "rawGeometry": mapping(parcel),
        "rawAreaKm2": area(parcel),
        "rawBounds": list(parcel.bounds),
        "rawCentroid": list(parcel.centroid.coords[0]),
        "distanceToSameSourceMainlandMetresUtm50N": transform(projection, parcel).distance(transform(projection, mainland)),
    },
    "display": {
        "deliveryPin": pin(ROOT / delivery_path),
        "feature": display_feature,
        "outlineEnclosedAreaKm2": area(display_polygon),
        "enclosedAreaRatioToRawParcel": area(display_polygon) / area(parcel),
        "finding": "The displayed closed outline shrank by about 89.45%; this is a separate generalization defect and is not evidence of administrative membership.",
    },
    "spatialComparisons": comparisons,
    "officialMapReferences": official,
    "officialReferencePortal": "https://tianjin.tianditu.gov.cn/static/html/bzmap.html",
    "official2022PublicationNotice": "https://www.tj.gov.cn/sy/tjxw/202208/t20220829_5970343.html",
    "approximateVisualRegistration": read((OUT / "visual-registration.json").relative_to(ROOT)),
    "findings": {
        "rawParcelExists": True,
        "createdByRecentSimplification": False,
        "officialDetachedTianjinTerritoryConfirmed": False,
        "sourceAssignmentConflict": True,
        "assessment": "The old ADM3/gb3 source assignment is inconsistent with the official 2022/2024 map depiction and the two other ADM1 datasets. Treat it as a suspected source-assignment error, not a verified Tianjin enclave.",
        "limits": [
            "ADM1 generalization can omit small enclaves, so two ADM1 datasets alone do not establish ground truth.",
            "The official maps are published cartographic references, not parcel-level cadastral polygons.",
            "Official 2022/2024 map depiction does not by itself establish the exact administrative situation on the scenario date 2020-01-01.",
            "No coordinate-specific official document has been found confirming this 1.96 km2 parcel as Tianjin territory or documenting a transfer. Do not claim a proven transfer or a fictitious physical settlement.",
            "The red locator on official-comparison.png is approximate visual registration, not official boundary data.",
        ],
    },
}
(OUT / "comparison-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(json.dumps({
    "report": (OUT / "comparison-report.json").relative_to(ROOT).as_posix(),
    "rawAreaKm2": area(parcel),
    "displayAreaKm2": area(display_polygon),
    "displayAreaRatio": area(display_polygon) / area(parcel),
    "sourceAssignmentConflict": True,
    "runtimeChanged": False,
}, indent=2))
