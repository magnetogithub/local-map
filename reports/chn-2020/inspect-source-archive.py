import sys,json,collections
sys.path.insert(0,'.tmp/chn-python')
import shapefile
from pathlib import Path
r=shapefile.Reader('data/raw/chn-2020/references/ADM3-source/CHN_ADM3.shp',encoding='utf8')
raw=collections.Counter(x[0] for x in r.records())
f=json.loads(Path('data/raw/chn-2020/references/geoBoundaries-CHN-ADM3.geojson').read_text('utf8'))['features']
cur=collections.Counter(x['properties']['shapeName'] for x in f)
print(json.dumps({'rawMissingFromRelease':dict(raw-cur),'releaseNotInRaw':dict(cur-raw),'rawShapeTypes':dict(collections.Counter(s.shapeType for s in r.shapes()))},ensure_ascii=False))
