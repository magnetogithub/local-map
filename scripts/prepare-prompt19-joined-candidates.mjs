import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {gunzipSync} from 'node:zlib';
import {arrangePrompt19Sources} from './prompt19-source-arrangement.mjs';
import {joinedTopology, globalCellId} from './prompt19-joined-topology.mjs';
import {digest, jsonBytes, normalizeGeometry} from './prompt14-catalog-core.mjs';
import {prompt19SourceLockSchema} from './prompt19-country-core.mjs';
import {validatePolygonFeatureCollection, CANONICAL_P0_VALIDATOR_POLICY} from './prompt14-source-gate.mjs';
import {resolvePrompt19Input} from './prompt19-country-files.mjs';

const option = name => {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw Error(`MISSING_ARGUMENT:${name}`);
  return process.argv[i + 1];
};
const outputPrefix = option('--output-prefix');
const sourceLockPaths = Object.fromEntries(['KOR', 'PRK'].map(c => [c,
  option(`--${c.toLowerCase()}-source-lock`) ?? `data/source-locks/prompt19/${c}.json`]));
const outputPath = suffix => outputPrefix ? `${outputPrefix}-${suffix}` : `reports/maintenance/prompt19-C/${suffix}`;
const countries = process.argv.includes('--prk-probe') ? ['PRK'] : ['KOR', 'PRK'];
const selected = new Set(countries), root = 'data/derived/prompt19/baseline-v1';
const read = file => JSON.parse(fs.readFileSync(file));
const envelopes = read(`${root}/country-envelopes.geojson`), parents = read(`${root}/coarse-parents.geojson`);
const baselineIndex=read(`${root}/artifact-index.json`);
for(const a of baselineIndex.artifacts){const b=fs.readFileSync(`${root}/${a.path}`);if(b.length!==a.byteLength||digest(b)!==a.sha256)throw Error('BASELINE_CHANGED');}
const datasets = countries.map(countryId => {
  const lock = prompt19SourceLockSchema.parse(read(sourceLockPaths[countryId]));
  if(lock.countryId!==countryId)throw Error('SOURCE_COUNTRY_CHANGED');
  const checked=(a,scope)=>{const b=fs.readFileSync(resolvePrompt19Input(process.cwd(),a.path,scope));if(b.length!==a.byteLength||digest(b)!==a.sha256)throw Error('SOURCE_CHANGED');return b;};
  for(const a of lock.sources.map(s=>s.artifact))checked(a,`data/raw/prompt19/${countryId}`);
  for(const a of lock.preprocessing.code)checked(a,`scripts/prompt19/${countryId}`);
  const bytes = checked(lock.normalizedInput,`data/raw/prompt19/${countryId}`);
  const sources = new Map(lock.sources.map(s => [s.sourceId, s]));
  const features = JSON.parse(bytes).features.map(f => ({...f, geometry: normalizeGeometry(f.geometry), properties: {...f.properties,
    sourceVersion: sources.get(f.properties.sourceId).version, adminLevel: sources.get(f.properties.sourceId).adminLevel}}));
  const validity = validatePolygonFeatureCollection({type: 'FeatureCollection', features}, countryId, CANONICAL_P0_VALIDATOR_POLICY);
  if (!validity.pass) throw Error(`${countryId}: invalid original source`);
  return {countryId, features, envelope: envelopes.features.find(f => f.properties.countryId === countryId),
    coarseParents: parents.features.filter(f => f.properties.countryId === countryId)};
});
const start = performance.now();
const coarseRoot='data/derived/prompt19/coarse-world-v1';
const gz=file=>JSON.parse(gunzipSync(fs.readFileSync(`${coarseRoot}/${file}`)));
const detailIndex=read(`${coarseRoot}/detail-index.json`);
const coarseRows=detailIndex.countries.flatMap(c=>gz(c.metadata.path).rows.map(row=>({countryId:c.countryId,row})));
const byOrdinal=new Map(coarseRows.map(c=>[c.row[0],c]));
const oldEdges=detailIndex.edgeDetails.flatMap(s=>gz(s.artifact.path).edges);
const neighborIds=new Set();
for(const e of oldEdges)if(e.right){const l=byOrdinal.get(e.left),r=byOrdinal.get(e.right);if(selected.has(l.countryId)&&!selected.has(r.countryId))neighborIds.add(r.row[1]);if(selected.has(r.countryId)&&!selected.has(l.countryId))neighborIds.add(l.row[1]);}
const coarseParentData=gz('metadata/parents.json.gz');
const neighboringParents=[];
for(const c of detailIndex.countries.filter(c=>!selected.has(c.countryId)&&coarseRows.some(r=>r.countryId===c.countryId&&neighborIds.has(r.row[1])))){
  const rows=new Map(gz(c.metadata.path).rows.map(r=>[r[0],r]));
  for(const f of gz(c.detail.path).features){const row=rows.get(f.id);if(neighborIds.has(row[1]))neighboringParents.push({...f,properties:{countryId:c.countryId,coarseTerritoryId:row[1],parentKey:coarseParentData.administrative[row[2]-1].parentKey}});}
}
const strictSourceMembership = process.argv.includes('--strict-source-membership');
const result = arrangePrompt19Sources({datasets, neighboringParents, preserveCanonicalResiduals:true, continueTerminals:false,strictSourceMembership,onProgress: console.log});
const topology=result.invalid.length||result.unresolved.length?null:joinedTopology(result);
const report = {countries, summary: result.summary, cells: result.cells.length, invalid: result.invalid, unresolved: result.unresolved,
  strictSourceMembership, sourceLockArtifacts: countries.map(countryId => {const file = sourceLockPaths[countryId], bytes = fs.readFileSync(file); return {countryId, path:file, sha256:digest(bytes), byteLength:bytes.length};}),
  evidence: result.evidence, topology:topology?.evidence??null, sourceTrace:result.sourceTrace, elapsedMs: performance.now() - start, peakRssBytes: process.resourceUsage().maxRSS * 1024};
fs.mkdirSync('reports/maintenance/prompt19-C', {recursive: true});
const name = countries.length === 1 ? 'prk-arrangement' : 'joint-arrangement';
fs.writeFileSync(outputPath(`${name}.json`), jsonBytes(report));
fs.writeFileSync(outputPath(`${name}-cells.geojson`), jsonBytes({type: 'FeatureCollection', features: result.cells}));
if(topology)fs.writeFileSync(outputPath(`${name}-topology.json`),jsonBytes(topology));
if(topology&&countries.length===2){
  const replacement=new Set(coarseRows.filter(c=>selected.has(c.countryId)).map(c=>c.row[1]));
  const features=[],records=[];
  for(const c of detailIndex.countries.filter(c=>!selected.has(c.countryId))){
    const rows=new Map(gz(c.metadata.path).rows.map(r=>[r[0],r]));
    for(const f of gz(c.detail.path).features){const row=rows.get(f.id);features.push({...f,id:row[1],properties:{countryId:c.countryId}});records.push({id:row[1],countryId:c.countryId,administrativeParentKey:coarseParentData.administrative[row[2]-1].parentKey,previousParentId:row[1]});}
  }
  for(const f of result.cells){const id=globalCellId(f);features.push({...f,id});records.push({id,countryId:f.properties.countryId,administrativeParentKey:f.properties.administrativeParentKey,previousParentId:f.properties.coarseParentTerritoryId});}
  const retained=oldEdges.filter(e=>!replacement.has(byOrdinal.get(e.left).row[1])&&!replacement.has(byOrdinal.get(e.right)?.row[1])).map(e=>({...e,leftTerritoryId:byOrdinal.get(e.left).row[1],rightTerritoryId:byOrdinal.get(e.right)?.row[1]??null}));
  const bundle={schemaVersion:'prompt19-joined-world-input-v1',features,records,edges:[...retained,...topology.edges],parents:coarseParentData,report};
  const snapshot=outputPath('joined-world-input.json');
  if(fs.existsSync(snapshot)){
    const stable=value=>{const {elapsedMs,peakRssBytes,...report}=value.report;void elapsedMs;void peakRssBytes;return{...value,report};};
    if(digest(jsonBytes(stable(read(snapshot))))!==digest(jsonBytes(stable(bundle))))throw Error('JOINED_INPUT_IMMUTABLE: publish a new snapshot path for changed inputs');
  }else fs.writeFileSync(snapshot,jsonBytes(bundle),{flag:'wx'});
  for(const countryId of countries){const local=result.cells.filter(c=>c.properties.countryId===countryId),key=digest(jsonBytes(local)).slice(0,20),out=`data/derived/prompt19/candidates/${countryId}/joined-${key}`;
    if(!fs.existsSync(out)){fs.mkdirSync(out,{recursive:true});fs.writeFileSync(`${out}/cells.geojson`,jsonBytes({type:'FeatureCollection',features:local}));fs.writeFileSync(`${out}/verification.json`,jsonBytes({countryId,summary:result.summary.find(s=>s.countryId===countryId),topology:topology.evidence,worldCoverageComplete:true,fineAssignmentComplete:!local.some(f=>f.properties.unresolvedFineSourceAssignment),unresolvedFineSourceAssignment:local.filter(f=>f.properties.unresolvedFineSourceAssignment).map(f=>f.id),sourceTrace:result.sourceTrace.filter(s=>s.countryId===countryId)}));}
  }
}
console.log(JSON.stringify({summary: result.summary, invalid: result.invalid.length, unresolved: result.unresolved.length, extensions: result.evidence.extensions.length}));
if (result.invalid.length || result.unresolved.length) process.exitCode = 2;
