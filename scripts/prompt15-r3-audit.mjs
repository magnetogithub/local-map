import fs from 'node:fs';
import path from 'node:path';
import {readJSON,fileIdentity,physicalMetrics} from './prompt15-cell-core.mjs';
import {jsonBytes,normalizeGeometry} from './prompt14-catalog-core.mjs';
import {validateArchive,validateMembership,validateRealization} from './prompt15-r3-validation.mjs';
import {validatePositiveGeometry} from './prompt15-r3-validity.mjs';
const output=process.argv[2];
if(fs.existsSync(`${output}/independent-validation.json`)){
 const previous=readJSON(`${output}/independent-validation.json`);
 if(!previous.inputs.every(i=>{const actual=fileIdentity(i.path);return actual.sha256===i.sha256&&actual.byteLength===i.byteLength;}))throw Error('Preserve previous independent audit: a pinned byte changed');
 console.log(`Reusing completed independent full-world audit after rechecking every pinned input byte: ${previous.status}`);process.exit(previous.status==='pass'?0:1);
}
const world=readJSON(`${output}/world/catalog.json`),membership=readJSON(`${output}/world/membership.json`),residuals=readJSON(`${output}/world/residual-membership.json`),regions=[],results=[],catalogById=new Map(world.cells.map(c=>[c.id,c])),catalogSeen=new Set();
const auditStart=performance.now();fs.mkdirSync(`${output}/audit-countries`,{recursive:true});
const old=readJSON(`${output}/old-protected.geojson`).features,sourceVersion=readJSON('data/source-locks/prompt14-derived-game-input-lock.json').sourceVersion,source=validateArchive(readJSON(`${output}/source-original.geojson`),readJSON(`${output}/source-records.json`));
const original=readJSON(`${output}/input-summary.json`).inputs.find(a=>a.path==='data/raw/ne_10m_admin_1_states_provinces.geojson');
source.originalBytes=fileIdentity(`${output}/source-original.geojson`).sha256===original.sha256;source.pass&&=source.originalBytes;
const inspect=callback=>{try{return callback();}catch(error){return {pass:false,errors:['independent-validation-exception'],exception:{name:error.name,message:error.message,stack:error.stack}};}};
for(const s of readJSON(`${output}/input-summary.json`).countries){
 const input=readJSON(`${output}/inputs/${s.countryId}.json`),summary=readJSON(`${output}/refined-mesh/${s.countryId}/summary.json`),cells=summary.chunks.flatMap(c=>readJSON(`${output}/${c.path}`));regions.push(...input.gameRegions);
 const realization=inspect(()=>validateRealization(input,cells,old.filter(f=>f.properties.sourceCountryId===s.countryId),sourceVersion)),validity=inspect(()=>validatePositiveGeometry(cells.map(c=>c.geometry)));
 const metricEvidence=inspect(()=>({pass:cells.every(c=>{const m=physicalMetrics(normalizeGeometry(c.geometry));return m.area===c.metrics.planarArea&&m.areaKm2===c.metrics.areaKm2&&m.diameterUpperBoundKm===c.metrics.diameterKm&&m.vertices===c.metrics.vertices;})})),metrics=metricEvidence.pass;
 const artifacts=summary.chunks.every(c=>{const a=fileIdentity(`${output}/${c.path}`);return a.sha256===c.sha256&&a.byteLength===c.byteLength;});
 let catalog=true;for(const chunk of summary.chunks)for(const c of readJSON(`${output}/${chunk.path}`)){const entry=catalogById.get(c.id);if(!entry||entry.sourceCountryId!==c.sourceCountryId||entry.adminId!==c.adminId||entry.oldTerritoryId!==c.oldTerritoryId||entry.geometryShard!==chunk.path||catalogSeen.has(c.id))catalog=false;catalogSeen.add(c.id);}
 results.push({countryId:s.countryId,pass:realization.pass&&validity.pass&&metrics&&artifacts&&catalog,realization,validity,metrics,metricEvidence,artifacts,catalog});fs.writeFileSync(`${output}/audit-countries/${s.countryId}.json`,jsonBytes(results.at(-1)));console.log(`${s.countryId}: ${results.at(-1).pass?'pass':'fail'}`);
}
const freeze=readJSON('data/catalogs/prompt14/frozen-catalog-ref.json'),oldPair=readJSON(`${path.dirname(freeze.artifactIndex.path)}/migration-pair.json`),state=readJSON(`${output}/world/inheritance-state-fixture.json`),metadata=readJSON(`${output}/world/metadata.json`);
const mutableInheritance=world.cells.every((c,i)=>{const inherited=state.territoriesById[c.id],parent=oldPair.world.territoriesById[c.oldTerritoryId];return state.territoryOrder[i]===c.id&&metadata.territories[i]?.id===c.id&&inherited?.sourceCountryId===c.sourceCountryId&&parent&&inherited.ownerCountryId===parent.ownerCountryId&&inherited.controllerCountryId===parent.controllerCountryId;});
const catalogBijection=catalogById.size===world.cells.length&&catalogSeen.size===world.cells.length;
const membershipCheck=validateMembership(world.cells,membership,residuals,regions),svn=regions.filter(r=>r.sourceCountryId==='SVN'&&r.active).length===193,result={status:source.pass&&membershipCheck.pass&&svn&&catalogBijection&&mutableInheritance&&results.every(r=>r.pass)?'pass':'fail',source,membership:membershipCheck,slovenia193:svn,catalogBijection,mutableInheritance,countries:results,command:`node scripts/prompt15-r3-audit.mjs ${output}`,inputs:[fileIdentity('scripts/prompt15-r3-audit.mjs'),fileIdentity('scripts/prompt15-r3-validation.mjs'),fileIdentity(`${output}/world/catalog.json`)],productionCutover:false};
result.elapsedMs=performance.now()-auditStart;result.peakRssBytes=process.resourceUsage().maxRSS*1024;result.resourceUsage=process.resourceUsage();
result.inputs=[fileIdentity('scripts/prompt15-r3-audit.mjs'),fileIdentity('scripts/prompt15-r3-validation.mjs'),fileIdentity(`${output}/input-summary.json`),...readJSON(`${output}/input-summary.json`).artifacts.map(a=>({...a,path:`${output}/${a.path}`})),...world.geometryArtifacts.map(a=>({...a,path:`${output}/${a.path}`})),...['catalog.json','membership.json','residual-membership.json','metadata.json','inheritance-state-fixture.json'].map(n=>fileIdentity(`${output}/world/${n}`))];
fs.writeFileSync(path.join(output,'independent-validation.json'),jsonBytes(result));if(result.status!=='pass')process.exitCode=1;
