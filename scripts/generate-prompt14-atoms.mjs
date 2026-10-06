import fs from 'node:fs';
import path from 'node:path';
import {assertBuildOutput, CATALOG_POLICY, canonical, digest, generateAtoms, jsonBytes, loadLockedInputs, validateAtoms, writeArtifact} from './prompt14-catalog-core.mjs';

const root=process.cwd(), output=path.resolve(process.argv[2]??'.tmp/prompt14-catalog/atoms-first');
assertBuildOutput(root,output);
console.log('14-6: verifying source lock and approved component membership.');
const inputs=loadLockedInputs(root), atoms=generateAtoms(inputs);
console.log(`14-6: normalized ${atoms.length} source-feature atoms; validating full country coverage.`);
const validation=validateAtoms(atoms,inputs,console.log);
const artifacts=[writeArtifact(output,'atoms.json',jsonBytes({policy:CATALOG_POLICY,atoms})),
  writeArtifact(output,'normalization-evidence.json',jsonBytes(validation))];
fs.writeFileSync(path.join(output,'artifact-index.json'),jsonBytes(artifacts));
console.log(canonical({stage:'14-6',status:'pass',atoms:atoms.length,rawComponents:validation.rawComponentAtomCandidates,vertices:validation.authoritativeVertices,artifacts,
  inputSha256:digest(fs.readFileSync('data/derived/prompt14/selected-game-input.geojson'))}));
