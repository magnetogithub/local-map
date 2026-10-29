import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawn} from 'node:child_process';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {CodexClient} from './codex-client.mjs';

vi.mock('node:child_process', () => ({spawn: vi.fn()}));

const fixtures = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const {client, process: child} of fixtures.splice(0)) {
    client.fail(Error('Test cleanup'));
    child.stdout.destroy();
    child.stderr.destroy();
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function fixture(options = {}) {
  const child = new EventEmitter();
  const sent = [];
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  const exit = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
  };
  child.stdin = {
    write: vi.fn(line => { sent.push(JSON.parse(line)); return true; }),
    end: vi.fn(exit),
  };
  child.kill = vi.fn(exit);
  spawn.mockReturnValue(child);
  const client = new CodexClient({cwd: 'fake-workspace', requestTimeoutMs: 60000, turnTimeoutMs: 5000, ...options});
  const f = {
    client, process: child, sent,
    notify: (method, params) => child.stdout.write(`${JSON.stringify({method, params})}\n`),
    reply: (request, result) => child.stdout.write(`${JSON.stringify({id: request.id, result})}\n`),
    reject: (request, message = 'Start rejected') => child.stdout.write(`${JSON.stringify({id: request.id, error: {code: -32000, message}})}\n`),
  };
  fixtures.push(f);
  return f;
}

function begin(f, options = {}) {
  const onStarted = options.onStarted ?? vi.fn();
  const promise = f.client.runTurn({
    threadId: 'thread', cwd: 'fake-workspace', role: {model: 'fake-model', effort: 'low'},
    prompt: 'Return structured output', schema: {type: 'object'}, writableRoots: ['fake-workspace'],
    ...options, onStarted,
  });
  const outcome = promise.then(result => ({result}), error => ({error}));
  return {outcome, onStarted, request: f.sent.filter(row => row.method === 'turn/start').at(-1)};
}

async function flush() { await Promise.resolve(); await Promise.resolve(); }
async function started(f, turn, turnId = 'turn') {
  f.reply(turn.request, {turn: {id: turnId}});
  await flush();
}
function item(f, turnId, text, phase = 'final_answer') {
  f.notify('item/completed', {threadId: 'thread', turnId, item: {type: 'agentMessage', phase, text}});
}
function complete(f, turnId, {status = 'completed', text, error} = {}) {
  f.notify('turn/completed', {threadId: 'thread', turn: {
    id: turnId, status, error,
    items: text === undefined ? [] : [{type: 'agentMessage', phase: 'final_answer', text}],
  }});
}
function expectClean(f) {
  expect(f.client.turns.size).toBe(0);
  expect(f.client.pending.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

describe('CodexClient turn lifecycle', () => {
  test.each(['completion items', 'item notifications'])('completion from %s clears the turn and both timers', async source => {
    const f = fixture();
    const turn = begin(f);
    await started(f, turn);
    item(f, 'turn', 'Commentary must not become the final response', 'commentary');
    if (source === 'item notifications') item(f, 'turn', '{"ok":true}');
    complete(f, 'turn', {text: source === 'completion items' ? '{"ok":true}' : undefined});

    expect(await turn.outcome).toMatchObject({result: {turnId: 'turn', value: {ok: true}}});
    expect(turn.onStarted).toHaveBeenCalledExactlyOnceWith({threadId: 'thread', turnId: 'turn'});
    expectClean(f);
    complete(f, 'turn', {text: '{"late":true}'});
    f.client.fail(Error('Late process error'));
    expectClean(f);
  });

  test.each([
    ['failed', {status: 'failed', error: {message: 'Model failed'}}, 'TURN_NOT_COMPLETED'],
    ['interrupted', {status: 'interrupted'}, 'TURN_NOT_COMPLETED'],
    ['empty response', {}, 'EMPTY_RESPONSE'],
    ['invalid structured output', {text: 'not JSON'}, 'INVALID_STRUCTURED_OUTPUT'],
  ])('%s rejects without leaving timers or an active turn', async (_name, completion, code) => {
    const f = fixture();
    const turn = begin(f);
    await started(f, turn);
    complete(f, 'turn', completion);

    expect((await turn.outcome).error).toMatchObject({code});
    expectClean(f);
    complete(f, 'turn', {text: '{"late":true}'});
    expectClean(f);
  });

  test.each([
    ['timeout', false], ['timeout', true], ['stop', false], ['stop', true],
  ])('%s before/after start acknowledgement=%s settles immediately and cancels pending timers', async (reason, acknowledged) => {
    const f = fixture();
    const shouldStop = vi.fn(() => reason === 'stop');
    const turn = begin(f, {shouldStop});
    if (acknowledged) await started(f, turn);
    await vi.advanceTimersByTimeAsync(reason === 'stop' ? 1000 : 5000);

    expect((await turn.outcome).error).toMatchObject({code: reason === 'stop' ? 'STOP_REQUESTED' : 'TURN_TIMEOUT'});
    expect(turn.onStarted).toHaveBeenCalledTimes(acknowledged ? 1 : 0);
    expect(f.sent.filter(row => row.method === 'turn/interrupt')).toHaveLength(acknowledged ? 1 : 0);
    expectClean(f);

    const polls = shouldStop.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(shouldStop).toHaveBeenCalledTimes(polls);
    expectClean(f);
  });

  test.each(['RPC rejection', 'missing turn id', 'send failure'])('%s while starting clears all turn resources', async reason => {
    const f = fixture();
    if (reason === 'send failure') f.process.stdin.write.mockImplementationOnce(() => { throw Error('Send failed'); });
    const turn = begin(f);
    if (reason === 'RPC rejection') f.reject(turn.request);
    if (reason === 'missing turn id') f.reply(turn.request, {turn: {}});

    const {error} = await turn.outcome;
    expect(error).toBeInstanceOf(Error);
    if (reason === 'missing turn id') expect(error.code).toBe('TURN_START_FAILED');
    expect(turn.onStarted).not.toHaveBeenCalled();
    expectClean(f);
  });

  test('a start RPC timeout also clears the longer turn timeout and polling interval', async () => {
    const f = fixture({requestTimeoutMs: 10});
    const turn = begin(f);

    await vi.advanceTimersByTimeAsync(10);

    expect((await turn.outcome).error.message).toBe('RPC timeout: turn/start');
    expect(turn.onStarted).not.toHaveBeenCalled();
    expectClean(f);
  });

  test.each(['onStarted', 'shouldStop'])('a throwing %s callback ends the turn and clears its timers', async callback => {
    const f = fixture();
    const error = Error('Callback failed');
    const turn = begin(f, {[callback]: () => { throw error; }});
    await started(f, turn);
    if (callback === 'shouldStop') await vi.advanceTimersByTimeAsync(1000);

    expect((await turn.outcome).error).toBe(error);
    expectClean(f);
  });

  test.each([
    ['error', false], ['error', true], ['exit', false], ['exit', true], ['close', false], ['close', true],
  ])('process %s during start acknowledgement=%s clears pending RPC and turn timers', async (event, acknowledged) => {
    const f = fixture();
    const turn = begin(f);
    if (acknowledged) await started(f, turn);
    if (event === 'error') f.process.emit('error', Error('Process failed'));
    else f.process.emit(event, 1, null);

    expect((await turn.outcome).error).toBeInstanceOf(Error);
    expectClean(f);
    f.client.fail(Error('Duplicate terminal event'));
    complete(f, 'turn', {text: '{"late":true}'});
    expectClean(f);
  });

  test.each([false, true])('client close during start acknowledgement=%s is safe to repeat', async acknowledged => {
    const f = fixture();
    const turn = begin(f);
    if (acknowledged) await started(f, turn);

    await Promise.all([f.client.close(), f.client.close()]);
    await f.client.close();

    expect((await turn.outcome).error).toMatchObject({code: 'CLIENT_CLOSED'});
    expect(f.process.stdin.end).toHaveBeenCalledTimes(1);
    expectClean(f);
  });

  test.each(['absent', 'exited'])('close still settles turns and unrelated RPCs when the process is %s', async state => {
    const f = fixture();
    const turn = begin(f);
    const rpc = f.client.request('initialize', {}).catch(error => error);
    if (state === 'absent') f.client.process = null;
    else f.process.exitCode = 0;

    await f.client.close();

    expect((await turn.outcome).error.code).toBe('CLIENT_CLOSED');
    expect((await rpc).code).toBe('CLIENT_CLOSED');
    expect(f.process.stdin.end).not.toHaveBeenCalled();
    expectClean(f);
  });

  test('close cleans its kill fallback timer and sends shutdown only once', async () => {
    const f = fixture();
    const turn = begin(f);
    f.process.stdin.end.mockImplementation(() => {});
    const firstClose = f.client.close();
    const secondClose = f.client.close();
    expect((await turn.outcome).error.code).toBe('CLIENT_CLOSED');
    expect(f.client.pending.size).toBe(0);
    expect(f.client.turns.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([firstClose, secondClose]);

    expect(f.process.stdin.end).toHaveBeenCalledTimes(1);
    expect(f.process.kill).toHaveBeenCalledTimes(1);
    expectClean(f);
  });

  test('completion before the start reply is matched and replayed after the turn id is known', async () => {
    const f = fixture();
    const turn = begin(f);
    item(f, 'turn', '{"fast":true}');
    complete(f, 'turn');
    await started(f, turn);

    expect(await turn.outcome).toMatchObject({result: {turnId: 'turn', value: {fast: true}}});
    expectClean(f);
  });

  test.each([false, true])('old messages cannot settle or supply the reused thread response; new final=%s', async hasFinal => {
    const f = fixture();
    const first = begin(f);
    await started(f, first, 'turn-A');
    await vi.advanceTimersByTimeAsync(5000);
    expect((await first.outcome).error.code).toBe('TURN_TIMEOUT');
    expectClean(f);

    const second = begin(f);
    let settled = false;
    second.outcome.then(() => { settled = true; });
    item(f, 'turn-A', '{"stale":true}');
    complete(f, 'turn-A', {text: '{"stale":true}'});
    await started(f, second, 'turn-B');
    item(f, 'turn-A', '{"stale":true}');
    complete(f, 'turn-A', {text: '{"stale":true}'});
    await flush();
    expect(settled).toBe(false);
    expect(f.client.turns.size).toBe(1);

    if (hasFinal) item(f, 'turn-B', '{"current":true}');
    complete(f, 'turn-B');
    const outcome = await second.outcome;
    if (hasFinal) expect(outcome.result).toMatchObject({turnId: 'turn-B', value: {current: true}});
    else expect(outcome.error.code).toBe('EMPTY_RESPONSE');
    expectClean(f);
  });

  test('a cancelled start and its late reply cannot remove a newly started turn on the same thread', async () => {
    const f = fixture();
    const first = begin(f);
    // Start B before the cancelled start's rejection continuation runs.
    vi.advanceTimersByTime(5000);
    const second = begin(f);
    await started(f, second, 'turn-B');
    f.reply(first.request, {turn: {id: 'turn-A'}});
    item(f, 'turn-A', '{"stale":true}');
    complete(f, 'turn-A', {text: '{"stale":true}'});
    await flush();

    expect((await first.outcome).error.code).toBe('TURN_TIMEOUT');
    expect(first.onStarted).not.toHaveBeenCalled();
    expect(second.onStarted).toHaveBeenCalledExactlyOnceWith({threadId: 'thread', turnId: 'turn-B'});
    expect(f.client.turns.size).toBe(1);
    complete(f, 'turn-B', {text: '{"current":true}'});
    expect(await second.outcome).toMatchObject({result: {turnId: 'turn-B', value: {current: true}}});
    expectClean(f);
  });
});
