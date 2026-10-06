'use client';
import {useEffect,useMemo,useRef,useState} from 'react';
import {useStore} from 'zustand';
import {useRouter} from 'next/navigation';
import {AppHeader} from './AppHeader';
import {CountryPanel} from '../country/CountryPanel';
import {CatalogWorldMap} from '../map/CatalogWorldMap';
import {CatalogGameScreen} from '../game/CatalogGameScreen';
import {useGameSetupStore} from '@/stores/game-setup-store';
import {createCatalogRuntime,readCatalogRuntimePair,type CatalogRuntime} from '@/lib/simulation/catalog-runtime';
import {catalogContractForConsumer} from '@/lib/projection/catalog-map-consumer-projection';
import {createCatalogProjectionUpdater} from '@/lib/projection/catalog-color-projection';
import {loadCatalogVectorDelivery,type CatalogVectorDelivery} from '@/lib/map/catalog-vector-delivery';
import type {CatalogConsumerBootstrap} from '@/lib/map/catalog-consumer-contract';
export function CatalogGameSetupShell(props:{mode:'setup'|'game';bootstrap:CatalogConsumerBootstrap;serializedPair:string}){
  const [ready,setReady]=useState<{delivery:CatalogVectorDelivery;runtime:CatalogRuntime}|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{
    const abort=new AbortController();
    void loadCatalogVectorDelivery(props.bootstrap,props.bootstrap.catalogRef,fetch,abort.signal).then(delivery=>{
      if(abort.signal.aborted)return;const catalog=catalogContractForConsumer(delivery.metadata),seed=readCatalogRuntimePair(props.serializedPair,catalog);
      setReady({delivery,runtime:createCatalogRuntime(seed,catalog)});
    }).catch(()=>{if(!abort.signal.aborted)setFailed(true);});
    return()=>abort.abort();
  },[props.bootstrap,props.serializedPair]);
  if(failed)return <main className="route-loading" role="alert">지도와 시뮬레이션 데이터를 불러올 수 없습니다. 새로고침 후 다시 시도하세요.</main>;
  if(!ready)return <main className="route-loading" role="status">세계 데이터를 불러오는 중입니다.</main>;
  return <ReadyCatalogShell mode={props.mode} {...ready}/>;
}
function ReadyCatalogShell({mode,delivery,runtime}:{mode:'setup'|'game';delivery:CatalogVectorDelivery;runtime:CatalogRuntime}){
  const router=useRouter(),pair=useStore(runtime.store,s=>s),player=useGameSetupStore(s=>s.playerCountryId);
  const project=useMemo(()=>createCatalogProjectionUpdater(delivery.metadata),[delivery.metadata]);
  const projection=useMemo(()=>project(pair.world),[project,pair.world]);
  const initializedPlayer=useRef<CatalogRuntime|null>(null);
  useEffect(()=>{
    const store=useGameSetupStore.getState();store.setCountrySearchProjection(projection.search);store.setCountryPanelProjection(projection.panel);store.initializeSession();
    if(mode==='game'&&initializedPlayer.current===runtime)store.syncSimulationPlayerCountry(runtime.getSnapshot().simulation.playerCountryId);
  },[mode,projection,runtime]);
  useEffect(()=>{
    if(mode!=='game'||initializedPlayer.current===runtime)return;initializedPlayer.current=runtime;
    const store=useGameSetupStore.getState();
    if(runtime.isFreshSeed()){
      const pending=new URLSearchParams(window.location.hash.slice(1)).get('player');if(pending){store.confirmPlayerCountry(pending);window.history.replaceState(null,'',window.location.pathname+window.location.search);}
      const selected=useGameSetupStore.getState().playerCountryId;if(!selected){router.replace('/');return;}
      if(runtime.getSnapshot().simulation.playerCountryId!==selected)runtime.selectPlayer(selected);
    }
    store.syncSimulationPlayerCountry(runtime.getSnapshot().simulation.playerCountryId);
  },[mode,runtime,router]);
  if(mode==='game'&&(!player||pair.simulation.playerCountryId!==player))return <div className="route-loading" role="status">플레이 국가를 준비하고 있습니다.</div>;
  return <><div className="unsupported"><div><h1>지원하지 않는 화면 크기입니다</h1><p>Pax Local은 1280×720 이상의 PC 화면을 지원합니다.</p></div></div>
    <div className="app-shell" data-page-mode={mode} data-world-schema-version={pair.world.schemaVersion} data-simulation-schema-version={pair.simulation.schemaVersion} data-world-revision={pair.world.revision}
      data-world-country-count={pair.world.countryOrder.length} data-world-territory-count={pair.world.territoryOrder.length} data-catalog-version={pair.world.catalogRef.catalogVersion} data-world-geometry-root={pair.world.catalogRef.geometryRoot} data-current-date={pair.simulation.currentDate}>
      {mode==='setup'?<><AppHeader/><main className="main"><CatalogWorldMap runtime={runtime} delivery={delivery} mapProjection={projection}/><CountryPanel onPlayerConfirmed={id=>{runtime.selectPlayer(id);router.push(`/game#player=${encodeURIComponent(id)}`);}}/></main>
        <footer className="footer"><time dateTime="2020-01-01">플레이 국가 선택</time><span>Map data: Natural Earth</span></footer></>:<CatalogGameScreen worldController={runtime} delivery={delivery} mapProjection={projection} countrySearchProjection={projection.search}/>}</div></>;
}
