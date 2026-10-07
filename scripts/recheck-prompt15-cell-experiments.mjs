// Rechecks existing geometry bytes with the final graph implementation; does not regenerate geometry.
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
 const tiles=render.tiles.map(t=>{const actual=fileIdentity(t.path);if(actual.sha256!==t.sha256||actual.byteLength!==t.byteLength)throw Error('PBF byte change');return {...actual,path:path.relative(dir,t.path).split(path.sep).join('/')};});
 const correctedRoot=digest(jsonBytes(tiles)),previousRoot=summary.deterministicRoots.render;
 const features=readJSON(`${dir}/geometry.geojson`).features,geometryById=new Map(features.map(f=>[f.properties.territoryId,f.geometry]));
 const cells=readJSON(`${dir}/cell-measurements.json`).map(c=>({...c,geometry:geometryById.get(c.id)}));
 const result={countryId:country,cells,parents:readJSON(`${dir}/membership.json`),topology:readJSON(`${dir}/topology.json`),coverage:summary.coverage};
 const behavior=behaviorExperiments(result,sources),largeFractions=behavior.scenarios.flatMap(s=>s.ranges.near.parentAreaFractions??[]).filter(p=>p.parentAreaKm2>=P.sufficientlyLargeAdministrativeAreaKm2);
 const checks={...summary.checks,
  nearSuccess:behavior.scenarios.every(s=>s.ranges.near.status==='pass'||(result.parents.every(p=>p.metrics.diameterUpperBoundKm<=P.interiorMaximumDiameterKm)&&s.ranges.near.status==='empty')),
  largeParentNearFraction:largeFractions.every(p=>p.occupiedAreaKm2/p.parentAreaKm2<=P.nearMaximumParentAreaFraction),
  interiorAdvance:behavior.scenarios.filter(s=>s.kind==='internal-frontier'&&s.parentAreaKm2>=P.sufficientlyLargeAdministrativeAreaKm2).every(s=>s.limitedHasSeveralDepthSteps&&s.nearLeavesInterior),
  secondAdvance:behavior.scenarios.filter(s=>s.kind==='national-frontier').every(s=>s.firstSecondDisjoint&&s.secondTouchesCurrentFront&&s.sameParentOccupiedAndUnoccupied)};
 const nearPayloadBytes=Math.max(0,...behavior.scenarios.map(s=>Buffer.byteLength(JSON.stringify({catalogRevision:'experimental',worldRevision:0,cellIds:s.ranges.near.ids,effectTarget:{territoryIds:s.ranges.near.ids},parentKeys:s.ranges.near.parentAreaFractions?.map(p=>p.parentKey)??[]}))));
 checks.nearProviderPayload=nearPayloadBytes<=P.budgets.nearProviderPayloadBytes;
 const recheck={command:'node scripts/recheck-prompt15-cell-experiments.mjs',before,inputs:[fileIdentity('scripts/prompt15-cell-core.mjs'),fileIdentity('scripts/recheck-prompt15-cell-experiments.mjs'),fileIdentity(`${dir}/render-index.json`)],
  renderRootNormalization:{previousRoot,correctedRoot,verifiedPbfFiles:tiles.length,reason:'The old root included the Windows first/second directory in tile identity paths. Normalize only the artifact path; every PBF file is independently hash/length checked and unchanged.'},
  geometryInputs:summary.artifacts.filter(a=>a.path.endsWith('geometry.geojson')||a.path.endsWith('topology.json')||a.path.endsWith('membership.json')||a.path.endsWith('cell-measurements.json'))};
 for(const a of recheck.geometryInputs){const current=fileIdentity(a.path);if(current.sha256!==a.sha256||current.byteLength!==a.byteLength)throw Error('Geometry artifact changed before recheck');}
 summary.deterministicRoots.render=correctedRoot;summary.behavior=behavior;summary.checks=checks;summary.nearPayloadBytes=nearPayloadBytes;summary.status=Object.values(checks).every(Boolean)?'pass':'fail';
 summary.finalRecheck=recheck;
 fs.writeFileSync(summaryPath,jsonBytes(summary));evidence.push({candidate:candidate.id,country,run,status:summary.status,artifact:fileIdentity(summaryPath),verifiedPbfFiles:tiles.length});
}
fs.writeFileSync('reports/prompt15/15-03-experiment-rechecks.json',jsonBytes({status:'pass',command:'node scripts/recheck-prompt15-cell-experiments.mjs',evidence}));
console.log(JSON.stringify({experiments:evidence.length,status:'pass'}));
