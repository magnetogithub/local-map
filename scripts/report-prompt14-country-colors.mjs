import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root='reports/prompt14/14-17-country-color';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const receipt=p=>{const bytes=fs.readFileSync(p);return {path:p,sha256:sha(bytes),byteLength:bytes.length};};
const assert=(v,m)=>{if(!v)throw new Error(m);};
const baseline=read(`${root}/baseline.json`),freeze=read('data/catalogs/prompt14/frozen-catalog-ref.json');
const pairPath=`data/catalogs/prompt14/${freeze.ref.catalogVersion}/migration-pair.json`,pair=read(pairPath);
const frozen=[{path:pairPath,expected:freeze.pairSha256},
  {path:`data/catalogs/prompt14/${freeze.ref.catalogVersion}/migration-mapping.json`,expected:freeze.mappingSha256},
  {path:'data/source-locks/prompt14-derived-game-input-lock.json',expected:freeze.sourceLockSha256}].map(item=>{
  const r=receipt(item.path);assert(r.sha256===item.expected,`Immutable bytes changed: ${item.path}`);return {...r,unchanged:true};
});
const original=read('src/data/countries-2020.json'),sourceColors=new Map(original.map(c=>[c.id,c.mapColor]));
for(const id of pair.world.countryOrder)assert(pair.world.countriesById[id].mapColor===sourceColors.get(id)?.toUpperCase(),`Seed RGB changed: ${id}`);
const suites=['related-regression-tests.json','map-regression-tests.json'].map(name=>{const p=`${root}/${name}`,r=read(p);assert(r.success&&r.numFailedTests===0,`Tests failed: ${p}`);return {...receipt(p),passed:r.numPassedTests,skipped:r.numPendingTests,exitCode:0};});
const browserPath=`${root}/browser/evidence.json`,browser=read(browserPath);assert(browser.status==='pass'&&browser.scenarios.length===2,'Browser smoke did not pass');
const files=[
  'src/lib/world/country-map-color.ts','src/lib/world/country-map-color.test.ts',
  'src/lib/commands/country-change-map-color.ts','src/lib/commands/country-change-map-color.test.ts',
  'src/lib/planning/country-map-color-planner.ts','src/lib/projection/catalog-color-projection.ts',
  'src/lib/projection/catalog-map-consumer-projection.ts','src/lib/map/catalog-map-consumer.ts','src/lib/map/catalog-consumer.test.ts',
  'src/lib/simulation/country-color-authority.ts','src/lib/simulation/country-color-runtime.test.ts',
  'src/lib/simulation/catalog-turn-plan.ts','src/lib/simulation/debug-world-effect.ts','src/lib/simulation/semantic-validator.ts',
  'src/lib/simulation/world-effect.ts','src/lib/simulation/world-effect-compiler.ts','src/lib/simulation/turn-resolution.ts','src/lib/simulation/simulation-context.ts',
  'src/lib/simulation/server/context-resolution-validator.ts','src/lib/simulation/server/provider-config.ts','src/lib/simulation/server/simulation-instruction.ts',
  'src/lib/simulation/client/turn-report.ts','src/components/layout/CatalogGameSetupShell.tsx','src/components/map/CatalogWorldMap.tsx',
  'scripts/smoke-prompt14-country-colors.mjs','scripts/report-prompt14-country-colors.mjs',
];
const changes=files.map(p=>{
  const wasDirtyAtStart=baseline.trackedDirty.includes(p)||baseline.untracked.includes(p);let startHash=baseline.startHashes[p]??null,trackedAtStart=false;
  try{const old=execFileSync('git',['show',`${baseline.head}:${p}`],{stdio:['ignore','pipe','ignore']});trackedAtStart=true;startHash??=sha(old);}catch{}
  return {...receipt(p),startHash,wasDirtyAtStart,trackedAtStart,attribution:wasDirtyAtStart?'Only color additions/integration belong to this run; pre-existing changes retained':'Color implementation or shared integration. Concurrent occupation additions retained where present.'};
});
const report={schemaVersion:'prompt14-country-color-checkpoint-v1',status:'pass',generatedAt:new Date().toISOString(),baselineHead:baseline.head,
  completedTasks:['14-15','14-16','14-17'],baselineEvidence:receipt(`${root}/baseline.json`),
  baselinePolicy:'Existing dirty files and new concurrent occupation files were retained. filesChangedByThisRun describes color edits; it does not claim ownership of every diff in shared files.',
  concurrentSharedEdits:{observed:true,resolution:'Integrated the current occupation planner/projection ports and reran color, occupation, atomic runtime and map regressions. User requested continued work without confirmation.'},
  stages:{'14-15':{status:'pass',seedColorMigration:'all frozen seed RGB values preserved',canonicalColor:'uppercase #RRGGBB; noncanonical commands rejected',allocator:'domain-separated deterministic RGB allocation; collision handling; no six-color cycling',authority:'actor/target/color/date/source event and revision checks; bounded grounded same-turn presentation grant'},
    '14-16':{status:'pass',atomicCommitUndoRedo:true,affectedTerritoryUpdatesOnly:true,controllerColor:true,wholeSourceUpdates:0,fullProjectionRebuildsForColor:0,unchangedTerritoryCollectionShared:true,labelsBordersSelection:'contrast ink/halo/outline; minimum ink contrast 4.5 including white, red, black and gray'},
    '14-17':{status:'pass',scenarios:['RUS requested #CC0000','AUT requested #FFFFFF','AUT/HUN merge preserves AUT identity, actual player reference, explicit name/color and history','grounded bounded normal grant and color in one production turn','development marked causal action','production unauthorized/debug rejection','server/local color grant agreement'],evidence:suites}},
  seedColors:{countryCount:pair.world.countryOrder.length,uniqueCanonicalColors:new Set(Object.values(pair.world.countriesById).map(c=>c.mapColor)).size,allSourceRgbPreserved:true,sourceMetadata:receipt('src/data/countries-2020.json')},
  immutableInputs:frozen,catalogRef:freeze.ref,
  commands:[{command:'npx.cmd vitest run (10 related suites)',exitCode:0,passed:suites[0].passed,evidence:suites[0].path},
    {command:"npx.cmd vitest run src/lib/map/catalog-consumer.test.ts -t 'catalog projection'",exitCode:0,passed:suites[1].passed,skipped:suites[1].skipped,evidence:suites[1].path},
    {command:'npx.cmd tsc --noEmit',exitCode:0},{command:'npx.cmd eslint (color and shared integration files)',exitCode:0},
    {command:'npm.cmd run build',exitCode:0},{command:'node scripts/smoke-prompt14-country-colors.mjs',exitCode:0,evidence:browserPath},
    {command:'git diff --check',exitCode:0}],
  browser:{...receipt(browserPath),mode:browser.mode,viewport:{width:1440,height:900},browserErrors:browser.browserErrors,
    scenarios:browser.scenarios.map(s=>({...s,screenshot:receipt(`${root}/browser/${s.screenshot}`)})),
    visualInspection:'Red fill with light outline and white fill with dark outline/label remain readable against adjacent countries and sea; screenshots inspected.'},
  filesChangedByThisRun:changes,
  remainingLimitations:['Browser scenarios use deterministic local provider responses through the real production UI and atomic runtime; no paid live model call was made.','This checkpoint covers 14-15 through 14-17. The full 14-18 through 14-20 integration/E2E/performance gates have not been executed here.'],
  unresolvedColorIssues:[],nextStage:'14-18 after the occupation checkpoint/review prerequisites are met; outside this request scope.'};
const checkpoint='reports/prompt14/14-17-country-color-checkpoint.json';
if(fs.existsSync(checkpoint)&&read(checkpoint).status==='blocked'){const history=`${root}/history`;fs.mkdirSync(history,{recursive:true});fs.copyFileSync(checkpoint,path.join(history,'before-integration-blocked-checkpoint.json'));}
fs.writeFileSync(checkpoint,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,completedTasks:report.completedTasks,testsPassed:suites.reduce((n,s)=>n+s.passed,0),seedColors:report.seedColors.countryCount,report:checkpoint}));
