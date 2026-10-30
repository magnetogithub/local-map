// Independent verifier for a CHN presentation-only province index. This never
// imports the producer, changes catalog bytes, or changes administrative parents.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT_ROOT = path.join(ROOT, 'reports/chn-province-20261030/verification');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => {throw Error(message);};
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
const same = (actual, expected, message) => {if (canonical(actual) !== canonical(expected)) fail(message);};
const local = file => {
  if (typeof file !== 'string' || path.isAbsolute(file)) fail('NONLOCAL_PRESENTATION_INPUT');
  const full = path.resolve(ROOT, file), relative = path.relative(ROOT, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('NONLOCAL_PRESENTATION_INPUT');
  return full;
};
const pin = file => {const bytes = fs.readFileSync(local(file));return {path: file, sha256: sha(bytes), byteLength: bytes.length};};
const checked = artifact => {
  if (!artifact || typeof artifact.path !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isSafeInteger(artifact.byteLength)) fail('INVALID_PRESENTATION_INPUT_PIN');
  const actual = pin(artifact.path);
  if (actual.sha256 !== artifact.sha256 || actual.byteLength !== artifact.byteLength) fail(`PRESENTATION_INPUT_PIN_CHANGED:${artifact.path}`);
  return fs.readFileSync(local(artifact.path));
};
const jsonPin = artifact => JSON.parse(checked(artifact));
const sortedNumbers = values => [...values].sort((a, b) => a - b);
const sortedStrings = values => [...values].sort();
const AEA = '+proj=aea +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +datum=WGS84 +units=m +no_defs';

function loadContext(pointerFile) {
  const pointerPin = pin(pointerFile), pointer = jsonPin(pointerPin);
  const indexPin = {...pointer.index, path: `${pointer.root}/artifact-index.json`}, index = jsonPin(indexPin);
  const artifacts = new Map();
  for (const item of index.artifacts) {if (artifacts.has(item.path)) fail('DUPLICATE_CATALOG_ARTIFACT');artifacts.set(item.path, item);}
  const artifactPin = file => {
    const artifact = artifacts.get(file);if (!artifact) fail(`UNINDEXED_CATALOG_ARTIFACT:${file}`);
    return {...artifact, path: `${pointer.root}/${file}`};
  };
  const json = file => {const bytes = checked(artifactPin(file));return JSON.parse(file.endsWith('.gz') ? gunzipSync(bytes) : bytes);};
  const descriptor = json('catalog.json'), parents = json('metadata/parents.json.gz'), detail = json('detail-index.json'), provenance = json('provenance.json');
  assert.equal(descriptor.catalogRef.catalogVersion, pointer.catalogVersion, 'POINTER_DESCRIPTOR_CATALOG_MISMATCH');
  const hierarchyPin = provenance.hierarchyArtifacts.find(p => p.countryId === 'CHN');
  if (!hierarchyPin) fail('MISSING_PINNED_CHN_HIERARCHY');
  const hierarchy = jsonPin(hierarchyPin), geometryPin = provenance.incremental?.geometry;
  if (!geometryPin) fail('MISSING_PINNED_CHN_FAMILY_GEOMETRY');
  const geometry = jsonPin(geometryPin), cells = new Map(), cellsById = new Map();
  for (const country of detail.countries) for (const row of json(country.metadata.path).rows) {
    const cell = {ordinal: row[0], id: row[1], countryId: country.countryId, admin: row[2], previous: row[3]};
    if (cells.has(cell.ordinal) || cellsById.has(cell.id)) fail('DUPLICATE_CATALOG_CELL');cells.set(cell.ordinal, cell);cellsById.set(cell.id, cell);
  }
  assert.equal(cells.size, descriptor.counts.cells, 'CATALOG_CELL_COUNT');
  const familyByCell = new Map(), activeFamilies = new Map();
  for (const feature of geometry.cells) {
    const cell = cellsById.get(feature.id);if (cell?.countryId !== 'CHN') fail('FAMILY_GEOMETRY_NOT_CURRENT_CHN_CELL');
    const sourceId = feature.properties.fineSourceIdentity?.sourceFeatureId ?? null;
    same(sourceId, feature.properties.sourceFeatureId ?? null, 'CONTRADICTORY_CELL_SOURCE_FAMILY');
    if (familyByCell.has(cell.ordinal)) fail('DUPLICATE_CELL_FAMILY');familyByCell.set(cell.ordinal, sourceId);
    if (sourceId) {const members = activeFamilies.get(sourceId) ?? [];members.push(cell.ordinal);activeFamilies.set(sourceId, members);}
  }
  const chnCells = [...cells.values()].filter(c => c.countryId === 'CHN');
  same(sortedNumbers(familyByCell.keys()), sortedNumbers(chnCells.map(c => c.ordinal)), 'INCOMPLETE_CURRENT_CHN_FAMILIES');
  const incidencePin = artifactPin('metadata/edge-incidence.bin.gz'), incidence = gunzipSync(checked(incidencePin));
  assert.equal(incidence.length, descriptor.counts.edges * 8, 'BAD_INCIDENCE_BYTE_LENGTH');
  const edges = [];
  for (let n = 1; n <= descriptor.counts.edges; n++) {
    const left = incidence.readUInt32LE((n - 1) * 8), right = incidence.readUInt32LE((n - 1) * 8 + 4);
    if (!cells.has(left) || right && !cells.has(right) || left === right) fail('BAD_INCIDENCE_RANGE');edges.push({ordinal: n, left, right});
  }
  return {pointerPin, pointer, indexPin, descriptor, hierarchyPin, hierarchy, geometryPin, cells, cellsById, parents, familyByCell, activeFamilies, chnCells, edges,
    requiredPins: {pointer: pointerPin, index: indexPin, metadata: artifactPin('metadata/countries/CHN.json.gz'),
      parents: artifactPin('metadata/parents.json.gz'), hierarchy: hierarchyPin, fineSource: hierarchy.sourceFine,
      provinceSource: hierarchy.sourceAdmin1.artifact, incidence: incidencePin, geometry: geometryPin}};
}

// Separate source calculation; no producer imports or stored success flags.
// It unions every active cell of a family before comparing real source polygons.
const COVERAGE_PYTHON = String.raw`
import json,sys
import shapely
import pyproj
from shapely.geometry import shape
from shapely.ops import transform
from collections import defaultdict
raw_ids={f['properties']['shapeID'] for f in json.load(open(sys.argv[1],encoding='utf-8'))['features']}
macro=json.load(open(sys.argv[2],encoding='utf-8'))['features']
hierarchy=json.load(open(sys.argv[3],encoding='utf-8'))
active=json.load(open(sys.argv[4],encoding='utf-8'))['cells']
groups=defaultdict(list)
for cell in active:
 p=cell['properties']
 if p.get('fineSourceIdentity'):
  source_id=p['sourceFeatureId']
  if source_id not in raw_ids or source_id!=p['fineSourceIdentity']['sourceFeatureId']: raise ValueError('INVALID_CURRENT_SOURCE_FAMILY')
  g=shape(cell['geometry'])
  if not g.is_valid or g.is_empty: raise ValueError('INVALID_CURRENT_CELL_GEOMETRY')
  groups[source_id].append(g)
del active
verified={a['sourceFeatureId']:a['macroId'] for a in hierarchy['assignments']}
macro_ids={a['sourceFeatureId']:a['macroId'] for a in hierarchy['macroGroups']}
provinces=[(macro_ids[f['properties']['shapeID']],shape(f['geometry'])) for f in macro]
if len(provinces)!=31 or len(set(p[0] for p in provinces))!=31: raise ValueError('BAD_SOURCE_PROVINCES')
if any(p.is_empty or not p.is_valid or p.area<=0 for _,p in provinces): raise ValueError('INVALID_SOURCE_PROVINCE')
province_union=shapely.union_all([p for _,p in provinces])
aea='+proj=aea +lat_1=25 +lat_2=47 +lat_0=0 +lon_0=105 +datum=WGS84 +units=m +no_defs'
project=pyproj.Transformer.from_crs('OGC:CRS84',pyproj.CRS.from_proj4(aea),always_xy=True)
def area_m2(g): return transform(project.transform,g).area
records={}
for source_id,members in sorted(groups.items()):
 if source_id in verified:
  records[source_id]={'verifiedMacroId':verified[source_id]};continue
 geom=shapely.union_all(members)
 if geom.is_empty or not geom.is_valid or geom.area<=0: raise ValueError('INVALID_SOURCE_FAMILY')
 denominator=area_m2(geom)
 if denominator<=0: raise ValueError('INVALID_FAMILY_EQUAL_AREA')
 west,south,east,north=geom.bounds
 hits=[]
 for macro_id,province in provinces:
  w,s,e,n=province.bounds
  if east<w or west>e or north<s or south>n: continue
  intersection=geom if province.covers(geom) else geom.intersection(province)
  if intersection.area>0: hits.append((macro_id,intersection.area,area_m2(intersection)))
 hits.sort(key=lambda v:(-v[2],v[0]))
 top=hits[0][2] if hits else 0
 second=hits[1][2] if len(hits)>1 else 0
 uncovered=geom.difference(province_union)
 records[source_id]={'verifiedMacroId':None,'topMacroId':hits[0][0] if hits else None,
  'topShare':top/denominator,'secondShare':second/denominator,'topMinusSecondShare':(top-second)/denominator,
  'uncoveredShare':area_m2(uncovered)/denominator,'uniqueStrictLargestPositiveOverlap':top>second,
  'activeFamilyAreaDegrees2':geom.area,'activeFamilyAreaSquareMetersAEA':denominator,
  'topSharePlanar':max((v/geom.area for _,v,_ in hits),default=0),'uncoveredSharePlanar':uncovered.area/geom.area,
  'positiveProvinceOverlaps':[{'macroId':k,'intersectionAreaDegrees2':v,'intersectionAreaSquareMetersAEA':a,'shareOfFamilyAreaAEA':a/denominator} for k,v,a in hits]}
json.dump({'runtime':{'shapely':shapely.__version__,'GEOS':shapely.geos_version_string,'pyproj':pyproj.__version__,'PROJ':pyproj.proj_version_str},'families':records},sys.stdout,separators=(',',':'))
`;
function recomputeCoverage(context) {
  checked(context.requiredPins.fineSource);checked(context.requiredPins.provinceSource);checked(context.hierarchyPin);
  const python = process.env.CHN_PYTHON ?? 'python';
  const result = spawnSync(python, ['-c', COVERAGE_PYTHON, local(context.requiredPins.fineSource.path), local(context.requiredPins.provinceSource.path), local(context.hierarchyPin.path), local(context.geometryPin.path)],
    {cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: {...process.env, PYTHONPATH: path.join(ROOT, '.tmp/chn-python')}, windowsHide: true});
  if (result.error || result.status !== 0) fail(`INDEPENDENT_SOURCE_COVERAGE_FAILED:${result.error?.message ?? result.stderr.slice(-2000)}`);
  return JSON.parse(result.stdout);
}

function verifyActiveAnalysis(analysis, context, coverage) {
  same(analysis.schemaVersion, 'chn-active-province-presentation-overlap-analysis-v1', 'ACTIVE_ANALYSIS_SCHEMA');
  same(analysis.catalogVersion, context.pointer.catalogVersion, 'ACTIVE_ANALYSIS_STALE_CATALOG');
  same(analysis.administrativeTruthClaim, false, 'ACTIVE_ANALYSIS_OFFICIAL_PARENT_CLAIM');
  for (const [analysisKey, expectedKey] of [['activePointer', 'pointer'], ['activeIndex', 'index'], ['activeCHNMetadata', 'metadata'],
    ['activeCHNGeometry', 'geometry'], ['hierarchy', 'hierarchy'], ['rawSourceProvinces', 'provinceSource'], ['rawSourceFamilies', 'fineSource']]) {
    const actual = analysis.inputs?.[analysisKey], expected = context.requiredPins[expectedKey];
    if (!actual || actual.path !== expected.path || actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) fail(`ACTIVE_ANALYSIS_INPUT_MISMATCH:${analysisKey}`);
  }
  same(analysis.areaMeasurement?.equalAreaCRS, AEA, 'ACTIVE_ANALYSIS_PROJECTION_CHANGED');
  same(analysis.areaMeasurement?.overlayCRS, 'OGC:CRS84', 'ACTIVE_ANALYSIS_OVERLAY_CRS_CHANGED');
  same(analysis.areaMeasurement?.alwaysXY, true, 'ACTIVE_ANALYSIS_AXIS_ORDER_CHANGED');
  const records = new Map(), macrosBySource = new Map(context.hierarchy.macroGroups.map(m => [m.sourceFeatureId, m.macroId]));
  for (const row of analysis.families) {
    const expected = coverage.families[row.sourceFeatureId], members = context.activeFamilies.get(row.sourceFeatureId);
    if (!expected || !members || records.has(row.sourceFeatureId)) fail('ACTIVE_ANALYSIS_FAMILY_SCOPE_CHANGED');
    same(sortedStrings(row.cellIds), sortedStrings(members.map(n => context.cells.get(n).id)), 'ACTIVE_ANALYSIS_FAMILY_MEMBERS_CHANGED');
    same(row.existingVerifiedSourceMacroIdUnchanged, expected.verifiedMacroId, 'ACTIVE_ANALYSIS_VERIFIED_PARENT_CHANGED');
    if (!expected.verifiedMacroId) {
      for (const [analysisKey, independentKey] of [['topShareAEA', 'topShare'], ['secondShareAEA', 'secondShare'], ['uncoveredShareAEA', 'uncoveredShare'],
        ['uniqueStrictLargestPositiveOverlapAEA', 'uniqueStrictLargestPositiveOverlap'], ['activeFamilyAreaDegrees2', 'activeFamilyAreaDegrees2'],
        ['activeFamilyAreaSquareMetersAEA', 'activeFamilyAreaSquareMetersAEA'], ['topSharePlanar', 'topSharePlanar'], ['uncoveredSharePlanar', 'uncoveredSharePlanar']]) {
        same(row[analysisKey], expected[independentKey], `ACTIVE_ANALYSIS_RECOMPUTATION_MISMATCH:${row.sourceFeatureId}:${analysisKey}`);
      }
      same(row.positiveProvinceOverlaps.length, expected.positiveProvinceOverlaps.length, 'ACTIVE_ANALYSIS_OVERLAP_COUNT_CHANGED');
      for (const hit of row.positiveProvinceOverlaps) {
        const independent = expected.positiveProvinceOverlaps.find(h => h.macroId === macrosBySource.get(hit.sourceFeatureId));
        if (!independent) fail('ACTIVE_ANALYSIS_OVERLAP_PROVINCE_CHANGED');
        for (const key of ['intersectionAreaDegrees2', 'intersectionAreaSquareMetersAEA', 'shareOfFamilyAreaAEA']) same(hit[key], independent[key], `ACTIVE_ANALYSIS_OVERLAP_VALUE_CHANGED:${row.sourceFeatureId}:${key}`);
      }
    }
    records.set(row.sourceFeatureId, row);
  }
  same(sortedStrings(records.keys()), sortedStrings(context.activeFamilies.keys()), 'ACTIVE_ANALYSIS_FAMILIES_INCOMPLETE');
  const sourceFree = context.chnCells.filter(c => context.familyByCell.get(c.ordinal) === null).map(c => c.id);
  same(sortedStrings(analysis.sourceFreeCells.map(c => c.cellId)), sortedStrings(sourceFree), 'ACTIVE_ANALYSIS_SOURCE_FREE_CHANGED');
  return records;
}

export function verifyProvincePresentation(value, context, coverage) {
  assert.equal(value.schemaVersion, 'chn-province-presentation-v1', 'PRESENTATION_SCHEMA');
  assert.equal(value.countryId, 'CHN', 'PRESENTATION_COUNTRY');
  assert.equal(value.administrativeTruthClaim, false, 'PRESENTATION_OFFICIAL_PARENT_CLAIM');
  if (value.geometryChanged !== undefined) assert.equal(value.geometryChanged, false, 'PRESENTATION_GEOMETRY_CHANGED');
  if (value.officialParentsChanged !== undefined) assert.equal(value.officialParentsChanged, false, 'PRESENTATION_PARENT_CHANGED');
  same(value.catalogRef, context.descriptor.catalogRef, 'PRESENTATION_STALE_CATALOG');
  for (const [name, expected] of Object.entries(context.requiredPins)) {
    const actual = value.inputs?.[name];if (!actual) fail(`MISSING_PRESENTATION_PIN:${name}`);
    if (actual.path !== expected.path || actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) fail(`PRESENTATION_PIN_MISMATCH:${name}`);
  }
  if (!value.inputs.activeOverlapAnalysis) fail('MISSING_PRESENTATION_PIN:activeOverlapAnalysis');
  const analysisRecords = verifyActiveAnalysis(jsonPin(value.inputs.activeOverlapAnalysis), context, coverage);
  const policy = value.policy;
  same(policy?.minimumTopShare, .99, 'PRESENTATION_TOP_COVERAGE_POLICY_CHANGED');
  same(policy?.maximumSecondShare, .001, 'PRESENTATION_SECOND_COVERAGE_POLICY_CHANGED');
  for (const name of ['minimumTopMinusSecondShare', 'maximumUncoveredShare']) if (policy[name] !== undefined && (!Number.isFinite(policy[name]) || policy[name] < 0 || policy[name] > 1)) fail(`INVALID_PRESENTATION_POLICY:${name}`);
  same(policy.metric, 'active-family-equal-area', 'PRESENTATION_METRIC_CHANGED');
  for (const [name, expected] of [['verifiedMemberships', 'fixed'], ['sourceFreeCells', 'unassigned'], ['ambiguousTop', 'unassigned']]) if (policy[name] !== undefined && policy[name] !== expected) fail(`INVALID_PRESENTATION_POLICY:${name}`);
  const provinces = context.hierarchy.macroGroups.map(m => ({id: m.macroId, sourceFeatureId: m.sourceFeatureId, sourceISO: m.sourceISO, name: m.name}));
  if (!Array.isArray(value.provinces)) fail('MISSING_PRESENTATION_PROVINCES');
  same([...value.provinces].sort((a, b) => a.id.localeCompare(b.id)), provinces.sort((a, b) => a.id.localeCompare(b.id)), 'PRESENTATION_PROVINCE_IDENTITY_CHANGED');
  const macroIds = new Set(context.hierarchy.macroGroups.map(m => m.macroId)), familyMap = new Map();
  if (!Array.isArray(value.families) || !Array.isArray(value.cells) || !Array.isArray(value.addedBoundaryOrdinals)) fail('INCOMPLETE_PRESENTATION_TABLES');
  for (const row of value.families) {
    if (familyMap.has(row.sourceFeatureId) || !coverage.families[row.sourceFeatureId]) fail('INVALID_PRESENTATION_FAMILY');
    if (row.renderProvinceId !== null && !macroIds.has(row.renderProvinceId)) fail('UNKNOWN_RENDER_PROVINCE');
    const source = coverage.families[row.sourceFeatureId];
    const qualifies = !source.verifiedMacroId && source.uniqueStrictLargestPositiveOverlap && source.topShare >= policy.minimumTopShare &&
      source.secondShare <= policy.maximumSecondShare && source.topMinusSecondShare >= (policy.minimumTopMinusSecondShare ?? 0) && source.uncoveredShare <= (policy.maximumUncoveredShare ?? 1);
    const expected = source.verifiedMacroId ?? (qualifies ? source.topMacroId : null);
    if (row.renderProvinceId !== expected) fail(source.verifiedMacroId ? 'VERIFIED_PRESENTATION_PARENT_CHANGED' : 'UNSUPPORTED_PRESENTATION_FAMILY_ASSIGNMENT');
    if (row.method !== (source.verifiedMacroId ? 'verified-hierarchy' : qualifies ? 'source-overlap-presentation' : 'unresolved')) fail('PRESENTATION_METHOD_MISMATCH');
    const analyzed = analysisRecords.get(row.sourceFeatureId), retained = context.hierarchy.assignments.find(a => a.sourceFeatureId === row.sourceFeatureId);
    const top = analyzed.positiveProvinceOverlaps[0], second = analyzed.positiveProvinceOverlaps[1], reasons = [];
    if (!retained) {
      if (!source.uniqueStrictLargestPositiveOverlap) reasons.push('no-unique-positive-top-overlap');
      if (source.topShare < policy.minimumTopShare) reasons.push('top-share-below-policy');
      if (source.secondShare > policy.maximumSecondShare) reasons.push('second-share-above-policy');
    }
    same(row.evidence, {metric: policy.metric, sourceName: analyzed.sourceName, activeCellCount: analyzed.activeCellCount,
      activeFamilyAreaSquareMetersAEA: analyzed.activeFamilyAreaSquareMetersAEA,
      topShare: analyzed.topShareAEA, secondShare: analyzed.secondShareAEA, uncoveredShare: analyzed.uncoveredShareAEA,
      sumPositiveOverlapShares: analyzed.sumPositiveOverlapSharesAEA, uniqueStrictPositiveTop: analyzed.uniqueStrictLargestPositiveOverlapAEA,
      topProvinceSourceFeatureId: top?.sourceFeatureId ?? null, secondProvinceSourceFeatureId: second?.sourceFeatureId ?? null,
      positiveProvinceOverlaps: analyzed.positiveProvinceOverlaps,
      originalVerifiedHierarchyMethod: retained?.method ?? null, originalVerifiedHierarchyEvidence: retained?.evidence ?? null,
      rawComparison: analyzed.rawComparison ?? null, unresolvedReasons: reasons, administrativeTruthClaim: false}, 'PRESENTATION_EVIDENCE_CHANGED');
    familyMap.set(row.sourceFeatureId, row);
  }
  // The producer may retain all raw families; it must at least cover every
  // current family, and cannot invent an absent raw family.
  same(sortedStrings(familyMap.keys()), sortedStrings(context.activeFamilies.keys()), 'MISSING_OR_FOREIGN_PRESENTATION_FAMILY');
  const cellMap = new Map();
  for (const row of value.cells) {
    const cell = context.cells.get(row.ordinal), sourceId = context.familyByCell.get(row.ordinal);
    if (!cell || cell.countryId !== 'CHN' || row.id !== cell.id || cellMap.has(row.ordinal)) fail('INVALID_PRESENTATION_CELL');
    if (row.sourceFeatureId !== sourceId) fail('PRESENTATION_CELL_FAMILY_CHANGED');
    const expected = sourceId ? familyMap.get(sourceId)?.renderProvinceId : null;
    if (row.renderProvinceId !== expected) fail('HETEROGENEOUS_FAMILY_PRESENTATION');
    const administrative = context.parents.administrative[cell.admin - 1];
    if (administrative.kind === 'administrative' && row.renderProvinceId !== administrative.macroId) fail('VERIFIED_CELL_PARENT_CHANGED');
    cellMap.set(row.ordinal, row);
  }
  same(sortedNumbers(cellMap.keys()), sortedNumbers(context.chnCells.map(c => c.ordinal)), 'INCOMPLETE_PRESENTATION_CELLS');
  const expectedEdges = [];
  for (const edge of context.edges) {
    const l = cellMap.get(edge.left), r = cellMap.get(edge.right);
    if (!l || !r || l.renderProvinceId === null || r.renderProvinceId === null || l.renderProvinceId === r.renderProvinceId) continue;
    if (l.sourceFeatureId && l.sourceFeatureId === r.sourceFeatureId) fail('INTERNAL_SOURCE_FAMILY_BOUNDARY_PROMOTED');
    expectedEdges.push(edge.ordinal);
  }
  if (value.addedBoundaryOrdinals.some((n, i, a) => !Number.isSafeInteger(n) || n < 1 || i > 0 && a[i - 1] >= n)) fail('INVALID_PRESENTATION_EDGE_ORDER');
  same(value.addedBoundaryOrdinals, expectedEdges, 'UNSUPPORTED_PRESENTATION_EDGE_PROMOTION');
  const assigned = value.cells.filter(c => c.renderProvinceId !== null), represented = new Set(assigned.map(c => c.renderProvinceId));
  return {pass: true, cells: value.cells.length, activeFamilies: context.activeFamilies.size, mappedFamilies: familyMap.size,
    assignedCells: assigned.length, unassignedCells: value.cells.length - assigned.length, representedProvinces: sortedStrings(represented), normalWhiteEdges: expectedEdges.length,
    independentlyRecomputedUnconfirmedFamilies: [...analysisRecords.values()].filter(r => !r.existingVerifiedSourceMacroIdUnchanged).length,
    analysisAreaValuesExactReproduction: true, administrativeParentsUnchanged: true, wholeFamiliesPreserved: true, sourceFreeCellsUnassigned: true, noForeignOrCoastPromotion: true};
}

function negativeControls(value, context, coverage) {
  const cases = [];
  const reject = (name, mutate) => {
    const changed = structuredClone(value);mutate(changed);
    let error;try {verifyProvincePresentation(changed, context, coverage);} catch (caught) {error = String(caught.message ?? caught);}
    if (!error) fail(`NEGATIVE_CONTROL_ACCEPTED:${name}`);cases.push({name, rejected: true, error});
  };
  reject('different-catalog', a => {a.catalogRef.catalogVersion += '-stale';});
  reject('stale-input-hash', a => {a.inputs.parents.sha256 = '0'.repeat(64);});
  reject('weakened-coverage-policy', a => {a.policy.minimumTopShare = .5;});
  reject('false-coverage-evidence', a => {a.families[0].evidence.topShare = -1;});
  const family = [...context.activeFamilies].find(([, members]) => members.length > 1);
  if (!family) fail('MISSING_MULTI_CELL_FAMILY_NEGATIVE_CONTROL');
  reject('heterogeneous-whole-family', a => {const cell = a.cells.find(c => c.ordinal === family[1][0]);cell.renderProvinceId = cell.renderProvinceId === null ? context.hierarchy.macroGroups[0].macroId : null;});
  const verified = value.families.find(f => coverage.families[f.sourceFeatureId]?.verifiedMacroId);
  if (!verified) fail('MISSING_VERIFIED_FAMILY_NEGATIVE_CONTROL');
  reject('verified-parent-mutation', a => {a.families.find(f => f.sourceFeatureId === verified.sourceFeatureId).renderProvinceId = null;});
  for (const [name, predicate] of [['foreign-edge-promotion', e => e.right && context.cells.get(e.left).countryId !== context.cells.get(e.right).countryId], ['coast-edge-promotion', e => !e.right]]) {
    const edge = context.edges.find(e => predicate(e) && (context.cells.get(e.left).countryId === 'CHN' || context.cells.get(e.right)?.countryId === 'CHN'));
    if (!edge) fail(`MISSING_NEGATIVE_EDGE:${name}`);
    reject(name, a => {a.addedBoundaryOrdinals = sortedNumbers(new Set([...a.addedBoundaryOrdinals, edge.ordinal]));});
  }
  return cases;
}

function option(name, fallback) {const i = process.argv.indexOf(name);if (i < 0) return fallback;const value = process.argv[i + 1];if (!value || value.startsWith('--')) fail(`MISSING_ARGUMENT:${name}`);return value;}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pointerFile = option('--pointer', 'data/runtime/operational-catalog/current.json');
  const artifactFile = option('--artifact', null), outputFile = option('--output-report', 'reports/chn-province-20261030/verification/independent.json');
  const output = local(outputFile), relative = path.relative(REPORT_ROOT, output);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('VERIFICATION_OUTPUT_OUTSIDE_OWNED_DIRECTORY');
  const start = performance.now();let report;
  try {
    if (!artifactFile) fail('USAGE: --artifact <presentation-json> [--pointer <catalog-pointer>] [--output-report <verification-report>]');
    const context = loadContext(pointerFile), artifactPin = pin(artifactFile), artifact = jsonPin(artifactPin), coverage = recomputeCoverage(context);
    const checks = verifyProvincePresentation(artifact, context, coverage), controls = negativeControls(artifact, context, coverage);
    for (const input of Object.values(context.requiredPins)) checked(input);
    checked(artifact.inputs.activeOverlapAnalysis);
    same(pin(pointerFile), context.pointerPin, 'ACTIVE_POINTER_CHANGED_DURING_PRESENTATION_VERIFICATION');
    report = {schemaVersion: 'chn-province-presentation-independent-verification-v1', pass: true, artifact: artifactPin, pointer: context.pointerPin,
      catalogVersion: context.pointer.catalogVersion, code: pin('scripts/chn-2020/verify-province-presentation.mjs'), inputs: context.requiredPins,
      runtime: {node: process.version, coverage: coverage.runtime}, checks, negativeControls: controls, inputPinsVerifiedBeforeAndAfter: true,
      methodology: 'Independent existing-whole-family/source-province CRS84 GEOS overlay, existing-vertex WGS84 Albers equal-area coverage recomputation, fixed verified hierarchy, ID-exact cell family mapping, and binary incidence-derived same-country edges. Raw coverage is not an adoption threshold. No generator imports, buffers, snapped coordinates, inferred official parents, cell splitting or catalog mutation. Coverage shares are geometric diagnostics, not accuracy or statistical confidence.',
      limits: ['Presentation-only source overlap does not certify an official administrative parent or exact 2020 boundary.', 'Browser visibility and delivered tile filtering require separate actual-browser evidence.'], elapsedMs: performance.now() - start};
  } catch (error) {report = {schemaVersion: 'chn-province-presentation-independent-verification-v1', pass: false, artifactFile, pointerFile, error: String(error.message ?? error), elapsedMs: performance.now() - start};process.exitCode = 1;}
  fs.mkdirSync(path.dirname(output), {recursive: true});fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({pass: report.pass, output: outputFile, checks: report.checks, error: report.error, elapsedMs: report.elapsedMs}));
}
