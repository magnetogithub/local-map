import {describe, expect, it} from "vitest";

import {createSimulationTurnPost} from "./simulation-turn-handler";
import {createCountrySearchProjection} from "../../projection/country-search-index-patch";
import {createProductionInitialWorldStateV2} from "../../world/initial-world-state-v2";
import {createInitialSimulationState} from "../initial-simulation-state";
import {loadProductionSubdivisionCatalog} from "../production-subdivision-catalog.server";
import {createResolvedTurnPlan} from "../resolved-turn-plan";
import {buildSimulationContext, SIMULATION_CONTEXT_LIMITS, type SimulationContextV1} from "../simulation-context";
import {createProductionSubdivisionCatalog} from "../subdivision-catalog";
import {OpenAIResponsesSimulationProvider} from "./openai-responses-provider";
import type {OpenAIResponsesRequest, OpenAIResponsesTransport} from "./openai-responses-transport";
import {normalizeProviderEvents} from "./provider-event-normalizer";
import type {SimulationProviderConfig} from "./provider-config";
import {loadSimulationProviderConfig} from "./provider-config";
import {SimulationProviderError, type SimulationModelProvider, type SimulationProviderEvent} from "./simulation-provider";
import {createSimulationToolManifest} from "./simulation-tools";
import {validateResolutionAgainstContext} from "./context-resolution-validator";
import {createModelSimulationContext} from './model-simulation-context';
import {executeReadOnlySimulationTool} from './simulation-tools';
import {OpenAIResponseEventAccumulator} from './openai-response-events';

const context: SimulationContextV1 = {
  contextVersion: "simulation-context.v1",
  scenario: {id: "fixture", startDate: "2020-01-01"},
  revisions: {simulation: 0, world: 0},
  period: {startDate: "2020-01-01", endDate: "2020-02-01"},
  playerCountry: {countryId: "AAA", name: "가국"},
  queuedActions: [{actionId: "action.1", actorCountryId: "AAA", submittedAtDate: "2020-01-01", text: "나국과 합쳐", visibility: "public"}],
  countries: [
    {countryId: "AAA", shortKo: "가국", english: "Aland", politicalStatus: "active", territoryCount: 1, territoryIds: ["territory.aaa"]},
    {countryId: "BBB", shortKo: "나국", english: "Bland", politicalStatus: "active", territoryCount: 1, territoryIds: ["territory.bbb"]},
  ],
  countryDirectory: [
    {countryId: "AAA", shortKo: "가국", english: "Aland", searchAliases: [], politicalStatus: "active"},
    {countryId: "BBB", shortKo: "나국", english: "Bland", searchAliases: [], politicalStatus: "active"},
  ],
  territoryDirectory: [
    {countryId: "AAA", territoryIds: ["territory:seed:2:v13:AAA"]},
    {countryId: "BBB", territoryIds: ["territory:seed:2:v13:BBB"]},
  ],
  facts: [], situations: [], dueConsequences: [], recentEvents: [], subdivisions: [],
  rules: {locale: "ko-KR", capabilities: ["narrative-events"]},
  metadata: {clipped: []},
};

const validResolution = {
  contractVersion: "turn-resolution.v1",
  baseSimulationRevision: 0,
  baseWorldRevision: 0,
  period: {startDate: "2020-01-01", endDate: "2020-02-01"},
  playerActionOutcomes: [{outcomeId: "outcome.1", actionId: "action.1", status: "delayed", evidenceEventId: "event.1", summary: "통합 협상을 제안했지만 즉시 합병되지는 않았습니다.", remainingConditions: ["상대국의 동의가 필요합니다."]}],
  events: [{eventId: "event.1", date: "2020-01-15", title: "통합 협상 제안", publicNarrative: "가국이 나국에 통합 협상을 제안했습니다.", actorCountryIds: ["AAA", "BBB"], relatedFactIds: [], relatedSituationIds: [], causes: [{kind: "queued-action", id: "action.1"}], outcomeCategory: "diplomatic", significance: "notable"}],
  factMutations: [], situationMutations: [], scheduledConsequences: [], worldEffects: [],
  advisorSummary: "직접 합병 명령이 아니라 외교적 제안으로 처리되었습니다.",
  unresolvedQuestions: ["나국이 협상에 응할지 불확실합니다."],
};

const config = (overrides: Partial<SimulationProviderConfig> = {}): SimulationProviderConfig => ({
  apiKey: "test-secret", model: "test-model", timeoutMs: 100, maxRetries: 1,
  maxToolIterations: 4, maxToolCalls: 12, debugMode: false, ...overrides,
});

const toolResponse = (callId: string, name: string, args: unknown, responseId: string) => {
  const item = {type: "function_call", call_id: callId, name, arguments: JSON.stringify(args)};
  return [
  {type: "response.output_item.added", item: {...item, arguments: ""}},
  {type: "response.function_call_arguments.done", call_id: callId, arguments: JSON.stringify(args)},
  {type: "response.output_item.done", item},
  {type: "response.completed", response: {id: responseId}},
  ];
};

class ScriptedTransport implements OpenAIResponsesTransport {
  readonly requests: OpenAIResponsesRequest[] = [];
  constructor(private readonly scripts: readonly (readonly unknown[])[]) {}
  async *stream(request: OpenAIResponsesRequest): AsyncIterable<unknown> {
    this.requests.push(request);
    const script = this.scripts[this.requests.length - 1] ?? [];
    for (const event of script) yield event;
  }
}

const collect = async <T>(source: AsyncIterable<T>) => {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
};

describe("12-23 through 12-30 provider boundary", () => {
  it('keeps catalog model context compact while host lookups retain omitted data', () => {
    const full = {...context,
      regionCatalog: {catalogVersion:'catalog.v1',geometryRoot:'a'.repeat(64),topologyRoot:'b'.repeat(64),renderArtifactRoot:'c'.repeat(64),manifestPath:'/data/catalog.v1/manifest.json'},
      countries: [context.countries[0]],
      countryDirectory: context.countryDirectory.map(country => ({...country,searchAliases:['hidden alias']})),
      metadata: {clipped:[{section:'directory:BBB',omittedCount:20,reason:'bounded'},{section:'territories:AAA',omittedCount:3,reason:'bounded'}]},
    };
    const model = createModelSimulationContext(full);
    expect(model.territoryDirectory.map(country => country.countryId)).toEqual(['AAA']);
    expect(model.countryDirectory).toHaveLength(full.countryDirectory.length);
    expect(model.metadata.clipped.some(entry => entry.section === 'directory:BBB')).toBe(false);
    expect(full.territoryDirectory).toHaveLength(2);
    expect(executeReadOnlySimulationTool('find_country',{query:'hidden alias'},full)).toHaveLength(2);
    expect(executeReadOnlySimulationTool('inspect_country_territories',{countryId:'BBB'},full)).toEqual(full.territoryDirectory[1]);
    expect(createModelSimulationContext(context)).toBe(context);
  });

  it('retains streamed error codes, retry delays, and incomplete reasons', () => {
    const accumulator = new OpenAIResponseEventAccumulator();
    expect(accumulator.accept({type:'error',error:{code:'rate_limit_exceeded',message:'Slow down',headers:{'retry-after-ms':'30'}}})[0])
      .toMatchObject({type:'failed',code:'rate_limit_exceeded',retryAfterMs:30,message:expect.stringContaining('Slow down')});
    expect(accumulator.accept({type:'response.incomplete',response:{incomplete_details:{reason:'max_output_tokens'}}})[0])
      .toMatchObject({type:'failed',message:expect.stringContaining('max_output_tokens')});
    expect(accumulator.accept({type:'response.failed',response:{error:{code:'server_error',message:'Unavailable'}}})[0])
      .toMatchObject({type:'failed',code:'server_error',message:expect.stringContaining('Unavailable')});
  });

  it('waits and retries a streamed rate limit even after receiving response lifecycle events', async () => {
    const transport = new ScriptedTransport([
      [{type:'response.created'}, {type:'error',error:{code:'rate_limit_exceeded',message:'Slow down',headers:{'retry-after-ms':'30'}}}],
      toolResponse('call.after-rate','submit_turn_resolution',validResolution,'response.after-rate'),
    ]);
    const start = Date.now();
    const events = await collect(new OpenAIResponsesSimulationProvider(config(),transport)
      .streamTurn({turnId:'turn.rate',context},new AbortController().signal));
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
    expect(transport.requests).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('resolution.ready');
    expect(events.filter(event => event.type === 'turn.failed')).toHaveLength(0);
  });

  it('cancels rate-limit backoff and bounds repeated rate-limit failures', async () => {
    const limited = [{type:'error',error:{code:'rate_limit_exceeded',headers:{'retry-after-ms':'30'}}}];
    const transport = new ScriptedTransport([limited,limited]);
    const controller = new AbortController();
    const pending = collect(new OpenAIResponsesSimulationProvider(config(),transport)
      .streamTurn({turnId:'turn.cancel-rate',context},controller.signal));
    setTimeout(() => controller.abort(),1);
    expect((await pending).at(-1)?.type).toBe('turn.cancelled');
    expect(transport.requests).toHaveLength(1);
    const repeated = new ScriptedTransport([limited,limited]);
    const events = await collect(new OpenAIResponsesSimulationProvider(config(),repeated)
      .streamTurn({turnId:'turn.repeated-rate',context},new AbortController().signal));
    expect(repeated.requests).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({type:'turn.failed',code:'PROVIDER_RATE_LIMIT'});
  });

  it("uses server-only typed configuration", () => {
    expect(() => loadSimulationProviderConfig({})).toThrowError(SimulationProviderError);
    const loaded = loadSimulationProviderConfig({OPENAI_API_KEY: "key", OPENAI_MODEL: "model"});
    expect(loaded.model).toBe("model");
    expect(loaded.timeoutMs).toBe(120_000);
    expect(loaded.maxToolIterations).toBe(8);
    expect(loaded.maxToolCalls).toBe(12);
    expect(loaded.debugMode).toBe(false);
    expect(loadSimulationProviderConfig({
      OPENAI_API_KEY: "key",
      OPENAI_MODEL: "model",
      PAX_SIMULATION_DEBUG_MODE: "1",
    }).debugMode).toBe(true);
  });

  it("exposes only strict lookup tools and the single full-resolution tool", () => {
    const tools = createSimulationToolManifest();
    expect(tools.every((tool) => tool.strict && tool.parameters.additionalProperties === false)).toBe(true);
    expect(JSON.stringify(tools)).not.toContain('"oneOf"');
    expect(tools.map((tool) => tool.name)).toEqual([
      "find_border_territories",
      "find_region", "resolve_region", "find_country", "inspect_country_territories", "list_country_subdivisions",
      "inspect_active_situation", "inspect_recent_events", "submit_turn_resolution",
    ]);
    expect(JSON.stringify(tools)).not.toMatch(/merge_country|transfer_territory|apply_|commit_/);
  });

  it("streams draft, performs a bounded read-only lookup, then returns a valid resolution", async () => {
    const transport = new ScriptedTransport([
      [{type: "response.output_text.delta", delta: "협상이 시작되었습니다."}, ...toolResponse("call.lookup", "find_country", {query: "나국"}, "response.1")],
      toolResponse("call.submit", "submit_turn_resolution", validResolution, "response.2"),
    ]);
    const provider = new OpenAIResponsesSimulationProvider(config(), transport);
    const events = await collect(provider.streamTurn({turnId: "turn.1", context}, new AbortController().signal));
    expect(events.some((event) => event.type === "draft.delta")).toBe(true);
    expect(events.at(-1)?.type).toBe("resolution.ready");
    expect(transport.requests).toHaveLength(2);
    const serialized = JSON.stringify(transport.requests[0]);
    expect(serialized).toContain("simulation_context");
    expect(serialized).not.toContain("test-secret");
    expect(serialized).not.toMatch(/FeatureCollection|undo/i);
    expect(transport.requests[0].store).toBe(false);
    expect(transport.requests[0].include).toEqual(["reasoning.encrypted_content"]);
    expect(transport.requests[1]).not.toHaveProperty("previous_response_id");
    expect(JSON.stringify(transport.requests[1].input)).toContain("call.lookup");
  });

  it("adds the explicit world-effect directive only in server-configured debug mode", async () => {
    const normalTransport = new ScriptedTransport([toolResponse(
      "call.normal",
      "submit_turn_resolution",
      validResolution,
      "response.normal",
    )]);
    await collect(new OpenAIResponsesSimulationProvider(config(), normalTransport)
      .streamTurn({turnId: "turn.normal", context}, new AbortController().signal));
    expect(normalTransport.requests[0].instructions).not.toContain("[DEBUG_WORLD_EFFECT]");

    const debugTransport = new ScriptedTransport([toolResponse(
      "call.debug",
      "submit_turn_resolution",
      validResolution,
      "response.debug",
    )]);
    await collect(new OpenAIResponsesSimulationProvider(config({debugMode: true}), debugTransport)
      .streamTurn({turnId: "turn.debug", context}, new AbortController().signal));
    expect(debugTransport.requests[0].instructions).toContain("[DEBUG_WORLD_EFFECT]");
    expect(debugTransport.requests[0].instructions).toContain("countries.unified");
    expect(debugTransport.requests[0].instructions).toContain("preserves its CountryId");
    expect(debugTransport.requests[0].instructions).toContain("one country.established effect per resulting country");
  });

  it("accepts a marked debug unification through the real resolution validator only in debug mode", async () => {
    const debugContext: SimulationContextV1 = {
      ...context,
      queuedActions: [{
        ...context.queuedActions[0],
        text: "[DEBUG_WORLD_EFFECT] Aland and Bland ratify a union treaty",
      }],
    };
    const debugResolution = {
      ...validResolution,
      playerActionOutcomes: [{
        ...validResolution.playerActionOutcomes[0],
        status: "succeeded",
        summary: "The union treaty was ratified.",
        remainingConditions: [],
      }],
      events: [
        {
          ...validResolution.events[0],
          title: "Union referendum approved",
          publicNarrative: "Aland and Bland approved the union referendum.",
          outcomeCategory: "domestic",
          significance: "major",
        },
        {
          ...validResolution.events[0],
          eventId: "event.2",
          date: "2020-01-20",
          title: "Union treaty enacted",
          publicNarrative: "Aland and Bland enacted their union treaty.",
          causes: [{kind: "resolution-event", id: "event.1"}],
          outcomeCategory: "treaty",
          significance: "transformative",
        },
      ],
      worldEffects: [{
        effectId: "effect.unify",
        type: "countries.unified",
        causedByEventId: "event.2",
        countryIds: ["AAA", "BBB"],
        newCountryRef: "new.union",
        displayName: "Aland-Bland Union",
      }],
    };

    expect(validateResolutionAgainstContext(debugResolution, debugContext).ok).toBe(false);

    const transport = new ScriptedTransport([toolResponse(
      "call.debug-union",
      "submit_turn_resolution",
      debugResolution,
      "response.debug-union",
    )]);
    const events = await collect(new OpenAIResponsesSimulationProvider(config({debugMode: true}), transport)
      .streamTurn({turnId: "turn.debug-union", context: debugContext}, new AbortController().signal));

    expect(events.at(-1)?.type).toBe("resolution.ready");
  });

  it("repairs one stale resolution without applying it", async () => {
    const transport = new ScriptedTransport([
      toolResponse("call.bad", "submit_turn_resolution", {...validResolution, baseWorldRevision: 99}, "response.bad"),
      toolResponse("call.good", "submit_turn_resolution", validResolution, "response.good"),
    ]);
    const events = await collect(new OpenAIResponsesSimulationProvider(config(), transport)
      .streamTurn({turnId: "turn.repair", context}, new AbortController().signal));
    expect(events.map((event) => event.type)).toContain("tool.invalid");
    expect(events.map((event) => event.type)).toContain("phase.changed");
    expect(events.at(-1)?.type).toBe("resolution.ready");
    expect(JSON.stringify(transport.requests[1].input)).toContain("STALE_REVISION");
    expect(transport.requests.every((request) => request.tool_choice === "required")).toBe(true);
  });

  it('reserves submission and repair after ordinary lookup responses are exhausted', async () => {
    const transport = new ScriptedTransport([
      toolResponse('call.lookup-1','find_country',{query:'AAA'},'response.lookup-1'),
      toolResponse('call.lookup-2','inspect_recent_events',{limit:1},'response.lookup-2'),
      toolResponse('call.bad-final','submit_turn_resolution',{...validResolution,baseWorldRevision:99},'response.bad-final'),
      toolResponse('call.fixed-final','submit_turn_resolution',validResolution,'response.fixed-final'),
    ]);
    const events = await collect(new OpenAIResponsesSimulationProvider(config({maxToolIterations:2,maxToolCalls:4}),transport)
      .streamTurn({turnId:'turn.reserved-submit',context},new AbortController().signal));
    expect(transport.requests).toHaveLength(4);
    expect(transport.requests[2].tool_choice).toEqual({type:'function',name:'submit_turn_resolution'});
    expect(transport.requests[3].tool_choice).toEqual({type:'function',name:'submit_turn_resolution'});
    expect(events.at(-1)?.type).toBe('resolution.ready');
  });

  it('forces submission before exhausting the tool-call cap even when the response budget is larger', async () => {
    const transport = new ScriptedTransport([
      toolResponse('call.lookup','find_country',{query:'AAA'},'response.lookup'),
      toolResponse('call.submit','submit_turn_resolution',validResolution,'response.submit'),
    ]);
    const events = await collect(new OpenAIResponsesSimulationProvider(config({maxToolIterations:20,maxToolCalls:3}),transport)
      .streamTurn({turnId:'turn.call-budget',context},new AbortController().signal));
    expect(transport.requests[1].tool_choice).toEqual({type:'function',name:'submit_turn_resolution'});
    expect(events.at(-1)?.type).toBe('resolution.ready');
  });

  it("requires a tool call after a rejected submission instead of allowing a text-only repair", async () => {
    const requests: OpenAIResponsesRequest[] = [];
    const transport: OpenAIResponsesTransport = {
      async *stream(request) {
        requests.push(request);
        const events = requests.length === 1
          ? toolResponse("call.bad", "submit_turn_resolution", {...validResolution, baseWorldRevision: 99}, "response.bad")
          : request.tool_choice === "required"
            ? toolResponse("call.fixed", "submit_turn_resolution", validResolution, "response.fixed")
            : [{type: "response.output_text.delta", delta: "판정을 수정했습니다."}, {type: "response.completed", response: {id: "response.text"}}];
        for (const event of events) yield event;
      },
    };
    const events = await collect(new OpenAIResponsesSimulationProvider(config(), transport)
      .streamTurn({turnId: "turn.required-repair", context}, new AbortController().signal));
    expect(requests).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("resolution.ready");
    expect(events.filter((event) => event.type === "resolution.ready")).toHaveLength(1);
  });

  it("rejects every world-effect family with dangling or invalid production references", () => {
    const invalidEffects = [
      {effectId: "effect.rename", type: "country.renamed", causedByEventId: "event.1", countryId: "ZZZ", displayName: "Unknown"},
      {effectId: "effect.unify", type: "countries.unified", causedByEventId: "event.1", countryIds: ["AAA", "ZZZ"], newCountryRef: "new.union", displayName: "Union"},
      {effectId: "effect.establish", type: "country.established", causedByEventId: "event.1", sourceCountryId: "AAA", territoryIds: ["territory:seed:2:v17:missing"], subdivisionRefs: [], newCountryRef: "new.state", displayName: "State"},
      {effectId: "effect.dissolve", type: "country.dissolved", causedByEventId: "event.1", countryId: "ZZZ", successorCountryId: null},
      {effectId: "effect.transfer", type: "territories.transferred", causedByEventId: "event.1", fromCountryId: "BBB", toCountryId: "AAA", territoryIds: ["territory:seed:2:v13:AAA"]},
      {effectId: "effect.partition", type: "country.partitionedBySubdivisions", causedByEventId: "event.1", sourceCountryId: "AAA", partitions: [
        {newCountryRef: "new.north", displayName: "North", subdivisionRefs: [{catalogId: "catalog", sourceVersion: "v1", subdivisionId: "missing.north"}]},
        {newCountryRef: "new.south", displayName: "South", subdivisionRefs: [{catalogId: "catalog", sourceVersion: "v1", subdivisionId: "missing.south"}]},
      ]},
    ];
    for (const worldEffect of invalidEffects) {
      const result = validateResolutionAgainstContext({...validResolution, worldEffects: [worldEffect]}, context);
      expect(result.ok, worldEffect.type).toBe(false);
      expect(result.issues.some((issue) => issue.code === "DANGLING_REFERENCE" || issue.code === "INVALID_WORLD_EFFECT" || issue.code === "INVALID_CAUSALITY"), worldEffect.type).toBe(true);
    }
  });

  it("repairs an invalid effect reference once and accepts only the corrected resolution", async () => {
    const invalid = {...validResolution, worldEffects: [{
      effectId: "effect.rename",
      type: "country.renamed",
      causedByEventId: "event.1",
      countryId: "ZZZ",
      displayName: "Unknown",
    }]};
    const transport = new ScriptedTransport([
      toolResponse("call.bad-effect", "submit_turn_resolution", invalid, "response.bad-effect"),
      toolResponse("call.good-effect", "submit_turn_resolution", validResolution, "response.good-effect"),
    ]);
    const events = await collect(new OpenAIResponsesSimulationProvider(config(), transport)
      .streamTurn({turnId: "turn.effect-repair", context}, new AbortController().signal));
    expect(events.filter((event) => event.type === "tool.invalid")).toHaveLength(1);
    expect(JSON.stringify(transport.requests[1].input)).toContain("DANGLING_REFERENCE");
    expect(events.at(-1)?.type).toBe("resolution.ready");
  });

  it("normalizes refusal to one terminal failure with monotonic sequence", async () => {
    const transport = new ScriptedTransport([[
      {type: "response.refusal.done", refusal: "no"},
      {type: "response.completed", response: {id: "response.refusal"}},
    ]]);
    const provider = new OpenAIResponsesSimulationProvider(config(), transport);
    const events = await collect(normalizeProviderEvents("turn.refusal", provider.streamTurn({turnId: "turn.refusal", context}, new AbortController().signal)));
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
    expect(events.filter((event) => ["resolution.ready", "turn.failed", "turn.cancelled"].includes(event.type))).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({type: "turn.failed", code: "PROVIDER_REFUSAL"});
    expect(JSON.stringify(events)).not.toContain("response.refusal");
  });

  it("retries one pre-output timeout and cancels without later tool or resolution events", async () => {
    let attempts = 0;
    const transport: OpenAIResponsesTransport = {
      async *stream(_request, signal) {
        attempts += 1;
        if (attempts === 1) {
          await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
          return;
        }
        yield* toolResponse("call.timeout-good", "submit_turn_resolution", validResolution, "response.timeout-good");
      },
    };
    const events = await collect(new OpenAIResponsesSimulationProvider(config({timeoutMs: 5}), transport)
      .streamTurn({turnId: "turn.timeout", context}, new AbortController().signal));
    expect(attempts).toBe(2);
    expect(events.at(-1)?.type).toBe("resolution.ready");

    const cancelTransport: OpenAIResponsesTransport = {
      async *stream(_request, signal) {
        await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
      },
    };
    const controller = new AbortController();
    const pending = collect(new OpenAIResponsesSimulationProvider(config({timeoutMs: 1_000}), cancelTransport)
      .streamTurn({turnId: "turn.cancel", context}, controller.signal));
    setTimeout(() => controller.abort(), 1);
    const cancelled = await pending;
    expect(cancelled.at(-1)?.type).toBe("turn.cancelled");
    expect(cancelled.some((event) => event.type === "tool.started" || event.type === "resolution.ready")).toBe(false);
  });
});

describe("12-31 Route Handler", () => {
  const request = (body: string, headers?: HeadersInit) => new Request("http://localhost/api/simulation/turn", {method: "POST", body, headers});

  it("returns typed errors for malformed, oversized, and missing configuration requests", async () => {
    const unused = createSimulationTurnPost({createProvider() { throw new Error("must not run"); }});
    expect((await unused(request("{"))).status).toBe(400);
    expect((await unused(request("{}", {"content-length": String(300_000)}))).status).toBe(413);
    const missing = createSimulationTurnPost({createProvider() { throw new SimulationProviderError("AI_NOT_CONFIGURED", "missing"); }});
    expect((await missing(request(JSON.stringify({turnId: "turn.1", context})))).status).toBe(503);
  });

  it("strictly rejects nested extras, invalid dates/revisions, directory overflow, and prototype keys before provider creation", async () => {
    let providerCreations = 0;
    const post = createSimulationTurnPost({createProvider() {
      providerCreations += 1;
      return {async *streamTurn() { yield {type: "turn.cancelled"}; }};
    }});
    const invalidContexts = [
      {...context, playerCountry: {...context.playerCountry, extra: true}},
      {...context, period: {...context.period, endDate: "2020-02-30"}},
      {...context, revisions: {...context.revisions, simulation: -1}},
      {...context, countryDirectory: Array.from({length: SIMULATION_CONTEXT_LIMITS.countryDirectory + 1}, () => context.countryDirectory[0])},
    ];
    for (const invalidContext of invalidContexts) {
      expect((await post(request(JSON.stringify({turnId: "turn.invalid", context: invalidContext})))).status).toBe(400);
    }
    const validRaw = JSON.stringify({turnId: "turn.prototype", context});
    const pollutedRaw = validRaw.replace("{", '{"__proto__":{"polluted":true},');
    expect((await post(request(pollutedRaw))).status).toBe(400);
    expect(providerCreations).toBe(0);
    expect(({} as {polluted?: boolean}).polluted).toBeUndefined();
  });

  it("streams NDJSON and preserves provider failure status as a terminal host event", async () => {
    const provider = (events: readonly SimulationProviderEvent[]): SimulationModelProvider => ({
      async *streamTurn() { for (const event of events) yield event; },
    });
    const okPost = createSimulationTurnPost({createProvider: () => provider([{type: "resolution.ready", resolution: validResolution as never}])});
    const ok = await okPost(request(JSON.stringify({turnId: "turn.ok", context})));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await ok.text()).toContain("resolution.ready");
    const failedPost = createSimulationTurnPost({createProvider: () => provider([{type: "turn.failed", code: "PROVIDER_ERROR", message: "fixture", retryable: true}])});
    const failed = await failedPost(request(JSON.stringify({turnId: "turn.failed", context})));
    expect(await failed.text()).toContain('"type":"turn.failed"');
  });

  it("integrates strict Route parsing, the Responses tool loop, normalization, and one repair", async () => {
    const transport = new ScriptedTransport([
      toolResponse("call.route-bad", "submit_turn_resolution", {...validResolution, worldEffects: [{
        effectId: "effect.route-invalid", type: "country.renamed", causedByEventId: "event.1",
        countryId: "ZZZ", displayName: "Unknown",
      }]}, "response.route-bad"),
      toolResponse("call.route-good", "submit_turn_resolution", validResolution, "response.route-good"),
    ]);
    const post = createSimulationTurnPost({
      createProvider: () => new OpenAIResponsesSimulationProvider(config(), transport),
    });
    const response = await post(request(JSON.stringify({turnId: "turn.route-integration", context})));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as {type: string; sequence: number});
    expect(response.status).toBe(200);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool.invalid", "phase.changed", "resolution.ready"]));
    expect(events.map((event) => event.sequence)).toEqual(events.map((_event, index) => index));
    expect(transport.requests).toHaveLength(2);
  });

  it("discovers a foreign production subdivision through the Route tool loop and produces a locally executable resolution", async () => {
    const world = createProductionInitialWorldStateV2().worldState;
    const simulation = createInitialSimulationState(world, "AUT");
    const subdivisionCatalog = createProductionSubdivisionCatalog(loadProductionSubdivisionCatalog());
    const productionContext = buildSimulationContext({
      simulation,
      world,
      countrySearchProjection: createCountrySearchProjection(world),
      subdivisionCatalog,
      scenarioId: "2020-otl",
      scenarioStartDate: "2020-01-01",
      targetDate: "2020-02-01",
    });
    const subdivision = productionContext.subdivisions.find((entry) =>
      entry.parentCountryId === "CHN" && entry.subdivisionId === "CHN-AH")!;
    const resolution = {
      contractVersion: "turn-resolution.v1",
      baseSimulationRevision: simulation.revision,
      baseWorldRevision: world.revision,
      period: productionContext.period,
      playerActionOutcomes: [],
      events: [{eventId: "event.anhui-independence", date: productionContext.period.endDate, title: "Regional independence", publicNarrative: "Anhui declared independence after a negotiated transition.", actorCountryIds: ["AUT", "CHN"], relatedFactIds: [], relatedSituationIds: [], causes: [], outcomeCategory: "territorial", significance: "transformative"}],
      factMutations: [], situationMutations: [], scheduledConsequences: [],
      worldEffects: [{effectId: "effect.anhui-independence", type: "country.established", causedByEventId: "event.anhui-independence", sourceCountryId: "CHN", territoryIds: [], subdivisionRefs: [{catalogId: subdivision.catalogId, sourceVersion: subdivision.sourceVersion, subdivisionId: subdivision.subdivisionId}], newCountryRef: "new.anhui", displayName: "Anhui"}],
      advisorSummary: "A negotiated regional transition changed the map.", unresolvedQuestions: [],
    };
    const invalid = structuredClone(resolution);
    invalid.worldEffects[0].subdivisionRefs[0].subdivisionId = "CHN-MISSING";
    const transport = new ScriptedTransport([
      toolResponse("call.find-china", "find_country", {query: "CHN"}, "response.find"),
      toolResponse("call.list-china", "list_country_subdivisions", {countryId: "CHN"}, "response.list"),
      toolResponse("call.invalid-subdivision", "submit_turn_resolution", invalid, "response.invalid"),
      toolResponse("call.valid-subdivision", "submit_turn_resolution", resolution, "response.valid"),
    ]);
    const post = createSimulationTurnPost({
      createProvider: () => new OpenAIResponsesSimulationProvider(
        config({maxToolIterations: 6, maxToolCalls: 16}),
        transport,
      ),
    });
    const response = await post(request(JSON.stringify({
      turnId: "turn.production-subdivision",
      context: productionContext,
    })));
    const events = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as {type: string; resolution?: unknown});
    const ready = events.find((event) => event.type === "resolution.ready");
    expect(response.status).toBe(200);
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["tool.invalid", "resolution.ready"]));
    expect(transport.requests).toHaveLength(4);
    expect(JSON.stringify(transport.requests[2].input)).toContain("CHN-AH");
    expect(JSON.stringify(transport.requests[3].input)).toContain("DANGLING_REFERENCE");
    expect(() => createResolvedTurnPlan({
      turnId: "turn.production-subdivision",
      simulation,
      world,
      resolution: ready?.resolution,
      subdivisionCatalog,
    })).not.toThrow();
  }, 300_000);
});
