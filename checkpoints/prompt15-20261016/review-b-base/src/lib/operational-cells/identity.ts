import {createHash} from "node:crypto";
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import IsValidOp from "jsts/org/locationtech/jts/operation/valid/IsValidOp.js";
import {z} from "zod";
import {
  artifactPinSchema, cellIdSchema, generationProvenanceSchema, geometryProvenanceSchema,
  geometrySchema, refinementFaceSchema, sha256Schema,
} from "./model.ts";

/** Offline only. Exact noded metre coordinates; no rounding, simplification,
 * re-projection, collinear-node removal, cutting or source repair. */
export const CELL_CANONICALIZATION_VERSION = "prompt15-exact-noded-polygon-v1";
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const sha256Bytes = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** Sorted UTF-16 keys, ECMAScript finite-number JSON representation, UTF-8 hash.
 * No locale collation or Unicode folding: source identities remain exact. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  const encode = (v: unknown): string => {
    if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" && Number.isFinite(v)) return JSON.stringify(v === 0 ? 0 : v);
    if (!v || typeof v !== "object" || active.has(v)) throw new Error("NON_CANONICAL_JSON");
    active.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw new Error("NON_CANONICAL_JSON");
      result = `[${v.map(encode).join(",")}]`;
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error("NON_CANONICAL_JSON");
      result = `{${Object.keys(v).sort(compareText).map(k => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k])}`).join(",")}}`;
    }
    active.delete(v);
    return result;
  };
  return encode(value);
}

type Point = [number, number];
type Ring = Point[];
const comparePoint = (a: Point, b: Point) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
const compareRing = (a: Ring, b: Ring) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const c = comparePoint(a[i], b[i]);
    if (c) return c;
  }
  return a.length - b.length;
};
function canonicalRing(ring: Ring): Ring {
  const open = ring.slice(0, -1).map(p => p.map(n => n === 0 ? 0 : n) as Point);
  // Valid rings cannot repeat a vertex except closure. Select the unique
  // lexicographic minimum, then compare both directions. O(vertices).
  let start = 0;
  for (let i = 1; i < open.length; i++) if (comparePoint(open[i], open[start]) < 0) start = i;
  const forward = open.map((_, i) => open[(start + i) % open.length]);
  const backward = open.map((_, i) => open[(start - i + open.length) % open.length]);
  const chosen = compareRing(forward, backward) <= 0 ? forward : backward;
  return [...chosen, [...chosen[0]] as Point];
}

/** Polygon and singleton MultiPolygon share an identity. Shell/hole roles are
 * retained; only ring orientation/start, hole order and component order vary. */
export function canonicalizeCellGeometry(value: unknown) {
  const geometry = geometrySchema.parse(value);
  const jts = new GeoJSONReader(new GeometryFactory()).read(geometry);
  if (jts.isEmpty() || !new IsValidOp(jts).isValid() || !(jts.getArea() > 0)) throw new Error("INVALID_CELL_GEOMETRY");
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const polygon of polygons) for (const ring of polygon) {
    // Reject redundant closure/zero edges instead of silently deleting nodes.
    const vertices = ring.slice(0, -1).map(p => canonicalJson(p));
    if (new Set(vertices).size !== vertices.length) throw new Error("REPEATED_CELL_VERTEX");
  }
  const coordinates = polygons.map(p => [canonicalRing(p[0]), ...p.slice(1).map(canonicalRing)
    .sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)))])
    .sort((a, b) => compareText(canonicalJson(a), canonicalJson(b)));
  return {type: "MultiPolygon" as const, coordinates};
}

export const identityProvenanceSchema = z.strictObject({
  // Keep raw source, approved/aligned polygon and correspondence distinct.
  source: geometryProvenanceSchema,
  envelope: geometryProvenanceSchema,
  previousGeometry: artifactPinSchema,
  generation: generationProvenanceSchema,
}).superRefine((v, ctx) => {
  const names = v.generation.dependencies.map(d => d.name);
  if (new Set(names).size !== names.length) ctx.addIssue({code: "custom", message: "Duplicate dependency"});
});
export type IdentityProvenance = z.infer<typeof identityProvenanceSchema>;

// Paths are retrieval locations, never immutable content identity. Retain them
// in provenance, but hash SHA256 + byteLength so isolated checkouts agree.
const contentPin = (p: z.infer<typeof artifactPinSchema>) => ({sha256: p.sha256, byteLength: p.byteLength});
function contentProvenance(p: IdentityProvenance) {
  const geometryPins = (g: IdentityProvenance["source"]) => ({rawSource: contentPin(g.rawSource),
    approvedGeometry: contentPin(g.approvedGeometry), correspondence: contentPin(g.correspondence)});
  const g = p.generation;
  return {source: geometryPins(p.source), envelope: geometryPins(p.envelope), previousGeometry: contentPin(p.previousGeometry),
    generation: {policy: {version: g.policy.version, artifact: contentPin(g.policy.artifact)},
      generator: {version: g.generator.version, artifact: contentPin(g.generator.artifact)},
      projection: {id: g.projection.id, unit: g.projection.unit, definition: contentPin(g.projection.definition)},
      dependencies: g.dependencies.map(d => ({name: d.name, version: d.version, artifact: contentPin(d.artifact)}))}};
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const cellIdentityRecordSchema = z.strictObject({
  version: z.literal(1), canonicalizationVersion: z.literal(CELL_CANONICALIZATION_VERSION),
  id: cellIdSchema, canonicalGeometrySha256: sha256Schema, immutableInputSha256: sha256Schema,
  provenance: identityProvenanceSchema,
});

/** Accept a cell/face carrying mutable state or prototype ordinals, but project
 * ONLY these explicit immutable fields. Mutable state is never serialized. */
export function createCellIdentity(value: unknown, provenanceValue: unknown) {
  if (!value || typeof value !== "object") throw new Error("INVALID_CELL_FACE");
  const v = value as Record<string, unknown>;
  const face = refinementFaceSchema.parse({sourceCountryId: v.sourceCountryId,
    administrativeParent: v.administrativeParent, previousGeometryParent: v.previousGeometryParent, geometry: v.geometry});
  const provenance = identityProvenanceSchema.parse(provenanceValue);
  provenance.generation.dependencies.sort((a, b) => compareText(a.name, b.name));
  const geometry = canonicalizeCellGeometry(face.geometry);
  const canonicalGeometrySha256 = sha256Bytes(canonicalJson([CELL_CANONICALIZATION_VERSION, geometry]));
  const admin = face.administrativeParent;
  const administrativeParent = admin.kind === "administrative-region" ? admin :
    {...admin, evidence: contentPin(admin.evidence)};
  const immutable = {sourceCountryId: face.sourceCountryId, administrativeParent,
    previousGeometryParent: face.previousGeometryParent, canonicalGeometrySha256,
    provenance: contentProvenance(provenance)};
  const immutableInputSha256 = sha256Bytes(canonicalJson(["prompt15-cell-immutable-input-v1", immutable]));
  const id = `territory:catalog:${sha256Bytes(canonicalJson(["prompt15-operational-cell-id-v1", CELL_CANONICALIZATION_VERSION, immutableInputSha256]))}`;
  return freeze(cellIdentityRecordSchema.parse({version: 1, canonicalizationVersion: CELL_CANONICALIZATION_VERSION,
    id, canonicalGeometrySha256, immutableInputSha256, provenance}));
}

/** Deterministic offline index; a duplicate is an error, never deduplicated. */
export function createCellIdentitySet(inputs: readonly {face: unknown; provenance: unknown}[]) {
  const records = inputs.map(v => createCellIdentity(v.face, v.provenance)).sort((a, b) => compareText(a.id, b.id));
  if (new Set(records.map(r => r.id)).size !== records.length) throw new Error("DUPLICATE_CELL_IDENTITY");
  return freeze(records);
}

export function verifyCellIdentity(recordValue: unknown, face: unknown, provenance: unknown) {
  const record = cellIdentityRecordSchema.parse(recordValue);
  const expected = createCellIdentity(face, provenance);
  if (canonicalJson(record) !== canonicalJson(expected)) throw new Error("CELL_IDENTITY_MISMATCH");
  return expected;
}

/** Caller supplies bytes from the assigned candidate; no implicit filesystem,
 * global cache, network, process locale, clock, random seed or runtime world. */
export function verifyArtifactBytes(pinValue: unknown, bytes: Uint8Array) {
  const pin = artifactPinSchema.parse(pinValue);
  if (bytes.byteLength !== pin.byteLength || sha256Bytes(bytes) !== pin.sha256) throw new Error("ARTIFACT_PIN_MISMATCH");
  return freeze(pin);
}
