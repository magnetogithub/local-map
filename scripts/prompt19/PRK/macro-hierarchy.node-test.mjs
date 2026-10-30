import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PRK_MACRO_HIERARCHY_LOCK, verifyPrkMacroHierarchy} from './verify-macro-hierarchy.mjs';

const withChangedLock = (change, run) => {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, 'prk-macro-hierarchy-'));
  try {
    const lock = JSON.parse(fs.readFileSync(PRK_MACRO_HIERARCHY_LOCK));
    change(lock);
    const file = path.join(root, 'lock.json');
    fs.writeFileSync(file, JSON.stringify(lock));
    run(file);
  } finally {
    const resolved = fs.realpathSync(root);
    assert.ok(resolved.startsWith(tempParent + path.sep));
    assert.ok(path.basename(resolved).startsWith('prk-macro-hierarchy-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  }
};

test('pinned PRK ADM2 members dissolve exactly into all eleven source macro groups', () => {
  const verified = verifyPrkMacroHierarchy();
  assert.equal(verified.pass, true);
  assert.equal(verified.sourceFeatures, 179);
  assert.equal(verified.assigned, 179);
  assert.equal(verified.macroGroups, 11);
  assert.equal(verified.parentUnionEqual, true);
  assert.ok(verified.parentUnions.every(parent => parent.missingFromChildUnionAreaDegrees2 === 0 && parent.extraOutsideParentAreaDegrees2 === 0));
});

test('a member cannot be reassigned to another macro while retaining valid raw pins', () => {
  withChangedLock(lock => {
    lock.members[0].macroId = lock.macroGroups.find(group => group.macroId !== lock.members[0].macroId).macroId;
  }, file => assert.throws(() => verifyPrkMacroHierarchy(file), /AssertionError/));
});

test('missing and duplicate member identities fail complete-source verification', () => {
  for (const change of [lock => lock.members.pop(), lock => {lock.members[1].sourceFeatureId = lock.members[0].sourceFeatureId;}]) {
    withChangedLock(change, file => assert.throws(() => verifyPrkMacroHierarchy(file), /AssertionError/));
  }
});

test('macro identities must retain the native source ISO value rather than invented codes', () => {
  withChangedLock(lock => {lock.macroGroups[0].macroId = 'macro:PRK:invented';},
    file => assert.throws(() => verifyPrkMacroHierarchy(file), /AssertionError/));
});
