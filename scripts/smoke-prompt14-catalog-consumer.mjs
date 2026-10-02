import fs from 'node:fs';
import {digest,jsonBytes,writeArtifact,assertBuildOutput} from './prompt14-catalog-core.mjs';
import path from 'node:path';
const server=process.argv[2],output=path.resolve(process.argv[3]??'.tmp/prompt14-consumer/http-smoke');
if(!server||!['127.0.0.1','localhost'].includes(new URL(server).hostname))throw new Error('An explicit local test server URL is required');
assertBuildOutput(process.cwd(),output);
const freeze=JSON.parse(fs.readFileSync('data/catalogs/prompt14/frozen-catalog-ref.json','utf8'));
const response=await fetch(new URL('/api/world/catalog',server));
if(!response.ok||response.headers.get('cache-control')!=='no-store')throw new Error('Catalog API is not ready/uncached');
const bootstrap=await response.json();
if(bootstrap.schemaVersion!=='catalog-consumer-bootstrap-v1'||!jsonBytes(bootstrap.catalogRef).equals(jsonBytes(freeze.ref)))throw new Error('HTTP bootstrap catalog ref mismatch');
const artifacts=[];
for(const a of [bootstrap.manifest,bootstrap.tileIndex,bootstrap.metadata]){
  const res=await fetch(new URL(a.path,server)),b=Buffer.from(await res.arrayBuffer());
  if(!res.ok||digest(b)!==a.sha256||b.length!==a.byteLength)throw new Error(`HTTP artifact mismatch: ${a.path}`);
  artifacts.push({...a,httpStatus:res.status});
}
const index=await (await fetch(new URL(bootstrap.tileIndex.path,server))).json(),tile=index.artifacts[0];
const tilePath=tile.path.replace(/^public/,''),tileResponse=await fetch(new URL(tilePath,server)),tileBytes=Buffer.from(await tileResponse.arrayBuffer());
if(!tileResponse.ok||digest(tileBytes)!==tile.sha256||tileBytes.length!==tile.byteLength)throw new Error('HTTP PBF identity mismatch');
artifacts.push({...tile,path:tilePath,httpStatus:tileResponse.status});
const inaccessible=[];
for(const suffix of ['geometry.geojson','topology.json']){
  const url=`/data/territory-catalog/${freeze.ref.catalogVersion}/${suffix}`,res=await fetch(new URL(url,server));
  if(res.status!==404)throw new Error('Build-only asset is accessible');inaccessible.push({path:url,httpStatus:res.status});
}
const evidence={status:'pass',server,catalogRef:freeze.ref,artifacts,buildOnlyRequestsRejected:inaccessible,productionCutover:false};
writeArtifact(output,'http-smoke-evidence.json',jsonBytes(evidence));console.log(JSON.stringify(evidence));
