import fs from 'node:fs';
import path from 'node:path';
import {atomicJSON,fileIdentity,validateIdentities} from './protocol.mjs';
import {digest} from './product-target.mjs';

// Acceptance text comes from the existing 48-task plan. A worker can implement
// tests for it, but cannot rewrite this controller-owned contract in a candidate.
export function taskContract(task,review){
  const number=Number(task.id.slice(3));
  let writablePaths=[];
  if(number>=11&&number<=17)writablePaths=['src/lib/operational-cells','scripts/operational-cells'];
  if(number>=18&&number<=24)writablePaths=['src/lib/operational-cells','scripts/operational-cells','data/operational-cells','public/operational-cells'];
  if(number>=25&&number<=30)writablePaths=['src/lib/commands','src/lib/planning','src/lib/operational-cells/lookup'];
  if(number>=31&&number<=35)writablePaths=['src/lib/simulation','src/lib/world','src/lib/operational-cells/migration'];
  if(number>=36&&number<=42)writablePaths=['src/lib/commands','src/lib/simulation','src/lib/world','src/lib/projection','src/lib/map','src/components/map','src/components/game','src/lib/test-only','e2e'];
  // Parallel branches own different files. Experiments consume the shared
  // prototype; country E2E branches consume the runtime completed by 15-38.
  // Reports stay in each candidate and are never merged over a sibling's data.
  let executionInstructions='';
  if(number===14){
    writablePaths=['scripts/operational-cells/representative-experiments'];
    executionInstructions='Implement representative geometry/graph experiments only in scripts/operational-cells/representative-experiments; read the prerequisite prototype, model and fixed policy without changing them. Put measurements, fixtures and acceptance tests in your candidate .reports. The identity/provenance branch runs concurrently in a different candidate; consume only your pinned prerequisites and never wait for or edit its in-flight output.';
  }
  if(number===15){
    writablePaths=['src/lib/operational-cells','scripts/operational-cells/identity-provenance'];
    executionInstructions='Implement stable ID/provenance in src/lib/operational-cells and optional CLI helpers in scripts/operational-cells/identity-provenance. Representative experiment scripts belong to 15-14; read the pinned prerequisite prototype without changing those scripts or waiting for that concurrent branch.';
  }
  if([39,40,41].includes(number)){
    const scenario=number===41?'slovenia':'korea';
    writablePaths=[`e2e/prompt15/${scenario}`,`src/lib/test-only/prompt15/${scenario}`];
    executionInstructions=`Implement ${scenario} E2E scenarios and helpers only in the assigned directories; read shared runtime/UI/provider code completed by 15-38 without changing it. Run against this candidate's own server with a unique available port, isolated browser context and separate game/save state using the project's supported storage settings. Keep output and temporary state inside this candidate .reports; record actual server, game and state identities in evidence. Never reuse a sibling's server, browser, game or output. Preserve real request-to-state-to-map assertions. Shared prerequisites that fail must be reported with concrete failing evidence, not bypassed or silently patched outside ownership.`;
  }
  // Final checks inspect the frozen candidate and put evidence in .reports.
  // Necessary scope extensions are operating repairs, never a model-written
  // replacement for the original product requirements or approved thresholds.
  const value={version:1,taskId:task.id,review,task,requirements:[
    {id:`${task.id}:acceptance`,text:task.check},
    {id:`${task.id}:preservation`,text:'Preserve original task requirements, immutable shared inputs and all behavior outside the assigned task; include an actual negative or preservation assertion.'},
  ],writablePaths,...(executionInstructions?{executionInstructions}:{}),verification:'controller-vitest',testPlanVersion:1};
  return {...value,contractDigest:digest(value)};
}

export function persistTaskContract(root,directory,task,review){
  const contract=taskContract(task,review),file=path.join(directory,'contract.json');
  if(fs.existsSync(file)){
    const old=JSON.parse(fs.readFileSync(file,'utf8'));
    if(digest(old)!==digest(contract))throw Error('Task acceptance contract changed; operating reconciliation required');
  }else atomicJSON(file,contract);
  return {value:contract,identity:fileIdentity(root,file)};
}

export function deterministicAssignment(task,review,candidateRoot,inputContextPath,contract){
  const semantics='Acceptance must test the original requirement on the current candidate. Historical measurements, a particular rejected policy, a generation error, a fixed attempt-context hash, or selectedPolicy=null are observations, not permanent success criteria. Preserve those cases as explicit negative fixtures. Require a real successful selection for a policy-selection task; compare geometry and cost reports against unchanged thresholds and actual inputs. Cover both valid and invalid inputs. A historical unit PASS does not resolve an authenticated whole-REVIEW failure.';
  const assignment={taskId:task.id,review,candidateRoot,inputContextPath,action:'implement',
    instructions:`${contract.executionInstructions?contract.executionInstructions+"\n\n":""}Implement only the original task below. Controller-owned acceptance contract ${JSON.stringify(contract)}. Write artifacts and a test-plan.json in candidate .reports. Do not run the official acceptance suite yourself: the controller executes it once. Use real Vitest test/expect; tests import candidate modules through @ or process.env.PROMPT15_CANDIDATE_ROOT. Relative imports may only refer to declared support files beside the test plan. Each required requirement id must appear in a real passing test name. Return testPlanPath. Format: {version:1,taskId,contractDigest,groups:[{environment:'node'|'jsdom',files:['acceptance.test.ts']}],supportFiles:[]}. Paths are relative to the test plan directory, exact regular files, no globs. Tests and support files are copied outside candidate before official execution. Once collection and actual required-criterion execution complete, that suite is frozen and reused unchanged for product repairs. Do not weaken tests to fix a product failure. Use process.env.PROMPT15_CANDIDATE_ROOT to read this attempt's artifacts. Original task: ${JSON.stringify(task)}`,
    writablePaths:contract.writablePaths,summary:`Direct assignment ${task.id}; fixed requirements, controller Vitest acceptance.`};
  const scopedSemantics=task.id==='15-17'
    ?'Acceptance must test the original task requirement on current pinned evidence. Complete the summary module, final artifacts, provenance and reproducible B handoff even when no policy qualifies. If a policy qualifies, select it only after all unchanged criteria pass. If none qualifies, produce a truthful diagnostic handoff: selectedPolicy=null, every rejection linked to actual evidence, approved existing catalog retained, and the responsible repair checkpoint identified. This scoped diagnostic completion never grants policy approval or REVIEW B PASS; independent REVIEW B must fail on unmet geometry, scope or cost gates and route responsible-task repair. Do not invent exceptions, relax thresholds, or alter prerequisites to make a selection. Historical exception counts and benchmark options are not acceptance thresholds.'
    :task.id==='15-14'
      ?'Complete the original representative geometry/graph experiment matrix, final summary, freeze receipt and preserved-input evidence from current pinned prerequisites. Report every measured rejection and physically infeasible scope honestly. Preserve meaningful successful near/current-frontier cases and all unchanged acceptance assertions. This task compares experiments; it does not select or approve a whole-REVIEW policy. Unmet whole-REVIEW gates or an impossible deeper scope on a small source are evidence to include in the complete matrix, not reasons to omit required outputs. Do not claim the prerequisite unit PASS resolved whole-REVIEW repairs, change thresholds, drop witnesses, or substitute a feasibility-only report for the required matrix. Independent REVIEW B remains responsible for policy approval and repair routing.'
      :semantics;
  assignment.instructions=scopedSemantics+'\n\n'+assignment.instructions;return assignment;
}

export function validateContractIdentity(root,receipt){validateIdentities(root,[receipt]);return JSON.parse(fs.readFileSync(path.resolve(root,receipt.path),'utf8'));}
