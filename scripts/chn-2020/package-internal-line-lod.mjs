import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {resolve, relative} from 'node:path';

const root = process.cwd(), args = process.argv.slice(2);
const option = name => {const i = args.indexOf(name); if (i < 0 || !args[i + 1]) throw Error(`MISSING_${name}`); return args[i + 1];};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = path => {const bytes = readFileSync(resolve(root, path)); return {path: relative(root, resolve(root, path)).replaceAll('\\', '/'), sha256: digest(bytes), byteLength: bytes.length};};
const readPin = expected => {
  const actual = pin(expected.path);
  if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) throw Error(`PIN_CHANGED:${expected.path}`);
  return readFileSync(resolve(root, expected.path));
};
const producerPin = pin(option('--producer')), verificationPin = pin(option('--verification'));
const producer = JSON.parse(readPin(producerPin)), verification = JSON.parse(readPin(verificationPin));
if (!producer.pass || producer.schemaVersion !== 'chn-internal-line-lod-producer-v1' || !verification.pass || verification.schemaVersion !== 'chn-internal-line-lod-independent-v1') throw Error('UNACCEPTED_LOD');
for (const [key, identity] of Object.entries(producer.inputs)) {
  for (const entry of Array.isArray(identity) ? identity : [identity]) readPin(entry);
}
readPin(producer.code);
for (const [category, expected] of [['province', producer.provinceGeometry], ['micro', producer.microGeometry]]) {
  if (JSON.stringify(verification.artifacts?.[category]) !== JSON.stringify(expected)) throw Error(`PROOF_OUTPUT_MISMATCH:${category}`);
  readPin(expected);
}
// Do not publish a proof for a different producer or any stale input snapshot.
const samePin = (a, b) => a?.path === b.path && a?.sha256 === b.sha256 && a?.byteLength === b.byteLength;
if (!samePin(verification.producer, producerPin) || !samePin(verification.baselinePointer, producer.inputs.pointer) ||
    JSON.stringify(verification.baseCatalogRef) !== JSON.stringify(producer.catalogRef)) throw Error('PROOF_PRODUCER_MISMATCH');
for (const identity of verification.sourcePins ?? []) readPin(identity);
readPin(verification.verifier);
const display = {};
for (const [category, identity] of [['province', producer.provinceGeometry], ['micro', producer.microGeometry]]) {
  const raw = readPin(identity), data = JSON.parse(raw), compressed = gzipSync(raw, {level: 9});
  const sha256 = digest(compressed), coordinates = data.features.flatMap(f => f.geometry.coordinates);
  if (data.features.some((f, i) => f.geometry.type !== 'LineString' || !Number.isInteger(f.id) || (i && f.id <= data.features[i - 1].id))) throw Error('INVALID_DISPLAY_ARCS');
  display[category] = {
    artifact: {path: `display/chn-${category}-lines-${sha256}.geojson.gz`, sha256, byteLength: compressed.length},
    // Decimal strings survive JSON-module parsers that round binary64 literals differently.
    bounds: coordinates.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]).map(String),
    minZoom: 2.2, maxZoom: 7, edgeOrdinals: data.features.map(f => f.id), payloadBase64: compressed.toString('base64'),
  };
}
const value = {schemaVersion: 'chn-boundary-display-delivery-v1', catalogRef: producer.catalogRef, producer: producerPin,
  verification: verificationPin, inputs: producer.inputs, ...display};
const bytes = Buffer.from(JSON.stringify(value) + '\n'), hash = digest(bytes);
const folder = `data/derived/chn-2020/internal-line-delivery-${hash.slice(0, 20)}`, path = `${folder}/delivery.json`;
if (existsSync(resolve(root, path))) {
  if (!readFileSync(resolve(root, path)).equals(bytes)) throw Error('IMMUTABLE_OUTPUT_CHANGED');
} else {mkdirSync(resolve(root, folder), {recursive: true}); writeFileSync(resolve(root, path), bytes);}
process.stdout.write(JSON.stringify({artifact: pin(path), province: {...display.province, payloadBase64: undefined}, micro: {...display.micro, edgeOrdinals: display.micro.edgeOrdinals.length, payloadBase64: undefined}}) + '\n');
