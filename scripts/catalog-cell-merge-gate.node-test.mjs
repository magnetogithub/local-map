import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {acceptContainedCellMerge} from './catalog-cell-merge-gate.mjs';

const folder = 'reports/tianjin-detached-parcel-audit-20261103/';
const proofBytes = fs.readFileSync(folder + 'merge-verification.json');
const proof = JSON.parse(proofBytes), inputBytes = fs.readFileSync(proof.after.path), bundle = JSON.parse(inputBytes);
const digest = b => createHash('sha256').update(b).digest('hex');
const checkedPin = p => {const bytes = fs.readFileSync(p.path); assert.equal(digest(bytes), p.sha256); assert.equal(bytes.length, p.byteLength); return bytes;};
const run = (value = proof, candidate = bundle, bytes = inputBytes) => acceptContainedCellMerge({bundle: candidate, inputBytes: bytes, proofBytes: Buffer.from(JSON.stringify(value)), checkedPin, digest});

test('accepts the actual certified one-cell merge against its indexed admitted input', () => {
  assert.equal(run().baselinePointer.catalogVersion, 'catalog-v3-prompt19-incremental-CHN-95ea496a8aa66910a9a7');
});
test('rejects changed input bytes, missing geometric acceptance and stale source pins', () => {
  assert.throws(() => run(proof, bundle, Buffer.from('changed')), /UNVERIFIED/);
  for (const field of ['scope', 'coverage', 'topology', 'lineage', 'sourcePreservation', 'reproducibility']) {
    assert.throws(() => run({...proof, checks: {...proof.checks, [field]: false}}), /MISSING_CELL_MERGE_ACCEPTANCE/);
  }
  const bad = structuredClone(bundle);
  bad.report.manualCellMerge.code[0].sha256 = '0'.repeat(64);
  assert.throws(() => run(proof, bad));
  assert.throws(() => run({...proof, after: {...proof.after, sha256: '0'.repeat(64)}}), /UNVERIFIED/);
});
