// V18: independent current-byte verification for the current 15-18 package.
// This verifier never imports the generator for its verdict. The product
// module is loaded only after the verdict calculation to exercise rejection
// fixtures against its public build guard.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {pathToFileURL} from 'node:url';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';

export const VERSION='prompt15-v18-current-byte-v2';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const readMember=file=>JSON.parse((file.endsWith('.gz')?gunzipSync(fs.readFileSync(file)):fs.readFileSync(file)).toString('utf8'));
const pin=file=>{const bytes=fs.readFileSync(file);return{path:file,byteLength:bytes.length,sha256:sha(bytes)};};
const duplicates=values=>{const seen=new Set(),dupes=new Set();for(const value of values)(seen.has(value)?dupes:seen).add(value);return[...dupes].sort();};
const difference=(left,right)=>[...left].filter(value=>!right.has(value)).sort();
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const minimal=row=>Object.fromEntries(['code','sourceId','countryId','faceId','territoryId','reason','error','grossSquareMetres','grossFraction','sourceShape','resultShape'].filter(key=>row?.[key]!==undefined).map(key=>[key,row[key]]));
const reader=new GeoJSONReader();
function geometryProblem(feature){
  try{
    const geometry=reader.read(feature.geometry),valid=new IsValidOp(geometry);
    if(geometry.isEmpty()||!(geometry.getArea()>0))return'empty or non-positive geometry';
    return valid.isValid()?null:(valid.getValidationError()?.getMessage()??'invalid geometry');
  }catch(error){return error.message;}
}
function resolveCandidateFile(candidate,name){
  const file=path.resolve(candidate,name),relative=path.relative(candidate,file);
  if(relative.startsWith('..')||path.isAbsolute(relative))throw Error(`candidate path escape: ${name}`);
  return file;
}
export async function verifyCurrentTask18({candidateRoot,reportFile}={}){
  const candidate=path.resolve(candidateRoot),preparationFile=resolveCandidateFile(candidate,'.reports/15-18/preparation-result.json');
  const preparation=read(preparationFile),artifactRoot=resolveCandidateFile(candidate,preparation.artifactRoot),indexFile=path.join(artifactRoot,'artifact-index.json'),index=read(indexFile);
  const failures=[],artifactFailures=[],inputFailures=[];
  const members={};
  for(const record of index.artifacts??[]){
    const file=resolveCandidateFile(artifactRoot,record.path);
    if(!fs.existsSync(file)){artifactFailures.push({kind:'missing',path:record.path});continue;}
    const current=pin(file);
    if(current.sha256!==record.sha256||current.byteLength!==record.byteLength)artifactFailures.push({kind:'identity',path:record.path,expected:{sha256:record.sha256,byteLength:record.byteLength},actual:current});
    else members[record.path]=readMember(file);
  }
  const actualFiles=fs.readdirSync(artifactRoot).filter(name=>name!=='artifact-index.json').sort(),indexedFiles=(index.artifacts??[]).map(row=>row.path).sort();
  if(!equal(actualFiles,indexedFiles))artifactFailures.push({kind:'member-set',indexed:indexedFiles,actual:actualFiles});
  const runInputsFile=resolveCandidateFile(candidate,'.reports/15-18/run-inputs.json'),runInputs=read(runInputsFile);
  for(const [name,record] of Object.entries(runInputs.sources??{})){
    const file=resolveCandidateFile(candidate,record.path);
    if(!fs.existsSync(file)){inputFailures.push({kind:'missing',name,path:record.path});continue;}
    const current=pin(file);if(current.sha256!==record.sha256||current.byteLength!==record.byteLength)inputFailures.push({kind:'identity',name,path:record.path,expected:record,actual:current});
  }
  const required=['administrative-candidates.geojson.gz','protected-overlay.geojson','source-trace.json.gz','country-audit.json.gz','build-blockers.json.gz','completion.json','provenance.json','summary.json'];
  for(const name of required)if(!members[name])failures.push(`required package member missing or corrupt: ${name}`);
  const candidates=members['administrative-candidates.geojson.gz']?.features??[],protectedFeatures=members['protected-overlay.geojson']?.features??[],traces=members['source-trace.json.gz']?.traces??[],excluded=members['source-trace.json.gz']?.excluded??[],countryAudit=members['country-audit.json.gz']??{countries:[],losses:[]},blockers=members['build-blockers.json.gz']??{errors:[],unresolved:[]},completion=members['completion.json']??{},summary=members['summary.json']??{};
  const raw=read(resolveCandidateFile(candidate,runInputs.sources.raw.path)),rawById=new Map(raw.features.map(feature=>[String(feature.properties.ne_id),feature]));
  const traceIds=traces.map(row=>String(row.sourceId)),candidateIds=candidates.map(feature=>String(feature.properties.sourceFeatureId)),rawIds=raw.features.map(feature=>String(feature.properties.ne_id));
  const rawSet=new Set(rawIds),traceSet=new Set(traceIds),candidateSet=new Set(candidateIds);
  const missingTrace=difference(rawSet,traceSet),unexpectedTrace=difference(traceSet,rawSet),missingCandidate=difference(rawSet,candidateSet),unexpectedCandidate=difference(candidateSet,rawSet);
  const duplicateTrace=duplicates(traceIds),duplicateCandidate=duplicates(candidateIds),duplicateRaw=duplicates(rawIds);
  const traceById=new Map(traces.map(row=>[String(row.sourceId),row])),auditCountryBySource=new Map(),duplicateCountryMembership=[];
  for(const country of countryAudit.countries??[])for(const sourceId of country.sourceIds??[]){const id=String(sourceId);if(auditCountryBySource.has(id))duplicateCountryMembership.push({sourceId:id,countries:[auditCountryBySource.get(id),country.countryId]});else auditCountryBySource.set(id,country.countryId);}
  const wrongCountry=[],countryMappings=[];for(const feature of candidates){const id=String(feature.properties.sourceFeatureId),trace=traceById.get(id),rawFeature=rawById.get(id),audited=auditCountryBySource.get(id),rawCountry=rawFeature?.properties?.adm0_a3;if(rawCountry!==trace?.rawCountry||feature.properties.sourceCountryId!==trace?.countryId||trace?.countryId!==audited)wrongCountry.push({sourceId:id,candidate:feature.properties.sourceCountryId,trace:trace?.countryId,audited,raw:rawCountry,traceRaw:trace?.rawCountry});else if(rawCountry!==audited)countryMappings.push({sourceId:id,rawCountry,assignedCountry:audited});}
  const componentHole=[];for(const row of traces){const boundaries=Object.values(row.boundary??{}).filter(value=>value&&typeof value==='object'&&'componentHoleBijection'in value);if(!equal(row.sourceShape,row.resultShape)||row.boundary?.complete!==true||boundaries.some(value=>value.componentHoleBijection!==true))componentHole.push({sourceId:row.sourceId,countryId:row.countryId,sourceShape:row.sourceShape,resultShape:row.resultShape,boundaryComplete:row.boundary?.complete??false});}
  const invalidGeometry=[];for(const feature of candidates){const problem=geometryProblem(feature);if(problem)invalidGeometry.push({sourceId:String(feature.properties.sourceFeatureId),countryId:feature.properties.sourceCountryId,problem});}
  const protectedIds=protectedFeatures.map(feature=>String(feature.properties.territoryId)),duplicateProtected=duplicates(protectedIds);
  const previousPin=runInputs.sources.previous,currentProtected=pin(path.join(artifactRoot,'protected-overlay.geojson'));
  const protectedByteExact=currentProtected.sha256===previousPin.sha256&&currentProtected.byteLength===previousPin.byteLength;
  const lossRows=countryAudit.losses??[],unresolvedLosses=lossRows.filter(row=>row.resolved!==true);
  const svn=countryAudit.countries?.find(row=>row.countryId==='SVN'),svnTraceIds=traces.filter(row=>row.countryId==='SVN').map(row=>String(row.sourceId)),svnCandidateIds=candidates.filter(feature=>feature.properties.sourceCountryId==='SVN').map(feature=>String(feature.properties.sourceFeatureId));
  const svnMissing=difference(new Set(svn?.sourceIds?.map(String)??[]),new Set(svnTraceIds)),svnDuplicate=duplicates(svnTraceIds);
  const perCountry=(countryAudit.countries??[]).map(row=>({countryId:row.countryId,source:(row.sourceIds??[]).length,candidate:(row.candidateIds??[]).length,traced:traces.filter(trace=>trace.countryId===row.countryId).length,missing:difference(new Set((row.sourceIds??[]).map(String)),new Set((row.candidateIds??[]).map(String))).length,duplicate:duplicates((row.candidateIds??[]).map(String)).length,unresolved:blockers.unresolved.filter(item=>item.countryId===row.countryId).length}));
  const checks={artifactIntegrity:artifactFailures.length===0,inputPinsCurrent:inputFailures.length===0,sourceIdentityComplete:!missingTrace.length&&!unexpectedTrace.length&&!duplicateTrace.length&&!duplicateRaw.length,candidateIdentityComplete:!missingCandidate.length&&!unexpectedCandidate.length&&!duplicateCandidate.length,countryOwnership:wrongCountry.length===0&&duplicateCountryMembership.length===0&&auditCountryBySource.size===rawSet.size,validGeometry:invalidGeometry.length===0,componentHoleCorrespondence:componentHole.length===0,priorLossesResolved:lossRows.length>0&&unresolvedLosses.length===0,protectedOverlayByteExact:protectedByteExact,protectedOverlayUnique:protectedFeatures.length===previousPin?false:duplicateProtected.length===0,svn193:(svn?.sourceIds?.length===193&&svnTraceIds.length===193&&svnCandidateIds.length===193&&!svnMissing.length&&!svnDuplicate.length),noErrors:blockers.errors.length===0,noUnresolved:blockers.unresolved.length===0,buildAllowed:summary.buildAllowed===true&&preparation.buildAllowed===true,completionEligible:completion.eligible===true&&['pass','completed'].includes(completion.status)};
  // Correct the count comparison separately; previousPin is a byte identity.
  checks.protectedOverlayCount=protectedFeatures.length===(completion.counts?.protectedExpected??-1)&&completion.counts?.protectedActual===protectedFeatures.length;
  delete checks.protectedOverlayUnique;checks.protectedOverlayUnique=duplicateProtected.length===0;
  const verdict=Object.values(checks).every(Boolean)?'pass':'fail';
  const productModule=await import(`${pathToFileURL(resolveCandidateFile(candidate,'scripts/operational-cells/administrative-restoration/input.mjs')).href}?v18=${Date.now()}`);
  const fixtureResults=[];for(const [name,audit] of [['missing-identity',{buildAllowed:false,errors:[{code:'MISSING_SOURCE_IDENTITY',sourceId:'fixture'}],unresolved:[]}],['unresolved',{buildAllowed:false,errors:[],unresolved:[{code:'V18_UNRESOLVED_FIXTURE'}]}]]){let rejected=false,message=null;try{productModule.requireBuildable(audit);}catch(error){rejected=true;message=error.message;}fixtureResults.push({name,rejected,message});}
  checks.failureFixturesReject=fixtureResults.every(row=>row.rejected&&row.message==='ADMINISTRATIVE_INPUT_UNRESOLVED');
  const finalStatus=verdict==='pass'&&checks.failureFixturesReject?'pass':'fail';
  const report={version:2,verifierVersion:VERSION,taskId:'15-18',verification:'V18',status:finalStatus,generatedAt:new Date().toISOString(),candidateRoot:candidate,artifactRoot,inputs:{preparation:pin(preparationFile),runInputs:pin(runInputsFile),artifactIndex:pin(indexFile)},checks,counts:{countries:perCountry.length,raw:rawIds.length,source:rawIds.length,candidates:candidateIds.length,traced:traceIds.length,missing:missingTrace.length+missingCandidate.length,duplicate:duplicateTrace.length+duplicateCandidate.length,wrongCountry:wrongCountry.length,invalidGeometry:invalidGeometry.length,componentHole:componentHole.length,priorLost:lossRows.length,unresolvedPriorLosses:unresolvedLosses.length,errors:blockers.errors.length,unresolved:blockers.unresolved.length,protectedExpected:completion.counts?.protectedExpected??null,protectedActual:protectedFeatures.length,svnSource:svn?.sourceIds?.length??0,svnTraced:svnTraceIds.length,svnCandidates:svnCandidateIds.length},svn:{source:svn?.sourceIds?.length??0,traced:svnTraceIds.length,candidates:svnCandidateIds.length,missing:svnMissing,duplicate:svnDuplicate},perCountry,countryMappings,failures:{artifactFailures,inputFailures,missingTrace,unexpectedTrace,duplicateTrace,missingCandidate,unexpectedCandidate,duplicateCandidate,duplicateCountryMembership,wrongCountry,invalidGeometry,componentHole,unresolvedLosses,errors:blockers.errors.map(minimal),unresolved:blockers.unresolved.map(minimal),protected:{byteExact:protectedByteExact,duplicates:duplicateProtected}},failureFixtures:fixtureResults,next:finalStatus==='pass'?'15-19 (not executed by V18)':'15-18 repair; downstream admission forbidden'};
  if(reportFile){const output=path.resolve(reportFile);if(fs.existsSync(output))throw Error(`immutable V18 report already exists: ${output}`);fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,`${JSON.stringify(report,null,2)}\n`,{flag:'wx'});}
  return report;
}

if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
  const candidate=process.argv[2],report=process.argv[3];if(!candidate||!report)throw Error('usage: node scripts/verify-prompt15-task18-current.mjs <candidateRoot> <immutableReport>');
  const result=await verifyCurrentTask18({candidateRoot:candidate,reportFile:report});console.log(JSON.stringify({status:result.status,counts:result.counts,checks:result.checks,report:path.resolve(report)}));if(result.status!=='pass')process.exitCode=1;
}
