import fs from 'node:fs';
import path from 'node:path';
import {builtinModules, createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
import {digest, hashCanonical, jsonBytes, compareText} from './prompt14-catalog-core.mjs';
import {verifyTree, identity, readJSON, readGzipJSON, POLICY} from './prompt15-world-delivery-core.mjs';

export const VERSION = 'prompt15-sliver-adoption-delivery-draft-v1';
export const REF_VERSION = 'prompt15-sliver-adoption-delivery-ref-v1';
export const INDEX_SCHEMA = 'prompt15-sliver-adoption-indices-draft-v1';
export const INPUTS = Object.freeze({
  catalog: {sha256: 'a32a1687a0988eabd48175ccd394c800005bc652be085927854124d4e0f046af', byteLength: 165354},
  indices: {sha256: 'cc77ef54ae5b7751c32a8afd1a7776029a2d931d4e53b99b135caf4cf89eae75', byteLength: 79999},
});
export const STRUCTURAL_REPORT = 'reports/prompt15/15-20-sliver-adoption-verification/20261028-independent/verification.json';
export const assert = (value, message, detail) => {if (!value) throw Object.assign(Error(message), {detail});};
export const equal = (a, b, message) => assert(digest(jsonBytes(a)) === digest(jsonBytes(b)), message);
export const missing = (seen, expected) => expected.filter(o => !seen[o]);
export const allOrdinals = n => Array.from({length: n}, (_, i) => i + 1);
export const resource = start => ({elapsedMs: Number(process.hrtime.bigint() - start) / 1e6, peakRssBytes: process.resourceUsage().maxRSS * 1024,
  runtimePerformance: 'UNMEASURED: server/browser heap, bootstrap time, provider payload. Offline RSS is not runtime budget PASS.'});
export function dependencySpecifiers(source) {
  const stack = [parse(source, {ecmaVersion: 'latest', sourceType: 'module', allowReturnOutsideFunction: true})], result = [];
  while (stack.length) {
    const node = stack.pop();
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source?.value) result.push({spec: node.source.value, esm: true});
    if (node.type === 'ImportExpression' && typeof node.source?.value === 'string') result.push({spec: node.source.value, esm: true});
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && typeof node.arguments[0]?.value === 'string') result.push({spec: node.arguments[0].value, esm: false});
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) {if (child?.type) stack.push(child);}
      else if (value?.type) stack.push(value);
    }
  }
  return result;
}
export function codeIdentities() {
  const found = new Map(), builtins = new Set(builtinModules.flatMap(n => [n, `node:${n}`]));
  const visit = file => {
    file = file.replaceAll('\\', '/'); if (found.has(file)) return; found.set(file, identity(file));
    if (file.endsWith('.json')) return;
    const source = fs.readFileSync(file, 'utf8'), require = createRequire(path.resolve(file));
    for (const {spec, esm} of dependencySpecifiers(source)) {
      if (builtins.has(spec) || spec.startsWith('node:')) continue;
      if (spec.startsWith('.')) visit(path.relative(process.cwd(), require.resolve(spec)));
      else {
        if (esm) {const imported = import.meta.resolve(spec); if (imported.startsWith('file:')) visit(path.relative(process.cwd(), fileURLToPath(imported)));}
        const resolved = require.resolve(spec); if (!builtins.has(resolved) && !resolved.startsWith('node:')) visit(path.relative(process.cwd(), resolved));
      }
    }
  };
  for (const file of ['scripts/prompt15-sliver-delivery.mjs', 'scripts/verify-prompt15-sliver-delivery.mjs', 'scripts/prompt15-sliver-delivery.node-test.mjs']) visit(file);
  for (const file of ['scripts/prompt15-world-delivery.mjs', 'scripts/verify-prompt15-world-delivery.mjs', 'scripts/prompt15-world-delivery.node-test.mjs',
    'scripts/prompt15-cell-policy.mjs', 'package.json', 'package-lock.json', 'node_modules/geojson-vt/package.json',
    'node_modules/@maplibre/vt-pbf/package.json', 'node_modules/@mapbox/vector-tile/package.json', 'node_modules/pbf/package.json']) found.set(file, identity(file));
  return [...found.values()].sort((a, b) => compareText(a.path, b.path));
}
export function inputChanges(pins) {
  return pins.flatMap(p => {try {const a = identity(p.path); return a.sha256 === p.sha256 && a.byteLength === p.byteLength ? [] : [{before: p, after: a}];}
    catch (error) {return [{before: p, error: error.message}];}});
}
export function validateBindings(order, admin, previous) {
  const n = order.cells.length, seen = new Set();
  assert(order.schemaVersion === INDEX_SCHEMA && admin.schemaVersion === INDEX_SCHEMA && previous.schemaVersion === INDEX_SCHEMA &&
    admin.cellCount === n && previous.cellCount === n, 'Wrong source order/membership schema or census');
  for (const [i, cell] of order.cells.entries()) {
    assert(cell.ordinal === i + 1 && !seen.has(cell.id) && (i === 0 || order.cells[i - 1].id < cell.id), 'Stale/local/duplicate cell ordinal or ID'); seen.add(cell.id);
  }
  for (const [membership, kind] of [[admin, 'administrative'], [previous, 'previous']]) {
    assert(membership.cellOrdinals.length === n, 'Missing/extra/truncated membership');
    const used = new Uint8Array(n + 1), parents = new Set(); let cursor = 0;
    for (const [i, parent] of membership.parents.entries()) {
      const key = kind === 'administrative' ? parent.parentKey : parent.oldTerritoryId;
      assert(key && !parents.has(key) && parent.start === cursor && Number.isInteger(parent.count) && parent.count > 0 && parent.count <= n - cursor, 'Wrong or duplicate parent CSR'); parents.add(key);
      for (let at = cursor; at < cursor + parent.count; at++) {
        const o = membership.cellOrdinals[at], c = order.cells[o - 1];
        assert(c && !used[o] && c.sourceCountryId === parent.sourceCountryId &&
          (kind === 'administrative' ? c.parentKey === key && c.adminId === parent.adminId && admin.parentOrdinalByCell[o - 1] === i + 1 :
            c.oldTerritoryId === key && previous.oldParentOrdinalByCell[o - 1] === i + 1), 'Wrong parent/cell forward or reverse membership'); used[o] = 1;
      }
      cursor += parent.count;
    }
    assert(cursor === n && used.reduce((a, b) => a + b, 0) === n, 'Incomplete membership census');
  }
}
export function verifyRootBindings({catalogRoot, indicesRoot, directory, indices, indicesIndexSchema, indexRoot, order, admin, previous}) {
  assert(directory.schemaVersion === 'prompt15-task-15-19-world-catalog-v1' && directory.preparationStatus === 'DRAFT_CATALOG_PREPARED_PENDING_VALIDATION' && directory.cellCount === order.cells.length,
    'Unrecognized catalog draft state/census');
  assert(indicesIndexSchema === INDEX_SCHEMA && (indices.schemaVersion === undefined || indices.schemaVersion === INDEX_SCHEMA) && indices.status === 'DRAFT_GLOBAL_INDICES_BUILT_PENDING_COUNTRY_VALIDATION' &&
    indexRoot.schemaVersion === INDEX_SCHEMA && indexRoot.sourceCatalogRoot === catalogRoot && indices.root === indicesRoot,
  'Wrong draft indices schema/state/source root');
  equal(indexRoot.countryOrder, directory.countryOrder, 'Country directory mismatch');
  validateBindings(order, admin, previous);
  assert(indexRoot.roots.catalogOrder === digest(jsonBytes(order.cells.map(c => c.id))), 'Wrong catalog order root');
}
export function openDeliveryInputs({catalogRoot, indicesRoot, structuralReport = STRUCTURAL_REPORT, smoke = false}) {
  const catalog = verifyTree(catalogRoot, INPUTS.catalog), indicesTree = verifyTree(indicesRoot, INPUTS.indices);
  assert(catalog.index.root === catalogRoot && indicesTree.index.root === indicesRoot, 'Indexed input root mismatch');
  const directory = readJSON(`${catalogRoot}/catalog-root.json`), indices = readJSON(`${indicesRoot}/summary.json`), indexRoot = readJSON(`${indicesRoot}/index-root.json`);
  const order = readGzipJSON(`${indicesRoot}/catalog-order.json.gz`), admin = readGzipJSON(`${indicesRoot}/administrative-membership.json.gz`), previous = readGzipJSON(`${indicesRoot}/previous-parent-index.json.gz`);
  verifyRootBindings({catalogRoot, indicesRoot, directory, indices, indicesIndexSchema: indicesTree.index.schemaVersion, indexRoot, order, admin, previous});
  assert(directory.countryOrder.length === 247 && order.cells.length === 923413 && indices.counts.edges === 3125713 &&
    indices.counts.adjacencyPairs === 2187521 && admin.parents.length === 4761 && previous.parents.length === 4231, 'Unexpected draft census');
  const sourceArtifact = name => {const a = indicesTree.index.artifacts.find(a => a.path === name); assert(a, `Missing source artifact ${name}`); return a;};
  const membershipArtifacts = ['administrative-membership.json.gz', 'previous-parent-index.json.gz'].map(sourceArtifact);
  const combined = hashCanonical('prompt15-sliver-membership-root.v1', membershipArtifacts);
  assert(combined === indexRoot.roots.membership, 'Combined membership root differs from its actual artifacts');
  const topologyArtifacts = indicesTree.index.artifacts.filter(a => a.path.startsWith('topology/'));
  assert(hashCanonical('prompt15-sliver-topology-root.v1', topologyArtifacts) === indexRoot.roots.topology, 'Topology root differs from actual shards');
  equal(indexRoot.topologyShards, topologyArtifacts.map(a => a.path), 'Topology shard directory mismatch');
  assert(structuralReport === STRUCTURAL_REPORT, 'Use the explicit independent structure receipt');
  const independent = readJSON(structuralReport);
  assert(independent.status === 'PASS_GLOBAL_REFERENCE_STRUCTURE_ONLY' && independent.membership.cells === order.cells.length &&
    independent.topology.edges === indices.counts.edges && independent.debt.scopedFindings === 23, 'Invalid independent structure evidence');
  const inputPins = [...[catalog, indicesTree].flatMap((tree, i) => [{...tree.identity}, ...tree.index.artifacts.map(a => ({path: `${i ? indicesRoot : catalogRoot}/${a.path}`, sha256: a.sha256, byteLength: a.byteLength}))])];
  for (const file of [structuralReport, path.posix.join(path.posix.dirname(structuralReport), 'verify.mjs'),
    'docs/automation/prompt15-sliver-evaluation-v2.json', 'docs/automation/prompt15-numerical-deferral.json',
    'reports/prompt15/15-22-sliver-closeout/20261028-closeout-d017f7145d/adoption-manifest.json',
    'reports/prompt15/15-22-sliver-closeout/20261028-closeout-d017f7145d/numerical-deferral-supplement.json',
    'reports/prompt15/15-20-sliver-adoption/20261028-indices-6084b5f890/numerical-debt-carryforward.json',
    'reports/prompt15/15-20-sliver-adoption/20261028-indices-6084b5f890/summary.json',
    'reports/prompt15/15-20-sliver-adoption/20261028-indices-6084b5f890/handoff.json']) inputPins.push(identity(file));
  inputPins.sort((a, b) => compareText(a.path, b.path));
  const activeCountries = smoke ? directory.countryOrder.filter(c => ['ABW', 'SXM', 'MAF'].includes(c)) : directory.countryOrder;
  const expectedCells = order.cells.filter(c => activeCountries.includes(c.sourceCountryId)).map(c => c.ordinal);
  let expectedEdges = null;
  if (smoke) {
    const incidence = readGzipJSON(`${indicesRoot}/incidence.json.gz`), edges = new Set();
    for (const o of expectedCells) for (let at = incidence.offsets[o - 1]; at < incidence.offsets[o]; at++) edges.add(Math.abs(incidence.signedEdges[at]));
    expectedEdges = [...edges].sort((a, b) => a - b);
  }
  return {catalogRoot, indicesRoot, trees: [catalog, indicesTree], directory, indices, indexRoot, order, admin, previous, sourceArtifact,
    sourceBindings: {schemaVersion: 'prompt15-separate-membership-artifact-bindings-v1', combinedMembershipRoot: combined,
      administrative: {root: indicesRoot, artifact: sourceArtifact('administrative-membership.json.gz')},
      previous: {root: indicesRoot, artifact: sourceArtifact('previous-parent-index.json.gz')}},
    inputPins, independentReport: {identity: identity(structuralReport), status: independent.status, scope: independent.scope},
    scope: smoke ? 'SMOKE_ABW_MAF_SXM_GLOBAL_ORDINALS_ONLY' : 'WORLD', activeCountries, expectedCells,
    expectedEdges: expectedEdges ?? allOrdinals(indices.counts.edges), cellCount: order.cells.length, edgeCount: indices.counts.edges};
}
export function membershipBytes(membership, parentOrdinals) {
  const bytes = Buffer.alloc(membership.cellOrdinals.length * 4);
  for (const ordinal of parentOrdinals) {
    const p = membership.parents[ordinal - 1]; assert(p, 'Missing membership parent ordinal');
    for (let i = p.start; i < p.start + p.count; i++) bytes.writeUInt32LE(membership.cellOrdinals[i], i * 4);
  }
  return bytes;
}
export function parentMetadata(context, transports) {
  const selected = new Set(context.expectedCells), cells = context.order.cells;
  const adminOrdinals = new Set([...selected].map(o => context.admin.parentOrdinalByCell[o - 1])), previousOrdinals = new Set([...selected].map(o => context.previous.oldParentOrdinalByCell[o - 1]));
  const rows = (membership, ordinals, kind) => [...ordinals].sort((a, b) => a - b).map(ordinal => {
    const p = membership.parents[ordinal - 1], {historicalParent, ...descriptor} = p;
    return {ordinal, descriptor, currentMembership: {start: p.start, count: p.count, recordBytes: 4, format: 'uint32-le-cell-ordinal', artifact: transports[kind]},
      historicalGeneration: historicalParent ? {cellCount: historicalParent.cellCount, parentHash: historicalParent.parentHash,
        role: 'PAST_EVIDENCE_ONLY; current count is currentMembership.count; no new generation PASS'} : null};
  });
  assert([...selected].every(o => cells[o - 1]), 'Wrong scoped cell ordinal');
  return {schemaVersion: VERSION, sourceBindings: context.sourceBindings, partial: context.scope !== 'WORLD',
    administrative: rows(context.admin, adminOrdinals, 'administrative'), previous: rows(context.previous, previousOrdinals, 'previous')};
}
export function budgetAccounting({artifacts, deliveryIndexBytes, artifactIndexBytes}) {
  const byName = new Map(artifacts.map(a => [a.path, a.byteLength]));
  const initial = ['manifest.json', 'tile-index.json', 'detail-index.json', POLICY.edgeIncidence.path];
  for (const p of initial) assert(byName.has(p), `Missing required initial metadata ${p}`);
  const delivered = artifacts.reduce((n, a) => n + a.byteLength, 0) + deliveryIndexBytes + artifactIndexBytes;
  const initialMetadata = initial.reduce((n, p) => n + byName.get(p), 0) + deliveryIndexBytes + artifactIndexBytes;
  return {delivered, initialMetadata, pass: delivered <= POLICY.renderByteBudget && initialMetadata <= POLICY.initialMetadataByteBudget};
}
