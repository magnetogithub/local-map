import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pin = file => {const b = fs.readFileSync(file); return {path: file, sha256: sha(b), byteLength: b.length};};
const checked = p => {const b = fs.readFileSync(p.path); assert.equal(sha(b), p.sha256); assert.equal(b.length, p.byteLength); return b;};
const read = p => JSON.parse(checked(p));
const baselinePin = pin('data/derived/chn-2020/province-render-36da1312a1dd69777275/index.json');
const baseline = read(baselinePin), full = read(baseline.acceptedPresentation), proof = read(baseline.independentVerification);
assert.equal(proof.pass, true); assert.deepEqual(proof.artifact, baseline.acceptedPresentation);
const referencePin = pin('data/source-locks/chn-2020/province-link-references.json'), references = read(referencePin);
assert.equal(references.schemaVersion, 'chn-province-link-references-v1');
assert.equal(references.families.length, 2);
const sources = new Map(read(full.inputs.fineSource).features.map(f => [f.properties.shapeID, f]));
const repairs = [];
for (const reference of references.families) {
  const source = sources.get(reference.sourceFeatureId);
  assert.equal(source.properties.shapeName, reference.sourceName);
  const family = full.families.find(f => f.sourceFeatureId === reference.sourceFeatureId);
  assert.equal(family.renderProvinceId, null);
  const top = family.evidence.positiveProvinceOverlaps[0];
  const province = full.provinces.find(p => p.id === reference.renderProvinceId);
  assert.equal(top.sourceFeatureId, province.sourceFeatureId);
  assert.equal(family.evidence.originalSourceFamilyPresentationEvidence.rawTopProvinceSourceFeatureId, province.sourceFeatureId);
  const cells = full.cells.filter(c => c.sourceFeatureId === reference.sourceFeatureId);
  assert.deepEqual(cells.map(c => c.ordinal), reference.cellOrdinals);
  family.renderProvinceId = reference.renderProvinceId;
  family.method = 'source-hierarchy-display-repair';
  family.displayRepair = {reference: referencePin, previousMethod: 'unresolved',
    basis: 'Official historical parent identity and pinned raw feature corroborate the complete existing gameplay family. Country outlines and game geometry remain unchanged.'};
  for (const cell of cells) {assert.equal(cell.renderProvinceId, null); cell.renderProvinceId = reference.renderProvinceId;}
  repairs.push({sourceFeatureId: reference.sourceFeatureId, renderProvinceId: reference.renderProvinceId, cellOrdinals: reference.cellOrdinals});
}
const incidence = gunzipSync(checked(full.inputs.incidence));
const cells = new Map(full.cells.map(c => [c.ordinal, c])), previousEdges = new Set(full.addedBoundaryOrdinals);
full.addedBoundaryOrdinals = [];
for (let i = 0; i < incidence.length / 8; i++) {
  const a = cells.get(incidence.readUInt32LE(i * 8)), b = cells.get(incidence.readUInt32LE(i * 8 + 4));
  if (a?.renderProvinceId && b?.renderProvinceId && a.renderProvinceId !== b.renderProvinceId) full.addedBoundaryOrdinals.push(i + 1);
}
assert.ok([...previousEdges].every(n => full.addedBoundaryOrdinals.includes(n)));
const added = full.addedBoundaryOrdinals.filter(n => !previousEdges.has(n));
assert.deepEqual(added, [3838, 7152, 7977]);
full.inputs = {...full.inputs, linkRepairReference: referencePin, previousPresentation: baseline.acceptedPresentation, previousPresentationProof: baseline.independentVerification};
full.code = [...full.code, pin('scripts/chn-2020/build-province-link-repair.mjs')];
full.linkRepair = {baseline: baselinePin, reference: referencePin, repairs, addedBoundaryOrdinals: added,
  geometryChanged: false, officialParentsChanged: false, unrelatedMembershipsChanged: false};
full.policy = {...full.policy, candidatePolicy: 'accepted-presentation-plus-explicit-source-parent-link-repairs', linkRepairReference: referencePin};
full.summary = {...full.summary, assignedCells: full.cells.filter(c => c.renderProvinceId !== null).length,
  unassignedCells: full.cells.filter(c => c.renderProvinceId === null).length, addedBoundaryEdges: full.addedBoundaryOrdinals.length,
  unresolvedFineFamilies: full.families.filter(f => f.renderProvinceId === null).length,
  sourceHierarchyDisplayRepairFamilies: full.families.filter(f => f.method === 'source-hierarchy-display-repair').length};
for (const input of Object.values(full.inputs)) checked(input);
const bytes = Buffer.from(JSON.stringify(full) + '\n'), hash = sha(bytes);
const destination = `data/derived/chn-2020/province-presentation-${hash.slice(0, 20)}/presentation.json`;
fs.mkdirSync(path.dirname(destination), {recursive: true});
if (fs.existsSync(destination)) assert.deepEqual(fs.readFileSync(destination), bytes);
else fs.writeFileSync(destination, bytes, {flag: 'wx'});
console.log(JSON.stringify({artifact: pin(destination), repair: full.linkRepair, provinceEdges: full.addedBoundaryOrdinals.length}));
