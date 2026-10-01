import {z} from "zod";

import type {SimulationContextV1} from "../simulation-context";
import {createTurnResolutionFunctionParametersSchema} from "../turn-resolution";

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
] as const);

export const createSimulationToolManifest = (): readonly FunctionToolDefinition[] => Object.freeze([
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
): unknown {
  if (!(name in argumentSchemas)) throw new Error(`UNKNOWN_TOOL:${name}`);
  const toolName = name as ReadOnlyToolName;
  const args = argumentSchemas[toolName].parse(rawArguments) as Record<string, unknown>;
  switch (toolName) {
    case "find_country": {
      const query = String(args.query).toLocaleLowerCase("en-US");
      return context.countryDirectory.filter((country) =>
        [country.countryId, country.shortKo, country.english, ...country.searchAliases]
          .some((value) => value.toLocaleLowerCase("en-US").includes(query)));
    }
    case "inspect_country_territories":
      return context.territoryDirectory.find((entry) => entry.countryId === args.countryId) ?? null;
    case "list_country_subdivisions":
      return context.subdivisions.filter((entry) => entry.parentCountryId === args.countryId);
    case "inspect_active_situation":
      return context.situations.find((entry) =>
        typeof entry === "object" && entry !== null && "situationId" in entry
        && entry.situationId === args.situationId) ?? null;
    case "inspect_recent_events":
      return context.recentEvents.slice(-Number(args.limit));
  }
}
