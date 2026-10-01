import {serializeSimulationContext} from "../simulation-context";
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

export class OpenAIResponsesSimulationProvider implements SimulationModelProvider {
  constructor(
    private readonly config: SimulationProviderConfig,
    private readonly transport: OpenAIResponsesTransport,
  ) {}

  async *streamTurn(
    request: SimulationProviderRequest,
    signal: AbortSignal,
  ): AsyncIterable<SimulationProviderEvent> {
    const tools = createSimulationToolManifest();
    const input: unknown[] = [{
      role: "user",
      content: [{
        type: "input_text",
        text: JSON.stringify({kind: "simulation_context", data: JSON.parse(serializeSimulationContext(request.context))}),
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

    for (let iteration = 0; iteration < this.config.maxToolIterations; iteration += 1) {
      if (signal.aborted) {
        yield {type: "turn.cancelled"};
        return;
      }
      const apiRequest: OpenAIResponsesRequest = {
        model: this.config.model,
        instructions: buildSimulationInstruction(request.context, {debugMode: this.config.debugMode}),
        input: Object.freeze([...input]),
        tools,
        tool_choice: "auto",
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
        readyCalls = [];
        replayItems = [];
        try {
          for await (const raw of this.transport.stream(apiRequest, attemptController.signal)) {
            received = true;
            if (signal.aborted) throw abortError();
            for (const event of accumulator.accept(raw)) {
              if (event.type === "draft.delta") yield event;
              else if (event.type === "tool.started") {
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
              else if (event.type === "failed") throw new Error(event.message);
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
          if (received || attempt >= this.config.maxRetries) {
            yield {
              type: "turn.failed",
              code: timeoutFailure ? "PROVIDER_TIMEOUT" : "PROVIDER_ERROR",
              message: timeoutFailure ? "Simulation provider timed out" : "Simulation provider request failed",
              retryable: true,
            };
            return;
          }
          attempt += 1;
        } finally {
          clearTimeout(timeout);
          signal.removeEventListener("abort", onAbort);
        }
      }
      if (refusal) {
        yield {type: "turn.failed", code: "PROVIDER_REFUSAL", message: "The model refused to adjudicate this turn", retryable: false};
        return;
      }
      if (readyCalls.length === 0) {
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
          const result = validateResolutionAgainstContext(args, request.context, {debugWorldEffectActionIds});
          if (result.ok && result.resolution) {
            yield {type: "resolution.ready", resolution: result.resolution};
            return;
          }
          console.error(
            "Simulation resolution validation failed",
            result.issues.slice(0, 12).map(({code, path}) => ({code, path})),
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
          const output = executeReadOnlySimulationTool(call.name, args, request.context);
          yield {type: "phase.changed", phase: "looking_up"};
          input.push({type: "function_call_output", call_id: call.callId, output: JSON.stringify({ok: true, data: output})});
        } catch {
          yield {type: "tool.invalid", callId: call.callId, name: call.name, code: "INVALID_ARGUMENTS"};
          yield {type: "turn.failed", code: "TOOL_PROTOCOL_ERROR", message: "Read-only tool arguments were invalid", retryable: false};
          return;
        }
      }
    }
    yield {type: "turn.failed", code: "TOOL_LIMIT_EXCEEDED", message: "Tool iteration limit exceeded", retryable: false};
  }
}
