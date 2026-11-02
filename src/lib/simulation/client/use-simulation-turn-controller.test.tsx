import {act, renderHook, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";

import {createCountrySearchProjection} from "@/lib/projection/country-search-index-patch";
import {SIMULATION_CONTRACT_VERSION} from "@/lib/simulation/simulation-contract-primitives";
import type {
  ProductionSubdivisionAsset,
  SerializedProductionSubdivisionCatalog,
} from "@/lib/simulation/subdivision-catalog";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {createWorldStateStore} from "@/stores/world-state-store";
import {testWorldState} from "@/stores/world-state-store-v2-fixture";
import type {streamSimulationTurn} from "./ndjson-turn-client";
import {useSimulationTurnController} from "./use-simulation-turn-controller";

type StreamTurn = typeof streamSimulationTurn;

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
    properties: {
      countryId: `${countryId}-${index}`,
      parentCountryId: countryId,
      nameKo: `구역 ${index}`,
      nameEn: `Area ${index}`,
    },
    geometry: {
      type: "Polygon",
      coordinates: [[[index, 0], [index + 0.5, 0], [index, 0.5], [index, 0]]],
    },
  })),
});

const subdivisionCatalog: SerializedProductionSubdivisionCatalog = {
  catalogVersion: "production-subdivision-catalog.v1",
  assets: [asset("CHN", "china-admin1-v1", 31), asset("USA", "usa-admin1-v1", 50)],
};

describe("13-6 simulation turn controller", () => {
  it("queues and cancels actions without a presentation component", async () => {
    const world = testWorldState(["AAA", "BBB"]);
    const worldController = createWorldStateStore(world);
    const streamTurn = vi.fn() as unknown as typeof streamSimulationTurn;
    const {result} = renderHook(() => useSimulationTurnController({
      worldController,
      countrySearchProjection: createCountrySearchProjection(world),
      serializedSubdivisionCatalog: subdivisionCatalog,
      playerCountryId: "AAA" as ActiveCountryId,
      syncPlayerCountry: vi.fn(),
      streamTurn,
    }));

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => result.current.setActionDraft("평화 회담을 제안한다"));
    act(() => result.current.queueAction());
    expect(result.current.queuedActions).toHaveLength(1);
    expect(result.current.queuedActions[0].text).toBe("평화 회담을 제안한다");
    expect(streamTurn).not.toHaveBeenCalled();

    act(() => result.current.cancelAction(result.current.queuedActions[0].actionId));
    expect(result.current.queuedActions).toEqual([]);
  });

  it("passes a validated custom date through the frozen request and preserves undo/redo", async () => {
    const world = testWorldState(["AAA", "BBB"]);
    const worldController = createWorldStateStore(world);
    const streamTurnMock = vi.fn(async (
      request: Parameters<StreamTurn>[0],
      _signal: Parameters<StreamTurn>[1],
      onEvent: Parameters<StreamTurn>[2],
    ) => {
      const frozen = request as {turnId: string; context: {period: {startDate: string; endDate: string}; revisions: {simulation: number; world: number}}};
      onEvent({version: 1, turnId: frozen.turnId, sequence: 0, type: "turn.started"});
      onEvent({
        version: 1,
        turnId: frozen.turnId,
        sequence: 1,
        type: "resolution.ready",
        resolution: {
          contractVersion: SIMULATION_CONTRACT_VERSION,
          baseSimulationRevision: frozen.context.revisions.simulation,
          baseWorldRevision: frozen.context.revisions.world,
          period: frozen.context.period,
          playerActionOutcomes: [],
          events: [],
          factMutations: [],
          situationMutations: [],
          scheduledConsequences: [],
          worldEffects: [],
          advisorSummary: "특이 사항 없이 시간이 진행되었습니다.",
          unresolvedQuestions: [],
        },
      });
    });
    const streamTurn: StreamTurn = streamTurnMock;
    const {result} = renderHook(() => useSimulationTurnController({
      worldController,
      countrySearchProjection: createCountrySearchProjection(world),
      serializedSubdivisionCatalog: subdivisionCatalog,
      playerCountryId: "AAA" as ActiveCountryId,
      syncPlayerCountry: vi.fn(),
      streamTurn,
    }));

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    await act(() => result.current.advanceToDate("2020-02-29"));
    expect(streamTurnMock).toHaveBeenCalledOnce();
    expect((streamTurnMock.mock.calls[0][0] as {context: {period: unknown}}).context.period).toEqual({
      startDate: "2020-01-01",
      endDate: "2020-02-29",
    });
    expect(result.current.snapshot?.simulation.currentDate).toBe("2020-02-29");
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());
    expect(result.current.snapshot?.simulation.currentDate).toBe("2020-01-01");
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.snapshot?.simulation.currentDate).toBe("2020-02-29");
  });

  it("aborts an active request and retries the same preset", async () => {
    const world = testWorldState(["AAA", "BBB"]);
    const worldController = createWorldStateStore(world);
    let callCount = 0;
    const streamTurnMock = vi.fn((
      _request: Parameters<StreamTurn>[0],
      signal: Parameters<StreamTurn>[1],
    ) => {
      callCount += 1;
      if (callCount > 1) return Promise.reject(new Error("RETRY_FAILED"));
      return new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("ABORTED")), {once: true});
      });
    });
    const streamTurn = streamTurnMock as StreamTurn;
    const {result} = renderHook(() => useSimulationTurnController({
      worldController,
      countrySearchProjection: createCountrySearchProjection(world),
      serializedSubdivisionCatalog: subdivisionCatalog,
      playerCountryId: "AAA" as ActiveCountryId,
      syncPlayerCountry: vi.fn(),
      streamTurn,
    }));

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => { void result.current.advance("week"); });
    await waitFor(() => expect(result.current.running).toBe(true));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.turn.phase).toBe("cancelled"));
    await act(() => result.current.retry());
    expect(streamTurnMock).toHaveBeenCalledTimes(2);
    const periods = streamTurnMock.mock.calls.map(([request]) =>
      (request as {context: {period: {endDate: string}}}).context.period.endDate);
    expect(periods).toEqual(["2020-01-08", "2020-01-08"]);
    expect(result.current.turn).toMatchObject({phase: "failed", errorCode: "RETRY_FAILED"});
  });

  it("deduplicates advances before React can publish the running phase", async () => {
    const world = testWorldState(["AAA", "BBB"]);
    const worldController = createWorldStateStore(world);
    let release: (() => void) | undefined;
    const streamTurnMock = vi.fn((_request: Parameters<StreamTurn>[0], signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        release = resolve;
        signal.addEventListener("abort", () => reject(new Error("ABORTED")), {once: true});
      }));
    const {result, unmount} = renderHook(() => useSimulationTurnController({
      worldController,
      countrySearchProjection: createCountrySearchProjection(world),
      serializedSubdivisionCatalog: subdivisionCatalog,
      playerCountryId: "AAA" as ActiveCountryId,
      syncPlayerCountry: vi.fn(),
      streamTurn: streamTurnMock as StreamTurn,
    }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    act(() => {
      void result.current.advance("day");
      void result.current.advance("week");
    });
    expect(streamTurnMock).toHaveBeenCalledOnce();
    act(() => release?.());
    unmount();
  });

  it("keeps the previous canonical snapshot when a request fails", async () => {
    const world = testWorldState(["AAA", "BBB"]);
    const worldController = createWorldStateStore(world);
    const streamTurn = vi.fn(async () => { throw new Error("NETWORK_ERROR"); }) as unknown as StreamTurn;
    const {result} = renderHook(() => useSimulationTurnController({
      worldController,
      countrySearchProjection: createCountrySearchProjection(world),
      serializedSubdivisionCatalog: subdivisionCatalog,
      playerCountryId: "AAA" as ActiveCountryId,
      syncPlayerCountry: vi.fn(),
      streamTurn,
    }));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    const before = result.current.snapshot;
    await act(() => result.current.advance("day"));
    expect(result.current.turn).toMatchObject({phase: "failed", errorCode: "NETWORK_ERROR"});
    expect(result.current.snapshot).toBe(before);
    expect(worldController.getState()).toBe(world);
  });
});
