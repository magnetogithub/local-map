import fs from 'node:fs';
import path from 'node:path';
import {assertBuildOutput,digest,generateAtoms,jsonBytes,loadLockedInputs,validateAtoms,writeArtifact} from './prompt14-catalog-core.mjs';
import {buildCatalogArtifacts,compareCatalogDirectories,verifyCatalogArtifactBytes} from './prompt14-catalog-artifacts.mjs';

const root=process.cwd();
if(process.argv[2]==='--compare'){
  console.log(JSON.stringify(compareCatalogDirectories(path.resolve(process.argv[3]),path.resolve(process.argv[4]))));
}else if(process.argv[2]==='--verify'){
  console.log(JSON.stringify(verifyCatalogArtifactBytes(path.resolve(process.argv[3]))));
}else{
  const output=path.resolve(process.argv[2]??'.tmp/prompt14-catalog/catalog-first');
  assertBuildOutput(root,output);
  if(fs.existsSync(output)&&fs.readdirSync(output).length)throw new Error('Independent generation requires an empty output directory');
  try{
    const inputs=loadLockedInputs(root),atoms=generateAtoms(inputs),validation=validateAtoms(atoms,inputs,console.log);
    const generatorFiles=['scripts/prompt14-catalog-core.mjs','scripts/prompt14-catalog-topology.mjs','scripts/prompt14-catalog-artifacts.mjs','scripts/generate-prompt14-catalog.mjs'].map(repositoryPath=>{const bytes=fs.readFileSync(repositoryPath);return {repositoryPath,sha256:digest(bytes),byteLength:bytes.length};});
    const evidence=buildCatalogArtifacts({atoms,inputs,validation,generatorFiles,output,onProgress:console.log});
    const verified=verifyCatalogArtifactBytes(output);console.log(JSON.stringify({status:'pass',ref:evidence.ref,renderArtifactCount:evidence.renderArtifactCount,renderBytes:evidence.renderBytes,verified}));
  }catch(error){
    writeArtifact(output,'generation-failure.json',jsonBytes({status:'fail',message:error.message,evidence:error.evidence??null}));
    console.error(error.message);process.exitCode=1;
  }
}
