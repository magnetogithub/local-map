// Read-only instrumentation of the same common engine: captures a failing boolean input.
// This changes neither source coordinates nor algorithm results and publishes no candidate.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import {performance} from 'node:perf_hooks';
import {preparePrompt19Country} from '../../prepare-prompt19-country.mjs';

const directory = 'reports/verification/prompt19/KOR';
const counts = {intersection: 0, difference: 0, union: 0}, originals = {}, failures = [];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync(directory, {recursive: true});
for (const name of Object.keys(counts)) {
  originals[name] = polygonClipping[name];
  polygonClipping[name] = (...args) => {
    counts[name]++;
    if (name === 'intersection' && counts[name] % 10000 === 0) console.log(JSON.stringify({booleanCalls: counts}));
    try {return originals[name](...args);} catch (error) {
      const summary = {operation: name, error: error.message, counts: {...counts}, argumentCount: args.length,
        inputVertices: args.reduce((n, polygons) => n + polygons.reduce((n, rings) => n + rings.reduce((n, ring) => n + ring.length, 0), 0), 0)};
      failures.push(summary);
      const inputFile = `${directory}/common-boolean-reproduction.json`, bytes = Buffer.from(JSON.stringify({operation: name, args}) + '\n');
      if (!fs.existsSync(inputFile)) {
      fs.writeFileSync(inputFile, bytes, {flag: 'wx'});
      const report = {stage: '19-02A', countryId: 'KOR', error: error.message, operation: name, counts: {...counts},
        arguments: args.map((arg, i) => ({index: i, polygons: arg.length, byteLength: Buffer.byteLength(JSON.stringify(arg))})),
        reproduction: {path: inputFile, sha256: sha(bytes), byteLength: bytes.length},
        requestedOwner: 'C', sourceOrSharedFilesChanged: false, candidatePublished: false};
      fs.writeFileSync(`${directory}/common-boolean-failure.json`, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
      }
      throw error;
    }
  };
}
const started = performance.now();
try {
  const result = preparePrompt19Country('KOR'); console.log(JSON.stringify({unexpectedSuccess: result, counts}));
} catch (error) {
  const report = {error: error.message, counts, failures, elapsedMs: performance.now() - started, maximumRssBytes: process.resourceUsage().maxRSS * 1024};
  fs.writeFileSync(`${directory}/common-failure-sequence.json`, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(report));
  process.exitCode = 2;
} finally {for (const name of Object.keys(counts)) polygonClipping[name] = originals[name];}
