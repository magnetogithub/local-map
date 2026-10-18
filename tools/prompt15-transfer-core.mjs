import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pipeline} from 'node:stream/promises';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export async function hashFile(file) {
  const hash = createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}
export function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') ||
      path.posix.isAbsolute(name) || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error(`Unsafe transfer path: ${name}`);
  }
  return name;
}
export function isPrivatePath(name) {
  return name.split('/').some(part => ['.git', '.codex', '.agents', '.aws', '.ssh', '.codex-remote-attachments'].includes(part) ||
    (part.startsWith('.env') && part !== '.env.example')) || /(?:^|\/)(?:auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519)$/.test(name);
}
export function secretKinds(text) {
  return [
    ['openai-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{28,}/],
    ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})/],
    ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
    ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
    ['discord-webhook', /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{30,}/],
    ['bearer-token', /\bBearer\s+[A-Za-z0-9_.-]{40,}/],
  ].filter(([, expression]) => expression.test(text)).map(([name]) => name);
}
const slash = name => name.replaceAll('\\', '/');
const excludedSource = new Set(['.git', '.codex', '.agents', '.aws', 'node_modules', '.next', 'out', 'build', 'coverage', '.tmp', '.reports', 'test-results', 'reports', 'data', 'public', 'archives']);
const coldHistoryKeys = new Set(['attemptHistory','controllerRepairHistory','interruptedRepairHistory','operatingMaintenanceHistory',
  'maintenanceFailureHistory','resolvedExecutionIncidents','nativeAuditReconciliations','exhaustionNotices','retiredRequests','operatingFailures']);
export class TransferInventory {
  constructor(root, {progress = () => {}} = {}) {
    this.root = path.resolve(root); this.progress = progress;
    this.files = new Map(); this.links = new Map(); this.dependencies = new Map();
    this.queue = []; this.seen = new Set(); this.roots = new Set(); this.missing = new Set();
    this.logicalSeen = new Set(); this.ancestorSeen = new Set(); this.pathCache = new Map();
    this.referenceSeen = new Set();
    this.realDirectories = new Map();
  }
  relative(file) {
    const relative = slash(path.relative(this.root, file));
    if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return null;
    return safeRelative(relative);
  }
  resolve(name) {
    if (typeof name !== 'string' || !name || name.length > 1000 || /[\n\r\0]/.test(name) || /^(https?:|file:)/.test(name)) return null;
    if (!path.isAbsolute(name) && !/^(?:reports|data|public|src|scripts|tools|automation|docs|prompts|e2e|validation|node_modules|\.tmp)[/\\]/.test(name) && !/^(?:package(?:-lock)?\.json|.*config\.[cm]?[jt]s|AGENTS\.md|CLAUDE\.md)$/.test(name)) return null;
    const file = path.resolve(this.root, name);
    return this.relative(file) ? file : null;
  }
  registerAncestors(file) {
    const parts = path.relative(this.root, file).split(path.sep); let cursor = this.root;
    for (const part of parts) {
      cursor = path.join(cursor, part);
      if (this.ancestorSeen.has(cursor)) continue;
      this.ancestorSeen.add(cursor);
      if (!fs.existsSync(cursor)) break;
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        const target = path.resolve(path.dirname(cursor), fs.readlinkSync(cursor));
        const relative = this.relative(cursor), targetRelative = this.relative(target);
        if (!relative || !targetRelative) throw Error(`External workspace link: ${cursor}`);
        this.links.set(relative, {path: relative, target: targetRelative});
        if (target !== cursor) this.registerAncestors(target);
      }
    }
  }
  canonical(file) {
    let result=file;
    for(let hop=0;hop<64;hop++){
      let cursor=result,match=null;
      while(cursor!==this.root){const relative=this.relative(cursor);if(relative&&this.links.has(relative)){match={cursor,link:this.links.get(relative)};break;}const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
      if(!match)return result;
      result=path.join(this.root,match.link.target,path.relative(match.cursor,result));
    }
    throw Error('Workspace link cycle');
  }
  addFile(name) {
    const logical = this.resolve(name); if (!logical) return;
    if (this.logicalSeen.has(logical)) return;
    this.logicalSeen.add(logical);
    const relative = this.relative(logical); if (isPrivatePath(relative)) throw Error(`Private file referenced: ${relative}`);
    if (!fs.existsSync(logical)) { this.missing.add(relative); return; }
    if (!fs.statSync(logical).isFile()) return;
    this.registerAncestors(logical);
    const real = this.canonical(logical);
    const realRelative = this.relative(real);
    if (!realRelative) { this.dependencies.set(logical, {path: logical, kind: 'external-tool'}); return; }
    if (realRelative.split('/').includes('node_modules')) {
      this.dependencies.set(realRelative, {path: realRelative, kind: 'npm'}); return;
    }
    if (!this.files.has(realRelative)) {
      this.files.set(realRelative, {path: realRelative, source: real, byteLength: fs.statSync(real).size});
      if (/\.json$/i.test(real) && fs.statSync(real).size <= 32 * 1024 * 1024) this.queue.push(realRelative);
    }
  }
  addSourceRoot(name) {
    const root = this.resolve(name); if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory() || this.roots.has(root)) return;
    this.roots.add(root);
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        if (excludedSource.has(entry.name) || entry.name.startsWith('.next-') || isPrivatePath(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) { this.registerAncestors(file); continue; }
        if (entry.isDirectory()) visit(file); else if (entry.isFile()) this.addFile(file);
      }
    };
    visit(root);
    for (const name of ['data', 'public', 'node_modules', 'reports/prompt14', 'validation/archives', 'validation/node_modules']) {
      const file = path.join(root, name);
      if (fs.existsSync(file)) this.registerAncestors(file);
    }
  }
  inspect(value, key = '', owner = null) {
    if (typeof value === 'string') {
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) && !path.isAbsolute(value)) return;
      if (!path.isAbsolute(value) && !/^(reports|data|src|scripts|tools|automation|docs|public|prompts|e2e|validation|node_modules|\.tmp)[/\\]/.test(value) &&
          !/^[^\r\n"'<>|]{1,600}\.(?:json|jsonl|gz|mjs|js|ts|tsx|md|txt|ps1|png|geojson|csv|zip|pbf|bin|html)$/.test(value)) return;
      const keyName = (path.isAbsolute(value) || /^(reports|data|src|scripts|tools|automation|docs|public|prompts|e2e|validation|\.tmp)[/\\]/.test(value)) ? value : `${path.dirname(this.document ?? this.root)}|${value}`;
      if (this.referenceSeen.has(keyName)) return;
      this.referenceSeen.add(keyName);
      let file = this.resolve(value);
      if ((!file || !fs.existsSync(file)) && this.document && value.length < 1000 && !/[\n\r\0]/.test(value) && !path.isAbsolute(value)) {
        const candidate = path.resolve(path.dirname(this.document), value);
        if (!path.relative(this.root, candidate).includes(':') && this.relative(candidate) && fs.existsSync(candidate)) file = candidate;
      }
      if (!file) return;
      if(this.logicalSeen.has(file))return;
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) {
        // Directories are not recursive authority. Source/baseline manifests
        // below enumerate their exact files; a historical cwd may be a very
        // large scratch tree unrelated to the resumed product.
        return;
      } else this.addFile(file);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if(typeof value.path==='string'&&/^[a-f0-9]{64}$/.test(value.sha256??'')&&Number.isFinite(value.byteLength)){
      this.addFile(value.path);
      for(const [name,child]of Object.entries(value))if(!['path','sha256','byteLength'].includes(name))this.inspect(child,name,value);
      return;
    }
    if (value.implementationUnit === 'task' && value.tasks && value.runId) {
      for (const name of ['baselineCertificate','approvedProductTarget','currentProductTarget','productRoot','reviewWorkspace','certificates','tasks','latestVerification','repairRouting'])
        if (value[name]) this.inspect(value[name], name, value);
      return;
    }
    if (!Array.isArray(value)) {
      if (typeof value.productRoot === 'string' && value.source && typeof value.source === 'object') {
        for (const name of Object.keys(value.source)) this.addFile(path.join(value.productRoot, name));
      }
      if (typeof value.directory === 'string' && value.baseline && typeof value.baseline === 'object') {
        for (const [name, hash] of Object.entries(value.baseline)) {
          const file = path.join(value.directory, name);
          if (typeof hash === 'string' && hash.startsWith('link:')) {
            if (fs.existsSync(file)) this.registerAncestors(file);
          } else this.addFile(file);
        }
      }
    }
    for (const [childKey, child] of Object.entries(value)) if(!coldHistoryKeys.has(childKey)) this.inspect(child, childKey, value);
  }
  async discover(seeds) {
    for (const seed of seeds) this.addFile(seed);
    for (let cursor = 0; cursor < this.queue.length; cursor++) {
      const relative = this.queue[cursor]; if (this.seen.has(relative)) continue;
      this.seen.add(relative);
      if(process.env.PROMPT15_TRANSFER_TRACE)fs.appendFileSync(process.env.PROMPT15_TRANSFER_TRACE,JSON.stringify({index:cursor,path:relative,files:this.files.size})+'\n');
      try { this.document = this.files.get(relative).source; this.inspect(JSON.parse(fs.readFileSync(this.document, 'utf8').replace(/^\uFEFF/, ''))); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      if (cursor % 100 === 0) { this.progress({parsed: cursor, files: this.files.size, queued: this.queue.length}); await new Promise(resolve => setTimeout(resolve, 0)); }
    }
    return {files: [...this.files.values()], links: [...this.links.values()], dependencies: [...this.dependencies.values()], missingReferences: [...this.missing]};
  }
}

// Mutable host ownership is separate from the immutable imported evidence.
// Product task rows, approval certificates and failure counters are not reset.
export function transferredState(original, receiptIdentity, at = new Date().toISOString()) {
  if (original.status !== 'stopped' || Object.keys(original.activeTurns ?? {}).length ||
      Object.keys(original.activeOperations ?? {}).length || original.activeOperation ||
      original.guardian?.activeRepairId || original.guardian?.activeAuditId ||
      original.supervisorOversight?.pendingRepairIdentity) throw Error('Transfer needs a stopped run with no native owner');
  const state = structuredClone(original);
  const archived = {};
  for (const key of ['threads', 'threadNames', 'guardian', 'supervisorOversight', 'operatingMaintenance', 'operatingMaintenanceHistory',
    'operatingMonitor', 'operatingRecovery', 'executionFailure', 'pendingExecutionIncident', 'guardianFailure', 'lastControllerFailure',
    'productBlockResolution', 'productBlockResolutions', 'explicitResume', 'error']) {
    if (key in state) archived[key] = state[key];
    delete state[key];
  }
  state.threads = {}; state.threadNames = {}; state.guardian = {sequence: original.guardian?.sequence ?? 0};
  state.supervisorOversight = {}; state.activeTurns = {}; state.activeOperations = {};
  state.controllerPid = null; state.runtimeSupervisorPid = null; state.activeRole = null;
  state.status = 'stopped'; state.phase = 'transfer_ready'; state.currentTasks = [];
  state.error = null;
  state.transfer = {version: 1, preparedAt: at, receiptIdentity, sourceRunId: original.runId,
    nativeSessions: 'fresh-after-explicit-resume', archivedHostState: archived,
    productApprovalsUnchanged: true, implementationFailureCountersUnchanged: true};
  state.nextAction = '다른 PC 이전 검증 완료 후 명시적으로 resume. A 승인과 15-13 BLOCKED를 유지하고 새 native 세션으로 인계.';
  for (const [id, row] of Object.entries(state.tasks)) {
    if (row.status === 'pass' || row.status === 'pending') continue;
    if (row.status !== 'blocked' || row.operatingContinuation || row.operatingHandoff) throw Error(`Unsupported active task transfer: ${id}`);
  }
  return state;
}
