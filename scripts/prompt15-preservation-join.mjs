// Explicit final join only. This never runs country audits or generators.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {joinCountryAudits,AUDIT_VERSION} from './prompt15-preservation-audit-core.mjs';
import {openAuditInputs,selectCountries,DELIVERY_ROOT} from './prompt15-preservation-audit.mjs';
import {identity,sameIdentity,safeRelative,INDICES_ROOT} from './prompt15-world-delivery-core.mjs';
import {jsonBytes} from './prompt14-catalog-core.mjs';

export function joinAuditFiles(files,output){
  if(files.length!==5||new Set(files.map(file=>path.resolve(file))).size!==5)throw Error('Provide exactly five distinct batch verdict files');
  const inputs=openAuditInputs(),readEvidence=(file,pin)=>JSON.parse(inputs.readFile(file,pin)),reports=[],batches=[],batchIds=new Set();
  for(const file of files){
    const batch=readEvidence(file),directory=path.dirname(file);
    if(batch.task!=='15-22'||batch.schemaVersion!==AUDIT_VERSION||batch.scope!=='assigned-country-preservation-audit'||batch.status!=='PASS'||batch.candidate!==DELIVERY_ROOT||batch.inputChanges?.length||batch.fatalError||batchIds.has(batch.batch)||!sameIdentity(batch.candidateArtifactIndex,identity(`${DELIVERY_ROOT}/artifact-index.json`)))throw Error(`Ineligible batch: ${file}`);batchIds.add(batch.batch);
    const expected=selectCountries(inputs.countryRoot.countryOrder,batch.batch);if(JSON.stringify(batch.countries)!==JSON.stringify(expected)||batch.results.length!==expected.length)throw Error(`Wrong country assignment: ${file}`);
    for(const pin of batch.inputs){if(!sameIdentity(identity(pin.path),pin))throw Error(`Stale audit input: ${pin.path}`);inputs.readFile(pin.path,pin);}
    const currentCode=new Map(batch.inputs.map(pin=>[pin.path,pin]));for(const name of ['scripts/prompt15-preservation-audit.mjs','scripts/prompt15-preservation-audit-core.mjs','scripts/prompt15-preservation-audit.node-test.mjs'])if(!currentCode.has(name))throw Error(`Batch omitted audit implementation: ${name}`);
    if(!safeRelative(batch.fixtureExecution.path))throw Error('Unsafe fixture evidence path');
    const fixture=readEvidence(path.join(directory,batch.fixtureExecution.path),batch.fixtureExecution);if(fixture.exitCode!==0||fixture.error)throw Error('Negative fixture execution was not successful');
    for(const [i,result] of batch.results.entries()){
      if(result.countryId!==expected[i]||result.status!=='PASS'||!safeRelative(result.report.path))throw Error('Country result missing, repeated or outside batch');
      const report=readEvidence(path.join(directory,result.report.path),result.report);if(report.countryId!==result.countryId)throw Error('Country report identity substitution');reports.push(report);
    }batches.push({batch:batch.batch,countries:batch.countries,verdict:identity(file)});
  }
  const joined=joinCountryAudits(inputs.countryRoot.countryOrder,reports,inputs.sourceIndex.counts),changed=inputs.verifyStable();
  if(changed.length){joined.status='FAIL';joined.errors.push({code:'join-input-mutated',paths:changed});}
  const resolved=path.resolve(output),relative=path.relative(path.resolve('.'),resolved).replaceAll('\\','/');
  if(!relative.startsWith('reports/prompt15/')||relative.split('/').includes('..')||fs.existsSync(resolved))throw Error('Use a new output directory under reports/prompt15/');
  for(let current=path.dirname(resolved);current!==path.resolve('.');current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Join output parent cannot be a symbolic link/junction');
  fs.mkdirSync(resolved,{recursive:true});
  const verdict={...joined,scope:'five-country-batch-preservation-join',candidate:DELIVERY_ROOT,candidateArtifactIndex:identity(`${DELIVERY_ROOT}/artifact-index.json`),sourceIndex:identity(`${INDICES_ROOT}/artifact-index.json`),batches,inputs:[...inputs.used.values()],inputChanges:changed,worldAuditComplete:joined.status==='PASS',taskAcceptance:joined.status==='PASS'?'PASS':'FAIL',task15_23Executed:false,reviewCExecuted:false,productionPublication:false};
  fs.writeFileSync(path.join(resolved,'verdict.json'),jsonBytes(verdict),{flag:'wx'});return verdict;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){try{
  const args=process.argv.slice(2),at=args.indexOf('--out');if(at!==5||args.length!==7)throw Error('Usage: node scripts/prompt15-preservation-join.mjs <batch1/verdict.json> ... <batch5/verdict.json> --out <new reports/prompt15/... directory>');
  const result=joinAuditFiles(args.slice(0,5),args[6]);console.log(JSON.stringify({task:'15-22',status:result.status,counts:result.counts,output:args[6]}));if(result.status!=='PASS')process.exitCode=1;
}catch(error){console.error(JSON.stringify({task:'15-22',status:'FAIL',message:error.message}));process.exitCode=1;}}
