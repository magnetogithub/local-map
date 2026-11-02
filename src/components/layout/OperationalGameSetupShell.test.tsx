import {StrictMode} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createSimulationStateV2} from '@/lib/simulation/simulation-state-v2';
import type {OperationalGameStart} from '@/lib/simulation/operational-game-protocol';
import {readCatalogTerritoryId} from '@/lib/world/world-geometry-catalog-ref';
import {createCountryEntityV3} from '@/lib/world/country-entity-v3';
import {useGameSetupStore} from '@/stores/game-setup-store';
import {OperationalGameSetupShell} from './OperationalGameSetupShell';

const mocks = vi.hoisted(() => ({router: {push: vi.fn(), replace: vi.fn()}}));
vi.mock('next/navigation', () => ({useRouter: () => mocks.router}));
vi.mock('./AppHeader', () => ({AppHeader: () => null}));
vi.mock('../map/OperationalWorldMap', () => ({OperationalWorldMap: () => <div>지도</div>}));
vi.mock('../country/CountryPanel', () => ({CountryPanel: ({onPlayerConfirmed}: {onPlayerConfirmed(id: string): void}) =>
  <button onClick={() => {useGameSetupStore.getState().confirmPlayerCountry('AAA'); onPlayerConfirmed('AAA');}}>AAA로 시작</button>}));
vi.mock('../game/CatalogGameScreen', () => ({GameScreenContent: () => <div data-testid="game-screen">게임 화면</div>}));

function responses(failCells = false) {
  const id = readCatalogTerritoryId(`territory:catalog:${'1'.repeat(64)}`);
  const country = createCountryEntityV3({id: 'AAA', names: {shortKo: 'AAA', officialKo: 'AAA', mapKo: 'AAA', english: 'AAA', searchAliases: []},
    politicalStatus: 'sovereign', presentationOverride: null, moduleVersions: {core: 1, names: 1}, mapColor: '#123456'});
  const countriesById = {AAA: country}, catalogRef = {catalogVersion: 'f05-shell-v1', geometryRoot: '1'.repeat(64), topologyRoot: '2'.repeat(64),
    renderArtifactRoot: '3'.repeat(64), manifestPath: '/data/f05-shell-v1/manifest.json'};
  const simulation = createSimulationStateV2({schemaVersion: 2, revision: 0, currentDate: '2020-01-01', turnNumber: 0, playerCountryId: 'AAA',
    queuedActions: [], factsById: {}, factOrder: [], situationsById: {}, situationOrder: [], scheduledConsequences: [], eventLog: [],
    history: {lastCommittedTurnId: null, committedTurnCount: 0}, territorialControlAuthoritiesById: {}, territorialControlAuthorityOrder: [],
    countryPresentationAuthoritiesById: {}, countryPresentationAuthorityOrder: []},
  {countriesById, retiredCountryIds: [], territoriesById: {[id]: {id}}});
  const start: OperationalGameStart = {sessionId: '757c2206-552c-4e0e-99b4-816d841ec403', seedVersion: 'f05-shell', policyVersion: 'f05-shell',
    runs: [[1, 'AAA', 'AAA', 'AAA']], presentation: [], snapshot: {revisions: {worldRevision: 0, simulationRevision: 0},
      world: {catalogRef, revision: 0, countriesById, countryOrder: [country.id], retiredCountryIds: []}, simulation,
      stateChange: null, counts: {AAA: {owned: 1, controlled: 1, occupied: 0}}, canUndo: false, canRedo: false, report: null}};
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(null, {status: 204});
    if (url === '/api/world/catalog/operational/cells') return failCells ? new Response(null, {status: 503}) : Response.json({catalogRef, cellIds: [id]});
    if (url === '/api/simulation/game') {
      const command = JSON.parse(String(init?.body));
      if (command.operation === 'start') return Response.json(start);
      if (command.operation === 'select-player') return Response.json({snapshot: start.snapshot});
    }
    throw Error('Unexpected test request');
  });
  vi.stubGlobal('fetch', fetcher);
  return {fetcher, deletes: () => fetcher.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
    starts: () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST' && JSON.parse(String(init.body)).operation === 'start')};
}

beforeEach(() => {useGameSetupStore.getState().resetGameSetup(); vi.clearAllMocks(); window.history.replaceState(null, '', '/');});
afterEach(async () => {
  cleanup();
  await act(async () => {window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));});
  useGameSetupStore.getState().resetGameSetup(); vi.unstubAllGlobals();
});

describe('F05 operational setup initialization ownership', () => {
  it('shows initialization failure and reclaims the allocated session on cells failure', async () => {
    const f = responses(true), view = render(<OperationalGameSetupShell mode="setup"/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('세계 데이터를 불러오지 못했습니다.');
    await waitFor(() => expect(f.deletes()).toHaveLength(1));
    view.unmount();
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
    expect(f.deletes()).toHaveLength(1);
  });

  it('shares one start during StrictMode replay and preserves the selected game on a real mode transition', async () => {
    const f = responses(), view = render(<StrictMode><OperationalGameSetupShell mode="setup"/></StrictMode>);
    fireEvent.click(await screen.findByRole('button', {name: 'AAA로 시작'}));
    await waitFor(() => expect(mocks.router.push).toHaveBeenCalledWith('/game#player=AAA'));
    view.rerender(<StrictMode><OperationalGameSetupShell mode="game"/></StrictMode>);
    expect(await screen.findByTestId('game-screen')).toBeInTheDocument();
    expect(f.starts()).toHaveLength(1);
    expect(f.deletes()).toHaveLength(0);
  });

  it('reuses a ready client across route unmounts and keeps a bfcache page alive', async () => {
    const f = responses(), setup = render(<OperationalGameSetupShell mode="setup"/>);
    fireEvent.click(await screen.findByRole('button', {name: 'AAA로 시작'}));
    await waitFor(() => expect(mocks.router.push).toHaveBeenCalledOnce());
    setup.unmount();
    await act(async () => {await new Promise(resolve => setTimeout(resolve, 5));});
    render(<OperationalGameSetupShell mode="game"/>);
    expect(await screen.findByTestId('game-screen')).toBeInTheDocument();
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
    expect(f.starts()).toHaveLength(1);
    expect(f.deletes()).toHaveLength(0);
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}));
    expect(f.deletes()).toHaveLength(1);
  });
});
