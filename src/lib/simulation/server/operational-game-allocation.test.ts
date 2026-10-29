import {afterEach, describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  ids: [] as string[], snapshot: vi.fn(), metadata: vi.fn(),
  nextId: () => {const id = `757c2206-552c-4e0e-99b4-${String(mocks.ids.length + 1).padStart(12, '0')}`; mocks.ids.push(id); return id;},
}));
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomUUID = () => mocks.nextId();
  return {...actual, randomUUID, default: {...actual, randomUUID}};
});
vi.mock('node:fs', () => ({default: {readFileSync: () => Buffer.from('{}')}}));
vi.mock('../../world/operational-game.server', () => ({createProductionOperationalGame: () => ({
  pair: {world: {territoryOrder: [], territoriesById: {}, seedVersion: 'f05', policyVersion: 'f05'}}, catalog: {},
})}));
vi.mock('../../world/operational-catalog.server', () => ({loadOperationalCatalog: () => ({ref: {}})}));
vi.mock('../../world/production-catalog-seed.server', () => ({loadProductionCatalogSeed: () => ({bootstrap: {metadata: {path: '/f05.json'}, catalogRef: {}}})}));
vi.mock('../../map/catalog-consumer-contract', () => ({readCatalogConsumerMetadata: mocks.metadata}));
vi.mock('../catalog-region.server', () => ({loadCatalogRegionIndex: () => ({})}));
vi.mock('../operational-frontier.server', () => ({selectOperationalFrontier: vi.fn()}));
vi.mock('./operational-game-session', () => ({createOperationalGameSession: () => ({snapshot: mocks.snapshot, isBusy: () => false})}));
import {closeOperationalGame, operationalGameSession, startOperationalGame} from './operational-game.server';

afterEach(() => {mocks.ids.forEach(closeOperationalGame); vi.clearAllMocks();});

describe('F05 server allocation publication', () => {
  it('does not register a session if snapshot preparation fails before its ID can reach the client', () => {
    mocks.snapshot.mockImplementationOnce(() => {throw Error('SNAPSHOT_FAILED');});
    expect(() => startOperationalGame()).toThrow('SNAPSHOT_FAILED');
    expect(() => operationalGameSession(mocks.ids.at(-1)!)).toThrow('GAME_SESSION_EXPIRED');
  });

  it('does not register a session if country presentation fails before a start response exists', () => {
    mocks.snapshot.mockReturnValue({});
    mocks.metadata.mockImplementationOnce(() => {throw Error('PRESENTATION_FAILED');});
    expect(() => startOperationalGame()).toThrow('PRESENTATION_FAILED');
    expect(() => operationalGameSession(mocks.ids.at(-1)!)).toThrow('GAME_SESSION_EXPIRED');
  });

  it('publishes a fully prepared session and keeps explicit cleanup idempotent', () => {
    mocks.snapshot.mockReturnValue({}); mocks.metadata.mockReturnValue({countries: [], territories: []});
    const started = startOperationalGame();
    expect(operationalGameSession(started.sessionId)).toBeDefined();
    closeOperationalGame(started.sessionId); closeOperationalGame(started.sessionId);
    expect(() => operationalGameSession(started.sessionId)).toThrow('GAME_SESSION_EXPIRED');
  });
});
