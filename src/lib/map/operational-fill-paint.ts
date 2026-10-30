import type {ExpressionSpecification} from 'maplibre-gl';

const tint = (flag: string, below: ExpressionSpecification, above: ExpressionSpecification | string): ExpressionSpecification =>
  ['interpolate', ['linear'], ['case', ['boolean', ['feature-state', flag], false], .18, 0], 0, below, 1, above];

// Same ordered RGB alpha composition as the former base + occupation + hover
// + selection layers, evaluated once per feature instead of four fill passes.
const base: ExpressionSpecification = ['to-color', ['coalesce', ['feature-state', 'mapColor'], '#D6D3C7']];
const selection: ExpressionSpecification = ['to-color', ['coalesce', ['feature-state', 'selectionColor'], '#FFFFFF']];
export const OPERATIONAL_FILL_COLOR = tint('selected', tint('hover', tint('occupied', base, '#40285E'), selection), selection);
