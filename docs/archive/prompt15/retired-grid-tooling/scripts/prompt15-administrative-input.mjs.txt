// Prompt 15 task 15-18 only: immutable administrative-restoration and protected-overlay inputs.
// This module does not generate operational cells and never changes a production/catalog reference.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {normalizeGeometry,polygons,hashCanonical,jsonBytes,digest,canonical,compareText} from './prompt14-catalog-core.mjs';
import {resolveAdmin1Parents,UPSTREAM_RELEASE} from './prompt14-source-gate.mjs';
import {readJSON,fileIdentity,physicalAreaKm2} from './prompt15-cell-core.mjs';
import {union} from './prompt15-r3-input.mjs';
import {overlay} from './prompt15-world-preflight.mjs';

export const TASK_15_18_VERSION='prompt15-task-15-18-administrative-input-v1';
const SOURCE_DATASET='natural-earth-admin1-states-provinces-10m';
const REVIEW_B='reports/prompt15/15-REVIEW-B.json';
const REVIEW_B_RECHECK='reports/prompt15/15-review-b-recheck.json';
const POLICY_DECISION='reports/prompt15/15-03-policy-decision.json';
const POLICY_VALIDATION='reports/prompt15/15-03-validation.json';
const BASELINE='reports/prompt15/15-01-baseline.json';
const LOSS_AUDIT='reports/prompt15/15-02-recovery.json';
const POLICY_ID='adaptive-12-24-v6';
const RESTORATION_15_09={
 first:{path:'reports/prompt15/candidates/SVN-first.json',byteLength:377427,sha256:'d5f65613df08524c223cecacc0c0b0b5ce04c822b92d1c3095881573c624adab'},
 second:{path:'reports/prompt15/candidates/SVN-second.json',byteLength:377427,sha256:'d5f65613df08524c223cecacc0c0b0b5ce04c822b92d1c3095881573c624adab'},
};
const reader=new GeoJSONReader();

const shape=geometry=>({components:polygons(geometry).length,holes:polygons(geometry).reduce((n,p)=>n+p.length-1,0)});
const validGeometry=geometry=>{try{return new IsValidOp(reader.read(geometry)).isValid();}catch{return false;}};
const idsWithDuplicates=values=>{const seen=new Set(),duplicates=new Set();for(const value of values)(seen.has(value)?duplicates:seen).add(value);return [...duplicates].sort(compareText);};
const difference=(expected,actual)=>[...expected].filter(value=>!actual.has(value)).sort(compareText);
const packageVersion=(lock,name)=>lock.packages?.[`node_modules/${name}`]?.version??null;
const writeJSON=(target,value)=>fs.writeFileSync(target,jsonBytes(value));

function assertCurrentPrerequisites(){
 const review=readJSON(REVIEW_B),recheck=readJSON(REVIEW_B_RECHECK),decision=readJSON(POLICY_DECISION),validation=readJSON(POLICY_VALIDATION);
 const decisionIdentity=fileIdentity(POLICY_DECISION),policyIdentity=fileIdentity(decision.policy.path);
 const failures=[];
 if(review.status!=='pass'||review.review!=='B'||review.selectedCandidate!==POLICY_ID||review.resumeAt!=='15-18')failures.push('current REVIEW B does not authorize 15-18');
 if(recheck.status!=='pass'||recheck.review!=='B'||recheck.selectedCandidate!==POLICY_ID||recheck.resumeAt!=='15-18')failures.push('current REVIEW B recheck does not authorize 15-18');
 if(decision.status!=='pass'||decision.selectedCandidate!==POLICY_ID)failures.push('current policy decision is not adaptive-12-24-v6 PASS');
 if(validation.status!=='pass')failures.push('current policy validation is not PASS');
 if(review.checkpoint?.sha256!==decisionIdentity.sha256||review.checkpoint?.byteLength!==decisionIdentity.byteLength)failures.push('REVIEW B checkpoint does not match current policy-decision bytes');
 if(decision.policy?.sha256!==policyIdentity.sha256||decision.policy?.byteLength!==policyIdentity.byteLength)failures.push('policy decision does not match current v6 policy bytes');
 if(failures.length)throw Error(`15-18 prerequisite failure: ${failures.join('; ')}`);
 return {review:fileIdentity(REVIEW_B),reviewRecheck:fileIdentity(REVIEW_B_RECHECK),policyDecision:decisionIdentity,policyValidation:fileIdentity(POLICY_VALIDATION),policy:policyIdentity,selectedPolicy:POLICY_ID};
}

function readRestoration15_09(){
 const identities={};
 for(const [name,pin] of Object.entries(RESTORATION_15_09)){
  const current=fileIdentity(pin.path);identities[name]=current;
  if(current.byteLength!==pin.byteLength||current.sha256!==pin.sha256)throw Error(`15-18 prerequisite failure: 15-09 ${name} evidence bytes changed`);
 }
 const candidate=readJSON(RESTORATION_15_09.first.path),second=readJSON(RESTORATION_15_09.second.path),checks=candidate.checks??{};
 if(candidate.status!=='pass'||candidate.countryId!=='SVN'||candidate.sourceIdentityCount!==193||candidate.selected?.features?.length!==193||candidate.evidence?.unresolved?.length!==0||!Object.values(checks).every(Boolean))throw Error('15-18 prerequisite failure: current 15-09 SVN restoration is not a complete 193-identity PASS');
 if(candidate.geometrySha256!==second.geometrySha256||candidate.topologySha256!==second.topologySha256||identities.first.sha256!==identities.second.sha256)throw Error('15-18 prerequisite failure: independent 15-09 generations are not byte-identical');
 if(candidate.evidence?.policy?.taskId!=='15-08'||candidate.evidence.policy.version!=='prompt15-administrative-restoration-policy-v2')throw Error('15-18 prerequisite failure: 15-09 candidate is not bound to the reset 15-08 v2 policy');
 const ids=candidate.selected.features.map(feature=>String(feature.properties.sourceFeatureId));if(new Set(ids).size!==193)throw Error('15-18 prerequisite failure: 15-09 candidate contains duplicate SVN source identities');
 return {candidate,identities};
}

function componentCorrespondence(source,result){
 // Canonical ordering is required before positional correspondence: raw MultiPolygon
 // component order is not an identity and can differ from the normalized result order.
 const sourcePolygons=polygons(normalizeGeometry(source)),resultPolygons=polygons(result);
 return sourcePolygons.map((coordinates,index)=>{
  const sourceGeometry=normalizeGeometry({type:'Polygon',coordinates}),resultCoordinates=resultPolygons[index],resultGeometry=resultCoordinates?normalizeGeometry({type:'Polygon',coordinates:resultCoordinates}):null;
  const sourceHoles=coordinates.length-1,resultHoles=resultCoordinates?resultCoordinates.length-1:0;
  return {sourceComponentIndex:index,resultComponentIndex:resultCoordinates?index:null,sourceGeometrySha256:digest(jsonBytes(sourceGeometry)),resultGeometrySha256:resultGeometry?digest(jsonBytes(resultGeometry)):null,sourceHoles,resultHoles,status:!resultGeometry?'missing':resultHoles===sourceHoles?'preserved':resultHoles>sourceHoles?'preserved-with-source-topology-repair':'hole-loss'};
 });
}

function makeReferences(sourceFeatures,parents,protectedFeatures,envelopes,priorLostIds,excludedSelectedById=new Map()){
 const sourceCountries=new Map(),sourceGeometryHashes=new Map(),sourceShapes=new Map();
 sourceFeatures.forEach((feature,index)=>{const id=String(feature.properties.ne_id),parent=parents.entries[index];if(parent.excluded)return;sourceCountries.set(id,parent.normalizedParentCountryId);sourceGeometryHashes.set(id,digest(jsonBytes(feature.geometry)));sourceShapes.set(id,shape(feature.geometry));});
 const excludedCountries=new Map(),excludedGeometryHashes=new Map();sourceFeatures.forEach((feature,index)=>{const parent=parents.entries[index];if(!parent.excluded)return;const id=String(feature.properties.ne_id),selected=excludedSelectedById.get(id);excludedCountries.set(id,selected?.properties.sourceCountryId??null);excludedGeometryHashes.set(id,digest(jsonBytes(feature.geometry)));});
 const protectedCountries=new Map(),protectedGeometryHashes=new Map(),protectedShapes=new Map();
 for(const feature of protectedFeatures){const id=feature.properties.territoryId;protectedCountries.set(id,feature.properties.sourceCountryId);protectedGeometryHashes.set(id,digest(jsonBytes(feature.geometry)));protectedShapes.set(id,shape(feature.geometry));}
 return {sourceCountries,sourceGeometryHashes,sourceShapes,excludedCountries,excludedGeometryHashes,protectedCountries,protectedGeometryHashes,protectedShapes,envelopeCountries:new Set(envelopes.map(f=>f.properties.countryId)),priorLostIds:new Set(priorLostIds)};
}

export function auditRestorationBundle(bundle,references){
 const problems={missingSourceIdentities:[],duplicateSourceIdentities:[],unexpectedSourceIdentities:[],missingExcludedSourceIdentities:[],duplicateExcludedSourceIdentities:[],unexpectedExcludedSourceIdentities:[],excludedSourceCorrespondence:[],duplicateRestorationIdentities:[],missingRestorationFeatures:[],duplicateRestorationFeatures:[],wrongCountry:[],invalidGeometry:[],componentOrHoleLoss:[],missingProtectedTerritories:[],duplicateProtectedTerritories:[],unexpectedProtectedTerritories:[],invalidProtectedGeometry:[],protectedCorrespondence:[],parentKindConfusion:[],missingLossAuditItems:[],duplicateLossAuditItems:[],invalidResiduals:[],duplicateResiduals:[],unresolved:[],arbitraryCountryFallback:[]};
 const traces=bundle.sourceIdentityTrace,sourceIds=traces.map(t=>t.source.identity),sourceSet=new Set(sourceIds),expectedSourceSet=new Set(references.sourceCountries.keys());
 problems.missingSourceIdentities=difference(expectedSourceSet,sourceSet);problems.unexpectedSourceIdentities=difference(sourceSet,expectedSourceSet);problems.duplicateSourceIdentities=idsWithDuplicates(sourceIds);
 problems.duplicateRestorationIdentities=idsWithDuplicates(traces.map(t=>t.result.identity));
 const featuresBySource=new Map();for(const feature of bundle.administrativeRestoration.features){const id=feature.properties.sourceFeatureId,list=featuresBySource.get(id)??[];list.push(feature);featuresBySource.set(id,list);}
 for(const trace of traces){const id=trace.source.identity,features=featuresBySource.get(id)??[];if(!features.length)problems.missingRestorationFeatures.push(id);if(features.length>1)problems.duplicateRestorationFeatures.push(id);
  const expectedCountry=references.sourceCountries.get(id),feature=features[0];if(trace.sourceCountryId!==expectedCountry||feature?.properties.sourceCountryId!==expectedCountry)problems.wrongCountry.push({id,expectedCountry,traceCountry:trace.sourceCountryId,featureCountry:feature?.properties.sourceCountryId??null});
  if(trace.source.geometrySha256!==references.sourceGeometryHashes.get(id))problems.protectedCorrespondence.push({kind:'source-original-hash',id});
  if(feature&&(!validGeometry(feature.geometry)||digest(jsonBytes(feature.geometry))!==trace.result.geometrySha256))problems.invalidGeometry.push(id);
  if(trace.result.shape.components<trace.source.shape.components||trace.result.shape.holes<trace.source.shape.holes||trace.components.some(c=>c.status==='missing'||c.status==='hole-loss'))problems.componentOrHoleLoss.push(id);
  if(trace.result.parentKind!=='administrative'||trace.result.previousTerritoryParentId!==null)problems.parentKindConfusion.push({kind:'administrative',id});
 }
 for(const [countryId,summary] of Object.entries(bundle.countrySummary)){if(summary.sourceIdentityCount>1&&summary.restorationIdentityCount<=1)problems.arbitraryCountryFallback.push(countryId);}
 const excluded=bundle.excludedSourceTrace??[],excludedIds=excluded.map(t=>t.source.identity),excludedSet=new Set(excludedIds),expectedExcludedSet=new Set(references.excludedCountries?.keys()??[]);
 problems.missingExcludedSourceIdentities=difference(expectedExcludedSet,excludedSet);problems.unexpectedExcludedSourceIdentities=difference(excludedSet,expectedExcludedSet);problems.duplicateExcludedSourceIdentities=idsWithDuplicates(excludedIds);
 for(const trace of excluded){const id=trace.source.identity;if(trace.source.geometrySha256!==references.excludedGeometryHashes?.get(id)||trace.selectedInputCountryId!==references.excludedCountries?.get(id)||trace.classification!=='explicit-excluded-map-unit-lineage'||!trace.selectedInputGeometrySha256)problems.excludedSourceCorrespondence.push(id);}
 for(const item of bundle.unresolved)problems.unresolved.push(item);
 for(const trace of traces)if(trace.disposition==='unresolved')problems.unresolved.push({kind:'source-identity',id:trace.source.identity});
 const protectedIds=bundle.protectedOverlayTrace.map(t=>t.previousTerritoryId),protectedSet=new Set(protectedIds),expectedProtectedSet=new Set(references.protectedCountries.keys());
 problems.missingProtectedTerritories=difference(expectedProtectedSet,protectedSet);problems.unexpectedProtectedTerritories=difference(protectedSet,expectedProtectedSet);problems.duplicateProtectedTerritories=idsWithDuplicates(protectedIds);
 const protectedFeatures=new Map(bundle.protectedOverlay.features.map(f=>[f.properties.territoryId,f]));
 for(const trace of bundle.protectedOverlayTrace){const id=trace.previousTerritoryId,feature=protectedFeatures.get(id),expectedCountry=references.protectedCountries.get(id),expectedHash=references.protectedGeometryHashes.get(id);
  if(!feature||trace.sourceCountryId!==expectedCountry||feature.properties.sourceCountryId!==expectedCountry||trace.geometrySha256!==expectedHash||digest(jsonBytes(feature.geometry))!==expectedHash||trace.shape.components<1)problems.protectedCorrespondence.push({kind:'protected-overlay',id});
  if(!feature||!validGeometry(feature.geometry))problems.invalidProtectedGeometry.push(id);
  if(trace.parentKind!=='previous-territory'||trace.administrativeParentId!==null)problems.parentKindConfusion.push({kind:'protected',id});
 }
 const lossIds=bundle.lossAudit.map(item=>item.sourceFeatureId);problems.duplicateLossAuditItems=idsWithDuplicates(lossIds);problems.missingLossAuditItems=difference(references.priorLostIds,new Set(lossIds));
 for(const item of bundle.lossAudit)if(item.status!=='resolved'||!sourceSet.has(item.sourceFeatureId))problems.unresolved.push({kind:'prior-loss',id:item.sourceFeatureId,status:item.status});
 const residualIds=bundle.residuals.features.map(feature=>feature.properties?.residualId);problems.duplicateResiduals=idsWithDuplicates(residualIds);
 for(const feature of bundle.residuals.features){const properties=feature.properties??{},countryId=properties.countryId;if(!references.envelopeCountries.has(countryId)||properties.sourceCountryId!==countryId||properties.classification!=='country-envelope-remainder'||properties.parentKind!=='country-envelope'||properties.administrativeIdentity!==null||properties.assignmentStatus!=='resolved-country-envelope-parent'||!properties.residualId||!validGeometry(feature.geometry))problems.invalidResiduals.push(properties.residualId??countryId??'unknown');}
 for(const item of bundle.fallbacks)if(item.classification!=='source-backed-zero-administrative-input')problems.arbitraryCountryFallback.push(item.countryId);
 for(const values of Object.values(problems))if(Array.isArray(values))values.sort((a,b)=>compareText(typeof a==='string'?a:canonical(a),typeof b==='string'?b:canonical(b)));
 const counts={rawSourceExpected:expectedSourceSet.size+expectedExcludedSet.size,rawSourceAccounted:sourceSet.size+excludedSet.size,sourceExpected:expectedSourceSet.size,sourceTraced:sourceSet.size,excludedSourceExpected:expectedExcludedSet.size,excludedSourceTraced:excludedSet.size,restorationFeatures:bundle.administrativeRestoration.features.length,protectedExpected:expectedProtectedSet.size,protectedTraced:protectedSet.size,priorLostExpected:references.priorLostIds.size,priorLostClassified:new Set(lossIds).size,residuals:bundle.residuals.features.length,fallbacks:bundle.fallbacks.length,unresolved:problems.unresolved.length};
 return {status:Object.values(problems).every(values=>values.length===0)?'pass':'fail',counts,problems};
}

export function buildRestorationBundle(){
 const prerequisites=assertCurrentPrerequisites(),restoration15_09=readRestoration15_09(),rawPath='data/raw/ne_10m_admin_1_states_provinces.geojson',preparedPath='data/derived/prompt14/shared-admin1-input.geojson',p0Path='data/derived/prompt14/shared-game-p0.geojson';
 const selectedPath='data/derived/prompt14/selected-game-input.geojson',raw=readJSON(rawPath),prepared=readJSON(preparedPath),selected=readJSON(selectedPath),p0=readJSON(p0Path),metadata=readJSON('src/data/countries-2020.json'),sourceLock=readJSON('data/source-locks/prompt14-derived-game-input-lock.json'),baseline=readJSON(BASELINE),packageLock=readJSON('package-lock.json');
 if(fileIdentity(rawPath).sha256!==UPSTREAM_RELEASE.admin1Sha256)throw Error('Pinned Natural Earth Admin-1 source hash mismatch');
 if(baseline.status!=='pass'||baseline.findings?.sourceAdministrativeIdentities!==4591||baseline.findings?.lostAdministrativeIdentities!==394)throw Error('Current Prompt 14/15 loss audit no longer reports source=4591 and lost=394');
 const parents=resolveAdmin1Parents(raw,p0.features.map(f=>f.properties.countryId),metadata),preparedById=new Map(prepared.features.map(f=>[String(f.properties.ne_id),f])),svnRestoredById=new Map(restoration15_09.candidate.selected.features.map(f=>[String(f.properties.sourceFeatureId),f])),selectedById=new Map(selected.features.filter(f=>f.properties.inputRole==='P1').map(f=>[String(f.properties.sourceFeatureId),f]));
 const freeze=readJSON('data/catalogs/prompt14/frozen-catalog-ref.json'),oldRoot=path.join(path.dirname(freeze.artifactIndex.path),'build-only',freeze.ref.catalogVersion),oldPath=path.join(oldRoot,'geometry.geojson'),old=readJSON(oldPath);
 const sourceIdentityTrace=[],restoredFeatures=[],countrySummary=Object.fromEntries(p0.features.map(f=>[f.properties.countryId,{sourceIdentityCount:0,restorationIdentityCount:0,priorLostIdentityCount:0,residualCount:0,residualAreaKm2:0,protectedTerritoryCount:0,exception:null}]));
 const priorLostIds=baseline.countries.flatMap(country=>country.lostSourceFeatureIds),priorLostSet=new Set(priorLostIds);
 raw.features.forEach((feature,index)=>{const parent=parents.entries[index];if(parent.excluded)return;const id=String(feature.properties.ne_id),countryId=parent.normalizedParentCountryId,resultSource=countryId==='SVN'?svnRestoredById.get(id):preparedById.get(id);if(!resultSource)throw Error(`Missing prepared/restored geometry for source ${id}`);
  const geometry=normalizeGeometry(resultSource.geometry),sourceShape=shape(feature.geometry),resultShape=shape(geometry),components=componentCorrespondence(feature.geometry,geometry),resultHash=digest(jsonBytes(geometry));
  const restorationId=hashCanonical('prompt15-administrative-restoration.v1',{sourceCountryId:countryId,sourceDataset:SOURCE_DATASET,sourceVersion:sourceLock.sourceVersion,sourceFeatureId:id,resultGeometrySha256:resultHash});
  const disposition=priorLostSet.has(id)?'restored-prior-catalog-loss':'preserved-source-identity',reason=priorLostSet.has(id)?'Restored directly from pinned source identity; prior fallback/catalog omission is not propagated':'Pinned source identity preserved for the next common-refinement build';
  restoredFeatures.push({type:'Feature',properties:{sourceCountryId:countryId,sourceFeatureId:id,sourceVersion:sourceLock.sourceVersion,restorationId,parentKind:'administrative',previousTerritoryParentId:null,resultKind:'source-administrative-geometry',name:feature.properties.name},geometry});
  sourceIdentityTrace.push({sourceCountryId:countryId,source:{dataset:SOURCE_DATASET,identity:id,version:sourceLock.sourceVersion,geometrySha256:digest(jsonBytes(feature.geometry)),preparedGeometrySha256:digest(jsonBytes(resultSource.geometry)),shape:sourceShape},components,result:{identity:restorationId,geometrySha256:resultHash,shape:resultShape,parentKind:'administrative',previousTerritoryParentId:null},disposition,reason,exception:resultShape.holes>sourceShape.holes?'Prepared source topology adds a valid repair hole; no original component or hole was removed':null});
  const summary=countrySummary[countryId];if(!summary)throw Error(`Administrative source ${id} has no fixed P0 country ${countryId}`);summary.sourceIdentityCount++;summary.restorationIdentityCount++;if(priorLostSet.has(id))summary.priorLostIdentityCount++;
 });
 const excludedSourceTrace=raw.features.flatMap((feature,index)=>{const parent=parents.entries[index];if(!parent.excluded)return[];const id=String(feature.properties.ne_id),selectedInput=selectedById.get(id);if(!selectedInput)throw Error(`Excluded/map-unit source ${id} lacks explicit Prompt 14 selected-input lineage`);return[{source:{dataset:SOURCE_DATASET,identity:id,version:sourceLock.sourceVersion,geometrySha256:digest(jsonBytes(feature.geometry)),shape:shape(feature.geometry),rawParentIds:parent.rawParentIds},selectedInputCountryId:selectedInput.properties.sourceCountryId,selectedInputGeometrySha256:digest(jsonBytes(selectedInput.geometry)),classification:'explicit-excluded-map-unit-lineage',reason:parent.exclusionReason,administrativeEligibility:'excluded-from-4591-baseline-gate'}];}).sort((a,b)=>compareText(a.source.identity,b.source.identity));
 sourceIdentityTrace.sort((a,b)=>compareText(a.sourceCountryId,b.sourceCountryId)||compareText(a.source.identity,b.source.identity));restoredFeatures.sort((a,b)=>compareText(a.properties.sourceCountryId,b.properties.sourceCountryId)||compareText(a.properties.sourceFeatureId,b.properties.sourceFeatureId));
 const protectedOverlayTrace=old.features.map(feature=>({sourceCountryId:feature.properties.sourceCountryId,previousTerritoryId:feature.properties.territoryId,geometrySha256:digest(jsonBytes(feature.geometry)),shape:shape(feature.geometry),parentKind:'previous-territory',administrativeParentId:null,reason:'Exact previous catalog territory boundary retained as a separate protected overlay input'})).sort((a,b)=>compareText(a.sourceCountryId,b.sourceCountryId)||compareText(a.previousTerritoryId,b.previousTerritoryId));
 for(const trace of protectedOverlayTrace){const summary=countrySummary[trace.sourceCountryId];if(!summary)throw Error(`Protected territory ${trace.previousTerritoryId} has no fixed P0 country ${trace.sourceCountryId}`);summary.protectedTerritoryCount++;}
 const residualFeatures=[];
 for(const envelope of p0.features.slice().sort((a,b)=>compareText(a.properties.countryId,b.properties.countryId))){const countryId=envelope.properties.countryId,countryAdmin=restoredFeatures.filter(f=>f.properties.sourceCountryId===countryId);if(countryId==='SVN')continue;const residual=countryAdmin.length?overlay('difference',envelope.geometry,overlay('intersection',union(countryAdmin.map(f=>f.geometry)),envelope.geometry).geometry).geometry:normalizeGeometry(envelope.geometry);
  if(polygons(residual).length&&reader.read(residual).getArea()>0){const normalized=normalizeGeometry(residual),residualId=hashCanonical('prompt15-administrative-residual.v1',{countryId,geometry:normalized});residualFeatures.push({type:'Feature',properties:{countryId,sourceCountryId:countryId,residualId,classification:'country-envelope-remainder',parentKind:'country-envelope',administrativeIdentity:null,assignmentStatus:'resolved-country-envelope-parent',reason:'Fixed P0 remainder has no pinned Admin-1 source claim. It remains an explicit country-envelope input and is never guessed onto an administrative identity.'},geometry:normalized});countrySummary[countryId].residualCount++;countrySummary[countryId].residualAreaKm2+=physicalAreaKm2(normalized);}
 }
 const fallbacks=[];for(const [countryId,summary] of Object.entries(countrySummary))if(summary.sourceIdentityCount===0){const item={countryId,classification:'source-backed-zero-administrative-input',reason:'Pinned Admin-1 source contains no accepted identity for this fixed P0 country; preserve explicit residual and protected prior territory without inventing an administrative polygon'};fallbacks.push(item);summary.exception=item;}
 const lossResolution=priorLostIds.slice().sort(compareText).map(id=>{const trace=sourceIdentityTrace.find(item=>item.source.identity===id);return {sourceFeatureId:id,sourceCountryId:trace?.sourceCountryId??null,restorationIdentity:trace?.result.identity??null,status:trace?'resolved':'unresolved',reason:trace?'Pinned source identity is present exactly once; SVN identities use the independently reproduced 15-09 v2 restoration':'Pinned source identity is absent from the new restoration input'};});
 const unresolved=[];
 const bundle={schemaVersion:TASK_15_18_VERSION,policy:{selectedOperationalPolicy:POLICY_ID,selectedOperationalPolicySha256:prerequisites.policy.sha256,administrativeRestoration:'Pinned original identity plus prepared-valid geometry; no tolerance widening, guessed ownership, nearest assignment, or whole-country substitution',protectedOverlay:'Previous territory boundary retained separately; administrative parent and previous-territory parent are different namespaces'},administrativeRestoration:{type:'FeatureCollection',features:restoredFeatures},sourceIdentityTrace,excludedSourceTrace,protectedOverlay:old,protectedOverlayTrace,residuals:{type:'FeatureCollection',features:residualFeatures},fallbacks,unresolved,lossAudit:lossResolution,countrySummary};
 const references=makeReferences(raw.features,parents,old.features,p0.features,priorLostIds,selectedById),audit=auditRestorationBundle(bundle,references);
 const inputs=[rawPath,preparedPath,selectedPath,p0Path,'src/data/countries-2020.json','data/source-locks/prompt14-derived-game-input-lock.json','data/catalogs/prompt14/frozen-catalog-ref.json',freeze.artifactIndex.path,oldPath,BASELINE,LOSS_AUDIT,REVIEW_B,REVIEW_B_RECHECK,POLICY_DECISION,POLICY_VALIDATION,prerequisites.policy.path,...Object.values(RESTORATION_15_09).map(item=>item.path),'scripts/prompt15-recovery-candidate.mjs','package.json','package-lock.json','scripts/prompt15-administrative-input.mjs'].map(fileIdentity);
 const sourceShapeTotals={rawEligible:{components:sourceIdentityTrace.reduce((n,t)=>n+t.source.shape.components,0),holes:sourceIdentityTrace.reduce((n,t)=>n+t.source.shape.holes,0)},preparedEligible:{components:sourceIdentityTrace.reduce((n,t)=>n+t.result.shape.components,0),holes:sourceIdentityTrace.reduce((n,t)=>n+t.result.shape.holes,0)},explicitPreparedTopologyRepairs:sourceIdentityTrace.filter(t=>t.exception).map(t=>({sourceFeatureId:t.source.identity,sourceCountryId:t.sourceCountryId,reason:t.exception,sourceShape:t.source.shape,resultShape:t.result.shape}))};
 const provenance={task:'15-18',generatorVersion:TASK_15_18_VERSION,generator:fileIdentity('scripts/prompt15-administrative-input.mjs'),dependencies:{node:process.version,jsts:packageVersion(packageLock,'jsts'),polygonClipping:packageVersion(packageLock,'polygon-clipping')},command:'node scripts/prompt15-administrative-input.mjs',inputs,prerequisites,restoration15_09:{evidence:restoration15_09.identities,status:restoration15_09.candidate.status,policyVersion:restoration15_09.candidate.evidence.policy.version,sourceIdentityCount:restoration15_09.candidate.sourceIdentityCount,geometrySha256:restoration15_09.candidate.geometrySha256,topologySha256:restoration15_09.candidate.topologySha256,checks:restoration15_09.candidate.checks},sourceVersion:sourceLock.sourceVersion,frozenPreviousCatalog:freeze.ref,baseline:{rawSourceIdentities:4596,eligibleSourceAdministrativeIdentities:4591,explicitExcludedMapUnitLineage:5,lostAdministrativeIdentities:394,countries:247,sourceShapeTotals},scope:'Administrative restoration and protected-overlay input only; unresolved input blocks output. No operational cells, REVIEW C, runtime, API, browser E2E, migration, cutover, or production write'};
 return {bundle,references,audit,provenance,protectedSourcePath:oldPath};
}

export function writeRestorationBundle(build,{outputBase='data/derived/prompt15'}={}){
 if(build.audit.status!=='pass'){
  const issueCounts=Object.fromEntries(Object.entries(build.audit.problems).filter(([,items])=>items.length).map(([name,items])=>[name,items.length]));
  throw Object.assign(Error(`15-18 fail-closed audit rejected candidate: ${canonical(issueCounts)}`),{audit:build.audit});
 }
 const rootKey=hashCanonical('prompt15-task-15-18-root.v1',{version:TASK_15_18_VERSION,policy:build.provenance.prerequisites.policy,inputs:build.provenance.inputs,generator:build.provenance.generator}).slice(0,20),root=path.join(outputBase,`15-18-administrative-input-v1-${rootKey}`);
 fs.mkdirSync(outputBase,{recursive:true});if(fs.existsSync(root))throw Error(`Immutable output root already exists: ${root}`);fs.mkdirSync(root,{recursive:false});
 const artifacts=[];const emit=(name,value)=>{const target=path.join(root,name);writeJSON(target,value);artifacts.push({...fileIdentity(target),path:name});};
 emit('contract.json',build.bundle.policy);emit('administrative-restoration.geojson',build.bundle.administrativeRestoration);emit('source-identity-trace.json',build.bundle.sourceIdentityTrace);emit('excluded-source-trace.json',build.bundle.excludedSourceTrace);
 fs.copyFileSync(build.protectedSourcePath,path.join(root,'protected-overlay.geojson'));artifacts.push({...fileIdentity(path.join(root,'protected-overlay.geojson')),path:'protected-overlay.geojson',role:'byte-exact import of frozen previous territory geometry'});
 emit('protected-overlay-trace.json',build.bundle.protectedOverlayTrace);emit('residuals.geojson',build.bundle.residuals);emit('fallbacks.json',build.bundle.fallbacks);emit('loss-audit-resolution.json',build.bundle.lossAudit);emit('country-summary.json',build.bundle.countrySummary);emit('audit.json',build.audit);emit('provenance.json',build.provenance);
 const summary={task:'15-18',status:'pass',root,counts:build.audit.counts,svn:build.bundle.countrySummary.SVN,missing:build.audit.problems.missingSourceIdentities,duplicates:build.audit.problems.duplicateSourceIdentities,unresolved:build.audit.problems.unresolved,exceptions:build.bundle.fallbacks,protectedOverlay:{sourcePath:build.protectedSourcePath,sourceIdentity:fileIdentity(build.protectedSourcePath),artifactIdentity:fileIdentity(path.join(root,'protected-overlay.geojson')),missing:build.audit.problems.missingProtectedTerritories,duplicates:build.audit.problems.duplicateProtectedTerritories,parentNamespacesSeparated:build.audit.problems.parentKindConfusion.length===0},next:'15-19 (not executed)'};emit('build-summary.json',summary);
 const artifactIndex={schemaVersion:TASK_15_18_VERSION,root,artifacts:artifacts.slice().sort((a,b)=>compareText(a.path,b.path)),totalByteLength:artifacts.reduce((n,a)=>n+a.byteLength,0),command:build.provenance.command};writeJSON(path.join(root,'artifact-index.json'),artifactIndex);
 return {root,rootKey,summary,artifactIndex,artifactIndexIdentity:fileIdentity(path.join(root,'artifact-index.json'))};
}

export function generateRestorationInputs(options){const build=buildRestorationBundle(),written=writeRestorationBundle(build,options);return {...written,audit:build.audit,provenance:build.provenance};}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const result=generateRestorationInputs();console.log(JSON.stringify({status:'pass',root:result.root,artifactIndex:result.artifactIndexIdentity,counts:result.audit.counts,svn:result.summary.svn,next:result.summary.next}));}
 catch(error){const issueCounts=error.audit?Object.fromEntries(Object.entries(error.audit.problems).filter(([,items])=>items.length).map(([name,items])=>[name,items.length])):null;console.error(JSON.stringify({status:'fail',message:error.message,counts:error.audit?.counts??null,issueCounts,next:'Return to the 15-08/15-09 policy checkpoint; no candidate was written'}));process.exitCode=1;}
}
