import {parseTerritorialControlCommand,type TerritorialControlCommand} from '../commands/territorial-control-v3';
import {MAX_COMMANDS_PER_BATCH} from '../commands/command-batch-v2';
import {createSimulationStateV2,isAuthorityActiveAt,type SimulationStateV2} from '../simulation/simulation-state-v2';
import {createTerritoryEntityV3,type TerritoryEntityV3} from '../world/territory-entity-v3';
import type {WorldStateV3} from '../world/world-state-v3';
import {assertSafeSimulationData,isoCalendarDateSchema} from '../simulation/simulation-contract-primitives';
import {allowsDevelopmentWorldEffect} from '../simulation/debug-world-effect';
export type TerritorialControlAggregateEffect=Readonly<{commandId:string;type:TerritorialControlCommand['type'];actorCountryId:string;authorityId:string;
  changes:readonly Readonly<{before:TerritoryEntityV3;after:TerritoryEntityV3}>[]}>;
export function planTerritorialControl(input:{world:WorldStateV3;simulation:SimulationStateV2;command:unknown;date?:string;debugDirective?:boolean}):TerritorialControlAggregateEffect{
  assertSafeSimulationData(input.command);const c=parseTerritorialControlCommand(input.command),p=c.payload,date=isoCalendarDateSchema.parse(input.date??input.simulation.currentDate);
  createSimulationStateV2(input.simulation,input.world);
  if(c.expectedRevision!==input.world.revision||p.expectedSimulationRevision!==input.simulation.revision)throw Error('STALE_REVISION');
  if(date<input.simulation.currentDate)throw Error('INVALID_OPERATION_DATE');
  for(const id of [p.actorCountryId,p.targetCountryId,c.type==='territory.transferOwnership'?c.payload.newOwnerCountryId:null])if(id!==null&&!Object.hasOwn(input.world.countriesById,id))throw Error('INACTIVE_COUNTRY');
  const authority=input.simulation.territorialControlAuthoritiesById[p.authorityId],operation=c.type==='territory.occupy'?'occupy':c.type==='territory.liberate'?'liberate':'transfer';
  if(authority?(!isAuthorityActiveAt(authority,date)||authority.actorCountryId!==p.actorCountryId||authority.targetCountryId!==p.targetCountryId||!authority.allowedOperations.includes(operation)):!allowsDevelopmentWorldEffect(input.debugDirective===true))throw Error('INVALID_AUTHORITY');
  const scope=authority?new Set(authority.allowedTerritoryIds):null;
  const changes=p.territoryIds.map(id=>{
    const before=input.world.territoriesById[id];if(!before||(scope&&!scope.has(id)))throw Error('INVALID_AUTHORITY_SCOPE');
    let owner=before.ownerCountryId,controller=before.controllerCountryId;
    if(c.type==='territory.occupy'){
      if(p.targetCountryId!==owner||p.actorCountryId===owner||p.actorCountryId===controller)throw Error('INVALID_OCCUPATION_RELATION');controller=p.actorCountryId as typeof controller;
    }else if(c.type==='territory.liberate'){
      if(owner===null)throw Error('NULL_OWNER_LIBERATION');
      if(p.targetCountryId!==controller||controller===owner||p.actorCountryId===controller)throw Error('INVALID_LIBERATION_RELATION');controller=owner;
    }else{
      if(p.actorCountryId!==owner||p.targetCountryId!==c.payload.newOwnerCountryId||owner===c.payload.newOwnerCountryId)throw Error('INVALID_TRANSFER_RELATION');
      owner=c.payload.newOwnerCountryId as typeof owner;if(c.payload.controllerPolicy==='new-owner')controller=owner;
    }
    return Object.freeze({before,after:createTerritoryEntityV3({...before,ownerCountryId:owner,controllerCountryId:controller})});
  });
  return Object.freeze({commandId:c.commandId,type:c.type,actorCountryId:p.actorCountryId,authorityId:p.authorityId,changes:Object.freeze(changes)});
}
/** Sequential aggregate plans stay within the existing command cap and never publish intermediate state. */
export function planTerritorialControlBatch(input:{world:WorldStateV3;simulation:SimulationStateV2;commands:readonly unknown[];date?:string}){
  if(!input.commands.length||input.commands.length>MAX_COMMANDS_PER_BATCH)throw Error('COMMAND_BATCH_CAP');
  const ids=new Set<string>(),territories={...input.world.territoriesById},effects:TerritorialControlAggregateEffect[]=[];
  for(const command of input.commands){const effect=planTerritorialControl({...input,world:{...input.world,territoriesById:territories},command});
    if(ids.has(effect.commandId))throw Error('DUPLICATE_COMMAND_ID');ids.add(effect.commandId);effects.push(effect);for(const change of effect.changes)territories[change.after.id]=change.after;
  }
  return Object.freeze({effects:Object.freeze(effects),territoriesById:Object.freeze(territories),affectedTerritoryIds:Object.freeze([...new Set(effects.flatMap(e=>e.changes.map(c=>c.after.id)))].sort())});
}
