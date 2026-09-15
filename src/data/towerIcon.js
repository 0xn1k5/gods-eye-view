/**
 * Cell tower silhouette as SVG data URI for Cesium billboards.
 *
 * GLYPH SOURCE: this string mirrors src/data/tower-icon.svg (the editable
 * source of truth) — redrawn from that file; rerunning the icon pipeline
 * should regenerate this block.  White fill + dark hairline stroke, the same
 * tint-safe contract as aircraftIcons.js (billboard.color = white × class hue).
 */

const SVG_SRC = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="\${w}" height="\${w}">
  <g fill="white" stroke="rgba(0,0,0,0.32)" stroke-width="1.4" stroke-linejoin="round" fill-rule="evenodd">
    <!-- Cell Tower Silhouette -->
    <path d=" M 48 6 L 60 12 L 55 26 L 62 22 L 72 62 L 60 70 L 58 62 L 54 70 L 42 70 L 38 62 L 36 70 L 24 62 L 34 22 L 41 26 L 36 12 Z M 48 18 L 55 26 L 41 26 Z M 36 40 L 60 40 L 64 54 L 57 58 L 39 58 L 32 54 Z M 48 4 L 46 10 L 50 10 Z " />
  </g>
</svg>`;

const _iconCache = new Map();

const _b64 = (s) =>
  typeof btoa === 'function'
    ? btoa(s)
    : Buffer.from(s, 'utf8').toString('base64');

/**
 * Data URI for the monochrome cell tower silhouette. Tinted at billboard time
 * via `billboard.color` (white × network-generation hue).
 */
export function towerIcon(px = 64) {
  const key = String(px);
  let uri = _iconCache.get(key);
  if (!uri) {
    const svg = SVG_SRC.replace(/\$\{w\}/g, String(px));
    uri = 'data:image/svg+xml;base64,' + _b64(svg);
    _iconCache.set(key, uri);
  }
  return uri;
}
