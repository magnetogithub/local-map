'use client';
import {useEffect, useMemo, useRef, useState} from 'react';
import {useStore} from 'zustand';
import {useRouter} from 'next/navigation';
import {AppHeader} from './AppHeader';
import {CountryPanel} from '../country/CountryPanel';
import {OperationalWorldMap} from '../map/OperationalWorldMap';
import {GameScreenContent} from '../game/CatalogGameScreen';
import {useGameSetupStore} from '@/stores/game-setup-store';
import {createOperationalGameClient, gameRequest, type OperationalGameClient} from '@/lib/simulation/client/operational-game-client';
import {useOperationalTurnController} from '@/lib/simulation/client/use-operational-turn-controller';
import {operationalGamePresentation} from '@/lib/projection/operational-game-presentation';
import type {OperationalGameStart} from '@/lib/simulation/operational-game-protocol';
import {OPERATIONAL_GAME_HEADER} from '@/lib/simulation/operational-game-protocol';
import {assertWorldGeometryCatalogRefMatches} from '@/lib/world/world-geometry-catalog-ref';
import type {TerritoryId} from '@/lib/world/territory-id';

// In-memory continuity across setup -> /game. Reload uses the existing new-game flow.
let loading: Promise<OperationalGameClient> | undefined;
function loadGame() {
  return loading ??= Promise.all([gameRequest<OperationalGameStart>({operation: 'start'}), fetch('/api/world/catalog/operational/cells', {cache: 'no-store'}).then(async r => {if (!r.ok) throw Error('CATALOG_NOT_READY'); return r.json();})])
    .then(([start, cells]) => {assertWorldGeometryCatalogRefMatches(cells.catalogRef, start.snapshot.world.catalogRef); return createOperationalGameClient(start, cells.cellIds as TerritoryId[]);})
    .catch(error => {loading = undefined; throw error;});
}
export function OperationalGameSetupShell({mode}: {mode: 'setup' | 'game'}) {
  const [client, setClient] = useState<OperationalGameClient | null>(null), [error, setError] = useState<string | null>(null);
  useEffect(() => {let disposed = false; void loadGame().then(value => {if (!disposed) setClient(value);}).catch(error => {if (!disposed) setError(error instanceof Error ? error.message : 'CATALOG_NOT_READY');}); return () => {disposed = true;};}, []);
  useEffect(() => {
    if (!client) return;
    const close = (event: PageTransitionEvent) => {if (!event.persisted) void fetch('/api/simulation/game', {method: 'DELETE', headers: {[OPERATIONAL_GAME_HEADER]: client.sessionId}, keepalive: true}).catch(() => {});};
    window.addEventListener('pagehide', close); return () => window.removeEventListener('pagehide', close);
  }, [client]);
  if (error) return <main className="route-loading" role="alert">세계 데이터를 불러오지 못했습니다. <button onClick={() => window.location.reload()}>다시 시작</button></main>;
  if (!client) return <main className="route-loading" role="status">세계 데이터를 불러오는 중입니다.</main>;
  return <ReadyOperationalShell mode={mode} client={client}/>;
}
function ReadyOperationalShell({mode, client}: {mode: 'setup' | 'game'; client: OperationalGameClient}) {
  const snapshot = useStore(client.store, s => s), router = useRouter(), player = useGameSetupStore(s => s.playerCountryId);
  const presentation = useMemo(() => operationalGamePresentation(snapshot.world, client.presentation), [client, snapshot.world]);
  const controller = useOperationalTurnController(client);
  const initialized = useRef(false), [preparing, setPreparing] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const store = useGameSetupStore.getState(); store.setCountrySearchProjection(presentation.search); store.setCountryPanelProjection(presentation.panel); store.initializeSession();
    if (mode === 'game' && initialized.current) store.syncSimulationPlayerCountry(snapshot.simulation.playerCountryId);
  }, [mode, presentation, snapshot.simulation.playerCountryId]);
  useEffect(() => {
    if (mode !== 'game' || initialized.current) return;
    initialized.current = true;
    const store = useGameSetupStore.getState(), requested = new URLSearchParams(window.location.hash.slice(1)).get('player');
    if (requested) {store.confirmPlayerCountry(requested); window.history.replaceState(null, '', window.location.pathname + window.location.search);}
    const selected = useGameSetupStore.getState().playerCountryId;
    if (!selected) {router.replace('/'); return;}
    setPreparing(true);
    void (selected !== client.getSnapshot().simulation.playerCountryId ? client.request({operation: 'select-player', countryId: selected}) : Promise.resolve())
      .then(() => store.syncSimulationPlayerCountry(client.getSnapshot().simulation.playerCountryId)).catch(error => setError(String(error))).finally(() => setPreparing(false));
  }, [client, mode, router]);
  useEffect(() => {
    if (mode !== 'setup' || !initialized.current) return;
    initialized.current = false; setPreparing(true);
    void client.request({operation: 'restart'}).then(() => useGameSetupStore.getState().clearSelectedCountry()).catch(error => setError(String(error))).finally(() => setPreparing(false));
  }, [client, mode]);
  if (error) return <main className="route-loading" role="alert">게임 상태를 불러오지 못했습니다. <button onClick={() => window.location.reload()}>새 게임</button></main>;
  if (preparing || mode === 'game' && (!player || snapshot.simulation.playerCountryId !== player)) return <main className="route-loading" role="status">플레이 국가를 준비하고 있습니다.</main>;
  const map = (settings?: Parameters<typeof OperationalWorldMap>[0]['uiSettings']) => <OperationalWorldMap key={snapshot.generation} client={client} presentation={presentation} uiSettings={settings}/>;
  return <><div className="unsupported"><div><h1>지원하지 않는 화면 크기입니다</h1><p>Pax Local은 1280×720 이상의 PC 화면을 지원합니다.</p></div></div>
    <div className="app-shell" data-page-mode={mode} data-world-schema-version="3" data-simulation-schema-version="2" data-world-revision={snapshot.world.revision} data-world-country-count={snapshot.world.countryOrder.length}
      data-world-territory-count={snapshot.world.territoryOrder.length} data-catalog-version={snapshot.world.catalogRef.catalogVersion} data-world-geometry-root={snapshot.world.catalogRef.geometryRoot} data-current-date={snapshot.simulation.currentDate}>
      {mode === 'setup' ? <><AppHeader/><main className="main">{map()}<CountryPanel onPlayerConfirmed={id => {setPreparing(true); void client.request({operation: 'select-player', countryId: id}).then(() => router.push(`/game#player=${encodeURIComponent(id)}`)).catch(error => setError(String(error))).finally(() => setPreparing(false));}}/></main>
        <footer className="footer"><time dateTime="2020-01-01">플레이 국가 선택</time><span>Map data: Natural Earth</span></footer></> :
        <GameScreenContent world={snapshot.world} mapProjection={presentation} turnController={controller} counts={snapshot.counts} map={map}/>}</div></>;
}
