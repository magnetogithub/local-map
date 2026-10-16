import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {
  REVIEWS, REPAIR_REVIEWS, CHECKPOINTS, GATES, VERIFICATION_SCHEMA, SUPERVISION_SCHEMA, IMPLEMENTATION_SCHEMA,
  validateVerification, validateDecision, validateBranchPlans, validateIdentities,
  fileIdentity, sourceSnapshot, changedPaths, atomicJSON, resolveInside, normalizeVerification,
  IMPLEMENTATION_HANDOFF_SCHEMA, validateImplementationHandoff,
  TASK_RELAY_SCHEMA, TASK_VERIFICATION_SCHEMA, TASK_GATES, validateTaskVerification,
  BOUND_IMPLEMENTATION_SCHEMA, BOUND_VERIFICATION_SCHEMA, BOUND_TASK_VERIFICATION_SCHEMA,
} from './protocol.mjs';
import {classifyFailure, recordRuntimeFailure, recordReviewResult, recordTaskResult, strategyInstruction, recordStrategyChange, RUNTIME_VERSION} from './policy.mjs';
import {VerificationStages} from './verification-stages.mjs';
import {createVerificationStages} from './verification-stages-compact.mjs';
import {reviewBOutcome} from './review-b-outcome.mjs';
import {prepareWorkspace, planWorkspaceMerge, applyWorkspaceMerge, workspaceSnapshot} from './workspaces.mjs';
import {requireReviewCoverage, reviewUnitInstructions} from './units.mjs';
import {taskPlanInstructions} from './task-plan.mjs';
import {assertLaunchAllowed} from './launch-policy.mjs';
import {captureProductTarget, validateProductTarget, attestProductTarget, failureAttemptKey, productSnapshot, digest} from './product-target.mjs';

const stamp = () => new Date().toISOString();
export function runName() {
  const koreanTime = new Date(Date.now() + 9 * 3600000).toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `${koreanTime}-KST-${randomUUID().slice(0, 8)}`;
}

export class Workflow {
  constructor({root, directory, config, configFile = null, server, log = () => {}, resume = false}) {
    this.root = path.resolve(root);
    this.directory = path.resolve(directory);
    this.config = config;
    this.configFile = configFile;
    this.server = server;
    this.log = log;
    this.stateFile = path.join(directory, 'state.json');
    this.state = resume ? JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) : {
      version: 1, runId: path.basename(directory), projectRoot: this.root, status: 'initializing',
      review: config.startReview === 'A' ? 'A' : 'C', entryReview: config.startReview === 'A' ? 'A' : 'C',
      startupPending: config.startReview === 'A', phase: config.startReview === 'A' ? 'prepare' : 'verify',
      baselinePending: config.baselineVerification === true,
      round: 0, repairAttempts: 0, threads: {}, certificates: {},
      createdAt: stamp(), ...(config.startReview === 'A' ? {} : {initialReviewC: 'failed'}),
      nextAction: config.startReview === 'A' ? 'Assign fresh 15-1/15-2 implementation' : 'Independent REVIEW C revalidation',
    };
    if (this.state.projectRoot !== this.root) throw Error('Resume project does not match the recorded project');
    this.resumePendingVerification = resume && this.state.status === 'blocked' && this.state.phase === 'verify' && !this.state.latestVerification;
    this.resumePendingImplementation = resume && (Boolean(this.state.pendingImplementation) ||
      (this.state.phase === 'implement' && this.state.error?.startsWith('Implementation requires attention:')));
    this.resumeInterruptedImplementation = resume && !this.state.pendingImplementation && Boolean(this.state.interruptedImplementation ?? this.state.activeImplementation);
    this.prompt = fs.readFileSync(resolveInside(this.root, config.promptPath), 'utf8');
    this.operatingRules = fs.readFileSync(resolveInside(this.root, config.rulesPath), 'utf8');
    this.promptIdentity = fileIdentity(this.root, config.promptPath);
    this.stopped = false;
    const previousRuntimeVersion = this.state.runtimeVersion ?? 1;
    this.state.runtimeVersion = RUNTIME_VERSION;
    this.reviewUnits = config.implementationUnit !== 'checkpoint';
    this.state.implementationUnit = this.reviewUnits ? 'review' : 'checkpoint';
    this.state.implementationSessions ??= {};
    this.state.threadNames ??= {};
    this.state.branchWorkspaces ??= {};
    // v8 kept only final responses. Retain its unfinished independent evidence
    // folder for explicit validation/adoption; never turn old claims into PASS.
    if (resume && config.verificationStages && !this.state.activeVerification && this.state.phase === 'verify' && this.state.round > 0) {
      const directory = path.join(this.directory, 'rounds', `${String(this.state.round).padStart(4, '0')}-${this.state.activeReview ?? this.state.review}`);
      if (fs.existsSync(path.join(directory, 'verifier-request.txt')) && !fs.existsSync(path.join(directory, 'verification.json'))) {
        this.state.activeVerification = {jobId: randomUUID(), review: this.state.activeReview ?? this.state.review, round: this.state.round,
          reportDirectory: this.relative(path.join(directory, 'verification')), taskId: this.state.nextVerificationAssignment?.implementationTask?.taskId ?? null,
          attempt: 1, legacyEvidence: true, startedAt: stamp()};
      }
    }
    // Older runtimes could only represent C/F repairs, even when the supervisor
    // explicitly returned to 15-3. Preserve that report and the C conversation.
    if (resume && previousRuntimeVersion < 3 && this.state.review === 'C' && this.state.latestPrerequisiteVerification) {
      const prerequisite = JSON.parse(fs.readFileSync(resolveInside(this.root, this.state.latestPrerequisiteVerification), 'utf8'));
      if (prerequisite.verdict !== 'pass') {
        this.state.resumeAfterPrerequisite = 'C';
        this.state.review = 'B';
        if (this.state.pendingImplementation) this.state.pendingImplementation.review = 'B';
        this.event('prerequisite_checkpoint_routing_corrected', {checkpoint: '15-3', previousCheckpoint: '15-4'});
      }
    }
  }

  relative(file) { return path.relative(this.root, file).replaceAll('\\', '/'); }
  get productRoot() { return this.state.productRoot ?? this.root; }
  get boundTargets() { return this.config.boundProductTargets === true; }
  controlSnapshot() {
    const snapshot=sourceSnapshot(this.root);
    if(!this.boundTargets)return snapshot;
    const selected=Object.fromEntries(Object.entries(snapshot).filter(([name])=>
      name.startsWith('scripts/prompt15-orchestrator/')&&!name.endsWith('.node-test.mjs') ||
      name.startsWith('automation/prompt15/') || name===this.config.rulesPath || name===this.config.promptPath || ['AGENTS.md','CLAUDE.md'].includes(name)));
    // A live model/effort change does not change product acceptance policy.
    if(this.configFile){const name=this.relative(this.configFile);if(selected[name]){
      const config=JSON.parse(fs.readFileSync(this.configFile,'utf8'));
      config.roles=Object.fromEntries(Object.entries(config.roles).map(([role,settings])=>{
        const policy={...settings};delete policy.model;delete policy.effort;return [role,policy];
      }));
      selected[name]=digest(config);
    }}
    return selected;
  }

  ensureProductWorkspace() {
    if (!this.boundTargets) return null;
    this.state.productWorkspaces ??= {};
    let workspace = this.state.productWorkspaces[this.state.review];
    if (!workspace || workspace.frozen) {
      const approved = workspace?.target ?? this.state.approvedProductTarget;
      validateProductTarget(this.root, approved);
      this.state.productWorkspaceSequence ??= {};
      const sequence=(this.state.productWorkspaceSequence[this.state.review]??0)+1;
      const directory = path.join(this.directory, 'work', 'products', `review-${this.state.review}-${String(sequence).padStart(3,'0')}`);
      if (workspace) (this.state.retiredProductWorkspaces??=[]).push({...workspace,review:this.state.review,reason:'fork approved candidate for repair'});
      workspace = prepareWorkspace(approved.productRoot, directory, {writablePaths:[]}, {controlRoot:this.root,sourceOnly:true});
      this.state.productWorkspaceSequence[this.state.review]=sequence;
      this.state.productWorkspaces[this.state.review] = workspace;
      this.state.productRoot = directory;
      this.save();
    }
    this.state.productRoot = workspace.directory;
    return workspace;
  }
  save() { this.state.updatedAt = stamp(); atomicJSON(this.stateFile, this.state); }
  record(name, value) { const file = path.join(this.roundDirectory, `${name}.json`); atomicJSON(file, value); return this.relative(file); }
  event(kind, detail = {}) { this.log({at: stamp(), kind, review: this.state.review, ...detail}); }

  settingsFor(role) {
    if (this.configFile) {
      const updated = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      // Only model settings are live. Task instructions and permissions keep their run configuration.
      for (const name of ['supervisor', 'implementer', 'verifier']) {
        this.config.roles[name].model = updated.roles[name].model;
        this.config.roles[name].effort = updated.roles[name].effort;
      }
    }
    this.state.modelSettings = Object.fromEntries(Object.entries(this.config.roles).map(([name, settings]) => [name, {model: settings.model, effort: settings.effort}]));
    return this.config.roles[role];
  }

  instructions(role, workingRoot = this.root) {
    return fs.readFileSync(resolveInside(this.root, this.config.roles[role].promptPath), 'utf8') +
      `\n\n이번 태스크 작업 경로: ${workingRoot}\n실제 제품 경로: ${this.productRoot}\n운영 코드·기록 저장소(제품 검사 대상으로 대체 금지): ${this.root}\n운영 규칙:\n${this.operatingRules}\n\n기능 명세 원문:\n${this.prompt}`;
  }

  async thread(role, key = role, options = {}) {
    const settings = this.settingsFor(role);
    if (role === 'implementer' && !options.cwd) this.ensureProductWorkspace();
    const cwd = options.cwd ?? (role === 'implementer' ? this.productRoot : path.join(this.directory, 'work', key));
    fs.mkdirSync(cwd, {recursive: true});
    const params = {
      cwd, approvalPolicy: this.config.approvalPolicy, approvalsReviewer: this.config.approvalsReviewer,
      sandbox: role === 'supervisor' ? 'read-only' : 'workspace-write',
      developerInstructions: this.instructions(role, cwd),
      ...(settings.model ? {model: settings.model} : {}),
      ...(settings.effort ? {config: {model_reasoning_effort: settings.effort}} : {}),
    };
    const prior = this.state.threads[key];
    let response;
    let recreatedUnusedThread = false;
    try {
      response = await this.server.request(prior ? 'thread/resume' : 'thread/start', prior ? {...params, threadId: prior} : params);
    } catch (error) {
      // app-server may not persist a newly prepared thread until its first turn.
      // Recreate only a proven unused thread; never discard an existing conversation.
      const logFile = path.join(this.directory, 'events.jsonl');
      const history = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').some(line => {
        try { const event = JSON.parse(line); return event.threadId === prior && (event.method === 'turn/started' || event.kind === 'agent_message'); }
        catch { return false; }
      }) : false;
      if (!prior || history || !error.message.includes('no rollout found for thread id')) throw error;
      response = await this.server.request('thread/start', params);
      recreatedUnusedThread = true;
    }
    this.state.threads[key] = response.thread.id;
    const checkpoint = options.checkpoint ?? this.state.implementationSessions[key]?.checkpoint ?? CHECKPOINTS[this.state.review].at(-1);
    const name = role === 'implementer' ? `[${checkpoint}] 구현` : role === 'supervisor' ? '총괄' : '검증';
    this.state.threadNames[key] = name;
    if (role === 'implementer') this.state.implementationSessions[key] = {threadId: response.thread.id, checkpoint, review: this.state.review, cwd};
    try { await this.server.request('thread/name/set', {threadId: response.thread.id, name}); }
    catch (error) { this.event('thread_name_pending', {key, name, reason: error.message}); }
    this.save();
    this.event(recreatedUnusedThread ? 'unused_thread_recreated' : prior ? 'thread_resumed' : 'thread_created', {role, key, threadId: response.thread.id});
    return response.thread.id;
  }

  async retireThread(key, reason) {
    const threadId = this.state.threads[key];
    if (!threadId || !this.state.implementationSessions[key]) return;
    this.state.retiredSessions ??= [];
    const retired = {...this.state.implementationSessions[key], name: this.state.threadNames[key], reason, retiredAt: stamp(), cleanup: 'pending'};
    this.state.retiredSessions.push(retired);
    delete this.state.threads[key];
    delete this.state.implementationSessions[key];
    delete this.state.threadNames[key];
    this.save();
    try { await this.server.request('thread/delete', {threadId}); retired.cleanup = 'deleted'; }
    catch (error) {
      if (/method not found|unknown method|-32601/i.test(error.message)) {
        try { await this.server.request('thread/archive', {threadId}); retired.cleanup = 'archived-delete-unsupported'; }
        catch (archiveError) { retired.error = archiveError.message; }
      } else retired.error = error.message;
    }
    this.save();
    this.event('implementation_session_retired', {threadId, reason, cleanup: retired.cleanup});
  }

  async ensureImplementationSession() {
    const restored = this.selectImplementationSession();
    const checkpoint = CHECKPOINTS[this.state.review].at(-1);
    if (restored || !this.state.threads.implementer) await this.thread('implementer', 'implementer', {checkpoint});
  }

  moveImplementationSession(from, to) {
    for (const field of ['threads', 'implementationSessions', 'threadNames']) {
      this.state[field][to] = this.state[field][from];
      delete this.state[field][from];
    }
  }

  selectImplementationSession() {
    let restored = false;
    const current = this.state.implementationSessions.implementer;
    if (current && current.review !== this.state.review) {
      const held = `review-${current.review}-implementation`;
      if (this.state.threads[held]) throw Error('An unfinished review implementation is already retained');
      this.moveImplementationSession('implementer', held);
      this.event('implementation_session_held', {review: current.review, threadId: current.threadId});
    }
    const retained = `review-${this.state.review}-implementation`;
    if (!this.state.threads.implementer && this.state.threads[retained]) { this.moveImplementationSession(retained, 'implementer'); restored = true; }
    this.save();
    return restored;
  }

  waitForInput(decision) {
    this.state.requiredUserInput = {kind: decision.blockerKind, evidence: decision.blockerEvidence, summary: decision.summary};
    throw Error(`Supervisor requires ${decision.blockerKind}: ${decision.blockerEvidence}`);
  }

  async initialize() {
    if (this.state.status === 'standby') return false;
    const baseline = assertLaunchAllowed(this.root, this.config, this.state);
    if (this.boundTargets && !this.state.approvedProductTarget) {
      this.state.approvedProductTarget = baseline.target;
      this.state.currentProductTarget = baseline.target;
      this.state.productRoot = baseline.target.productRoot;
      this.state.baselineCertificate = {verification:baseline.verification, target:baseline.target, mode:'manual-independent'};
      this.save();
    }
    await this.server.initialize();
    // Three independent roots: no forking/copying another role's conversation.
    for (const role of ['supervisor', 'implementer', 'verifier']) {
      if (role === 'implementer') this.selectImplementationSession();
      await this.thread(role);
    }
    // Historical verification verdicts count once; implementation reports and
    // transport failures are not strikes. The original functional prompt is untouched.
    const rounds = path.join(this.directory, 'rounds');
    if (fs.existsSync(rounds)) for (const name of fs.readdirSync(rounds).sort()) {
      const file = path.join(rounds, name, 'verification.json');
      if (fs.existsSync(file)) recordReviewResult(this.state, JSON.parse(fs.readFileSync(file, 'utf8')), this.relative(file));
    }
    // v5 validated these reports but did not count their task-level verdicts.
    for (const task of this.state.taskVerificationHistory ?? []) {
      const file = resolveInside(this.root, task.path);
      if (fs.existsSync(file)) recordTaskResult(this.state, JSON.parse(fs.readFileSync(file, 'utf8')), task.path);
    }
    // Recover uncertain/interrupted work by reviewing current bytes, never by assuming a turn succeeded.
    this.state.status = 'running';
    delete this.state.error;
    this.state.phase = this.boundTargets && this.state.phase === 'supervise' ? 'supervise' : this.state.baselinePending ? 'baseline_verify' : this.state.startupPending ? 'prepare' : 'verify';
    this.state.nextAction = this.state.baselinePending ? 'Independently verify Prompt 14 baseline' : this.state.startupPending ? 'Assign fresh REVIEW A implementation' : `Verify REVIEW ${this.state.review}`;
    this.save();
    return true;
  }

  ensureRunning() {
    if (this.stopped || fs.existsSync(path.join(this.directory, 'stop.json'))) throw Error('Workflow stop requested');
    if (this.configFile && JSON.parse(fs.readFileSync(this.configFile,'utf8')).executionMode === 'manual-prompt14') throw Error('Manual baseline gate: execution disabled by operator; no automatic retry');
    const prompt = fileIdentity(this.root, this.config.promptPath);
    if (prompt.sha256 !== this.promptIdentity.sha256) throw Error('Prompt 15 changed during this run; resume to reload the specification');
  }

  async turn(role, key, prompt, schema, reportDirectory = this.roundDirectory) {
    this.ensureRunning();
    const suffix = role === 'verifier' && key === 'verifier' && this.state.activeVerification?.attempt > 1 ? `-resume-${this.state.activeVerification.attempt}` : '';
    const requestFile = path.join(this.roundDirectory, `${key}${suffix}-request.txt`);
    const workspace = this.state.branchWorkspaces[key] ?? (role === 'implementer' && this.boundTargets ? this.ensureProductWorkspace() : null);
    const sandboxPolicy = role === 'supervisor' ? {type: 'readOnly', networkAccess: false} : {
      type: 'workspaceWrite', networkAccess: false,
      writableRoots: role === 'implementer' ? [workspace?.directory ?? this.productRoot] : [reportDirectory, path.join(this.directory, 'work', 'verifier')],
    };
    const cwd = role === 'implementer' ? workspace?.directory ?? this.productRoot : role === 'verifier' ? reportDirectory : path.join(this.directory, 'work', 'supervisor');
    if (role === 'implementer' && this.boundTargets) {
      schema = BOUND_IMPLEMENTATION_SCHEMA;
      prompt += `\n\n고정 제품 작업 경로: ${cwd}. 최종 candidateRoot는 반드시 이 경로다. 다른 중첩 후보나 원본 저장소의 변경은 완료로 인정하지 않는다. inputManifestPath에는 실제 산출물·공유 생성 입력을 pin한 version=1, inputs=[{path,sha256,byteLength}] JSON 경로를 쓴다. 각 pin의 path는 실제 소비 파일의 절대 경로이며 제품 source/config는 이 후보 안에 있어야 한다. 산출물이 없을 때만 빈 문자열을 쓴다. 운영 코드·승인 baseline은 수정하지 않는다.`;
      prompt += `\n\n이번 구현 배정의 쓰기 가능한 산출물 경로: ${path.join(cwd,'.reports','prompt15-tasks',path.basename(this.roundDirectory),key)}. 세부 작업 기록은 이 경로 아래 <taskId>/result.json, 공통 입력 manifest와 산출물도 이 제품 작업본 안에 저장하고 artifactPaths/inputManifestPath로 전달한다. 앞서 언급된 controlRoot의 run/보고서 경로는 컨트롤러 저장 위치이며 구현 역할의 출력 경로로 사용하지 않는다.`;
    }
    const settings = this.settingsFor(role);
    const unit = this.reviewUnits && !key.startsWith('branch-') ? 'review' : 'checkpoint';
    const savedResponseFile = requestFile.replace(/-request\.txt$/, '-response.json');
    if (this.boundTargets && fs.existsSync(savedResponseFile)) {
      const saved = JSON.parse(fs.readFileSync(savedResponseFile,'utf8'));
      if (!saved.turnId || saved.schemaDigest !== digest(schema) || saved.cwd !== cwd || fs.readFileSync(requestFile,'utf8') !== `${prompt}\n`) throw Error('Target binding: saved turn does not match the exact assignment');
      validateIdentities(this.root,[saved.requestIdentity]);
      if (role === 'implementer' && saved.productSourceDigest !== digest(productSnapshot(cwd))) throw Error('Target binding: product changed after completed implementation turn');
      if (role === 'implementer' && !key.startsWith('branch-')) this.state.pendingImplementation = {responsePath:this.relative(savedResponseFile),review:this.state.review,unit};
      this.save(); this.event('completed_turn_reused',{role,key,turnId:saved.turnId});
      return saved.result;
    }
    if (this.boundTargets && fs.existsSync(requestFile)) throw Error('Target binding: unconfirmed dispatch already exists; recover the saved task instead of overwriting it');
    fs.writeFileSync(requestFile, `${prompt}\n`, {flag: 'wx'});
    this.state.activeRole = role;
    if (role === 'implementer' && !key.startsWith('branch-')) {
      this.state.activeImplementation = {review:this.state.review, key, unit, threadId:this.state.threads[key] ?? this.state.threads[role],
        requestIdentity:fileIdentity(this.root, requestFile), reportDirectory:this.relative(reportDirectory), startedAt:stamp()};
      delete this.state.interruptedImplementation;
    }
    const directive = this.state.latestSupervisorInstruction;
    if (role === 'implementer' && this.state.review === 'B' && directive?.status === 'supervisor_decided') {
      directive.status = 'implementation_dispatched';
      directive.implementationThreadId = this.state.threads[key] ?? this.state.threads[role];
      directive.implementationRequest = this.relative(requestFile);
      directive.updatedAt = stamp();
      atomicJSON(resolveInside(this.root, directive.receiptPath), directive);
    }
    this.save();
    this.event('dispatch', {role, key, responseKey: `${key}${suffix}`, threadId: this.state.threads[key] ?? this.state.threads[role], reportDirectory: this.relative(reportDirectory), sessionName: this.state.threadNames[key] ?? this.state.threadNames[role], model: settings.model, effort: settings.effort});
    const result = await this.server.runTurn(this.state.threads[key] ?? this.state.threads[role], prompt, schema, {
      cwd, sandboxPolicy,
      ...(settings.model ? {model: settings.model} : {}),
      ...(settings.effort ? {effort: settings.effort} : {}),
    }, {executionIdleTimeoutMs: role === 'verifier' ? this.config.verifierExecutionIdleTimeoutMs : 0});
    if (role === 'implementer' && this.boundTargets && path.resolve(result.value.candidateRoot ?? '') !== cwd) throw Error('Target binding: implementation returned a different candidate root');
    // Completed turns break a consecutive runtime-failure streak. REVIEW strikes
    // are separate and remain exclusively based on independent verdicts.
    this.state.recoveryAttempts = 0;
    delete this.state.executionFailure;
    const responsePath = this.record(`${key}${suffix}-response`, {threadId: this.state.threads[key] ?? this.state.threads[role], turnId: result.turnId, result: result.value,
      ...(this.boundTargets ? {requestIdentity:fileIdentity(this.root,requestFile),schemaDigest:digest(schema),cwd,
        ...(role === 'implementer' ? {productSourceDigest:digest(productSnapshot(cwd))} : {})} : {}),
      ...(role === 'implementer' ? {implementationUnit:unit} : {})});
    if (role === 'implementer' && !key.startsWith('branch-')) {
      delete this.state.activeImplementation;
      delete this.state.interruptedImplementation;
      this.state.pendingImplementation = {responsePath, review: this.state.review, unit};
      this.state.latestImplementationArtifacts = result.value.artifactPaths;
      this.save();
    }
    if (this.boundTargets && role === 'verifier' && key === 'verifier') {
      this.state.completedVerificationTurn = {responsePath,review:this.state.review,round:this.state.round,
        targetId:this.state.currentProductTarget.targetId,turnId:result.turnId};
      this.save();
    }
    this.ensureRunning();
    return result.value;
  }

  certificatesStillValid() {
    const order = this.state.entryReview === 'A' ? REPAIR_REVIEWS : REVIEWS;
    for (const review of order) {
      const certificate = review === 'B' ? this.state.prerequisiteCertificates?.B : this.state.certificates[review];
      if (order.indexOf(review) >= order.indexOf(this.state.review)) continue;
      if (!certificate) {
        if (this.boundTargets) throw Error(`Target binding: missing prior REVIEW ${review} approval; cannot infer a verification target`);
        this.event('prior_review_missing', {missingReview: review});
        this.invalidateFrom(review);
        this.state.review = review;
        this.state.nextAction = `Reverify missing REVIEW ${review} approval`;
        return false;
      }
      try { validateIdentities(this.root, certificate.inputs); validateIdentities(this.root, certificate.evidence); if(this.boundTargets)validateProductTarget(this.root,certificate.productTarget); }
      catch (error) {
        if (this.boundTargets) throw Error(`Target binding: prior REVIEW ${review} approval changed: ${error.message}`);
        this.event('prior_review_invalidated', {invalidatedReview: review, reason: error.message});
        this.invalidateFrom(review);
        this.state.review = review;
        this.state.nextAction = `Reverify changed REVIEW ${review} inputs`;
        return false;
      }
    }
    return true;
  }

  invalidateFrom(review) {
    if (review === 'A') delete this.state.certificates.A;
    if (review === 'A' || review === 'B') {
      delete this.state.prerequisiteCertificates?.B;
      this.state.resumeAfterPrerequisite = 'C';
    }
    for (const item of REVIEWS.slice(['A', 'B'].includes(review) ? 0 : REVIEWS.indexOf(review))) delete this.state.certificates[item];
    if (this.boundTargets) {
      const index=REPAIR_REVIEWS.indexOf(review);
      for (const later of REPAIR_REVIEWS.slice(index+1)) {
        const workspace=this.state.productWorkspaces?.[later];
        if(workspace){(this.state.retiredProductWorkspaces??=[]).push({...workspace,review:later,reason:`ancestor REVIEW ${review} invalidated`});delete this.state.productWorkspaces[later];}
      }
      const prior=REPAIR_REVIEWS.slice(0,index).reverse().map(item=>item==='B'?this.state.prerequisiteCertificates?.B:this.state.certificates[item]).find(Boolean);
      this.state.approvedProductTarget=prior?.productTarget??this.state.baselineCertificate.target;
      validateProductTarget(this.root,this.state.approvedProductTarget);
    }
  }

  async verify({review: assignedReview, assignment = ''} = {}) {
    if (!assignedReview) this.certificatesStillValid();
    const review = assignedReview ?? this.state.review;
    const combined = this.state.nextVerificationAssignment?.review === review ? this.state.nextVerificationAssignment.implementationTask : null;
    if (this.boundTargets && combined && !combined.target) throw Error('Target binding: implementation handoff lost its product target');
    const target = this.boundTargets ? combined?.target ?? this.state.currentProductTarget : null;
    if (this.boundTargets) validateProductTarget(this.root,target);
    if (this.boundTargets && target.review !== review) throw Error(`Target binding: REVIEW ${review} has no confirmed implementation target; preserve unfinished work before recovery`);
    const productRoot = target?.productRoot ?? this.productRoot;
    assignment ||= this.state.nextVerificationAssignment?.review === review ? this.state.nextVerificationAssignment.prompt : '';
    const previous = this.state.activeVerification;
    const taskId = combined?.taskId ?? null;
    const savedTurn = this.boundTargets && this.state.completedVerificationTurn?.review === review ? this.state.completedVerificationTurn : null;
    if (savedTurn && savedTurn.targetId !== target.targetId) throw Error('Target binding: saved verifier response belongs to another candidate');
    const continuing = Boolean(savedTurn) || this.config.verificationStages && previous?.review === review && previous.taskId === taskId;
    const last = this.state.lastCandidateVerification;
    if (this.boundTargets && !continuing && last?.review === review && last.revision === target.revision && last.nonPassKind === 'implementation') throw Error('Candidate unchanged after repair; preserve the existing verdict and fix the handoff before another verification');
    if (!continuing) this.state.round += 1;
    this.roundDirectory = path.join(this.directory, 'rounds', `${String(savedTurn?.round ?? (continuing ? previous.round : this.state.round)).padStart(4, '0')}-${review}`);
    const reportDirectory = path.join(this.roundDirectory, 'verification');
    fs.mkdirSync(reportDirectory, {recursive: true});
    let stageInstructions = '';
    if (this.config.verificationStages) {
      const job = continuing ? previous : {jobId: randomUUID(), review, round: this.state.round, reportDirectory: this.relative(reportDirectory), taskId, attempt: 0, startedAt: stamp()};
      if (!savedTurn) job.attempt += 1;
      const contextFile = path.join(reportDirectory, 'job-context.json');
      const context = {version: 1, jobId: job.jobId, review, taskId, root: this.root, reportDirectory: job.reportDirectory,
        requiredGates: combined ? [...GATES[review], ...TASK_GATES] : GATES[review], requestIdentity: combined?.requestIdentity ?? null,
        ...(target ? {productRoot,productTarget:target} : {})};
      if (fs.existsSync(contextFile)) {
        if (JSON.stringify(JSON.parse(fs.readFileSync(contextFile, 'utf8'))) !== JSON.stringify(context)) throw Error('Independent verification job identity changed');
      } else atomicJSON(contextFile, context);
      job.contextPath = this.relative(contextFile);
      if (job.contextIdentity) validateIdentities(this.root, [job.contextIdentity]);
      else job.contextIdentity = fileIdentity(this.root, contextFile);
      this.state.activeVerification = job;
      this.event(continuing ? 'verification_resumed' : 'verification_started', {jobId: job.jobId, attempt: job.attempt, reportDirectory: job.reportDirectory});
      stageInstructions = this.verificationStageInstructions(job);
    }
    this.state.phase = 'verify';
    this.state.activeReview = review;
    this.state.nextAction = `Independent REVIEW ${review} verification`;
    this.save();
    const before = this.controlSnapshot();
    if (!savedTurn) this.record(continuing ? `source-before-verification-resume-${this.state.activeVerification.attempt}` : 'source-before-verification', before);
    const savedResponse = savedTurn ? JSON.parse(fs.readFileSync(resolveInside(this.root,savedTurn.responsePath),'utf8')) : null;
    if (savedResponse) {
      validateIdentities(this.root,[savedResponse.requestIdentity]);
      if (!savedResponse.turnId || savedResponse.turnId !== savedTurn.turnId || savedResponse.schemaDigest !== digest(BOUND_VERIFICATION_SCHEMA)) throw Error('Target binding: invalid completed verifier receipt');
      this.event('completed_verification_recovered',{turnId:savedTurn.turnId,targetId:target.targetId});
    }
    const result = savedResponse?.result ?? await this.turn('verifier', 'verifier', [
      `총괄 지시: 현재 REVIEW ${review}를 독립적으로 검증한다. 실행 시작점은 ${this.state.entryReview ?? 'C'}다.`,
      `프로젝트: ${productRoot}`, `운영 저장소(제품 대상 대체 금지): ${this.root}`, `새 검증 증거 디렉터리: ${reportDirectory}`,
      target ? `고정 제품 targetId=${target.targetId}, candidateRoot=${productRoot}. 이 후보의 실제 source·config·import·생성 입력을 검사한다. 결과의 targetId/candidateRoot는 정확히 일치해야 한다. inputs에 반드시 이 manifest를 포함한다: ${JSON.stringify(target.manifest)}. root 원본이나 다른 후보로 fallback하지 않는다.` : '',
      `필수 check id: ${GATES[review].join(', ')}`,
      `대상 checkpoint: ${review === 'B' ? '15-3' : CHECKPOINTS[review].join(', ')}`,
      assignment,
      stageInstructions,
      combined ? `이번 검증은 전체 REVIEW와 원본 구현 프롬프트 수행을 함께 판정한다. taskId: ${combined.taskId}\n원본 구현 프롬프트:\n${fs.readFileSync(resolveInside(this.root, combined.requestIdentity.path), 'utf8')}\n반드시 inputs에 포함할 원본 프롬프트 identity: ${JSON.stringify(combined.requestIdentity)}\n추가 필수 check id: ${TASK_GATES.join(', ')}. 원본 지시 각각의 수행, 보존 조건, 새 실행 증거를 기록한다. 일부 완료/미실행이면 전체 PASS를 발급하지 않는다. 별도의 부분 태스크 검증을 먼저 반복하지 않는다.` : '',
      `최근 구현의 산출물 위치(통과 주장이 아닌 검증 대상 경로): ${JSON.stringify(this.state.latestImplementationArtifacts ?? [])}`,
      this.state.entryReview === 'A' ? '이번 새 실행의 구현 산출물을 검증한다. 롤백 전 후보는 과거 실패 원인 조사에만 참조하며 새 구현/승인으로 사용하지 않는다.' : '기존 reports/prompt15의 최신 구현 후보와 r7/r8 handoff를 조사하되 과거 성공 표시는 통과 근거가 아니다.',
      '구현 세션의 답변·사고 과정은 읽지 않는다. 기능 명세, 현재 코드와 actual artifact bytes로 판단한다.',
      '수정 없이 실제 검사를 실행한다. 증거 파일을 새 디렉터리에 기록하고 SHA256과 byteLength를 계산한다.',
      '프로젝트에서 명령을 실행해야 한다면 cwd를 명시하되 source/data/public/기존 report를 수정하지 않는다.',
      'PASS는 모든 필수 gate의 현재 실행 증거와 입력 hash가 있을 때만 가능하다. 누락/미실행은 blocked 또는 fail이다.',
      '실패하면 failures에 재현 명령·실제 원인·영향을 넣고 suggestedRepairPrompt에 구현자가 바로 실행할 구체적인 보완 프롬프트를 작성한다.',
      'nonPassKind는 pass이면 none, 구현 결함/미완료/필수 증거 누락으로 미통과면 implementation, 권한·외부 환경·검증 도구 실행 장애면 environment다. 구현 오류를 환경 장애로 분류하지 말고 실제 실패 근거를 failures에 기록한다.',
      'r7/r8 보완 시도 내부의 A~G gate를 Prompt 15의 REVIEW A~F와 혼동하지 않는다.',
      'C에서는 아직 구현하지 않은 15-5 이후 production 기능을 선행 조건으로 요구하지 않는다.',
      'B는 현재 generator·delivery의 변경 영향에 대한 15-3 선행 재검증이다. 물리 해상도·near 범위·sliver·비용·ID/provenance 정책과 대표 국가 실험을 실제 bytes로 검증한다. 아직 없는 전 세계 generation이나 production E2E를 B의 선행 조건으로 요구하지 않는다.',
      'B 통과 시 현재 통합 실행기가 요구하는 scope/countries/checks/dependency pin을 실제 검사 근거로 갖춘 새 review-b-certification.json을 이 verification 디렉터리에 생성하고 evidence에 포함한다. 검증하지 않은 hash나 scope만 채워 인증하지 않는다. 기존 인증 파일은 보존한다.',
      'F에서는 cutover 준비를 검증하고 게시를 실행하지 않는다. F 통과 이후에는 사용자 지시로 대기한다.',
      `이전에 총괄이 승인한 리뷰: ${JSON.stringify(Object.keys(this.state.certificates))}`,
      '최종 답변은 지정 JSON schema로 반환한다. evidencePaths와 command.evidencePath는 evidence 배열에 있어야 한다.',
    ].join('\n\n'), this.boundTargets ? BOUND_VERIFICATION_SCHEMA : VERIFICATION_SCHEMA, reportDirectory);
    const changes = changedPaths(before, this.controlSnapshot());
    this.record(savedTurn ? 'recovered-verification-source-changes' : continuing ? `verification-source-changes-resume-${this.state.activeVerification.attempt}` : 'verification-source-changes', {changes});
    if (changes.length) throw Error(`Source changed during independent verification; certification withheld: ${changes.slice(0, 8).join(', ')}`);
    const normalized = normalizeVerification(this.root, reportDirectory, result);
    validateVerification(this.root, reportDirectory, review, normalized, combined ? [...GATES[review], ...TASK_GATES] : GATES[review]);
    if (target) {
      attestProductTarget(this.root,target,normalized);
      normalized.failureAttemptKey = failureAttemptKey(normalized);
    }
    if (this.config.verificationStages && normalized.verdict === 'pass') {
      validateIdentities(this.root, [this.state.activeVerification.contextIdentity]);
      const contextFile = path.join(this.root, this.state.activeVerification.contextPath);
      const journal = this.config.compactVerification ? createVerificationStages(contextFile) : new VerificationStages(contextFile);
      await journal.validateComplete();
      const summaryPath = this.relative(journal.summaryFile);
      if (!normalized.evidence.some(item => item.path === summaryPath)) throw Error('Review PASS must attest the completed independent stage journal');
      validateIdentities(this.root, normalized.evidence);
    }
    if (combined) {
      validateIdentities(this.root, [combined.requestIdentity]);
      if (normalized.verdict === 'pass' && !normalized.inputs.some(item => item.path === combined.requestIdentity.path && item.sha256 === combined.requestIdentity.sha256 && item.byteLength === combined.requestIdentity.byteLength)) throw Error('Review PASS must attest the exact original implementation prompt');
      normalized.implementationTaskId = combined.taskId;
      normalized.taskId = combined.taskId;
      normalized.readyForReview = normalized.verdict === 'pass';
      normalized.fullReview = true;
      const reportPath = this.relative(path.join(this.roundDirectory, 'verification.json'));
      this.state.latestTaskVerification = reportPath;
      this.state.taskVerificationHistory ??= [];
      this.state.taskVerificationHistory.push({taskId:combined.taskId, review, verdict:normalized.verdict, readyForReview:normalized.readyForReview, path:reportPath, fullReview:true});
      this.state.latestVerifiedImplementationTask = {taskId:combined.taskId, review, readyForReview:normalized.readyForReview};
    }
    const task = this.state.latestVerifiedImplementationTask;
    if (!combined && task?.review === review && (this.reviewUnits || task.readyForReview)) normalized.implementationTaskId = task.taskId;
    this.record('verification', normalized);
    recordReviewResult(this.state, normalized, this.relative(path.join(this.roundDirectory, 'verification.json')));
    if (target) this.state.lastCandidateVerification = {review,revision:target.revision,verdict:normalized.verdict,nonPassKind:normalized.nonPassKind,verification:this.relative(path.join(this.roundDirectory,'verification.json'))};
    if (review === 'B') this.state.latestPrerequisiteVerification = this.relative(path.join(this.roundDirectory, 'verification.json'));
    else this.state.latestVerification = this.relative(path.join(this.roundDirectory, 'verification.json'));
    if (this.state.nextVerificationAssignment?.review === review) delete this.state.nextVerificationAssignment;
    if (this.state.activeVerification) {
      this.state.lastVerificationJob = {...this.state.activeVerification, completedAt: stamp(), verdict: normalized.verdict};
      delete this.state.activeVerification;
    }
    delete this.state.completedVerificationTurn;
    this.state.phase = 'supervise';
    this.state.nextAction = 'Supervisor reviews verifier evidence';
    this.save();
    return normalized;
  }

  verificationStageInstructions(job) {
    if (this.config.compactVerification) return [
      `운영 v10: 동일 전체 REVIEW 배정 안에서 빠른 회귀→필요 통합→최종 전체 검증 순서로 실행한다. jobId=${job.jobId}, context=${path.join(this.root, job.contextPath)}, attempt=${job.attempt}.`,
      '새 job은 scripts/prompt15-orchestrator/verification-stages-compact.mjs의 register|revise|run|remaining|check CLI를 사용한다. 기존 v9 plan이 있는 같은 job은 그 원본 journal로 남은 작업을 마무리하며 변환·재실행하지 않는다. 다음 후보부터 v2 plan을 사용한다.',
      'v2 plan은 {version:2,jobId,role:"verifier",requiredGates:[전체 id],inputSets:{common:{path,sha256,byteLength}},stages:[{id,phase:"regression|normal|audit|final",dependsOn:[],gates:[],inputSets:["common"],inputs:[추가 pin],command:[실행파일,wrapper,...args],results:[{path,assertions:[{key:"pass",equals:true}]}]}이다. 공통 manifest는 {version:1,inputs:[{path,sha256,byteLength}]}로 한 번만 저장한다. 실제 import/spawn·설정·원본·후보·dependency closure와 원본 구현 프롬프트를 모두 사전에 pin한다. plan/각 실행 record에 전체 목록을 반복 삽입하지 않는다.',
      'scripts/prompt15-orchestrator/run-node-checks.mjs <새 verification 하위 출력> <명시적인 .node-test.mjs 파일들>로 Node 내장 테스트를 실행한다. 결과는 result.json 한 개와 제한된 로그다. skip/todo/cancelled/실패/완료 summary 누락은 pass=false다. assertion에서 예상 case 수와 요구사항 대응을 검사한다. 제품 Vitest/필수 browser E2E는 해당 범위에서 유지한다.',
      '기존 도 전체 과다 점령·필수 witness 삭제/교체·역할 목록 축소·정상 hash로 재pin한 잘못된 cell binding ordinal/edge 좌우 승인 재현을 작은 결정적 fixture와 실제 소비 함수로 먼저 검사한다. 테스트의 기대값은 독립 승인 source에서 정하며 producer checks/자기 제출 root를 정답으로 쓰지 않는다. tiny fixture PASS를 전체 geometry/비용 PASS로 확대하지 않는다.',
      '오류 사례마다 24국 후보나 package 전체를 물리 복제하거나 전체 준비 CLI를 반복하지 않는다. 공통 baseline은 읽기 전용으로 공유하고 변경 파일만 새 scratch에 복사한다. scripts/prompt15-orchestrator/bounded-output.mjs의 copySmallFixture(source,destination,명시 파일 목록,maxBytes)를 사용한다(기본 8MiB 상한). hardlink 파일을 덮어써 baseline을 변조하지 않는다. 필요한 소형 실제 byte fixture로 진짜 소비/거부 의미를 확인한 뒤 CLI 연결 검사는 별도 수행한다.',
      'raw stdout/stderr는 runBoundedCommand 또는 compact journal로 각 stream 최대 256KiB만 보관한다. 전체 관측 byte 수·SHA256과 절단 여부를 기록한다. 모델 도구 출력에 전체 artifact/대형 JSON을 출력하지 않는다. 진행 파일에는 completed/total/현재 case만, 결과에는 pass/실패 원인/재현 및 evidence identity만 남긴다. 대형 geometry는 실제 필요 생성 결과로 한 번 저장하고 manifest에서 참조한다.',
      '명확한 구현 결함이 실제 재현되면 원본/후보의 불변성과 재현의 정당성을 확인해 해당 전체 REVIEW를 FAIL로 반환할 수 있다. 미실행 gate는 blocked 및 not-executed-due-to-confirmed-failure로 명시하고 PASS나 범위 축소로 처리하지 않는다. FAIL 확정 후 그 후보의 장시간 정상 전체 검증을 의무적으로 계속하지 않는다. PASS에는 모든 필수 gate와 현재 입력·사후 대조·complete journal이 필요하다.',
      '변경 영향이 없는 독립 단계는 원래 사전/사후 pin·코드·정책·scope·실행 결과를 검증한 경우에만 재사용한다. 최종 정상 전체 CLI/geometry/비용 검증은 회귀를 통과한 후보 revision에 대해 수행한다. 필수 재현성의 두 독립 생성 등 원문 요구는 그대로 수행하며 B에 없는 전 세계 생성/production E2E는 추가하지 않는다.',
      '기존 request/response/FAIL/수정 전 증거를 보존한다. 구현 코드를 고치거나 producer PASS를 승계하지 않는다. helper 오류는 검증 scratch에서 해결하고 실행 장애는 environment로 구별한다. 최종 check와 stages/progress.json attestation은 전체 PASS에 필수다. 모든 판정과 보완 지시는 총괄에게만 반환한다.',
    ].join('\n\n');
    return [
      `운영 v9: 전체 REVIEW를 한 번에 판정하되 실행은 단계별로 저장한다. jobId=${job.jobId}, context=${path.join(this.root, job.contextPath)}, attempt=${job.attempt}. 같은 총괄 배정·독립 검증 세션·증거 디렉터리를 유지한다.`,
      'scripts/prompt15-orchestrator/verification-stages.mjs의 VerificationStages API 또는 CLI를 사용한다. register <context> <plan>, revise <context> <plan>, run <context> <stage-id>, remaining <context>, check <context>를 지원한다. root cwd에서 node로 실행한다. 현재 단계 중복 실행/producer PASS 승계는 금지한다.',
      'plan은 {jobId,role:"verifier",requiredGates:[context의 모든 id],stages:[{id,phase:"regression|normal|audit|final",dependsOn:[],gates:[],command:[실행파일,검사wrapper,...args],inputs:[{path,sha256,byteLength}],results:[{path,assertions:[{key:"pass",equals:true}]}]} 형식이다. 실제 실행·동적 import/spawn/설정/정책/후보/원본 입력 closure를 실행 전에 고정하고 단계별 입력에 포함한다. negative wrapper는 실제 거부 코드·ready=false·의도한 거부 원인을 검증한 뒤 exit 0으로 검사 성공을 반환한다.',
      '기존 FAIL의 도 전체 점령·필수 witness 삭제/교체·역할/입력 목록 축소 재현을 regression 단계로 우선 실행한다. 해당 REVIEW에 없는 production E2E/전 세계 생성을 추가하지 않는다. 정상·geometry·비용·전체 오류 입력·최종 감사 등 원래 배정된 필수 조건을 plan에 빠짐없이 포함한다.',
      '중단 후 journal이 completed인 단계도 입력/검사 코드/의존 단계/출력 bytes를 실제 다시 대조해야 재사용된다. plan의 범위·후보가 바뀌면 이전 승인 효력을 전제하지 말고 변경 영향을 보고한다. 미완료 단계와 그 영향 범위를 확인하여 같은 전체 배정 안에서 이어 수행한다.',
      'helper 정정이나 입력 변경에는 revise를 사용한다. 원래 stage 목록·gate·의존 관계·assertion은 축소할 수 없다. 이전 plan과 실행 기록은 보존되며 변경된 단계와 의존 단계는 재검증한다. 이미 존재하는 출력은 덮어쓰지 말고 새 출력 경로를 plan에 지정한다.',
      'legacyEvidence 또는 journal 이전 증거가 있으면 독립 실행의 사전 pin·사후 pin·종료 코드·입력 소비·scope·출력 hash를 실제 검증하는 별도 단계로 재사용 적격성을 증명한다. producer 보고, 현재 hash만으로 과거 사전 pin을 보충하거나 미완료 명령을 완료로 승격하지 않는다. 이전 request/response/evidence는 덮어쓰지 않는다.',
      '검증 helper의 경로/입력 목록/연산 backend 오류는 현재 verification 안의 새 복사본에서 정정·재검사하고 원본 오류와 변경 이유를 보존한다. 보완 가능한 도구 오류를 구현 FAIL로 판정하거나 총괄에 작은 재배정을 요구하지 않는다. 해결 불가 실행 장애는 environment로 정확히 보고한다.',
      '모든 plan 단계의 현재 적격성과 최종 사후 입력 대조가 완료된 뒤에만 전체 PASS를 판단한다. check를 최종 수행하고 stages/progress.json을 evidence에 넣는다. 단계 완료는 전체 REVIEW 승인/다음 checkpoint 배정이 아니다. 최종 판정은 검증자가 총괄에게만 반환한다.',
    ].join('\n\n');
  }

  recoverVerification() {
    if (!this.resumePendingVerification) return null;
    this.resumePendingVerification = false;
    this.roundDirectory = path.join(this.directory, 'rounds', `${String(this.state.round).padStart(4, '0')}-${this.state.review}`);
    try {
      const response = JSON.parse(fs.readFileSync(path.join(this.roundDirectory, 'verifier-response.json'), 'utf8'));
      // Recover only an explicitly completed failure report. A cached PASS is reverified.
      if (!response.turnId || response.result.verdict !== 'fail') return null;
      const mutation = JSON.parse(fs.readFileSync(path.join(this.roundDirectory, 'verification-source-changes.json'), 'utf8'));
      if (mutation.changes.length) return null;
      const previous = JSON.parse(fs.readFileSync(path.join(this.roundDirectory, 'source-before-verification.json'), 'utf8'));
      const changed = changedPaths(previous, this.controlSnapshot());
      const substantive = changed.filter(name => !name.startsWith('scripts/prompt15-orchestrator/') && !name.startsWith('docs/automation/'));
      if (substantive.length) return null;
      const reportDirectory = path.join(this.roundDirectory, 'verification');
      const normalized = normalizeVerification(this.root, reportDirectory, response.result);
      validateVerification(this.root, reportDirectory, this.state.review, normalized);
      this.record('verification', normalized);
      recordReviewResult(this.state, normalized, this.relative(path.join(this.roundDirectory, 'verification.json')));
      this.record('recovered-verification', {completedTurnId: response.turnId, verdict: 'fail', operatorChanges: changed});
      this.state.latestVerification = this.relative(path.join(this.roundDirectory, 'verification.json'));
      this.state.phase = 'supervise';
      this.state.nextAction = 'Supervisor reviews the completed independent failure report';
      this.save();
      this.event('completed_failure_report_recovered', {turnId: response.turnId});
      return normalized;
    } catch (error) {
      this.event('failure_report_requires_reverification', {reason: error.message});
      return null;
    }
  }

  async supervise(verification) {
    const outcome = reviewBOutcome(this.root, this.directory, this.state, verification);
    if (outcome) {
      this.record('review-b-user-outcome', {...outcome, selectedAt: stamp()});
      this.state.reviewBUserOutcome = outcome;
      this.save();
    }
    const decision = await this.turn('supervisor', 'supervisor', [
      `현재 REVIEW ${this.state.review}의 독립 검증 결과를 판정하고 다음 작업을 배정한다.`,
      JSON.stringify(verification, null, 2),
      '모든 전달은 총괄을 거친다. 실패/blocked이면 suggestedRepairPrompt와 실제 실패 증거를 검토하여 구현 지시 repairPrompt를 작성한다.',
      'repairReview는 원인 checkpoint의 A/B/C/D/E/F다. A는 15-1/15-2, B는 15-3, C는 15-4다. 이전 단계 문제가 확인되면 해당 리뷰로 되돌아가 후속 승인을 무효화한다.',
      'A가 PASS이면 action=advance, repairReview=A를 유지하고 repairPrompt에 15-3 전체 구현 지시, repairCoverage에 REVIEW B 전체 gate를 작성한다. A 통과 전 B/C로 진행하지 않는다.',
      'B가 FAIL/blocked이면 repairReview=B로 15-3을 보완한다. B가 통과하기 전 C 보완이나 C 검증을 배정하지 않는다. B가 PASS이면 action=advance로 C 복귀를 배정하고 repairPrompt에 15-4의 후속 구현 지시를 작성한다.',
      '리뷰 기준/허용 오차/cap을 성공 결과에 맞춰 완화하지 않는다. 누락된 검사를 PASS로 바꾸지 않는다.',
      'C가 PASS이면 action=advance, branchPlans에 15-5와 15-6의 각각 구체적인 지시와 서로 겹치지 않는 writablePaths를 제공한다.',
      'shared contract 파일은 한 분기에만 배정하고 다른 분기는 그 계약을 따른다. 두 분기는 서로의 완료에 의존하지 않도록 합의한 계약을 instructions에 명시한다.',
      'writablePaths는 프로젝트 상대 경로의 정확한 파일/디렉터리다. src 전체나 scripts 전체를 양쪽에 배정하지 않는다.',
      'D/E가 PASS이면 action=advance. F가 PASS이면 action=wait. 다른 리뷰를 건너뛰거나 F 이후 cutover를 지시하지 않는다.',
      'blocked action은 사용자 결정/권한/환경이 없어서 보완할 수 없는 구체적인 경우에만 선택한다. 보완 가능한 검증 실패는 repair로 처리한다.',
      `누적 보완 횟수: ${this.state.repairAttempts}`,
      strategyInstruction(this.state, this.state.review),
      outcome?.instructions ?? '',
      this.reviewUnits ? reviewUnitInstructions(verification.verdict === 'pass' && ['A', 'B'].includes(this.state.review) ? this.state.review === 'A' ? 'B' : 'C' : this.state.review) : '',
      'repairCoverage는 보완 또는 A/B 통과 후 다음 리뷰 구현 지시의 모든 필수 gate id를 기록한다. 구현 지시가 없는 action에서는 빈 배열로 반환한다.',
      'blocked는 전체 종료가 아니라 외부 입력 대기다. 이때 blockerKind와 blockerEvidence에 필수 조건을 명시한다. 다른 action은 blockerKind=none, blockerEvidence=""로 반환한다.',
    ].join('\n\n'), SUPERVISION_SCHEMA);
    validateDecision(this.state.review, verification, decision);
    if (outcome && decision.action !== 'blocked') {
      if (outcome.verdict === 'fail' && (decision.action !== 'repair' || decision.repairReview !== 'B')) throw Error('User B failure transition requires cleanup and selective B repair');
      if (outcome.verdict === 'pass' && decision.action !== 'advance') throw Error('User B pass transition requires C with compact verification');
      decision.repairPrompt = `${outcome.instructions}\n\n총괄의 구체적인 수행 계획:\n${decision.repairPrompt}`;
    }
    this.record('decision', decision);
    this.state.latestDecision = this.relative(path.join(this.roundDirectory, 'decision.json'));
    recordStrategyChange(this.state, this.state.review, decision, this.state.latestDecision);
    this.save();
    return decision;
  }

  bindImplementationResult(result, key, responsePath) {
    const workspace = this.state.branchWorkspaces[key] ?? (this.boundTargets ? this.state.productWorkspaces[this.state.review] : null);
    if (this.boundTargets) {
      responsePath = resolveInside(this.root,responsePath);
      const responseIdentity = fileIdentity(this.root,responsePath);
      if (workspace.target?.responseIdentity?.sha256 === responseIdentity.sha256) {
        validateProductTarget(this.root,workspace.target);
        if (!key.startsWith('branch-')) this.state.currentProductTarget = workspace.target;
        return workspace;
      }
      if (path.resolve(result.candidateRoot ?? '') !== workspace.directory) throw Error('Target binding: recovered report names a different candidate');
      const after = workspaceSnapshot(workspace.directory);
      const protectedPrefixes = ['automation/','docs/automation/','scripts/prompt15-orchestrator/','tools/prompt15-','tools/discord-','prompts/'];
      for (const name of new Set([...Object.keys(workspace.baseline),...Object.keys(after)])) {
        if (workspace.baseline[name] !== after[name] && protectedPrefixes.some(prefix=>name.startsWith(prefix))) throw Error(`Target binding: product implementation changed operating policy ${name}`);
      }
      if (result.artifactPaths.length && !result.inputManifestPath) throw Error('Target binding: product artifacts need an explicit input manifest');
      const response = JSON.parse(fs.readFileSync(responsePath,'utf8'));
      if (response.productSourceDigest !== digest(productSnapshot(workspace.directory))) throw Error('Target binding: product changed after completed implementation report');
      const receiptDirectory = path.join(path.dirname(responsePath), `target-${key}`);
      const target = captureProductTarget(this.root,workspace.directory,receiptDirectory,{
        requestIdentity:fileIdentity(this.root,responsePath.replace(/-response\.json$/,'-request.txt')),
        responseIdentity:fileIdentity(this.root,responsePath),turnId:response.turnId,
        review:this.state.review,
        artifactManifest:result.inputManifestPath ? resolveInside(workspace.directory,result.inputManifestPath) : null,
      });
      workspace.target = target;
      if (!key.startsWith('branch-')) this.state.currentProductTarget = target;
      this.save();
    }
    return workspace;
  }

  async implement(prompt, key = 'implementer') {
    if (!key.startsWith('branch-')) await this.ensureImplementationSession();
    if (this.reviewUnits && !key.startsWith('branch-')) prompt += `\n\n현재 사용자 운영 지시(이전 부분 구현 제한보다 우선):\n${reviewUnitInstructions(this.state.review)}`;
    if (key.startsWith('branch-')) prompt += `\n\n분기 내부의 세부 작업 계획:\n${taskPlanInstructions('D',{checkpoint:key.slice('branch-'.length)})}`;
    const result = await this.turn('implementer', key, prompt, IMPLEMENTATION_SCHEMA);
    if (!['completed', 'blocked'].includes(result.status)) throw Error('Invalid implementation status');
    const workspace = this.bindImplementationResult(result,key,path.join(this.roundDirectory,`${key}-response.json`));
    if (workspace) {
      result.artifactPaths = result.artifactPaths.map(name => this.relative(resolveInside(workspace.directory, name)));
      this.record(`${key}-artifact-locations`, {artifactPaths: result.artifactPaths});
    }
    for (const name of result.changedFiles) resolveInside(workspace?.directory ?? this.productRoot, name);
    for (const name of result.artifactPaths) resolveInside(this.root, name);
    // Parallel results are independently checked before the integration assignment.
    if (key.startsWith('branch-')) return result;
    return this.resolveImplementationHandoff(result);
  }

  async relayReviewImplementation(result) {
    const responsePath = this.state.pendingImplementation?.responsePath;
    const responseFile = resolveInside(this.root, responsePath);
    const response = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
    if (!response.turnId) throw Error('Whole-review verification requires a confirmed implementation turn');
    if (this.boundTargets) this.bindImplementationResult(response.result,'implementer',responseFile);
    const requestFile = responseFile.replace(/-response\.json$/, '-request.txt');
    if (!fs.existsSync(requestFile)) throw Error('Whole-review implementation request is missing');
    const taskId = this.relative(responseFile);
    const number = (this.state.taskAssessments ?? 0) + 1;
    this.state.taskAssessments = number;
    this.state.phase = 'implementation_relay';
    this.state.nextAction = 'Supervisor forwards the complete review implementation to one independent review';
    this.save();
    const requestIdentity = fileIdentity(this.root, requestFile);
    const relay = await this.turn('supervisor', `review-relay-${number}`, [
      `총괄 전달: 현재 REVIEW ${this.state.review}의 전체 보완 구현을 독립 검증으로 전달한다.\ntaskId: ${taskId}`,
      `구현 프롬프트 원문:\n${fs.readFileSync(requestFile, 'utf8')}`,
      `구현 보고(판정 근거가 아닌 검증 대상):\n${JSON.stringify(result, null, 2)}`,
      this.boundTargets ? `고정 후보 전달: ${JSON.stringify(this.state.currentProductTarget)}\n검증 대상은 이 productRoot이며 원본 저장소로 대체하지 않는다. completed/blocked 모두 동일 원본 배정과 후보를 전달한다.` : '',
      '이번 턴은 전달 전용이다. 구현 성공/실패를 판정하거나 다음 작은 구현을 배정하지 않는다. verificationPrompt에 해당 REVIEW의 모든 필수 gate와 원본 지시 전체 수행·보존·실행 증거의 통합 검증을 배정한다.',
      `필수 REVIEW gate: ${GATES[this.state.review].join(', ')}. 추가 수행 gate: ${TASK_GATES.join(', ')}. blocked 보고도 같은 전체 범위에서 실제 미완료/제약을 확인한다.`,
    ].join('\n\n'), TASK_RELAY_SCHEMA);
    if (relay.review !== this.state.review || relay.taskId !== taskId || !relay.verificationPrompt.trim()) throw Error('Supervisor must relay the exact whole-review implementation');
    this.state.nextVerificationAssignment = {review:this.state.review, prompt:relay.verificationPrompt, implementationTask:{taskId,requestIdentity,...(this.boundTargets ? {target:this.state.currentProductTarget} : {})}};
    delete this.state.pendingImplementation;
    delete this.state.activeReview;
    this.state.phase = 'verify';
    this.save();
    this.event('whole_review_implementation_relayed', {taskId, requiredGates:[...GATES[this.state.review], ...TASK_GATES]});
    return {...result, disposition:'independent_whole_review_assigned'};
  }

  async assessImplementation(result, {key = 'implementer', responsePath, workingRoot = this.productRoot} = {}) {
    responsePath ??= this.state.pendingImplementation?.responsePath ?? this.relative(path.join(this.roundDirectory, `${key}-response.json`));
    const responseFile = resolveInside(this.root, responsePath);
    const response = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
    if (!response.turnId) throw Error('Task verification requires a confirmed implementation turn');
    const requestFile = responseFile.replace(/-response\.json$/, '-request.txt');
    const hasRequest = requestFile !== responseFile && fs.existsSync(requestFile);
    const request = hasRequest ? fs.readFileSync(requestFile, 'utf8') : 'Original implementation request is missing; prompt completion cannot be certified.';
    const requestIdentity = hasRequest ? fileIdentity(this.root, requestFile) : null;
    const taskId = this.relative(responseFile);
    const target = this.boundTargets ? this.state.branchWorkspaces[key]?.target ?? this.state.currentProductTarget : null;
    if (target) {
      validateProductTarget(this.root,target);
      if (target.productRoot !== workingRoot) throw Error('Target binding: task verifier root mismatch');
    }
    const number = (this.state.taskAssessments ?? 0) + 1;
    this.state.taskAssessments = number;
    const taskDirectory = path.join(this.roundDirectory, 'tasks', `${String(number).padStart(4, '0')}-${key}`);
    const reportDirectory = path.join(taskDirectory, 'verification');
    fs.mkdirSync(reportDirectory, {recursive: true});
    this.state.phase = 'implementation_relay';
    this.state.nextAction = 'Supervisor forwards the whole implementation prompt to independent verification';
    this.save();
    const assignment = await this.turn('supervisor', `task-relay-${number}`, [
      `구현 프롬프트의 수행 결과를 검증자에게 전달한다. 현재 REVIEW ${this.state.review}.`,
      `taskId: ${taskId}`, `실제 구현 작업 경로: ${workingRoot}`,
      `구현 프롬프트 원문:\n${request}`,
      `구현 보고(독립 판정이 아님):\n${JSON.stringify(result, null, 2)}`,
      '이번 턴에서는 검증 지시 verificationPrompt만 작성한다. 구현 성공/실패를 판정하거나 추가 구현을 배정하지 않는다.',
      '동작 한 번은 이 프롬프트의 지시사항 전체 수행이다. 개별 명령/실험마다 넘기거나 지시사항을 일부 생략하도록 바꾸지 않는다.',
      '원문의 모든 지시사항과 변경에 따른 보존 조건을 검증하도록 전달한다. 미완료/막힘 보고도 실제 bytes로 독립 확인한다.',
      '작은 보완 프롬프트는 해당 전체 지시 범위를 검증한다. 아직 배정하지 않은 전체 국가 생성이나 장시간 회귀를 임의로 추가하지 않는다.',
      '태스크 PASS는 REVIEW PASS가 아니다. 후속 checkpoint, 검증 기준 완화, 게시를 배정하지 않는다.',
    ].join('\n\n'), TASK_RELAY_SCHEMA);
    if (assignment.review !== this.state.review || assignment.taskId !== taskId || !assignment.verificationPrompt.trim()) throw Error('Supervisor must relay this exact implementation task to verification');
    const before = sourceSnapshot(workingRoot);
    atomicJSON(path.join(taskDirectory, 'source-before.json'), before);
    this.state.phase = 'task_verify';
    this.state.activeReview = this.state.review;
    this.state.nextAction = 'Verifier judges all instructions in the completed implementation prompt';
    this.save();
    const assessment = await this.turn('verifier', `task-verifier-${number}`, [
      `총괄 지시: 현재 REVIEW ${this.state.review}의 구현 프롬프트 전체 수행 결과를 독립 검증한다.`,
      `taskId: ${taskId}`, `구현 작업 경로: ${workingRoot}`, `새 증거 디렉터리: ${reportDirectory}`,
      `원본 구현 프롬프트 존재: ${hasRequest}`, `구현 프롬프트 원문:\n${request}`,
      requestIdentity ? `반드시 inputs에 포함할 원본 프롬프트 identity: ${JSON.stringify(requestIdentity)}` : '',
      assignment.verificationPrompt,
      `검증 대상 위치와 실행 기록:\n${JSON.stringify({changedFiles: result.changedFiles, artifactPaths: result.artifactPaths, commands: result.commands, remainingIssues: result.remainingIssues}, null, 2)}`,
      `필수 check id: ${TASK_GATES.join(', ')}`,
      target ? `고정 후보: ${JSON.stringify(target)}. 결과 targetId와 candidateRoot를 이 값에 연결하고 inputs에 manifest identity를 포함한다. 다른 제품 root를 검사하지 않는다.` : '',
      '구현자의 완료/실패 주장이나 총괄의 추측을 판정 근거로 삼지 않는다. 현재 코드·입력·실제 bytes와 새 재현 실행으로 판단한다.',
      'prompt_instructions에 원본 지시사항 각각의 수행 여부를 기록한다. 일부 지시만 수행하거나 필수 실행을 생략했다면 PASS가 아니다.',
      'scope_preservation에는 변경 범위, 원점/identity/geometry 등 해당 변경의 불변식과 금지 우회를 검사한다.',
      'execution_evidence에는 새 검사 명령·종료 코드·결과 bytes의 hash와 byteLength를 기록한다. 원본 프롬프트가 없으면 blocked다.',
      '전체 프롬프트의 지시사항을 만족하면 태스크 pass, 실제 오류는 fail, 필요한 증거/입력이 없으면 blocked다. 판정은 검증자만 한다.',
      'nonPassKind는 pass이면 none, 구현 결함/미완료/필수 산출물 누락으로 미통과면 implementation, 권한·외부 환경·검증 도구 실행 장애면 environment다. 판정 확정 후 implementation 미통과는 1스트라이크가 기록된다. 환경 장애를 핑계로 구현 결함을 제외하지 않는다.',
      'readyForReview는 태스크 pass이고 해당 REVIEW 전체 필수 검증을 실행할 준비까지 된 경우에만 true다. 제한 실험/부분 산출물은 pass여도 false다.',
      '이 결과로 REVIEW 인증을 발급하거나 후속 checkpoint를 시작하지 않는다. REVIEW 전체 PASS에는 별도의 전체 독립 검증이 필요하다.',
      '배정 범위 밖의 전체 생성·장시간 검사·source/data/public/과거 보고서 수정을 하지 않는다. 증거는 지정 새 디렉터리와 검증 scratch에만 기록한다.',
      'fail/blocked이면 실제 원인과 재현을 failures에 적고 구체적인 다음 보완안을 suggestedRepairPrompt에 작성해 총괄에게 반환한다.',
    ].join('\n\n'), this.boundTargets ? BOUND_TASK_VERIFICATION_SCHEMA : TASK_VERIFICATION_SCHEMA, reportDirectory);
    const changes = changedPaths(before, sourceSnapshot(workingRoot));
    atomicJSON(path.join(taskDirectory, 'source-changes.json'), {changes});
    if (changes.length) throw Error(`Source changed during task verification: ${changes.slice(0, 8).join(', ')}`);
    const normalized = normalizeVerification(this.root, reportDirectory, assessment);
    validateTaskVerification(this.root, reportDirectory, this.state.review, taskId, normalized);
    if (target) { attestProductTarget(this.root,target,normalized); normalized.failureAttemptKey = failureAttemptKey(normalized); }
    if (requestIdentity) {
      validateIdentities(this.root, [requestIdentity]);
      if (normalized.verdict === 'pass' && !normalized.inputs.some(item => item.path === requestIdentity.path && item.sha256 === requestIdentity.sha256 && item.byteLength === requestIdentity.byteLength)) throw Error('Task PASS must attest the exact original implementation prompt');
    }
    if (!hasRequest && normalized.verdict === 'pass') throw Error('Missing implementation prompt cannot receive task PASS');
    const reportPath = this.relative(path.join(taskDirectory, 'verification.json'));
    atomicJSON(resolveInside(this.root, reportPath), normalized);
    this.state.latestTaskVerification = reportPath;
    this.state.taskVerificationHistory ??= [];
    this.state.taskVerificationHistory.push({taskId, review: this.state.review, verdict: normalized.verdict, readyForReview: normalized.readyForReview, path: reportPath});
    // Count the confirmed verifier verdict now, before any supervisor assignment.
    recordTaskResult(this.state, normalized, reportPath);
    this.state.latestVerifiedImplementationTask = {taskId, review: this.state.review, readyForReview: normalized.readyForReview};
    this.state.phase = 'implementation_handoff';
    this.save();
    this.event('implementation_task_verified', {taskId, verdict: normalized.verdict, readyForReview: normalized.readyForReview, reportPath});
    return normalized;
  }

  async resolveImplementationHandoff(result) {
    let prerequisite = this.state.review === 'B' && this.state.latestPrerequisiteVerification
      ? JSON.parse(fs.readFileSync(resolveInside(this.root, this.state.latestPrerequisiteVerification), 'utf8')) : null;
    while (['completed', 'blocked'].includes(result.status)) {
      this.ensureRunning();
      const control = ['user-instruction', 'orchestration-control', 'runtime-recovery'].includes(result.origin);
      if (!control && this.state.pendingImplementation?.unit === 'review') return this.relayReviewImplementation(result);
      const assessment = control ? null : this.recoveredTaskAssessment ?? await this.assessImplementation(result);
      delete this.recoveredTaskAssessment;
      this.state.phase = 'implementation_handoff';
      this.state.activeReview = this.state.review;
      this.state.nextAction = 'Supervisor handles implementation report and assigns repair or prerequisite verification';
      this.save();
      const number = (this.state.implementationHandoffs ?? 0) + 1;
      this.state.implementationHandoffs = number;
      const decision = await this.turn('supervisor', `supervisor-handoff-${number}`, [
        result.origin === 'user-instruction'
          ? `사용자가 기존 총괄 세션에 REVIEW ${this.state.review}의 분석 결과와 우선순위 변경을 전달하도록 명령했다. 아래 userInstruction을 반영해 기존 B 구현 세션에 새 보완 지시를 작성한다. 미완료 작업과 완료된 보고는 구별하며 원문과 검증 기준은 유지한다.`
          : result.origin === 'runtime-recovery'
          ? `운영 전환 기록: REVIEW ${this.state.review} 구현이 시간 제한/실행 도구 장애로 미완료 상태에서 중단됐다. 구현 세션의 완료 보고가 아니다. 원본 프롬프트와 현재 산출물을 확인하여 기존 구현 세션에 같은 전체 범위의 남은 작업 이어가기를 repair로 배정한다. 중단 자체를 검증 실패로 취급하거나 미완료 구현을 검증으로 전달하지 않는다.`
          : result.origin === 'orchestration-control'
          ? `운영 전환 기록: REVIEW ${this.state.review} 배정 오류로 중단된 미완료 작업을 총괄에게 전달한다. 구현 세션의 완료 보고가 아니다. 현재 bytes와 중간 산출물을 확인하여 15-3의 새 구현 세션에 보완을 배정한다.`
          : `구현 세션이 REVIEW ${this.state.review} 보완 도중 결과를 총괄에게 반환했다. 이것은 사용자 승인 요청이나 전체 종료 명령이 아니다.`,
        JSON.stringify(result, null, 2),
        assessment ? `이번 구현 프롬프트에 대한 검증자의 독립 판정:\n${JSON.stringify(assessment, null, 2)}` : '',
        prerequisite ? `총괄이 배정한 독립 REVIEW B 결과:\n${JSON.stringify(prerequisite, null, 2)}` : '',
        '구현 완료/실패 판정은 검증자만 한다. 이번 독립 태스크 검증 판정과 실제 증거를 확인한 뒤 다음 작업을 배정한다. 과거 보고가 현재 상태를 보증하지 않는다.',
        '태스크 pass여도 readyForReview=false면 다음 필요한 프롬프트를 repair로 배정한다. 태스크 fail/blocked는 검증 suggestedRepairPrompt를 반영한 repair 또는 근거 있는 외부 입력 대기다.',
        'action=reverify는 이번 태스크가 pass이고 readyForReview=true일 때만 선택한다. 이 action 자체는 REVIEW PASS나 단계 진행이 아니다.',
        'action=repair: 권한 범위 내의 구현 보완을 구체적으로 지시한다. REVIEW B 준비가 덜 됐다면 먼저 현재 generic generator/runner/검사 코드를 연결하도록 지시하고, 완료 후 독립 B 검증을 거친다.',
        'B의 실패 보완은 반드시 repairReview=B, checkpoint=15-3으로 배정한다. B 통과 전 repairReview=C로 넘기지 않는다. C 세션은 보관하며 B 구현에는 별도 세션을 사용한다.',
        'action=verify_b: verificationPrompt에 15-3의 독립 REVIEW B 검증 대상·실제 후보/정책/generator 경로·필요 scope와 dependency pin을 명시한다. 기존 인증의 PASS/hash를 편집하지 않는다.',
        'action=reverify: 현재 해당 B/C/D/E/F 리뷰의 독립 검증으로 돌아간다. 구현 완료 또는 통과를 주장하는 의미가 아니다.',
        'action=blocked는 기존 사용자 지시만으로 해결할 수 없는 사용자 결정·권한·외부 입력이 필수인 경우뿐이다. blockerKind와 blockerEvidence에 정확한 요구사항과 근거를 쓴다. 내부 REVIEW 재검증이나 총괄 배정 대기는 외부 blocker가 아니다.',
        '현재 사용자는 C 보완 반복과 그에 필요한 선행 checkpoint 재검증을 이미 요청했다. 새 승인 흐름을 임의로 추가하지 않는다. 기존 수치/보존/범위 hard gate를 완화하지 않는다.',
        'C 통과 전 15-5/15-6 진입 금지. F 이후 게시와 다음 작업 시작 금지. 모든 지시는 총괄을 거친다.',
        strategyInstruction(this.state, this.state.review),
        this.reviewUnits ? reviewUnitInstructions(this.state.review) : '',
      ].join('\n\n'), IMPLEMENTATION_HANDOFF_SCHEMA);
      validateImplementationHandoff(this.state.review, decision);
      if (this.reviewUnits && decision.action === 'repair') requireReviewCoverage(decision.repairReview, decision);
      if (assessment && decision.action === 'reverify' && !assessment.readyForReview) throw Error('Full review requires the verifier to confirm task completion and readiness');
      if (assessment && decision.action === 'verify_b' && this.state.review === 'B' && !assessment.readyForReview) throw Error('Full B review requires independently confirmed readiness');
      this.state.latestImplementationHandoff = this.record(`implementation-handoff-${number}`, decision);
      recordStrategyChange(this.state, this.state.review, decision, this.state.latestImplementationHandoff);
      if (result.origin === 'user-instruction') {
        this.state.latestSupervisorInstruction = {id: result.instructionId, status: 'supervisor_decided',
          requestPath: result.instructionPath, receiptPath: `${result.instructionPath}.receipt.json`,
          supervisorThreadId: this.state.threads.supervisor, decisionPath: this.state.latestImplementationHandoff, updatedAt: stamp()};
        atomicJSON(resolveInside(this.root, this.state.latestSupervisorInstruction.receiptPath), this.state.latestSupervisorInstruction);
      }
      if (decision.action !== 'blocked') delete this.state.pendingCheckpointCorrection;
      this.save();
      if (decision.action === 'blocked') {
        this.waitForInput(decision);
      }
      delete this.state.requiredUserInput;
      if (decision.action === 'reverify') {
        delete this.state.pendingImplementation;
        delete this.state.activeReview;
        this.state.phase = 'verify';
        this.save();
        return {...result, disposition: 'independent_reverification_assigned'};
      }
      if (decision.action === 'verify_b') {
        this.invalidateFrom('B');
        this.state.review = 'B';
        this.state.nextVerificationAssignment = {review: 'B', prompt: decision.verificationPrompt};
        delete this.state.pendingImplementation;
        delete this.state.activeReview;
        this.state.phase = 'verify';
        this.save();
        return {...result, disposition: 'prerequisite_reverification_assigned'};
      }
      this.state.repairAttempts += 1;
      this.invalidateFrom(decision.repairReview);
      this.state.review = decision.repairReview;
      this.state.phase = 'implement';
      this.state.nextAction = `Repair REVIEW ${this.state.review} (${CHECKPOINTS[this.state.review].join(', ')}), then independently reverify`;
      delete this.state.activeReview;
      this.save();
      const key = `implementer-handoff-${number}`;
      await this.ensureImplementationSession();
      result = await this.turn('implementer', key, [
        `총괄이 구현 보고를 검토한 후 전달하는 REVIEW ${this.state.review} 보완 지시:`, decision.repairPrompt,
        `새 산출물 디렉터리: ${path.join(this.roundDirectory, key)}`,
        '기존 보고서·승인 배포·입력·hard gate를 보존한다. 운영 도구는 수정하지 않는다. 선행 리뷰 인증을 직접 선언하지 않는다.',
        '구현 완료 또는 진행 제약을 총괄에게 보고한다. 후속 checkpoint나 cutover를 스스로 실행하지 않는다.',
        this.reviewUnits ? `현재 사용자 운영 지시(이전 부분 구현 제한보다 우선):\n${reviewUnitInstructions(this.state.review)}` : '',
      ].join('\n\n'), IMPLEMENTATION_SCHEMA);
      if (!['completed', 'blocked'].includes(result.status)) throw Error('Invalid implementation status');
      for (const name of [...result.changedFiles, ...result.artifactPaths]) resolveInside(this.root, name);
      this.state.pendingImplementation = {responsePath: this.relative(path.join(this.roundDirectory, `${key}-response.json`)), review: this.state.review, unit:this.reviewUnits ? 'review' : 'checkpoint'};
      prerequisite = null;
      this.save();
    }
    delete this.state.pendingImplementation;
    delete this.state.activeReview;
    this.state.phase = 'verify';
    this.save();
    return result;
  }

  async recoverImplementationHandoff() {
    if (!this.resumePendingImplementation) return;
    this.resumePendingImplementation = false;
    const previousDirectory = path.join(this.directory, 'rounds', `${String(this.state.round).padStart(4, '0')}-${this.state.review}`);
    const responsePath = this.state.pendingImplementation?.responsePath ?? this.relative(path.join(previousDirectory, 'implementer-response.json'));
    const response = JSON.parse(fs.readFileSync(resolveInside(this.root, responsePath), 'utf8'));
    if (response.turnId) this.state.latestImplementationArtifacts = response.result.artifactPaths;
    if (!response.turnId || !['completed', 'blocked'].includes(response.result.status)) { delete this.state.pendingImplementation; this.save(); return; }
    this.state.round += 1;
    this.roundDirectory = path.join(this.directory, 'rounds', `${String(this.state.round).padStart(4, '0')}-${this.state.review}-handoff`);
    fs.mkdirSync(this.roundDirectory, {recursive: true});
    this.state.pendingImplementation = {responsePath, review: this.state.review, unit:response.implementationUnit ?? 'checkpoint'};
    this.record('recovered-implementation-report', {responsePath, completedTurnId: response.turnId});
    this.recoveredTaskAssessment = this.recoverTaskFailure(responsePath);
    this.save();
    this.event('implementation_report_forwarded_to_supervisor', {responsePath});
    await this.resolveImplementationHandoff(response.result);
  }

  async recoverInterruptedImplementation() {
    if (!this.resumeInterruptedImplementation) return;
    this.resumeInterruptedImplementation = false;
    const interrupted = this.state.interruptedImplementation ?? this.state.activeImplementation;
    if (!interrupted || this.state.pendingImplementation) return;
    const requestFile = resolveInside(this.root, interrupted.requestIdentity.path);
    const relative = path.relative(path.join(this.directory, 'rounds'), requestFile);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw Error('Interrupted implementation request escapes this run');
    validateIdentities(this.root, [interrupted.requestIdentity]);
    if (!GATES[interrupted.review]) throw Error('Interrupted implementation review is invalid');
    this.state.review = interrupted.review;
    this.state.round += 1;
    this.roundDirectory = path.join(this.directory, 'rounds', `${String(this.state.round).padStart(4, '0')}-${this.state.review}-handoff`);
    fs.mkdirSync(this.roundDirectory, {recursive:true});
    this.record('incomplete-implementation-recovery', {...interrupted, completedTurn:false, taskStatus:'incomplete'});
    this.resumePendingImplementation = false;
    this.save();
    this.event('implementation_continuation_requested', {key:interrupted.key, threadId:interrupted.threadId, requestPath:interrupted.requestIdentity.path});
    await this.resolveImplementationHandoff({origin:'runtime-recovery', status:'blocked',
      summary:'실행 도구가 구현 완료 응답을 받기 전에 중단됐다. 기존 세션·원본 지시·코드·중간 산출물을 보존하고 미완료 작업부터 이어 배정한다. 중단 자체는 구현/검증 판정이 아니다.',
      originalImplementationPrompt:fs.readFileSync(requestFile,'utf8'), interruptedImplementation:interrupted,
      changedFiles:[], artifactPaths:[interrupted.requestIdentity.path, interrupted.reportDirectory], commands:[],
      remainingIssues:['원래 전체 구현 범위와 고정 기준을 유지하고 실제 완료한 실행을 확인한 뒤 남은 작업부터 이어 수행한다.', '구현 완료 또는 실제 제약 보고가 저장된 뒤에만 총괄 전달 및 독립 검증으로 이동한다.']});
  }

  recoverTaskFailure(taskId) {
    if(this.boundTargets)return null; // Bound verdicts require their exact target receipt.
    const reportPath = this.state.latestTaskVerification;
    if (!reportPath) return null;
    try {
      const file = resolveInside(this.root, reportPath);
      const result = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (result.taskId !== taskId || result.review !== this.state.review || result.verdict !== 'fail') return null;
      const directory = path.dirname(file);
      if (JSON.parse(fs.readFileSync(path.join(directory, 'source-changes.json'), 'utf8')).changes.length) return null;
      const before = JSON.parse(fs.readFileSync(path.join(directory, 'source-before.json'), 'utf8'));
      const changes = changedPaths(before, sourceSnapshot(this.root));
      if (changes.some(name => !['scripts/prompt15-orchestrator/', 'automation/prompt15/', 'docs/automation/'].some(prefix => name.startsWith(prefix)))) return null;
      const normalized = normalizeVerification(this.root, path.join(directory, 'verification'), result);
      validateTaskVerification(this.root, path.join(directory, 'verification'), this.state.review, taskId, normalized);
      recordTaskResult(this.state, normalized, reportPath);
      this.record('recovered-task-failure', {taskId, reportPath, operatorChanges: changes});
      this.event('confirmed_task_failure_forwarded_to_supervisor', {taskId, reportPath});
      return normalized;
    } catch {
      // Changed inputs, proof bytes, or functional code require fresh verification.
      return null;
    }
  }

  async recoverCheckpointCorrection() {
    const correction = this.state.pendingCheckpointCorrection;
    if (!correction) return;
    if (!['orchestration-control', 'user-instruction'].includes(correction.origin) || correction.review !== 'B' || correction.checkpoint !== '15-3') throw Error('Invalid checkpoint correction record');
    for (const name of [correction.reportDirectory, correction.supervisorDecision, correction.prerequisiteVerification]) resolveInside(this.root, name);
    let instruction;
    if (correction.origin === 'user-instruction') {
      const file = resolveInside(this.root, correction.instructionPath);
      const local = path.relative(path.join(this.directory, 'control'), file);
      if (path.isAbsolute(local) || local === '..' || local.startsWith(`..${path.sep}`)) throw Error('User instruction is outside this run control directory');
      instruction = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (instruction.origin !== 'user-instruction' || instruction.review !== 'B' || instruction.targetSupervisorThreadId !== this.state.threads.supervisor || !/^[a-z0-9_-]{1,80}$/.test(instruction.id) || !instruction.message?.trim()) throw Error('Invalid user supervisor instruction');
      for (const name of instruction.evidencePaths ?? []) resolveInside(this.root, name);
      if (correction.completedResponsePath) {
        const response = JSON.parse(fs.readFileSync(resolveInside(this.root, correction.completedResponsePath), 'utf8'));
        if (!response.turnId || !['completed', 'blocked'].includes(response.result?.status)) throw Error('Saved implementation report is not a confirmed completed turn');
      }
      delete this.state.pendingImplementation;
      this.resumePendingImplementation = false;
    }
    this.invalidateFrom('B');
    this.state.review = 'B';
    this.state.round += 1;
    this.roundDirectory = path.join(this.directory, 'rounds', `${String(this.state.round).padStart(4, '0')}-B-handoff`);
    fs.mkdirSync(this.roundDirectory, {recursive: true});
    this.record(instruction ? 'supervisor-instruction' : 'checkpoint-correction', {...correction, taskStatus: correction.completedResponsePath ? 'completed-report-saved' : 'incomplete', completedTurn: Boolean(correction.completedResponsePath)});
    this.save();
    if (instruction) {
      await this.resolveImplementationHandoff({origin: 'user-instruction', instructionId: instruction.id, instructionPath: correction.instructionPath,
        userInstruction: instruction.message, status: 'blocked',
        summary: '사용자가 독립 운영 분석을 총괄에게 전달하고 그 우선순위에 따라 구현을 지시하도록 요청했다. 현재 B 세션과 기존 source·산출물은 보존한다. 제어를 위해 종료된 턴은 검증 실패로 집계하지 않는다.',
        changedFiles: [], artifactPaths: [correction.reportDirectory, correction.supervisorDecision, correction.prerequisiteVerification, ...(instruction.evidencePaths ?? []), ...(correction.completedResponsePath ? [correction.completedResponsePath] : [])],
        commands: [], remainingIssues: ['최신 사용자 지시를 이전의 부분 재현·측정 후 조기 반환 규칙보다 우선하여 구현 완료 단위와 전체 검증 범위를 배정한다.']});
      return;
    }
    await this.resolveImplementationHandoff({origin: 'orchestration-control', status: 'blocked',
      summary: 'B 실패 보완이 C 세션으로 잘못 배정되어 운영 전환을 실행했다. 기존 대화와 source 및 중간 산출물은 보존했다. 중단된 작업을 완료 또는 검증 통과로 취급하지 않는다.',
      changedFiles: [], artifactPaths: [correction.reportDirectory, correction.supervisorDecision, correction.prerequisiteVerification], commands: [],
      remainingIssues: ['현재 source와 중간 r12 후보를 실제 검사하여 완료·미완료 범위를 확인한다.', '고정된 B 기준을 보존하고 15-3 새 세션에 상세 보완을 배정한다. C는 B 통과까지 대기한다.']});
  }

  async repair(decision) {
    if (this.reviewUnits) requireReviewCoverage(decision.repairReview, decision);
    this.state.repairAttempts += 1;
    this.invalidateFrom(decision.repairReview);
    this.state.review = decision.repairReview;
    this.state.phase = 'implement';
    this.state.nextAction = this.state.reviewBUserOutcome?.verdict === 'fail' && decision.repairReview === 'B'
      ? 'Preserve compact failure evidence, prune duplicate fixtures, and selectively rebuild REVIEW B'
      : `Repair REVIEW ${this.state.review}, then independently reverify`;
    this.save();
    await this.implement([
      `총괄이 전달하는 REVIEW ${this.state.review} 보완 프롬프트:`, decision.repairPrompt,
      `새 결과 디렉터리: ${path.join(this.roundDirectory, 'implementation')}`,
      '이번 보완만 수행하고 총괄에게 결과를 반환한다. 자신이 REVIEW 통과를 판정하거나 검증 세션을 직접 시작하지 않는다.',
      '기존 dirty 변경/고정 source/승인 배포/과거 증거를 보존한다. 기존 후보 실패를 은폐하지 않는다.',
      '운영 도구 scripts/prompt15-orchestrator, automation/prompt15 및 docs/automation은 수정하지 않는다.',
      '이 단계에서 후속 checkpoint를 실행하거나 production cutover하지 않는다.',
    ].join('\n\n'));
    this.state.phase = 'verify';
    this.save();
  }

  async parallel(decision) {
    const plans = validateBranchPlans(this.root, decision.branchPlans);
    this.state.review = 'D';
    if (this.boundTargets) this.ensureProductWorkspace();
    this.state.phase = 'parallel_implementation';
    this.state.nextAction = 'Implement 15-5 and 15-6 concurrently, then integrate through supervisor';
    this.save();
    for (const plan of plans) {
      const key = `branch-${plan.checkpoint}`;
      const workspace = prepareWorkspace(this.productRoot, path.join(this.roundDirectory, 'workspaces', plan.checkpoint), plan, {controlRoot:this.root,sourceOnly:this.boundTargets});
      this.state.branchWorkspaces[key] = workspace;
      this.save();
      if (plan.checkpoint === '15-6' && this.state.threads['review-D-implementation']) this.moveImplementationSession('review-D-implementation', key);
      await this.thread('implementer', key, {cwd: workspace.directory, checkpoint: plan.checkpoint});
    }
    const results = await Promise.allSettled(plans.map(plan => this.implement([
      `총괄 지시: REVIEW C의 승인 계약을 사용하여 ${plan.checkpoint}를 구현한다. 다른 분기와 동시에 실행 중이다.`,
      plan.instructions, `쓰기 소유 경로: ${JSON.stringify(plan.writablePaths)}`,
      `격리 작업 경로: ${this.state.branchWorkspaces[`branch-${plan.checkpoint}`].directory}. 이 경로만 수정한다. 원본 프로젝트는 읽기만 한다.`,
      '소유 경로 외 코드는 수정하지 않는다. 공유 계약 변경이 필요하면 남은 문제로 보고하고 총괄의 통합 작업을 기다린다.',
      `분기 산출물 경로: ${path.join(this.state.branchWorkspaces[`branch-${plan.checkpoint}`].directory, '.reports')}`,
      '최종 changedFiles에 실제 변경 경로를 빠짐없이 기록한다. 소유 범위와 분기 산출물 외 기존 보고서/자산을 덮어쓰지 않는다.',
      '15-7/15-8/게시를 실행하지 않는다. 리뷰 통과를 스스로 판정하지 않는다.',
    ].join('\n\n'), `branch-${plan.checkpoint}`)));
    const failures = results.filter(result => result.status === 'rejected');
    this.record('parallel-results', results.map((result, index) => ({checkpoint: plans[index].checkpoint, ...(result.status === 'fulfilled' ? {result: result.value} : {error: result.reason.message})})));
    if (failures.length) throw Error(`Parallel branch did not complete: ${failures.map(result => result.reason.message).join('; ')}`);
    const branchVerifications = [];
    for (const [index, plan] of plans.entries()) {
      const key = `branch-${plan.checkpoint}`;
      branchVerifications.push(await this.assessImplementation(results[index].value, {
        key, responsePath: this.relative(path.join(this.roundDirectory, `${key}-response.json`)),
        workingRoot: this.state.branchWorkspaces[key].directory,
      }));
    }
    this.record('parallel-task-verifications', branchVerifications);
    if (this.boundTargets) for(const plan of plans)validateProductTarget(this.root,this.state.branchWorkspaces[`branch-${plan.checkpoint}`].target);
    // Validate both baselines and all ownership before applying either branch.
    const changes = plans.flatMap((plan, index) => planWorkspaceMerge(this.productRoot, this.state.branchWorkspaces[`branch-${plan.checkpoint}`], plan, results[index].value.changedFiles));
    applyWorkspaceMerge(changes);
    this.record('parallel-merge', {changes: changes.map(change => ({path: change.name, remove: change.remove}))});
    if (results[0].value.status === 'completed') await this.retireThread('branch-15-5', 'task-completed');
    // 15-6 is immediately before REVIEW D: keep its history through integration
    // and D repair, changing the cwd back to the integrated project for these turns.
    await this.retireThread('implementer', 'previous-review-completed');
    this.state.threads.implementer = this.state.threads['branch-15-6'];
    this.state.implementationSessions.implementer = {...this.state.implementationSessions['branch-15-6'], cwd: this.productRoot};
    this.state.threadNames.implementer = '[15-6] 구현';
    delete this.state.threads['branch-15-6'];
    delete this.state.implementationSessions['branch-15-6'];
    delete this.state.threadNames['branch-15-6'];
    delete this.state.branchWorkspaces['branch-15-6'];
    this.save();
    await this.thread('implementer', 'implementer', {cwd: this.productRoot, checkpoint: '15-6'});
    // No branch can directly dispatch another role. Supervisor receives both outputs first.
    const handoff = await this.turn('supervisor', 'supervisor-integration', [
      '15-5 및 15-6 병렬 구현 결과를 함께 검토하고 구현 역할에 전달할 통합 프롬프트를 작성한다.',
      JSON.stringify(results.map((result, index) => ({checkpoint: plans[index].checkpoint, result: result.value})), null, 2),
      `각 분기의 독립 태스크 검증 결과:\n${JSON.stringify(branchVerifications, null, 2)}`,
      'action=repair, review=D, repairReview=D로 응답한다. repairPrompt에는 shared tool/authority/migration 계약을 일치시키고 두 단계의 통합 증거를 준비하는 작업만 포함한다.',
      '분기 검증의 fail/blocked와 suggestedRepairPrompt를 통합 보완에 반드시 반영한다. 분기 태스크 PASS를 전체 D PASS로 취급하지 않는다.',
      '아직 REVIEW D는 독립 검증되지 않았다. PASS를 선언하거나 15-7을 시작하지 않는다.',
    ].join('\n\n'), SUPERVISION_SCHEMA);
    if (handoff.action === 'blocked') { validateDecision('D', {verdict: 'fail'}, handoff); this.waitForInput(handoff); }
    if (handoff.action !== 'repair' || handoff.review !== 'D' || handoff.repairReview !== 'D' || !handoff.repairPrompt.trim()) throw Error('Supervisor did not provide D integration instructions');
    if (this.reviewUnits) requireReviewCoverage('D', handoff);
    await this.implement(`총괄이 전달하는 15-5·15-6 통합 지시:\n\n${handoff.repairPrompt}\n\n후속 단계나 게시를 실행하지 말고 결과를 총괄에게 보고한다.`, 'implementer-integration');
    this.state.phase = 'verify';
    this.save();
  }

  async advance(verification, decision) {
    const review = this.state.review;
    delete this.state.activeReview;
    if (this.boundTargets) {
      validateProductTarget(this.root,verification.productTarget);
      if (verification.productTarget.targetId !== this.state.currentProductTarget.targetId) throw Error('Target binding: approval does not cover the current candidate');
      this.state.approvedProductTarget = verification.productTarget;
      const workspace=this.state.productWorkspaces?.[review];
      if(workspace?.target?.targetId===verification.productTarget.targetId)workspace.frozen=true;
    }
    const certificate = {verification: review === 'B' ? this.state.latestPrerequisiteVerification : this.state.latestVerification, inputs: verification.inputs, evidence: verification.evidence, certifiedAt: stamp(),
      ...(this.boundTargets ? {productTarget:verification.productTarget} : {})};
    if (review === 'B') {
      this.state.prerequisiteCertificates ??= {};
      this.state.prerequisiteCertificates.B = certificate;
    } else this.state.certificates[review] = certificate;
    this.save();
    for (const [key, session] of Object.entries(this.state.implementationSessions)) if (session.review === review) await this.retireThread(key, `REVIEW ${review} passed`);
    if (review === 'A') {
      requireReviewCoverage('B', decision);
      if (!decision.repairPrompt.trim()) throw Error('REVIEW A advance needs a concrete 15-3 assignment');
      this.state.review = 'B';
      this.state.phase = 'implement';
      this.state.nextAction = 'Implement fresh 15-3 after independent REVIEW A passed';
      this.save();
      await this.implement(`${decision.repairPrompt}\n\n새 산출물 디렉터리: ${path.join(this.roundDirectory, 'implementation-next')}\n기존 승인 후보를 재사용하거나 C를 선행하지 않는다.`);
      this.state.phase = 'verify';
      this.save();
    } else if (review === 'B') {
      this.state.review = 'C';
      if (this.reviewUnits) requireReviewCoverage('C', decision);
      delete this.state.resumeAfterPrerequisite;
      this.state.phase = 'implement';
      this.state.nextAction = 'Resume retained 15-4 implementation after independent REVIEW B passed';
      this.save();
      await this.implement([
        '총괄 지시: 독립 REVIEW B 통과를 확인했다. 보관한 [15-4] 구현 세션으로 복귀하여 C 보완을 계속한다.',
        `현재 B 검증 근거: ${this.state.latestPrerequisiteVerification}`,
        decision.repairPrompt,
        `새 결과 디렉터리: ${path.join(this.roundDirectory, 'implementation-next')}`,
        '고정된 B 정책·입력·generator 인증을 보존하고 실제 두 독립 전 세계 후보 생성과 REVIEW C 재검증에 필요한 산출물을 완성한다.',
        '구현 완료는 C 통과 판정이 아니다. 총괄에게 결과를 반환하며 C 통과 전 15-5/15-6과 게시를 실행하지 않는다.',
      ].join('\n\n'));
      this.state.phase = 'verify';
      this.save();
    } else if (review === 'F') {
      this.state.status = 'standby';
      this.state.phase = 'standby';
      this.state.activeRole = null;
      this.state.nextAction = 'Wait for explicit user instruction. No cutover or Prompt 16.';
      this.state.productionCutover = 'not-executed-by-user-instruction';
      this.save();
      this.event('standby_after_review_f');
    } else if (review === 'C') await this.parallel(decision);
    else {
      const next = REVIEWS[REVIEWS.indexOf(review) + 1];
      this.state.review = next;
      this.state.phase = 'implement';
      this.state.nextAction = `Implement ${CHECKPOINTS[next].join(', ')}`;
      this.save();
      await this.implement([
        `총괄 지시: REVIEW ${review}의 독립 통과를 확인했다. ${CHECKPOINTS[next].join(', ')}를 원문 명세대로 구현한다.`,
        `이전 검증 근거: ${this.state.latestVerification}`,
        `새 산출물 경로: ${path.join(this.roundDirectory, 'implementation-next')}`,
        '이번 checkpoint만 구현하고 결과를 총괄에게 보고한다. REVIEW 통과를 자체 판정하지 않는다.',
        '15-8은 최종 후보와 cutover 준비까지다. F 통과 이후에도 게시를 실행하지 않는다.',
      ].join('\n\n'));
      this.state.phase = 'verify';
      this.save();
    }
  }

  async verifyBaseline() {
    if (this.state.baselinePending || this.config.baselineVerification) throw Error('Manual baseline gate: automatic Prompt 14 repair loop is retired');
  }

  async recoverBoundVerification() {
    if (!this.boundTargets || this.state.phase !== 'supervise') return null;
    const file = this.state.review === 'B' ? this.state.latestPrerequisiteVerification : this.state.latestVerification;
    if (!file) return null;
    const verification = JSON.parse(fs.readFileSync(resolveInside(this.root,file),'utf8'));
    if (verification.review !== this.state.review) return null;
    this.roundDirectory = path.dirname(resolveInside(this.root,file));
    validateVerification(this.root,path.join(this.roundDirectory,'verification'),this.state.review,verification,verification.fullReview ? [...GATES[this.state.review],...TASK_GATES] : GATES[this.state.review]);
    attestProductTarget(this.root,this.state.currentProductTarget,verification);
    if (this.config.verificationStages && verification.verdict === 'pass') await createVerificationStages(path.join(this.roundDirectory,'verification/job-context.json')).validateComplete();
    this.event('published_verification_recovered',{path:file,targetId:verification.targetId});
    return verification;
  }

  async beginFreshReview() {
    if (!this.state.startupPending) return;
    if (this.state.nextVerificationAssignment?.review === 'A') {
      this.state.startupPending = false; this.save(); return;
    }
    this.state.startupAttempts = (this.state.startupAttempts ?? 0) + 1;
    this.roundDirectory = path.join(this.directory, 'rounds', `0000-A-start-${this.state.startupAttempts}`);
    fs.mkdirSync(this.roundDirectory, {recursive: true}); this.save();
    let decision;
    if (this.state.startupDecision) decision = JSON.parse(fs.readFileSync(resolveInside(this.root, this.state.startupDecision), 'utf8'));
    else {
      decision = await this.turn('supervisor', 'startup', [
        '새 실행 시작: Prompt 14 롤백 기준에서 15-1/15-2 전체 구현을 배정한다. 현재 REVIEW A는 아직 판정하지 않았다.',
        'action=repair, review=A, repairReview=A, branchPlans=[]로 반환한다. repairPrompt에는 실행 가능한 전체 구현·감사·복구 후보 준비 지시를 쓰고 repairCoverage에 모든 A gate를 기록한다.',
        '이 시작 배정은 실패 판정/스트라이크가 아니다. 구현 완료 후 한 번의 독립 REVIEW A로 전달한다. 과거 B 실행/후보는 재개하지 않는다.',
        reviewUnitInstructions('A'),
        this.state.latestBaselineVerification ? `현재 Prompt14 독립 승인: ${this.state.latestBaselineVerification}` : '',
        this.boundTargets ? `수동 Prompt14 승인 및 실제 기준 후보: ${JSON.stringify(this.state.baselineCertificate)}\nA 구현 작업본: ${this.productRoot}` : '',
        `새 산출물 디렉터리: ${path.join(this.roundDirectory, 'implementation')}`,
      ].join('\n\n'), SUPERVISION_SCHEMA);
      if (decision.review !== 'A' || decision.repairReview !== 'A' || decision.action !== 'repair' || !decision.repairPrompt.trim() || decision.blockerKind !== 'none') throw Error('Fresh REVIEW A needs a complete implementation assignment');
      requireReviewCoverage('A', decision);
      this.state.startupDecision = this.record('startup-decision', decision); this.save();
    }
    await this.implement(decision.repairPrompt);
    this.state.startupPending = false; this.state.phase = 'verify'; this.save();
  }

  async run() {
    try {
      if (!await this.initialize()) return this.state;
      await this.verifyBaseline();
      await this.recoverCheckpointCorrection();
      await this.recoverInterruptedImplementation();
      await this.recoverImplementationHandoff();
      await this.beginFreshReview();
      while (this.state.status === 'running') {
        this.ensureRunning();
        const verification = await this.recoverBoundVerification() ?? (this.boundTargets ? null : this.recoverVerification()) ?? await this.verify();
        const decision = await this.supervise(verification);
        if (decision.action === 'blocked') this.waitForInput(decision);
        if (decision.action === 'repair') await this.repair(decision);
        else await this.advance(verification, decision);
      }
    } catch (error) {
      if (this.state.activeImplementation && !this.state.pendingImplementation) {
        this.state.interruptedImplementation = {...this.state.activeImplementation, interruptedAt:stamp(), reason:error.message};
      }
      this.state.status = classifyFailure(error, this.state, this.stopped || fs.existsSync(path.join(this.directory, 'stop.json')));
      if (this.state.status !== 'stopped') recordRuntimeFailure(this.state, error);
      this.state.activeRole = null;
      this.state.error = error.message;
      this.state.nextAction = this.state.requiredUserInput ? `Waiting for ${this.state.requiredUserInput.kind}: ${this.state.requiredUserInput.evidence}` :
        this.state.pendingImplementation ? 'Recover and forward the saved implementation report to supervisor.' : 'Recover runtime; independently verify uncertain work.';
      if (this.state.status === 'waiting_execution') this.state.nextAction = this.state.executionFailure.resumeCondition;
      this.save();
      this.event(this.state.status === 'stopped' ? 'workflow_stopped' : 'workflow_waiting', {status: this.state.status, reason: error.message});
    }
    return this.state;
  }
}
