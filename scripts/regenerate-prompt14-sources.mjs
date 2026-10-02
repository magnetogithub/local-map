import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {arrangeSourcePartitions,ARRANGEMENT_POLICY} from './prompt14-boundary-arrangement.mjs';
import {assertBuildOutput,digest,jsonBytes,generateAtoms,validateAtoms,writeArtifact} from './prompt14-catalog-core.mjs';
import {buildCatalogTopology} from './prompt14-catalog-topology.mjs';

export const HISTORY='data/derived/prompt14/history/review-c-v1';
export async function regenerateSources(output,onProgress=()=>{}){
  assertBuildOutput(process.cwd(),path.resolve(output));
  if(fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('Source regeneration requires an empty directory');
  const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),snapshot=read(`${HISTORY}/snapshot.json`);
  const evidenceFor=p=>{const b=fs.readFileSync(p);return {repositoryPath:p,sha256:digest(b),byteLength:b.length};};
  for(const p of snapshot.archivedFiles){const e=evidenceFor(`${HISTORY}/${p}`),prior=snapshot.hashes[p];if(e.sha256!==prior.sha256||e.byteLength!==prior.byteLength)throw new Error(`History bytes changed: ${p}`);}
  const oldLock=read(`${HISTORY}/data/source-locks/prompt14-derived-game-input-lock.json`);
  for(const e of oldLock.lineageInputs.filter(e=>!e.repositoryPath.startsWith('scripts/')&&!e.repositoryPath.startsWith('data/source-locks/'))){const actual=evidenceFor(e.repositoryPath);if(actual.sha256!==e.sha256||actual.byteLength!==e.byteLength)throw new Error(`Immutable upstream input changed: ${e.repositoryPath}`);}
  const load=p=>import(pathToFileURL(path.resolve(`${HISTORY}/scripts/${p}`)).href);
  const shared=await load('prompt14-shared-topology.mjs'),repair=await load('prompt14-repair.mjs'),gate=await load('prompt14-source-gate.mjs'),selection=await load('prompt14-game-selection.mjs');
  const raw0=read('data/raw/ne_10m_admin_0_countries.geojson'),raw1=read('data/raw/ne_10m_admin_1_states_provinces.geojson'),seed=read('public/data/maps/countries-10m.geojson'),metadata=read('src/data/countries-2020.json');
  onProgress('replaying archived pinned recipe from original raw sources');
  const p0=shared.deriveSharedP0(raw0,seed),p1=shared.prepareTopologyP1(repair.normalizeCollection(raw1,gate.VALIDATOR_POLICY));
  if(!p1.identityPreserved)throw new Error('Original P1 source identity lost');
  const parents=gate.resolveAdmin1Parents(raw1,metadata.map(c=>c.id),metadata);
  parents.entries.forEach((e,i)=>{const id=raw1.features[i].properties.adm0_a3;if(['ESB','WSB','USG','KAS','KAB'].includes(id)){e.excluded=false;e.normalizedParentCountryId=gate.normalizeCountryId(id);e.resolutionRule='existing-P0-map-unit-owner-assignment';delete e.exclusionReason;}});
  const sourceFeatureIds=Object.fromEntries(seed.features.map(f=>[f.properties.countryId,raw0.features.filter(r=>!['BJN','SER','SCR'].includes(r.properties.ADM0_A3)&&gate.normalizeCountryId(r.properties.ADM0_A3)===f.properties.countryId).map(r=>String(r.properties.NE_ID))]));
  const prior=selection.selectGameInputs(p0,p1.collection,parents,metadata,sourceFeatureIds,c=>{if(c.phase==='complete'&&c.processed%25===0)onProgress(`source selection ${c.processed}/247`);});
  const historicalReplay=[];
  for(const [name,value]of [['shared-game-p0.geojson',p0],['shared-admin1-input.geojson',p1.collection],['selected-game-input.geojson',prior.collection]]){
    const b=Buffer.from(JSON.stringify(value)+'\n'),old=fs.readFileSync(`${HISTORY}/data/derived/prompt14/${name}`);if(!b.equals(old))throw new Error(`Raw replay differs from historical lock: ${name}`);historicalReplay.push({name,sha256:digest(b),byteLength:b.length,byteIdentical:true});
  }
  const arranged=arrangeSourcePartitions(p0,prior.collection,p1.collection,onProgress);
  onProgress('certifying all source feature boundaries, components, holes and area changes');
  const identityCollection=collection=>({...collection,features:collection.features.map((f,i)=>({...f,properties:{...f.properties,countryId:`source:${i}:${f.properties.sourceFeatureId}`}}))});
  const selectedBytes=Buffer.from(JSON.stringify(arranged.selected)+'\n'),p0Bytes=Buffer.from(JSON.stringify(arranged.p0)+'\n');
  const featureChange=shared.verifySharedP0(identityCollection(prior.collection),identityCollection(arranged.selected),selectedBytes,selectedBytes);
  const errors=[];
  for(const [i,e]of featureChange.countries.entries()){
    e.sourceCountryId=prior.collection.features[i].properties.countryId;e.sourceFeatureId=prior.collection.features[i].properties.sourceFeatureId;
    if(e.componentsBefore!==e.componentsAfter||e.holesBefore!==e.holesAfter||Math.abs(e.relativeAreaChange)>ARRANGEMENT_POLICY.maximumActualAlignmentAreaFraction)errors.push(`Source component/hole/area bound failed: ${e.sourceFeatureId}`);
  }
  const legacyChange=shared.verifySharedP0(seed,arranged.p0,p0Bytes,p0Bytes);
  if(!featureChange.pass||!legacyChange.pass||errors.length)throw Object.assign(new Error('Actual source/legacy change certificate failed'),{evidence:{featureChange,legacyChange,errors}});
  const plan=shared.planSourceComponentGroups(arranged.selected),grouping=shared.verifySourceComponentGroups(arranged.selected,plan);
  const inputs={p0:arranged.p0,selected:arranged.selected,metadata,lock:oldLock},atoms=generateAtoms(inputs),validation=validateAtoms(atoms,inputs,onProgress),topology=buildCatalogTopology(atoms,arranged.p0,onProgress);
  const fallback=read(`${HISTORY}/reports/prompt14/14-02-game-input-selection.json`);
  if(!grouping.pass||!shared.validatePartialOccupationReadiness(fallback.countries).pass)throw new Error('Grouping or administrative partition readiness failed');
  const sourceArtifacts=[writeArtifact(output,'shared-game-p0.geojson',p0Bytes),writeArtifact(output,'shared-admin1-input.geojson',Buffer.from(JSON.stringify(p1.collection)+'\n')),writeArtifact(output,'selected-game-input.geojson',selectedBytes),writeArtifact(output,'component-grouping-plan.json',jsonBytes({...plan,verification:grouping,deterministic:true})),writeArtifact(output,'arrangement-policy.json',jsonBytes(ARRANGEMENT_POLICY))];
  const evidence={status:'pass',history:HISTORY,historicalReplay,policy:ARRANGEMENT_POLICY,sourceArtifacts,arrangement:arranged.evidence,featureChange,legacyChange,validation,topology:topology.evidence,
    sourceIdentityAndComponentHolePreservation:true,fullWorldBoundaryConnection:true,fallbackCountries:fallback.fallbackCountries,fallbackAlternativeEvidence:`${HISTORY}/reports/prompt14/14-02-game-input-selection.json`,noNewWholeCountryFallback:true,originalAssetsPreserved:true,grouping};
  writeArtifact(output,'source-evidence.json',jsonBytes(evidence));
  return evidence;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'))){
  const output=process.argv[2];
  try{const evidence=await regenerateSources(output,console.log);console.log(JSON.stringify({status:evidence.status,atomCount:evidence.validation.atomCount,vertices:evidence.validation.authoritativeVertices}));}
  catch(error){if(output)writeArtifact(output,'source-failure.json',jsonBytes({status:'fail',message:error.message,evidence:error.evidence??null}));console.error(error.stack);process.exitCode=1;}
}
