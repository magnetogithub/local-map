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
    createInterface({input: this.process.stdout}).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch (error) { this.fail(error); }
    });
    createInterface({input: this.process.stderr}).on('line', line => this.log({kind: 'server_stderr', text: redact(line)}));
  }

  send(message) {
    if (this.failure) throw this.failure;
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(`RPC timeout: ${method}`));
      }, this.requestTimeoutMs);
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
    if (message.id !== undefined && message.method) {
      // The controller never grants approvals or invents human answers.
      this.log({kind: 'human_input_required', method: message.method, threadId: message.params?.threadId});
      this.send({id: message.id, error: {code: -32000, message: 'Human input required'}});
      return;
    }
    const {method, params = {}} = message;
    const active = this.turns.get(params.threadId);
    if (method === 'item/completed' && active && params.item?.type === 'agentMessage') {
      if (params.item.phase !== 'commentary') active.messages.push(params.item.text);
      this.log({kind: 'agent_message', threadId: params.threadId, phase: params.item.phase, text: params.item.text});
    }
    if (method === 'turn/completed' && active) {
      clearTimeout(active.timer);
      clearInterval(active.stopTimer);
      this.turns.delete(params.threadId);
      const turn = params.turn;
      if (turn.status !== 'completed') active.reject(Object.assign(Error(`Turn ${turn.status}: ${turn.error?.message ?? turn.id}`), {code: 'TURN_NOT_COMPLETED'}));
      else {
        const final = (turn.items ?? []).filter(item => item.type === 'agentMessage' && item.phase !== 'commentary').map(item => item.text).at(-1) ?? active.messages.at(-1);
        if (!final) active.reject(Object.assign(Error('Completed turn has no final response'), {code: 'EMPTY_RESPONSE'}));
        else active.resolve({turnId: turn.id, text: final});
      }
    }
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
    if (this.turns.has(threadId)) throw Error(`Thread already active: ${threadId}`);
    let active;
    const completion = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (active.turnId) this.request('turn/interrupt', {threadId, turnId: active.turnId}).catch(() => {});
        this.turns.delete(threadId);
        reject(Object.assign(Error('Model turn timed out'), {code: 'TURN_TIMEOUT'}));
      }, this.turnTimeoutMs);
      const stopTimer = setInterval(() => {
        if (!shouldStop()) return;
        clearTimeout(timer); clearInterval(stopTimer); this.turns.delete(threadId);
        if (active.turnId) this.request('turn/interrupt', {threadId, turnId: active.turnId}).catch(() => {});
        reject(Object.assign(Error('Stop requested'), {code: 'STOP_REQUESTED'}));
      }, 1000);
      active = {resolve, reject, timer, stopTimer, messages: [], turnId: null};
      this.turns.set(threadId, active);
    });
    completion.catch(() => {});
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
      });
      if (!result.turn?.id) throw Object.assign(Error('turn/start returned no turn id'), {code: 'TURN_START_FAILED'});
      active.turnId = result.turn.id;
      onStarted({threadId, turnId: active.turnId});
    } catch (error) {
      clearTimeout(active.timer); clearInterval(active.stopTimer); this.turns.delete(threadId); active.reject(error); throw error;
    }
    const result = await completion;
    let value;
    try { value = JSON.parse(result.text); }
    catch { throw Object.assign(Error('Final response is not valid structured JSON'), {code: 'INVALID_STRUCTURED_OUTPUT'}); }
    return {...result, value};
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    for (const turn of this.turns.values()) { clearTimeout(turn.timer); clearInterval(turn.stopTimer); turn.reject(error); }
    this.pending.clear(); this.turns.clear();
  }

  async close() {
    if (!this.process || this.process.exitCode !== null || this.process.signalCode !== null) return;
    const exited = new Promise(resolve => { this.process.once('exit', resolve); this.process.once('close', resolve); });
    this.process.stdin.end();
    const timer = setTimeout(() => this.process.kill(), 5000);
    await exited; clearTimeout(timer);
  }
}
