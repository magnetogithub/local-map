// Reuse accepted display coordinates after a certified merge. Only IDs and the
// removed boundary change; do not rerun simplification on unrelated borders.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

const option = name => {const i = process.argv.indexOf(name); assert.ok(i >= 0 && process.argv[i + 1], name); return process.argv[i + 1];};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => {const bytes = fs.readFileSync(file); return {path: file.replaceAll('\\', '/'), sha256: sha(bytes), byteLength: bytes.length};};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const checked = p => {assert.deepEqual(pin(p.path), p); return read(p.path);};
const immutable = (file, value) => {const bytes = Buffer.from(JSON.stringify(value) + '\n'); fs.mkdirSync(path.dirname(file), {recursive: true});
  if (fs.existsSync(file)) assert.deepEqual(fs.readFileSync(file), bytes); else fs.writeFileSync(file, bytes, {flag: 'wx'}); return pin(file);};
const pointerPin = pin(option('--pointer')), pointer = checked(pointerPin);
const proofPin = pin(option('--merge-proof')), proof = checked(proofPin);
assert.equal(proof.pass, true);
const bundle = checked(proof.after), correction = bundle.report.manualCellMerge;
const previousPointer = checked(correction.baseline.pointer);
const previousPresentationPin = pin(option('--presentation')), previousPresentation = checked(previousPresentationPin);
const previousDeliveryPin = pin(option('--display')), previousDelivery = checked(previousDeliveryPin);
assert.equal(previousPresentation.catalogRef.catalogVersion, previousPointer.catalogVersion);
assert.equal(previousDelivery.catalogRef.catalogVersion, previousPointer.catalogVersion);
assert.equal(checked(previousDelivery.verification).pass, true);
assert.equal(checked(previousPresentation.independentVerification).pass, true);
const nextCatalog = read(pointer.root + '/catalog.json');
const nextProvenance = read(pointer.root + '/provenance.json');
assert.equal(nextProvenance.inputRoot, proof.after.sha256);
const detail = p => read(p.root + '/detail-index.json');
const edges = p => detail(p).edgeDetails.flatMap(s => JSON.parse(gunzipSync(fs.readFileSync(p.root + '/' + s.artifact.path))).edges);
const oldEdges = new Map(edges(previousPointer).map(e => [e.ordinal, e]));
const newEdges = edges(pointer), edgeOrdinal = new Map(newEdges.map(e => [e.id, e.ordinal]));
const deletedEdges = new Set(correction.operations.flatMap(op => op.removedEdgeIds));
const oldToNewCells = new Map(correction.operations.map(op => [op.mergeIntoCellId, op.mergedCellId]));
const deletedCells = new Set(correction.operations.map(op => op.removeCellId));
const country = detail(pointer).countries.find(c => c.countryId === 'CHN');
const rows = JSON.parse(gunzipSync(fs.readFileSync(pointer.root + '/' + country.metadata.path))).rows;
const cellOrdinal = new Map(rows.map(([n, id]) => [id, n]));
const cells = previousPresentation.cells.filter(c => !deletedCells.has(c.id)).map(c => {
  const id = oldToNewCells.get(c.id) ?? c.id; assert.ok(cellOrdinal.has(id)); return {...c, id, ordinal: cellOrdinal.get(id)};
}).sort((a, b) => a.ordinal - b.ordinal);
assert.equal(cells.length, rows.length);
const remap = category => JSON.parse(gunzipSync(Buffer.from(previousDelivery[category].payloadBase64, 'base64'))).features
  .filter(f => !deletedEdges.has(oldEdges.get(f.id).id)).map(f => {
    const n = edgeOrdinal.get(oldEdges.get(f.id).id); assert.ok(n); return {...f, id: n};
  }).sort((a, b) => a.id - b.id);
const inputs = {pointer: pointerPin, metadata: pin(pointer.root + '/metadata/countries/CHN.json.gz'),
  parents: pin(pointer.root + '/metadata/parents.json.gz'), incidence: pin(pointer.root + '/metadata/edge-incidence.bin.gz'),
  catalog: pin(pointer.root + '/catalog.json'), detailIndex: pin(pointer.root + '/detail-index.json'),
  previousPresentation: previousPresentationPin, previousDelivery: previousDeliveryPin, mergeProof: proofPin};
const province = remap('province'), micro = remap('micro');
const presentation = {schemaVersion: 'chn-province-presentation-v1', countryId: 'CHN', administrativeTruthClaim: false,
  catalogRef: nextCatalog.catalogRef, inputs, provinces: previousPresentation.provinces, cells, addedBoundaryOrdinals: province.map(f => f.id),
  method: 'Retain accepted province memberships by stable cell identity; merged recipient inherits its previous display group. Certified deleted cell and its shared edge are removed.'};
const code = pin('scripts/rebase-contained-merge-display.mjs');
const key = sha(Buffer.from(JSON.stringify({inputs, code}))).slice(0, 20);
const folder = 'data/derived/manual-cell-merges/display-' + key;
const presentationPin = immutable(folder + '/presentation.json', presentation);
const provinceGeometry = immutable(folder + '/province.geojson', {type: 'FeatureCollection', features: province});
const microGeometry = immutable(folder + '/micro.geojson', {type: 'FeatureCollection', features: micro});
const producer = {schemaVersion: 'chn-internal-line-rebase-producer-v1', pass: true, catalogRef: nextCatalog.catalogRef,
  inputs, code, provinceGeometry, microGeometry, presentation: presentationPin,
  policy: 'Exact accepted coordinate reuse with stable-edge-ID remapping; remove only certified merged internal contacts.',
  summary: {provinceEdges: province.length, microEdges: micro.length, deletedEdges: [...deletedEdges]}};
console.log(JSON.stringify({producer: immutable(folder + '/producer-report.json', producer), presentation: presentationPin, summary: producer.summary}));
