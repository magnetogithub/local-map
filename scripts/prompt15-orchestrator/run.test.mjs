import path from 'node:path';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';

const mocks = vi.hoisted(() => ({run: vi.fn(), state: null}));
vi.mock('./orchestrator.mjs', () => ({
  Prompt15Orchestrator: class {
    run(options) { return mocks.run(options); }
  },
}));
vi.mock('./protocol.mjs', async importOriginal => ({
  ...await importOriginal(),
  readJson: file => path.basename(file) === 'state.json' ? structuredClone(mocks.state) : {},
  atomicJson: vi.fn(),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  mocks.run.mockReset();
  mocks.state = {status: 'waiting_input', phase: 'implement', taskId: '15-18', productAttempt: 2, requiredInput: 'Supply the missing input'};
  mocks.run.mockImplementation(async () => structuredClone(mocks.state));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.exitCode = 0;
});
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('resume CLI input acknowledgement', () => {
  test.each([
    [[], false],
    [['--ack-operating'], false],
    [['--ack-input'], true],
  ])('resume flags %j forward only explicit input acknowledgement', async (flags, ackInput) => {
    process.argv = [originalArgv[0], 'run.mjs', 'resume', '--run', 'reports/prompt15/orchestrator-v2/test-run', ...flags];

    await import('./run.mjs');

    expect(mocks.run).toHaveBeenCalledExactlyOnceWith({ackInput});
    expect(console.error).not.toHaveBeenCalled();
    expect(JSON.parse(console.log.mock.calls[0][0])).toMatchObject(mocks.state);
    expect(process.exitCode).toBe(1);
  });

  test('input acknowledgement cannot acknowledge an operating failure', async () => {
    mocks.state = {...mocks.state, status: 'operating_failure', phase: 'operating_failure'};
    process.argv = [originalArgv[0], 'run.mjs', 'resume', '--run', 'reports/prompt15/orchestrator-v2/test-run', '--ack-input'];

    await import('./run.mjs');

    expect(mocks.run).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Operating failure requires explicit --ack-operating after the cause is fixed');
    expect(process.exitCode).toBe(1);
  });
});
