import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';

const redact = text => text.replace(/(Bearer\s+|sk-)[A-Za-z0-9_\-.]+/gi, '$1[redacted]');

export class CodexClient {
  constructor({binary = 'codex', cwd, log = () => {}, requestTimeoutMs = 120000, turnTimeoutMs = 3600000}) {
    this.log = log;
    this.requestTimeoutMs = requestTimeoutMs;
    this.turnTimeoutMs = turnTimeoutMs;
    this.pending = new Map();
    this.turns = new Map();
    this.nextId = 1;
    this.process = spawn(binary, ['app-server', '--listen', 'stdio://'], {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.once('error', error => this.fail(error));
    this.process.once('exit', (code, signal) => this.fail(Error(`Codex app-server exited (${code ?? signal})`)));
    this.process.once('close', (code, signal) => this.fail(Error(`Codex app-server closed (${code ?? signal})`)));
    createInterface({input: this.process.stdout}).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch (error) { this.fail(error); }
    });
    createInterface({input: this.process.stderr}).on('line', line => this.log({kind: 'server_stderr', text: redact(line)}));
  }

  send(message) {
    if (this.failure) throw this.failure;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, {signal} = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => pending.reject(signal.reason);
      const finish = (error, result) => {
        if (this.pending.get(id) !== pending) return;
        clearTimeout(pending.timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(result);
      };
      const pending = {resolve: result => finish(null, result), reject: error => finish(error), timer: null};
      this.pending.set(id, pending);
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, {once: true});
      pending.timer = setTimeout(() => pending.reject(Error(`RPC timeout: ${method}`)), this.requestTimeoutMs);
      try { this.send({id, method, params}); }
      catch (error) { pending.reject(error); }
    });
  }

  finishTurn(active, {error = null, result = null, interrupt = false} = {}) {
    if (active.settled) return false;
    active.settled = true;
    clearTimeout(active.timer);
    clearInterval(active.stopTimer);
    active.events.length = 0;
    if (this.turns.get(active.threadId) === active) this.turns.delete(active.threadId);
    active.startAbort.abort(error ?? undefined);
    if (error) active.reject(error);
    else active.resolve(result);
    if (interrupt && active.turnId && !this.failure) {
      // Best effort only: a completed local turn must not acquire another RPC
      // timeout while waiting for an interrupt acknowledgement.
      try { this.send({id: this.nextId++, method: 'turn/interrupt', params: {threadId: active.threadId, turnId: active.turnId}}); }
      catch { /* the turn is already settled */ }
    }
    return true;
  }

  receiveTurnEvent(active, method, params) {
    const turnId = params.turn?.id ?? params.turnId;
    if (!turnId || active.settled) return;
    if (method === 'item/completed' && params.item?.type !== 'agentMessage') return;
    // A completion may precede the turn/start response. Wait for its turn ID
    // before accepting events, including when a thread is reused.
    if (!active.turnId) { active.events.push({method, params}); return; }
    if (turnId !== active.turnId) return;
    if (method === 'item/completed' && params.item?.type === 'agentMessage') {
      if (params.item.phase !== 'commentary') active.messages.push(params.item.text);
      this.log({kind: 'agent_message', threadId: active.threadId, phase: params.item.phase, text: params.item.text});
    }
    if (method === 'turn/completed') {
      const turn = params.turn;
      if (turn.status !== 'completed') this.finishTurn(active, {error: Object.assign(Error(`Turn ${turn.status}: ${turn.error?.message ?? turn.id}`), {code: 'TURN_NOT_COMPLETED'})});
      else {
        const final = (turn.items ?? []).filter(item => item.type === 'agentMessage' && item.phase !== 'commentary').map(item => item.text).at(-1) ?? active.messages.at(-1);
        if (!final) this.finishTurn(active, {error: Object.assign(Error('Completed turn has no final response'), {code: 'EMPTY_RESPONSE'})});
        else this.finishTurn(active, {result: {turnId: turn.id, text: final}});
      }
    }
  }

  receive(message) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(Error(`${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      // The controller never grants approvals or invents human answers.
      this.log({kind: 'human_input_required', method: message.method, threadId: message.params?.threadId});
      this.send({id: message.id, error: {code: -32000, message: 'Human input required'}});
      return;
    }
    const {method, params = {}} = message;
    const active = this.turns.get(params.threadId);
    if (active && ['item/completed', 'turn/completed'].includes(method)) this.receiveTurnEvent(active, method, params);
    if (['turn/started', 'turn/completed', 'item/started', 'item/completed'].includes(method)) {
      this.log({kind: 'native_event', method, threadId: params.threadId, turnId: params.turn?.id, itemType: params.item?.type, status: params.turn?.status});
    }
  }

  async initialize() {
    const result = await this.request('initialize', {clientInfo: {name: 'prompt15_simple_loop', title: 'Prompt 15 Simple Loop', version: '2.0.0'}});
    this.send({method: 'initialized'});
    return result;
  }

  async startThread({cwd, role, developerInstructions}) {
    const result = await this.request('thread/start', {
      cwd,
      model: role.model,
      developerInstructions,
      approvalPolicy: 'on-request',
    });
    if (!result.thread?.id) throw Object.assign(Error('thread/start returned no thread id'), {code: 'THREAD_START_FAILED'});
    return result.thread.id;
  }

  async runTurn({threadId, cwd, role, prompt, schema, writableRoots, shouldStop = () => false, onStarted = () => {}}) {
    if (this.failure) throw this.failure;
    if (this.turns.has(threadId)) throw Error(`Thread already active: ${threadId}`);
    const active = {threadId, messages: [], events: [], turnId: null, settled: false, startAbort: new AbortController()};
    const completion = new Promise((resolve, reject) => {
      active.resolve = resolve;
      active.reject = reject;
    });
    completion.catch(() => {});
    this.turns.set(threadId, active);
    active.timer = setTimeout(() => this.finishTurn(active, {
      error: Object.assign(Error('Model turn timed out'), {code: 'TURN_TIMEOUT'}), interrupt: true,
    }), this.turnTimeoutMs);
    active.stopTimer = setInterval(() => {
      try {
        if (shouldStop()) this.finishTurn(active, {error: Object.assign(Error('Stop requested'), {code: 'STOP_REQUESTED'}), interrupt: true});
      } catch (error) { this.finishTurn(active, {error, interrupt: true}); }
    }, 1000);
    // Completion must settle even if turn/start has not replied yet.
    (async () => {
      try {
        const result = await this.request('turn/start', {
          threadId,
          input: [{type: 'text', text: prompt}],
          outputSchema: schema,
          cwd,
          model: role.model,
          effort: role.effort,
          approvalPolicy: 'on-request',
          sandboxPolicy: {type: 'workspaceWrite', writableRoots},
        }, {signal: active.startAbort.signal});
        if (active.settled) return;
        if (!result?.turn?.id) throw Object.assign(Error('turn/start returned no turn id'), {code: 'TURN_START_FAILED'});
        active.turnId = result.turn.id;
        onStarted({threadId, turnId: active.turnId});
        for (const event of active.events.splice(0)) {
          if (active.settled) break;
          this.receiveTurnEvent(active, event.method, event.params);
        }
      } catch (error) { this.finishTurn(active, {error, interrupt: true}); }
    })();
    const result = await completion;
    let value;
    try { value = JSON.parse(result.text); }
    catch { throw Object.assign(Error('Final response is not valid structured JSON'), {code: 'INVALID_STRUCTURED_OUTPUT'}); }
    return {...result, value};
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const turn of this.turns.values()) this.finishTurn(turn, {error});
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.turns.clear();
  }

  async close() {
    this.fail(Object.assign(Error('Codex client closed'), {code: 'CLIENT_CLOSED'}));
    if (this.closing) return this.closing;
    if (!this.process || this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.closing = (async () => {
      const exited = new Promise(resolve => { this.process.once('exit', resolve); this.process.once('close', resolve); });
      const timer = setTimeout(() => this.process.kill(), 5000);
      try { this.process.stdin.end(); await exited; }
      finally { clearTimeout(timer); }
    })();
    return this.closing;
  }
}
