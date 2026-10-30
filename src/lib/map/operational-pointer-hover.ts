import type {Map as MapLibreMap, MapMouseEvent} from 'maplibre-gl';

/** Camera motion can replace the land beneath a stationary pointer. Resolve
 * the rendered fill again on idle instead of retaining the previous country. */
export function mountOperationalPointerHover(map: MapLibreMap, layers: readonly string[], resolveCountry: (ordinal: number) => string | null, publish: (country: string | null) => void) {
  const canvas = map.getCanvas();
  let point: [number, number] | null = null;
  const clear = () => {point = null; publish(null);};
  const resolve = () => {
    if (!point) return;
    const rect = canvas.getBoundingClientRect();
    const target = document.elementFromPoint(rect.left + point[0], rect.top + point[1]);
    if (target !== canvas) {clear(); return;}
    const visibleLayers = layers.filter(id => !!map.getLayer(id));
    const features = visibleLayers.length ? map.queryRenderedFeatures(point, {layers: visibleLayers}) : [];
    const ordinal = Number(features[0]?.id);
    publish(Number.isInteger(ordinal) && ordinal > 0 ? resolveCountry(ordinal) : null);
  };
  const move = (event: MapMouseEvent) => {point = [event.point.x, event.point.y]; resolve();};
  map.on('mousemove', move); map.on('idle', resolve); canvas.addEventListener('mouseleave', clear);
  return () => {map.off('mousemove', move); map.off('idle', resolve); canvas.removeEventListener('mouseleave', clear);};
}
