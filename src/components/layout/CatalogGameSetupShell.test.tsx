import fs from 'node:fs';import {useMemo} from 'react';import {useStore} from 'zustand';import {beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';import {act,render,screen,waitFor,fireEvent} from '@testing-library/react';
import {CatalogGameSetupShell} from './CatalogGameSetupShell';import {useGameSetupStore} from '@/stores/game-setup-store';import {prepareProductionCatalogSeed} from '@/lib/world/production-catalog-seed.server';import {readCatalogConsumerMetadata,type CatalogConsumerBootstrap,type CatalogConsumerMetadata} from '@/lib/map/catalog-consumer-contract';import {catalogContractForConsumer} from '@/lib/projection/catalog-map-consumer-projection';
import {readCatalogRuntimePair,type CatalogRuntime} from '@/lib/simulation/catalog-runtime';import {createCatalogTurnPlan} from '@/lib/simulation/catalog-turn-plan';import {useCatalogSimulationTurnController} from '@/lib/simulation/client/use-catalog-simulation-turn-controller';
const mocks=vi.hoisted(()=>({replace:vi.fn(),load:vi.fn(),create:vi.fn(),sync:vi.fn()}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:mocks.replace,push:vi.fn()})}));
vi.mock('@/lib/map/catalog-vector-delivery',()=>({loadCatalogVectorDelivery:mocks.load}));
vi.mock('@/lib/simulation/catalog-runtime',async importActual=>({...await importActual<object>(),createCatalogRuntime:mocks.create}));
vi.mock('../game/CatalogGameScreen',()=>({CatalogGameScreen:(props:Parameters<typeof Harness>[0])=><Harness {...props}/>}));
vi.mock('../map/CatalogWorldMap',()=>({CatalogWorldMap:()=>null}));
vi.mock('../country/CountryPanel',()=>({CountryPanel:()=>null}));
vi.mock('./AppHeader',()=>({AppHeader:()=>null}));
let bootstrap:CatalogConsumerBootstrap,metadata:CatalogConsumerMetadata,serializedPair:string,catalog:ReturnType<typeof catalogContractForConsumer>,runtime:CatalogRuntime;
function Harness({worldController,delivery,mapProjection}:{worldController:CatalogRuntime;delivery:{metadata:CatalogConsumerMetadata};mapProjection:ReturnType<ReturnType<typeof import('@/lib/projection/catalog-color-projection').createCatalogProjectionUpdater>>}){
  const player=useGameSetupStore(s=>s.playerCountryId),sync=useGameSetupStore(s=>s.syncSimulationPlayerCountry),pair=useStore(worldController.store,s=>s);
  const controller=useCatalogSimulationTurnController({runtime:worldController,metadata:delivery.metadata,countrySearchProjection:mapProjection.search,playerCountryId:player,syncPlayerCountry:id=>{mocks.sync(id);sync(id);}});
  const countries=useMemo(()=>mapProjection.ownedByCountry[player??'']??[],[mapProjection,player]);
  return <><output data-testid="player">{player}:{pair.simulation.playerCountryId}:{countries.length}</output><button onClick={controller.undo}>undo</button><button onClick={controller.redo}>redo</button></>;
}
beforeAll(()=>{const p=prepareProductionCatalogSeed();bootstrap=p.bootstrap;serializedPair=p.serializedPair;metadata=readCatalogConsumerMetadata(JSON.parse(fs.readFileSync(`public${bootstrap.metadata.path}`,'utf8')),bootstrap.catalogRef);catalog=catalogContractForConsumer(metadata);});
beforeEach(()=>{useGameSetupStore.getState().resetGameSetup();window.location.hash='#player=HUN';mocks.replace.mockClear();mocks.sync.mockClear();mocks.load.mockResolvedValue({metadata});});
async function mount(){const actual=await vi.importActual<typeof import('@/lib/simulation/catalog-runtime')>('@/lib/simulation/catalog-runtime');runtime=actual.createCatalogRuntime(readCatalogRuntimePair(serializedPair,catalog),catalog);mocks.create.mockReturnValue(runtime);render(<CatalogGameSetupShell mode="game" bootstrap={bootstrap} serializedPair={serializedPair}/>);await waitFor(()=>expect(screen.getByTestId('player').textContent).toMatch(/^HUN:HUN:/));return runtime;}
function merge(){const p=runtime.getSnapshot(),id='event.merge';return createCatalogTurnPlan({...p,catalog,turnId:'turn.player-merge',resolution:{contractVersion:'turn-resolution.v1',baseSimulationRevision:p.simulation.revision,baseWorldRevision:p.world.revision,period:{startDate:'2020-01-01',endDate:'2020-01-02'},playerActionOutcomes:[],events:[{eventId:id,date:'2020-01-02',title:'합병',publicNarrative:'합병 결과',actorCountryIds:['AUT','HUN'],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'treaty',significance:'minor'}],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects:[],advisorSummary:'검증',unresolvedQuestions:[]}});}
describe('catalog player initialization and client history synchronization',()=>{
  it('uses URL only once and synchronizes HUN → AUT → HUN → AUT through actual client undo/redo',async()=>{
    await mount();const p=runtime.getSnapshot();
    const ground={eventId:'event.ground',date:'2020-01-02',title:'협상',publicNarrative:'합병 협상',actorCountryIds:['AUT','HUN'],relatedFactIds:[],relatedSituationIds:[],causes:[],outcomeCategory:'treaty',significance:'minor'};
    const base=merge().resolution;
    act(()=>runtime.commit(createCatalogTurnPlan({...p,catalog,turnId:'turn.ground',resolution:{...base,events:[ground]}})));
    const current=runtime.getSnapshot();act(()=>runtime.commit(createCatalogTurnPlan({...current,catalog,turnId:'turn.merge',resolution:{...base,baseSimulationRevision:current.simulation.revision,baseWorldRevision:current.world.revision,period:{startDate:'2020-01-02',endDate:'2020-01-03'},events:[{...ground,eventId:'event.merge',date:'2020-01-03',causes:[{kind:'authoritative-event',id:'event.ground'}]}],worldEffects:[{effectId:'effect.merge',type:'countries.merged',causedByEventId:'event.merge',initiatorCountryId:'AUT',absorbedCountryIds:['HUN']}]}})));
    await waitFor(()=>expect(screen.getByTestId('player').textContent).toMatch(/^AUT:AUT:/));expect(window.location.hash).toBe('');
    fireEvent.click(screen.getByText('undo'));await waitFor(()=>expect(screen.getByTestId('player').textContent).toMatch(/^HUN:HUN:/));expect(mocks.sync).toHaveBeenLastCalledWith('HUN');expect(runtime.isFreshSeed()).toBe(false);expect(()=>runtime.selectPlayer('AUT')).toThrow(/fresh seed/);
    fireEvent.click(screen.getByText('redo'));await waitFor(()=>expect(screen.getByTestId('player').textContent).toMatch(/^AUT:AUT:/));expect(mocks.sync).toHaveBeenLastCalledWith('AUT');expect(mocks.replace).not.toHaveBeenCalled();
  });
  it('retains ordinary narrative undo/redo without reapplying a changed hash',async()=>{
    await mount();act(()=>runtime.commit(merge()));window.location.hash='#player=AUT';fireEvent.click(screen.getByText('undo'));await waitFor(()=>expect(screen.getByTestId('player').textContent).toMatch(/^HUN:HUN:/));fireEvent.click(screen.getByText('redo'));await waitFor(()=>expect(screen.getByTestId('player').textContent).toMatch(/^HUN:HUN:/));expect(mocks.replace).not.toHaveBeenCalled();
  });
});
