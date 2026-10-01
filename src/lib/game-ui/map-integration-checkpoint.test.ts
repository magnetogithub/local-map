import {describe, expect, it} from "vitest";

import {EMPTY_WAR_MAP_SOURCE, MAP_LAYER_IDS, MAP_SOURCE_IDS} from "@/lib/map/map-config";
import {DEFAULT_GAME_UI_SETTINGS} from "./ui-settings";
import {applyMapUiSettings, type MapUiSettingsTarget} from "./map-ui-settings-adapter";

describe("13-30 map settings and war layer slot", () => {
  it("reserves empty war layers without production fixture data", () => {
    expect(MAP_SOURCE_IDS.wars).toBe("war-overlay-slot");
    expect([MAP_LAYER_IDS.warAreas, MAP_LAYER_IDS.warFronts]).toEqual(["war-areas", "war-fronts"]);
    expect(EMPTY_WAR_MAP_SOURCE).toEqual({type: "FeatureCollection", features: []});
  });

  it("applies settings through layer properties without a GeoJSON source reload", () => {
    const calls: string[] = [];
    const target: MapUiSettingsTarget = {
      getLayer: () => ({}),
      setLayoutProperty: () => calls.push("layout"),
      setPaintProperty: () => calls.push("paint"),
    };
    applyMapUiSettings(target, {...DEFAULT_GAME_UI_SETTINGS, showCountryLabels: false, showCapitalMarkers: false, emphasizeBorders: true});
    expect(calls).toEqual(["layout", "layout", "layout", "layout", "layout", "layout", "paint", "paint"]);
    expect("setData" in target).toBe(false);
  });
});
