import {MAP_LAYER_IDS as L} from "@/lib/map/map-config";
import type {GameUiSettings} from "./ui-settings";

export type MapUiSettingsTarget = Readonly<{
  getLayer(id: string): unknown;
  setLayoutProperty(id: string, name: string, value: unknown): unknown;
  setPaintProperty(id: string, name: string, value: unknown): unknown;
}>;

const normalLowBorderWidth = ["interpolate", ["linear"], ["zoom"], 1, .45, 3, .8] as const;
const emphasizedLowBorderWidth = ["interpolate", ["linear"], ["zoom"], 1, 1.1, 3, 1.6] as const;
const normalHighBorderWidth = ["interpolate", ["linear"], ["zoom"], 3, .8, 6, 1.8] as const;
const emphasizedHighBorderWidth = ["interpolate", ["linear"], ["zoom"], 3, 1.6, 6, 3] as const;

export function applyMapUiSettings(target: MapUiSettingsTarget, settings: GameUiSettings): void {
  const visibility = (layerIds: readonly string[], visible: boolean) => {
    for (const layerId of layerIds) {
      if (target.getLayer(layerId)) {
        target.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
      }
    }
  };
  visibility([L.glyphLabelFills, L.glyphLabelOutlines, L.smallLabels, L.ultraSmallLabels], settings.showCountryLabels);
  visibility([L.capitalDots, L.capitalLabels], settings.showCapitalMarkers);
  if (target.getLayer(L.bordersLow)) {
    target.setPaintProperty(L.bordersLow, "line-width", settings.emphasizeBorders ? emphasizedLowBorderWidth : normalLowBorderWidth);
  }
  if (target.getLayer(L.borders)) {
    target.setPaintProperty(L.borders, "line-width", settings.emphasizeBorders ? emphasizedHighBorderWidth : normalHighBorderWidth);
  }
}
