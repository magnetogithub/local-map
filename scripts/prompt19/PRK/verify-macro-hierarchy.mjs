// Offline hierarchy proof for the fixed, same-publisher PRK ADM1/ADM2 inputs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import clipping from 'polygon-clipping';
import {digest, geometryMetadata, polygons} from '../../prompt14-catalog-core.mjs';

export const PRK_MACRO_HIERARCHY_LOCK = 'data/source-locks/prompt19/PRK-macro-hierarchy.json';
const read = file => JSON.parse(fs.readFileSync(file));
const checked = artifact => {
  const bytes = fs.readFileSync(artifact.path);
  assert.equal(bytes.length, artifact.byteLength, artifact.path);
  assert.equal(digest(bytes), artifact.sha256, artifact.path);
  return bytes;
};
const area = parts => parts.length ? geometryMetadata({type: 'MultiPolygon', coordinates: parts}).area : 0;
const bboxOverlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];

export function verifyPrkMacroHierarchy(lockPath = PRK_MACRO_HIERARCHY_LOCK) {
  const lock = read(lockPath);
  assert.equal(lock.schemaVersion, 'prompt19-fine-macro-hierarchy-v1');
  assert.equal(lock.countryId, 'PRK');
  lock.artifacts.forEach(checked);
  lock.preprocessing.code.forEach(checked);
  const fineLock = JSON.parse(checked(lock.fineSourceLock));
  assert.equal(fineLock.countryId, 'PRK');
  assert.equal(fineLock.sources.length, 1);
  const fineSource = fineLock.sources[0];
  const children = JSON.parse(checked(fineSource.artifact)).features;
  const parentInput = lock.sourceAdmin1;
  const parents = JSON.parse(checked(parentInput.artifact)).features.map(feature => ({feature, bbox: geometryMetadata(feature.geometry).bbox}));
  const metadata = JSON.parse(checked(parentInput.metadata));
  assert.equal(metadata.boundaryID, 'PRK-ADM1-3916807');
  assert.equal(metadata.boundaryISO, 'PRK');
  assert.equal(metadata.boundaryYear, '2018');
  assert.equal(metadata.boundaryType, 'ADM1');
  assert.equal(children.length, 179);
  assert.equal(parents.length, 11);
  assert.equal(lock.members.length, children.length);
  assert.equal(lock.macroGroups.length, parents.length);
  const members = new Map(lock.members.map(member => [member.sourceFeatureId, member]));
  const groups = new Map(lock.macroGroups.map(group => [group.sourceFeatureId, group]));
  assert.equal(members.size, children.length);
  assert.equal(groups.size, parents.length);
  const childrenByParent = new Map(parents.map(({feature}) => [feature.properties.shapeID, []]));
  for (const {feature} of parents) {
    const p = feature.properties, group = groups.get(p.shapeID);
    assert.equal(p.shapeGroup, 'PRK');
    assert.equal(p.shapeType, 'ADM1');
    assert.match(p.shapeISO, /^KP\d{2}$/);
    assert.equal(group?.macroId, `macro:PRK:${p.shapeISO}`);
    assert.equal(group.name, p.shapeName);
  }
  for (const child of children) {
    const p = child.properties;
    assert.equal(p.shapeGroup, 'PRK');
    assert.equal(p.shapeType, 'ADM2');
    const childBbox = geometryMetadata(child.geometry).bbox;
    const matches = [];
    for (const parent of parents) {
      if (!bboxOverlaps(childBbox, parent.bbox)) continue;
      const intersection = area(clipping.intersection(polygons(child.geometry), polygons(parent.feature.geometry)));
      if (intersection === 0) continue;
      const outside = area(clipping.difference(polygons(child.geometry), polygons(parent.feature.geometry)));
      matches.push({parentId: parent.feature.properties.shapeID, intersection, outside});
    }
    // Require exactly one positive-area parent and zero outside area, not a winner by overlap.
    assert.equal(matches.length, 1, p.shapeID);
    assert.equal(matches[0].outside, 0, p.shapeID);
    const group = groups.get(matches[0].parentId), member = members.get(p.shapeID);
    assert.equal(member?.macroId, group.macroId, p.shapeID);
    assert.equal(member.method, 'unique-exact-polygon-containment');
    assert.equal(member.evidence.parentSourceFeatureId, matches[0].parentId);
    assert.equal(member.evidence.outsideParentAreaDegrees2, 0);
    childrenByParent.get(matches[0].parentId).push(child);
  }
  const parentUnions = parents.map(({feature}) => {
    const children = childrenByParent.get(feature.properties.shapeID);
    assert.ok(children.length);
    const union = clipping.union(...children.map(child => polygons(child.geometry)));
    const missing = area(clipping.difference(polygons(feature.geometry), union));
    const extra = area(clipping.difference(union, polygons(feature.geometry)));
    assert.equal(missing, 0, feature.properties.shapeID);
    assert.equal(extra, 0, feature.properties.shapeID);
    return {macroId: groups.get(feature.properties.shapeID).macroId, children: children.length,
      missingFromChildUnionAreaDegrees2: missing, extraOutsideParentAreaDegrees2: extra};
  });
  assert.equal(lock.verification.complete, true);
  assert.deepEqual(lock.verification.unresolved, []);
  assert.equal(lock.verification.sourceFeatures, children.length);
  assert.equal(lock.verification.parentUnionEqual, true);
  return {pass: true, countryId: 'PRK', sourceFeatures: children.length, macroGroups: parents.length,
    assigned: members.size, unresolved: 0, outsideParentAreaDegrees2: 0, parentUnionEqual: true, parentUnions};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyPrkMacroHierarchy(process.argv[2] ?? PRK_MACRO_HIERARCHY_LOCK)));
}
