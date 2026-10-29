import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, describe, expect, it, vi} from "vitest";

import {initialTurnClientState} from "@/lib/simulation/client/turn-state-machine";
import type {TurnReport} from "@/lib/simulation/client/turn-report";
import type {SimulationTurnController} from "@/lib/simulation/client/use-simulation-turn-controller";
import {createInitialSimulationState} from "@/lib/simulation/initial-simulation-state";
import {queuePlayerAction, type QueuedPlayerActionV1} from "@/lib/simulation/queued-player-action";
import {testWorldState} from "@/stores/world-state-store-v2-fixture";
import {GameActionOverlay} from "./GameActionOverlay";

const world = testWorldState(["AAA", "BBB"]);
const initialSimulation = createInitialSimulationState(world, "AAA");
const snapshot = Object.freeze({
  simulation: initialSimulation,
  world,
  revisions: Object.freeze({simulationRevision: 0, worldRevision: 0}),
});

function createController(overrides: Partial<SimulationTurnController> = {}): SimulationTurnController {
  return {
    snapshot,
    actionDraft: "",
    setActionDraft: vi.fn(),
    queuedActions: [],
    turn: initialTurnClientState(),
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

afterEach(cleanup);

describe("13-21 through 13-23 game action overlay", () => {
  it("uses one start action for presets and requires explicit time-only confirmation", async () => {
    const user = userEvent.setup();
    const controller = createController();
    render(<GameActionOverlay controller={controller}/>);
    const start = screen.getByRole("button", {name: "진행 시작"});
    expect(start).toBeDisabled();
    await user.click(screen.getByRole("checkbox", {name: "행동 없이 시간만 진행"}));
    await user.click(screen.getByRole("button", {name: "1주"}));
    expect(screen.getByRole("button", {name: "1주"})).toHaveAttribute("aria-pressed", "true");
    expect(start).toBeEnabled();
    await user.click(start);
    expect(controller.advance).toHaveBeenCalledOnce();
    expect(controller.advance).toHaveBeenCalledWith("week");
    expect(controller.advanceToDate).not.toHaveBeenCalled();
  });

  it("passes the exact valid custom date and blocks an invalid date before the controller", async () => {
    const user = userEvent.setup();
    const invalidController = createController();
    const {rerender} = render(<GameActionOverlay controller={invalidController}/>);
    await user.click(screen.getByRole("checkbox", {name: "행동 없이 시간만 진행"}));
    const date = screen.getByLabelText("목표 날짜 직접 입력");
    fireEvent.change(date, {target: {value: "2020-01-01"}});
    expect(screen.getByRole("alert")).toHaveTextContent("현재 날짜보다 뒤인 유효한 ISO 날짜");
    expect(screen.getByRole("button", {name: "진행 시작"})).toBeDisabled();
    expect(invalidController.advanceToDate).not.toHaveBeenCalled();

    const validController = createController();
    rerender(<GameActionOverlay controller={validController}/>);
    fireEvent.change(screen.getByLabelText("목표 날짜 직접 입력"), {target: {value: "2020-02-29"}});
    const start = screen.getByRole("button", {name: "진행 시작"});
    expect(start).toBeEnabled();
    await user.click(start);
    expect(validController.advanceToDate).toHaveBeenCalledOnce();
    expect(validController.advanceToDate).toHaveBeenCalledWith("2020-02-29");
  });

  it("does not require the time-only confirmation when an action is queued", () => {
    const queuedActions = queuePlayerAction([], {
      actionId: "action.fixture",
      playerCountryId: "AAA",
      submittedAtDate: "2020-01-01",
      text: "협상을 제안한다",
    });
    render(<GameActionOverlay controller={createController({queuedActions})}/>);
    expect(screen.getByRole("checkbox", {name: "행동 없이 시간만 진행"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "진행 시작"})).toBeEnabled();
  });

  it("shows streaming draft and Stop while locking advance controls", async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    render(<GameActionOverlay controller={createController({
      turn: {...initialTurnClientState(), phase: "looking_up", draft: "임시 판정 초안"},
      running: true,
      stop,
    })}/>);
    expect(screen.getByRole("status")).toHaveTextContent("세계 정보 확인 중");
    expect(screen.getByLabelText("임시 초안")).toHaveTextContent("임시 판정 초안");
    expect(screen.getByRole("group", {name: "진행할 시간"})).toBeDisabled();
    await user.click(screen.getByRole("button", {name: "Stop"}));
    expect(stop).toHaveBeenCalledOnce();
  });

  it("does not stop or retry the shared controller when the overlay is merely closed", () => {
    const stop = vi.fn();
    const retry = vi.fn(async () => undefined);
    const {unmount} = render(<GameActionOverlay controller={createController({
      turn: {...initialTurnClientState(), phase: "requesting"},
      running: true,
      stop,
      retry,
    })}/>);
    unmount();
    expect(stop).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", "STALE_STATE", "세계 상태가 변경"],
    ["failed", "NETWORK_ERROR", "이전에 확정된 세계 상태는 유지"],
    ["cancelled", "CANCELLED", "이전 상태에서 다시 시도"],
  ] as const)("renders %s recovery without replacing the snapshot", async (phase, errorCode, message) => {
    const user = userEvent.setup();
    const retry = vi.fn(async () => undefined);
    const controller = createController({
      turn: {...initialTurnClientState(), phase, errorCode},
      retry,
    });
    render(<GameActionOverlay controller={controller}/>);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(controller.snapshot).toBe(snapshot);
    await user.click(screen.getByRole("button", {name: "Retry"}));
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each(["NETWORK_ERROR", "STALE_REVISION_PAIR"])("keeps %s command failures visible without offering turn Retry", (errorCode) => {
    const retry = vi.fn(async () => undefined);
    render(<GameActionOverlay controller={createController({
      turn: {...initialTurnClientState(), phase: "failed", failureSource: "command", errorCode},
      retry,
    })}/>);
    expect(screen.getByRole("status")).toHaveAttribute("data-phase", "failed");
    expect(screen.getByRole("status")).toHaveTextContent(`명령 확인 실패 (${errorCode})`);
    expect(screen.getByRole("alert")).toHaveTextContent("명령 처리 결과를 확인하지 못했습니다. 현재 상태를 확인하세요.");
    expect(screen.queryByRole("button", {name: "Retry"})).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });

  it("withholds turn Retry until the blocking major event is acknowledged", async () => {
    const user = userEvent.setup();
    const retry = vi.fn(async () => undefined);
    const controller = createController({
      turn: {...initialTurnClientState(), phase: "failed", failureSource: "turn", errorCode: "NETWORK_ERROR"},
      retry,
    });
    const {rerender} = render(<GameActionOverlay controller={controller} advanceBlocked/>);
    expect(screen.queryByRole("button", {name: "Retry"})).not.toBeInTheDocument();
    expect(screen.getByText("미확인 주요 사건을 모두 확인해야 다음 진행을 시작할 수 있습니다.")).toBeVisible();
    expect(retry).not.toHaveBeenCalled();

    rerender(<GameActionOverlay controller={controller}/>);
    await user.click(screen.getByRole("button", {name: "Retry"}));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("blocks the next advance while a committed major event is unacknowledged", () => {
    const queuedActions = queuePlayerAction([], {
      actionId: "action.blocked",
      playerCountryId: "AAA",
      submittedAtDate: "2020-01-01",
      text: "queued action",
    });
    const {container} = render(<GameActionOverlay controller={createController({queuedActions})} advanceBlocked/>);
    expect(container.querySelector<HTMLButtonElement>(".game-advance-submit")).toBeDisabled();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("keeps only a compact result summary in the action panel and opens full news", async () => {
    const user = userEvent.setup();
    const onOpenNews = vi.fn();
    const report: TurnReport = {
      turnId: "turn-result",
      period: "2020-01-01 — 2020-02-01",
      outcomes: ["detailed outcome"],
      events: [{eventId: "event-result", date: "2020-02-01", title: "event title", narrative: "event narrative", countryIds: ["AAA"], category: "diplomatic", significance: "major", hasMapChanges: false}],
      reactions: ["detailed reaction"],
      mapChanges: ["detailed map change"],
      continuing: ["detailed continuing issue"],
      advisorSummary: "compact advisor summary",
    };
    const {container} = render(<GameActionOverlay controller={createController({report})} onOpenNews={onOpenNews}/>);
    expect(container.querySelector(".game-action-result")).toHaveTextContent("compact advisor summary");
    expect(screen.queryByText("detailed outcome")).not.toBeInTheDocument();
    expect(screen.queryByText("detailed reaction")).not.toBeInTheDocument();
    const openNews = container.querySelector<HTMLButtonElement>(".game-action-result button");
    expect(openNews).not.toBeNull();
    await user.click(openNews!);
    expect(onOpenNews).toHaveBeenCalledWith("event-result");
  });
});

const activeActions = (count: number): readonly QueuedPlayerActionV1[] => Array.from({length: count}, (_, index) => ({
  actionId: `action.limit.${index}`,
  actorCountryId: "AAA",
  submittedAtDate: "2020-01-01",
  text: `대기 행동 ${index + 1}`,
  visibility: "public",
  status: "queued",
}));

function controllerWithActions(actions: readonly QueuedPlayerActionV1[], overrides: Partial<SimulationTurnController> = {}) {
  return createController({snapshot: {...snapshot, simulation: {...initialSimulation, queuedActions: actions}},
    queuedActions: actions.filter(action => action.status === "queued" || action.status === "resolving"),
    actionDraft: "추가 행동", canQueue: true, ...overrides});
}

describe("F03 active action limit controls", () => {
  it.each([31, 32, 33])("enforces the %i-action boundary for buttons and Enter", async count => {
    const user = userEvent.setup();
    const controller = controllerWithActions(activeActions(count));
    render(<GameActionOverlay controller={controller}/>);
    const add = screen.getByRole("button", {name: "대기열에 추가"});
    const advance = screen.getByRole("button", {name: "진행 시작"});
    expect(add).toHaveProperty("disabled", count >= 32);
    expect(advance).toHaveProperty("disabled", count > 32);
    fireEvent.keyDown(screen.getByLabelText("현재 플레이 국가가 시도할 행동"), {key: "Enter"});
    await user.click(add);
    expect(controller.queueAction).toHaveBeenCalledTimes(count < 32 ? 2 : 0);
    if (count > 32) expect(screen.getByRole("alert")).toHaveTextContent("기존 행동을 취소해 32개 이하로 줄인 뒤 진행하세요.");
  });

  it("counts resolving actions in the full snapshot while ignoring closed records", () => {
    const actions = [...activeActions(31),
      {...activeActions(1)[0], actionId: "action.resolving", status: "resolving" as const},
      {...activeActions(1)[0], actionId: "action.cancelled", status: "cancelled" as const},
      {...activeActions(1)[0], actionId: "action.resolved", status: "resolved" as const}];
    const controller = controllerWithActions(actions, {queuedActions: actions.filter(action => action.status === "queued")});
    render(<GameActionOverlay controller={controller}/>);
    expect(screen.getByRole("button", {name: "대기열에 추가"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "진행 시작"})).toBeEnabled();
  });

  it("allows legacy resolving cancellation only while over the limit and restores Retry after recovery", async () => {
    const user = userEvent.setup();
    const actions = activeActions(33).map((action, index) => index === 0 ? {...action, status: "resolving" as const} : action);
    const cancelAction = vi.fn();
    const failedTurn = {...initialTurnClientState(), phase: "failed" as const, errorCode: "NETWORK_ERROR"};
    const controller = controllerWithActions(actions, {turn: failedTurn, cancelAction});
    const {rerender} = render(<GameActionOverlay controller={controller}/>);
    expect(screen.queryByRole("button", {name: "Retry"})).not.toBeInTheDocument();
    const firstCancel = screen.getAllByRole("button", {name: "취소"})[0];
    expect(firstCancel).toBeEnabled();
    await user.click(firstCancel);
    expect(cancelAction).toHaveBeenCalledWith(actions[0].actionId);

    rerender(<GameActionOverlay controller={controllerWithActions(actions.slice(0, 32), {turn: failedTurn})}/>);
    expect(screen.getAllByRole("button", {name: "취소"})[0]).toBeDisabled();
    expect(screen.getByRole("button", {name: "진행 시작"})).toBeEnabled();
    expect(screen.getByRole("button", {name: "Retry"})).toBeEnabled();
  });
});
