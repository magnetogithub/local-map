"""Verify source-parent display repairs and both reported missing connections."""
import argparse, copy, gzip, hashlib, json
from collections import Counter
from pathlib import Path
import shapely
from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parents[2]
TARGETS = {'62558664B63578283386767': ('Zayü County', 'macro:CHN:CN-54', [3747]),
           '62558664B94418753148767': ('Junshan District', 'macro:CHN:CN-43', [5174])}

def pin(file):
    b = (ROOT / file).read_bytes()
    return {'path': file, 'sha256': hashlib.sha256(b).hexdigest(), 'byteLength': len(b)}

def checked(p):
    assert pin(p['path']) == p, 'INPUT_PIN_CHANGED:' + p['path']
    return (ROOT / p['path']).read_bytes()

def read(p):
    return json.loads(checked(p))

def context(value):
    baseline = read(value['linkRepair']['baseline'])
    old = read(baseline['acceptedPresentation'])
    proof = read(baseline['independentVerification'])
    assert proof['pass'] is True and proof['artifact'] == baseline['acceptedPresentation']
    refs = read(value['linkRepair']['reference'])
    assert refs['schemaVersion'] == 'chn-province-link-references-v1'
    assert {r['sourceFeatureId'] for r in refs['families']} == set(TARGETS)
    for p in value['inputs'].values(): checked(p)
    for p in value['code']: checked(p)
    for key in ('pointer', 'index', 'metadata', 'parents', 'hierarchy', 'fineSource', 'provinceSource', 'incidence', 'geometry'):
        assert value['inputs'][key] == old['inputs'][key], 'BASE_CATALOG_INPUT_CHANGED:' + key
    pointer = read(value['inputs']['pointer'])
    assert read(pin('data/runtime/operational-catalog/current.json')) == pointer
    index = read({'path': pointer['root'] + '/artifact-index.json', **pointer['index']})
    artifacts = {a['path']: a for a in index['artifacts']}
    def asset(name):
        b = checked({**artifacts[name], 'path': pointer['root'] + '/' + name})
        return json.loads(gzip.decompress(b) if name.endswith('.gz') else b)
    detail = asset('detail-index.json')
    edges = [e for s in detail['edgeDetails'] for e in asset(s['artifact']['path'])['edges']]
    raw = read(value['inputs']['fineSource'])['features']
    provinces = read(value['inputs']['provinceSource'])['features']
    containment = {}
    for reference in refs['families']:
        source_id = reference['sourceFeatureId']
        name, province_id, ordinals = TARGETS[source_id]
        assert (reference['sourceName'], reference['renderProvinceId'], reference['cellOrdinals']) == (name, province_id, ordinals)
        source = next(f for f in raw if f['properties']['shapeID'] == source_id)
        assert source['properties']['shapeName'] == name
        polygon = shape(source['geometry'])
        overlaps = sorted([(polygon.intersection(shape(f['geometry'])).area / polygon.area, f['properties']['shapeISO']) for f in provinces], reverse=True)
        assert overlaps[0][1] == province_id.removeprefix('macro:CHN:')
        assert overlaps[0][0] > (.6 if ordinals == [3747] else .999999)
        assert overlaps[1][0] < .000001
        containment[source_id] = {'topShare': overlaps[0][0], 'secondShare': overlaps[1][0], 'province': overlaps[0][1]}
    return {'old': old, 'edges': edges, 'containment': containment}

def verify(value, ctx):
    old, edges = ctx['old'], ctx['edges']
    assert value['catalogRef'] == old['catalogRef'] and value['provinces'] == old['provinces']
    assert value['administrativeTruthClaim'] is False
    assert len(value['cells']) == len(old['cells'])
    changed = []
    for before, after in zip(old['cells'], value['cells']):
        expected = dict(before)
        if before['sourceFeatureId'] in TARGETS:
            assert before['renderProvinceId'] is None
            expected['renderProvinceId'] = TARGETS[before['sourceFeatureId']][1]
            changed.append(before['ordinal'])
        assert expected == after, 'UNRELATED_OR_WRONG_CELL_MEMBERSHIP'
    assert changed == [3747, 5174]
    assert len(value['families']) == len(old['families'])
    for before, after in zip(old['families'], value['families']):
        if before['sourceFeatureId'] not in TARGETS:
            assert before == after, 'UNRELATED_FAMILY_CHANGED'
        else:
            assert after['renderProvinceId'] == TARGETS[before['sourceFeatureId']][1]
            assert after['method'] == 'source-hierarchy-display-repair'
            previous = dict(after)
            previous.pop('displayRepair')
            previous['method'], previous['renderProvinceId'] = before['method'], before['renderProvinceId']
            assert previous == before
    cells = {c['ordinal']: c for c in value['cells']}
    expected = sorted(e['ordinal'] for e in edges if e['left'] in cells and e['right'] in cells
        and cells[e['left']]['renderProvinceId'] is not None and cells[e['right']]['renderProvinceId'] is not None
        and cells[e['left']]['renderProvinceId'] != cells[e['right']]['renderProvinceId'])
    assert value['addedBoundaryOrdinals'] == expected, 'MISSING_OR_FOREIGN_PROVINCE_EDGE'
    added = sorted(set(expected) - set(old['addedBoundaryOrdinals']))
    assert added == [3838, 7152, 7977] and set(old['addedBoundaryOrdinals']) <= set(expected)
    protected = [shape(e['geometry']) for e in edges if e['boundaryClass'] in ('country', 'coast')]
    tree = shapely.STRtree(protected)
    regions = {'myanmar-side': (94, 24, 105, 33), 'south-of-wuhan': (108, 25, 117, 32)}
    def terminals(ids, box):
        degree = Counter(tuple(p) for e in edges if e['ordinal'] in ids for p in (e['geometry']['coordinates'][0], e['geometry']['coordinates'][-1]))
        return [node for node, n in degree.items() if n == 1 and box[0] < node[0] < box[2] and box[1] < node[1] < box[3]
            and not len(tree.query(Point(node), predicate='intersects'))]
    endpoints = {}
    for name, box in regions.items():
        before, after = terminals(set(old['addedBoundaryOrdinals']), box), terminals(set(expected), box)
        assert len(before) == (1 if name == 'myanmar-side' else 2), 'BASELINE_MISSING_CONNECTION_NOT_REPRODUCED'
        assert not after, 'INTERIOR_DANGLING_PROVINCE_ENDPOINT:' + name
        endpoints[name] = {'before': before, 'after': after}
    return {'changedCellOrdinals': changed, 'promotedEdges': added, 'provinceEdges': len(expected),
        'rawContainment': ctx['containment'], 'danglingEndpoints': endpoints,
        'allExistingProvinceEdgesPreserved': True, 'unrelatedMembershipsUnchanged': True,
        'countryOutlinesAndGameGeometryUnchanged': True}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    value = read(pin(args.artifact))
    ctx = context(value)
    checks = verify(value, ctx)
    controls = {}
    for ordinal in (3838, 7152):
        bad = copy.deepcopy(value)
        bad['addedBoundaryOrdinals'].remove(ordinal)
        try: verify(bad, ctx)
        except AssertionError: controls['omitted-edge-' + str(ordinal)] = True
        else: raise AssertionError('NEGATIVE_CONTROL_ACCEPTED')
    bad = copy.deepcopy(value)
    next(c for c in bad['cells'] if c['ordinal'] == 5174)['renderProvinceId'] = 'macro:CHN:CN-42'
    try: verify(bad, ctx)
    except AssertionError: controls['wrong-parent'] = True
    else: raise AssertionError('NEGATIVE_CONTROL_ACCEPTED')
    for p in value['inputs'].values(): checked(p)
    report = {'schemaVersion': 'chn-province-link-repair-verification-v1', 'pass': True, 'artifact': pin(args.artifact),
        'checks': checks, 'negativeControls': controls, 'verifier': pin('scripts/chn-2020/verify-province-link-repair.py')}
    target = ROOT / args.output
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report))
