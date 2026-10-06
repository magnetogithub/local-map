import {describe, expect, it} from 'vitest';
import {allocateCountryMapColor, canonicalizeRequestedMapColor, colorContrast, mapColorPresentation} from './country-map-color';
import {readCanonicalMapColor} from './country-entity-v3';
describe('14-15 color policy', () => {
  it('canonicalizes RGB without changing the visual value and rejects noncanonical stored values', () => {
    expect(canonicalizeRequestedMapColor('#aBc123')).toBe('#ABC123');
    for (const color of ['#abc123', '#FFF', 'red', ' #FFFFFF', '#GG0000']) expect(() => readCanonicalMapColor(color)).toThrow();
  });
  it('allocates stable, diverse colors independent of used-color ordering', () => {
    const colors = Array.from({length: 300}, (_, i) => allocateCountryMapColor(`A${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + i % 26)}`, []));
    expect(new Set(colors).size).toBe(300);
    expect(allocateCountryMapColor('AAA', colors)).toBe(allocateCountryMapColor('AAA', [...colors].reverse()));
    expect(colors).not.toContain(allocateCountryMapColor('AAA', colors));
  });
  it.each(['#CC0000', '#FFFFFF', '#FEFEFE', '#000000','#808080'])('preserves requested %s with readable ink', color => {
    expect(allocateCountryMapColor('AAA', [color], color.toLowerCase())).toBe(color);
    const p = mapColorPresentation(color); expect(colorContrast(color, p.outlineColor)).toBeGreaterThan(4.5);
  });
});
