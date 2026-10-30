import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import PointLocator from 'jsts/org/locationtech/jts/algorithm/PointLocator.js';
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
import DistanceOp from 'jsts/org/locationtech/jts/operation/distance/DistanceOp.js';

const read = path => JSON.parse(fs.readFileSync(path));
const checked = pin => {
  const bytes = fs.readFileSync(pin.path);
  assert.equal(bytes.length, pin.byteLength, pin.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pin.sha256, pin.path);
  return bytes;
};
const lock = read('data/source-locks/prompt19/KOR-macro-hierarchy.json');
const root = 'data/raw/prompt19/KOR/hierarchy-citypopulation-2020-20261030';
const facts = read(`${root}/hierarchy-facts.json`);
const representatives = new Map(read(`${root}/representative-facts.json`).records.map(r => [r.publisherChildId, r]));
const fineLock = JSON.parse(checked(lock.fineSourceLock));
const source = JSON.parse(checked(fineLock.sources[0].artifact));
const sourceById = new Map(source.features.map(f => [f.properties.shapeID, f]));
const childById = new Map(facts.children.map(c => [c.id, c]));
const macroById = new Map(lock.macroGroups.map(g => [g.macroId, g]));
const norm = text => text.split('[')[0].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const macroId = publisherId => `KOR:macro:citypopulation:${publisherId}`;
const reader = new GeoJSONReader(), locator = new PointLocator();

test('KOR hierarchy artifacts and fine source inputs retain their exact recorded bytes', () => {
  assert.equal(lock.schemaVersion, 'prompt19-fine-macro-hierarchy-v1');
  assert.equal(lock.countryId, 'KOR');
  lock.artifacts.forEach(checked);
  checked(fineLock.normalizedInput);
  assert.equal(lock.artifacts.length, 6);
  assert.equal(fineLock.sources[0].adminLevel, 2);
  assert.match(fineLock.sources[0].sourceId, /KOR-ADM2-2020$/);
  assert.equal(source.features.length, 228);
});

test('every published fine identity has exactly one evidenced macro without inventing missing districts', () => {
  assert.equal(lock.members.length, source.features.length);
  assert.equal(new Set(lock.members.map(m => m.sourceFeatureId)).size, source.features.length);
  assert.deepEqual(new Set(lock.members.map(m => m.sourceFeatureId)), new Set(sourceById.keys()));
  assert.equal(macroById.size, 17); assert.equal(facts.parents.length, 17);
  assert.equal(childById.size, 229);
  assert.equal(new Set(lock.members.map(m => m.evidence.matchedPublisherChildId)).size, 228);
  for (const group of lock.macroGroups) {
    const parent = facts.parents.find(p => p.id === group.sourceFeatureId);
    assert.ok(parent); assert.equal(group.macroId, macroId(parent.id));
    assert.equal(group.name, parent.name); assert.equal(group.nameKo, parent.native);
    assert.ok(lock.members.some(m => m.macroId === group.macroId));
  }
  for (const member of lock.members) {
    assert.ok(macroById.has(member.macroId));
    const child = childById.get(member.evidence.matchedPublisherChildId), feature = sourceById.get(member.sourceFeatureId);
    assert.ok(child); assert.ok(feature);
    assert.equal(member.evidence.sourceName, feature.properties.shapeName);
    assert.equal(member.evidence.matchedPublisherChildName, child.name);
    assert.equal(member.evidence.publisherChildUrl, `https://www.citypopulation.de${child.href}`);
    if (!member.evidence.temporalCorrection) assert.equal(member.macroId, macroId(child.parent.id));
  }
  const used = new Set(lock.members.map(m => m.evidence.matchedPublisherChildId));
  const unmatched = facts.children.filter(c => !used.has(c.id));
  assert.deepEqual(unmatched.map(c => c.name), ['Yeonggwang-gun']);
  assert.equal(source.features.some(f => norm(f.properties.shapeName) === norm('Yeonggwang-gun')), false);
  assert.equal(lock.verification.complete, true); assert.deepEqual(lock.verification.unresolved, []);
  assert.equal(lock.verification.oldNaturalEarthParentGeometryUsed, false);
  assert.equal(lock.verification.oldParentMajorityUsed, false);
});

test('unique name assignments and the one explicit suffix alias are checked against the publisher hierarchy', () => {
  const unique = lock.members.filter(m => m.method.startsWith('unique-source-name'));
  assert.equal(unique.length, 198); // Includes the separately evidenced Gunwi temporal correction.
  for (const member of unique) {
    const sameName = facts.children.filter(c => norm(c.name) === norm(member.evidence.sourceName));
    assert.equal(sameName.length, 1, member.sourceFeatureId);
    assert.equal(sameName[0].id, member.evidence.matchedPublisherChildId);
  }
  const aliases = lock.members.filter(m => m.method === 'unique-name-explicit-suffix-alias');
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].evidence.sourceName, 'Yeoju');
  assert.equal(aliases[0].evidence.matchedPublisherChildName, 'Yeoju-si');
  assert.deepEqual(aliases[0].evidence.explicitNameAlias.source, 'Yeoju');
  assert.equal(facts.children.filter(c => norm(c.name) === norm('Yeoju-si')).length, 1);
});

test('same-name district disambiguation uses the matching publisher representative within the source polygon', () => {
  const resolved = lock.members.filter(m => m.method === 'same-name-and-representative-covered');
  assert.equal(resolved.length, 28);
  for (const member of resolved) {
    const sameName = facts.children.filter(c => norm(c.name) === norm(member.evidence.sourceName));
    assert.ok(sameName.length > 1);
    const g = reader.read(sourceById.get(member.sourceFeatureId).geometry);
    const covered = sameName.filter(c => {
      const r = representatives.get(c.id);
      return r && locator.locate(new Coordinate(...r.representative), g) !== 2;
    });
    assert.equal(covered.length, 1, member.sourceFeatureId);
    assert.equal(covered[0].id, member.evidence.matchedPublisherChildId);
    assert.deepEqual(member.evidence.representative, representatives.get(covered[0].id).representative);
    assert.equal(member.evidence.representativeCovered, true);
  }
});

test('Seoul Jung-gu is the unique remaining bijection and keeps its non-covering representative caveat', () => {
  const inferred = lock.members.filter(m => m.method === 'same-name-group-bijection-elimination');
  assert.equal(inferred.length, 1);
  const member = inferred[0], sameNameSources = source.features.filter(f => norm(f.properties.shapeName) === norm('Jung-gu'));
  const sameNameChildren = facts.children.filter(c => norm(c.name) === norm('Jung-gu'));
  assert.equal(sameNameSources.length, 6); assert.equal(sameNameChildren.length, 6);
  const known = lock.members.filter(m => norm(m.evidence.sourceName) === norm('Jung-gu') && m !== member);
  assert.equal(known.length, 5);
  assert.ok(known.every(m => m.method === 'same-name-and-representative-covered'));
  const occupied = new Set(known.map(m => m.evidence.matchedPublisherChildId));
  const remaining = sameNameChildren.filter(c => !occupied.has(c.id));
  assert.equal(remaining.length, 1); assert.equal(remaining[0].id, member.evidence.matchedPublisherChildId);
  assert.equal(remaining[0].parent.name, 'Seoul'); assert.equal(member.macroId, macroId('11'));
  const representative = representatives.get(remaining[0].id).representative;
  const g = reader.read(sourceById.get(member.sourceFeatureId).geometry);
  assert.equal(locator.locate(new Coordinate(...representative), g), 2);
  assert.equal(member.evidence.bijection.representativeCovered, false);
  assert.equal(member.evidence.bijection.alreadyUniquelyVerified, 5);
  const nearest = DistanceOp.nearestPoints(g, reader.read({type:'Point',coordinates:representative}));
  assert.deepEqual(member.evidence.bijection.nearestBoundaryPoint, [nearest[0].x, nearest[0].y]);
  assert.ok(member.evidence.bijection.representativeBoundaryDistanceKm > .14);
  assert.ok(member.evidence.bijection.representativeBoundaryDistanceKm < .15);
});

test('2020 Gunwi stays in Gyeongsangbuk-do despite a contemporary source table showing Daegu', () => {
  const member = lock.members.find(m => m.evidence.sourceName === 'Gunwi-gun');
  assert.ok(member); assert.equal(member.macroId, macroId('37'));
  const child = childById.get(member.evidence.matchedPublisherChildId);
  assert.equal(child.parent.name, 'Daegu');
  assert.equal(member.evidence.observedCurrentMacroId, macroId('22'));
  const correction = member.evidence.temporalCorrection;
  assert.equal(correction.scenarioDate, '2020-01-01');
  assert.equal(correction.transferEffectiveDate, '2023-07-01');
  assert.ok(correction.scenarioDate < correction.transferEffectiveDate);
  assert.equal(correction.parentNameKo, '경상북도');
  assert.ok(correction.sources.includes('https://www.law.go.kr/LSW/lsInfoP.do?efYd=20230701&lsiSeq=247229'));
  assert.ok(correction.sources.some(url => url.includes('mois.go.kr') && url.includes('97607')));
  const temporal = read(`${root}/temporal-facts.json`);
  assert.deepEqual(temporal.corrections, [correction]);
  assert.ok(temporal.sources.every(s => s.status === 200 && s.rawHtmlRedistributed === false));
  assert.match(lock.temporalCoverage.caveat, /Not certification/);
});

test('the same release ADM1 is explicitly rejected as a compatible hierarchy source', () => {
  const inspected = read(`${root}/source-inspection.json`);
  assert.equal(inspected.sameReleaseAdm1.boundaryYear, '2021');
  assert.equal(inspected.sameReleaseAdm1.boundarySource, 'Natural Earth');
  assert.equal(inspected.sameReleaseAdm1SuitableForCoherentHierarchy, false);
  assert.equal(inspected.nativeParentCodeAvailable, false);
  assert.match(facts.contentPolicy, /Population tables.*not copied/);
});
