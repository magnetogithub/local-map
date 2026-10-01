import type {TurnReport} from "@/lib/simulation/client/turn-report";

export type MajorEventQueueEntry = Readonly<{
  key: string;
  turnId: string;
  event: TurnReport["events"][number];
  ordinal: number;
  total: number;
}>;

export type MajorEventQueueState = Readonly<{
  pending: readonly MajorEventQueueEntry[];
  acknowledgedKeys: ReadonlySet<string>;
  acknowledgedEventIds: ReadonlySet<string>;
}>;

export type MajorEventQueueAction =
  | Readonly<{type: "enqueue-report"; report: TurnReport}>
  | Readonly<{type: "acknowledge-current"}>;

export const initialMajorEventQueueState: MajorEventQueueState = Object.freeze({
  pending: Object.freeze([]),
  acknowledgedKeys: new Set<string>(),
  acknowledgedEventIds: new Set<string>(),
});

export function majorEventQueueReducer(
  state: MajorEventQueueState,
  action: MajorEventQueueAction,
): MajorEventQueueState {
  if (action.type === "acknowledge-current") {
    const current = state.pending[0];
    if (!current) return state;
    return Object.freeze({
      pending: Object.freeze(state.pending.slice(1)),
      acknowledgedKeys: new Set([...state.acknowledgedKeys, current.key]),
      acknowledgedEventIds: new Set([...state.acknowledgedEventIds, current.event.eventId]),
    });
  }

  const known = new Set([...state.acknowledgedKeys, ...state.pending.map((entry) => entry.key)]);
  const blocking = action.report.events
    .map((event, stableIndex) => ({event, stableIndex}))
    .filter(({event}) => event.significance === "major" || event.significance === "transformative")
    .sort((left, right) => left.event.date.localeCompare(right.event.date) || left.stableIndex - right.stableIndex)
    .filter(({event}) => !known.has(`${action.report.turnId}:${event.eventId}`));
  if (blocking.length === 0) return state;
  const appended = blocking.map(({event}, index) => Object.freeze({
    key: `${action.report.turnId}:${event.eventId}`,
    turnId: action.report.turnId,
    event,
    ordinal: index + 1,
    total: blocking.length,
  }));
  return Object.freeze({
    pending: Object.freeze([...state.pending, ...appended]),
    acknowledgedKeys: state.acknowledgedKeys,
    acknowledgedEventIds: state.acknowledgedEventIds,
  });
}
