import {fireEvent, render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it, vi} from "vitest";

import {GameActionOverlay} from "@/components/game/GameActionOverlay";
import {createCountrySearchProjection} from "@/lib/projection/country-search-index-patch";
import {useSimulationTurnController} from "@/lib/simulation/client/use-simulation-turn-controller";
import {createWorldStateStore} from "@/stores/world-state-store";
import {testWorldState} from "@/stores/world-state-store-v2-fixture";
import {useGameSetupStore} from "@/stores/game-setup-store";
import {NdjsonHostEventParser, TurnStreamProtocolError} from "./ndjson-turn-client";
import {initialTurnClientState, reduceHostTurnEvent} from "./turn-state-machine";
import type {ProductionSubdivisionAsset, SerializedProductionSubdivisionCatalog} from "../subdivision-catalog";

const asset = (
  countryId: "CHN" | "USA",
  scenario: "china-admin1-v1" | "usa-admin1-v1",
  count: number,
): ProductionSubdivisionAsset => ({
  type: "FeatureCollection",
  scenario,
  rollbackCountryId: countryId,
  features: Array.from({length: count}, (_value, index) => ({
    type: "Feature",
    properties: {countryId: `${countryId}-${index}`, parentCountryId: countryId, nameKo: `구역 ${index}`, nameEn: `Area ${index}`},
    geometry: {type: "Polygon", coordinates: [[[index, 0], [index + 0.5, 0], [index, 0.5], [index, 0]]]},
  })),
});
const subdivisionCatalog: SerializedProductionSubdivisionCatalog = {
  catalogVersion: "production-subdivision-catalog.v1",
  assets: [asset("CHN", "china-admin1-v1", 31), asset("USA", "usa-admin1-v1", 50)],
};

function ActionComposerHarness({worldController}: Readonly<{
  worldController: ReturnType<typeof createWorldStateStore>;
}>) {
  const playerCountryId = useGameSetupStore((state) => state.playerCountryId);
  const syncPlayerCountry = useGameSetupStore((state) => state.syncSimulationPlayerCountry);
  const controller = useSimulationTurnController({
    worldController,
    countrySearchProjection: createCountrySearchProjection(worldController.getState()),
    serializedSubdivisionCatalog: subdivisionCatalog,
    playerCountryId,
    syncPlayerCountry,
  });
  return <GameActionOverlay controller={controller}/>;
}

const line = (sequence: number, type: string, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({version: 1, turnId: "turn.1", sequence, type, ...extra})}\n`;

describe("12-34 action composer", () => {
  afterEach(() => {
    useGameSetupStore.setState({playerCountryId: null});
    vi.restoreAllMocks();
  });

  it("supports Korean IME, keyboard submit, focus metadata, max length, and queued display without network or map mutation", async () => {
    const world = testWorldState(["AAA", "BBB"]);
    const worldController = createWorldStateStore(world);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    useGameSetupStore.setState({playerCountryId: "AAA" as never});
    render(<ActionComposerHarness worldController={worldController}/>);
    const input = await screen.findByLabelText("현재 플레이 국가가 시도할 행동");
    expect(input).toHaveAttribute("maxlength", "2000");
    expect(screen.getByRole("button", {name: "대기열에 추가"})).toBeDisabled();
    fireEvent.compositionStart(input);
    fireEvent.change(input, {target: {value: "오스트리아와 통일 협상을 시작한다"}});
    fireEvent.keyDown(input, {key: "Enter", isComposing: true});
    expect(screen.queryByText("오스트리아와 통일 협상을 시작한다", {selector: ".action-queue span"})).toBeNull();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, {key: "Enter"});
    expect(screen.getByText("오스트리아와 통일 협상을 시작한다", {selector: ".action-queue span"})).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(worldController.getState()).toBe(world);
  });
});

describe("12-35 and 12-36 frozen requests and NDJSON state", () => {
  it("parses split chunks and multiple lines while keeping draft ephemeral", () => {
    const parser = new NdjsonHostEventParser();
    expect(parser.push(line(0, "turn.started").slice(0, 15))).toEqual([]);
    const events = parser.push(line(0, "turn.started").slice(15) + line(1, "draft.delta", {delta: "임시"}) + line(2, "turn.cancelled"));
    expect(events).toHaveLength(3);
    expect(parser.finish()).toEqual([]);
    const state = events.reduce(reduceHostTurnEvent, initialTurnClientState());
    expect(state.phase).toBe("cancelled");
    expect(state.draft).toBe("");
    expect(state.resolution).toBeNull();
  });

  it("rejects malformed, out-of-order, post-terminal, and disconnected streams", () => {
    expect(() => new NdjsonHostEventParser().push("not-json\n")).toThrowError(TurnStreamProtocolError);
    expect(() => new NdjsonHostEventParser().push(line(1, "turn.started"))).toThrow(/sequence|envelope/i);
    const afterTerminal = new NdjsonHostEventParser();
    afterTerminal.push(line(0, "turn.cancelled"));
    expect(() => afterTerminal.push(line(1, "draft.delta", {delta: "late"}))).toThrow(/terminal/i);
    const disconnected = new NdjsonHostEventParser();
    disconnected.push(line(0, "turn.started"));
    expect(() => disconnected.finish()).toThrow(/terminal/i);
  });
});
