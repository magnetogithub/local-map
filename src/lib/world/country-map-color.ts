import {readCanonicalMapColor} from './country-entity-v3';
import {sha256Hex} from './sha256';

/** Input convenience for requests/seed import only. Stored state remains strict. */
export function canonicalizeRequestedMapColor(value: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error('Expected RGB hex color');
  return readCanonicalMapColor(value.toUpperCase());
}
export function colorLuminance(color: string): number {
  readCanonicalMapColor(color);
  const channels = [1, 3, 5].map(i => {
    const n = parseInt(color.slice(i, i + 2), 16) / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
export function colorContrast(a: string, b: string): number {
  const x = colorLuminance(a), y = colorLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** White fills stay white; contrasting outlines and label halos provide separation. */
export function mapColorPresentation(color: string) {
  const dark = '#172E35', light = '#FFFFFF';
  const darkInk=colorContrast(color,dark)>=4.5?dark:'#000000';
  const ink = colorContrast(color, darkInk) >= colorContrast(color, light) ? darkInk : light;
  return Object.freeze({mapColor: readCanonicalMapColor(color), outlineColor: ink,
    selectionColor: ink, labelColor: ink, labelHaloColor: ink === light ? dark : light});
}
/** Full RGB space, stable across ordering/locale. Explicit requested colors may repeat. */
export function allocateCountryMapColor(countryId: string, usedColors: readonly string[], requested?: string): string {
  if (!/^[A-Z]{3}$/.test(countryId)) throw new Error('Expected canonical CountryId');
  const used = new Set(usedColors.map(readCanonicalMapColor));
  if (requested !== undefined) return canonicalizeRequestedMapColor(requested);
  const start = parseInt(sha256Hex(new TextEncoder().encode(`country-map-color.v1\0${countryId}`)).slice(0, 6), 16);
  // Odd step visits every 24-bit RGB value; no fixed-palette cycling.
  for (let i = 0; i <= used.size; i++) {
    const candidate = `#${((start + i * 0x9E3779) & 0xFFFFFF).toString(16).padStart(6, '0').toUpperCase()}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error('Country color space exhausted');
}
