import {describe, expect, it, vi} from "vitest";

import {MAP_LAYER_IDS as L} from "@/lib/map/map-config";
import {DEFAULT_GAME_UI_SETTINGS} from "./ui-settings";
import {applyMapUiSettings, type MapUiSettingsTarget} from "./map-ui-settings-adapter";

describe("13-19 map UI settings adapter", () => {
  it("changes only label, capital and border layer properties", () => {
    const getLayer = vi.fn(() => ({}));
    const setLayoutProperty = vi.fn();
    const setPaintProperty = vi.fn();
    const setData = vi.fn();
    const target = {getLayer, setLayoutProperty, setPaintProperty, setData} as unknown as MapUiSettingsTarget;
    applyMapUiSettings(target, {
      ...DEFAULT_GAME_UI_SETTINGS,
      showCountryLabels: false,
      showCapitalMarkers: false,
      emphasizeBorders: true,
    });
    expect(setLayoutProperty.mock.calls).toEqual([
      [L.glyphLabelFills, "visibility", "none"],
      [L.glyphLabelOutlines, "visibility", "none"],
      [L.smallLabels, "visibility", "none"],
      [L.ultraSmallLabels, "visibility", "none"],
      [L.capitalDots, "visibility", "none"],
      [L.capitalLabels, "visibility", "none"],
    ]);
    expect(setPaintProperty).toHaveBeenCalledTimes(2);
    expect(setPaintProperty.mock.calls.map(([layerId, property]) => [layerId, property])).toEqual([
      [L.bordersLow, "line-width"],
      [L.borders, "line-width"],
    ]);
    expect(setData).not.toHaveBeenCalled();
  });

  it("skips absent layers and never accesses a source API", () => {
    const target: MapUiSettingsTarget = {
      getLayer: vi.fn(() => undefined),
      setLayoutProperty: vi.fn(),
      setPaintProperty: vi.fn(),
    };
    applyMapUiSettings(target, DEFAULT_GAME_UI_SETTINGS);
    expect(target.setLayoutProperty).not.toHaveBeenCalled();
    expect(target.setPaintProperty).not.toHaveBeenCalled();
  });
});
