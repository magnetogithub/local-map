import fs from 'node:fs';
import path from 'node:path';
import {fileIdentity,validateIdentities,resolveInside,inside,atomicJSON} from './protocol.mjs';
import {productSnapshot,validateProductTarget,digest} from './product-target.mjs';
import {workspaceSnapshot} from './workspaces.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));

// Execution tools are not product files. This exception authenticates only this
// process's executable; it must never become a general external-path resolver.
export function normalizeImplementationInputs(root,inputs){
  if(!Array.isArray(inputs))throw Error('Invalid implementation input manifest');
  const productInputs=[],executionTools=[];
  for(const pin of inputs){
    if(!pin||typeof pin.path!=='string'||!pin.path.trim())throw Error('Invalid implementation input pin');
    if(inside(path.resolve(root),path.resolve(root,pin.path))){
      validateIdentities(root,[pin]);productInputs.push(pin);continue;
    }
    const executable=path.resolve(process.execPath);
    if(!path.isAbsolute(pin.path)||path.resolve(pin.path)!==executable||!fs.lstatSync(executable).isFile()||fs.realpathSync(executable)!==executable)throw Error(`Unapproved execution tool: ${pin.path}`);
    const actual=fileIdentity(path.dirname(executable),executable);
    if(pin.sha256!==actual.sha256||pin.byteLength!==actual.byteLength)throw Error(`Execution tool bytes changed: ${pin.path}`);
    executionTools.push({...pin,path:executable});
  }
  return {productInputs,executionTools};
}

function controllerInputBinding(root,candidateRoot,response){
  validateIdentities(root,[response.requestIdentity,response.responseIdentity]);
  const confirmed=read(resolveInside(root,response.responseIdentity.path)),request=read(resolveInside(root,response.requestIdentity.path)),result=confirmed.result;
  if(!confirmed.completedAt||!response.turnId||confirmed.turnId!==response.turnId||digest(confirmed.requestIdentity)!==digest(response.requestIdentity)||digest(result)!==digest(response.result)||confirmed.cwd!==candidateRoot||request.cwd!==candidateRoot||result.candidateRoot!==candidateRoot||!['completed','blocked'].includes(result.status)||request.role!=='implementer'||request.taskId!==result.taskId||confirmed.schemaDigest!==request.schemaDigest||confirmed.productSourceDigest!==digest(productSnapshot(candidateRoot)))throw Error('Target binding: input normalization needs the exact confirmed implementation');
  const manifestFile=resolveInside(root,result.inputManifestPath);
  if(!inside(candidateRoot,manifestFile))throw Error('Implementation input manifest must stay in the candidate');
  const original=read(manifestFile);
  if(original.version!==1)throw Error('Invalid implementation input manifest');
  const roles=normalizeImplementationInputs(root,original.inputs);
  const artifacts=result.artifactPaths.map(name=>{const file=resolveInside(root,name);if(!inside(candidateRoot,file)||!fs.statSync(file).isFile())throw Error('Task artifacts must be exact candidate files');return fileIdentity(root,file);});
  const sourceManifest=fileIdentity(root,manifestFile);
  return {original,artifacts,record:{version:1,kind:'implementation-input-normalization',candidateRoot,requestIdentity:response.requestIdentity,responseIdentity:response.responseIdentity,turnId:response.turnId,sourceManifest,...roles,artifacts}};
}

function preserveJSON(file,value){
  if(fs.existsSync(file)){if(digest(read(file))!==digest(value))throw Error('Implementation outputs changed after controller handoff');}
  else atomicJSON(file,value);
}

export function prepareControllerImplementationInputs(root,{candidateRoot,attemptDirectory,response}){
  candidateRoot=resolveInside(root,candidateRoot);attemptDirectory=resolveInside(root,attemptDirectory);
  if(candidateRoot!==path.join(attemptDirectory,'candidate')||!inside(attemptDirectory,resolveInside(root,response.responseIdentity.path))||!inside(attemptDirectory,resolveInside(root,response.requestIdentity.path)))throw Error('Target binding: input normalization belongs to another attempt');
  const {original,artifacts,record}=controllerInputBinding(root,candidateRoot,response);
  const legacyFile=path.join(attemptDirectory,'controller-bound-inputs.json');
  const legacy={version:1,inputs:[...original.inputs,record.sourceManifest,...artifacts]};
  if(!record.executionTools.length){preserveJSON(legacyFile,legacy);return {artifactManifest:legacyFile,artifacts};}
  // Preserve the failed legacy handoff byte-for-byte. A new role projection and
  // its own receipt bind the same confirmed response, candidate and artifacts.
  if(fs.existsSync(legacyFile)){preserveJSON(legacyFile,legacy);record.legacyManifest=fileIdentity(root,legacyFile);}
  const normalization=path.join(attemptDirectory,'implementation-input-normalization.json');
  preserveJSON(normalization,record);
  const artifactManifest=path.join(attemptDirectory,'controller-product-inputs.json');
  preserveJSON(artifactManifest,{version:1,inputs:[...record.productInputs,record.sourceManifest,...artifacts,fileIdentity(root,normalization)]});
  return {artifactManifest,artifacts};
}

// Recheck the nested runtime identity on every target handoff, including reuse
// of a completed official result. Pinning only the receipt bytes is insufficient.
export function validateImplementationInputRoles(root,target,manifest){
  for(const pin of manifest.extraInputs.filter(pin=>path.basename(pin.path)==='implementation-input-normalization.json')){
    validateIdentities(root,[pin]);const record=read(resolveInside(root,pin.path));
    validateIdentities(root,[record.responseIdentity,record.requestIdentity,record.sourceManifest]);
    const confirmed=read(resolveInside(root,record.responseIdentity.path));
    const {original,artifacts,record:expected}=controllerInputBinding(root,target.productRoot,{...confirmed,responseIdentity:record.responseIdentity});
    if(record.legacyManifest){
      const legacy=path.join(path.dirname(resolveInside(root,pin.path)),'controller-bound-inputs.json');
      if(resolveInside(root,record.legacyManifest.path)!==legacy)throw Error('Invalid legacy implementation handoff');
      validateIdentities(root,[record.legacyManifest]);
      if(digest(read(legacy))!==digest({version:1,inputs:[...original.inputs,expected.sourceManifest,...artifacts]}))throw Error('Legacy implementation handoff changed');
      expected.legacyManifest=record.legacyManifest;
    }
    if(digest(record)!==digest(expected)||!record.executionTools.length||digest(target.requestIdentity)!==digest(record.requestIdentity)||digest(target.responseIdentity)!==digest(record.responseIdentity)||target.turnId!==record.turnId)throw Error('Target binding: implementation input roles changed');
    for(const input of [...record.productInputs,record.sourceManifest,...artifacts])if(!manifest.extraInputs.some(bound=>bound.sha256===input.sha256&&bound.byteLength===input.byteLength&&resolveInside(root,bound.path)===resolveInside(root,input.path)))throw Error('Target binding: normalized product input missing');
  }
}

// Recovery seeds duplicate the pinned decision's repairTaskIds. They are routing
// metadata, absent from older immutable contexts, rather than a new task input.
function repairInputMetadata(root,repair){
  const {seeds,...metadata}=repair;
  if(Object.hasOwn(repair,'seeds')){
    validateIdentities(root,[repair.decision]);
    const action=read(resolveInside(root,repair.decision.path)).result;
    if(action?.action!=='repair'||action.review!==repair.review||!Array.isArray(action.repairTaskIds)||digest(seeds)!==digest(action.repairTaskIds))throw Error('Target binding: task input context changed');
  }
  return metadata;
}
export function prepareTaskInputs(root,{state,taskId,candidateRoot,outputFile,previousResponse=null}){
  const approved=state.approvedProductTarget,approvedManifest=validateProductTarget(root,approved),sourceRoot=state.reviewWorkspace.directory;
  const source=productSnapshot(sourceRoot),changes=[...new Set([...Object.keys(approvedManifest.source),...Object.keys(source)])].sort().filter(name=>approvedManifest.source[name]!==source[name]).map(name=>({path:name,before:approvedManifest.source[name]??null,after:source[name]??null}));
  const prior=previousResponse?read(resolveInside(root,previousResponse.path)):null;
  if(previousResponse)validateIdentities(root,[previousResponse]);
  const historical=[state.baselineCertificate?.verification,...Object.values(state.certificates??{}).map(row=>row.verification)].filter(Boolean);
  for(const expected of [...historical]){
    const report=read(resolveInside(root,expected.path));
    // Retain explicit final manual-PASS/preservation evidence. A historical
    // report's start-hash is not the current candidate's authoritative hash.
    for(const evidence of report.evidence??[])if(/(?:verification\.json|result\.json|preservation\.json|binding\.json)$/.test(evidence.path))historical.push(evidence);
  }
  const references=[];
  const prompt14='prompts/PROMPT_14_MICRO_TERRITORY_OCCUPATION_AND_COUNTRY_COLORS.txt';
  if(fs.existsSync(path.join(root,prompt14)))references.push({...fileIdentity(root,prompt14),role:'read-only original requirement reference; not original-root application execution'});
  const sharedRoots=[];
  for(const relative of ['data','public','node_modules','validation/node_modules','validation/archives']){
    const file=path.join(sourceRoot,relative);if(fs.existsSync(file))sharedRoots.push({path:file,resolvedPath:fs.realpathSync(file),readOnly:true});
  }
  const dependencies=[];
  for(const relative of ['node_modules/next/package.json','node_modules/typescript/package.json','node_modules/vitest/package.json']){
    const file=path.join(sourceRoot,relative);if(!fs.existsSync(file))continue;
    const resolved=fs.realpathSync(file);dependencies.push({logicalPath:relative,resolvedPath:resolved,identity:fileIdentity(root,resolved),note:'Existing approved installation; real package paths may follow nested junctions outside the logical node_modules directory. Compare exact pinned bytes rather than directory spelling.'});
  }
  const snapshot=workspaceSnapshot(sourceRoot);
  const repair=state.tasks?.[taskId]?.reviewRepair;
  if(repair)validateIdentities(root,[repair.decision,repair.verification,repair.target.manifest]);
  let value={version:1,taskId,candidateRoot,readOnlySourceRoot:sourceRoot,...(repair?{reviewRepair:repairInputMetadata(root,repair)}:{}),approvedBaseline:{target:approved,verification:state.baselineCertificate?.verification??null},
    dirtyInventory:{scope:'Actual product source only, compared with the immutable accepted predecessor. This is not a claim about control-root git status.',complete:true,authority:approved.manifest,currentSourceDigest:digest(source),currentSource:source,changes,workspaceConstructionSnapshot:snapshot},
    sharedRoots,dependencies,historicalEvidence:[...new Map(historical.map(pin=>[path.resolve(root,pin.path).toLowerCase(),pin])).values()],referenceDocuments:references,
    previousBlockedResponse:previousResponse,previousArtifacts:prior?.result?.artifactPaths??[],
    handoff:{implementationCompletion:'Save result and evidence first. The controller calls guardian after the implementation response; future relay/verification audits are not an implementation completion precondition.',independentVerification:'Not yet performed; no task/review PASS is implied.'}};
  validateIdentities(root,[...value.historicalEvidence,...references]);
  outputFile=resolveInside(root,outputFile);if(fs.existsSync(outputFile)){
    const existing=read(outputFile),comparable=existing.reviewRepair?{...existing,reviewRepair:repairInputMetadata(root,existing.reviewRepair)}:existing;
    if(digest(comparable)!==digest(value))throw Error('Target binding: task input context changed');
    // Preserve both bytes and the returned value of the original receipt,
    // including contexts already written by recovery with validated seeds.
    value=existing;
  }else atomicJSON(outputFile,value);
  return{path:outputFile,identity:fileIdentity(root,outputFile),value};
}
