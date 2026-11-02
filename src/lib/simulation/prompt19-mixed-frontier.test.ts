// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {createProductionOperationalGame} from '../world/operational-game.server';
import {prepareOperationalCatalog} from '../world/operational-catalog.server';
import {createTerritoryEntityV3} from '../world/territory-entity-v3';
import type {OperationalWorldView} from '../world/operational-catalog';
import {selectOperationalFrontier} from './operational-frontier.server';

describe('19-02 actual mixed Korea catalog',()=>{
  for(const [actor,target] of [['KOR','PRK'],['PRK','KOR']])it(`${actor} advances into part of ${target} and continues from current control`,()=>{
    const game=createProductionOperationalGame(actor),catalog=prepareOperationalCatalog();
    const world:OperationalWorldView={catalogRef:catalog.ref,revision:0,territoriesById:game.pair.world.territoriesById};
    const request={catalogRef:catalog.ref,baseWorldRevision:0,actorCountryId:actor,targetCountryId:target,operation:'occupy',extent:'near'};
    const first=selectOperationalFrontier(catalog,world,request);
    expect(first.cellIds.length).toBeGreaterThan(0);expect(first.cellIds.length).toBeLessThan(catalog.loadCountry(target).length);
    expect(first.metrics.maximumGraphDepthKm).toBeLessThanOrEqual(36);
    const advanced:OperationalWorldView={...world,revision:1,territoriesById:{...world.territoriesById,
      ...Object.fromEntries(first.cellIds.map(id=>[id,createTerritoryEntityV3({...world.territoriesById[id],controllerCountryId:actor})]))}};
    for(const id of first.cellIds)expect(advanced.territoriesById[id]).toMatchObject({sourceCountryId:target,ownerCountryId:target,controllerCountryId:actor});
    for(const p of new Set(first.cellIds.map(id=>catalog.cell(id).administrativeOrdinal))){
      const parent=catalog.administrativeParents[p-1],members=catalog.administrativeMembership(parent.parentKey);
      expect(members.some(c=>!first.cellIds.includes(c.id)&&advanced.territoriesById[c.id].controllerCountryId===target)).toBe(true);
    }
    const next=selectOperationalFrontier(catalog,advanced,{...request,baseWorldRevision:1});
    expect(next.frontier.kind).toBe('current-controller');expect(first.cellIds).toContain(next.frontier.supportCellId);
    expect(next.cellIds.every(id=>!first.cellIds.includes(id))).toBe(true);
    for(const c of catalog.loadCountry('USA'))expect(advanced.territoriesById[c.id]).toBe(world.territoriesById[c.id]);
    expect(()=>selectOperationalFrontier(catalog,advanced,request)).toThrow('STALE_WORLD_REVISION');
    if(first.cellIds.length>1)expect(()=>selectOperationalFrontier(catalog,world,{...request,cap:1})).toThrow('FRONTIER_REQUEST_CAP');
    else expect(selectOperationalFrontier(catalog,world,{...request,cap:1}).cellIds).toEqual(first.cellIds);
    console.log(JSON.stringify({actor,target,first:first.cellIds.length,next:next.cellIds.length,firstAreaKm2:first.metrics.areaKm2,nextAreaKm2:next.metrics.areaKm2}));
  });
});
