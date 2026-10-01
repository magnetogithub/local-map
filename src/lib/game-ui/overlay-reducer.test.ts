import {describe, expect, it} from "vitest";

import type {ActiveCountryId} from "@/lib/world/country-id";
import {gameOverlayReducer, initialGameOverlay} from "./overlay-reducer";

describe("13-8 game overlay reducer", () => {
  it("represents exactly one open management window", () => {
    const politics = gameOverlayReducer(initialGameOverlay, {type: "toggle-menu", kind: "politics"});
    const economy = gameOverlayReducer(politics, {type: "toggle-menu", kind: "economy"});
    expect(politics).toEqual({kind: "politics"});
    expect(economy).toEqual({kind: "economy"});
    expect(Object.keys(economy)).toEqual(["kind"]);
  });

  it("toggles the same menu closed and supports explicit close", () => {
    const news = gameOverlayReducer(initialGameOverlay, {type: "toggle-menu", kind: "news"});
    expect(gameOverlayReducer(news, {type: "toggle-menu", kind: "news"})).toBe(initialGameOverlay);
    expect(gameOverlayReducer(news, {type: "close"})).toBe(initialGameOverlay);
  });

  it("preserves active targets and closes retired country targets", () => {
    const countryId = "AAA" as ActiveCountryId;
    const state = gameOverlayReducer(initialGameOverlay, {
      type: "open",
      overlay: {kind: "country", countryId},
    });
    expect(gameOverlayReducer(state, {
      type: "reconcile-active-countries",
      activeCountryIds: new Set([countryId]),
    })).toBe(state);
    expect(gameOverlayReducer(state, {
      type: "reconcile-active-countries",
      activeCountryIds: new Set(),
    })).toBe(initialGameOverlay);
  });

  it("cleans a retired diplomacy target without closing untargeted diplomacy", () => {
    const countryId = "BBB" as ActiveCountryId;
    const active = new Set<string>();
    expect(gameOverlayReducer({kind: "diplomacy", countryId}, {
      type: "reconcile-active-countries",
      activeCountryIds: active,
    })).toBe(initialGameOverlay);
    const untargeted = {kind: "diplomacy"} as const;
    expect(gameOverlayReducer(untargeted, {
      type: "reconcile-active-countries",
      activeCountryIds: active,
    })).toBe(untargeted);
  });
});

