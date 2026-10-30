// @vitest-environment node
import {describe, expect, it} from 'vitest';
import {createExpression} from '@maplibre/maplibre-gl-style-spec';
import {OPERATIONAL_COUNTRY_BORDER_OPACITY, operationalCountryBorderWidth} from './operational-boundary-style';

const valueAt = (value: unknown, zoom: number) => {
  const expression = createExpression(value);
  if (expression.result !== 'success') throw Error(JSON.stringify(expression.value));
  return expression.value.evaluate({zoom});
};

describe('operational zoom-aware country outlines', () => {
  it('uses a softer subpixel world outline while retaining the close-up width', () => {
    expect(valueAt(operationalCountryBorderWidth(false), 1)).toBe(.25);
    expect(valueAt(operationalCountryBorderWidth(false), 6)).toBe(.8);
    expect(valueAt(OPERATIONAL_COUNTRY_BORDER_OPACITY, 1)).toBe(.55);
    expect(valueAt(OPERATIONAL_COUNTRY_BORDER_OPACITY, 6)).toBe(1);
    let previous = 0;
    for (const zoom of [1, 1.5, 2, 3, 4, 5, 7, 9]) {
      const width = valueAt(operationalCountryBorderWidth(false), zoom);
      expect(width).toBeGreaterThanOrEqual(previous); previous = width;
    }
  });

  it('keeps the emphasis setting relative to zoom instead of restoring a thick world outline', () => {
    for (const zoom of [1, 2, 3, 4, 6, 9]) {
      expect(valueAt(operationalCountryBorderWidth(true), zoom)).toBeCloseTo(valueAt(operationalCountryBorderWidth(false), zoom) * 2);
    }
    expect(valueAt(operationalCountryBorderWidth(true), 1)).toBeLessThan(valueAt(operationalCountryBorderWidth(false), 6));
  });
});
