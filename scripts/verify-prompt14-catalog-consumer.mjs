import fs from 'node:fs';
import path from 'node:path';
import {build} from 'vite';
import {digest,jsonBytes,writeArtifact,assertBuildOutput} from './prompt14-catalog-core.mjs';

const output=path.resolve(process.argv[2]??'.tmp/prompt14-consumer/verified-browser');assertBuildOutput(process.cwd(),output);
const freeze=JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json','utf8'));
const indexBytes=fs.readFileSync(freeze.artifactIndex.path);
if(freeze.status!=='pass'||freeze.review!=='C'||digest(indexBytes)!==freeze.artifactIndex.sha256||indexBytes.length!==freeze.artifactIndex.byteLength)throw new Error('Frozen catalog approval changed');
const replay=process.argv[3];
if(replay){const b=fs.readFileSync(path.join(replay,'artifact-index.json'));if(digest(b)!==freeze.artifactIndex.sha256||b.length!==freeze.artifactIndex.byteLength)throw new Error('Independently regenerated catalog differs from consumer freeze');}
const index=JSON.parse(indexBytes),version=freeze.ref.catalogVersion,prefix=`public/data/territory-catalog/${version}/`;
const approval=JSON.parse(fs.readFileSync(`data/catalog-consumers/prompt14/${version}/consumer-approval.json`,'utf8'));
const registered=index.artifacts.filter(a=>a.path.startsWith(prefix));
for(const a of [...registered,{...approval.metadata,path:`public${approval.metadata.path}`}]){
  const b=fs.readFileSync(a.path);if(b.length!==a.byteLength||digest(b)!==a.sha256)throw new Error(`Published artifact identity mismatch: ${a.path}`);
}
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name).replaceAll('\\','/')]);
const allowed=new Set([...registered.map(a=>a.path),`public${approval.metadata.path}`]);
const files=walk(prefix);if(files.length!==5464||files.some(p=>!allowed.has(p)))throw new Error('Unexpected/missing files in the public catalog namespace');
const result=await build({configFile:false,build:{lib:{entry:'src/lib/map/catalog-map-consumer.ts',formats:['es'],fileName:'catalog-consumer'},outDir:output,emptyOutDir:false}});
const chunks=(Array.isArray(result)?result:[result]).flatMap(r=>r.output).filter(c=>c.type==='chunk');
const modules=chunks.flatMap(c=>Object.keys(c.modules)).map(p=>p.replaceAll('\\','/'));
if(!modules.some(p=>p.endsWith('/catalog-map-consumer.ts'))||modules.some(p=>/node:|\.server\.|\/test-only\//.test(p)))throw new Error('Browser consumer imported a server/build/test authority');
for(const c of chunks)if(c.imports.length||/node:fs|build-only|geometry\.geojson|topology\.json/.test(c.code))throw new Error('Full catalog/server dependency leaked into the client bundle');
const evidence={status:'pass',catalogRef:freeze.ref,publishedArtifactsVerified:files.length,publicNamespaceContainsOnlyApprovedDelivery:true,independentCatalogReplay:replay?{directory:replay,frozenArtifactIndexMatches:true}:null,
  browserBoundary:{entry:'src/lib/map/catalog-map-consumer.ts',serverOrBuildOnlyDependencies:false,externalRuntimeImports:false,modules:modules.map(p=>p.replace(`${process.cwd().replaceAll('\\','/')}/`,'')),
    artifacts:chunks.map(c=>{const b=fs.readFileSync(path.join(output,c.fileName));return {path:c.fileName,sha256:digest(b),byteLength:b.length};})}};
writeArtifact(output,'browser-boundary-evidence.json',jsonBytes(evidence));console.log(JSON.stringify(evidence));
