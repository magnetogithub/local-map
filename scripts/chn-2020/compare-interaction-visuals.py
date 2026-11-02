"""Read-only PNG regression check for the fixed-camera country-label view.

Uses only Python's standard library. This supplements root visual inspection;
it does not replace the geometry or decoded-tile acceptance.
"""
import hashlib
import json
from pathlib import Path
import struct
import zlib

ROOT = Path('reports/chn-perf-20261030')

def pin(path):
    value = Path(path).read_bytes()
    return {'path': str(path).replace('\\', '/'), 'sha256': hashlib.sha256(value).hexdigest(), 'byteLength': len(value)}

def pixels(path):
    value = Path(path).read_bytes()
    assert value[:8] == b'\x89PNG\r\n\x1a\n'
    offset, compressed = 8, bytearray()
    while offset < len(value):
        length = struct.unpack('>I', value[offset:offset + 4])[0]
        kind, data = value[offset + 4:offset + 8], value[offset + 8:offset + 8 + length]
        if kind == b'IHDR':
            width, height, depth, color, compression, filtering, interlace = struct.unpack('>IIBBBBB', data)
            assert depth == 8 and color in [2, 6] and compression == filtering == interlace == 0
        if kind == b'IDAT':
            compressed.extend(data)
        offset += length + 12
    channels = 3 if color == 2 else 4
    stride, raw = width * channels, zlib.decompress(compressed)
    assert len(raw) == height * (stride + 1)
    rows, previous = [], bytearray(stride)
    for y in range(height):
        method = raw[y * (stride + 1)]
        row = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        assert method in range(5)
        for x in range(stride):
            a, b = row[x - channels] if x >= channels else 0, previous[x]
            c = previous[x - channels] if x >= channels else 0
            if method == 1: prediction = a
            elif method == 2: prediction = b
            elif method == 3: prediction = (a + b) // 2
            elif method == 4:
                p = a + b - c
                distances = [abs(p - a), abs(p - b), abs(p - c)]
                prediction = [a, b, c][distances.index(min(distances))]
            else: prediction = 0
            row[x] = (row[x] + prediction) & 255
        rows.append(row)
        previous = row
    return width, height, channels, rows

def white_count(image, bounds):
    width, height, channels, rows = image
    west, north, east, south = bounds
    assert 0 <= west < east <= width and 0 <= north < south <= height
    return sum(all(value >= 235 for value in rows[y][x * channels:x * channels + 3])
               for y in range(north, south) for x in range(west, east))

before_path, after_path = ROOT / 'baseline-china.png', ROOT / 'optimized-china.png'
before, after = pixels(before_path), pixels(after_path)
assert before[:3] == after[:3]
regions = []
for name, bounds in [('map', [0, 60, 1051, 800]), ('large-china-label', [100, 300, 900, 550])]:
    a, b = white_count(before, bounds), white_count(after, bounds)
    ratio = b / a if a else 0
    regions.append({'name': name, 'bounds': bounds, 'baselineWhitePixels': a, 'optimizedWhitePixels': b,
                    'ratio': ratio, 'pass': a > 1000 and .9 <= ratio <= 1.1})
report = {'schemaVersion': 'chn-interaction-visual-comparison-v1', 'pass': all(r['pass'] for r in regions),
          'baseline': pin(before_path), 'optimized': pin(after_path), 'regions': regions,
          'method': 'Count near-white pixels in the exact same fixed-camera normal selection screenshots, excluding the UI/attribution. A missing large white country label fails. Separate root inspection checks appearance.'}
(ROOT / 'visual-comparison.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf8')
print(json.dumps(report))
if not report['pass']:
    raise SystemExit(1)
