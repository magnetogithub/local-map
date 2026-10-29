// Read-only recheck of generated geometry, graph behavior and exact artifact bytes.
import fs from 'node:fs';
import path from 'node:path';
import {CELL_EXPERIMENT_POLICY as P} from './prompt15-cell-policy.mjs';
import {readJSON,fileIdentity,loadExperimentSources,behaviorExperiments} from './prompt15-cell-core.mjs';
import {digest,jsonBytes} from './prompt14-catalog-core.mjs';
const sources=loadExperimentSources(),evidence=[];
for(const candidate of P.candidates)for(const country of P.representativeCountries)for(const run of ['first','second']){
 const dir=`reports/prompt15/cell-experiments/${candidate.id}/${country}/${run}`,summaryPath=`${dir}/summary.json`;
 if(!fs.existsSync(summaryPath))continue;
 const summary=readJSON(summaryPath),before=fileIdentity(summaryPath),render=readJSON(`${dir}/render-index.json`);
 const tiles=render.tiles.map(t=>{const actual=fileIdentity(path.join(dir,...t.path.split('/')));if(actual.sha256!==t.sha256||actual.byteLength!==t.byteLength)throw Error('PBF byte change');return {...actual,path:t.path};});
 const tileRoot=digest(jsonBytes(tiles));
 const features=readJSON(`${dir}/geometry.geojson`).features,geometryById=new Map(features.map(f=>[f.properties.territoryId,f.geometry]));
 const cells=readJSON(`${dir}/cell-measurements.json`).map(c=>({...c,geometry:geometryById.get(c.id)}));
 const result={countryId:country,cells,parents:readJSON(`${dir}/membership.json`),topology:readJSON(`${dir}/topology.json`),coverage:summary.coverage};
 const behavior=behaviorExperiments(result,sources),largeFractions=behavior.scenarios.flatMap(s=>s.ranges.near.parentAreaFractions??[]).filter(p=>p.parentAreaKm2>=P.sufficientlyLargeAdministrativeAreaKm2);
 const checks={...summary.checks,
  nearSuccess:behavior.scenarios.every(s=>s.ranges.near.status==='pass'||(result.parents.every(p=>p.metrics.diameterUpperBoundKm<=P.interiorMaximumDiameterKm)&&s.ranges.near.status==='empty')),
  largeParentNearFraction:largeFractions.every(p=>p.occupiedAreaKm2/p.parentAreaKm2<=P.nearMaximumParentAreaFraction),
  interiorAdvance:behavior.scenarios.filter(s=>s.kind==='internal-frontier'&&s.parentAreaKm2>=P.sufficientlyLargeAdministrativeAreaKm2).every(s=>s.limitedHasSeveralDepthSteps&&s.nearLeavesInterior),
   limitedDepthTiers:behavior.scenarios.every(s=>s.ranges.limited.status==='pass'&&s.ranges.limited.tiers>=P.minimumLimitedGraphTiers),
   frontierCoverage:Object.values(behavior.frontierCoverage).flat().every(e=>Math.abs(e.coverageRatio-1)<=1e-6),
   secondAdvance:behavior.scenarios.filter(s=>s.kind==='national-frontier').every(s=>s.firstSecondDisjoint&&s.secondTouchesCurrentFront&&s.sameParentOccupiedAndUnoccupied)};
 const nearPayloadBytes=Math.max(0,...behavior.scenarios.map(s=>Buffer.byteLength(JSON.stringify({catalogRevision:'experimental',worldRevision:0,cellIds:s.ranges.near.ids,effectTarget:{territoryIds:s.ranges.near.ids},parentKeys:s.ranges.near.parentAreaFractions?.map(p=>p.parentKey)??[]}))));
 checks.nearProviderPayload=nearPayloadBytes<=P.budgets.nearProviderPayloadBytes;
 const manifest=readJSON(`${dir}/artifact-manifest.json`),manifestFiles=manifest.files.map(a=>{const actual=fileIdentity(path.join(dir,...a.path.split('/')));if(actual.sha256!==a.sha256||actual.byteLength!==a.byteLength)throw Error(`Artifact byte change: ${a.path}`);return {...actual,path:a.path};}),manifestRoot=digest(jsonBytes(manifestFiles));
 const recheck={command:'node scripts/recheck-prompt15-cell-experiments.mjs',before,inputs:[fileIdentity('scripts/prompt15-cell-core.mjs'),fileIdentity('scripts/recheck-prompt15-cell-experiments.mjs'),fileIdentity(`${dir}/render-index.json`)],
  byteRoots:{tileRoot,expectedTileRoot:summary.deterministicRoots.tiles,manifestRoot,expectedManifestRoot:manifest.rootSha256,verifiedPbfFiles:tiles.length,verifiedManifestFiles:manifestFiles.length},
  geometryInputs:summary.artifacts.filter(a=>a.path.endsWith('geometry.geojson')||a.path.endsWith('topology.json')||a.path.endsWith('membership.json')||a.path.endsWith('cell-measurements.json'))};
 for(const a of recheck.geometryInputs){const current=fileIdentity(a.path);if(current.sha256!==a.sha256||current.byteLength!==a.byteLength)throw Error('Geometry artifact changed before recheck');}
 const comparisons={behavior:jsonBytes(behavior).equals(jsonBytes(summary.behavior)),checks:jsonBytes(checks).equals(jsonBytes(summary.checks)),nearPayload:nearPayloadBytes===summary.nearPayloadBytes,tiles:tileRoot===summary.deterministicRoots.tiles,manifest:manifestRoot===manifest.rootSha256},matches=Object.values(comparisons).every(Boolean);
 evidence.push({candidate:candidate.id,country,run,status:matches?'pass':'fail',candidateStatus:summary.status,comparisons,artifact:before,verifiedPbfFiles:tiles.length,recheck});
}
const status=evidence.length===P.candidates.length*P.representativeCountries.length+P.representativeCountries.length&&evidence.every(x=>x.status==='pass')?'pass':'fail';
fs.writeFileSync('reports/prompt15/15-03-experiment-rechecks.json',jsonBytes({status,command:'node scripts/recheck-prompt15-cell-experiments.mjs',evidence}));
console.log(JSON.stringify({experiments:evidence.length,status}));
if(status!=='pass')process.exitCode=1;
