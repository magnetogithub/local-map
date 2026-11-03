"""Independently verify a source-backed display correction and coastal endpoints."""
import argparse, copy, gzip, hashlib, json
from collections import Counter
from pathlib import Path
import shapely
from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parents[2]
def pin(file):
    b = (ROOT / file).read_bytes()
    return {'path': file, 'sha256': hashlib.sha256(b).hexdigest(), 'byteLength': len(b)}
def checked(p):
    assert pin(p['path']) == p, 'INPUT_PIN_CHANGED:' + p['path']
    return (ROOT / p['path']).read_bytes()
def read(p):
    return json.loads(checked(p))

def verify(value):
    baseline = read(value['displayRepair']['baseline'])
    old = read(baseline['acceptedPresentation'])
    old_proof = read(baseline['independentVerification'])
    assert old_proof['pass'] is True and old_proof['artifact'] == baseline['acceptedPresentation']
    reference = read(value['displayRepair']['reference'])
    source_id, province_id = reference['sourceFeatureId'], reference['renderProvinceId']
    assert source_id == '62558664B17454932046206' and province_id == 'macro:CHN:CN-12'
    assert reference['reference']['url'] == 'https://www.stats.gov.cn/fw/bgthyb/202302/t20230215_1904787.html'
    for p in value['inputs'].values(): checked(p)
    for p in value['code']: checked(p)
    assert value['catalogRef'] == old['catalogRef']
    assert value['provinces'] == old['provinces']
    assert value['administrativeTruthClaim'] is False
    pointer = read(value['inputs']['pointer'])
    assert read(pin('data/runtime/operational-catalog/current.json')) == pointer
    # Recompute containment from actual pinned polygons, rather than trusting
    # the old producer's coverage claim or a nearest-centroid/name match.
    raw = read(value['inputs']['fineSource'])
    feature = next(f for f in raw['features'] if f['properties']['shapeID'] == source_id)
    assert feature['properties']['shapeName'] == reference['sourceName'] == 'Binhai New Area'
    polygon = shape(feature['geometry'])
    provinces = read(value['inputs']['provinceSource'])['features']
    overlaps = sorted([(polygon.intersection(shape(f['geometry'])).area / polygon.area, f['properties']['shapeISO']) for f in provinces], reverse=True)
    assert overlaps[0][1] == 'CN-12' and overlaps[0][0] > .999999
    assert overlaps[1][0] < .000001
    assert len(value['cells']) == len(old['cells'])
    changed = []
    for before, after in zip(old['cells'], value['cells']):
        expected = dict(before)
        if before['sourceFeatureId'] == source_id:
            assert before['renderProvinceId'] is None
            expected['renderProvinceId'] = province_id
            changed.append(after['ordinal'])
        assert after == expected, 'UNRELATED_CELL_CHANGED'
    assert changed == [254, 6150]
    assert len(old['families']) == len(value['families'])
    for before, after in zip(old['families'], value['families']):
        if before['sourceFeatureId'] != source_id:
            assert before == after, 'UNRELATED_FAMILY_CHANGED'
        else:
            assert after['renderProvinceId'] == province_id and after['method'] == 'source-hierarchy-display-repair'
            expected = dict(after)
            expected.pop('displayRepair')
            expected['method'], expected['renderProvinceId'] = before['method'], before['renderProvinceId']
            assert expected == before
    base = ROOT / pointer['root']
    index = read({'path': pointer['root'] + '/artifact-index.json', **pointer['index']})
    artifacts = {a['path']: a for a in index['artifacts']}
    def asset(name):
        b = checked({**artifacts[name], 'path': pointer['root'] + '/' + name})
        return json.loads(gzip.decompress(b) if name.endswith('.gz') else b)
    detail = asset('detail-index.json')
    edges = [e for s in detail['edgeDetails'] for e in asset(s['artifact']['path'])['edges']]
    cells = {c['ordinal']: c for c in value['cells']}
    expected = [e['ordinal'] for e in edges if e['left'] in cells and e['right'] in cells
        and cells[e['left']]['renderProvinceId'] is not None and cells[e['right']]['renderProvinceId'] is not None
        and cells[e['left']]['renderProvinceId'] != cells[e['right']]['renderProvinceId']]
    expected.sort()
    assert value['addedBoundaryOrdinals'] == expected, 'MISSING_OR_FOREIGN_PROVINCE_EDGE'
    added = sorted(set(expected) - set(old['addedBoundaryOrdinals']))
    assert added == [3549, 4050, 6750, 7473, 9565]
    assert set(old['addedBoundaryOrdinals']) <= set(expected)
    # Every affected Tianjin/Hebei boundary must end at another provincial
    # boundary or the exact existing coast, not stop inside Binhai.
    coast = shapely.union_all([shape(e['geometry']) for e in edges if e['boundaryClass'] == 'coast' and (e['left'] in cells or e['right'] in cells)])
    region = (116.8, 38.3, 118.1, 39.6)
    def dangling(ids):
        degree = Counter(tuple(p) for e in edges if e['ordinal'] in ids for p in (e['geometry']['coordinates'][0], e['geometry']['coordinates'][-1]))
        return [node for node, n in degree.items() if n == 1 and region[0] < node[0] < region[2] and region[1] < node[1] < region[3] and not coast.intersects(Point(node))]
    before, after = dangling(set(old['addedBoundaryOrdinals'])), dangling(set(expected))
    assert len(before) == 4, 'NEGATIVE_BASELINE_NO_LONGER_REPRODUCES_GAP'
    assert not after, 'INTERIOR_PROVINCE_DANGLING_ENDPOINT'
    return {'rawTopProvinceShare': overlaps[0][0], 'rawSecondProvinceShare': overlaps[1][0],
        'changedCells': changed, 'promotedEdges': added, 'provinceEdges': len(expected),
        'interiorDanglingEndpointsBefore': before, 'interiorDanglingEndpointsAfter': after,
        'existingProvinceEdgesPreserved': True, 'unrelatedFamiliesAndCellsUnchanged': True}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    value = read(pin(args.artifact))
    checks = verify(value)
    controls = {}
    for name, mutate in [('omitted-coastal-link', lambda v: v['addedBoundaryOrdinals'].remove(4050)),
            ('wrong-province', lambda v: v['cells'][next(i for i,c in enumerate(v['cells']) if c['ordinal'] == 6150)].update(renderProvinceId='macro:CHN:CN-13'))]:
        bad = copy.deepcopy(value)
        mutate(bad)
        try: verify(bad)
        except AssertionError: controls[name] = True
        else: raise AssertionError('NEGATIVE_CONTROL_ACCEPTED:' + name)
    report = {'pass': True, 'schemaVersion': 'chn-province-coast-repair-verification-v1', 'artifact': pin(args.artifact),
        'checks': checks, 'negativeControls': controls, 'verifier': pin('scripts/chn-2020/verify-province-coast-repair.py')}
    target = ROOT / args.output
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
