"use client";

import {useEffect, useMemo, useReducer, useRef, useState} from "react";
import {useStore} from "zustand";

import {CatalogWorldMap as WorldMap} from "@/components/map/CatalogWorldMap";
import {createGameHudProjection} from "@/lib/game-ui/game-hud-projection";
import {createEconomyProjection, createPoliticsProjection} from "@/lib/game-ui/country-management-projection";
import {createCountryViewProjection, createDiplomacyChannelProjection} from "@/lib/game-ui/country-view-projection";
import {createWarsProjection} from "@/lib/game-ui/war-view-projection";
import {createNewsProjection} from "@/lib/game-ui/news-projection";
import {initialMajorEventQueueState, majorEventQueueReducer} from "@/lib/game-ui/major-event-queue";
import {DEFAULT_GAME_UI_SETTINGS, type GameUiSettingKey} from "@/lib/game-ui/ui-settings";
import {
  gameOverlayReducer,
  initialGameOverlay,
  type GameMenuOverlayKind,
} from "@/lib/game-ui/overlay-reducer";
import type {CountrySearchProjection} from "@/lib/projection/country-search-index-patch";
import {useCatalogSimulationTurnController as useSimulationTurnController} from "@/lib/simulation/client/use-catalog-simulation-turn-controller";
import {useGameSetupStore} from "@/stores/game-setup-store";
import type {CatalogRuntime as WorldStateStoreController} from '@/lib/simulation/catalog-runtime';
import type {CatalogMapConsumerProjection as WorldMapRuntimeProjection} from '@/lib/projection/catalog-map-consumer-projection';
import type {CatalogVectorDelivery} from '@/lib/map/catalog-vector-delivery';
import {GameEdgeNavigation} from "./GameEdgeNavigation";
import {GameHud} from "./GameHud";
import {GameEmptyState, GamePanel, GameTooltipProvider} from "./GamePanel";
import {GameOverlayEscapeHandler} from "./GameOverlayEscapeHandler";
import {EconomyOverlay, PoliticsOverlay} from "./CountryManagementOverlays";
import {CountryOverlay, DiplomacyOverlay} from "./DiplomacyOverlays";
import {SaveOverlay, SettingsOverlay, WarsOverlay} from "./WarAndSystemOverlays";
import {GameActionOverlay} from "./GameActionOverlay";
import {NewsOverlay} from "./NewsOverlay";
import {MajorEventModal} from "./MajorEventModal";
import {MapCountryPicker} from "./MapCountryPicker";

type Props = Readonly<{
  worldController: WorldStateStoreController;
  mapProjection: WorldMapRuntimeProjection;
  countrySearchProjection: CountrySearchProjection;
  delivery: CatalogVectorDelivery;
}>;

const panelCopy: Record<Exclude<GameMenuOverlayKind, "action">, Readonly<{
  title: string;
  eyebrow: string;
  description: string;
}>> = {
  politics: {title: "정치", eyebrow: "국가 관리", description: "정치 체제와 지도자 데이터 연결을 준비하고 있습니다."},
  economy: {title: "경제", eyebrow: "국가 관리", description: "인구와 경제 지표 데이터 연결을 준비하고 있습니다."},
  diplomacy: {title: "외교", eyebrow: "국제 관계", description: "전용 외교 채널 연결을 준비하고 있습니다."},
  wars: {title: "전쟁", eyebrow: "분쟁 현황", description: "현재 연결된 전쟁 데이터가 없습니다."},
  news: {title: "뉴스", eyebrow: "국제 소식", description: "아직 기록된 국제 사건이 없습니다."},
  save: {title: "저장", eyebrow: "게임 관리", description: "서버 저장 기능은 백엔드 연결 후 제공됩니다."},
  settings: {title: "설정", eyebrow: "화면 설정", description: "지도 표시 설정을 준비하고 있습니다."},
};

export function CatalogGameScreen({
  worldController,
  mapProjection,
  countrySearchProjection,
  delivery,
}: Props) {
  const world = useStore(worldController.store, (state) => state.world);
  const playerCountryId = useGameSetupStore((state) => state.playerCountryId);
  const selectedCountryId = useGameSetupStore((state) => state.selectedCountryId);
  const countryPanelProjection = useGameSetupStore((state) => state.countryPanelProjection);
  const clearSelectedCountry = useGameSetupStore((state) => state.clearSelectedCountry);
  const selectCountry = useGameSetupStore((state) => state.selectCountry);
  const syncSimulationPlayerCountry = useGameSetupStore((state) => state.syncSimulationPlayerCountry);
  const [overlay, dispatchOverlay] = useReducer(gameOverlayReducer, initialGameOverlay);
  const [majorEvents, dispatchMajorEvents] = useReducer(majorEventQueueReducer, initialMajorEventQueueState);
  const [uiSettings, setUiSettings] = useState(DEFAULT_GAME_UI_SETTINGS);
  const didObserveInitialSelection = useRef(false);
  const turnController = useSimulationTurnController({
    runtime:worldController,
    metadata:delivery.metadata,
    countrySearchProjection,
    playerCountryId,
    syncPlayerCountry: syncSimulationPlayerCountry,
  });

  useEffect(() => {
    dispatchOverlay({
      type: "reconcile-active-countries",
      activeCountryIds: new Set(world.countryOrder),
    });
  }, [world.countryOrder]);

  useEffect(() => {
    if (!didObserveInitialSelection.current) {
      didObserveInitialSelection.current = true;
      return;
    }
    if (selectedCountryId) {
      dispatchOverlay({type: "open", overlay: {kind: "country", countryId: selectedCountryId}});
    }
  }, [selectedCountryId]);

  useEffect(() => {
    if (turnController.report) {
      dispatchMajorEvents({type: "enqueue-report", report: turnController.report});
    }
  }, [turnController.report]);

  const closeOverlay = () => {
    clearSelectedCountry();
    dispatchOverlay({type: "close"});
  };
  const toggle = (kind: GameMenuOverlayKind) => {
    clearSelectedCountry();
    dispatchOverlay({type: "toggle-menu", kind});
  };
  const economy = useMemo(() => playerCountryId ? createEconomyProjection({
    world,
    mapProjection,
    countryId: playerCountryId,
    simulation: turnController.snapshot?.simulation ?? null,
  }) : null, [mapProjection, playerCountryId, turnController.snapshot, world]);
  const hud = useMemo(() => playerCountryId ? createGameHudProjection({
    world,
    mapProjection,
    playerCountryId,
    simulation: turnController.snapshot?.simulation ?? null,
    phase: turnController.turn.phase,
    economy,
    unacknowledgedMajorEventCount: majorEvents.pending.length,
  }) : null, [economy, majorEvents.pending.length, mapProjection, playerCountryId, turnController.snapshot, turnController.turn.phase, world]);
  const politics = useMemo(() => playerCountryId ? createPoliticsProjection({
    world,
    mapProjection,
    countryId: playerCountryId,
    simulation: turnController.snapshot?.simulation ?? null,
  }) : null, [mapProjection, playerCountryId, turnController.snapshot, world]);
  const country = useMemo(() => playerCountryId && overlay.kind === "country" ? createCountryViewProjection({
    world,
    mapProjection,
    playerCountryId,
    countryId: overlay.countryId,
    simulation: turnController.snapshot?.simulation ?? null,
    countryPanelProjection,
  }) : null, [countryPanelProjection, mapProjection, overlay, playerCountryId, turnController.snapshot, world]);
  const diplomacy = useMemo(() => playerCountryId && overlay.kind === "diplomacy" ? createDiplomacyChannelProjection({
    world,
    mapProjection,
    playerCountryId,
    counterpartCountryId: overlay.countryId ?? null,
  }) : null, [mapProjection, overlay, playerCountryId, world]);
  const wars = useMemo(() => createWarsProjection(), []);
  const news = useMemo(() => turnController.snapshot ? createNewsProjection({
    simulation: turnController.snapshot.simulation,
    report: turnController.report,
    selectedEventId: overlay.kind === "news" ? overlay.eventId ?? null : null,
    acknowledgedEventIds: majorEvents.acknowledgedEventIds,
  }) : null, [majorEvents.acknowledgedEventIds, overlay, turnController.report, turnController.snapshot]);
  const majorEvent = majorEvents.pending[0] ?? null;
  const countryNames = useMemo(() => Object.freeze(Object.fromEntries(
    world.countryOrder.map((countryId) => [countryId, world.countriesById[countryId].names.shortKo]),
  )), [world]);
  const mapCountryOptions = useMemo(() => Object.freeze(world.countryOrder.map((countryId) => Object.freeze({
    countryId,
    name: world.countriesById[countryId].names.shortKo,
    role: countryId === playerCountryId ? "player" as const : "foreign" as const,
  }))), [playerCountryId, world]);
  const changeUiSetting = (key: GameUiSettingKey, value: boolean) => {
    setUiSettings((current) => Object.freeze({...current, [key]: value}));
  };
  if (!playerCountryId || !hud) return null;

  const panel = overlay.kind !== "closed"
    ? overlay.kind === "action"
      ? {title: "국가 행동", eyebrow: "턴 진행", description: null}
      : overlay.kind === "country"
        ? {title: country?.country.nameKo ?? "국가 정보", eyebrow: "국가 정보", description: null}
        : panelCopy[overlay.kind]
    : null;

  return (
    <main className="game-screen" data-testid="game-screen" data-reduce-motion={uiSettings.reduceMotion ? "" : undefined}>
      <GameTooltipProvider>
        <WorldMap
          runtime={worldController}
          delivery={delivery}
          mapProjection={mapProjection}
          uiSettings={uiSettings}
        />
        <MapCountryPicker
          options={mapCountryOptions}
          selectedCountryId={selectedCountryId}
          onSelect={(countryId) => {
            selectCountry(countryId);
            window.dispatchEvent(new CustomEvent("pax:focus-country", {detail: countryId}));
          }}
        />
        <GameHud
          model={hud}
          onOpen={toggle}
          onStop={turnController.stop}
          onRetry={() => void turnController.retry()}
          turnDraft={turnController.turn.draft}
          turnErrorCode={turnController.turn.errorCode}
        />
        <GameEdgeNavigation overlay={overlay} onToggle={toggle}/>
        <GameOverlayEscapeHandler onClose={closeOverlay}/>
        {panel && (
          <GamePanel key={`${overlay.kind}:${"countryId" in overlay ? overlay.countryId ?? "" : ""}`} title={panel.title} eyebrow={panel.eyebrow} onClose={closeOverlay}>
            {overlay.kind === "action" ? (
              <GameActionOverlay
                controller={turnController}
                advanceBlocked={majorEvent !== null}
                onOpenNews={(eventId) => dispatchOverlay({type: "open", overlay: {kind: "news", eventId}})}
              />
            ) : overlay.kind === "politics" && politics ? (
              <PoliticsOverlay model={politics}/>
            ) : overlay.kind === "economy" && economy ? (
              <EconomyOverlay model={economy}/>
            ) : overlay.kind === "country" && country ? (
              <><dl data-testid="country-territorial-control"><dt>소유 영토</dt><dd>{mapProjection.ownedByCountry[country.country.countryId]?.length??0}</dd><dt>통제 영토</dt><dd>{mapProjection.controlledByCountry[country.country.countryId]?.length??0}</dd><dt>타국 통제 아래의 소유 영토</dt><dd>{(mapProjection.ownedByCountry[country.country.countryId]??[]).filter(id=>mapProjection.featuresById[id].occupied).length}</dd></dl><CountryOverlay
                model={country}
                onOpenPolitics={() => { clearSelectedCountry(); dispatchOverlay({type: "open", overlay: {kind: "politics"}}); }}
                onOpenDiplomacy={(countryId) => dispatchOverlay({type: "open", overlay: {kind: "diplomacy", countryId}})}
              /></>
            ) : overlay.kind === "diplomacy" && diplomacy ? (
              <DiplomacyOverlay
                model={diplomacy}
                onSelectCountry={(countryId) => dispatchOverlay({type: "open", overlay: {kind: "diplomacy", countryId}})}
              />
            ) : overlay.kind === "wars" ? (
              <WarsOverlay model={wars}/>
            ) : overlay.kind === "news" && news ? (
              <NewsOverlay
                model={news}
                activeCountryIds={new Set(world.countryOrder)}
                onSelectEvent={(eventId) => dispatchOverlay({type: "open", overlay: {kind: "news", eventId}})}
                onOpenCountry={(countryId) => dispatchOverlay({type: "open", overlay: {kind: "country", countryId}})}
              />
            ) : overlay.kind === "save" ? (
              <SaveOverlay countryName={hud.playerCountry.nameKo} currentDate={hud.currentDate} turnNumber={hud.turnNumber}/>
            ) : overlay.kind === "settings" ? (
              <SettingsOverlay settings={uiSettings} onChange={changeUiSetting}/>
            ) : (
              <GameEmptyState title={`${panel.title} 데이터 없음`} description={panel.description ?? "데이터 연결을 준비하고 있습니다."}/>
            )}
          </GamePanel>
        )}
        <p className="game-live-region" aria-live="polite" aria-atomic="true">
          {overlay.kind === "closed" ? "" : `${panel?.title ?? "국가"} 창 열림`}
        </p>
        {majorEvent && <MajorEventModal
          entry={majorEvent}
          countryNames={countryNames}
          onViewOnMap={(countryId) => window.dispatchEvent(new CustomEvent("pax:focus-country", {detail: countryId}))}
          onAcknowledge={() => {
            dispatchMajorEvents({type: "acknowledge-current"});
            if (majorEvents.pending.length === 1) {
              dispatchOverlay({type: "open", overlay: {kind: "news", eventId: majorEvent.event.eventId}});
            }
          }}
        />}
      </GameTooltipProvider>
    </main>
  );
}

