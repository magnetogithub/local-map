"use client";

import {useEffect, useMemo, useState} from "react";
import {useRouter} from "next/navigation";
import {useStore} from "zustand";
import {AppHeader} from "./AppHeader";
import {WorldMap} from "@/components/map/WorldMap";
import {CountryPanel} from "@/components/country/CountryPanel";
import {createCountryCapitalProjection} from "@/lib/projection/country-capital-projection";
import {createCountryMapMarkerProjection, type SmallCountryMarkerSeed} from "@/lib/projection/country-map-marker-projection";
import {createCountryPanelProjection, deserializeCountryPanelProjection, type CountryPanelPresentationEntry, type SerializedCountryPanelProjection} from "@/lib/projection/country-panel-projection";
import {createCountrySearchProjection, deserializeCountrySearchProjection, type SerializedCountrySearchProjection} from "@/lib/projection/country-search-index-patch";
import {createLabelProjection, deserializeLabelProjection, type SerializedLabelProjection} from "@/lib/projection/label-projection-checkpoint";
import {createWorldMapRuntimeProjection} from "@/lib/projection/world-map-runtime-projection";
import {useGameSetupStore} from "@/stores/game-setup-store";
import {createWorldStateStore} from "@/stores/world-state-store";
import type {InitialWorldStateV2Bootstrap} from "@/lib/world/initial-world-state-v2";
import type {SeedCountryCapital} from "@/lib/world/seed-v1-to-v2";
import {deserializeWorldStateV2, type SerializedWorldStateV2} from "@/lib/world/world-state-v2";
import type {SerializedProductionSubdivisionCatalog} from "@/lib/simulation/subdivision-catalog";
import {GameScreen} from "@/components/game/GameScreen";

type Props = {
  mode:"setup"|"game";
  initialWorldState:InitialWorldStateV2Bootstrap;
  initialWorldSnapshot:SerializedWorldStateV2;
  capitalSeeds:Readonly<Record<string,SeedCountryCapital>>;
  smallCountryMarkerSeeds:Readonly<Record<string,SmallCountryMarkerSeed>>;
  panelPresentationEntries:Readonly<Record<string,CountryPanelPresentationEntry>>;
  countryMapColorSeeds:Readonly<Record<string,string>>;
  initialCountrySearchProjection:SerializedCountrySearchProjection;
  initialCountryPanelProjection:SerializedCountryPanelProjection;
  initialLabelProjection:SerializedLabelProjection;
  subdivisionCatalog:SerializedProductionSubdivisionCatalog;
};

export function GameSetupShell(props:Props){
  const router=useRouter();
  const {initialWorldState,initialWorldSnapshot,capitalSeeds,smallCountryMarkerSeeds,panelPresentationEntries,countryMapColorSeeds,initialCountrySearchProjection,initialCountryPanelProjection}=props;
  const [worldController]=useState(()=>createWorldStateStore(deserializeWorldStateV2(initialWorldSnapshot)));
  const worldState=useStore(worldController.store,state=>state);
  const capitalProjection=useMemo(()=>createCountryCapitalProjection(worldState,capitalSeeds),[worldState,capitalSeeds]);
  const markerProjection=useMemo(()=>createCountryMapMarkerProjection(worldState,capitalProjection,smallCountryMarkerSeeds),[worldState,capitalProjection,smallCountryMarkerSeeds]);
  const initialLabelProjection=useMemo(()=>deserializeLabelProjection(props.initialLabelProjection),[props.initialLabelProjection]);
  const [projectionCache,setProjectionCache]=useState(()=>({
    worldState,
    mapProjection:createWorldMapRuntimeProjection(worldState,undefined,countryMapColorSeeds),
    labelProjection:initialLabelProjection,
  }));
  let currentProjectionCache=projectionCache;
  if(projectionCache.worldState!==worldState){
    currentProjectionCache={
      worldState,
      mapProjection:createWorldMapRuntimeProjection(worldState,projectionCache.mapProjection,countryMapColorSeeds),
      labelProjection:createLabelProjection(worldState,{}, {state:projectionCache.worldState,projection:projectionCache.labelProjection}),
    };
    setProjectionCache(currentProjectionCache);
  }
  const {mapProjection,labelProjection}=currentProjectionCache;
  const initializeSession=useGameSetupStore(state=>state.initializeSession);
  const setCountrySearchProjection=useGameSetupStore(state=>state.setCountrySearchProjection);
  const setCountryPanelProjection=useGameSetupStore(state=>state.setCountryPanelProjection);
  const countrySearchProjection=useGameSetupStore(state=>state.countrySearchProjection);
  const playerCountryId=useGameSetupStore(state=>state.playerCountryId);
  const sessionInitialized=useGameSetupStore(state=>state.sessionInitialized);
  const confirmPlayerCountry=useGameSetupStore(state=>state.confirmPlayerCountry);

  useEffect(()=>{
    setCountrySearchProjection(deserializeCountrySearchProjection(initialCountrySearchProjection));
    setCountryPanelProjection(deserializeCountryPanelProjection(initialCountryPanelProjection));
    initializeSession();
    const pendingPlayerCountryId=props.mode==="game"
      ?new URLSearchParams(window.location.hash.slice(1)).get("player")
      :null;
    if(props.mode==="game"&&pendingPlayerCountryId){
      confirmPlayerCountry(pendingPlayerCountryId);
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
    }
  },[confirmPlayerCountry,initialCountrySearchProjection,initialCountryPanelProjection,initializeSession,props.mode,setCountrySearchProjection,setCountryPanelProjection]);
  useEffect(()=>{if(worldState.revision===initialWorldState.revision)return;setCountrySearchProjection(createCountrySearchProjection(worldState));setCountryPanelProjection(createCountryPanelProjection(worldState,capitalProjection,panelPresentationEntries))},[worldState,capitalProjection,panelPresentationEntries,initialWorldState.revision,setCountrySearchProjection,setCountryPanelProjection]);
  useEffect(()=>{if(props.mode==="game"&&sessionInitialized&&playerCountryId===null)router.replace("/")},[playerCountryId,props.mode,router,sessionInitialized]);

  if(props.mode==="game"&&(!sessionInitialized||playerCountryId===null))return <div className="route-loading" role="status">국가 선택 화면으로 이동 중입니다.</div>;

  return <><div className="unsupported"><div><h1>지원하지 않는 화면 크기입니다</h1><p>Pax Local은 1280×720 이상의 PC 화면을 지원합니다.</p></div></div><div className="app-shell" data-page-mode={props.mode} data-world-schema-version={worldState.schemaVersion} data-world-revision={worldState.revision} data-world-country-count={worldState.countryOrder.length} data-world-territory-count={worldState.territoryOrder.length} data-world-topology-edge-count={Object.keys(worldState.topology.edgesById).length} data-world-countries-root={worldState.hashRoots.countriesRootHash}>{props.mode==="setup"?<><AppHeader/><main className="main"><WorldMap worldController={worldController} mapProjection={mapProjection} initialMarkerProjection={markerProjection} labelProjection={labelProjection}/><CountryPanel onPlayerConfirmed={(countryId)=>router.push(`/game#player=${encodeURIComponent(countryId)}`)}/></main><footer className="footer"><time dateTime={worldState.revision===0?"2020-01-01":undefined}>플레이 국가 선택</time><span>Map data: Natural Earth · 1:50m / 1:10m</span></footer></>:<GameScreen worldController={worldController} mapProjection={mapProjection} markerProjection={markerProjection} labelProjection={labelProjection} countrySearchProjection={countrySearchProjection} serializedSubdivisionCatalog={props.subdivisionCatalog}/>}</div></>;
}
