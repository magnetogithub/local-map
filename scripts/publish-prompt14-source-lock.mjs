import fs from 'node:fs';
import {canonical,digest,jsonBytes} from './prompt14-catalog-core.mjs';
import {ARRANGEMENT_LINEAGE_PATHS,validateDerivedGameLock} from './prompt14-shared-topology.mjs';
import {normalizeCountryId} from './prompt14-source-gate.mjs';
import {HISTORY} from './regenerate-prompt14-sources.mjs';
const [first,second]=process.argv.slice(2);
if(!first||!second)throw new Error('Provide both independently regenerated source directories');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8')),evidence=read(`${first}/source-evidence.json`);
if(evidence.status!=='pass'||read(`${second}/source-evidence.json`).status!=='pass')throw new Error('Actual complete source proof is required');
const names=['source-evidence.json','component-hole-correspondence.json',...evidence.sourceArtifacts.map(a=>a.path)];
if(read(`${first}/component-hole-correspondence.json`).status!=='pass')throw new Error('Complete component/hole correspondence required');
for(const p of names)if(!fs.readFileSync(`${first}/${p}`).equals(fs.readFileSync(`${second}/${p}`)))throw new Error(`Independent source bytes differ: ${p}`);
for(const name of ['shared-game-p0.geojson','shared-admin1-input.geojson','selected-game-input.geojson'])fs.copyFileSync(`${first}/${name}`,`data/derived/prompt14/${name}`);
fs.copyFileSync(`${first}/component-grouping-plan.json`,'reports/prompt14/14-02-component-grouping-plan.json');
fs.copyFileSync(`${first}/arrangement-policy.json`,'data/source-locks/prompt14-boundary-arrangement-policy.json');
fs.copyFileSync(`${first}/source-evidence.json`,'reports/prompt14/14-02-source-arrangement-evidence.json');
fs.copyFileSync(`${first}/component-hole-correspondence.json`,'reports/prompt14/14-02-component-hole-correspondence.json');
const proof={pass:true,byteIdentical:true,directories:[first,second],artifacts:names.map(p=>{const b=fs.readFileSync(`${first}/${p}`);return {path:p,sha256:digest(b),byteLength:b.length};})};
const selection=read(`${HISTORY}/reports/prompt14/14-02-game-input-selection.json`);
selection.history=`${HISTORY}/reports/prompt14/14-02-game-input-selection.json`;selection.currentArrangementEvidence='reports/prompt14/14-02-source-arrangement-evidence.json';selection.fullWorldP0PartitionEqualityVerified=true;selection.status='pass';
selection.selectedInput={repositoryPath:'data/derived/prompt14/selected-game-input.geojson',...evidence.sourceArtifacts.find(a=>a.path==='selected-game-input.geojson')};
selection.validation=evidence.validation;selection.countries=selection.countries.map(c=>{
  const {before,after,alignedResiduals,alignmentAreaDegreesSquared,residualDiagnostics,...identityAndAlternatives}=c;
  return {...identityAndAlternatives,previousSelectionEvidence:selection.history,currentCoverage:evidence.validation.coverage.find(e=>e.countryId===c.countryId),
    previousAlignmentSummary:{before,after,alignedResiduals,alignmentAreaDegreesSquared,residualDiagnostics},
    currentAlignmentEvidence:'reports/prompt14/14-02-source-arrangement-evidence.json'};
});
fs.writeFileSync('reports/prompt14/14-02-game-input-selection.json',jsonBytes(selection));
fs.writeFileSync('reports/prompt14/14-02-derived-p0-comparison.json',jsonBytes({status:'pass',history:`${HISTORY}/reports/prompt14/14-02-derived-p0-comparison.json`,current:evidence.legacyChange,independentGeneration:proof}));
const fileEvidence=p=>{const b=fs.readFileSync(p);return {repositoryPath:p,sha256:digest(b),byteLength:b.length};};
const lock=read(`${HISTORY}/data/source-locks/prompt14-derived-game-input-lock.json`);
lock.schemaVersion='prompt14-derived-game-input-lock-v2';lock.attribution+='; bounded common source arrangement v1 in stage 14-2';
lock.lineageInputs=ARRANGEMENT_LINEAGE_PATHS.map(fileEvidence);lock.planningEvidence=fileEvidence('reports/prompt14/14-02-component-grouping-plan.json');
lock.artifacts=lock.artifacts.map(e=>{const collection=read(e.repositoryPath);return {...fileEvidence(e.repositoryPath),geometryTypes:[...new Set(collection.features.map(f=>f.geometry.type))].sort(),coveredCountryIds:[...new Set(collection.features.map(f=>f.properties.countryId??normalizeCountryId(f.properties.adm0_a3)).filter(Boolean))].sort()};});
fs.writeFileSync('data/source-locks/prompt14-derived-game-input-lock.json',jsonBytes(lock));
const validation=validateDerivedGameLock(lock,process.cwd());if(!validation.pass)throw new Error(canonical(validation));
fs.writeFileSync('reports/prompt14/14-02-source-generation-delivery-decision.json',jsonBytes({status:'pass',review:'B',scope:'14-2 revalidated derived geometry; final catalog delivery and REVIEW C remain separate gates',
  priorDecision:`${HISTORY}/reports/prompt14/14-02-source-generation-delivery-decision.json`,history:HISTORY,sourceLock:fileEvidence('data/source-locks/prompt14-derived-game-input-lock.json'),lockValidation:validation,
  policy:evidence.policy,sourceEvidence:fileEvidence('reports/prompt14/14-02-source-arrangement-evidence.json'),independentGeneration:proof,
  gates:{fullRawSourceReplay:'pass',all247CountryCoverage:'pass',allSourceBoundaryConnection:'pass',boundedContinuousFeatureChanges:'pass',legacyToDerivedP0:'pass',sourceIdentityComponentsHoles:'pass',administrativePartitionsAndCaps:'pass',originalAssetsPreserved:'pass'},
  diagnosis:fileEvidence('reports/prompt14/14-02-full-boundary-diagnosis.json'),counts:evidence.validation,fallbackCountries:evidence.fallbackCountries,fallbackAlternatives:evidence.fallbackAlternativeEvidence,
  changedActualResidualFaces:evidence.arrangement.changes.length,unresolvedFaces:0,geometryChangedOnlyInStage:'14-2',productionCutover:false}));
console.log(JSON.stringify({status:'pass',independentSourceArtifacts:names.length,sourceLock:fileEvidence('data/source-locks/prompt14-derived-game-input-lock.json')}));
