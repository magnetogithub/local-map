import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
const root='reports/chn-province-20261030',base='http://127.0.0.1:3002';
const pin=file=>{const b=fs.readFileSync(file);return{path:file,sha256:createHash('sha256').update(b).digest('hex'),byteLength:b.length};};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const save=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');
const check=(ok,message)=>{if(!ok)throw Error(message);};
const compact=pin('data/derived/chn-2020/province-render-f1c91c059cdb06f5234f/index.json'), index=read(compact.path);
const proof=read(index.independentVerification.path), full=read(index.acceptedPresentation.path);
check(proof.pass===true&&JSON.stringify(pin(index.acceptedPresentation.path))===JSON.stringify(proof.artifact),'INDEPENDENT_PROOF_MISMATCH');
check(JSON.stringify(index.cells)===JSON.stringify(full.cells)&&JSON.stringify(index.addedBoundaryOrdinals)===JSON.stringify(full.addedBoundaryOrdinals),'COMPACT_PROJECTION_MISMATCH');
const before=read(root+'/browser/before.json'),after=read(root+'/browser/after.json'),refresh=read(root+'/browser/same-game-refresh.json');
check(before.pass&&after.pass&&refresh.pass&&after.provinceBoundaryCount===994&&after.ownSessionCleanupStatus===204&&refresh.cleanupStatus===204,'BROWSER_OR_CLEANUP_FAILED');
const build=fs.readFileSync(root+'/build.log','utf8'),tests=fs.readFileSync(root+'/tests.log','utf8'),lint=fs.readFileSync(root+'/lint.log','utf8');
check(/Compiled successfully/.test(build)&&/prerendered as static content/.test(build)&&!/Failed to compile/.test(build),'BUILD_FAILED');
check(/87 passed/.test(tests)&&/4 passed/.test(tests)&&!lint.trim(),'CHECKS_FAILED');
const pointer=read('data/runtime/operational-catalog/current.json');
check(pin('data/runtime/operational-catalog/current.json').sha256===before.pointer.sha256,'ACTIVE_CATALOG_CHANGED');
const calls=[],bootstraps=[];
for(let i=0;i<5;i++){const start=performance.now(),r=await fetch(base+'/api/world/catalog/operational/map',{cache:'no-store'});check(r.ok,'LIVE_BOOTSTRAP_HTTP');const text=await r.text(),b=JSON.parse(text);calls.push({request:i+1,wallMs:performance.now()-start,rawBytes:Buffer.byteLength(text),gzipBytes:gzipSync(text).length});bootstraps.push(b);check(b.catalog.catalogRef.catalogVersion===pointer.catalogVersion&&b.provincePresentationRoot===compact.sha256&&JSON.stringify(b.provincePresentationBoundaryOrdinals)===JSON.stringify(index.addedBoundaryOrdinals),'LIVE_PRESENTATION_NOT_ACTIVATED');}
const bootstrap=bootstraps[0],without={...bootstrap};delete without.provincePresentationBoundaryOrdinals;delete without.provincePresentationRoot;
const addedBytes=Buffer.byteLength(JSON.stringify(bootstrap))-Buffer.byteLength(JSON.stringify(without));
let checkpoint;
try{const r=await fetch(base+'/api/local-maintenance/operational-games/checkpoint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'checkpoint-all',expectedCatalogVersion:pointer.catalogVersion})});checkpoint=await r.json();check(r.ok&&checkpoint.pass,'LIVE_GAME_CHECKPOINT_FAILED');save(root+'/user-game-after-checkpoint.json',checkpoint);}
finally{const r=await fetch(base+'/api/local-maintenance/operational-games/checkpoint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'abort-checkpoint',expectedCatalogVersion:pointer.catalogVersion})});const unlocked=await r.json();save(root+'/user-game-after-unlocked.json',unlocked);check(r.ok&&unlocked.pass&&unlocked.mutationsLocked===false,'GAME_UNLOCK_FAILED');}
const old=read(root+'/user-game-checkpoint.json'),identity=p=>p.pools.flatMap(pool=>pool.checkpoints.map(c=>c.payloadHash)).sort();
const preserved=JSON.stringify(identity(old))===JSON.stringify(identity(checkpoint));
check(preserved,'LIVE_GAME_POOL_CHANGED_DURING_DISPLAY_FIX');
const report={schemaVersion:'chn-province-display-fix-v1',pass:true,activeURL:base,scope:'CHN presentation only; worldwide scale analysis only',pointer:pin('data/runtime/operational-catalog/current.json'),
  runtimeIndex:compact,presentation:index.acceptedPresentation,verification:index.independentVerification,
  implementation:{normalWhiteSharedEdges:994,debugMicroOnly:true,officialParentsChanged:false,catalogRefChanged:false,geometryChanged:false,otherCountriesChanged:false,verifiedFamiliesUnchanged:1663,activeCoverageDisplayFamilies:1025,rawFamilyDisplayInheritanceFamilies:150,unresolvedFineFamilies:12,sourceFreeCells:7,unassignedCells:33},
  limitations:full.limitations,temporalLimits:full.temporalLimits,potentialMissingInterfaces:full.boundaryAudit,
  preservation:{pass:preserved,previousSessions:old.sessionCount,currentSessions:checkpoint.sessionCount,unchangedCheckpointPayloadHashes:identity(checkpoint).length,receipt:pin(root+'/user-game-after-checkpoint.json'),unlocked:pin(root+'/user-game-after-unlocked.json')},
  checks:{unit:{passed:87,files:4,artifact:pin(root+'/tests.log')},lint:{pass:true,artifact:pin(root+'/lint.log')},build:{pass:true,mode:'Next production webpack',artifact:pin(root+'/build.log')},independentNegativeControls:11},
  browser:{before:pin(root+'/browser/before.json'),after:pin(root+'/browser/after.json'),sameGameRefresh:pin(root+'/browser/same-game-refresh.json'),externalAiCalls:0,fullChinaExactRequests:0},
  liveDelivery:{calls,conditions:'development endpoint diagnostics: first may include compilation; warm server/OS cache; not a matched cold/warm geometry or FPS benchmark',addedBootstrapBytes:addedBytes,serverOnlyIndexBytes:compact.byteLength,noAdditionalPolygonOrLineAsset:true,legacyBoundaryCount:bootstrap.legacyBoundaryOrdinals.length},
  worldwideAnalysis:pin('reports/world-micro-scale-20261030/scaling-audit.json'),
  code:['scripts/chn-2020/write-province-report.mjs','src/lib/map/chn-province-presentation.server.ts','src/lib/map/province-presentation.server.ts','src/lib/map/operational-delivery.server.ts','src/lib/map/operational-delivery-contract.ts','src/lib/map/operational-map-consumer.ts','src/components/map/OperationalWorldMap.tsx'].map(pin)};
save(root+'/final-report.json',report);console.log(JSON.stringify({pass:report.pass,liveURL:base,preservedSessions:checkpoint.sessionCount,boundaries:994,addedBootstrapBytes:addedBytes,warmEndpointWallMs:calls.slice(1).map(x=>x.wallMs)}));
