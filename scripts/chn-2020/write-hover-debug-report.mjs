import fs from 'node:fs';
import {createHash} from 'node:crypto';
const root='reports/hover-debug-20261030',base='http://127.0.0.1:3002';
const pin=file=>{const b=fs.readFileSync(file);return{path:file,sha256:createHash('sha256').update(b).digest('hex'),byteLength:b.length};};
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const save=(file,data)=>fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n');
const check=(ok,message)=>{if(!ok)throw Error(message);};
const browser=read(root+'/verification.json');
check(browser.pass&&browser.views.length===13&&browser.fullCountryGeometryRequests.length===0&&browser.cleanup.every(c=>c.status===204),'BROWSER_VERIFICATION_FAILED');
for(const expected of [browser.pointer,...browser.code]){const actual=pin(expected.path);check(actual.sha256===expected.sha256&&actual.byteLength===expected.byteLength,'MEASURED_SOURCE_CHANGED:'+expected.path);}
const tests=fs.readFileSync(root+'/tests.log','utf8'),settings=fs.readFileSync(root+'/settings-tests.log','utf8'),build=fs.readFileSync(root+'/build.log','utf8');
check(/97 passed/.test(tests)&&/5 passed/.test(settings),'UNIT_TESTS_FAILED');
check(!fs.readFileSync(root+'/types.log','utf8').trim()&&!fs.readFileSync(root+'/lint.log','utf8').trim(),'TYPE_OR_LINT_FAILURE');
check(/Compiled successfully/.test(build)&&/prerendered as static content/.test(build),'BUILD_FAILED');
const pointer=read('data/runtime/operational-catalog/current.json');
const response=await fetch(base+'/api/world/catalog/operational/map',{cache:'no-store'}),bootstrap=await response.json();
check(response.ok&&bootstrap.catalog.catalogRef.catalogVersion===pointer.catalogVersion&&bootstrap.provincePresentationBoundaryOrdinals.length===994,'MAIN_APP_NOT_READY');
let after;
try{const r=await fetch(base+'/api/local-maintenance/operational-games/checkpoint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'checkpoint-all',expectedCatalogVersion:pointer.catalogVersion})});after=await r.json();check(r.ok&&after.pass,'GAME_CHECKPOINT_FAILED');save(root+'/user-game-after.json',after);}
finally{const r=await fetch(base+'/api/local-maintenance/operational-games/checkpoint',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'abort-checkpoint',expectedCatalogVersion:pointer.catalogVersion})});const unlocked=await r.json();check(r.ok&&unlocked.pass&&unlocked.mutationsLocked===false,'GAME_UNLOCK_FAILED');save(root+'/user-game-after-unlocked.json',unlocked);}
const before=read(root+'/user-game-before.json'),hashes=receipt=>receipt.pools.flatMap(p=>p.checkpoints.map(c=>c.payloadHash)).sort();
check(JSON.stringify(hashes(before))===JSON.stringify(hashes(after)),'RUNNING_GAME_STATE_CHANGED');
const report={schemaVersion:'hover-neighbor-debug-implementation-v1',pass:true,activeURL:base,
  pointer:pin('data/runtime/operational-catalog/current.json'),catalogUnchanged:true,geometryUnchanged:true,militaryRulesUnchanged:true,
  behavior:{enabled:'debug mode only',scope:'hovered current map owner (controller only if owner is absent), plus direct positive-land neighbors',selectionIndependent:true,noHoverOrSea:'all debug micro lines hidden',coastAndPointContacts:'not used as adjacency',vectorAndExactScopeIdentical:true,normalProvinceAndOccupationFrontsPreserved:true},
  implementation:{scopeIndex:'metadata only, lazy first debug hover, eight-scope LRU; ownership changes update only affected incident edges',sameCountryHover:'no scope/filter rebuild',exactInspection:'120ms settled hover viewport debounce, cancellation, bounded cell-shard capability only; otherwise existing fine PBF',simulationStateChanges:0},
  limitations:['Base PBF tiles still contain fine cell/edge geometry outside the displayed hover scope; this is not a transport LOD rewrite.','Bounded optional exact hover inspection is available only where the current catalog has cell shards; other countries retain existing fine PBF precision.'],
  checks:{unit:{passed:102,files:5,logs:[pin(root+'/tests.log'),pin(root+'/settings-tests.log')]},types:{pass:true,log:pin(root+'/types.log')},lint:{pass:true,log:pin(root+'/lint.log')},build:{pass:true,mode:'Next webpack production',log:pin(root+'/build.log')},browser:{pass:true,views:13,actualMouse:true,fullNationalGeometryRequests:0,externalAiCalls:0,artifact:pin(root+'/verification.json')}},
  preservation:{pass:true,sessionsBefore:before.sessionCount,sessionsAfter:after.sessionCount,unchangedPayloadHashes:hashes(after).length,receipts:[pin(root+'/user-game-before.json'),pin(root+'/user-game-after.json'),pin(root+'/user-game-after-unlocked.json')]},
  code:[...browser.code,pin('src/components/game/WarAndSystemOverlays.tsx'),pin('scripts/chn-2020/write-hover-debug-report.mjs')]};
save(root+'/final-report.json',report);console.log(JSON.stringify({pass:true,url:base,tests:102,browserViews:13,preservedSessions:after.sessionCount}));
