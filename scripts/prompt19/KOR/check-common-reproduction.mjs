// Focused reproduction evidence for C. No fallback is installed in the common engine.
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import GeoJSONWriter from 'jsts/org/locationtech/jts/io/GeoJSONWriter.js';
import OverlayOp from 'jsts/org/locationtech/jts/operation/overlay/OverlayOp.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {geometryMetadata, normalizeGeometry} from '../../prompt14-catalog-core.mjs';

const file = 'reports/verification/prompt19/KOR/common-boolean-reproduction.json';
const repro = JSON.parse(fs.readFileSync(file)), reader = new GeoJSONReader(), writer = new GeoJSONWriter();
if (repro.operation !== 'intersection' || repro.args.length !== 2) throw Error('Unexpected reproduction');
const input = repro.args.map(coordinates => ({type: 'MultiPolygon', coordinates}));
const report = {stage: '19-02A', inputFile: file, inputValidity: input.map(g => new IsValidOp(reader.read(g)).isValid()),
  method: 'Direct JSTS OverlayOp.overlayOp(INTERSECTION); no SnapIfNeededOverlayOp convenience/fallback method',
  appliedToSharedGenerator: false, sourceCoordinatesChanged: false};
const start = performance.now();
try {
  const result = writer.write(OverlayOp.overlayOp(reader.read(input[0]), reader.read(input[1]), OverlayOp.INTERSECTION));
  report.elapsedMs = performance.now() - start;
  report.resultType = result.type;
  report.resultValid = new IsValidOp(reader.read(result)).isValid();
  report.resultMetrics = geometryMetadata(normalizeGeometry(result));
  report.result = result;
} catch (error) {report.error = error.message; report.elapsedMs = performance.now() - start;}
fs.writeFileSync('reports/verification/prompt19/KOR/direct-overlay-investigation.json', JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({...report, result: report.result ? 'preserved in report' : null}));
