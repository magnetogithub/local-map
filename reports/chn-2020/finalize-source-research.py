import collections
import hashlib
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, '.tmp/chn-python')
import numpy as np
from pyproj import Geod
from shapely import get_coordinates, make_valid, points, distance
from shapely.geometry import shape
from shapely.strtree import STRtree

ROOT = Path('data/raw/chn-2020/references')
REVISION = '9469f09592ced973a3448cf66b6100b741b64c0d'

def pin(path):
    path = Path(path)
    data = path.read_bytes()
    return {'path': path.as_posix(), 'sha256': hashlib.sha256(data).hexdigest(), 'byteLength': len(data)}

def load(name):
    return json.loads((ROOT/name).read_text('utf8'))

fine = load('geoBoundaries-CHN-ADM3.geojson')['features']
parent_features = load('gb3-CHN-ADM1.geojson')['features']
parents = [make_valid(shape(f['geometry'])) for f in parent_features]
tree = STRtree(parents)
geod = Geod(ellps='WGS84')
macro_groups = [{'macroId': 'macro:CHN:'+f['properties']['shapeISO'],
                 'sourceFeatureId': f['properties']['shapeID'],
                 'sourceISO': f['properties']['shapeISO'],
                 'name': f['properties']['shapeName'],
                 'nameKo': None,
                 'sourceVersion': 'geoBoundaries-3_0_0/CHN/ADM1'} for f in parent_features]
assignments, unresolved, exceptions = [], [], []
for i, feature in enumerate(fine):
    g = shape(feature['geometry'])
    candidates = tree.query(g)
    exact = [int(j) for j in candidates if parents[j].covers(g)]
    row = {'sourceFeatureId': feature['properties']['shapeID'], 'sourceName': feature['properties']['shapeName']}
    if len(exact) == 1:
        parent = exact[0]
        assignments.append({**row, 'macroId': macro_groups[parent]['macroId'], 'method': 'unique-exact-polygon-containment',
                            'evidence': {'parentSourceFeatureId': macro_groups[parent]['sourceFeatureId'],
                                         'outsideParentAreaDegrees2': 0, 'wholeGeometryCovered': True}})
        continue
    numeric = []
    for j in candidates:
        residual = g.difference(parents[j])
        # The only tolerated exception is individually measured floating precision.
        # Neither the 1 km2 research diagnostic nor largest overlap assigns parents.
        if residual.area > 1e-12:
            continue
        coords = get_coordinates(residual)
        maximum = float(np.max(distance(points(coords), parents[j]))) if len(coords) else 0
        if maximum > 1e-10:
            continue
        numeric.append((int(j), residual, coords, maximum))
    if len(numeric) == 1:
        parent, residual, coords, maximum = numeric[0]
        exception = {**row, 'parentSourceFeatureId': macro_groups[parent]['sourceFeatureId'],
                     'outsideParentAreaDegrees2': residual.area,
                     'outsideParentAreaKm2': abs(geod.geometry_area_perimeter(residual)[0])/1e6,
                     'maxOutsideVertexDistanceDegrees': maximum,
                     'maxOutsideVertexDistanceMetersUpperBound': maximum*111320,
                     'outsideGeometrySha256WKB': hashlib.sha256(residual.wkb).hexdigest(),
                     'outsideCoordinateCount': len(coords), 'outsideCoordinates': coords.tolist(),
                     'areaAcceptanceBoundDegrees2': 1e-12, 'distanceAcceptanceBoundDegrees': 1e-10,
                     'reason': 'Individually measured machine-scale coordinate arithmetic residual against the same OSM/Wambacher 2017 source family; no parent inferred by area majority or centroid.'}
        exceptions.append(exception)
        assignments.append({**row, 'macroId': macro_groups[parent]['macroId'], 'method': 'unique-containment-with-individual-floating-residual',
                            'evidence': {k:v for k,v in exception.items() if k not in ['sourceFeatureId','sourceName','outsideCoordinates']}})
    else:
        unresolved.append({**row, 'macroId': None, 'sourceParentId': None,
                           'fallbackKind': 'country-envelope-residual',
                           'administrativeTruthClaim': False,
                           'reason': 'No unique exact parent, and no unique individually bounded floating precision exception. No centroid, nearest parent, or largest-overlap administrative assignment.'})

metrics = []
for feature in fine:
    g = shape(feature['geometry'])
    a = abs(geod.geometry_area_perimeter(g)[0])/1e6
    box = g.bounds
    diameter = max(geod.inv(box[0],box[1],box[2],box[3])[2],geod.inv(box[0],box[3],box[2],box[1])[2])/1000
    metrics.append((a, diameter))
def distribution(index):
    a=sorted(x[index] for x in metrics)
    return {'min': a[0], 'p10': float(np.percentile(a,10)), 'p50': float(np.percentile(a,50)),
            'p90': float(np.percentile(a,90)), 'p99': float(np.percentile(a,99)), 'max': a[-1]}

Path('data/source-locks/chn-2020').mkdir(parents=True,exist_ok=True)
exception_path = Path('reports/chn-2020/hierarchy-floating-exceptions.json')
exception_path.write_text(json.dumps({'schemaVersion':'chn-hierarchy-floating-exceptions-v1','exceptions':exceptions},ensure_ascii=False,indent=2)+'\n','utf8')
hierarchy = {'schemaVersion':'chn-2020-source-hierarchy-v1','countryId':'CHN','scenarioDate':'2020-01-01',
    'administrativeFactsAsOf2020Certified':False,
    'sourceFine':pin(ROOT/'geoBoundaries-CHN-ADM3.geojson'),
    'sourceAdmin1':{'artifact':pin(ROOT/'gb3-CHN-ADM1.geojson'),'metadata':pin(ROOT/'gb3-ADM1-metadata.json'),
                    'sourceId':'geoBoundaries-3_0_0-CHN-ADM1','representedYear':2017,
                    'publisher':'geoBoundaries; OpenStreetMap / Wambacher','license':'ODbL-1.0',
                    'url':'https://www.geoboundaries.org/data/geoBoundaries-3_0_0/CHN/ADM1/geoBoundaries-3_0_0-CHN-ADM1.geojson'},
    'macroGroups':macro_groups,'assignments':assignments,'unresolved':unresolved,
    'floatingPrecisionExceptions':pin(exception_path),
    'summary':{'sourceFineFeatures':len(fine),'sourceMacroFeatures':len(macro_groups),
               'exactContained':sum(x['method']=='unique-exact-polygon-containment' for x in assignments),
               'individualFloatingExceptions':len(exceptions),'assigned':len(assignments),'unresolved':len(unresolved)},
    'policy':'Only same-original-source whole polygon containment is used. Unknown parents retain the existing supported country-envelope-residual contract. Native shapeID is a distributor ID, not an official code. Source hierarchy is experimental and does not certify 2020 legal boundaries.'}
hierarchy_path = Path('data/source-locks/chn-2020/CHN-hierarchy.json')
hierarchy_path.write_text(json.dumps(hierarchy,ensure_ascii=False,indent=2)+'\n','utf8')
decision = {'schemaVersion':'chn-2020-source-decision-v1','decisionDate':'2026-10-30','countryId':'CHN','scenarioDate':'2020-01-01',
    'decision':'adopt-fixed-gbOpen-ADM3-for-experimental-scenario','sourceAcquisitionCompletedBeforeGeneratorChanges':True,
    'selected':{'publisher':'geoBoundaries / William & Mary geoLab; original OpenStreetMap, Lee Beryman / Wambacher',
       'sourceId':'geoboundaries-gbOpen-CHN-ADM3-62558664','revision':REVISION,
       'sourceUrl':f'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/{REVISION}/releaseData/gbOpen/CHN/ADM3/geoBoundaries-CHN-ADM3.geojson',
       'originalDistributorUrl':'https://wambachers-osm.website/boundaries/',
       'apiMetadataUrl':'https://www.geoboundaries.org/api/current/gbOpen/CHN/ADM3/',
       'artifact':pin(ROOT/'geoBoundaries-CHN-ADM3.geojson'),'originalArchive':pin(ROOT/'CHN_ADM3-source.zip'),
       'metadata':pin(ROOT/'ADM3-metadata.json'),'originalMetadata':pin(ROOT/'ADM3-source/meta.txt'),
       'originalProcessHistory':pin(ROOT/'ADM3-source/CHN_ADM3.shp.xml'),
       'reportedRepresentedYear':2017,'reportedBuildDate':'2023-12-12',
       'observedProcessDates':['2017-10-20','2021-08-03','2021-08-04','2021-08-11'],
       'scenarioDateExactMatch':False,'temporalLimitation':'The original metadata claims 2017, but original shapefile XML records append/dissolve processing in August 2021. The fixed file is mixed or uncertified vintage. It is used as an experimental county geometry reference for the 2020-01-01 game scenario, not certified 2020 or untouched 2017 administrative truth. No unverified change is backdated.',
       'administrativeLevel':'ADM3; canonical County, City','featureCountActual':len(fine),'featureCountApi':2867,
       'originalShapefileRecordCount':2867,'recordDifference':'Published GeoJSON omits Bayuquan District, Lanzhou New Area and Qingshuihe County from the source archive; source names Zhijiang City and Jiangshan City have leading whitespace normalized. No missing feature is fabricated.',
       'stableIdPolicy':'Preserve published shapeID and fixed revision. Original archive has NAME/Level/Shape_Leng/Shape_Area only, no OSM relation ID, official administrative code or parent code. shapeID is explicitly a distributor identifier.',
       'crs':'OGC CRS84 / WGS84 longitude,latitude degrees','axisOrder':'longitude,latitude','coordinateTransformationAtAcquisition':'none',
       'areaKm2Geodesic':distribution(0),'boundingBoxDiagonalKmGeodesic':distribution(1),
       'diameterMethod':'Maximum geodesic distance of the two axis-aligned geographic bounding-box diagonals; diagnostic extent proxy, not exact geodesic polygon diameter.',
       'license':{'id':'ODbL-1.0','redistributionAllowed':True,'url':'https://opendatacommons.org/licenses/odbl/1-0/',
                  'attribution':'© OpenStreetMap contributors; geoBoundaries / William & Mary geoLab; Lee Beryman / Wambacher. Contains information available under ODbL 1.0.',
                  'conditions':'Retain notices and attribution; include ODbL URI; distribute publicly used derivative database under ODbL and offer machine-readable derivative data or alterations. Local internal use is allowed. This does not license program code.',
                  'evidence':[pin(ROOT/'ADM3-source/license.PNG'),pin(ROOT/'OSM-copyright.html'),pin(ROOT/'ODbL-1.0.html')]},
       'adoptionReason':'Actual whole-country county polygons, clear source-archive ODbL license and fixed revision; actual current partition has better validity/overlap/coverage than the available 2020-published historical OSM edition. County polygons are used rather than relabelled provinces or synthetic nationwide subdivision. Large western counties and tiny city districts remain granularity risks to check against unchanged gameplay limits.'},
    'hierarchy':pin(hierarchy_path),'hierarchySummary':hierarchy['summary'],
    'alternatives':[
       {'name':'Official NGCC 2019 DLG','url':'https://search.ngcc.cn/xwzx/bnyw/202401/t20240110_2036.html','evidence':pin(ROOT/'NGCC-2019-announcement.html'),
        'observed':'Official announcement dated 2019-07-23; 1:50,000 data current to 2018; 1:250,000 and 1:1,000,000 current to 2017; CGCS2000. Provided/used under surveying-results management provisions; free for government decision, national defence and public services.',
        'decision':'not-adopted','reason':'No confirmed general redistribution grant or directly acquired redistributable county polygon snapshot; public availability is not a redistribution license.'},
       {'name':'National Bureau of Statistics hierarchy/2019 and 2020 statistical codes','url':'https://www.stats.gov.cn/hd/lyzx/zxgk/202104/t20210401_1815920.html',
        'rulesUrl':'https://www.stats.gov.cn/zt_18555/zdtjgz/zgjjpc/dycjjpc/pcfa/202303/t20230306_1935317.htm',
        'observed':'Official reply identifies 2020 statistical codes as of 2020-06-30 and based on county-and-above administrative codes. Official coding rules distinguish province, prefecture, county and lower statistical units.',
        'decision':'reference-only','reason':'A hierarchy/code table is not a polygon source; post-January-2020 table cannot silently certify January boundaries. No code-to-English-distributor-ID crosswalk was fabricated.'},
       {'name':'geoBoundaries 3.0.0 CHN ADM3/ADM2/ADM1','url':'https://www.geoboundaries.org/data/geoBoundaries-3_0_0/CHN/ADM3/',
        'artifacts':[pin(ROOT/('gb3-CHN-'+a+'.geojson')) for a in ['ADM1','ADM2','ADM3']],
        'actualFeatureCounts':{'ADM1':31,'ADM2':340,'ADM3':2852},'reportedRepresentedYear':2017,'updateDate':'2020-05-25','license':'ODbL-1.0',
        'decision':'ADM3-not-adopted; ADM1-retained-as-exact-containment-evidence-only',
        'reason':'Publication in May 2020 does not mean January-2020 boundaries. Actual historical ADM3 has material overlap and larger omissions versus active CHN territory, measured in historical-source-metrics.json. Historical ADM1 is the compatible original OSM/Wambacher 2017 source family; only exact whole containment or individually bounded machine-scale remnants support parents.',
        'actualCandidateMetrics':pin('reports/chn-2020/historical-source-metrics.json')},
       {'name':'geoBoundaries fixed current CHN ADM2','artifact':pin(ROOT/'geoBoundaries-CHN-ADM2.geojson'),'featureCountActual':2391,
        'url':f'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/{REVISION}/releaseData/gbOpen/CHN/ADM2/geoBoundaries-CHN-ADM2.geojson',
        'decision':'not-adopted','reason':'Older 2,391 county features versus ADM3 2,864. Metadata PDDL proof references a 2014 prefecture/province post, while actual county source points to a different 2017 post; licensing provenance and missing detail are weaker.'},
       {'name':'geoBoundaries current CHN ADM1','artifact':pin(ROOT/'geoBoundaries-CHN-ADM1.geojson'),'featureCountActual':34,
        'decision':'not-used-as-parent-source','reason':'2019 Wikimedia-derived boundaries differ from OSM county original source and include Taiwan/Hong Kong/Macao; cannot infer official parents by largest overlap or enlarge CHN ownership.'},
       {'name':'OCHA HDX China COD-AB 2020','url':'https://data.humdata.org/dataset/cod-ab-chn','decision':'not-adopted',
        'reason':'Primary dataset access returned HTTP 403 during research. Metadata-only summaries indicate coarse ADM2 prefecture-scale units, not the county precision sought; actual source file not acquired, so no polygon/ID/license claim is made from the inaccessible file.'}],
    'scopePolicy':'Clip only to currently active CHN game territory, preserve all non-CHN territory and existing KOR/PRK fine IDs/geometry/admin lineage. Hong Kong/Macao/Taiwan and disputed source areas are not acquired because a source labels them CHN.',
    'acquisitionDate':'2026-10-30','sourceNotes':'No API-provided count or represented year overrides actual bytes, record count, embedded process history or checked license. Original files are retained unmodified.'}
Path('reports/chn-2020/source-decision.json').write_text(json.dumps(decision,ensure_ascii=False,indent=2)+'\n','utf8')
print(json.dumps({'hierarchy':hierarchy['summary'],'selected':decision['selected']['artifact'],'distribution':decision['selected']['areaKm2Geodesic']},ensure_ascii=False),flush=True)
