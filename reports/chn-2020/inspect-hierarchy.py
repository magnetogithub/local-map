import sys,json,time
sys.path.insert(0,'.tmp/chn-python')
from shapely.geometry import shape
from shapely import make_valid
from shapely.strtree import STRtree
from pyproj import Geod
from pathlib import Path
root=Path('data/raw/chn-2020/references')
features=json.loads((root/'geoBoundaries-CHN-ADM3.geojson').read_text('utf8'))['features']
parentfeatures=json.loads((root/'gb3-CHN-ADM1.geojson').read_text('utf8'))['features']
parents=[make_valid(shape(f['geometry'])) for f in parentfeatures]
tree=STRtree(parents)
geod=Geod(ellps='WGS84')
result=[]
for n,f in enumerate(features):
 g=shape(f['geometry']); candidates=tree.query(g)
 contained=[int(i) for i in candidates if parents[i].covers(g)]
 nearcontained=[]
 if not contained:
  for i in candidates:
   residual=g.difference(parents[i]); area=abs(geod.geometry_area_perimeter(residual)[0])/1e6
   if area<1: nearcontained.append({'index':int(i),'outsideKm2':area,'outsideFraction':residual.area/g.area})
 result.append({'shapeID':f['properties']['shapeID'],'name':f['properties']['shapeName'],'covers':contained,'near':nearcontained})
 if n%500==0:print(n,flush=True)
summary={'total':len(result),'fullyContainedExactly':sum(len(x['covers'])==1 for x in result),'multiple':sum(len(x['covers'])>1 for x in result),'notContained':sum(not x['covers'] for x in result),'uniqueWithin1km2':sum(not x['covers'] and len(x['near'])==1 for x in result),'parents':[f['properties'] for f in parentfeatures],'rows':result}
Path('reports/chn-2020/historical-adm1-containment.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),'utf8')
print(json.dumps({k:v for k,v in summary.items() if k not in ['parents','rows']},ensure_ascii=False))
