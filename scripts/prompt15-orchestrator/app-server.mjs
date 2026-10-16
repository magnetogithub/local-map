import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {EventEmitter} from 'node:events';
import {ExecutionProgress} from './execution-progress.mjs';

/** A small client for the installed Codex JSONL app-server protocol. */
export class AppServer extends EventEmitter {
  constructor({binary = 'codex', cwd, log = () => {}, requestTimeoutMs = 120000, turnTimeoutMs = 21600000, serverArgs = ['app-server', '--listen', 'stdio://']}) {
    super();
    this.log = log;
    this.requestTimeoutMs = requestTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.pending = new Map();
    this.active = new Map();
    this.nextId = 1;
    this.failure = null;
    this.process = spawn(binary, serverArgs, {cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => this.fail(Error(`Codex app-server exited (${code ?? signal})`)));
    this.lines = createInterface({input: this.process.stdout});
    this.lines.on('line', line => {
      try { this.receive(JSON.parse(line)); }
      catch (error) { this.fail(error); }
    });
    // Keep authentication tokens and environment out of controller logs.
    const errors = createInterface({input: this.process.stderr});
    errors.on('line', line => this.log({kind: 'server_stderr', text: line.replace(/(Bearer\s+|sk-)[A-Za-z0-9_\-.]+/gi, '$1[redacted]')}));
  }

  send(message) {
    if (this.failure) throw this.failure;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`RPC timed out: ${method}`)); }, this.requestTimeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      try { this.send({id, method, params}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  receive(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    // A headless client must never silently grant an approval or answer a user's question.
    // auto_review is handled inside the server; unresolved requests stop the workflow.
    if (message.id !== undefined && message.method) {
      this.log({kind: 'input_required', method: message.method, threadId: message.params?.threadId});
      this.send({id: message.id, error: {code: -32000, message: 'Human input is required; controller does not auto-approve.'}});
      this.fail(Error(`Human input required: ${message.method}`));
      return;
    }
    const {method, params = {}} = message;
    const active = this.active.get(params.threadId);
    active?.executionProgress?.receive(method, params.item);
    if (method === 'item/completed' && active && params.item?.type === 'agentMessage') {
      if (params.item.phase !== 'commentary') active.messages.push(params.item.text);
      this.log({kind: 'agent_message', threadId: params.threadId, phase: params.item.phase, text: params.item.text});
    }
    if (method === 'turn/completed' && active) {
      clearTimeout(active.timer);
      clearInterval(active.idleTimer);
      this.active.delete(params.threadId);
      const turn = params.turn;
      if (turn.status !== 'completed') active.reject(Error(`Turn ${turn.status}: ${turn.error?.message ?? turn.id}`));
      else {
        const items = turn.items?.filter(item => item.type === 'agentMessage' && item.phase !== 'commentary').map(item => item.text) ?? [];
        const text = (items.length ? items : active.messages).at(-1);
        if (!text) active.reject(Error('Completed turn has no final agent message'));
        else active.resolve({turnId: turn.id, text});
      }
    }
    if (['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)) this.log({kind: 'event', method, threadId: params.threadId, turnId: params.turn?.id, itemType: params.item?.type, status: params.turn?.status});
    this.emit('notification', {method, params});
  }

  async initialize() {
    const result = await this.request('initialize', {clientInfo: {name: 'prompt15_orchestrator', title: 'Prompt 15 총괄', version: '1.0.0'}});
    this.send({method: 'initialized'});
    return result;
  }

  async runTurn(threadId, input, schema, overrides = {}, {executionIdleTimeoutMs = 0, turnTimeoutMs = this.turnTimeoutMs, onStarted} = {}) {
    if (this.active.has(threadId)) throw Error('A role cannot run two turns concurrently');
    let finish;
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        finish.expired = true;
        clearInterval(finish.idleTimer);
        this.active.delete(threadId);
        if (finish.turnId) this.request('turn/interrupt', {threadId, turnId: finish.turnId}).catch(() => {});
        reject(Error(`Turn timeout for ${threadId}; no completion was certified`));
      }, turnTimeoutMs);
      finish = {resolve, reject, timer, messages: [], executionProgress: new ExecutionProgress()};
      if (executionIdleTimeoutMs > 0) finish.idleTimer = setInterval(() => {
        if (!finish.executionProgress.isIdle(Date.now(), executionIdleTimeoutMs)) return;
        finish.expired = true;
        clearInterval(finish.idleTimer); clearTimeout(finish.timer);
        this.active.delete(threadId);
        if (finish.turnId) this.request('turn/interrupt', {threadId, turnId: finish.turnId}).catch(error => this.log({kind: 'idle_interrupt_error', threadId, text: error.message}));
        this.log({kind: 'execution_idle_timeout', threadId, turnId: finish.turnId, limitMs: executionIdleTimeoutMs});
        reject(Error(`Verification execution idle timeout for ${threadId}; no completion was certified`));
      }, Math.min(60000, executionIdleTimeoutMs));
      this.active.set(threadId, finish);
    });
    // Mark the promise handled even if turn/start fails before completion is awaited.
    completion.catch(() => {});
    let startFailure;
    try {
      const result = await this.request('turn/start', {threadId, input: [{type: 'text', text: input}], outputSchema: schema, ...overrides});
      if (!result.turn?.id) throw Error('Turn start returned no exact native identity');
      finish.turnId = result.turn.id;
      await onStarted?.({threadId, turnId: result.turn.id});
      if (finish.expired) this.request('turn/interrupt', {threadId, turnId: result.turn.id}).catch(() => {});
    } catch (error) {
      startFailure = error;
      if (finish.turnId && !finish.expired) this.request('turn/interrupt', {threadId, turnId: finish.turnId}).catch(() => {});
      clearTimeout(finish.timer);
      clearInterval(finish.idleTimer);
      this.active.delete(threadId);
      finish.reject(error);
    }
    // Completion may race ahead of the start acknowledgement. A failure to
    // persist that acknowledgement must still reject an already resolved turn.
    if (startFailure) throw startFailure;
    const result = await completion;
    let value;
    try { value = JSON.parse(result.text); }
    catch { throw Error(`Invalid structured final output from ${threadId}`); }
    return {...result, value};
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    for (const active of this.active.values()) { clearTimeout(active.timer); clearInterval(active.idleTimer); active.reject(error); }
    this.pending.clear();
    this.active.clear();
    this.emit('failure', error);
  }

  async close() {
    if (this.closing) return this.closing;
    if (!this.process.pid) return;
    if (this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.closing = this.shutdown();
    return this.closing;
  }

  async shutdown() {
    // Interrupt only the threads started by this client. Never stop other Codex windows.
    await Promise.allSettled([...this.active].filter(([, turn]) => turn.turnId).map(([threadId, turn]) => this.request('turn/interrupt', {threadId, turnId: turn.turnId})));
    const exited = new Promise(resolve => { this.process.once('exit', resolve); this.process.once('close', resolve); });
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill(), 5000);
    await exited;
    clearTimeout(timer);
  }
}
