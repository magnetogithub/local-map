// Reproducible Prompt 15 checkpoints A. All output stays in reports/prompt15.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import polygonClipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import {digest,jsonBytes,polygons,geometryMetadata} from './prompt14-catalog-core.mjs';
import {verifyCatalogArtifactBytes} from './prompt14-catalog-artifacts.mjs';
import {selectGameInputs,hasSourceBoundaryContact,splitResidualBySharedBoundaries} from './prompt14-game-selection.mjs';
import {resolveAdmin1Parents} from './prompt14-source-gate.mjs';

const out='reports/prompt15';fs.mkdirSync(out,{recursive:true});
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const identity=p=>{const b=fs.readFileSync(p);return {path:p,sha256:digest(b),byteLength:b.length};};
const write=(name,data)=>{const p=`${out}/${name}`;fs.writeFileSync(p,jsonBytes(data));return identity(p);};
const freezePath='data/catalogs/prompt14/frozen-catalog-ref.json',freeze=read(freezePath),base=path.dirname(freeze.artifactIndex.path);
const index=read(freeze.artifactIndex.path),build=`${base}/build-only/${freeze.ref.catalogVersion}`;
const rawPath='data/derived/prompt14/shared-admin1-input.geojson',p0Path='data/derived/prompt14/shared-game-p0.geojson',selectedPath='data/derived/prompt14/selected-game-input.geojson';
const raw=read(rawPath),p0=read(p0Path),selected=read(selectedPath),catalog=read(`${build}/catalog.json`),geometry=read(`${build}/geometry.geojson`),topology=read(`${build}/topology.json`);
const metadata=read('src/data/countries-2020.json'),selection=read('reports/prompt14/14-02-game-input-selection.json');
const parents=resolveAdmin1Parents(raw,p0.features.map(f=>f.properties.countryId),metadata);
const sourceId=f=>String(f.properties.ne_id??f.properties.NE_ID);
const idsFor=e=>e.provenanceIds.flatMap(id=>catalog.provenanceById[id].sourceId==='natural-earth-admin1-states-provinces-10m'?[catalog.provenanceById[id].sourceFeatureId]:[]);
const geoById=new Map(geometry.features.map(f=>[f.properties.territoryId,f]));

if(process.argv[2]==='baseline'){
 const started=performance.now();
 const preservedPaths=[freezePath,freeze.artifactIndex.path,'data/source-locks/prompt14-derived-game-input-lock.json',rawPath,p0Path,selectedPath,
  'data/raw/ne_10m_admin_0_countries.geojson','data/raw/ne_10m_admin_1_states_provinces.geojson','src/data/countries-2020.json',
  'reports/prompt14/14-02-game-input-selection.json','reports/prompt14/14-02-source-arrangement-evidence.json',
  `${base}/migration-pair.json`,`${base}/migration-mapping.json`].filter(p=>fs.existsSync(p));
 const lock=read('data/source-locks/prompt14-derived-game-input-lock.json');
 const lockChecks=[...lock.artifacts,...lock.lineageInputs].map(a=>({...identity(a.repositoryPath),expected:{sha256:a.sha256,byteLength:a.byteLength},pass:digest(fs.readFileSync(a.repositoryPath))===a.sha256&&fs.statSync(a.repositoryPath).size===a.byteLength}));
 const frozenChecks=index.artifacts.map(a=>{const actual=identity(`${base}/${a.path}`);return {...actual,expected:a,pass:actual.sha256===a.sha256&&actual.byteLength===a.byteLength};});
 const publicChecks=index.artifacts.filter(a=>a.path.startsWith('public/')).map(a=>{const actual=identity(a.path);return {...actual,expected:a,pass:actual.sha256===a.sha256&&actual.byteLength===a.byteLength};});
 const verified=verifyCatalogArtifactBytes(base);
 const countries=metadata.map(c=>{
  const sources=raw.features.filter((f,i)=>parents.entries[i].normalizedParentCountryId===c.id&&!parents.entries[i].excluded);
  const sourceIds=sources.map(sourceId).sort(),chosen=selected.features.filter(f=>f.properties.countryId===c.id),entries=catalog.entries.filter(e=>e.sourceCountryId===c.id);
  const membership=sourceIds.map(id=>({sourceFeatureId:id,name:sources.find(f=>sourceId(f)===id).properties.name,selected:chosen.some(f=>f.properties.sourceFeatureId===id&&f.properties.inputRole==='P1'),territoryIds:entries.filter(e=>idsFor(e).includes(id)).map(e=>e.id)}));
  const stored=selection.countries.find(x=>x.countryId===c.id);
  return {countryId:c.id,sourceAdministrativeIdentityCount:sourceIds.length,selectedAdministrativeIdentityCount:membership.filter(x=>x.selected).length,
   catalogAdministrativeIdentityCount:membership.filter(x=>x.territoryIds.length).length,selectedFeatureCount:chosen.length,territoryCount:entries.length,
   selection:stored?.selection??null,fallbackReason:stored?.reason??null,lostSourceFeatureIds:membership.filter(x=>!x.territoryIds.length).map(x=>x.sourceFeatureId),
   withinAdministrativePartialOccupationPossible:membership.some(x=>x.territoryIds.length>1),membership,
   singleSourceRegion:sourceIds.length===1,standaloneSourceComponentCount:chosen.filter(f=>f.properties.inputRole==='P0-source-component').length};
 });
 const idCountry=new Map(catalog.entries.map(e=>[e.id,e.sourceCountryId]));
 const borderIds=new Set();for(const e of topology.edges){if(idCountry.get(e.leftTerritoryId)==='PRK'&&idCountry.get(e.rightTerritoryId)==='KOR')borderIds.add(e.leftTerritoryId);if(idCountry.get(e.rightTerritoryId)==='PRK'&&idCountry.get(e.leftTerritoryId)==='KOR')borderIds.add(e.rightTerritoryId);}
 const north=[...borderIds].sort().map(id=>{const e=catalog.entries.find(e=>e.id===id);return {territoryId:id,sourceCountryId:e.sourceCountryId,sourceFeatureIds:idsFor(e),administrativeNames:idsFor(e).map(id=>raw.features.find(f=>sourceId(f)===id)?.properties.name),geometryIdentity:{sha256:digest(jsonBytes(geoById.get(id).geometry)),...geometryMetadata(geoById.get(id).geometry)},geometry:geoById.get(id).geometry};});
 const contracts={
  world:{path:'src/lib/world/world-state-v3.ts',contract:'Immutable catalogRef/sourceCountryId; ownerCountryId/controllerCountryId mutable per territory; world revision'},
  seed:{path:'src/lib/world/production-catalog-seed.server.ts',contract:'Approved migration pair SHA; revision 0 world/simulation, 2020-01-01; fresh seed on reload, no new persistence'},
  simulation:{path:'src/lib/simulation/catalog-runtime.ts',contract:'Atomic world/simulation pair commit and snapshot undo/redo bound to one catalog'},
  authority:{path:'src/lib/simulation/catalog-authority-lifecycle.ts',contract:'Host validates territorial authority scope and current owner/controller before planning effects'},
  regions:{path:'src/lib/simulation/catalog-region.server.ts',contract:'Raw NE administrative names + catalog provenance => region membership; never substitutes TerritoryId for subdivisionId'},
  regionCaps:{path:'src/lib/simulation/catalog-region.ts',contract:'Record membership <=512; per request/aggregate <=512 territories; <=8 region refs; reject overflow'},
  tools:{path:'src/lib/simulation/server/simulation-tools.ts',contract:'Strict additionalProperties=false; border/region cap 1..512; border lookup uses fixed source adjacency, no qualitative depth/current-frontier expansion'},
  provider:{path:'src/lib/simulation/server/openai-responses-provider.ts',contract:'8 ordinary iterations, 12 calls, reserved submit+single repair; output 8000 tokens; timeout 120000ms, retry 1; rate-limit/timeout/error distinguished'},
  providerConfig:{path:'src/lib/simulation/server/provider-config.ts',contract:'Read server configuration; secrets excluded from audit'},
  migration:{path:'src/lib/test-only/production-catalog-migration.ts',contract:'Existing V2-to-V3 seed migration proof; no new operational one-to-many migration exists'},
  projection:{path:'src/lib/projection/catalog-map-consumer-projection.ts',contract:'Catalog-root matched metadata; controller fill and edge frontier state derive from authoritative territory state'},
  delivery:{path:'src/lib/map/catalog-consumer.server.ts',contract:'Root/hash/byte validation; 5461 z0..6 tiles; full geometry/topology build-only'},
  map:{path:'src/components/map/WorldMap.tsx',contract:'Inspect existing catalog layer visibility before changing zoom rules'},
 };
 const contractEvidence=Object.fromEntries(Object.entries(contracts).map(([k,v])=>[k,{...v,file:identity(v.path)}]));
 const findings={countries:countries.length,sourceAdministrativeIdentities:countries.reduce((n,c)=>n+c.sourceAdministrativeIdentityCount,0),catalogTerritories:catalog.entries.length,
  lostAdministrativeIdentities:countries.reduce((n,c)=>n+c.lostSourceFeatureIds.length,0),fallbackCountries:countries.filter(c=>c.selection==='P0-fallback').map(c=>c.countryId),
  internallyDividedAdministrativeIdentities:countries.flatMap(c=>c.membership).filter(m=>m.territoryIds.length>1).length};
 const freezeIndexIdentityMatches=identity(freeze.artifactIndex.path).sha256===freeze.artifactIndex.sha256;
 const sourceLockIdentityMatches=identity('data/source-locks/prompt14-derived-game-input-lock.json').sha256===freeze.sourceLockSha256;
 const legacyReports=fs.readdirSync('reports/prompt14',{recursive:true}).filter(p=>fs.statSync(path.join('reports/prompt14',p)).isFile()).map(p=>identity(path.join('reports/prompt14',p).replaceAll('\\','/')));
 const artifactEvidence=write('15-01-artifact-byte-audit.json',{frozenChecks,publicChecks,lockChecks,verified,legacyReports,freezeIndexIdentityMatches,sourceLockIdentityMatches});
 const status=[...frozenChecks,...publicChecks,...lockChecks].every(x=>x.pass)&&freezeIndexIdentityMatches&&sourceLockIdentityMatches?'pass':'fail';
 write('15-01-baseline.json',{checkpoint:'15-1',status,scope:'Current bytes and country source-identity loss audit; pass means audit completed, not Prompt 15 functionality',command:'node scripts/audit-prompt15.mjs baseline',tools:{node:process.version,jsts:read('node_modules/jsts/package.json').version,polygonClipping:read('node_modules/polygon-clipping/package.json').version},
  inputs:preservedPaths.map(identity),frozenCatalog:freeze,artifactEvidence,findings,countries,northKoreaBorder:{algorithmSource:identity('src/lib/simulation/catalog-border-lookup.ts'),scope:'Exact replay of current border adjacency algorithm from frozen topology; real function execution captured separately in 15-01-runtime-audit.json',territories:north},contractEvidence,
  performance:{offlineAuditMs:performance.now()-started,memory:process.memoryUsage(),browserRenderAndAPI:'Not measured in checkpoint A; measure candidates in 15-3 and real runtime in 15-7/15-8'},
  dirtyAtTaskStart:[],workingScope:['scripts/prompt15-*','scripts/audit-prompt15.mjs','reports/prompt15/'],historicalReportDisagreements:lockChecks.filter(x=>!x.pass),
  next:'15-2: reproduce historical SVN selection, validate recovery without publishing or widening tolerance'});
 console.log(JSON.stringify({checkpoint:'15-1',status,findings}));
}else if(process.argv[2]==='recovery'){
 const baseline=read(`${out}/15-01-baseline.json`),history='data/derived/prompt14/history/review-c-v1';
 const hp0=read(`${history}/${p0Path}`),hraw=read(`${history}/${rawPath}`);
 const hparents=resolveAdmin1Parents(hraw,hp0.features.map(f=>f.properties.countryId),metadata);
 const historical=selectGameInputs({type:'FeatureCollection',features:hp0.features.filter(f=>f.properties.countryId==='SVN')},hraw,hparents,metadata.filter(c=>c.id==='SVN'));
 const reproduction=historical.countries[0];
 const localRaw=hraw.features.filter((f,i)=>hparents.entries[i].normalizedParentCountryId==='SVN');
 const union=polygonClipping.union(...localRaw.map(f=>polygons(f.geometry)));
 const gap={type:'MultiPolygon',coordinates:polygonClipping.difference(polygons(hp0.features.find(f=>f.properties.countryId==='SVN').geometry),union)};
 const historicalBase=hp0.features.find(f=>f.properties.countryId==='SVN').geometry;
 const alignmentReferences=localRaw.map(f=>({type:'Feature',properties:{sourceFeatureId:sourceId(f)},geometry:{type:'MultiPolygon',coordinates:polygonClipping.intersection(polygons(f.geometry),polygons(historicalBase))}}));
 const adjacent=alignmentReferences.flatMap((f,i)=>hasSourceBoundaryContact(gap,f.geometry)?[i]:[]);
 const split=splitResidualBySharedBoundaries(gap,alignmentReferences,adjacent);
 const geoReader=new GeoJSONReader(),skipThreshold=reproduction.before.tolerance/gap.coordinates.length;
 const splitSkipProof={originalResidualCount:gap.coordinates.length,adjacentSourceFeatureIds:adjacent.map(i=>alignmentReferences[i].properties.sourceFeatureId),
  sharedBoundaryCount:split.sharedBoundaryCount,perFragmentSkipThreshold:skipThreshold,fragments:split.fragments.map(g=>({geometry:g,areaDegreesSquared:geoReader.read(g).getArea(),skippedByOldLoop:geoReader.read(g).getArea()<=skipThreshold}))};
 splitSkipProof.totalSplitArea=splitSkipProof.fragments.reduce((n,f)=>n+f.areaDegreesSquared,0);
 splitSkipProof.rootCauseVerified=splitSkipProof.fragments.every(f=>f.skippedByOldLoop)&&splitSkipProof.totalSplitArea>reproduction.before.tolerance;
 const gapIdentity=write('15-02-svn-gap.geojson',{type:'FeatureCollection',features:[{type:'Feature',properties:{role:'Actual fixed P0 minus pinned source P1',units:'degrees squared'},geometry:gap}]});
 const outcomes=[];
 for(const countryId of baseline.findings.fallbackCountries){
  console.log(`Candidate ${countryId}`);
  const execution=spawnSync(process.execPath,['scripts/prompt15-recovery-candidate.mjs',countryId,'first'],{encoding:'utf8',maxBuffer:16*1024*1024});
  const log=write(`15-02-${countryId}-execution.json`,{command:`node scripts/prompt15-recovery-candidate.mjs ${countryId} first`,exitCode:execution.status,stdout:execution.stdout,stderr:execution.stderr,error:execution.error?.message??null});
  if(execution.status!==0)throw Error(`Candidate runner failed: ${countryId}`);
  const candidatePath=`${out}/candidates/${countryId}-first.json`,candidate=read(candidatePath);
  outcomes.push({countryId,status:candidate.status,sourceIdentityCount:candidate.sourceIdentityCount,checks:candidate.checks??null,reason:candidate.reason??null,unresolvedFaceCount:candidate.evidence?.unresolved?.length??0,artifact:identity(candidatePath),execution:log,
   recoveryPlan:candidate.status==='pass'?'Use this identity-preserving administrative candidate in 15-4 common WORLD arrangement; global boundary/components/membership/independent-generation hard gates remain mandatory':candidate.sourceIdentityCount===0?'Retain source-backed unsplit country exception; do not invent administrative identity':'Keep deployment; diagnose recorded ambiguous/source geometry faces or component/hole/area/boundary failures from pinned sources. No whole-country replacement is allowed in new candidate. Fail 15-4 until resolved or source-backed exception established',
   rolloutBlock:candidate.status!=='pass'&&candidate.sourceIdentityCount>0});
 }
 const secondRun=spawnSync(process.execPath,['scripts/prompt15-recovery-candidate.mjs','SVN','second'],{encoding:'utf8',maxBuffer:16*1024*1024});
 if(secondRun.status!==0)throw Error('Second independent SVN process failed');
 write('15-02-SVN-independent-execution.json',{command:'node scripts/prompt15-recovery-candidate.mjs SVN second',exitCode:secondRun.status,stdout:secondRun.stdout,stderr:secondRun.stderr});
 const a=fs.readFileSync(`${out}/candidates/SVN-first.json`),b=fs.readFileSync(`${out}/candidates/SVN-second.json`),svn=JSON.parse(a);
 const independent={pass:a.equals(b),first:identity(`${out}/candidates/SVN-first.json`),second:identity(`${out}/candidates/SVN-second.json`),scope:'Two fresh Node processes, entire administrative candidate and evidence bytes; operational/world artifacts not generated'};
 const previous=selection.countries.find(c=>c.countryId==='SVN');
 const reasonMatches=reproduction.reason===previous.reason;
 const tinyTriangle=gap.coordinates[0]?.[0];
 const height=tinyTriangle&&Math.abs((tinyTriangle[1][0]-tinyTriangle[0][0])*(tinyTriangle[2][1]-tinyTriangle[0][1])-(tinyTriangle[1][1]-tinyTriangle[0][1])*(tinyTriangle[2][0]-tinyTriangle[0][0]))/Math.hypot(tinyTriangle[1][0]-tinyTriangle[0][0],tinyTriangle[1][1]-tinyTriangle[0][1]);
 const byteAudit=read(baseline.artifactEvidence.path);
 const preserved=new Map([...baseline.inputs,...byteAudit.frozenChecks,...byteAudit.publicChecks,...byteAudit.legacyReports].map(a=>[a.path,a]));
 const preservation=[...preserved.values()].map(a=>{const current=identity(a.path);return {path:a.path,pass:a.sha256===current.sha256&&a.byteLength===current.byteLength,before:{path:a.path,sha256:a.sha256,byteLength:a.byteLength},after:current};});
 const status=reproduction.selection==='P0-fallback'&&reproduction.originalP1FeatureCount===193&&reasonMatches&&svn.status==='pass'&&independent.pass&&preservation.every(x=>x.pass)?'pass':'fail';
 write('15-02-recovery.json',{checkpoint:'15-2',status,command:'node scripts/audit-prompt15.mjs recovery',inputs:[identity(`${out}/15-01-baseline.json`),identity(`${history}/${p0Path}`),identity(`${history}/${rawPath}`),identity('scripts/prompt15-recovery-candidate.mjs')],
  reproduction,reasonMatches,gapArtifact:gapIdentity,cause:{classification:'Positive-area source P0/P1 mismatch, not a floating-point equivalence within 1e-12',triangleHeightDegrees:height,existingNumericalDisplacementCeilingDegrees:1e-12,splitSkipProof,
   pipelineFailure:'Old splitting produces two positive faces, each below tolerance divided by the ORIGINAL residual count (1). Both are skipped as tiny debris although their SUM exceeds country coverage tolerance. Final coverage fails and catch replaces all 193 identities with P0. Common arrangement preserves both source-oriented faces.',
   evidence:'Replayed pinned historical inputs; actual difference geometry saved; recovered face geometry, sourceSegment, left/right source identities, numerical displacement and continuous boundary certificates in candidate evidence',
   sourceMeaning:'Pinned Natural Earth source mismatch; no claim of legal boundary defect or current real-world municipal count'},
  recovery:{svnStatus:svn.status,sourceIdentities:svn.sourceIdentityCount,checks:svn.checks,coverage:svn.coverage,adjustmentAreaFraction:svn.adjustmentAreaFraction,independent},allFallbackRecoveryPlan:outcomes,preservation,
  rolloutBlocks:outcomes.filter(o=>o.rolloutBlock).map(o=>o.countryId),next:'REVIEW A; 15-3 resolution experiments only. 15-4/global rollout blocked until all source loss is resolved, with no tolerance increase or guessed ownership.'});
 const runtime=read(`${out}/15-01-runtime-audit.json`);
 const criteria={northKoreaLargeRegionFromCurrentBytes:baseline.northKoreaBorder.territories.length>0&&baseline.findings.internallyDividedAdministrativeIdentities===0,
   actualBorderToolMatchesByteReplay:JSON.stringify(runtime.directBorderTerritoryIds)===JSON.stringify(baseline.northKoreaBorder.territories.map(t=>t.territoryId))&&runtime.status==='pass',svn193To1Reproduced:reproduction.originalP1FeatureCount===193&&reproduction.selectedFeatureCount===1&&reasonMatches,
   gapLocatedAndSourcePreservingCandidateChecked:svn.status==='pass'&&independent.pass,allFallbacksInvestigated:outcomes.length===baseline.findings.fallbackCountries.length,unresolvedAndRolloutBlocksExplicit:true,originalDeploymentPreserved:preservation.every(x=>x.pass)},
  reviewStatus=status==='pass'&&baseline.status==='pass'&&Object.values(criteria).every(Boolean)?'pass':'fail';
 write('15-REVIEW-A.json',{review:'A',status:reviewStatus,evidence:[identity(`${out}/15-01-baseline.json`),identity(`${out}/15-01-runtime-audit.json`),identity(`${out}/15-02-recovery.json`)],criteria,
  interpretation:'Checkpoint A investigation and recovery proof only; some other countries remain blocked. REVIEW C/global catalog rollout and Prompt 15 final completion are not approved.',resumeAt:'15-3',productionCutover:false});
 console.log(JSON.stringify({checkpoint:'15-2',status,svn:svn.status,independent:independent.pass,outcomes:outcomes.map(o=>({country:o.countryId,status:o.status})),rolloutBlocks:outcomes.filter(o=>o.rolloutBlock).map(o=>o.countryId)}));
}else throw Error('Usage: node scripts/audit-prompt15.mjs baseline|recovery');
