// Read-only observer. It does not start, stop, or send prompts to any Codex session.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {reviewActivity, executionProgress, operationView} from './prompt15-progress-core.mjs';
import {taskMessageSnapshot} from './prompt15-session-messages.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = path.join(root, 'reports/prompt15/orchestration');
const args = process.argv.slice(2);
const once = args.includes('--once');
const writeProgress = args.includes('--write');
const quiet = args.includes('--quiet');
const runIndex = args.indexOf('--run');
const selected = runIndex >= 0 ? args[runIndex + 1] : null;
const names = {supervisor: '총괄', implementer: '구현', verifier: '검증'};
const statusNames = {running: '실행 중', initializing: '세션 준비 중', blocked: '이전 버전 중단 상태', recovering: '실행 도구 복구 중', waiting_input: '필수 입력 대기 · 운영 유지', waiting_recovery: '복구 확인 대기 · 작업 정지', waiting_execution: '실행 장애 대기 · 검증 정지', stopped: '사용자 명령으로 중단', standby: 'F 통과 후 대기'};
const phaseNames = {verify: 'REVIEW 전체 독립 검증', task_verify: '구현 프롬프트 전체 수행 결과 검증', implementation_relay: '총괄이 구현 결과를 검증에 전달', supervise: '총괄 판정 및 보완 지시', implementation_handoff: '총괄이 검증 판정에 따라 다음 작업 배정', implement: '보완 또는 다음 단계 구현', parallel_implementation: '15-5 · 15-6 병렬 구현', standby: '사용자 지시 대기'};
const clock = new Intl.DateTimeFormat('ko-KR', {timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
function time(value) { return value ? clock.format(new Date(value)) : '-'; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function relative(file) { return path.relative(root, file).replaceAll('\\', '/'); }

function pidAlive(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}

export function controllerOwnsProgress(state,alive){
  // A slow heartbeat does not transfer write ownership during a bounded hash
  // operation or recovery. An uncertain live PID is conservatively cache-only.
  return state.implementationUnit==='task'&&Number.isInteger(state.controllerPid)&&state.controllerPid>0&&alive&&!['stopped','standby','manual_hold','completed','complete'].includes(state.status);
}

function publishText(file,text){
  const temporary=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary,text,'utf8');fs.renameSync(temporary,file);
}

export function taskProgressView(directory,{write=false,isAlive=pidAlive}={}){
  const stateFile=path.join(directory,'state.json'),state=readJSON(stateFile),view=taskMessageSnapshot(directory,state);
  let cacheWritten=false,progressWritten=false,controllerOwner=false;
  if(write){
    const serialized=JSON.stringify(view.cache,null,2)+'\n';
    if(!fs.existsSync(view.cacheFile)||fs.readFileSync(view.cacheFile,'utf8')!==serialized){publishText(view.cacheFile,serialized);cacheWritten=true;}
    // Re-read just before fallback publication so an owner/state transition
    // while collecting messages does not use the earlier ownership snapshot.
    const current=readJSON(stateFile);
    controllerOwner=controllerOwnsProgress(current,isAlive(current.controllerPid));
    if(!controllerOwner){
      const progress=path.join(directory,'progress.txt');
      if(fs.readFileSync(progress,'utf8').trimEnd()!==view.text){publishText(progress,`${view.text}\n`);progressWritten=true;}
    }
  }
  return{...view,cacheWritten,progressWritten,controllerOwner};
}

function events(file) {
  if (!fs.existsSync(file)) return [];
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - 256 * 1024);
  const buffer = Buffer.alloc(size - start);
  const handle = fs.openSync(file, 'r');
  try { fs.readSync(handle, buffer, 0, buffer.length, start); }
  finally { fs.closeSync(handle); }
  const lines = buffer.toString('utf8').split('\n');
  if (start) lines.shift();
  return lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}

function wrap(text, width = 90) {
  const lines = [];
  for (const paragraph of String(text).trim().split('\n')) {
    let line = '', length = 0;
    for (const character of paragraph) {
      const size = character.codePointAt(0) > 255 ? 2 : 1;
      if (length + size > width) { lines.push(line); line = ''; length = 0; }
      line += character;
      length += size;
    }
    lines.push(line);
  }
  return lines;
}

function runDirectory() {
  const directory = selected ? path.resolve(root, selected) : readJSON(path.join(base, 'latest.json')).directory;
  const local = path.relative(base, directory);
  if (path.isAbsolute(local) || local === '..' || local.startsWith(`..${path.sep}`)) throw Error('프로젝트의 orchestration 실행 폴더를 지정하세요.');
  return directory;
}

function snapshot(directory) {
  const savedState = readJSON(path.join(directory, 'state.json'));
  // Preserve the task runtime's progress and add bounded per-session messages.
  // This read-only observer never changes task state, dispatches or verdicts.
  if(savedState.implementationUnit==='task'){
    return taskProgressView(directory,{write:writeProgress}).text;
  }
  const state = operationView(savedState,readJSON(path.join(root,'automation/prompt15/config.json')));
  const manual=state.status==='manual_hold';
  let historyAudit;
  try{historyAudit=readJSON(path.join(directory,'control/history-audit-v12.json'));}catch{/* No legacy correction is needed for new runs. */}
  let update;
  try { update = readJSON(path.join(directory, 'runtime-update.json')); } catch { /* No revision is pending. */ }
  const log = events(path.join(directory, 'events.jsonl'));
  const messages = log.filter(event => event.kind === 'agent_message' && event.phase === 'commentary').slice(-4);
  const latest = log.filter(event => ['event', 'agent_message', 'dispatch', 'workflow_stopped'].includes(event.kind)).at(-1);
  const roleByThread = Object.fromEntries(Object.entries(state.threads ?? {}).map(([key, id]) => [id, state.threadNames?.[key] ?? names[key] ?? `[${key.replace('branch-', '')}] 구현`]));
  for (const event of log) if (event.kind === 'dispatch' && event.sessionName) roleByThread[event.threadId] = event.sessionName;
  let verification;
  if (state.latestVerification) {
    try { verification = readJSON(path.join(root, state.latestVerification)); } catch { /* A result may still be being published. */ }
  }
  let prerequisite;
  if (state.latestPrerequisiteVerification) {
    try { prerequisite = readJSON(path.join(root, state.latestPrerequisiteVerification)); } catch { /* A prerequisite result may still be being published. */ }
  }
  const waitingForB = state.review === 'B' || (state.review === 'C' && !state.certificates?.C && (
    state.activeReview === 'B' || (prerequisite && prerequisite.verdict !== 'pass' && !state.prerequisiteCertificates?.B)
  ));
  const activity = {verify: '전체 검증 중', task_verify: '태스크 검증 중', implementation_relay: '검증 전달 중', supervise: '총괄 판정 중', implementation_handoff: '검증 후 배정 중', implement: '보완 중', parallel_implementation: '구현 중'};
  const gate = review => {
    if (state.baselinePending) return '14 검증 통과 대기';
    if (state.certificates?.[review] || (review === 'B' && state.prerequisiteCertificates?.B)) return 'PASS';
    if (review === 'C' && waitingForB) return 'B 통과 대기';
    if (review === 'B') {
      if (state.activeReview === 'B') return reviewActivity(state, activity);
      if (waitingForB) return state.phase === 'implement' ? '보완 중' : '후속 배정 대기';
      return '대기';
    }
    return state.review === review ? reviewActivity(state, activity) : '대기';
  };
  const reviews = state.entryReview === 'A' ? ['A', 'B', 'C', 'D', 'E', 'F'] : prerequisite || state.activeReview === 'B' || state.prerequisiteCertificates?.B ? ['B', 'C', 'D', 'E', 'F'] : ['C', 'D', 'E', 'F'];
  const lastResults = [prerequisite, verification].filter(Boolean).map(report => `${report.review} [${report.verdict.toUpperCase()}]`);
  let taskVerification;
  if (state.latestTaskVerification) {
    try { taskVerification = readJSON(path.join(root, state.latestTaskVerification)); } catch { /* Wait for the complete task result. */ }
  }
  const output = [
    'PROMPT 15  실시간 진행 상황',
    '────────────────────────────────────────────────────────────────────',
    `상태: ${manual ? '수동 검증 모드 · 자동 실행 정지' : statusNames[state.status] ?? state.status}    목표 ${state.baselinePending ? 'Prompt 14 검증' : `REVIEW ${state.resumeAfterPrerequisite ?? state.review}`}${manual?'':`    라운드 ${state.round}    보완 ${state.repairAttempts}회`}`,
    `단계: ${{manual_baseline:'별도 수동 검증 결과 대기 · 이 오케스트레이션은 검증하지 않음',baseline_verify:'Prompt 14 독립 검증',baseline_supervise:'총괄이 Prompt 14 보완 배정',baseline_implement:'Prompt 14 보완 구현',prepare:'A 구현 준비'}[state.phase] ?? (waitingForB && state.phase === 'implement' ? '선행 REVIEW B 보완' : phaseNames[state.phase] ?? state.phase)}`,
    ...(state.implementationUnit === 'review' && !state.baselinePending ? [`구현 단위: REVIEW ${state.review}의 남은 보완 전체 → 독립 전체 검증`] : []),
    `시작점: Prompt 14 [${manual?'수동 검증 · 자동 접수 없음':state.baselineCertificate ? 'PASS' : state.baselinePending ? '검증·보완 중' : '해당 없음'}] → A 검증 → B 구현`,
    ...(historyAudit?[`이전 자동 실행 감사: FAIL 관측 ${historyAudit.observedFailures}회 · 고유 실패 입력 ${historyAudit.uniqueFailureInputs}종 · 보완 배정 ${historyAudit.repairAssignments}회 (원본 판정 보존)`]:[]),
    ...(state.currentProductTarget?[`실제 후보: ${state.currentProductTarget.productRoot}`,`후보 identity: ${state.currentProductTarget.targetId.slice(0,16)}`]:[]),
    `리뷰 진행: ${reviews.map(review => `${review} [${gate(review)}]`).join(' → ')}`,
    ...(lastResults.length ? [`마지막 검증 결과: ${lastResults.join(' · ')}`] : []),
    ...(taskVerification ? [taskVerification.fullReview
      ? `최근 통합 검증: REVIEW ${taskVerification.review} ${taskVerification.verdict.toUpperCase()} · 프롬프트 수행과 전체 기준 함께 판정`
      : `최근 프롬프트 수행 검증: ${taskVerification.verdict.toUpperCase()} · REVIEW 전체 판정과 별도`] : []),
    '',
  ];
  let stageProgress;
  if (state.activeVerification?.reportDirectory) {
    try { stageProgress = readJSON(path.join(root, state.activeVerification.reportDirectory, 'stages/progress.json')); } catch { /* Stage plan may not be registered yet. */ }
  }
  output.push(...executionProgress(state, stageProgress));
  for (const [role, label] of Object.entries(names)) {
    const active = state.status === 'running' && state.activeRole === role;
    const taskLabel = role === 'implementer' ? `[${{A: '15-1·15-2', B: '15-3', C: '15-4', D: '15-6', E: '15-7', F: '15-8'}[state.review]}] 구현` : label;
    output.push(`${active ? '▶' : '○'} ${state.threadNames?.[role] ?? taskLabel}: ${active ? phaseNames[state.phase] ?? '작업 중' : '대기'}  (${state.threads?.[role]?.slice(-8) ?? '태스크 배정 시 생성'})`);
  }
  if (update && update.status !== 'applied') output.push(`운영 규칙 v${update.targetVersion}: ${update.status === 'waiting_for_task_report' ? '현재 태스크 보고 저장 후 자동 전환 대기' : update.status}`);
  for (const [key, session] of Object.entries(state.implementationSessions ?? {})) if (key.startsWith('review-')) output.push(`○ ${state.threadNames[key]}: 해당 리뷰 복귀까지 보관  (${session.threadId.slice(-8)})`);
  for (const [key, name] of Object.entries(state.threadNames ?? {})) if (key.startsWith('branch-')) output.push(`▶ ${name}: 격리 작업 공간에서 구현  (${state.threads?.[key]?.slice(-8)})`);
  const strikes = state.reviewStrikes?.[state.activeReview ?? state.review];
  if (strikes) output.push(`3스트라이크: ${strikes.sinceStrategyChange}/3    해당 리뷰 누적 미통과 ${strikes.totalFailures}회    방식 재검토 ${strikes.strategyChanges}회`);
  output.push('', `${manual ? '이전 자동 실행 기록의' : '프로세스'} PID: ${state.controllerPid ?? '-'}    ${manual ? '마지막' : ''} heartbeat: ${time(state.heartbeatAt)} KST`,
    `최근 작업 이벤트: ${time(latest?.at)} KST${latest?.itemType ? ` / ${latest.itemType}` : ''}`);
  if (state.runtimeSupervisorPid) output.push(`${manual ? '이전 자동 실행 기록의' : '로컬 복구 감시'} PID: ${state.runtimeSupervisorPid}`);
  if (state.error) output.push('', ...wrap(`현재 복구·대기 사유: ${state.error}`));
  output.push('',manual?'이전 자동 실행의 역할별 메시지 (현재 수동 검증 진행과 별도)':'최근 역할별 메시지', '────────────────────────────────────────────────────────────────────');
  if (!messages.length) output.push('아직 메시지가 없습니다. 세션 준비 또는 첫 응답을 기다리는 중입니다.');
  for (const message of messages) output.push(`[${time(message.at)}] ${roleByThread[message.threadId] ?? 'Codex'}`, ...wrap(message.text), '');
  output.push(`기록: ${relative(directory)}`);
  if (writeProgress) output.push('이 파일은 자동으로 갱신됩니다. VS Code에서 읽기용으로 열어두세요.');
  else output.push('Ctrl+C: 이 모니터만 종료합니다. 자동 운영은 계속 실행됩니다.');
  return output.join('\n');
}

let lastSaved = '';
let watchedDirectory=null,watcher,refresh;
function render() {
  try {
    const directory = runDirectory();
    const output = snapshot(directory);
    const taskMode=readJSON(path.join(directory,'state.json')).implementationUnit==='task';
    if(writeProgress&&!once&&taskMode&&watchedDirectory!==directory){
      watcher?.close();watchedDirectory=directory;
      watcher=fs.watch(directory,(_event,name)=>{
        if(!['progress.txt','events.jsonl','state.json'].includes(String(name)))return;
        // Continuous tool notifications must not keep postponing the update.
        if(refresh)return;
        refresh=setImmediate(()=>{refresh=null;render();});
      });
    }
    // Task mode publishes through taskProgressView: an active controller is
    // the only progress.txt writer; the observer publishes its cache instead.
    if (writeProgress && !taskMode && output!==lastSaved) {
      const destination = path.join(directory, 'progress.txt');
      publishText(destination,`${output}\n`);
      lastSaved = output;
    }
    if (quiet) return;
    if (process.stdout.isTTY && !once) process.stdout.write('\u001b[2J\u001b[H');
    console.log(output);
  } catch (error) {
    console.error(`진행 상황을 읽을 수 없습니다: ${error.message}`);
    if (once) process.exitCode = 1;
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  render();
  if (!once) {
    const timer = setInterval(render, writeProgress ? 1000 : process.stdout.isTTY ? 2000 : 10000);
    const stop=()=>{clearInterval(timer);clearImmediate(refresh);watcher?.close();if(!quiet)process.stdout.write('\n모니터를 종료했습니다.\n');};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }else watcher?.close();
}
