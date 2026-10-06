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
    const inputs=loadLockedInputs(root);
    const sourceIndex=process.argv.indexOf('--sources');
    if(sourceIndex>=0){
      const source=process.argv[sourceIndex+1];
      const evidence=JSON.parse(fs.readFileSync(path.join(source,'source-evidence.json'),'utf8'));
      if(evidence.status!=='pass')throw new Error('Full raw source regeneration did not pass');
      for(const name of ['shared-game-p0.geojson','shared-admin1-input.geojson','selected-game-input.geojson'])if(!fs.readFileSync(path.join(source,name)).equals(fs.readFileSync(path.join(root,'data/derived/prompt14',name))))throw new Error(`Regenerated source differs from the current lock: ${name}`);
      if(!fs.readFileSync(path.join(source,'source-evidence.json')).equals(fs.readFileSync(path.join(root,'reports/prompt14/14-02-source-arrangement-evidence.json'))))throw new Error('Raw replay evidence differs from the locked policy proof');
      if(!fs.readFileSync(path.join(source,'component-hole-correspondence.json')).equals(fs.readFileSync(path.join(root,'reports/prompt14/14-02-component-hole-correspondence.json'))))throw new Error('Component/hole correspondence differs from the locked proof');
      writeArtifact(output,'source-replay-evidence.json',fs.readFileSync(path.join(source,'source-evidence.json')));
    }
    writeArtifact(output,'source-lock.json',jsonBytes(inputs.lock));
    const atoms=generateAtoms(inputs),validation=validateAtoms(atoms,inputs,console.log);
    const generatorFiles=['scripts/prompt14-catalog-core.mjs','scripts/prompt14-catalog-topology.mjs','scripts/prompt14-catalog-artifacts.mjs','scripts/generate-prompt14-catalog.mjs'].map(repositoryPath=>{const bytes=fs.readFileSync(repositoryPath);return {repositoryPath,sha256:digest(bytes),byteLength:bytes.length};});
    const evidence=buildCatalogArtifacts({atoms,inputs,validation,generatorFiles,output,onProgress:console.log});
    const verified=verifyCatalogArtifactBytes(output);console.log(JSON.stringify({status:'pass',ref:evidence.ref,renderArtifactCount:evidence.renderArtifactCount,renderBytes:evidence.renderBytes,verified}));
  }catch(error){
    writeArtifact(output,'generation-failure.json',jsonBytes({status:'fail',message:error.message,evidence:error.evidence??null}));
    console.error(error.message);process.exitCode=1;
  }
}
