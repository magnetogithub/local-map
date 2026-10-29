// Branch A records the common generator result without changing shared files or runtime.
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {preparePrompt19Country} from '../../prepare-prompt19-country.mjs';

const startedAt = new Date().toISOString(), started = performance.now();
console.log('Preparing KOR candidate with the pinned common generator.');
let result = null, error = null;
try {result = preparePrompt19Country('KOR');} catch (cause) {error = {message: cause instanceof Error ? cause.message : String(cause), evidence: cause.evidence ?? null};}
const report = {stage: '19-02A', countryId: 'KOR', startedAt, finishedAt: new Date().toISOString(),
  elapsedMs: performance.now() - started, maximumRssBytes: process.resourceUsage().maxRSS * 1024,
  node: process.version, result, error};
fs.mkdirSync('reports/verification/prompt19/KOR', {recursive: true});
const file = `reports/verification/prompt19/KOR/candidate-run-${startedAt.replace(/[^0-9]/g, '')}.json`;
fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({...report, reportPath: file}));
if (error || !result?.pass) process.exitCode = 2;
