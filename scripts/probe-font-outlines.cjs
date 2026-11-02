const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const fontPath = path.join(root, "public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf");
const fontkit = require("fontkit");
const fontBytes = fs.readFileSync(fontPath);
const font = fontkit.create(fontBytes);
const samples = ["호주", "러시아"];
const tolerances = [1, 4];

const round = value => Math.round(value * 1e6) / 1e6;
const distanceToLine = (point, start, end) => {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  if (dx === 0 && dy === 0) return Math.hypot(point[0] - start[0], point[1] - start[1]);
  return Math.abs(dy * point[0] - dx * point[1] + end[0] * start[1] - end[1] * start[0]) / Math.hypot(dx, dy);
};
const splitCubic = (p0, p1, p2, p3) => {
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const a = mid(p0, p1), b = mid(p1, p2), c = mid(p2, p3), d = mid(a, b), e = mid(b, c), f = mid(d, e);
  return [[p0, a, d, f], [f, e, c, p3]];
};
const flattenCubic = (p0, p1, p2, p3, tolerance, output, depth = 0) => {
  const error = Math.max(distanceToLine(p1, p0, p3), distanceToLine(p2, p0, p3));
  if (error <= tolerance || depth >= 20) { output.push(p3); return; }
  const [left, right] = splitCubic(p0, p1, p2, p3);
  flattenCubic(...left, tolerance, output, depth + 1);
  flattenCubic(...right, tolerance, output, depth + 1);
};
const signedArea = ring => ring.slice(0, -1).reduce((sum, point, index) => {
  const next = ring[index + 1]; return sum + point[0] * next[1] - next[0] * point[1];
}, 0) / 2;
const pointInRing = (point, ring) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};
const flattenPath = (commands, tolerance) => {
  const rings = []; let ring = null, current = null, start = null;
  for (const item of commands) {
    const a = item.args;
    if (item.command === "moveTo") { ring = [[a[0], a[1]]]; rings.push(ring); current = ring[0]; start = current; }
    else if (item.command === "lineTo") { current = [a[0], a[1]]; ring.push(current); }
    else if (item.command === "bezierCurveTo") { const points = []; flattenCubic(current, [a[0], a[1]], [a[2], a[3]], [a[4], a[5]], tolerance, points); ring.push(...points); current = [a[4], a[5]]; }
    else if (item.command === "quadraticCurveTo") {
      const control = [a[0], a[1]], end = [a[2], a[3]], c1 = [current[0] + 2 / 3 * (control[0] - current[0]), current[1] + 2 / 3 * (control[1] - current[1])], c2 = [end[0] + 2 / 3 * (control[0] - end[0]), end[1] + 2 / 3 * (control[1] - end[1])], points = [];
      flattenCubic(current, c1, c2, end, tolerance, points); ring.push(...points); current = end;
    } else if (item.command === "closePath" && ring && (current[0] !== start[0] || current[1] !== start[1])) { ring.push(start); current = start; }
  }
  return rings.map((points, index) => {
    const probe = points[0], nestingDepth = rings.filter((other, otherIndex) => otherIndex !== index && pointInRing(probe, other)).length;
    return {points: points.map(point => point.map(round)), signedArea: round(signedArea(points)), role: nestingDepth % 2 ? "hole" : "outer", nestingDepth};
  });
};
const canonicalHash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const byteHash = value => crypto.createHash("sha256").update(value).digest("hex");
const results = {};
for (const text of samples) {
  const run = font.layout(text);
  results[text] = {glyphCount: run.glyphs.length, missingGlyphs: run.glyphs.filter(g => g.id === 0).length, glyphs: run.glyphs.map((glyph, glyphIndex) => ({
    glyphIndex, codePoint: [...text][glyphIndex].codePointAt(0), glyphId: glyph.id, advanceWidth: glyph.advanceWidth,
    position: {xAdvance: run.positions[glyphIndex].xAdvance, yAdvance: run.positions[glyphIndex].yAdvance, xOffset: run.positions[glyphIndex].xOffset, yOffset: run.positions[glyphIndex].yOffset},
    tolerances: Object.fromEntries(tolerances.map(tolerance => { const contours = flattenPath(glyph.path.commands, tolerance); return [String(tolerance), {contourCount: contours.length, holeCount: contours.filter(c => c.role === "hole").length, vertexCount: contours.reduce((sum, c) => sum + c.points.length, 0), maxFlattenErrorFontUnits: tolerance, contours, outlineHash: canonicalHash(contours)}]; }))
  }))};
}
const compact = {font: {path: "public/fonts/Noto Sans KR/NotoSansCJKkr-Regular.otf", sha256: byteHash(fontBytes), byteLength: fontBytes.length, postscriptName: font.postscriptName, fullName: font.fullName, unitsPerEm: font.unitsPerEm, format: "OpenType/CFF", numGlyphs: font.numGlyphs}, tolerances, samples: results};
compact.canonicalHash = canonicalHash(compact);

const panels = []; let panelX = 20;
for (const tolerance of tolerances) for (const text of samples) {
  const run = font.layout(text); let advance = 0; const paths = [];
  run.glyphs.forEach((glyph, index) => { const contours = results[text].glyphs[index].tolerances[String(tolerance)].contours; for (const contour of contours) paths.push(contour.points.map((p, i) => `${i ? "L" : "M"}${round(p[0] + advance)},${round(-p[1])}`).join(" ") + " Z"); advance += run.positions[index].xAdvance; });
  panels.push(`<g transform="translate(${panelX} 920) scale(.42)"><path d="${paths.join(" ")}" fill="#173f55" fill-rule="evenodd" stroke="#d23b3b" stroke-width="2"/><text x="0" y="150" font-family="sans-serif" font-size="64" fill="#111">${text} · tolerance ${tolerance} · ${results[text].glyphs.reduce((n,g)=>n+g.tolerances[String(tolerance)].vertexCount,0)} vertices</text></g>`);
  panelX += text === "호주" ? 900 : 1450;
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="900" viewBox="0 0 2000 900"><rect width="100%" height="100%" fill="#f5f1e7"/><text x="20" y="42" font-family="sans-serif" font-size="28" fill="#111">Noto Sans CJK KR outline flattening probe (even-odd holes)</text><g transform="translate(0 20) scale(.48)">${panels.join("")}</g></svg>`;
fs.mkdirSync(path.join(root, "screenshots"), {recursive: true});
fs.writeFileSync(path.join(root, "reports/fix08-2-font-outline-probe.raw.json"), JSON.stringify(compact, null, 2) + "\n");
fs.writeFileSync(path.join(root, "screenshots/fix08-2-font-outline-probe.svg"), svg);
console.log(JSON.stringify({canonicalHash: compact.canonicalHash, font: compact.font, summary: Object.fromEntries(samples.map(text => [text, {glyphs: results[text].glyphCount, missing: results[text].missingGlyphs, tolerances: Object.fromEntries(tolerances.map(t => [t, {contours: results[text].glyphs.reduce((n,g)=>n+g.tolerances[String(t)].contourCount,0), holes: results[text].glyphs.reduce((n,g)=>n+g.tolerances[String(t)].holeCount,0), vertices: results[text].glyphs.reduce((n,g)=>n+g.tolerances[String(t)].vertexCount,0)}]))}]))}));
