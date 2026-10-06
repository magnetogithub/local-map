import fs from 'node:fs';
import path from 'node:path';
import {digest,jsonBytes,writeArtifact,assertBuildOutput} from './prompt14-catalog-core.mjs';
import {verifyCatalogArtifactBytes} from './prompt14-catalog-artifacts.mjs';

const [first,second]=process.argv.slice(2);
if(!first||!second||path.resolve(first)===path.resolve(second))throw new Error('Two independent preparation directories are required');
for(const dir of [first,second])assertBuildOutput(process.cwd(),path.resolve(dir));
const names=['consumer-metadata.json','consumer-approval.json','preparation-evidence.json'];
const compared=names.map(name=>{
  const a=fs.readFileSync(path.join(first,name)),b=fs.readFileSync(path.join(second,name));
  if(!a.equals(b))throw new Error(`Independent consumer artifact mismatch: ${name}`);
  return {path:name,sha256:digest(a),byteLength:a.length};
});
const freeze=JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json','utf8'));
if(freeze.status!=='pass'||freeze.review!=='C')throw new Error('REVIEW C must pass before consumer preparation');
const indexBytes=fs.readFileSync(freeze.artifactIndex.path);
if(digest(indexBytes)!==freeze.artifactIndex.sha256||indexBytes.length!==freeze.artifactIndex.byteLength)throw new Error('Frozen artifact index changed');
const base=path.dirname(freeze.artifactIndex.path),index=JSON.parse(indexBytes),version=freeze.ref.catalogVersion;
const verified=verifyCatalogArtifactBytes(base),approval=JSON.parse(fs.readFileSync(path.join(first,'consumer-approval.json'),'utf8'));
if(JSON.stringify(verified.ref)!==JSON.stringify(freeze.ref)||JSON.stringify(approval.catalogRef)!==JSON.stringify(freeze.ref)||approval.frozenArtifactIndexSha256!==freeze.artifactIndex.sha256)throw new Error('Consumer/catalog approval mismatch');
const metadata=compared[0];
if(approval.metadata.sha256!==metadata.sha256||approval.metadata.byteLength!==metadata.byteLength||approval.metadata.path!==`/data/territory-catalog/${version}/consumer-metadata.json`)throw new Error('Consumer metadata identity mismatch');
const delivery=index.artifacts.filter(a=>a.path.startsWith(`public/data/territory-catalog/${version}/`));
if(delivery.length!==5463||delivery.some(a=>!a.path.endsWith('.pbf')&&!a.path.endsWith('/manifest.json')&&!a.path.endsWith('/tile-index.json')))throw new Error('Unexpected public delivery contents');
const copyExact=(source,target)=>{
  const bytes=fs.readFileSync(source);
  if(fs.existsSync(target)){if(!fs.readFileSync(target).equals(bytes))throw new Error(`Immutable delivery already exists with different bytes: ${target}`);}
  else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);}
  if(!fs.readFileSync(target).equals(bytes))throw new Error(`Published bytes mismatch: ${target}`);
};
// Validate all candidates before publishing any file. Build-only assets never enter public.
for(const a of delivery){const b=fs.readFileSync(path.join(base,a.path));if(b.length!==a.byteLength||digest(b)!==a.sha256)throw new Error('Stored delivery identity mismatch');if(fs.existsSync(a.path)&&!fs.readFileSync(a.path).equals(b))throw new Error(`Immutable delivery collision: ${a.path}`);}
for(const a of delivery)copyExact(path.join(base,a.path),a.path);
const consumerBase=`data/catalog-consumers/prompt14/${version}`;
for(const name of names)copyExact(path.join(first,name),`${consumerBase}/${name}`);
copyExact(path.join(first,'consumer-metadata.json'),`public${approval.metadata.path}`);
const evidence={status:'pass',catalogRef:freeze.ref,independentPreparationDirectories:[first,second],byteIdenticalArtifacts:compared,
  publishedRegisteredArtifacts:delivery.length,publishedMetadata:approval.metadata,allPublishedBytesVerified:true,
  fullGeometryAndTopologyPublished:false,productionCutover:false,
  generators:['scripts/prepare-prompt14-catalog-consumer.mjs','scripts/publish-prompt14-catalog-consumer.mjs'].map(p=>{const b=fs.readFileSync(p);return {path:p,sha256:digest(b),byteLength:b.length};})};
writeArtifact(consumerBase,'publication-evidence.json',jsonBytes(evidence));
console.log(JSON.stringify(evidence));
