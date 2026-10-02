import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {CAPS, CANONICAL_P0_VALIDATOR_POLICY, validateCaps, validatePartitionCoverage, validatePolygonFeatureCollection} from './prompt14-source-gate.mjs';
import {validateDerivedGameLock, verifySourceComponentGroups} from './prompt14-shared-topology.mjs';

export const GENERATOR_VERSION = 'prompt14-immutable-catalog-v1';
export const CATALOG_POLICY = Object.freeze({
  version: GENERATOR_VERSION,
  coordinates: 'Preserve finite IEEE-754 source doubles, normalize negative zero; no coordinate rounding, snapping, simplification or geometric repair.',
  rings: 'Exact duplicate consecutive vertices only; closed CCW exterior/CW holes; numerically smallest vertex and lexicographically smallest cyclic sequence.',
  components: 'Sort canonical holes/components by bytewise canonical JSON. Group only the complete component set of one approved source-feature identity.',
  invalidGeometry: 'Reject after strict JSTS IsValidOp; source self-touch repair/selection was locked in 14-2. Never drop an invalid component.',
  atomKey: 'Domain-separated source-country, source-version, source-feature, input-role and sorted normalized component hashes; independent of future TerritoryId and input enumeration.',
  hashing: 'SHA-256(domain + NUL + canonical UTF-8 JSON); bytewise object keys; JSON finite-number representation, negative zero normalized.',
  topology: 'Offline exact robust source boundary noding/ownership; certify every coast/country edge against locked P0. Reject unpaired interior boundaries, missing P0 segments or more than two sides. Never snap geometry or turn an unmatched interior boundary into coast.',
  units: {area: 'longitude/latitude degrees squared', centroid: 'longitude/latitude degrees'},
  caps: CAPS,
});

export const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {if (!Number.isFinite(value)) throw new Error('Nonfinite canonical number'); return JSON.stringify(Object.is(value, -0) ? 0 : value);}
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Noncanonical value');
  return `{${Object.keys(value).sort(compareText).map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export const hashCanonical = (domain, value) => digest(Buffer.from(`${domain}\0${canonical(value)}`));
export const jsonBytes = value => Buffer.from(`${canonical(value)}\n`);
export const polygons = g => g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : (() => {throw new Error('Polygon source required');})();
const equalPoint = (a, b) => a[0] === b[0] && a[1] === b[1];
const pointCompare = (a, b) => a[0] - b[0] || a[1] - b[1];
export function signedArea(ring) {
  const [ox, oy] = ring[0]; let sum = 0;
  for (let i = 1; i < ring.length; i++) sum += (ring[i-1][0]-ox)*(ring[i][1]-oy)-(ring[i][0]-ox)*(ring[i-1][1]-oy);
  return sum / 2;
}
export function normalizeRing(source, exterior) {
  if (!Array.isArray(source) || source.length < 4 || !equalPoint(source[0], source.at(-1))) throw new Error('Unclosed or short ring');
  let ring = source.map(p => {
    if (p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) throw new Error('Invalid WGS84 position');
    return p.map(v => Object.is(v, -0) ? 0 : v);
  }).filter((p, i, all) => i === 0 || !equalPoint(p, all[i-1]));
  if (ring.length < 4 || signedArea(ring) === 0) throw new Error('Degenerate ring');
  if ((signedArea(ring) > 0) !== exterior) ring.reverse();
  ring.pop();
  let start = 0;
  for (let i = 1; i < ring.length; i++) {
    let difference = pointCompare(ring[i], ring[start]);
    if (difference === 0) for (let j = 1; j < ring.length && difference === 0; j++) difference = pointCompare(ring[(i+j)%ring.length], ring[(start+j)%ring.length]);
    if (difference < 0) start = i;
  }
  const result = [...ring.slice(start), ...ring.slice(0, start)];
  result.push([...result[0]]); return result;
}
export function normalizeGeometry(geometry) {
  const components = polygons(geometry).map(p => {
    if (!p.length) throw new Error('Empty polygon');
    return [normalizeRing(p[0], true), ...p.slice(1).map(r => normalizeRing(r, false)).sort((a,b) => compareText(canonical(a), canonical(b)))];
  }).sort((a,b) => compareText(canonical(a), canonical(b)));
  if (!components.length) throw new Error('Empty geometry');
  return {type: components.length === 1 ? 'Polygon' : 'MultiPolygon', coordinates: components.length === 1 ? components[0] : components};
}
export function geometryMetadata(geometry) {
  const bbox = [Infinity, Infinity, -Infinity, -Infinity]; let area = 0, sx = 0, sy = 0, vertices = 0, holes = 0;
  for (const polygon of polygons(geometry)) {
    holes += polygon.length - 1;
    for (const ring of polygon) {
      vertices += ring.length; const [ox,oy] = ring[0]; let twice = 0, cx = 0, cy = 0;
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i]; bbox[0] = Math.min(bbox[0],p[0]); bbox[1] = Math.min(bbox[1],p[1]); bbox[2] = Math.max(bbox[2],p[0]); bbox[3] = Math.max(bbox[3],p[1]);
        if (i) {const a=ring[i-1], cross=(a[0]-ox)*(p[1]-oy)-(p[0]-ox)*(a[1]-oy); twice+=cross; cx+=(a[0]+p[0]-2*ox)*cross; cy+=(a[1]+p[1]-2*oy)*cross;}
      }
      if (!twice) throw new Error('Zero area ring');
      const signed = twice/2; area += signed; sx += (ox+cx/(3*twice))*signed; sy += (oy+cy/(3*twice))*signed;
    }
  }
  if (!(area > 0)) throw new Error('Nonpositive polygon area');
  return {bbox, centroid: [sx/area,sy/area], area, vertices, components: polygons(geometry).length, holes};
}
export function loadLockedInputs(root) {
  const read = p => JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
  for (const p of ['reports/prompt14/14-02-source-generation-delivery-decision.json','reports/prompt14/14-05-schema-migration-checkpoint.json']) if (read(p).status !== 'pass') throw new Error(`Unapproved prerequisite: ${p}`);
  const lock = read('data/source-locks/prompt14-derived-game-input-lock.json');
  const lockValidation = validateDerivedGameLock(lock, root);
  if (!lockValidation.pass) throw new Error(`Locked input validation failed: ${canonical(lockValidation)}`);
  const selected = read('data/derived/prompt14/selected-game-input.geojson');
  const plan = read('reports/prompt14/14-02-component-grouping-plan.json');
  const grouping = verifySourceComponentGroups(selected,plan);
  if (!grouping.pass) throw new Error(`Locked grouping failed: ${canonical(grouping)}`);
  return {lock, lockValidation, selected, plan, grouping, p0: read('data/derived/prompt14/shared-game-p0.geojson'),
    selection: read('reports/prompt14/14-02-game-input-selection.json'), metadata: read('src/data/countries-2020.json')};
}
export function generateAtoms(inputs) {
  const atoms = [], seen = new Set();
  const sourceVersion = inputs.lock.sourceVersion;
  for (const [featureIndex, f] of inputs.selected.features.entries()) {
    const p = f.properties;
    if (!/^[A-Z0-9]{3}$/.test(p.countryId) || p.sourceCountryId !== p.countryId || typeof p.sourceFeatureId !== 'string') throw new Error('Invalid source identity');
    const geometry = normalizeGeometry(f.geometry);
    const componentKeys = polygons(geometry).map(component => hashCanonical('catalog-component.v1',component)).sort(compareText);
    if (new Set(componentKeys).size !== componentKeys.length) throw new Error('Duplicate normalized component');
    const identity = {sourceCountryId: p.countryId, sourceVersion, sourceFeatureId: p.sourceFeatureId, inputRole: p.inputRole, componentKeys};
    const canonicalAtomKey = `atom:${p.countryId}:${hashCanonical('catalog-atom.v1',identity)}`;
    if (seen.has(canonicalAtomKey)) throw new Error('Duplicate canonical atom identity'); seen.add(canonicalAtomKey);
    const members = polygons(f.geometry).map((component, componentIndex) => ({featureIndex, componentIndex,
      componentInputSha256: digest(Buffer.from(JSON.stringify(component))), canonicalComponentKey: hashCanonical('catalog-component.v1',polygons(normalizeGeometry({type:'Polygon',coordinates:component}))[0])}));
    if (members.length !== componentKeys.length || canonical(members.map(m=>m.canonicalComponentKey).sort(compareText)) !== canonical(componentKeys)) throw new Error('Component membership is not bijective');
    atoms.push({canonicalAtomKey, identity, members, geometry, ...geometryMetadata(geometry)});
  }
  return atoms.sort((a,b)=>compareText(a.canonicalAtomKey,b.canonicalAtomKey));
}
export function validateAtoms(atoms, inputs, onProgress = () => {}) {
  const normalized = {type:'FeatureCollection',features:atoms.map(a=>({type:'Feature',properties:{countryId:a.identity.sourceCountryId},geometry:a.geometry}))};
  const validity = validatePolygonFeatureCollection(normalized,'canonical atoms',CANONICAL_P0_VALIDATOR_POLICY);
  if (!validity.pass) throw new Error(`Invalid normalized geometry: ${canonical(validity.errors)}`);
  const byCountry = new Map(); let vertices = 0, components = 0, holes = 0;
  for (const atom of atoms) {const id=atom.identity.sourceCountryId; const list=byCountry.get(id)??[];list.push(atom.geometry);byCountry.set(id,list);vertices+=atom.vertices;components+=atom.components;holes+=atom.holes;}
  if (canonical([...byCountry.keys()].sort()) !== canonical(inputs.metadata.map(c=>c.id).sort())) throw new Error('Country coverage differs from metadata');
  const coverage = inputs.p0.features.map((f,i)=>{
    const countryId=f.properties.countryId; const result=validatePartitionCoverage(f.geometry,byCountry.get(countryId)??[],CANONICAL_P0_VALIDATOR_POLICY);
    if (!result.pass) throw new Error(`Locked P0 partition failed ${countryId}: ${canonical(result)}`);
    if (i % 25 === 0) onProgress(`coverage ${i+1}/${inputs.p0.features.length} ${countryId}`);
    return {countryId,...result};
  });
  const caps=validateCaps({totalAtoms:atoms.length,countries:[...byCountry].map(([countryId,parts])=>({countryId,atomCount:parts.length}))},vertices);
  if (!caps.pass) throw new Error(`Final atom cap exceeded; return to 14-2 policy selection: ${canonical(caps)}`);
  for (const id of ['USA','CHN','KOR','GBR','FRA']) if ((byCountry.get(id)?.length??0) <= 1) throw new Error(`Lost partial occupation partitions: ${id}`);
  return {pass:true,countryCount:byCountry.size,atomCount:atoms.length,rawComponentAtomCandidates:components,authoritativeVertices:vertices,holes,
    caps,validity,coverage,componentMembershipBijection:true,sourceFeatureIdentitiesPreserved:atoms.length===inputs.selected.features.length,
    introducedProtectedBoundaryCrossings:0,maximumCoordinateDisplacement:0,geometryRepairCount:0,
    boundaryProofScope:'Normalization preserves the locked source geometry exactly. This certifies no introduced crossings; absolute boundary pairing/continuity requires the separate complete topology gate.'};
}
export function writeArtifact(directory, relativePath, bytes) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').some(p=>!p||p==='.'||p==='..')) throw new Error('Artifact path traversal');
  const target=path.join(directory,relativePath); fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);
  return {path:relativePath,sha256:digest(bytes),byteLength:bytes.length};
}
export function assertBuildOutput(root,output){
  const relative=path.relative(root,output);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Output must stay inside the workspace');
  if(relative.split(path.sep)[0].toLowerCase()==='public')throw new Error('Build-only whole-world geometry must not be written under public');
}
