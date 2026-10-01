import type {ActiveCountryId} from "@/lib/world/country-id";

export type GameMenuOverlayKind =
  | "politics"
  | "economy"
  | "diplomacy"
  | "wars"
  | "action"
  | "news"
  | "save"
  | "settings";

export type GameOverlay =
  | Readonly<{kind: "closed"}>
  | Readonly<{kind: "politics"}>
  | Readonly<{kind: "economy"}>
  | Readonly<{kind: "diplomacy"; countryId?: ActiveCountryId}>
  | Readonly<{kind: "wars"; warId?: string}>
  | Readonly<{kind: "action"}>
  | Readonly<{kind: "news"; eventId?: string}>
  | Readonly<{kind: "save"}>
  | Readonly<{kind: "settings"}>
  | Readonly<{kind: "country"; countryId: ActiveCountryId}>;

export type GameOverlayAction =
  | Readonly<{type: "open"; overlay: Exclude<GameOverlay, Readonly<{kind: "closed"}>>}>
  | Readonly<{type: "toggle-menu"; kind: GameMenuOverlayKind}>
  | Readonly<{type: "close"}>
  | Readonly<{type: "reconcile-active-countries"; activeCountryIds: ReadonlySet<string>}>;

export const initialGameOverlay: GameOverlay = Object.freeze({kind: "closed"});

export function gameOverlayReducer(
  state: GameOverlay,
  action: GameOverlayAction,
): GameOverlay {
  if (action.type === "close") return initialGameOverlay;
  if (action.type === "open") return Object.freeze({...action.overlay});
  if (action.type === "toggle-menu") {
    return state.kind === action.kind
      ? initialGameOverlay
      : Object.freeze({kind: action.kind});
  }
  if (
    (state.kind === "country" || state.kind === "diplomacy")
    && state.countryId !== undefined
    && !action.activeCountryIds.has(state.countryId)
  ) return initialGameOverlay;
  return state;
}

