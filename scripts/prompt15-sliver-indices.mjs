import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';
import {compareText, digest, hashCanonical, jsonBytes} from './prompt14-catalog-core.mjs';
import {CELL_EXPERIMENT_POLICY as POLICY} from './prompt15-cell-policy.mjs';
import {canonicalSegment, makeEdge} from './prompt15-world-indices-core.mjs';
import {assert, openDraft, loadMembershipInputs, compilerPins, changes, readJSON, readGzip, writeJSON, same} from './prompt15-sliver-indices-adapter.mjs';
import {SCHEMA, buildMembership, validateMembership, buildTopology, sourceSupport} from './prompt15-sliver-indices-core.mjs';
import {identity, safeRelative, assertFreshOutput} from './prompt15-sliver-adoption-draft.mjs';

export const COMPLETE = 'DRAFT_GLOBAL_INDICES_BUILT_PENDING_COUNTRY_VALIDATION';
const pairKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
function validateCsr(value, field, count) {
  const list = value[field]; assert(value.cellCount === count && value.offsets?.length === count + 1 && value.offsets[0] === 0 &&
    value.offsets.at(-1) === list?.length, `Invalid ${field} CSR shape`);
  for (let i = 1; i < value.offsets.length; i++) assert(Number.isInteger(value.offsets[i]) && value.offsets[i] >= value.offsets[i - 1], `Invalid ${field} offset`);
}
export function validateTopology(cells, adjacency, incidence, counts, readShard) {
  validateCsr(adjacency, 'neighbors', cells.length); validateCsr(incidence, 'signedEdges', cells.length);
  const left = new Int32Array(counts.edges + 1), right = new Int32Array(counts.edges + 1), incidenceSeen = new Uint8Array(counts.edges + 1);
  const ids = new Set(), pairs = new Set(), vertices = new Set(); let cursor = 0, supportCount = 0;
  for (let bucket = 0; bucket < 256; bucket++) {
    const {edges, support} = readShard(bucket);
    assert(Array.isArray(edges) && Array.isArray(support) && edges.length === support.length, 'Missing/duplicate edge support');
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i], trace = support[i]; cursor++;
      assert(edge.ordinal === cursor && trace.edgeOrdinal === cursor && !ids.has(edge.id), 'Stale/local ordinal or duplicate edge ID'); ids.add(edge.id);
      const [a, b] = edge.geometry.coordinates;
      assert(edge.geometry.type === 'LineString' && edge.geometry.coordinates.length === 2 && a.length === 2 && b.length === 2 &&
        [...a, ...b].every(Number.isFinite), 'Invalid topology edge geometry');
      const expected = makeEdge(cells, edge.left, edge.right, a, b, cursor);
      assert(same(edge, expected), 'Wrong edge ID/owner/classification/length');
      assert(trace.owners.length === (edge.right ? 2 : 1), 'Edge owner incidence trace count mismatch');
      const uniqueOwners = new Set(), canonical = canonicalSegment(a, b);
      for (const owner of trace.owners) {
        assert([edge.left, edge.right].includes(owner.ordinal) && !uniqueOwners.has(owner.ordinal) &&
          sourceSupport(canonical.a, canonical.b, ...owner.sourceSegment), 'Wrong/remote source segment or edge owner');
        assert(owner.ordinal === edge.left ? owner.side === canonical.side : owner.side !== canonical.side,
          'Source direction disagrees with left/right owner');
        uniqueOwners.add(owner.ordinal); supportCount++;
      }
      if (edge.right) {
        assert(trace.owners[0].side !== trace.owners[1].side, 'Same direction two-owner edge');
        pairs.add(pairKey(edge.left, edge.right));
      }
      for (const p of [a, b]) vertices.add(`${p[0]},${p[1]}`);
      left[cursor] = edge.left; right[cursor] = edge.right;
    }
  }
  assert(cursor === counts.edges && vertices.size === counts.topologyVertices, 'Measured edge/vertex census mismatch');
  const expectedPairCount = pairs.size;
  const binaryHas = (owner, target) => {
    let lo = adjacency.offsets[owner - 1], hi = adjacency.offsets[owner] - 1;
    while (lo <= hi) {const mid = (lo + hi) >>> 1, n = adjacency.neighbors[mid]; if (n === target) return true; if (n < target) lo = mid + 1; else hi = mid - 1;} return false;
  };
  for (let ordinal = 1; ordinal <= cells.length; ordinal++) {
    let previous = 0;
    for (let i = adjacency.offsets[ordinal - 1]; i < adjacency.offsets[ordinal]; i++) {
      const neighbor = adjacency.neighbors[i];
      assert(Number.isInteger(neighbor) && neighbor > previous && neighbor <= cells.length && neighbor !== ordinal &&
        binaryHas(neighbor, ordinal), 'Invalid/duplicate/asymmetric adjacency');
      if (ordinal < neighbor) assert(pairs.delete(pairKey(ordinal, neighbor)), 'Point-only/remote adjacency without a real edge');
      previous = neighbor;
    }
    let previousEdge = 0;
    for (let i = incidence.offsets[ordinal - 1]; i < incidence.offsets[ordinal]; i++) {
      const signed = incidence.signedEdges[i], edge = Math.abs(signed), bit = signed > 0 ? 1 : 2;
      assert(Number.isInteger(signed) && edge > previousEdge && edge <= counts.edges &&
        (signed > 0 ? left[edge] : right[edge]) === ordinal && !(incidenceSeen[edge] & bit), 'Wrong/duplicate/stale edge incidence');
      incidenceSeen[edge] |= bit; previousEdge = edge;
    }
  }
  assert(pairs.size === 0 && adjacency.neighbors.length === expectedPairCount * 2 && adjacency.adjacencyPairs === expectedPairCount, 'Missing edge adjacency');
  for (let i = 1; i <= counts.edges; i++) assert(incidenceSeen[i] === (right[i] ? 3 : 1), 'Missing left/right incidence');
  assert(incidence.signedEdges.length === supportCount && counts.incidenceReferences === supportCount, 'Incidence census mismatch');
  assert(cells.length <= POLICY.budgets.worldCells && cursor <= POLICY.budgets.worldEdges && vertices.size <= POLICY.budgets.worldVertices &&
    counts.sourceVertexOccurrences <= POLICY.budgets.worldVertices, 'Frozen world cell/edge/vertex cap exceeded');
  return {status: 'PASS', cells: cells.length, edges: cursor, uniqueEdgeIds: ids.size, topologyVertices: vertices.size,
    adjacencyPairs: expectedPairCount, incidenceReferences: supportCount, checks: {
      freshOrdinals: true, uniqueEdgeIds: true, validOwners: true, sourceSegmentSupport: true, positiveSharedBoundary: true,
      membershipValidatedSeparately: true, symmetricCompleteAdjacency: true, pointAndRemoteAdjacencyAbsent: true,
      completeLeftRightIncidence: true, frozenCaps: true}};
}
const runtime = () => ({node: process.version, v8: process.versions.v8, zlib: process.versions.zlib, platform: process.platform, arch: process.arch,
  jsts: readJSON('node_modules/jsts/package.json').version});
const metrics = started => ({elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, maxRssKiB: process.resourceUsage().maxRSS,
  maxRssBytes: process.resourceUsage().maxRSS * 1024, currentRssBytes: process.memoryUsage().rss,
  memoryBudgetInterpretation: 'Measured process RSS. The heap option is not budget evidence. Frozen offlineCountryRssBytes concerns country generation, which was not run; no separate global-index-build RSS limit is specified.'});

export function buildDraftIndices({catalogRoot, evidenceManifest, evidence, smoke = false, smokeReceipt}) {
  safeRelative(evidence); assert(evidence.startsWith('reports/prompt15/15-20-sliver-adoption/'), 'Use dedicated evidence tree');
  assertFreshOutput(evidence); fs.mkdirSync(evidence, {recursive: true});
  const started = process.hrtime.bigint(), startedAt = new Date().toISOString(); let context, code, inputPins, staging, root, phase = 'input-adapter';
  try {
    context = openDraft({catalogRoot, evidenceManifest}); code = compilerPins(); inputPins = context.snapshot;
    writeJSON(`${evidence}/before.json`, {inputs: inputPins, code, runtime: runtime()});
    const codeRoot = digest(jsonBytes(code)), inputRoot = digest(jsonBytes(inputPins));
    if (!smoke) {
      assert(smokeReceipt, 'A pinned passing smoke receipt is required before the one world build');
      const receipt = readJSON(smokeReceipt);
      assert(receipt.status === 'SMOKE_PASS' && receipt.codeRoot === codeRoot && receipt.inputRoot === inputRoot &&
        receipt.catalogIndex.sha256 === context.indexPin.sha256 && receipt.structuralValidation.status === 'PASS', 'Smoke receipt does not cover this compiler and input');
    }
    const order = smoke ? context.directory.countryOrder.filter(c => ['ABW', 'SXM', 'MAF'].includes(c)) : context.directory.countryOrder;
    phase = 'membership-inputs'; const sources = loadMembershipInputs(context, order), cells = sources.cells;
    assert(smoke || cells.length === 923413, 'World cell census mismatch');
    phase = 'membership'; const membership = buildMembership(cells, sources.parents, context.oldParents);
    const contentHash = hashCanonical('prompt15-sliver-global-indices-root.v1', {version: SCHEMA, code, inputs: inputPins, runtime: runtime()});
    const name = `15-20-sliver-adoption-indices-draft-v1-${contentHash.slice(0, 20)}`;
    root = smoke ? `${evidence}/smoke-output` : `data/derived/prompt15/${name}`;
    staging = smoke ? `${evidence}/smoke-staging` : `data/derived/prompt15/.${name}.staging`;
    assertFreshOutput(root); assertFreshOutput(staging); fs.mkdirSync(staging);
    const artifacts = [];
    const write = (rel, value, compressed = true) => {
      safeRelative(rel); const file = path.join(staging, rel); fs.mkdirSync(path.dirname(file), {recursive: true});
      const bytes = compressed ? gzipSync(jsonBytes(value), {level: 9, mtime: 0}) : jsonBytes(value);
      fs.writeFileSync(file, bytes, {flag: 'wx'}); artifacts.push({path: rel, sha256: digest(bytes), byteLength: bytes.length, compression: compressed ? 'gzip' : null});
    };
    write('catalog-order.json.gz', {schemaVersion: SCHEMA, ordinalRule: '1-based, ascending bytewise actual cell ID; fixed 247-country census, no inherited/local ordinal',
      cells, cellRoot: digest(jsonBytes(cells.map(c => c.id)))});
    write('administrative-membership.json.gz', membership.administrative); write('previous-parent-index.json.gz', membership.previous);
    write('historical-repair-receipts.json', {evidenceRole: context.historicalRole, receipts: sources.repairs,
      application: 'Provenance only; not independently applied as an extra geometry area delta in this structural build.'}, false);
    write('selection-evidence.json', {countries: sources.selectionReceipts, rule: context.manifest.sliverEvaluationRule,
      numericalDebt: context.manifest.numericalDebtSupplement, strictVerdictsUnchanged: true}, false);
    phase = 'topology'; const result = buildTopology({context, cells, countryOrder: order, work: `${evidence}/topology-work`, emit: write, partial: smoke});
    write('adjacency.json.gz', result.adjacency); write('incidence.json.gz', result.incidence);
    phase = 'serialized-structural-verification'; global.gc?.();
    const serializedCells = readGzip(`${staging}/catalog-order.json.gz`).cells;
    assert(same(serializedCells, cells), 'Serialized catalog order differs from selected IDs/parents');
    const membershipValidation = validateMembership(serializedCells, readGzip(`${staging}/administrative-membership.json.gz`), readGzip(`${staging}/previous-parent-index.json.gz`));
    assert(membershipValidation.pass, 'Serialized membership failed', membershipValidation);
    const structuralValidation = validateTopology(serializedCells, readGzip(`${staging}/adjacency.json.gz`), readGzip(`${staging}/incidence.json.gz`), result.counts,
      bucket => ({edges: readGzip(`${staging}/topology/${String(bucket).padStart(3, '0')}.json.gz`).edges,
        support: readGzip(`${staging}/source-support/${String(bucket).padStart(3, '0')}.json.gz`).support}));
    const counts = {...result.counts, countries: order.length, administrativeParents: membership.administrative.parents.length,
      previousParents: membership.previous.parents.length, historicalRepairReceipts: sources.repairs.length};
    const status = smoke ? 'SMOKE_PASS' : COMPLETE;
    if (smoke) assert(result.changedCrossBorder.some(e => [e.leftCountry, e.rightCountry].sort().join(':') === 'MAF:SXM'), 'Smoke did not observe actual SXM/MAF land boundary');
    const validation = {status: 'PASS', scope: smoke ? 'PARTIAL_ABW_SXM_MAF_ONLY; open outside context explicitly identified' : 'NEW_WORLD_REFERENCE_STRUCTURE_ONLY',
      membership: membershipValidation, topology: structuralValidation, noding: result.noding, mapCuts: result.mapCuts,
      externalContextEdges: result.externalContextEdges, changedCrossBorder: result.changedCrossBorder,
      notRun: ['country regeneration', 'parent preparation', '247-country geometry preservation/sliver audit', '15-21', 'final join', '15-23']};
    write('structural-validation.json', validation, false);
    const roots = {catalogOrder: digest(jsonBytes(cells.map(c => c.id))),
      topology: hashCanonical('prompt15-sliver-topology-root.v1', artifacts.filter(a => a.path.startsWith('topology/'))),
      membership: hashCanonical('prompt15-sliver-membership-root.v1', artifacts.filter(a => a.path.includes('membership') || a.path.includes('previous-parent'))),
      incidence: artifacts.find(a => a.path === 'incidence.json.gz').sha256, adjacency: artifacts.find(a => a.path === 'adjacency.json.gz').sha256};
    write('index-root.json', {schemaVersion: SCHEMA, status, sourceCatalogRoot: catalogRoot, countryOrder: order, roots, counts,
      catalogOrder: 'catalog-order.json.gz', administrativeMembership: 'administrative-membership.json.gz', previousParentIndex: 'previous-parent-index.json.gz',
      topologyShards: Array.from({length: 256}, (_, i) => `topology/${String(i).padStart(3, '0')}.json.gz`), adjacency: 'adjacency.json.gz', incidence: 'incidence.json.gz'}, false);
    write('provenance.json', {schemaVersion: SCHEMA, compiler: code, inputPins, runtime: runtime(), sourceCatalogIndex: context.indexPin,
      manifest: identity(process.cwd(), evidenceManifest), fixedPhysicalPolicy: context.manifest.frozenPhysicalPolicy, separateSliverRule: context.manifest.sliverEvaluationRule,
      historicalEvidence: context.historicalRole, legacyHelperCompatibility: context.manifest.legacyHelperCompatibility,
      topologyRule: 'Existing exact-pair preservation and fixed 1e12 common edge noding only; source-cell coordinates are never written. Every output edge records immutable input-owner source segments and bounded support.',
      strictPastFailures: 'Unchanged original six and exact scoped seven; development continuation is not strict geometry PASS.',
      candidateApproved: false, geometryRegeneration: false, localOrOldWorldReferencesImported: false}, false);
    const summary = {status, scope: 'draft-global-reference-build-only', root, counts, roots, inputRoot, codeRoot,
      membershipValidation, structuralValidation, mapCuts: result.mapCuts, resources: metrics(started),
      countryGeometryAudit: 'NOT_RUN', sliverV2Reevaluation: 'NOT_RUN; 23 pinned receipts only', task15_22OverallPass: false, approvalPointersChanged: false};
    write('summary.json', summary, false);
    artifacts.sort((a, b) => compareText(a.path, b.path));
    writeJSON(`${staging}/artifact-index.json`, {schemaVersion: SCHEMA, root, artifacts, totalByteLength: artifacts.reduce((n, a) => n + a.byteLength, 0),
      command: 'node scripts/prompt15-sliver-indices.mjs --catalog-root <pinned-draft> --manifest <pinned-selection-manifest> --evidence <new-run> --smoke-receipt <same-code-smoke.json>'});
    phase = 'artifact-and-immutability-verification';
    for (const a of artifacts) {const b = fs.readFileSync(`${staging}/${a.path}`); assert(digest(b) === a.sha256 && b.length === a.byteLength, `Artifact mismatch: ${a.path}`);}
    const disk = fs.readdirSync(staging, {recursive: true, withFileTypes: true}).filter(e => e.isFile()).map(e =>
      path.relative(staging, path.join(e.parentPath, e.name)).replaceAll('\\', '/')).sort(compareText);
    assert(same(disk, [...artifacts.map(a => a.path), 'artifact-index.json'].sort(compareText)), 'Unindexed or missing output artifact');
    const inputChanges = changes(inputPins), codeChanges = changes(code);
    assert(!inputChanges.length && !codeChanges.length, 'Compiler or inputs changed during build', {inputChanges, codeChanges});
    assertFreshOutput(root); fs.renameSync(staging, root);
    writeJSON(`${evidence}/summary.json`, {...summary, startedAt, finishedAt: new Date().toISOString(), resources: metrics(started),
      catalogIndex: context.indexPin, artifactIndex: identity(process.cwd(), `${root}/artifact-index.json`),
      inputChanges, codeChanges, newGlobalCellOrder: true, reusedLocalWorldReferences: false,
      buildCount: smoke ? 0 : 1, partialSmokeOnly: smoke});
    writeJSON(`${evidence}/handoff.json`, {status: 'PENDING_SEPARATE_15_21_AND_COUNTRY_VALIDATION', inputCatalogRoot: catalogRoot,
      indexRoot: root, artifactIndex: identity(process.cwd(), `${root}/artifact-index.json`), schemaVersion: SCHEMA,
      deliveryInputs: ['catalog-order.json.gz', 'administrative-membership.json.gz', 'previous-parent-index.json.gz', 'topology/*.json.gz', 'adjacency.json.gz', 'incidence.json.gz', 'index-root.json'],
      catalogGeometryInput: context.indexPin, rule: context.manifest.sliverEvaluationRule, numericalDeferral: context.manifest.numericalDebtSupplement,
      sourceSupportShards: 'source-support/*.json.gz; every edge bound to actual input owner segments',
      legacyV20Verifier: 'Retains its original fixed pins and was not run on this new draft. New structure verification does not replace full independent country geometry validation.',
      remainingValidation: 'Partition all 247 countries under identical final code/input/rule identities after separately authorized delivery preparation; preserve strict FAIL/native 1 debts, validate changed 16 plus actual adjacent countries first.',
      autoProgress: false});
    console.log(JSON.stringify({status, root, counts, resources: metrics(started)})); return {...summary, root};
  } catch (error) {
    writeJSON(`${evidence}/failure.json`, {status: 'DRAFT_GLOBAL_INDICES_BUILD_FAIL', phase, error: error.message, detail: error.detail ?? null,
      stack: error.stack, staging: staging ?? null, root: root ?? null, startedAt, finishedAt: new Date().toISOString(), resources: metrics(started),
      inputChanges: inputPins ? changes(inputPins) : null, codeChanges: code ? changes(code) : null,
      action: 'STOP; no automatic world rebuild, country generation or numerical geometry repair'});
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === '--smoke') options.smoke = true;
    else {
      const names = {'--catalog-root': 'catalogRoot', '--manifest': 'evidenceManifest', '--evidence': 'evidence', '--smoke-receipt': 'smokeReceipt'};
      assert(names[option] && args[i + 1] && !args[i + 1].startsWith('--'), `Invalid CLI argument ${option}`); options[names[option]] = args[++i];
    }
  }
  try {buildDraftIndices(options);} catch (error) {console.error(error.stack); process.exitCode = 1;}
}
