import type {WorldStateV3} from '../world/world-state-v3';
import type {SimulationStateV2,TerritorialControlAuthority} from './simulation-state-v2';
import type {SimulationEventV1} from './simulation-event';
import {sha256Hex} from '../world/sha256';
export type CountrySuccessors=Readonly<Record<string,string|null>>;
export function catalogLifecycleEvent(input:{turnId:string;date:string;actorIds:readonly string[];sourceEventId:string;authority?:NonNullable<SimulationEventV1['authorityLifecycle']>;reference?:NonNullable<SimulationEventV1['referenceLifecycle']>}):SimulationEventV1{
  const detail=input.authority??input.reference!,key=JSON.stringify(detail);
  const authorityText={granted:'검증된 범위의 국가 변경 권한이 등록되었습니다.',expired:'국가 변경 권한의 유효기간이 끝났습니다.',rewritten:'국가 승계에 따라 변경 권한이 조정되었습니다.',invalidated:'변경된 국가 관계에서 적용할 수 없는 권한이 종료되었습니다.'};
  const referenceText={rewritten:'국가 승계에 따라 진행 중인 기록의 참여국이 조정되었습니다.',ended:'합병 또는 해체로 더 이상 유효하지 않은 국가 간 관계가 종료되었습니다.',cancelled:'참여국 변경으로 진행할 수 없는 후속 행동이 취소되었습니다.'};
  return {eventId:`lifecycle.${sha256Hex(new TextEncoder().encode(`${input.turnId}:${input.date}:${key}`)).slice(0,40)}`,date:input.date,title:input.authority?'국가 변경 권한':'국가 관계 변경',publicNarrative:input.authority?authorityText[input.authority.operation]:referenceText[input.reference!.operation],
    actorCountryIds:[...new Set(input.actorIds)].sort(),relatedFactIds:[],relatedSituationIds:[],causes:[{kind:'authoritative-event',id:input.sourceEventId}],outcomeCategory:'other',significance:'minor',...(input.authority?{authorityLifecycle:input.authority}:{referenceLifecycle:input.reference})};
}
export function territorialAuthorityScopeValid(a:TerritorialControlAuthority,world:WorldStateV3):boolean{
  return a.allowedTerritoryIds.every(id=>{const t=world.territoriesById[id];if(!t)return false;
    return a.allowedOperations.every(op=>op==='occupy'?t.ownerCountryId===a.targetCountryId&&t.ownerCountryId!==a.actorCountryId:
      op==='liberate'?t.ownerCountryId!==null&&t.controllerCountryId===a.targetCountryId&&t.ownerCountryId!==t.controllerCountryId&&a.actorCountryId!==t.controllerCountryId:
      t.ownerCountryId===a.actorCountryId&&a.targetCountryId!==null&&a.targetCountryId!==a.actorCountryId);
  });
}
export function reconcileCatalogSimulation(input:{simulation:SimulationStateV2;world:WorldStateV3;successors:CountrySuccessors;date:string;turnId:string}){
  const {simulation:s,world:w,successors,date,turnId}=input,events:SimulationEventV1[]=[];
  const successor=(id:string):string|null=>{const seen=new Set<string>();while(Object.hasOwn(successors,id)){if(seen.has(id))throw Error('CYCLIC_SUCCESSOR');seen.add(id);const next=successors[id];if(next===null)return null;id=next;}return Object.hasOwn(w.countriesById,id)?id:null;};
  const player=successor(s.playerCountryId);if(!player)throw Error('PLAYER_WITHOUT_SUCCESSOR');
  const actors=(ids:readonly string[])=>[...new Set(ids.map(successor).filter((id):id is string=>id!==null))].sort();
  const refEvent=(id:string,kind:NonNullable<SimulationEventV1['referenceLifecycle']>['kind'],operation:NonNullable<SimulationEventV1['referenceLifecycle']>['operation'],reason:NonNullable<SimulationEventV1['referenceLifecycle']>['reason'],ids:readonly string[],source:string)=>events.push(catalogLifecycleEvent({turnId,date,actorIds:ids.length?ids:[player],sourceEventId:source,reference:{referenceId:id,kind,operation,reason}}));
  const queuedActions=s.queuedActions.map(a=>{if(a.status!=='queued'&&a.status!=='resolving')return a;const id=successor(a.actorCountryId);if(id===a.actorCountryId)return a;
    const safe=id===player;refEvent(a.actionId,'queued-action',safe?'rewritten':'cancelled',safe?'country-successor':'retired-actor',[a.actorCountryId],s.eventLog.at(-1)!.eventId);return {...a,actorCountryId:safe?id!:a.actorCountryId,status:safe?a.status:'cancelled' as const};});
  const factsById={...s.factsById};for(const [id,f]of Object.entries(factsById)){if(f.status!=='active')continue;const ids=actors(f.actorCountryIds);if(JSON.stringify(ids)===JSON.stringify([...f.actorCountryIds].sort()))continue;
    const ended=!ids.length||(f.actorCountryIds.length>1&&ids.length<2&&['diplomatic-relation','treaty-or-negotiation','conflict-or-war','military-or-occupation'].includes(f.kind));
    refEvent(id,'fact',ended?'ended':'rewritten',ended?'collapsed-relation':'country-successor',f.actorCountryIds,f.sourceEventId);factsById[id]=ended?{...f,status:'ended'}:{...f,actorCountryIds:ids};}
  const situationsById={...s.situationsById};for(const [id,v]of Object.entries(situationsById)){if(v.status!=='active')continue;const ids=actors(v.participantCountryIds);if(JSON.stringify(ids)===JSON.stringify([...v.participantCountryIds].sort()))continue;
    const ended=!ids.length||(v.participantCountryIds.length>1&&ids.length<2);refEvent(id,'situation',ended?'ended':'rewritten',ended?'collapsed-relation':'country-successor',v.participantCountryIds,v.lastUpdatedByEventId);situationsById[id]=ended?{...v,status:'resolved'}:{...v,participantCountryIds:ids};}
  const scheduledConsequences=s.scheduledConsequences.map(c=>{if(c.status!=='scheduled'&&c.status!=='due')return c;const ids=actors(c.actorCountryIds);if(JSON.stringify(ids)===JSON.stringify([...c.actorCountryIds].sort()))return c;
    const cancelled=!ids.length||(c.actorCountryIds.length>1&&ids.length<2);refEvent(c.consequenceId,'consequence',cancelled?'cancelled':'rewritten',cancelled?'collapsed-relation':'country-successor',c.actorCountryIds,c.sourceEventId);return cancelled?{...c,status:'cancelled' as const}:{...c,actorCountryIds:ids};});
  const territorial={...s.territorialControlAuthoritiesById},presentation={...s.countryPresentationAuthoritiesById};
  for(const record of [territorial,presentation])for(const [id,a]of Object.entries(record)){
    const actor=successor(a.actorCountryId),target=a.targetCountryId===null?null:successor(a.targetCountryId),rewritten=actor!==a.actorCountryId||target!==a.targetCountryId;
    let reason:NonNullable<SimulationEventV1['authorityLifecycle']>['reason']|null=null;
    if(a.validTo!==null&&date>a.validTo)reason='date-expired';else if(!actor||(a.targetCountryId!==null&&!target))reason='no-successor';else if(rewritten&&actor===target)reason='self-reference';
    const next={...a,actorCountryId:actor!,targetCountryId:target};
    if(!reason&&'allowedTerritoryIds'in next&&!territorialAuthorityScopeValid(next,w))reason='operation-scope-invalid';
    if(reason){delete record[id];}else if(rewritten){Object.assign(record,{[id]:next});}
    if(reason||rewritten)events.push(catalogLifecycleEvent({turnId,date,actorIds:[a.actorCountryId,...(a.targetCountryId?[a.targetCountryId]:[])],sourceEventId:a.sourceEventId,authority:{authorityId:id,operation:reason?(reason==='date-expired'?'expired':'invalidated'):'rewritten',reason:reason??'country-successor',previousActorCountryId:a.actorCountryId,previousTargetCountryId:a.targetCountryId}}));
  }
  return {...s,currentDate:date,playerCountryId:player,queuedActions,factsById,situationsById,scheduledConsequences,territorialControlAuthoritiesById:territorial,territorialControlAuthorityOrder:Object.keys(territorial).sort(),countryPresentationAuthoritiesById:presentation,countryPresentationAuthorityOrder:Object.keys(presentation).sort(),eventLog:[...s.eventLog,...events].sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0)};
}
