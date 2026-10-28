import {OpenAIResponsesSimulationProvider} from '../simulation/server/openai-responses-provider';
import type {SimulationContextV1} from '../simulation/simulation-context';
import type {OpenAIResponsesRequest} from '../simulation/server/openai-responses-transport';
import {OPERATIONAL_CATALOG_VERSION} from '../world/operational-catalog';
const events=(name:string,args:unknown,n:number)=>{const item={type:'function_call',call_id:`fixture.${n}`,name,arguments:JSON.stringify(args)};return [{type:'response.output_item.added',item:{...item,arguments:''}},{type:'response.function_call_arguments.done',call_id:item.call_id,arguments:item.arguments},{type:'response.output_item.done',item},{type:'response.completed',response:{id:`fixture.response.${n}`}}];};
/** Compiled only through explicit development/E2E aliases. Replaces model responses, never host validation. */
export function createProductionSimulationProvider(){
 let n=0;
 const transport={async *stream(request:OpenAIResponsesRequest){
   n++;const input=request.input as {role?:string;content?:{text:string}[];type?:string;call_id?:string;output?:string}[];
   const context=JSON.parse(input.find(i=>i.role==='user')!.content![0].text).data as SimulationContextV1;
   if(context.regionCatalog?.catalogVersion===OPERATIONAL_CATALOG_VERSION){
     const action=context.queuedActions[0];
     if(!action?.text.startsWith('[DEBUG_WORLD_EFFECT]'))throw Error('SCRIPTED_DEBUG_ACTION_REQUIRED');
     if(n===1){
       for(const event of events('find_frontier_territories',{actorCountryId:context.playerCountry.countryId,targetCountryId:'PRK',operation:'occupy',extent:'near',direction:null,reference:null,regionQuery:null,cap:512},n))yield event;
       return;
     }
     const output=input.find(i=>i.type==='function_call_output'&&i.call_id==='fixture.1');
     const found=output?.output?JSON.parse(output.output).data:null;
     if(!found?.ok||!found.effectTarget)throw Error('SCRIPTED_FRONTIER_LOOKUP_FAILED');
     const eventId=`event.frontier.${context.revisions.simulation}`;
     const event={eventId,date:context.period.endDate,title:'접경 일부 점령',publicNarrative:'현재 육상 전선에 인접한 제한된 범위를 점령했습니다.',actorCountryIds:[context.playerCountry.countryId,'PRK'],relatedFactIds:[],relatedSituationIds:[],causes:[{kind:'queued-action',id:action.actionId}],outcomeCategory:'military',significance:'notable'};
     const resolution={contractVersion:'turn-resolution.v1',baseSimulationRevision:context.revisions.simulation,baseWorldRevision:context.revisions.world,period:context.period,
       playerActionOutcomes:[{outcomeId:`outcome.frontier.${context.revisions.simulation}`,actionId:action.actionId,status:'succeeded',evidenceEventId:eventId,summary:'접경 일부 점령',remainingConditions:[]}],events:[event],factMutations:[],situationMutations:[],scheduledConsequences:[],
       worldEffects:[{effectId:`effect.frontier.${context.revisions.simulation}`,type:'territory.occupy',causedByEventId:eventId,actorCountryId:context.playerCountry.countryId,targetCountryId:'PRK',authorityId:'tca:debug',...found.effectTarget}],advisorSummary:'개발용 scripted provider로 실제 catalog의 부분 점령을 확인했습니다.',unresolvedQuestions:[]};
     for(const event of events('submit_turn_resolution',resolution,n))yield event;
     return;
   }
   const action=context.queuedActions[0];if(!action?.text.startsWith('E2E REGION '))throw Error('E2E_FIXTURE_ACTION_REQUIRED');
   const occupying=action.text.includes('OCCUPY'),coloring=action.text.includes('COLOR');
   let name='submit_turn_resolution',args:unknown;
   if(occupying&&n===1){name='find_region';args={countryId:'CHN',query:'Guangdong'};}
   else if(occupying&&n===2){const found=JSON.parse(input.find(i=>i.type==='function_call_output'&&i.call_id==='fixture.1')!.output!).data;
     if(!found.ok)throw Error('LOOKUP_FAILED');name='resolve_region';args={countryId:'CHN',reference:found.region.ref,operation:'occupy',cap:512};
   }else{
     const eventId=coloring?'event.region.color':occupying?'event.region.occupation':'event.region.treaty';
     const event={eventId,date:context.period.endDate,title:coloring?'White presentation':occupying?'Guangdong operation':'Bounded occupation treaty',publicNarrative:'A bounded regional agreement is implemented.',actorCountryIds:coloring?['KOR']:['CHN','KOR'],relatedFactIds:[],relatedSituationIds:[],causes:[{kind:occupying?'authoritative-event':'queued-action',id:occupying?'event.region.treaty':action.actionId}],outcomeCategory:coloring?'domestic':'treaty',significance:'notable'};
     const worldEffects:unknown[]=[];
     if(coloring)worldEffects.push({effectId:'effect.region.color',type:'country.chooseMapColor',causedByEventId:eventId,requestedMapColor:'#FFFFFF',authority:{id:'cpa:e2e-region',actorCountryId:'KOR',targetCountryId:'KOR',validFrom:event.date,validTo:null,sourceEventId:eventId}});
     if(occupying){const region=JSON.parse(input.find(i=>i.type==='function_call_output'&&i.call_id==='fixture.2')!.output!).data;
       worldEffects.push({effectId:'effect.region.grant',type:'territorialAuthority.granted',causedByEventId:eventId,authority:{id:'tca:e2e-region',actorCountryId:'KOR',targetCountryId:'CHN',allowedTerritoryIds:region.territoryIds,allowedOperations:['occupy'],validFrom:event.date,validTo:null,sourceEventId:eventId}},
         {effectId:'effect.region.occupy',type:'territory.occupy',causedByEventId:eventId,actorCountryId:'KOR',targetCountryId:'CHN',authorityId:'tca:e2e-region',territoryIds:[],regionRefs:[{countryId:'CHN',reference:region.ref}]});
     }
     args={contractVersion:'turn-resolution.v1',baseSimulationRevision:context.revisions.simulation,baseWorldRevision:context.revisions.world,period:context.period,playerActionOutcomes:[{outcomeId:`outcome.region.${context.revisions.simulation}`,actionId:action.actionId,status:'succeeded',evidenceEventId:eventId,summary:'Agreement implemented',remainingConditions:[]}],events:[event],factMutations:[],situationMutations:[],scheduledConsequences:[],worldEffects,advisorSummary:'Bounded named-region fixture',unresolvedQuestions:[]};
   }for(const event of events(name,args,n))yield event;
 }};
 return new OpenAIResponsesSimulationProvider({apiKey:'fixture',model:'fixture',timeoutMs:120000,maxRetries:0,maxToolIterations:4,maxToolCalls:8,debugMode:process.env.NODE_ENV!=='production'&&process.env.PAX_OPERATIONAL_SMOKE==='1'},transport);
}
