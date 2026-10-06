import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import polygonClipping from "polygon-clipping";
import {sha256, validatePolygonFeatureCollection, VALIDATOR_POLICY, normalizeCountryId} from "./prompt14-source-gate.mjs";

export const REPAIR_POLICY = Object.freeze({
  version: "prompt14-lossless-ring-normalization-v1",
  generatorVersion: "prompt14-derived-input-v1",
  operations: ["remove exact consecutive duplicate positions", "reverse ring winding to source-specific policy"],
  coordinatePrecision: "preserve every original IEEE-754 coordinate; no rounding or quantization",
  areaAbsoluteToleranceDegreesSquared: 1e-9,
  areaRelativeTolerance: 1e-12,
  boundaryDisplacementTolerance: 0,
  coverageRule: "same ordered features, properties, geometry types, components, holes and undirected nonzero segment multiset per ring",
  forbidden: ["union", "buffer", "make-valid", "snap", "simplify", "delete feature/component/hole", "fill gaps", "split countries", "move coordinates"],
  failureConditions: ["source digest mismatch", "non-determinism", "feature/identity/type/ring/segment changes", "area tolerance exceeded", "remaining validator errors"],
  topologyPolicy: "Any remaining defect requires independently justified, versioned topology repair or replacement source; blocked, never silently repaired.",
});
const polys = (g) => g.type === "Polygon" ? [g.coordinates] : g.coordinates;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
const area = (r) => r.slice(0, -1).reduce((s, p, i) => s + p[0]*r[i+1][1]-r[i+1][0]*p[1], 0)/2;
const segments = (r) => r.slice(1).flatMap((b, i) => {
  const a = r[i];
  if (same(a,b)) return [];
  return [[JSON.stringify(a), JSON.stringify(b)].sort().join("|")];
}).sort();
export function normalizeCollection(source, policy = VALIDATOR_POLICY) {
  const output = structuredClone(source);
  for (const f of output.features) for (const p of polys(f.geometry)) p.forEach((r, i) => {
    const clean = r.filter((v, j) => j === 0 || !same(v, r[j-1]));
    const winding = i === 0 ? policy.exteriorWinding : policy.interiorWinding;
    if ((area(clean) > 0) !== (winding === "counterclockwise")) clean.reverse();
    p[i] = clean;
  });
  return output;
}
export function verifyRepair(source, output, firstBytes, secondBytes, policy = VALIDATOR_POLICY) {
  const errors = [];
  let maximumAreaDelta = 0;
  if (!Buffer.from(firstBytes).equals(Buffer.from(secondBytes))) errors.push("non-deterministic derived bytes");
  if (source.features.length !== output.features.length) errors.push("feature count changed");
  source.features.forEach((f, i) => {
    const g = output.features[i];
    if (!g || JSON.stringify({...f, geometry: null}) !== JSON.stringify({...g, geometry: null}) || f.geometry.type !== g.geometry.type) { errors.push(`feature ${i}: identity/properties/type changed`); return; }
    const before = polys(f.geometry), after = polys(g.geometry);
    if (before.length !== after.length) errors.push(`feature ${i}: component count changed`);
    before.forEach((p,j) => {
      if (!after[j] || p.length !== after[j].length) { errors.push(`feature ${i}: ring count changed`); return; }
      p.forEach((r,k) => {
        const delta = Math.abs(Math.abs(area(r))-Math.abs(area(after[j][k])));
        maximumAreaDelta = Math.max(maximumAreaDelta,delta);
        if (!Number.isFinite(delta) || delta > Math.max(REPAIR_POLICY.areaAbsoluteToleranceDegreesSquared, Math.abs(area(r))*REPAIR_POLICY.areaRelativeTolerance)) errors.push(`feature ${i}: area changed`);
        if (JSON.stringify(segments(r)) !== JSON.stringify(segments(after[j][k]))) errors.push(`feature ${i}: boundary/coverage changed`);
      });
    });
  });
  const validation = validatePolygonFeatureCollection(output,"derived",policy);
  return {pass: errors.length === 0 && validation.pass, invariantsPass: errors.length === 0, errors, maximumAreaDeltaDegreesSquared: maximumAreaDelta, boundaryDisplacement: errors.length ? null : 0, coveragePreserved: errors.length === 0, validation};
}
export function classifyErrors(validation, collection, parentEntries = []) {
  return validation.errors.map(message => {
    const index = Number(message.match(/features\[(\d+)\]/)?.[1]);
    const p = collection.features[index]?.properties ?? {};
    const topologyWitness = /boolean-valid|JSTS/.test(message) ? diagnoseRingTopology(collection.features[index]?.geometry) : null;
    return {featureIndex: index, sourceFeatureId: String(p.ne_id ?? p.NE_ID ?? p.adm1_code ?? p.countryId ?? index), countryId: p.countryId ?? parentEntries[index]?.normalizedParentCountryId ?? normalizeCountryId(p.ADM0_A3 ?? p.adm0_a3), category: /duplicate|must be clockwise|must be counterclockwise/.test(message) ? "normalization-rule" : topologyWitness?.confirmedNonSimpleRing ? "geometry-defect-non-simple-ring" : /boolean-valid|JSTS/.test(message) ? "topology-validator-rejection-requires-diagnosis" : "structural-or-containment-defect", topologyWitness, message};
  });
}
function diagnoseRingTopology(geometry) {
  if (!geometry) return null;
  for (const [polygonIndex,p] of polys(geometry).entries()) for (const [ringIndex,r] of p.entries()) {
    const seen = new Map();
    for (let i=0;i<r.length-1;i++) {
      const key = JSON.stringify(r[i]);
      if (seen.has(key) && i-seen.get(key)>1) return {confirmedNonSimpleRing:true,cause:"non-adjacent repeated vertex / ring self-touch",polygonIndex,ringIndex,vertexIndices:[seen.get(key),i],coordinate:r[i],repair:"topology alteration requires external justification; blocked"};
      seen.set(key,i);
    }
  }
  return {confirmedNonSimpleRing:false,cause:"No non-adjacent repeated vertex found; Turf may reject a spike/puncture, intersecting holes or component interference. Independent topology diagnosis required; no inferred pass."};
}
export function buildDerived(root, repositoryPath, expectedHash, policy, parentEntries = []) {
  const raw = fs.readFileSync(path.join(root,repositoryPath));
  if (sha256(raw) !== expectedHash) throw new Error(`source digest mismatch: ${repositoryPath}`);
  const source = JSON.parse(raw);
  const first = normalizeCollection(source,policy), second = normalizeCollection(source,policy);
  const firstBytes = Buffer.from(JSON.stringify(first)+"\n"), secondBytes = Buffer.from(JSON.stringify(second)+"\n");
  const verification = verifyRepair(source,first,firstBytes,secondBytes,policy);
  const target = `data/derived/prompt14/${path.basename(repositoryPath)}`;
  fs.mkdirSync(path.join(root,"data/derived/prompt14"),{recursive:true});
  fs.writeFileSync(path.join(root,target),firstBytes);
  const before = validatePolygonFeatureCollection(source,"source",policy);
  return {collection: first, evidence: {source: {repositoryPath,sha256:sha256(raw),byteLength:raw.length}, derived: {repositoryPath:target,sha256:sha256(firstBytes),byteLength:firstBytes.length}, policy:REPAIR_POLICY, generator: {repositoryPath:"scripts/prompt14-repair.mjs",sha256:sha256(fs.readFileSync(path.join(root,"scripts/prompt14-repair.mjs")))}, status: verification.pass ? "pass" : "blocked", before: {...before, diagnostics:classifyErrors(before,source,parentEntries)}, after: {...verification, diagnostics:classifyErrors(verification.validation,first,parentEntries)}}};
}

// Execute only the existing pure geometry definitions, never the asset-writing script.
export function verifyP0Lineage(root) {
  const codeBytes = fs.readFileSync(path.join(root,"scripts/prepare-map-data.mjs"));
  const code = codeBytes.toString("utf8");
  const definitions = code.slice(code.indexOf("const round="),code.indexOf("const ringArea="));
  const normalize = code.slice(code.indexOf("function normalizeCountries("),code.indexOf("const country50="));
  const metadataBytes = fs.readFileSync(path.join(root,"src/data/countries-2020.json"));
  const rawBytes = fs.readFileSync(path.join(root,"data/raw/ne_10m_admin_0_countries.geojson"));
  const current = fs.readFileSync(path.join(root,"public/data/maps/countries-10m.geojson"));
  const generated = vm.runInNewContext(`${definitions}\nconst byId=new Map(metadata.map(c=>[c.id,c]));\n${normalize}\nJSON.stringify(normalizeCountries(raw,.0015))+"\\n"`,{polygonClipping, metadata:JSON.parse(metadataBytes), raw:JSON.parse(rawBytes)}, {timeout:120000});
  const bytes = Buffer.from(generated);
  const windowsBytes = Buffer.from(generated.replace(/\n/g,"\r\n"));
  return {pass:bytes.equals(current) || windowsBytes.equals(current), byteTransformation:bytes.equals(current) ? "UTF-8 LF" : windowsBytes.equals(current) ? "UTF-8; existing checkout LF to CRLF conversion" : "unexplained mismatch", raw:{repositoryPath:"data/raw/ne_10m_admin_0_countries.geojson",sha256:sha256(rawBytes),byteLength:rawBytes.length}, code:{repositoryPath:"scripts/prepare-map-data.mjs",sha256:sha256(codeBytes),byteLength:codeBytes.length}, metadata:{repositoryPath:"src/data/countries-2020.json",sha256:sha256(metadataBytes),byteLength:metadataBytes.length}, operations:"5 decimal rounding; distance simplification .0015 degrees; ID overrides; exclusions; country dissolve union; KAS/KAB mask differences. Existing transform replay only, not newly authorized topology repair.", replay:{sha256:sha256(bytes),byteLength:bytes.length,windowsSha256:sha256(windowsBytes),windowsByteLength:windowsBytes.length}, current:{sha256:sha256(current),byteLength:current.length}, legal2020Proven:false};
}
