import {cleanup, render, screen, within} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

import {createWorldMapRuntimeProjection} from "@/lib/projection/world-map-runtime-projection";
import {initialTurnClientState} from "@/lib/simulation/client/turn-state-machine";
import type {TurnReport} from "@/lib/simulation/client/turn-report";
import type {SimulationTurnController} from "@/lib/simulation/client/use-simulation-turn-controller";
import {createInitialSimulationState} from "@/lib/simulation/initial-simulation-state";
import {createSimulationStateV1} from '@/lib/simulation/simulation-state';
import {useGameSetupStore} from "@/stores/game-setup-store";
import {testWorldState} from "@/stores/world-state-store-v2-fixture";
import {GameScreenContent} from "./CatalogGameScreen";

vi.mock("@/components/map/CatalogWorldMap", () => ({CatalogWorldMap: () => null}));

const world = testWorldState(["AAA", "BBB"]);
const mapProjection = createWorldMapRuntimeProjection(world);
const snapshot = {
  world,
  simulation: createInitialSimulationState(world, "AAA"),
  revisions: {worldRevision: 0, simulationRevision: 0},
};

function controller(overrides: Partial<SimulationTurnController> = {}): SimulationTurnController {
  return {
    snapshot,
    actionDraft: "",
    setActionDraft: vi.fn(),
    queuedActions: [],
    turn: {...initialTurnClientState(), phase: "failed", errorCode: "NETWORK_ERROR"},
    report: null,
    lifecycleNotice: null,
    running: false,
    canQueue: false,
    canUndo: false,
    canRedo: false,
    queueAction: vi.fn(),
    cancelAction: vi.fn(),
    advance: vi.fn(async () => undefined),
    advanceToDate: vi.fn(async () => undefined),
    stop: vi.fn(),
    retry: vi.fn(async () => undefined),
    undo: vi.fn(),
    redo: vi.fn(),
    ...overrides,
  };
}

function game(turnController: SimulationTurnController) {
  return <GameScreenContent world={world} mapProjection={mapProjection} turnController={turnController} counts={{}} map={<div>지도</div>}/>;
}

beforeEach(() => {
  useGameSetupStore.getState().resetGameSetup();
  useGameSetupStore.getState().syncSimulationPlayerCountry(world.countryOrder[0]);
});
afterEach(() => {
  cleanup();
  useGameSetupStore.getState().resetGameSetup();
});

describe("F01 shared game HUD retry", () => {
  it("blocks HUD Retry for an oversized legacy queue and restores it at 32 active actions", () => {
    const actions = Array.from({length: 33}, (_, i) => ({actionId: `legacy.${i}`, actorCountryId: 'AAA',
      submittedAtDate: '2020-01-01', text: `이전 행동 ${i}`, visibility: 'public' as const, status: 'resolving' as const}));
    const withActions = (count: number) => game(controller({snapshot: {...snapshot,
      simulation: createSimulationStateV1({...snapshot.simulation, queuedActions: actions.slice(0, count)}, world)}}));
    const {rerender} = render(withActions(33));
    const hud = screen.getByLabelText('게임 현황');
    expect(within(hud).getByRole('button', {name: '대기 행동: 33'})).toBeInTheDocument();
    expect(within(hud).queryByRole('button', {name: 'Retry'})).not.toBeInTheDocument();
    rerender(withActions(32));
    expect(within(hud).getByRole('button', {name: '대기 행동: 32'})).toBeInTheDocument();
    expect(within(hud).getByRole('button', {name: 'Retry'})).toBeInTheDocument();
  });

  it("keeps command failure visible and restores Retry for an actual turn failure", async () => {
    const user = userEvent.setup();
    const retry = vi.fn(async () => undefined);
    const failedCommand = controller({turn: {...initialTurnClientState(), phase: "failed", failureSource: "command", errorCode: "NETWORK_ERROR"}, retry});
    const {rerender} = render(game(failedCommand));
    const hud = screen.getByLabelText("게임 현황");
    expect(hud).toHaveTextContent("실패 · NETWORK_ERROR");
    expect(within(hud).queryByRole("button", {name: "Retry"})).not.toBeInTheDocument();

    rerender(game(controller({retry})));
    await user.click(within(hud).getByRole("button", {name: "Retry"}));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("withholds HUD Retry until the report's major event is acknowledged", async () => {
    const user = userEvent.setup();
    const retry = vi.fn(async () => undefined);
    const report: TurnReport = {
      turnId: "turn.previous",
      period: "2020-01-01 — 2020-01-02",
      outcomes: [],
      events: [{eventId: "event.major", date: "2020-01-02", title: "주요 사건", narrative: "확인이 필요한 사건", countryIds: ["AAA"], category: "diplomatic", significance: "major", hasMapChanges: false}],
      reactions: [],
      mapChanges: [],
      continuing: [],
      advisorSummary: "이전 턴 결과",
    };
    render(game(controller({report, retry})));
    const hud = screen.getByLabelText("게임 현황");
    expect(screen.getByRole("dialog", {name: "주요 사건"})).toBeVisible();
    expect(within(hud).queryByRole("button", {name: "Retry"})).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", {name: "확인"}));
    expect(screen.queryByRole("dialog", {name: "주요 사건"})).not.toBeInTheDocument();
    await user.click(within(hud).getByRole("button", {name: "Retry"}));
    expect(retry).toHaveBeenCalledOnce();
  });
});
