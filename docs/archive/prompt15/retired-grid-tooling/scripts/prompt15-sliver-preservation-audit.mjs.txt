import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {gzipSync} from 'node:zlib';
import {BASE,A,W,I,D,CLOSE,SVN,REVIEW,PINS,RECEIPTS,RULES,assert,same,samePin,id,root,write,openInputs,currentCodePins,checkReady,preparedSources} from './prompt15-sliver-preservation-evidence.mjs';
import {buildContext,assemble} from './prompt15-sliver-preservation-context.mjs';
import {auditCountryData,geometryHash} from './prompt15-preservation-audit-core.mjs';
import {evaluateCellSlivers,sliverSummary} from './prompt15-sliver-core.mjs';
import {componentBoundaryCorrespondence} from './prompt15-cell-preservation.mjs';
import {jsonBytes,digest,polygons} from './prompt14-catalog-core.mjs';
import {PACKET_VERSION,PACKET_CONTRACT,encodeCountryPacket,packetGzip,packetGunzip} from './prompt15-sliver-preservation-packet.mjs';
export const makeCountryPacket=encodeCountryPacket;
export const SCHEMA='prompt15-sliver-country-preservation-audit-v1';
const ENTRY='scripts/prompt15-sliver-preservation-audit.mjs';
const read=p=>JSON.parse(fs.readFileSync(p));
export function partitionCountries(order){assert(order.length===247&&new Set(order).size===247&&order[0]==='ABW'&&order[49]==='COL','Fixed country directory');return Array.from({length:5},(_,i)=>order.slice(i*50,Math.min(247,(i+1)*50)));}
export function decision(strict,v2,matches,extra=[]){
 if(extra.some(e=>e.auditor)||strict.errors.some(e=>/union-error|exception|invalid-cell-geometry|physical-metrics|cell-boundary-index/.test(e.code)))return 'AUDITOR_BLOCKED';
 if(!v2.eligibleV2.pass||v2.errors.length)return 'FAIL';
 const unresolved=strict.errors.filter((e,i)=>e.code!=='sliver-budget'&&!matches.some(m=>m.errorIndex===i));
 if(unresolved.length||extra.some(e=>!e.deferred))return 'FAIL';
 return matches.length||extra.some(e=>e.deferred)?'PASS_WITH_DECLARED_DEBT':'PASS';
}
export function validateSupplementFinding(f,actual,sourceHash,selectedPin){
 return f.disposition==='DEFERRED_BY_USER_SUPPLEMENT'&&f.notAWholeCountryExemption===true&&f.strictNativeExitCode===1&&f.strictStatus==='FAIL'&&f.actualBeforeAfterEqual===true&&same(f.before,f.after)&&same(f.after,actual)&&f.sourceComponentHash===sourceHash&&f.scopeBinding.sourceComponent===sourceHash&&f.scopeBinding.selectedCells===selectedPin.sha256;
}
function freshOutput(out,outputBase=BASE){const resolved=path.resolve(out),base=path.resolve(outputBase)+path.sep,allowed=path.resolve('reports/prompt15/15-22-sliver-adoption-audit')+path.sep;assert(base.startsWith(allowed)&&resolved.startsWith(base)&&!fs.existsSync(resolved),'Use a new output below the declared sliver audit directory');fs.mkdirSync(resolved,{recursive:true});return resolved;}
function collectDataPins(value,map=new Map(),historical=[]){
 if(!value||typeof value!=='object')return map;
 if(typeof value.path==='string'&&/^[a-f0-9]{64}$/.test(value.sha256)&&Number.isSafeInteger(value.byteLength)){
  if(/\.(?:js|mjs|cjs)$/.test(value.path)){historical.push(value);return map;}
  const p={path:value.path.replaceAll('\\','/'),sha256:value.sha256,byteLength:value.byteLength};assert(!map.has(p.path)||samePin(map.get(p.path),p),`Conflicting immutable evidence pins ${p.path}`);map.set(p.path,p);
 }
 for(const x of Object.values(value))collectDataPins(x,map,historical);return map;
}
export function prepare({outputBase=BASE,validationPath}={}){
 const prep=`${outputBase}/preparation`,readyPath=`${prep}/ready.json`;
 if(fs.existsSync(readyPath)){const ready=read(readyPath);checkReady(ready);return ready;}
 assert(validationPath,'Packet-v2 ready requires final round-trip/test/real-smoke validation evidence');
 assert(path.resolve(outputBase).startsWith(path.resolve('reports/prompt15/15-22-sliver-adoption-audit')+path.sep),'Preparation base must remain under sliver audit reports');
 fs.mkdirSync(prep,{recursive:true});const inputs=openInputs();
 const validation=inputs.read(validationPath);
 assert(validation.schemaVersion==='prompt15-sliver-packet-v2-readiness-validation'&&validation.status==='PASS'&&validation.packetSchema===PACKET_VERSION,'Incomplete packet validation');
 for(const p of validation.evidencePins)inputs.bytes(p.path,p);
 assert(same(validation.roundTrips.map(r=>r.countryId),['ABW','COM','VAT'])&&validation.roundTrips.every(r=>r.status==='PASS'&&r.geometryAuditExecuted===false),'Actual packet round-trip prerequisites');
 assert(same(validation.smokes.map(r=>r.countryId),['ABW','COM'])&&validation.smokes.every(r=>r.expectedResultMatched&&[0,1].includes(r.nativeExitCode)&&r.status==='PASS'),'Only ABW/COM native smokes must pass expected results');
 assert(validation.tests.nativeExitCode===0&&validation.lint.nativeExitCode===0,'Final tests/lint prerequisites');
 const receipts=RECEIPTS.map(p=>inputs.read(p));
 assert(receipts[0].status==='PASS_GLOBAL_REFERENCE_STRUCTURE_ONLY'&&receipts[0].countryGeometryAudit==='NOT_RUN','New V20 is structural, not geometry approval');
 assert(receipts[1].status==='DRAFT_INDEPENDENT_DELIVERY_PASS_PENDING_COUNTRY_VALIDATION'&&receipts[1].root===D&&samePin(receipts[1].artifactIndex,PINS[3])&&receipts[2].nativeExitCode===0&&receipts[2].signal===null,'Independent draft delivery receipt/native exit');
 const indexRoot=inputs.indexed(I,'index-root.json'),directory=inputs.indexed(W,'catalog-root.json'),manifest=inputs.indexed(D,'manifest.json');
 assert(same(indexRoot.countryOrder,directory.countryOrder)&&indexRoot.counts.cells===923413&&indexRoot.counts.edges===3125713&&manifest.ref.sourceCatalogRoot===W&&manifest.ref.sourceIndicesRoot===I,'New draft root/census binding');
 const chunks=partitionCountries(indexRoot.countryOrder),historicalCodePins=[];
 for(const p of RULES)inputs.bytes(p);
 const evidencePins=new Map();for(const p of [`${CLOSE}/adoption-manifest.json`,`${CLOSE}/numerical-deferral-supplement.json`])collectDataPins(inputs.read(p),evidencePins,historicalCodePins);
 // The immutable source/selection reports may name old helper bytes. They remain historical claims.
 for(const pin of evidencePins.values())inputs.bytes(pin.path,pin);
 const six=inputs.read(`${REVIEW}/summary.json`);
 for(const finding of six.findings){for(const name of [finding.finalAudit.report,finding.finalAudit.command,finding.analysis,finding.lineage,finding.review])if(name)inputs.bytes(`${REVIEW}/${name}`);}
 const provenance=inputs.indexed(A,'provenance.json');const routed=preparedSources(inputs,provenance,[],[]);historicalCodePins.push(...routed.historicalCode);
 // Collect execution/data pins of the exact independently reproduced SVN v2 reports.
 for(const entry of inputs.read(SVN).entries){const ex=inputs.read(entry.origin.execution.path,entry.origin.execution);for(const pin of ex.inputsBefore)if(!/\.(?:mjs|js|cjs)$/.test(pin.path))inputs.bytes(pin.path,pin);}
 const code=currentCodePins(),auditCodeRoot=root('sliver-audit-code-v1',code);
 assert(validation.auditCodeRoot===auditCodeRoot&&same(validation.code,code)&&validation.smokes.every(r=>r.auditCodeRoot===auditCodeRoot),'Smoke/test/final code snapshot mismatch');
 for(const p of validation.inputPins)inputs.bytes(p.path,p);
 assert(code.every(p=>samePin(id(p.path),p)),'Code changed after regression tests or real smokes');
 const contract={schemaVersion:SCHEMA,scope:'assigned-countries-only; immutable unapproved draft; not historical admission',statuses:['PASS','PASS_WITH_DECLARED_DEBT','FAIL','AUDITOR_BLOCKED'],strict:'Native frozen-v6 errors and worker numeric exit preserved; no rewriting to v2 PASS',sliver:'Actual v2 evaluation for every assigned country with pinned source parent component identity/hash/index and physical proof; all-tiny reason explicit',debt:'Exact original six geometry/input/coverage correspondence or exact supplementary source/parent/component/location proof only; no country-wide waiver',pins:'Common pins checked at start, each country start/end and batch end; consumedInputRoot separate',stop:'Stop on common integrity or infrastructure failure; no automatic country retry',geometry:'All source identities/cell IDs/global ordinals, complete parent memberships and binary transport, source/parent/country unions with component/hole/interior preservation, physical/sliver/cap, incident topology/class/flags/positive shared adjacency/incidence',ownedEdges:'Every incident side audited; global census belongs only to original left cell sourceCountryId',history:'Generation PASS, original code hashes and V20 approval retain historical role only. No historical count or approval promotion.',outputs:{country:['raw-strict.json','sliver-v2.json.gz','development.json','native-execution.json','input-pins.json','pin-checks.json'],batch:['verdict.json','summary.json']},notRun:['other batches','final join','approval pointer changes','15-23']};
 contract.packet={schemaVersion:PACKET_VERSION,contract:'packet-contract.json'};
 contract.batchProgress='assigned, actual workersStarted, completed, noCompletedReport/unexecuted, neverStarted, startedWithoutReport, blockedBeforeStart and verdictCounts are separate; unexecuted countries have no fabricated native result';
 write(prep,'contract.json',contract);write(prep,'packet-contract.json',PACKET_CONTRACT);
 const rules=[...new Map([...RULES.map(id),id(`${prep}/contract.json`),id(`${prep}/packet-contract.json`)].map(p=>[p.path,p])).values()];
 const commonInputs=[...inputs.used.values()].filter(p=>!rules.some(r=>r.path===p.path));
 const assignments=chunks.map((countries,i)=>{const name=`batch-${String(i+1).padStart(2,'0')}.json`,file=`${prep}/${name}`,command=`node --expose-gc --max-old-space-size=4096 ${ENTRY} --ready ${readyPath} --batch ${i+1} --out ${outputBase}/batch-${String(i+1).padStart(2,'0')}/<unique-run>`;write(prep,name,{schemaVersion:SCHEMA,batch:i+1,countries,command,candidate:D,candidateIndex:PINS[3]});return {batch:i+1,count:countries.length,countries,file:id(file),command};});
 assert(inputs.stable().length===0,'Common preparation inputs changed');
 write(prep,'historical-code-claims.json',{role:'Historical native receipt code claims, not current audit dependencies; no historical execution replayed',pins:historicalCodePins});
 const ready={schemaVersion:SCHEMA,status:'READY_FOR_FIVE_COUNTRY_BATCHES',created:new Date().toISOString(),outputBase,candidate:D,candidateIndex:PINS[3],commonInputs,commonInputRoot:root('sliver-audit-common-input-v1',commonInputs),rules,ruleRoot:root('sliver-audit-rules-v1',rules),code,auditCodeRoot,assignments,contract:id(`${prep}/contract.json`),packet:{schemaVersion:PACKET_VERSION,contract:id(`${prep}/packet-contract.json`)},validation:id(validationPath),tests:validation.tests,smokes:validation.smokes,supersedes:id(`${BASE}/preparation/ready.json`),runtime:{node:process.version,v8:process.versions.v8,platform:process.platform,arch:process.arch},historicalCodeClaims:id(`${prep}/historical-code-claims.json`),task15_22OverallPass:false};
 checkReady(ready);
 // This is the only write of ready, after every prerequisite and regression succeeds.
 write(prep,'ready.json',ready);return ready;
}
function worker(packetPath,out){
 const start=performance.now(),p=packetGunzip(fs.readFileSync(packetPath)),input=p.input;
 const raw=auditCountryData(input),v2=evaluateCellSlivers(input.cells,input.parents),matches=[],extra=[],supplementResults=[];
 const strict=structuredClone(raw);
 for(const f of p.supplement){
  const parent=input.parents.find(p=>p.parentKey===f.parentKey),coordinates=parent&&polygons(parent.geometry)[f.componentIndex];assert(coordinates,'Declared debt parent/component missing');
  const actual=componentBoundaryCorrespondence({type:'Polygon',coordinates},input.cells.filter(c=>c.parentKey===f.parentKey&&c.componentIndex===f.componentIndex));
  const selection=p.selection,valid=validateSupplementFinding(f,actual,geometryHash({type:'Polygon',coordinates}),selection.selectedCellInput.file);
  supplementResults.push({findingId:f.findingId,parentKey:f.parentKey,componentIndex:f.componentIndex,sourceComponentHash:f.sourceComponentHash,actual,declared:f.after,correspondenceProved:valid,historicalStrictNativeExitCode:f.strictNativeExitCode,historicalStrictStatus:f.strictStatus});
  if(!actual.pass){strict.errors.push({code:'original-source-boundary-correspondence',detail:f.findingId});extra.push({findingId:f.findingId,deferred:valid});}
  else if(!valid)extra.push({findingId:f.findingId,deferred:false});
 }
 if(p.originalSix){
  const old=p.originalSix.report;
  for(const [errorIndex,e] of strict.errors.entries())if(e.code!=='sliver-budget'&&p.unchangedFromBaseline&&old.errors.some(x=>same(x,e))){
   const key=typeof e.detail==='string'?e.detail:null,current=raw.checks.parentCoverage.find(x=>x.parentKey===key),prior=old.checks.parentCoverage.find(x=>x.parentKey===key);
   if(current&&prior&&same(current,prior)&&p.originalSix.parentKey===key)matches.push({errorIndex,code:e.code,parentKey:key,proof:'Exact immutable selected baseline geometry, same original parent hash/shape and complete failed union evidence',originalReport:p.originalSix.pin,originalNativeExitCode:p.originalSix.nativeExitCode});
  }
 }
 strict.status=strict.errors.length?'FAIL':'PASS';
 const status=decision(strict,v2,matches,extra),resources={elapsedMs:performance.now()-start,peakRssBytes:process.resourceUsage().maxRSS*1024};
 write(out,'raw-core-strict.json',raw);write(out,'raw-strict.json',strict);
 fs.writeFileSync(path.join(out,'sliver-v2.json.gz'),gzipSync(jsonBytes(v2),{level:9,mtime:0}),{flag:'wx'});
 write(out,'development.json',{schemaVersion:SCHEMA,countryId:input.countryId,status,frozenV6Strict:strict.status,frozenV6Errors:strict.errors,frozenV6Sliver:v2.legacy,sliverV2:sliverSummary(v2),originalSixMatches:matches,supplementMatches:supplementResults,newErrors:strict.errors.filter((e,i)=>e.code!=='sliver-budget'&&e.code!=='original-source-boundary-correspondence'&&!matches.some(m=>m.errorIndex===i)),extraFindings:extra,checksExecuted:['source identity/lineage','exact delivered cell ID/ordinal/geometry','administrative and previous membership/forward/reverse/binary','source-parent and previous and country geometry/component/hole','physical/sourceTiny/sliver','incident topology/canonical ID/class/flags/shared boundary/adjacency/binary incidence'],historicalCurrentCounts:p.historicalCurrentCounts,resources});
 console.log(JSON.stringify({countryId:input.countryId,status,strict:strict.status,resources}));process.exitCode=strict.status==='PASS'?0:1;
}
export function createCountryPacket(inputs,ctx,country,{supplement,six}){
 const input=assemble(inputs,ctx,country),selection=ctx.adoption.changedCountrySelections.find(s=>s.countryId===country)??null,original=six.findings.find(f=>f.country===country);
 let originalSix=null;
 if(original){const file=`${REVIEW}/${original.finalAudit.report}`,command=inputs.read(`${REVIEW}/${original.finalAudit.command}`);assert(command.exitCode===1,'Historical original-six strict exit');originalSix={parentKey:original.parentKey,report:inputs.read(file),pin:inputs.used.get(file),nativeExitCode:command.exitCode};}
 const relevant=supplement.findings.filter(f=>f.countryId===country);
 for(const f of relevant){inputs.read(f.originalStrictProof.path,f.originalStrictProof);inputs.read(f.originalStrictCommand.path,f.originalStrictCommand);inputs.read(f.closeoutCheck.path,f.closeoutCheck);inputs.read(f.closeoutNativeCommand.path,f.closeoutNativeCommand);}
 if(selection){inputs.bytes(selection.selectedCellInput.file.path,selection.selectedCellInput.file);if(selection.cellCorrespondence)inputs.bytes(selection.cellCorrespondence.path,selection.cellCorrespondence);}
 return makeCountryPacket(input,{selection,supplement:relevant,originalSix,cellOrdinalCapacity:ctx.order.length,edgeOrdinalCapacity:ctx.indexRoot.counts.edges});
}
export function launchCountryWorker(packetFile,out){
 const stdout=fs.openSync(path.join(out,'stdout.txt'),'wx'),stderr=fs.openSync(path.join(out,'stderr.txt'),'wx');
 const args=['--expose-gc','--max-old-space-size=4096',ENTRY,'--worker',packetFile,'--out',out],started=new Date().toISOString();
 const native=spawnSync(process.execPath,args,{stdio:['ignore',stdout,stderr],windowsHide:true});fs.closeSync(stdout);fs.closeSync(stderr);
 const execution={command:process.execPath,args,started,finished:new Date().toISOString(),nativeExitCode:native.status,pid:native.pid??null,signal:native.signal,error:native.error?.message??null};
 write(out,'native-execution.json',execution);return execution;
}
export function batchProgress(countries,startedCountries,results,infrastructure){
 const verdictCounts=Object.fromEntries(['PASS','PASS_WITH_DECLARED_DEBT','FAIL','AUDITOR_BLOCKED'].map(s=>[s,results.filter(r=>r.status===s).length]));
 const noCompletedReport=countries.filter(c=>!results.some(r=>r.countryId===c)),neverStarted=countries.filter(c=>!startedCountries.includes(c));
 return {assigned:countries.length,workersStarted:startedCountries.length,completed:results.length,unexecuted:noCompletedReport.length,
  unexecutedMeaning:'No completed country report; may include a started worker infrastructure failure',neverStarted:neverStarted.length,
  startedWithoutCompletedReport:startedCountries.filter(c=>!results.some(r=>r.countryId===c)).length,
  infrastructureBlockedBeforeStart:infrastructure?neverStarted.length:0,verdictCounts,unexecutedCountries:noCompletedReport,neverStartedCountries:neverStarted};
}
export function runBatch(readyPath,batch,out){
 const ready=read(readyPath),readyPin=id(readyPath);checkReady(ready);assert(Number.isInteger(batch)&&batch>=1&&batch<=5,'Batch must be 1..5');
 const assignment=ready.assignments[batch-1],countries=read(assignment.file.path).countries;assert(same(countries,assignment.countries),'Assigned country slice');
 const output=freshOutput(out,ready.outputBase??BASE),inputs=openInputs(),results=[],startedCountries=[],started=new Date().toISOString();let infrastructure=null,ctx;
 const pinCheck=()=>{assert(samePin(id(readyPath),readyPin),'Ready changed');checkReady(ready);};
 const report=()=>{const progress=batchProgress(countries,startedCountries,results,infrastructure),counts=progress.verdictCounts;
  const status=infrastructure||counts.AUDITOR_BLOCKED?'AUDITOR_BLOCKED':counts.FAIL?'FAIL':counts.PASS_WITH_DECLARED_DEBT?'PASS_WITH_DECLARED_DEBT':'PASS';
  const final={schemaVersion:SCHEMA,scope:'assigned-sliver-draft-country-audit',candidate:D,batch,countries,started,finished:new Date().toISOString(),status,counts,progress,results,unexecuted:progress.unexecutedCountries,infrastructure,commonInputRoot:ready.commonInputRoot,ruleRoot:ready.ruleRoot,auditCodeRoot:ready.auditCodeRoot,ready:readyPin,consumedInputRoot:root('sliver-audit-consumed-v1',[...inputs.used.values()]),inputPins:[...inputs.used.values()],task15_22OverallPass:false,finalJoinExecuted:false};write(output,'verdict.json',final);write(output,'summary.json',final);return final;};
 try{
  pinCheck();ctx=buildContext(inputs,countries,output);
  const supplement=inputs.read(`${CLOSE}/numerical-deferral-supplement.json`),six=inputs.read(`${REVIEW}/summary.json`);
  for(const [n,country] of countries.entries()){
   pinCheck();console.log(`[country ${n+1}/${countries.length}] ${country}`);const dir=path.join(output,country);fs.mkdirSync(dir);
   const packet=createCountryPacket(inputs,ctx,country,{supplement,six});
   const packetFile=path.join(dir,'input-packet.json.gz');fs.writeFileSync(packetFile,packetGzip(packet),{flag:'wx'});
   write(dir,'pin-checks-before.json',{ready:readyPin,commonInputRoot:ready.commonInputRoot,ruleRoot:ready.ruleRoot,auditCodeRoot:ready.auditCodeRoot,checkedAt:new Date().toISOString()});
   const native=launchCountryWorker(packetFile,dir);if(Number.isInteger(native.pid)&&native.pid>0)startedCountries.push(country);
   pinCheck();const changed=inputs.stable();assert(changed.length===0,`Consumed input changed: ${changed.map(p=>p.path).join(',')}`);
   write(dir,'pin-checks-after.json',{unchanged:true,ready:readyPin,commonInputRoot:ready.commonInputRoot,ruleRoot:ready.ruleRoot,auditCodeRoot:ready.auditCodeRoot,checkedAt:new Date().toISOString()});
   write(dir,'input-pins.json',{consumedInputRoot:root('sliver-audit-consumed-v1',[...inputs.used.values()]),pins:[...inputs.used.values()],inputPacket:id(packetFile)});
   assert(!native.error&&native.signal===null&&[0,1].includes(native.nativeExitCode)&&fs.existsSync(path.join(dir,'development.json')),'Native country audit infrastructure failure');
   const development=read(path.join(dir,'development.json'));results.push({countryId:country,status:development.status,strict:development.frozenV6Strict,nativeExitCode:native.nativeExitCode,report:id(path.join(dir,'development.json')),rawStrict:id(path.join(dir,'raw-strict.json')),resources:development.resources});
   if(development.status==='AUDITOR_BLOCKED')throw Error(`Country auditor/geometry infrastructure blocked: ${country}`);global.gc?.();
  }
  pinCheck();assert(inputs.stable().length===0,'Batch input stability');
 }catch(e){infrastructure={message:e.message,stack:e.stack};write(output,'infrastructure-error.json',infrastructure);}
 return report();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{
 const args=process.argv.slice(2);
 if(args[0]==='--prepare'){let options={};if(args.length!==1){assert(args.length===5&&args[1]==='--out-base'&&args[3]==='--validation','Use --prepare --out-base <new base> --validation <completed packet proof>');options={outputBase:args[2],validationPath:args[4]};}const r=prepare(options);console.log(JSON.stringify({status:r.status,ready:`${r.outputBase??BASE}/preparation/ready.json`,auditCodeRoot:r.auditCodeRoot,commonInputRoot:r.commonInputRoot,ruleRoot:r.ruleRoot}));}
 else if(args.length===4&&args[0]==='--worker'&&args[2]==='--out')worker(args[1],args[3]);
 else{assert(args.length===6&&args[0]==='--ready'&&args[2]==='--batch'&&args[4]==='--out','Use --ready <ready.json> --batch <1..5> --out <new directory>');const r=runBatch(args[1],Number(args[3]),args[5]);console.log(JSON.stringify({status:r.status,counts:r.counts,unexecuted:r.unexecuted}));process.exitCode=r.status==='AUDITOR_BLOCKED'?2:r.status==='FAIL'?1:0;}
}catch(e){console.error(e.stack);process.exitCode=2;}}
