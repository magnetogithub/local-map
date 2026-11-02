import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const root='reports/prompt14/14-17-country-color/review-f-remediation';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const receipt=p=>{const bytes=fs.readFileSync(p);return {path:p,sha256:hash(bytes),byteLength:bytes.length};};
const assert=(value,message)=>{if(!value)throw new Error(message);};
const previous=read(`${root}/previous-checkpoint.json`);
const commands=fs.readFileSync(`${root}/commands.jsonl`,'utf8').trim().split('\n').map(JSON.parse);
const latest=Object.fromEntries(commands.map(c=>[c.stage,c]));
for(const stage of ['tests','map','typecheck','lint','build','smoke','browserContract'])assert(latest[stage]?.exitCode===0,`Current ${stage} did not pass`);
const suites=['related-tests','map-tests','browser-contract-tests'].map(name=>{
  const file=`${root}/${name}.json`,result=read(file);assert(result.success&&result.numFailedTests===0,`Failed suite ${file}`);
  return {...receipt(file),passed:result.numPassedTests,skipped:result.numPendingTests,
    skippedTests:result.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='skipped'||t.status==='pending').map(t=>t.fullName)),
    testNames:result.testResults.flatMap(f=>f.assertionResults.filter(t=>t.status==='passed').map(t=>t.fullName))};
});
const browser=read(`${root}/browser/evidence.json`);assert(browser.status==='pass'&&browser.scenarios.length===3&&browser.turns.length===6,'Current browser smoke incomplete');
for(const scenario of browser.scenarios){
  assert(scenario.sourceUpdates===0&&scenario.before.projectionBuilds===scenario.after.projectionBuilds,'Color rebuilt a source/projection');
  assert(scenario.unauthorizedProductionDebugRejected&&scenario.redoColor===scenario.selectedColor,'Color history or production gate failed');
}
const freeze=read('data/catalogs/prompt14/frozen-catalog-ref.json'),pairPath=`data/catalogs/prompt14/${freeze.ref.catalogVersion}/migration-pair.json`;
const immutable=[{path:pairPath,expected:freeze.pairSha256},
  {path:`data/catalogs/prompt14/${freeze.ref.catalogVersion}/migration-mapping.json`,expected:freeze.mappingSha256},
  {path:'data/source-locks/prompt14-derived-game-input-lock.json',expected:freeze.sourceLockSha256}].map(e=>{
  const r=receipt(e.path);assert(r.sha256===e.expected,`Frozen bytes changed: ${e.path}`);return {...r,unchanged:true};
});
const seed=read(pairPath),colors=new Map(read('src/data/countries-2020.json').map(c=>[c.id,c.mapColor.toUpperCase()]));
for(const id of seed.world.countryOrder)assert(seed.world.countriesById[id].mapColor===colors.get(id),`Seed color changed: ${id}`);
const files=[
  'src/lib/simulation/presentation-grant-validation.ts','src/lib/simulation/country-color-intent.ts',
  'src/lib/simulation/country-color-authority.ts','src/lib/simulation/country-color-runtime.test.ts',
  'src/lib/simulation/simulation-context.ts','src/lib/simulation/world-effect.ts',
  'src/lib/simulation/semantic-validator.ts','src/lib/simulation/server/context-resolution-validator.ts',
  'src/lib/simulation/server/simulation-instruction.ts','src/lib/simulation/world-effect-compiler.ts',
  'scripts/smoke-prompt14-country-colors.mjs','scripts/verify-prompt14-review-f.mjs','scripts/report-prompt14-review-f.mjs',
].map(p=>({...receipt(p),previousCheckpointHash:previous.filesChangedByThisRun?.find(f=>f.path===p)?.sha256??null,
  baseline:'Previous checkpoint hash is historical, not a current-run starting hash. Current-run dirty status and tracked diff are archived; initial hashes of untracked files were not captured.',
  attribution:'Only Review F additions belong to this remediation; existing worktree content was retained.'}));
const allNames=new Set(suites.flatMap(s=>s.testNames));
const regressions=[
  ['lifecycleHistoryRejected','authority/reference lifecycle evidence rejected by server and local','Review F shared presentation authority regressions rejects'],
  ['futureConsequenceRejected','Due by turn end is insufficient before the causal date','rejects a consequence due by turn end'],
  ['normalEventApproved','Past event grant then color commits; reverse order fails','approves an actual past event'],
  ['normalQueuedActionApproved','Pending actor action accepted; wrong actor or completed action rejected','approves an actual pending actor action'],
  ['endedIdReuseRejected','Historical ID still rejected after its lifecycle source falls outside recentEvents','rejects expired ID reuse'],
  ['capsAndDuplicatesRejected','Duplicate grant, 128-authority cap and 256-ID history bound fail closed','rejects duplicate grants'],
  ['grantContractChecked','Actor, target, source date, validTo, canonical/allowed colors checked','rejects mismatched actor'],
  ['actualChoiceCommit','Requested RGB and fallback normalize to one-color grant + matching effect, commit, rollback and undo/redo','commits explicit choice'],
  ['mergeKeepsExistingColor','No color intent means existing initiator color; ID unchanged','retains initiator seed color'],
  ['explicitMergeChoiceCommit','Requested/fallback presentation applied after merger while preserving initiator ID and player','merges with explicit presentation choice'],
  ['noExtraAuthority','Strict choice intent cannot supply extra allowed colors; missing evidence/palette and extra unmatched color rejected','cannot enlarge the host single-color grant'],
  ['affectedProjectionOnly','Only presented territories; unchanged projection collections and zero whole-source update','applies RUS #CC0000'],
  ['controllerPresentation','Foreign-controlled owned territory excluded, controlled foreign territory included','uses controller color'],
  ['productionDebugRejected','Marked action cannot waive production authority in either validator','a marked debug action'],
  ['capturedServerContract','All six real browser context/stubbed responses validated against server policy','validates captured production browser'],
].map(([id,description,pattern])=>{
  const tests=[...allNames].filter(name=>name.includes(pattern));assert(tests.length,`No executed regression: ${id}`);return {id,status:'pass',description,tests};
});
const focusedInitial=read(`${root}/color-tests-initial-schema-failure.json`),focusedIntermediate=read(`${root}/color-tests-intermediate-failures.json`);
const report={schemaVersion:'prompt14-country-color-checkpoint-v2',status:'pass',generatedAt:new Date().toISOString(),
  baselineHead:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),completedTasks:['14-15','14-16','14-17'],
  scope:'Review F remediation of 14-15 through 14-17 only. No 14-18 or later work performed.',
  previousRun:{...receipt(`${root}/previous-checkpoint.json`),generatedAt:previous.generatedAt,statusReported:previous.status,
    role:'Archived historical result; not used as proof of current verification. Previous blanket success claims are superseded by this current run.'},
  currentRun:{baselineEvidence:[receipt(`${root}/baseline-status.txt`),receipt(`${root}/baseline-tracked.diff`)],
    baselinePolicy:'No reset, clean, checkout, staging or commit performed. Shared occupation/UI changes retained. Untracked starting byte hashes were not captured; previous checkpoint hashes are labelled as historical.',
    implementation:{sharedPolicy:'validatePresentationGrant with explicit context/full-state adapters; actual sources, causal dates, actor pending status, lifecycle exclusions, exact historical IDs and bounded collections.',
      intent:'country.chooseMapColor is explicit semantic presentation intent. The host expands it to exactly one-color bounded grant and matching country.changeMapColor, then normal server/local/atomic validation runs.',
      allocation:'Canonical requested RGB or deterministic fallback against complete unchanged base-world palette. Seed colors and initiator IDs are preserved; merge alone has no color effect.',
      history:'Exact sorted IDs plus completeness boolean, capped at 256. Missing/incomplete/exhausted history rejects new grants on both sides; no lossy reuse approval.'},
    commands,latestCommands:latest,evidence:suites.map(({testNames:omitted,...suite})=>{void omitted;return suite;}),uniquePassedTests:allNames.size,
    regressions,stages:{'14-15':'pass: common authority validation and actual allocator integration','14-16':'pass: atomic rollback, affected projection, zero whole-source updates, undo/redo','14-17':'pass: current production build, three browser choices and captured server validation'},
    browser:{...receipt(`${root}/browser/evidence.json`),mode:browser.mode,scenarios:browser.scenarios,
      captures:'Provider endpoint responses are deterministic stubs; captured contexts/responses additionally ran through the real server validator in Vitest.',
      visualInspection:'AUT white fill screenshot inspected: contrasting outline/selection and readable labels preserved.'},
    intermediateFailures:[
      {command:'npx.cmd vitest run src/lib/simulation/country-color-runtime.test.ts --reporter=json --outputFile=reports/prompt14/14-17-country-color/review-f-remediation/color-tests.json',exitCode:1,evidence:receipt(`${root}/color-tests-initial-schema-failure.json`),result:focusedInitial.testResults[0].message,fix:'Built a strict choice authority schema from fields; retained final grant date/color validation.'},
      {command:'npx.cmd vitest run src/lib/simulation/country-color-runtime.test.ts --reporter=json --outputFile=reports/prompt14/14-17-country-color/review-f-remediation/color-tests.json',exitCode:1,evidence:receipt(`${root}/color-tests-intermediate-failures.json`),passed:focusedIntermediate.numPassedTests,failed:focusedIntermediate.numFailedTests,fix:'Generated effect ID kept within 64-character contract; wrong-actor fixture uses its actual player country.'},
      {command:'npx.cmd vitest run src/lib/simulation/country-color-runtime.test.ts --reporter=json --outputFile=reports/prompt14/14-17-country-color/review-f-remediation/color-tests.json',exitCode:0,evidence:receipt(`${root}/color-tests.json`),role:'Intermediate smaller focused run (24 tests); final broader current suites supersede it.'},
    ],
    reproduction:{baselineMethod:'Source inspection identified server kind-only grounding and lack of ended-ID context; allocator had no production callers. The old validator was not restored or executed during this remediation.',
      currentMethod:'Executed invalid lifecycle/future-consequence/reused-ID inputs against both validators and valid event/queued-action inputs through actual atomic plans; see regression test names and logs.'},
    warnings:'Vitest emitted existing configLoader:native/CommonJS config advisory. Scoped lint, typecheck and production build passed.',
  },
  immutableSeedEvidence:immutable,seedColors:{verifiedCountries:seed.world.countryOrder.length,allOriginalRgbPreserved:true},
  filesChangedByThisRun:files,
  remainingLimitations:[
    'No paid/live model call. Browser provider responses were deterministic stubs, with real UI/runtime and separate server-contract verification.',
    'Server can validate only provided recentEvents/dueConsequences; local adapter has full simulation sources. Clipped sources cannot authorize a server grant.',
    'New grants fail closed when exact historical plus active presentation IDs reach 256, or history/palette is absent/incomplete. Existing valid authorities remain usable. Raising/redesigning this bound is not part of this remediation.',
    'Scoped related and map tests ran; broader map cases and the occupation captured-browser test are explicitly skipped, not passed. No 14-18+ integration/performance gate was run.',
    'Initial untracked-file hashes were not captured in this run; historical checkpoint hashes are not represented as current starting hashes.',
  ],unresolvedColorIssues:[],nextStage:'Review F remediation review only; 14-18 and later excluded by user instruction.'};
fs.writeFileSync('reports/prompt14/14-17-country-color-checkpoint.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,uniquePassedTests:allNames.size,browserScenarios:browser.scenarios.length,regressions:regressions.length}));
