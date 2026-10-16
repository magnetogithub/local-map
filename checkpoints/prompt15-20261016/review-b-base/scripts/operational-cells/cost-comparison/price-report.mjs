import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {pinFile} from '../source-samples.mjs';
import {summarizeCosts} from './analysis.mjs';

// Recompute estimates from this candidate's actual measured payloads. This
// never fabricates or reruns generation, changes timings, or issues a PASS.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..'),reports=path.join(root,'.reports');
const report=path.resolve(root,process.argv[2]),archive=path.resolve(root,process.argv[3]);
for(const p of [report,archive]){const rel=path.relative(reports,p);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw new Error('CANDIDATE_REPORT_REQUIRED');}
if(fs.existsSync(archive)&&fs.readdirSync(archive).some(n=>n!=='analysis.mjs'))throw new Error('NEW_PRICING_ARCHIVE_REQUIRED');
fs.mkdirSync(archive,{recursive:true});
for(const p of [report,archive])if(path.relative(fs.realpathSync(reports),fs.realpathSync(p)).startsWith('..'))throw new Error('REPORT_SYMLINK_ESCAPE');
const summaryPath=path.join(report,'summary.json'),manifestPath=path.join(report,'input-manifest.json'),analysisPath=path.join(root,'scripts/operational-cells/cost-comparison/analysis.mjs');
const read=p=>JSON.parse(fs.readFileSync(p)),manifest=read(manifestPath);
for(const p of manifest.inputs){if(p.path===analysisPath)continue;const now=pinFile(p.path);if(now.sha256!==p.sha256||now.byteLength!==p.byteLength)throw new Error('MEASUREMENT_INPUT_CHANGED: '+p.path);}
fs.copyFileSync(summaryPath,path.join(archive,'summary.json'),fs.constants.COPYFILE_EXCL);
fs.copyFileSync(manifestPath,path.join(archive,'input-manifest.json'),fs.constants.COPYFILE_EXCL);
const oldSource=pinFile(path.join(archive,'analysis.mjs')),oldPin=manifest.inputs.find(p=>p.path===analysisPath);
if(oldSource.sha256!==oldPin.sha256||oldSource.byteLength!==oldPin.byteLength)throw new Error('ORIGINAL_PRICING_SOURCE_REQUIRED');
const measurementsPath=path.join(report,'measurements.json.gz'),areasPath=path.join(report,'source-area-scenarios.json');
const measured=JSON.parse(gunzipSync(fs.readFileSync(measurementsPath))),summary=read(summaryPath),areas=read(areasPath);
summary.comparison=summarizeCosts(measured.cases,areas);
summary.methodology.extrapolation+=' The global directory shares its one provenance template once. Directory bytes receive no compression credit in initial-transfer estimates.';
summary.pricingRevision={version:2,oldSource:oldPin,newSource:pinFile(analysisPath),reason:'Count the shared provenance template once in the global shard directory; original generation, encoding and decode measurements are unchanged.'};
fs.writeFileSync(summaryPath,JSON.stringify(summary,null,2));
const inputs=[...manifest.inputs.filter(p=>p.path!==analysisPath),pinFile(analysisPath),pinFile(fileURLToPath(import.meta.url)),
  pinFile(summaryPath),pinFile(measurementsPath),pinFile(areasPath),...['analysis.mjs','summary.json','input-manifest.json'].map(n=>pinFile(path.join(archive,n)))];
fs.writeFileSync(manifestPath,JSON.stringify({version:1,inputs:[...new Map(inputs.map(p=>[p.path,p])).values()]},null,2));
process.stdout.write(JSON.stringify({taskId:'15-16',repricedCases:measured.cases.length,generationRerun:false,verification:'controller Vitest pending'}));
