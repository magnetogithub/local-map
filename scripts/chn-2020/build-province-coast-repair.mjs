import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pin = file => {const b = fs.readFileSync(file); return {path: file, sha256: sha(b), byteLength: b.length};};
const checked = p => {const b = fs.readFileSync(p.path); assert.equal(sha(b), p.sha256); assert.equal(b.length, p.byteLength); return b;};
const read = p => JSON.parse(checked(p));
const baselinePin = pin('data/derived/chn-2020/province-render-f1c91c059cdb06f5234f/index.json');
const baseline = read(baselinePin), full = read(baseline.acceptedPresentation), proof = read(baseline.independentVerification);
assert.equal(proof.pass, true); assert.deepEqual(proof.artifact, baseline.acceptedPresentation);
const referencePin = pin('data/source-locks/chn-2020/binhai-province-display-reference.json'), reference = read(referencePin);
const source = read(full.inputs.fineSource).features.find(f => f.properties.shapeID === reference.sourceFeatureId);
assert.equal(source.properties.shapeName, reference.sourceName);
const family = full.families.find(f => f.sourceFeatureId === reference.sourceFeatureId);
assert.equal(family.renderProvinceId, null);
assert.equal(family.evidence.originalSourceFamilyPresentationEvidence.rawTopProvinceSourceFeatureId, 'CHN-ADM1-3_0_0-B24');
assert.ok(family.evidence.originalSourceFamilyPresentationEvidence.rawTopShare > .999999);
const oldFamily = structuredClone(family);
family.renderProvinceId = reference.renderProvinceId;
family.method = 'source-hierarchy-display-repair';
family.displayRepair = {reference: referencePin, previousMethod: oldFamily.method,
  basis: 'Official parent identity corroborated by the pinned raw feature and ADM1 containment; inherit over existing game adjustments without changing their geometry.'};
const changedCells = full.cells.filter(c => c.sourceFeatureId === reference.sourceFeatureId);
assert.equal(changedCells.length, 2);
for (const cell of changedCells) {assert.equal(cell.renderProvinceId, null); cell.renderProvinceId = reference.renderProvinceId;}
const pointerPin = full.inputs.pointer, pointer = read(pointerPin);
const incidence = gunzipSync(fs.readFileSync(full.inputs.incidence.path));
assert.equal(sha(fs.readFileSync(full.inputs.incidence.path)), full.inputs.incidence.sha256);
const byOrdinal = new Map(full.cells.map(c => [c.ordinal, c]));
const previousEdges = new Set(full.addedBoundaryOrdinals);
full.addedBoundaryOrdinals = [];
for (let i = 0; i < incidence.length / 8; i++) {
  const a = byOrdinal.get(incidence.readUInt32LE(i * 8)), b = byOrdinal.get(incidence.readUInt32LE(i * 8 + 4));
  if (a?.renderProvinceId && b?.renderProvinceId && a.renderProvinceId !== b.renderProvinceId) full.addedBoundaryOrdinals.push(i + 1);
}
assert.ok([...previousEdges].every(n => full.addedBoundaryOrdinals.includes(n)));
// The unchanged memberships retain their accepted proof. Historical overlap
// diagnostics may be archived; this correction independently checks its raw family.
full.inputs = {...Object.fromEntries(['pointer', 'index', 'metadata', 'parents', 'hierarchy', 'fineSource', 'provinceSource', 'incidence', 'geometry'].map(k => [k, full.inputs[k]])),
  displayRepairReference: referencePin, previousPresentation: baseline.acceptedPresentation, previousPresentationProof: baseline.independentVerification};
full.code = [...full.code, pin('scripts/chn-2020/build-province-coast-repair.mjs')];
full.displayRepair = {baseline: baselinePin, reference: referencePin, sourceFeatureId: reference.sourceFeatureId,
  changedCellOrdinals: changedCells.map(c => c.ordinal), addedBoundaryOrdinals: full.addedBoundaryOrdinals.filter(n => !previousEdges.has(n)),
  geometryChanged: false, officialParentsChanged: false, unrelatedMembershipsChanged: false};
full.policy = {...full.policy, candidatePolicy: 'accepted-v2-plus-explicit-source-parent-display-repair', displayRepairReference: referencePin};
// Audits of the old edge classification remain available through the baseline.
delete full.boundaryAudit;
delete full.boundaryAuditInputs;
full.summary = {...full.summary, assignedCells: full.cells.filter(c => c.renderProvinceId !== null).length,
  unassignedCells: full.cells.filter(c => c.renderProvinceId === null).length, addedBoundaryEdges: full.addedBoundaryOrdinals.length,
  unresolvedFineFamilies: full.families.filter(f => f.renderProvinceId === null).length, sourceHierarchyDisplayRepairFamilies: 1};
for (const input of Object.values(full.inputs)) checked(input);
const bytes = Buffer.from(JSON.stringify(full) + '\n'), hash = sha(bytes);
const destination = `data/derived/chn-2020/province-presentation-${hash.slice(0, 20)}/presentation.json`;
fs.mkdirSync(path.dirname(destination), {recursive: true});
if (fs.existsSync(destination)) assert.deepEqual(fs.readFileSync(destination), bytes);
else fs.writeFileSync(destination, bytes, {flag: 'wx'});
console.log(JSON.stringify({artifact: pin(destination), catalogVersion: pointer.catalogVersion, repair: full.displayRepair, provinceEdges: full.addedBoundaryOrdinals.length}));
