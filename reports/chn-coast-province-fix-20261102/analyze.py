import gzip, json
from pathlib import Path
from collections import Counter
import shapely, pyproj
from shapely.geometry import shape, Point

root = Path.cwd()
pointer = json.loads((root / 'data/runtime/operational-catalog/current.json').read_bytes())
base = root / pointer['root']
def read(name):
    data = (base / name).read_bytes()
    return json.loads(gzip.decompress(data) if name.endswith('.gz') else data)
detail = read('detail-index.json')
edges = [e for s in detail['edgeDetails'] for e in read(s['artifact']['path'])['edges']]
presentation = json.loads((root / 'data/derived/chn-2020/province-render-f1c91c059cdb06f5234f/index.json').read_bytes())
cells = {c['ordinal']: c for c in presentation['cells']}
province = set(presentation['addedBoundaryOrdinals'])
lines = [shape(e['geometry']) for e in edges]
project = pyproj.Transformer.from_crs('OGC:CRS84', 'EPSG:3857', always_xy=True)
coast_edges = [e for e in edges if e['boundaryClass'] == 'coast' and (e['left'] in cells or e['right'] in cells)]
coast = shapely.union_all([shape(e['geometry']) for e in coast_edges])
coast_projected = shapely.transform(coast, project.transform, interleaved=False)
degree = Counter(tuple(p) for e in edges if e['ordinal'] in province for p in (e['geometry']['coordinates'][0], e['geometry']['coordinates'][-1]))
tree = shapely.STRtree(lines)
terminals = []
for node, count in degree.items():
    if count != 1:
        continue
    point = Point(node)
    if not (114 <= node[0] <= 123 and 34 <= node[1] <= 43):
        continue
    incident = []
    for i in tree.query(point, predicate='intersects'):
        e = edges[int(i)]
        incident.append({'ordinal': e['ordinal'], 'class': e['boundaryClass'],
            'left': cells.get(e['left'], {'ordinal': e['left']}),
            'right': cells.get(e['right'], {'ordinal': e['right']})})
    terminals.append({'node': node, 'coastDistanceMercatorMeters': coast_projected.distance(Point(project.transform(*node))), 'incident': incident})
out = root / 'reports/chn-coast-province-fix-20261102/terminals.json'
out.write_text(json.dumps(terminals, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(terminals, ensure_ascii=False))
