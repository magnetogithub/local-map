import {loadCatalogRegionIndex} from '../catalog-region.server';
import {loadProductionCatalogSeed} from '../../world/production-catalog-seed.server';
import {assertWorldGeometryCatalogRefMatches} from '../../world/world-geometry-catalog-ref';
import {serializeSimulationContext} from "../simulation-context";
import {createModelSimulationContext} from './model-simulation-context';
import {OpenAIResponsesError} from './openai-responses-error';
import {validateResolutionAgainstContext} from "./context-resolution-validator";
import {OpenAIResponseEventAccumulator, type CompletedToolCall} from "./openai-response-events";
import type {OpenAIResponsesRequest, OpenAIResponsesTransport} from "./openai-responses-transport";
import type {SimulationProviderConfig} from "./provider-config";
import {buildSimulationInstruction, DEBUG_WORLD_EFFECT_PREFIX} from "./simulation-instruction";
import {
  executeReadOnlySimulationTool,
  READ_ONLY_SIMULATION_TOOL_NAMES,
  createSimulationToolManifest,
} from "./simulation-tools";
import type {
  SimulationModelProvider,
  SimulationProviderEvent,
  SimulationProviderRequest,
} from "./simulation-provider";

const readonlyNames = new Set<string>(READ_ONLY_SIMULATION_TOOL_NAMES);
const abortError = () => new DOMException("The operation was aborted", "AbortError");
const waitForRetry = (milliseconds: number, signal: AbortSignal): Promise<boolean> => new Promise((resolve) => {
  if (signal.aborted) {resolve(false); return;}
  const finish = (ready: boolean) => {clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(ready);};
  const onAbort = () => finish(false);
  const timer = setTimeout(() => finish(true), milliseconds);
  signal.addEventListener('abort', onAbort, {once: true});
});

export class OpenAIResponsesSimulationProvider implements SimulationModelProvider {
  constructor(
    private readonly config: SimulationProviderConfig,
    private readonly transport: OpenAIResponsesTransport,
  ) {}

  async *streamTurn(
    request: SimulationProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<SimulationProviderEvent> {
    const regionIndex=request.context.regionCatalog?loadCatalogRegionIndex():undefined;
    if(regionIndex)assertWorldGeometryCatalogRefMatches(request.context.regionCatalog!,loadProductionCatalogSeed().bootstrap.catalogRef);
    const tools = createSimulationToolManifest();
    const input: unknown[] = [{
      role: "user",
      content: [{
        type: "input_text",
        text: JSON.stringify({kind: "simulation_context", data: JSON.parse(serializeSimulationContext(createModelSimulationContext(request.context)))}),
      }],
    }];
    let calls = 0;
    let repaired = false;
    const debugWorldEffectActionIds = new Set(
      this.config.debugMode
        ? request.context.queuedActions
          .filter((action) => action.text.startsWith(DEBUG_WORLD_EFFECT_PREFIX))
          .map((action) => action.actionId)
        : [],
    );
    const seenCallIds = new Set<string>();
    yield {type: "phase.changed", phase: "requesting"};

    // Lookup responses cannot consume the slots needed to submit and repair a turn.
    const responseLimit = Math.min(this.config.maxToolIterations + 2, this.config.maxToolCalls);
    for (let iteration = 0; iteration < responseLimit; iteration += 1) {
      if (signal.aborted) {
        yield {type: "turn.cancelled"};
        return;
      }
      const submitRequired = iteration >= this.config.maxToolIterations
        || calls >= this.config.maxToolCalls - (repaired ? 1 : 2);
      const apiRequest: OpenAIResponsesRequest = {
        model: this.config.model,
        instructions: `${buildSimulationInstruction(request.context, {debugMode: this.config.debugMode})}\n${submitRequired
          ? 'The lookup budget is exhausted. Submit the complete turn resolution now using verified results already returned, correcting any validation issues. Do not claim success without matching world effects.'
          : `There are ${this.config.maxToolIterations - iteration} ordinary responses left before submission is mandatory. Avoid repeating lookups whose results are already available; submit as soon as you have enough verified data.`}`,
        input: Object.freeze([...input]),
        tools,
        // Every response must advance the lookup/submit protocol, including repairs.
        tool_choice: submitRequired ? {type: 'function', name: 'submit_turn_resolution'} : "required",
        parallel_tool_calls: false,
        store: false,
        stream: true,
        max_output_tokens: 8_000,
        include: ["reasoning.encrypted_content"],
      };
      let readyCalls: CompletedToolCall[] = [];
      let replayItems: Readonly<Record<string, unknown>>[] = [];
      let refusal = false;
      let attempt = 0;
      let completedAttempt = false;
      while (!completedAttempt && attempt <= this.config.maxRetries) {
        const attemptController = new AbortController();
        const onAbort = () => attemptController.abort(signal.reason ?? abortError());
        signal.addEventListener("abort", onAbort, {once: true});
        const timeout = setTimeout(() => attemptController.abort(new DOMException("Provider timeout", "TimeoutError")), this.config.timeoutMs);
        const accumulator = new OpenAIResponseEventAccumulator();
        let received = false;
        let publishedOutput = false;
        let retryDelayMs = 0;
        readyCalls = [];
        replayItems = [];
        try {
          for await (const raw of this.transport.stream(apiRequest, attemptController.signal)) {
            received = true;
            if (signal.aborted) throw abortError();
            for (const event of accumulator.accept(raw)) {
              if (event.type === "draft.delta") {publishedOutput = true; yield event;}
              else if (event.type === "tool.started") {
                publishedOutput = true;
                if (seenCallIds.has(event.callId)) {
                  yield {type: "tool.invalid", callId: event.callId, name: event.name, code: "DUPLICATE_CALL_ID"};
                  yield {type: "turn.failed", code: "TOOL_PROTOCOL_ERROR", message: "Duplicate tool call ID", retryable: false};
                  return;
                }
                seenCallIds.add(event.callId);
                yield event;
              } else if (event.type === "tool.ready") {
                readyCalls.push(event.call);
                yield {type: "tool.ready", callId: event.call.callId, name: event.call.name};
              } else if (event.type === "response.item") replayItems.push(event.item);
              else if (event.type === "refusal") refusal = true;
              else if (event.type === "failed") throw new OpenAIResponsesError(event.message, event.code, event.retryAfterMs);
            }
          }
          completedAttempt = true;
        } catch (error) {
          if (signal.aborted) {
            yield {type: "turn.cancelled"};
            return;
          }
          console.error(
            "Simulation provider request failed",
            error instanceof Error ? error.message : "Unknown provider error",
          );
          const timeoutFailure = attemptController.signal.aborted;
          const rateLimited = error instanceof OpenAIResponsesError && error.code === 'rate_limit_exceeded';
          const canRetryRateLimit = rateLimited && !publishedOutput && (error.retryAfterMs ?? 1000) <= 60_000;
          if ((received && !canRetryRateLimit) || attempt >= this.config.maxRetries || (rateLimited && !canRetryRateLimit)) {
            yield {
              type: "turn.failed",
              code: timeoutFailure ? "PROVIDER_TIMEOUT" : rateLimited ? 'PROVIDER_RATE_LIMIT' : "PROVIDER_ERROR",
              message: timeoutFailure ? "Simulation provider timed out" : rateLimited ? 'Simulation provider rate limited; retry later' : "Simulation provider request failed",
              retryable: true,
            };
            return;
          }
          if (canRetryRateLimit) retryDelayMs = error.retryAfterMs ?? 1000;
          attempt += 1;
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
        }
        if (retryDelayMs > 0 && !await waitForRetry(retryDelayMs, signal)) {
          yield {type: 'turn.cancelled'};
          return;
        }
      }
      if (refusal) {
        yield {type: "turn.failed", code: "PROVIDER_REFUSAL", message: "The model refused to adjudicate this turn", retryable: false};
        return;
      }
      if (readyCalls.length === 0) {
        console.error("Simulation provider returned no tool calls", JSON.stringify({
          iteration, repaired, outputTypes: replayItems.map((item) => item.type),
        }));
        yield {type: "turn.failed", code: "TOOL_PROTOCOL_ERROR", message: "No turn resolution was submitted", retryable: true};
        return;
      }
      input.push(...replayItems);
      for (const call of readyCalls) {
        if (signal.aborted) {
          yield {type: "turn.cancelled"};
          return;
        }
        calls += 1;
        if (calls > this.config.maxToolCalls) {
          yield {type: "turn.failed", code: "TOOL_LIMIT_EXCEEDED", message: "Tool call limit exceeded", retryable: false};
          return;
        }
        let args: unknown;
        try {
          args = JSON.parse(call.argumentsText) as unknown;
        } catch {
          yield {type: "tool.invalid", callId: call.callId, name: call.name, code: "INVALID_ARGUMENTS"};
          yield {type: "turn.failed", code: "TOOL_PROTOCOL_ERROR", message: "Tool arguments were not valid JSON", retryable: false};
          return;
        }
        if (call.name === "submit_turn_resolution") {
          const result = validateResolutionAgainstContext(args, request.context, {debugWorldEffectActionIds,regionIndex});
          if (result.ok && result.resolution) {
            yield {type: "resolution.ready", resolution: result.resolution};
            return;
          }
          console.error(
            "Simulation resolution validation failed",
            JSON.stringify(result.issues.slice(0, 12).map(({code, path}) => ({code, path}))),
          );
          if (repaired) {
            const issueSummary = result.issues.slice(0, 6).map(({code, path}) => `${code}@${path}`).join(", ");
            yield {
              type: "turn.failed",
              code: "REPAIR_FAILED",
              message: `Repaired turn resolution remained invalid: ${issueSummary}`,
              retryable: false,
            };
            return;
          }
          repaired = true;
          yield {type: "tool.invalid", callId: call.callId, name: call.name, code: "INVALID_RESOLUTION"};
          yield {type: "phase.changed", phase: "repairing"};
          input.push({
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify({ok: false, issues: result.issues.slice(0, 12)}),
          });
          continue;
        }
        if (!readonlyNames.has(call.name)) {
          yield {type: "tool.invalid", callId: call.callId, name: call.name, code: "UNKNOWN_TOOL"};
          yield {type: "turn.failed", code: "TOOL_PROTOCOL_ERROR", message: "Unknown tool requested", retryable: false};
          return;
        }
        try {
          const output = executeReadOnlySimulationTool(call.name, args, request.context,regionIndex);
          yield {type: "phase.changed", phase: "looking_up"};
          input.push({type: "function_call_output", call_id: call.callId, output: JSON.stringify({ok: true, data: output})});
        } catch {
          yield {type: "tool.invalid", callId: call.callId, name: call.name, code: "INVALID_ARGUMENTS"};
          yield {type: "turn.failed", code: "TOOL_PROTOCOL_ERROR", message: "Read-only tool arguments were invalid", retryable: false};
          return;
        }
      }
    }
    console.error('Simulation tool budget exhausted', JSON.stringify({responses:responseLimit,calls,repaired}));
    yield {type: "turn.failed", code: "TOOL_LIMIT_EXCEEDED", message: "Tool iteration limit exceeded", retryable: false};
  }
}
