import {z} from "zod";

import type {SimulationContextV1} from "../simulation-context";
import {createTurnResolutionFunctionParametersSchema} from "../turn-resolution";
import type {CatalogRegionIndex} from '../catalog-region';
import {subdivisionReferenceSchema} from '../world-effect';

export type FunctionToolDefinition = Readonly<{
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
}>;

const objectSchema = (properties: Record<string, unknown>, required: readonly string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const stringId = {type: "string", minLength: 1, maxLength: 160};

export const READ_ONLY_SIMULATION_TOOL_NAMES = Object.freeze([
  "find_country",
  "inspect_country_territories",
  "list_country_subdivisions",
  "inspect_active_situation",
  "inspect_recent_events",
  "find_region",
  "resolve_region",
  "find_border_territories",
] as const);

export const createSimulationToolManifest = (): readonly FunctionToolDefinition[] => Object.freeze([
  {type:'function',name:'find_border_territories',description:'Find existing catalog territory IDs on the specified country side of its shared land border with a neighbor. Use for frontier/near-border descriptions such as the Korean armistice line. IDs are sorted and bounded; coastlines and interior cells are excluded. Countries are original source classifications, and current ownership/controller relations are validated at commit. This grants no authority. Choose a bounded subset or the returned frontier cells and describe that interpretation.',strict:true,parameters:objectSchema({countryId:stringId,neighborCountryId:stringId,cap:{type:'integer',minimum:1,maximum:512}},['countryId','neighborCountryId','cap'])},
  {type:'function',name:'find_region',description:'Read the complete approved server region index, including regions clipped from context. Ambiguous names return bounded candidates and no selection. sourceCountryId is original classification, not current ownership.',strict:true,parameters:objectSchema({countryId:stringId,query:{type:'string',minLength:1,maxLength:120}},['countryId','query'])},
  {type:'function',name:'resolve_region',description:'Resolve a verified canonical region reference to bounded territory IDs. This is read-only and grants no authority. Use the reference in regionRefs on territorial effects; authority scope and current ownership are validated separately.',strict:true,parameters:objectSchema({countryId:stringId,reference:objectSchema({catalogId:stringId,sourceVersion:stringId,subdivisionId:stringId},['catalogId','sourceVersion','subdivisionId']),operation:{type:'string',enum:['occupy','liberate','transfer']},cap:{type:'integer',minimum:1,maximum:512}},['countryId','reference','operation','cap'])},
  {type: "function", name: "find_country", description: "Find compact country records by Korean name, English name, or country ID.", strict: true, parameters: objectSchema({query: {type: "string", minLength: 1, maxLength: 120}}, ["query"])},
  {type: "function", name: "inspect_country_territories", description: "Inspect the bounded authoritative territory IDs currently owned by one country.", strict: true, parameters: objectSchema({countryId: stringId}, ["countryId"])},
  {type: "function", name: "list_country_subdivisions", description: "List trusted subdivision catalog summaries for one country; geometry is never returned.", strict: true, parameters: objectSchema({countryId: stringId}, ["countryId"])},
  {type: "function", name: "inspect_active_situation", description: "Inspect one active situation already present in the compact context.", strict: true, parameters: objectSchema({situationId: stringId}, ["situationId"])},
  {type: "function", name: "inspect_recent_events", description: "Inspect a bounded suffix of recent authoritative events.", strict: true, parameters: objectSchema({limit: {type: "integer", minimum: 1, maximum: 20}}, ["limit"])},
  {
    type: "function",
    name: "submit_turn_resolution",
    description: "Submit the complete adjudication for this turn. This is not a proposal or an administrative map command. Never guarantee a requested success. World effects require causal in-world events such as negotiation, treaty, war, referendum, or collapse.",
    strict: true,
    parameters: createTurnResolutionFunctionParametersSchema(),
  },
]);

const argumentSchemas = {
  find_border_territories:z.strictObject({countryId:z.string().min(1).max(160),neighborCountryId:z.string().min(1).max(160),cap:z.number().int().min(1).max(512)}),
  find_region:z.strictObject({countryId:z.string().min(1).max(160),query:z.string().min(1).max(120)}),
  resolve_region:z.strictObject({countryId:z.string().min(1).max(160),reference:subdivisionReferenceSchema,operation:z.enum(['occupy','liberate','transfer']),cap:z.number().int().min(1).max(512)}),
  find_country: z.strictObject({query: z.string().min(1).max(120)}),
  inspect_country_territories: z.strictObject({countryId: z.string().min(1).max(160)}),
  list_country_subdivisions: z.strictObject({countryId: z.string().min(1).max(160)}),
  inspect_active_situation: z.strictObject({situationId: z.string().min(1).max(160)}),
  inspect_recent_events: z.strictObject({limit: z.number().int().min(1).max(20)}),
} as const;

export type ReadOnlyToolName = keyof typeof argumentSchemas;

export function executeReadOnlySimulationTool(
  name: string,
  rawArguments: unknown,
  context: SimulationContextV1,
  regionIndex?:CatalogRegionIndex,
): unknown {
  if (!(name in argumentSchemas)) throw new Error(`UNKNOWN_TOOL:${name}`);
  const toolName = name as ReadOnlyToolName;
  const args = argumentSchemas[toolName].parse(rawArguments) as Record<string, unknown>;
  switch (toolName) {
    case 'find_border_territories': {
      if(!regionIndex?.borderTerritories)return {ok:false,code:'BORDER_LOOKUP_UNAVAILABLE'};
      if(![args.countryId,args.neighborCountryId].every(id=>context.countryDirectory.some(country=>country.countryId===id)))return {ok:false,code:'INACTIVE_BORDER_COUNTRY'};
      try {
        const territoryIds=regionIndex.borderTerritories(String(args.countryId),String(args.neighborCountryId),Number(args.cap));
        return {ok:true,countryId:args.countryId,neighborCountryId:args.neighborCountryId,catalogRef:regionIndex.catalogRef,territoryIds,
          effectTarget:{territoryIds,regionRefs:null},
          usage:'Copy effectTarget into the territorial effect. These are territory IDs, never subdivisionId values. Do not convert them into regionRefs.',
          regionNames:regionIndex.records.filter(region=>region.territoryIds.some(id=>territoryIds.includes(id))).map(region=>({nameKo:region.nameKo,nameEn:region.nameEn})),
          interpretation:'Existing cells touching the shared land border on countryId side; source classification is immutable, current ownership is checked separately'};
      } catch(error) {return {ok:false,code:error instanceof Error?error.message:'BORDER_LOOKUP_FAILED'};}
    }
    case 'find_region':{
      if(!regionIndex)throw Error('REGION_RESOLVER_UNAVAILABLE');
      const candidates=regionIndex.search(String(args.countryId),String(args.query)).map(({ref,parentCountryId,nameKo,nameEn})=>({ref,parentCountryId,nameKo,nameEn}));
      return candidates.length===1?{ok:true,region:candidates[0]}:{ok:false,code:candidates.length?'AMBIGUOUS_REGION':'UNKNOWN_REGION',candidates};
    }
    case 'resolve_region':
      if(!regionIndex)throw Error('REGION_RESOLVER_UNAVAILABLE');
      return regionIndex.resolve(String(args.countryId),subdivisionReferenceSchema.parse(args.reference),String(args.operation),Number(args.cap));
    case "find_country": {
      const query = String(args.query).toLocaleLowerCase("en-US");
      return context.countryDirectory.filter((country) =>
        [country.countryId, country.shortKo, country.english, ...country.searchAliases]
          .some((value) => value.toLocaleLowerCase("en-US").includes(query)));
    }
    case "inspect_country_territories":
      return context.territoryDirectory.find((entry) => entry.countryId === args.countryId) ?? null;
    case "list_country_subdivisions":
      if(regionIndex){const records=regionIndex.records.filter(r=>r.parentCountryId===args.countryId);return {regions:records.slice(0,128).map(({ref,parentCountryId,nameKo,nameEn})=>({ref,parentCountryId,nameKo,nameEn,materializable:true})),clipped:records.length>128};}
      return context.subdivisions.filter((entry) => entry.parentCountryId === args.countryId);
    case "inspect_active_situation":
      return context.situations.find((entry) =>
        typeof entry === "object" && entry !== null && "situationId" in entry
        && entry.situationId === args.situationId) ?? null;
    case "inspect_recent_events":
      return context.recentEvents.slice(-Number(args.limit));
  }
}
