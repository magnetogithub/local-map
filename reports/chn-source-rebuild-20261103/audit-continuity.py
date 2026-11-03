"""Measure direction changes at the same degree-two provincial junctions."""
import json
import math
from collections import defaultdict
from pathlib import Path
import numpy as np
import pyproj

ROOT = Path(__file__).resolve().parents[2]
DIR = Path(__file__).resolve().parent
project = pyproj.Transformer.from_crs("OGC:CRS84", "EPSG:3857", always_xy=True)
package = json.loads((DIR / "package.json").read_bytes())
delivery = json.loads((ROOT / package["artifact"]["path"]).read_bytes())
producer = json.loads((ROOT / delivery["producer"]["path"]).read_bytes())
previous = json.loads((ROOT / "data/derived/chn-2020/internal-line-delivery-d652d5fd9ade1d4263f5/delivery.json").read_bytes())
previous_producer = json.loads((ROOT / previous["producer"]["path"]).read_bytes())
results = {}
for phase, identity in [("before", previous_producer["provinceGeometry"]), ("after", producer["provinceGeometry"])]:
    features = json.loads((ROOT / identity["path"]).read_bytes())["features"]
    nodes = defaultdict(list)
    for feature in features:
        a = feature["geometry"]["coordinates"]
        xy = np.column_stack(project.transform(*np.asarray(a).T))
        for at, other in [(0, 1), (-1, -2)]:
            vector = xy[other] - xy[at]
            norm = np.linalg.norm(vector)
            if norm > 0:
                nodes[tuple(a[at])].append((feature["id"], vector / norm))
    angles = []
    for ports in nodes.values():
        if len(ports) == 2 and ports[0][0] != ports[1][0]:
            angles.append(math.degrees(math.acos(float(np.clip(-np.dot(ports[0][1], ports[1][1]), -1, 1)))))
    results[phase] = {"degreeTwoJoins": len(angles), "medianDirectionChangeDegrees": float(np.median(angles)),
        "p90DirectionChangeDegrees": float(np.percentile(angles, 90)), "joinsOver30Degrees": sum(a > 30 for a in angles)}
(DIR / "junction-continuity.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
print(json.dumps(results))
