import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fileIdentity,validateIdentities,atomicJSON,PROMPT14_GATES,resolveInside} from './protocol.mjs';
import {productSnapshot} from './product-target.mjs';
import {prepareManualBaselineReceipt} from './launch-policy.mjs';

// Adapt the independent manual verifier's report format. Original BLOCKED and
// later PASS reports are immutable; this records intake, never re-runs or
// invents a product test. Original unsuccessful helper/cleanup receipts stay so.
export function adoptManualBaseline(root,{localDirectory,passDirectory,supplementDirectory,outputDirectory}){
  const local=resolveInside(root,localDirectory),pass=resolveInside(root,passDirectory),output=resolveInside(root,outputDirectory);
  const original=JSON.parse(fs.readFileSync(path.join(pass,'result.json'),'utf8'));
  const before=JSON.parse(fs.readFileSync(path.join(local,'inputs.json'),'utf8'));
  if(original.status!=='PASS'||PROMPT14_GATES.some(id=>original.gates[id]!=='PASS')||original.productsModified!==false)throw Error('Independent complete manual PASS is required');
  const candidate=path.resolve(original.candidateRoot);
  if(path.resolve(before.candidateRoot)!==candidate)throw Error('Manual baseline candidate identities disagree');
  const sourcePins=before.candidateSourceBaseline.map(pin=>({path:path.join(candidate,pin.relative),sha256:pin.sha256,byteLength:pin.byteLength}));
  validateIdentities(root,sourcePins);validateIdentities(root,[before.binding]);
  const source=productSnapshot(candidate),pins=new Map(sourcePins.map(pin=>[path.resolve(pin.path).toLowerCase(),pin.sha256]));
  for(const [name,sha]of Object.entries(source))if(pins.get(path.join(candidate,name).toLowerCase())!==sha)throw Error(`Independent manual source pin missing/changed: ${name}`);
  for(const name of ['sourceChanges','inputChanges','publicChanges'])if(original.preservation[name]?.length)throw Error('Manual PASS preservation changes are nonempty');
  if(fs.existsSync(output))throw Error('Preserve existing baseline intake');fs.mkdirSync(output,{recursive:true});
  const sharedPins=(before.checks??[]).flatMap(check=>check.match&&check.expected?.path&&check.expected?.sha256?[check.expected]:[]);
  validateIdentities(root,sharedPins);
  const inputsFile=path.join(output,'verified-inputs.json');atomicJSON(inputsFile,{version:1,inputs:[...sourcePins,...sharedPins]});
  const originalPaths=[path.join(local,'result.json'),path.join(local,'inputs.json'),path.join(local,'preservation.json'),path.join(pass,'result.json'),path.join(pass,'preservation.json')];
  if(supplementDirectory){const extra=path.join(resolveInside(root,supplementDirectory),'result.json'),value=JSON.parse(fs.readFileSync(extra,'utf8'));if(value.status!=='PASS'||path.resolve(value.candidateRoot)!==candidate||value.productsModified!==false)throw Error('Supplement manual PASS does not match candidate');originalPaths.push(extra);}
  const gateReceipts={typecheck:[local,'typecheck.json'],production_build:[local,'build-default.json'],handler_contracts:[local,'unit-isolated.json'],catalog_identity:[local,'catalog-audit.json'],browser_regressions:[pass,'live-contract.json']};
  const evidence=[],commands=[],checks=[];
  for(const id of PROMPT14_GATES){const [directory,name]=gateReceipts[id],sourceFile=path.join(directory,name),receipt=JSON.parse(fs.readFileSync(sourceFile,'utf8'));if(receipt.exitCode!==0||receipt.timedOut||receipt.signal)throw Error(`Unsuccessful retained manual receipt: ${id}`);
    const intake=path.join(output,`${id}-intake.json`);atomicJSON(intake,{kind:'manual-independent-evidence-intake',originalReceipt:fileIdentity(root,sourceFile),originalCommand:receipt.command,originalExitCode:receipt.exitCode,executedAt:receipt.end??receipt.finishedAt,acceptedAt:new Date().toISOString(),productTestsReexecuted:false,resolution:original.resolvedBlockers??[],authoritativePass:fileIdentity(root,path.join(pass,'result.json'))});
    evidence.push(fileIdentity(root,intake),fileIdentity(root,sourceFile));commands.push({command:JSON.stringify(receipt.command),exitCode:receipt.exitCode,evidencePath:fileIdentity(root,intake).path});checks.push({id,status:'pass',evidencePaths:[fileIdentity(root,intake).path],detail:'Retained independent actual execution, accepted only against final full manual PASS and unchanged candidate pins; no test rerun.'});}
  const verdict={review:'prompt14',verdict:'pass',summary:'Independent complete Prompt14 PASS adopted with exact candidate bytes. Original BLOCKED preserved; subsequent full PASS resolves its external blocker. This is receipt format adaptation, not a new product verdict.',nonPassKind:'none',checks,evidence:[...evidence,...originalPaths.map(file=>fileIdentity(root,file))],inputs:[fileIdentity(root,inputsFile),fileIdentity(root,path.join(local,'inputs.json')),before.binding],inputManifests:[fileIdentity(root,inputsFile)],commands,failures:[],suggestedRepairPrompt:''};
  verdict.productInputManifestPath=inputsFile;
  const file=path.join(output,'verification.json');atomicJSON(file,verdict);
  return prepareManualBaselineReceipt(root,file,candidate,path.join(output,'accepted'));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [localDirectory,passDirectory,supplementDirectory,outputDirectory]=process.argv.slice(2);
  const result=adoptManualBaseline(process.cwd(),{localDirectory,passDirectory,supplementDirectory,outputDirectory});console.log(JSON.stringify({receipt:result.path,productRoot:result.receipt.target.productRoot,verdict:result.receipt.verdict}));
}
