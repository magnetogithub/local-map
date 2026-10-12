import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {recoverCountry} from './prompt15-recovery-candidate.mjs';
import {validatePartitionCoverage} from './prompt14-source-gate.mjs';
test('SVN candidate preserves all 193 identities, components, holes and existing bounds',()=>{
 const r=recoverCountry('SVN');
 assert.equal(r.status,'pass');assert.equal(r.sourceIdentityCount,193);
 assert.ok(Object.values(r.checks).every(Boolean));
 assert.ok(r.coverage.gapArea<r.coverage.tolerance);
 assert.equal(r.evidence.changes.length,2);
 assert.ok(r.evidence.changes.every(c=>c.decision==='oriented-pinned-shared-P1-terminal-boundary'));
});
test('coverage-only success cannot approve source loss; missing/gapped candidates fail',()=>{
 const r=JSON.parse(fs.readFileSync('reports/prompt15/candidates/SVN-first.json','utf8'));
 const removed=validatePartitionCoverage(r.p0.features[0].geometry,r.selected.features.slice(1).map(f=>f.geometry));
 assert.equal(removed.pass,false);
 const wholeCountry=validatePartitionCoverage(r.p0.features[0].geometry,[r.p0.features[0].geometry]);
 assert.equal(wholeCountry.pass,true);
 assert.notEqual(1,r.sourceIdentityCount); // This old fallback passes coverage but fails identity gate.
 const cnm=recoverCountry('CNM');assert.equal(cnm.status,'blocked');assert.equal(cnm.sourceIdentityCount,0);
});
test('historical SVN splits were individually discarded despite aggregate gap exceeding tolerance',()=>{
 const r=JSON.parse(fs.readFileSync('reports/prompt15/15-02-recovery.json','utf8'));
 assert.equal(r.cause.splitSkipProof.rootCauseVerified,true);
 assert.equal(r.cause.splitSkipProof.fragments.length,2);
 assert.ok(r.cause.splitSkipProof.totalSplitArea>r.reproduction.before.tolerance);
});
