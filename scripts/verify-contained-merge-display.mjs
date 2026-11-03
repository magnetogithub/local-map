import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

const option = name => {const i = process.argv.indexOf(name); assert.ok(i >= 0 && process.argv[i + 1]); return process.argv[i + 1];};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pin = file => {const b = fs.readFileSync(file); return {path: file.replaceAll('\\', '/'), sha256: sha(b), byteLength: b.length};};
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const checked = p => {assert.deepEqual(pin(p.path), p); return read(p.path);};
const producerPin = pin(option('--producer')), producer = checked(producerPin);
assert.equal(producer.schemaVersion, 'chn-internal-line-rebase-producer-v1');
const inputs = producer.inputs, pointer = checked(inputs.pointer), mergeProof = checked(inputs.mergeProof);
assert.equal(mergeProof.pass, true);
const bundle = checked(mergeProof.after), correction = bundle.report.manualCellMerge;
const oldPointer = checked(correction.baseline.pointer), oldPresentation = checked(inputs.previousPresentation), oldDisplay = checked(inputs.previousDelivery);
assert.equal(checked(oldDisplay.verification).pass, true);
assert.equal(checked(oldPresentation.independentVerification).pass, true);
const actualIndex = checked({path: pointer.root + '/artifact-index.json', ...pointer.index});
for (const p of actualIndex.artifacts) assert.deepEqual(pin(pointer.root + '/' + p.path), {...p, path: pointer.root + '/' + p.path});
const detail = p => read(p.root + '/detail-index.json');
const edges = p => detail(p).edgeDetails.flatMap(s => JSON.parse(gunzipSync(fs.readFileSync(p.root + '/' + s.artifact.path))).edges);
const oldEdges = edges(oldPointer), nextEdges = edges(pointer);
const oldByOrdinal = new Map(oldEdges.map(e => [e.ordinal, e])), newById = new Map(nextEdges.map(e => [e.id, e]));
const deletedEdges = new Set(correction.operations.flatMap(op => op.removedEdgeIds));
assert.equal(nextEdges.length, oldEdges.length - deletedEdges.size);
for (const e of oldEdges) {
  if (deletedEdges.has(e.id)) {assert.equal(newById.has(e.id), false); continue;}
  assert.deepEqual(newById.get(e.id).geometry, e.geometry, 'UNRELATED_EDGE_COORDINATES_CHANGED');
}
const nextMeta = JSON.parse(gunzipSync(fs.readFileSync(inputs.metadata.path))).rows;
const cellOrdinals = new Map(nextMeta.map(([n, id]) => [id, n]));
const removed = new Set(correction.operations.map(op => op.removeCellId));
const replaced = new Map(correction.operations.map(op => [op.mergeIntoCellId, op.mergedCellId]));
const expectedCells = oldPresentation.cells.filter(row => !removed.has(row.id)).map(row => {
  const id = replaced.get(row.id) ?? row.id;
  return {...row, id, ordinal: cellOrdinals.get(id)};
}).sort((a, b) => a.ordinal - b.ordinal);
const presentation = checked(producer.presentation);
assert.deepEqual(presentation.cells, expectedCells);
assert.deepEqual(presentation.provinces, oldPresentation.provinces);
assert.equal(presentation.cells.length, nextMeta.length);
const groups = new Map(presentation.cells.map(c => [c.ordinal, c.renderProvinceId]));
const newCatalog = checked(inputs.catalog);
assert.deepEqual(presentation.catalogRef, newCatalog.catalogRef);
assert.deepEqual(producer.catalogRef, newCatalog.catalogRef);
const kinds = {};
for (const kind of ['province', 'micro']) {
  const previous = JSON.parse(gunzipSync(Buffer.from(oldDisplay[kind].payloadBase64, 'base64')));
  const expected = previous.features.filter(f => !deletedEdges.has(oldByOrdinal.get(f.id).id))
    .map(f => ({...f, id: newById.get(oldByOrdinal.get(f.id).id).ordinal})).sort((a, b) => a.id - b.id);
  const current = checked(producer[kind + 'Geometry']);
  assert.deepEqual(current.features, expected, 'DISPLAY_COORDINATES_OR_SCOPE_CHANGED');
  kinds[kind] = current.features.map(f => f.id);
}
const classifiedProvince = nextEdges.filter(e => groups.get(e.left) != null && groups.get(e.right) != null && groups.get(e.left) !== groups.get(e.right)).map(e => e.ordinal);
const provinceIds = new Set(classifiedProvince);
const classifiedMicro = nextEdges.filter(e => e.right && cellOrdinals.size && groups.has(e.left) && groups.has(e.right) && !provinceIds.has(e.ordinal)).map(e => e.ordinal);
assert.deepEqual(kinds.province, classifiedProvince);
assert.deepEqual(kinds.micro, classifiedMicro);
assert.deepEqual(presentation.addedBoundaryOrdinals, classifiedProvince);
for (const p of Object.values(inputs)) assert.deepEqual(pin(p.path), p);
assert.deepEqual(pin(producer.code.path), producer.code);
const proof = {schemaVersion: 'chn-internal-line-rebase-independent-v1', pass: true, producer: producerPin,
  baselinePointer: inputs.pointer, baseCatalogRef: producer.catalogRef,
  artifact: producer.presentation, artifacts: {province: producer.provinceGeometry, micro: producer.microGeometry},
  sourcePins: Object.values(inputs), verifier: pin('scripts/verify-contained-merge-display.mjs'),
  summary: {cells: presentation.cells.length, provinceEdges: kinds.province.length, microEdges: kinds.micro.length,
    removedEdges: [...deletedEdges], unchangedDisplayCoordinates: true, preservedOtherCellsAndGroups: true}};
const out = option('--output');
fs.writeFileSync(out, JSON.stringify(proof) + '\n');
console.log(JSON.stringify({proof: pin(out), summary: proof.summary}));
