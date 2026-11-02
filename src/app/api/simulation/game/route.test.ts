import {afterEach, describe, expect, it, vi} from 'vitest';
import {SimulationContractError} from '@/lib/simulation/simulation-contract-primitives';

const host = vi.hoisted(() => ({command: vi.fn()}));
vi.mock('@/lib/simulation/server/operational-game.server', () => ({
  closeOperationalGame: vi.fn(), startOperationalGame: vi.fn(),
  operationalGameSession: () => ({command: host.command}),
}));
import {POST} from './route';

afterEach(() => vi.clearAllMocks());

describe('F03 game action admission errors', () => {
  it('returns the explicit queue policy error to clients', async () => {
    host.command.mockImplementation(() => {throw new SimulationContractError('ACTION_QUEUE_LIMIT_REACHED', 'At most 32 active actions');});
    const response = await POST(new Request('http://localhost/api/simulation/game', {method: 'POST', body: JSON.stringify({
      operation: 'queue', sessionId: '757c2206-552c-4e0e-99b4-816d841ec403',
      revisions: {worldRevision: 0, simulationRevision: 0}, text: '초과 행동',
    })}));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({error: {code: 'ACTION_QUEUE_LIMIT_REACHED'}});
  });
});
