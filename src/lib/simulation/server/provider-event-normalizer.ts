import type {TurnResolutionV1} from "../turn-resolution";
import type {SimulationProviderEvent} from "./simulation-provider";

export type HostTurnEvent =
  | Readonly<{version: 1; turnId: string; sequence: number; type: "turn.started"}>
  | Readonly<{version: 1; turnId: string; sequence: number; type: "phase.changed"; phase: "requesting" | "looking_up" | "repairing"}>
  | Readonly<{version: 1; turnId: string; sequence: number; type: "draft.delta"; delta: string}>
  | Readonly<{version: 1; turnId: string; sequence: number; type: "tool.started" | "tool.ready"; callId: string; name: string}>
  | Readonly<{version: 1; turnId: string; sequence: number; type: "tool.invalid"; callId: string; name: string; code: string}>
  | Readonly<{version: 1; turnId: string; sequence: number; type: "resolution.ready"; resolution: TurnResolutionV1}>
  | Readonly<{version: 1; turnId: string; sequence: number; type: "turn.failed"; code: string; message: string; retryable: boolean}>
  | Readonly<{version: 1; turnId: string; sequence: number; type: "turn.cancelled"}>;

const terminal = new Set(["resolution.ready", "turn.failed", "turn.cancelled"]);

export async function* normalizeProviderEvents(
  turnId: string,
  source: AsyncIterable<SimulationProviderEvent>,
): AsyncGenerator<HostTurnEvent> {
  let sequence = 0;
  let ended = false;
  yield Object.freeze({version: 1, turnId, sequence: sequence++, type: "turn.started"});
  for await (const event of source) {
    if (ended) continue;
    const normalized = Object.freeze({version: 1, turnId, sequence: sequence++, ...event}) as HostTurnEvent;
    yield normalized;
    if (terminal.has(event.type)) ended = true;
  }
  if (!ended) {
    yield Object.freeze({version: 1, turnId, sequence, type: "turn.failed", code: "PROVIDER_ERROR", message: "Provider stream ended without a terminal event", retryable: true});
  }
}
