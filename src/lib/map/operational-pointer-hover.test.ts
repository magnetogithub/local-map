import {afterEach, expect, it, vi} from 'vitest';
import type {Map} from 'maplibre-gl';
import {mountOperationalPointerHover} from './operational-pointer-hover';

afterEach(() => vi.restoreAllMocks());
it('reconciles a stationary pointer after camera movement and clears on overlays and canvas leave', () => {
  const canvas = document.createElement('canvas'), listeners = new globalThis.Map<string, (event?: unknown) => void>();
  let ordinal = 1;
  Object.defineProperty(document, 'elementFromPoint', {configurable: true, value: vi.fn(() => canvas)});
  const publish = vi.fn(), queryRenderedFeatures = vi.fn(() => [{id: ordinal}]);
  const map = {getCanvas: () => canvas, getLayer: () => ({}), queryRenderedFeatures,
    on: (event: string, fn: (event?: unknown) => void) => listeners.set(event, fn), off: (event: string) => listeners.delete(event)};
  const stop = mountOperationalPointerHover(map as unknown as Map, ['fill'], n => n === 1 ? 'PRK' : 'USA', publish);
  listeners.get('mousemove')!({point: {x: 100, y: 100}}); expect(publish).toHaveBeenLastCalledWith('PRK');
  ordinal = 2; listeners.get('idle')!(); expect(publish).toHaveBeenLastCalledWith('USA');
  vi.mocked(document.elementFromPoint).mockReturnValue(document.createElement('aside'));
  listeners.get('idle')!(); expect(publish).toHaveBeenLastCalledWith(null);
  const count = queryRenderedFeatures.mock.calls.length;
  listeners.get('idle')!(); expect(queryRenderedFeatures).toHaveBeenCalledTimes(count);
  vi.mocked(document.elementFromPoint).mockReturnValue(canvas);
  listeners.get('mousemove')!({point: {x: 100, y: 100}}); canvas.dispatchEvent(new MouseEvent('mouseleave'));
  expect(publish).toHaveBeenLastCalledWith(null); stop(); expect(listeners.size).toBe(0);
});
