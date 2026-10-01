import type {HostTurnEvent} from "../server/provider-event-normalizer";
import type {TurnResolutionV1} from "../turn-resolution";

export type TurnClientPhase = "idle" | "requesting" | "looking_up" | "repairing" | "committing" | "committed" | "failed" | "cancelled";
export type TurnClientState = Readonly<{
  turnId: string | null;
  phase: TurnClientPhase;
  draft: string;
  resolution: TurnResolutionV1 | null;
  errorCode: string | null;
  nextSequence: number;
}>;

export const initialTurnClientState = (): TurnClientState => Object.freeze({turnId: null, phase: "idle", draft: "", resolution: null, errorCode: null, nextSequence: 0});

export function reduceHostTurnEvent(state: TurnClientState, event: HostTurnEvent): TurnClientState {
  if (event.sequence !== state.nextSequence || (state.turnId !== null && event.turnId !== state.turnId)) throw new Error("OUT_OF_ORDER");
  const base = {...state, turnId: event.turnId, nextSequence: state.nextSequence + 1};
  switch (event.type) {
    case "turn.started": return Object.freeze({...base, phase: "requesting", draft: "", errorCode: null});
    case "phase.changed": return Object.freeze({...base, phase: event.phase});
    case "draft.delta": return Object.freeze({...base, draft: state.draft + event.delta});
    case "resolution.ready": return Object.freeze({...base, phase: "committing", resolution: event.resolution});
    case "turn.failed": return Object.freeze({...base, phase: "failed", errorCode: event.code, draft: ""});
    case "turn.cancelled": return Object.freeze({...base, phase: "cancelled", errorCode: "CANCELLED", draft: ""});
    default: return Object.freeze(base);
  }
}

export const markTurnCommitted = (state: TurnClientState): TurnClientState => {
  if (state.phase !== "committing" || !state.resolution) throw new Error("Turn cannot commit before a validated resolution");
  return Object.freeze({...state, phase: "committed", draft: ""});
};
