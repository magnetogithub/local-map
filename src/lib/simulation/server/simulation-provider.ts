import type {SimulationContextV1} from "../simulation-context";
import type {TurnResolutionV1} from "../turn-resolution";

export type SimulationProviderFailureCode =
  | "AI_NOT_CONFIGURED"
  | "PROVIDER_ERROR"
  | "PROVIDER_REFUSAL"
  | "PROVIDER_TIMEOUT"
  | "TOOL_PROTOCOL_ERROR"
  | "TOOL_LIMIT_EXCEEDED"
  | "INVALID_RESOLUTION"
  | "REPAIR_FAILED";

export type SimulationProviderEvent =
  | Readonly<{type: "phase.changed"; phase: "requesting" | "looking_up" | "repairing"}>
  | Readonly<{type: "draft.delta"; delta: string}>
  | Readonly<{type: "tool.started"; callId: string; name: string}>
  | Readonly<{type: "tool.ready"; callId: string; name: string}>
  | Readonly<{type: "tool.invalid"; callId: string; name: string; code: string}>
  | Readonly<{type: "resolution.ready"; resolution: TurnResolutionV1}>
  | Readonly<{type: "turn.failed"; code: SimulationProviderFailureCode; message: string; retryable: boolean}>
  | Readonly<{type: "turn.cancelled"}>;

export type SimulationProviderRequest = Readonly<{
  turnId: string;
  context: SimulationContextV1;
}>;

export interface SimulationModelProvider {
  streamTurn(request: SimulationProviderRequest, signal: AbortSignal): AsyncIterable<SimulationProviderEvent>;
}

export class SimulationProviderError extends Error {
  constructor(
    readonly code: SimulationProviderFailureCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "SimulationProviderError";
  }
}
