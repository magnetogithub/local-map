import type {ExpressionSpecification} from 'maplibre-gl';

/** Keep close-up borders familiar while reducing the weight of a whole-world outline. */
export function operationalCountryBorderWidth(emphasized: boolean): ExpressionSpecification {
  const scale = emphasized ? 2 : 1;
  return ['interpolate', ['linear'], ['zoom'], 1, .25 * scale, 3, .55 * scale, 5, .8 * scale];
}

export const OPERATIONAL_COUNTRY_BORDER_OPACITY: ExpressionSpecification =
  ['interpolate', ['linear'], ['zoom'], 1, .55, 3, .85, 5, 1];

/** Original ADM1 boundaries are presentation; operational subdivisions remain debug-only. */
export const OPERATIONAL_LEGACY_BOUNDARY_PAINT = {
  'line-color': '#FFFFFF',
  'line-opacity': ['interpolate', ['linear'], ['zoom'], 2.2, 0, 3, .22, 5, .52],
  'line-width': ['interpolate', ['linear'], ['zoom'], 2.2, .25, 5, .85, 7, 1],
} satisfies NonNullable<import('maplibre-gl').LineLayerSpecification['paint']>;

export const OPERATIONAL_DEBUG_BOUNDARY_PAINT = {
  'line-color': '#9ADDE8',
  'line-opacity': ['interpolate', ['linear'], ['zoom'], 2.2, .2, 4, .45, 7, .7],
  'line-width': ['interpolate', ['linear'], ['zoom'], 2.2, .25, 5, .5, 7, .75],
} satisfies NonNullable<import('maplibre-gl').LineLayerSpecification['paint']>;
