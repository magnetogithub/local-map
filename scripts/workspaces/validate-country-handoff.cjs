// Read-only workspace envelope checks. Geography meanings remain in the shared TS validators.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync, spawnSync} = require('node:child_process');
const ts = require('typescript');
const previousLoader = require.extensions['.ts'];
require.extensions['.ts'] = (mod, file) => mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}, fileName: file,
}).outputText, file);
const shared = require('../../src/lib/geography/state-province-contract.ts');
require('../../src/lib/geography/country-metadata-input.ts');
const io = require('../../src/lib/geography/state-province-io.ts');
if (previousLoader) require.extensions['.ts'] = previousLoader;
else delete require.extensions['.ts'];
const CONTRACTS = Object.freeze({workspace: 'country-workspace-handoff-v1', ownership: 'workspace-ownership-v1',
  layout: 'workspace-layout-v1', geography: shared.GEOGRAPHY_SCHEMA_VERSION});
const ENTRY_POINTS = ['src/lib/geography/country-metadata-input.ts', 'src/lib/geography/state-province-io.ts'];
const FIXED = ['package.json', 'package-lock.json', 'scripts/workspaces/validate-country-handoff.cjs',
  'docs/geography/country-metadata-handoff-v1.md', 'docs/development/workspace-ownership-v1.md',
  'docs/development/workspace-layout-v1.md', 'docs/development/country-workspace-handoff-v1.md'];
const fail = (code, message) => {const error = new Error(message); error.code = code; throw error;};
const ensure = (condition, code, message) => {if (!condition) fail(code, message);};
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(canonical(value[k]))])) : value);
const equal = (a, b) => canonical(a) === canonical(b);
const text = value => typeof value === 'string' && value.trim().length > 0;
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', windowsHide: true}).trim();
function localFile(root, relative) {
  ensure(typeof relative === 'string' && /^[A-Za-z0-9._/-]+$/.test(relative) && relative.split('/').every(p => p && p !== '.' && p !== '..'), 'HANDOFF_PATH', `Invalid relative path: ${relative}`);
  const realRoot = fs.realpathSync(root), target = path.resolve(root, relative);
  ensure(fs.existsSync(target), 'HANDOFF_MISSING_ARTIFACT', `Missing artifact: ${relative}`);
  const difference = path.relative(realRoot, fs.realpathSync(target));
  ensure(difference && !difference.startsWith('..') && !path.isAbsolute(difference) && fs.statSync(target).isFile(), 'HANDOFF_PATH', `Artifact escapes root or is not a file: ${relative}`);
  return target;
}
function pin(root, relative) {
  const bytes = fs.readFileSync(localFile(root, relative));
  return shared.geographyArtifactSchema.parse({path: relative, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length});
}
function checkPins(root, artifacts, label) {
  ensure(Array.isArray(artifacts), 'HANDOFF_SCHEMA', `${label} must be an artifact array`);
  const seen = new Set();
  for (const value of artifacts) {
    const parsed = shared.geographyArtifactSchema.safeParse(value);
    ensure(parsed.success && !seen.has(value.path), 'HANDOFF_SCHEMA', `Invalid/duplicate ${label} artifact`);
    seen.add(value.path);
    ensure(equal(value, pin(root, value.path)), 'HANDOFF_PIN', `Changed ${label} bytes: ${value.path}`);
  }
}
function commonPaths(root) {
  const found = new Set(FIXED), pending = [...ENTRY_POINTS];
  while (pending.length) {
    const relative = pending.pop();
    if (found.has(relative)) continue;
    found.add(relative);
    const file = localFile(root, relative);
    for (const item of ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true).importedFiles) {
      if (!item.fileName.startsWith('.')) continue;
      const resolved = ts.resolveModuleName(item.fileName, file, {moduleResolution: ts.ModuleResolutionKind.Node10, resolveJsonModule: true}, ts.sys).resolvedModule;
      ensure(resolved, 'HANDOFF_DEPENDENCY', `Unresolved common import: ${relative}:${item.fileName}`);
      pending.push(path.relative(root, resolved.resolvedFileName).split(path.sep).join('/'));
    }
  }
  return [...found].sort();
}
function cleanCommon(root, files) {
  // Git normalizes configured LF/CRLF attributes; comparing raw Git blobs would be incorrect.
  const tracked = new Set(execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...files], {encoding: 'utf8', windowsHide: true}).split('\0'));
  ensure(files.every(file => tracked.has(file)), 'HANDOFF_DIRTY_DEPENDENCY', 'Consumed common code/contracts must be tracked before capture');
  const diff = spawnSync('git', ['-C', root, 'diff', '--quiet', 'HEAD', '--', ...files], {windowsHide: true});
  ensure(diff.status === 0, 'HANDOFF_DIRTY_DEPENDENCY', 'Commit consumed common code/contracts before capturing or accepting evidence');
}
function captureBaseline(root, dependencyPaths = []) {
  root = path.resolve(root);
  ensure(Array.isArray(dependencyPaths) && dependencyPaths.every(text), 'HANDOFF_SCHEMA', 'dependencies must be relative path strings');
  const paths = new Set([...commonPaths(root), ...dependencyPaths]);
  cleanCommon(root, commonPaths(root));
  const json = (file, expected) => {
    const actual = pin(root, file);
    ensure(!expected || actual.sha256 === expected.sha256 && actual.byteLength === expected.byteLength, 'HANDOFF_PIN', `Current artifact pin mismatch: ${file}`);
    paths.add(file);
    return JSON.parse(fs.readFileSync(localFile(root, file), 'utf8').replace(/^\uFEFF/u, ''));
  };
  const pointer = json('data/runtime/operational-catalog/current.json');
  const index = json(`${pointer.root}/artifact-index.json`, pointer.index);
  ensure(index.schemaVersion === 'operational-world-delivery-v2' && Array.isArray(index.artifacts), 'HANDOFF_SCHEMA', 'Unsupported operational artifact index');
  const delivery = name => {
    const matches = index.artifacts.filter(a => a.path === name);
    ensure(matches.length === 1, 'HANDOFF_SCHEMA', `Missing/duplicate operational artifact: ${name}`);
    return json(`${pointer.root}/${name}`, matches[0]);
  };
  const descriptor = delivery('catalog.json'), catalogManifest = delivery('manifest.json');
  const catalogRef = shared.geographyCatalogRefSchema.parse(descriptor.catalogRef);
  ensure(catalogRef.manifestPath === `/data/territory-catalog/${catalogRef.catalogVersion}/manifest.json`, 'HANDOFF_STALE_REF', 'Catalog manifest delivery URL does not match its versioned indexed manifest');
  ensure(pointer.catalogVersion === catalogRef.catalogVersion && ['catalogVersion', 'geometryRoot', 'topologyRoot', 'renderArtifactRoot']
    .every(k => catalogManifest.ref[k] === catalogRef[k]), 'HANDOFF_STALE_REF', 'Operational pointer/index/descriptor/manifest disagree');
  const registry = json('data/runtime/geography/current.json');
  const manifest = json(registry.manifest.path, registry.manifest);
  const metadataRef = shared.geographyMetadataRefSchema.parse(registry.metadataRef);
  ensure(registry.schemaVersion === 'geography-registry-v1' && manifest.schemaVersion === 'state-province-manifest-v1'
    && equal(shared.geographyCatalogRefSchema.parse(registry.catalogRef), catalogRef)
    && equal(shared.geographyCatalogRefSchema.parse(manifest.catalogRef), catalogRef)
    && equal(shared.geographyMetadataRefSchema.parse(manifest.metadataRef), metadataRef), 'HANDOFF_STALE_REF', 'Active geography references disagree');
  ensure(io.validateGeographyManifest(manifest, {catalogRef, metadataRef}).ok, 'HANDOFF_SCHEMA', 'Shared production geography manifest validation failed');
  for (const artifact of [manifest.metadata, manifest.admission]) {
    shared.geographyArtifactSchema.parse(artifact);
    ensure(equal(pin(root, artifact.path), artifact), 'HANDOFF_PIN', `Active geography payload changed: ${artifact.path}`);
    paths.add(artifact.path);
  }
  ensure(Array.isArray(descriptor.countryOrder) && new Set(descriptor.countryOrder).size === descriptor.countryOrder.length, 'HANDOFF_SCHEMA', 'Invalid registered country order');
  const countryIds = descriptor.countryOrder.map(c => shared.geographyCountryIdSchema.parse(c));
  return {schemaVersion: 'country-workspace-baseline-v1', head: git(root, 'rev-parse', 'HEAD'), contracts: CONTRACTS,
    catalogRef, metadataRef, countryIds, dependencies: [...paths].sort().map(file => pin(root, file))};
}
function ancestor(root, commit, head) {
  ensure(typeof commit === 'string' && /^[a-f0-9]{40}$/.test(commit), 'HANDOFF_COMMIT', 'Expected a full Git commit');
  const checked = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', commit, head], {windowsHide: true});
  ensure(checked.status === 0, 'HANDOFF_COMMIT', `Commit is not an ancestor of the current integration HEAD: ${commit}`);
}
function codeCommit(root, commit) {
  ensure(typeof commit === 'string' && /^[a-f0-9]{40}$/.test(commit), 'HANDOFF_COMMIT', 'Expected a full producer/validation commit');
  const checked = spawnSync('git', ['-C', root, 'cat-file', '-t', commit], {encoding: 'utf8', windowsHide: true});
  ensure(checked.status === 0 && checked.stdout.trim() === 'commit', 'HANDOFF_COMMIT', 'Producer/validation commit is unavailable; fetch or provide it for review');
}
function validateCountryHandoff(value, {root, baseline, expectedCountryId}) {
  try {
    ensure(value && typeof value === 'object' && baseline && baseline.schemaVersion === 'country-workspace-baseline-v1', 'HANDOFF_SCHEMA', 'Expected handoff and integration-captured baseline');
    ensure(Array.isArray(baseline.dependencies), 'HANDOFF_SCHEMA', 'Missing integration dependency inventory');
    const current = captureBaseline(root, baseline.dependencies.map(a => a.path));
    ensure(equal(current, baseline), 'HANDOFF_STALE_BASELINE', 'Recapture the integration baseline from the latest checkout; supplied baseline no longer matches');
    ensure(value.schemaVersion === CONTRACTS.workspace && equal(value.contracts, CONTRACTS), 'HANDOFF_SCHEMA', 'Workspace/geography contract versions differ');
    ensure(['unassigned', 'source-preparation', 'country-metadata-preparation'].includes(value.stage), 'HANDOFF_SCHEMA', 'Unsupported preparation stage');
    ensure(expectedCountryId === null || shared.geographyCountryIdSchema.safeParse(expectedCountryId).success, 'HANDOFF_COUNTRY', 'The integrator must select an actual CountryId or explicit null');
    ensure(value.countryId === expectedCountryId, 'HANDOFF_COUNTRY', 'Submission belongs to a different assigned country');
    ensure(value.countryId === null ? value.stage === 'unassigned' : value.stage !== 'unassigned' && current.countryIds.includes(value.countryId), 'HANDOFF_COUNTRY', 'Country/stage is not registered for this catalog');
    ensure(equal(shared.geographyCatalogRefSchema.parse(value.catalogRef), current.catalogRef)
      && equal(shared.geographyMetadataRefSchema.parse(value.metadataRef), current.metadataRef), 'HANDOFF_STALE_REF', 'Full active catalogRef/metadataRef changed; synchronize and revalidate');
    ensure(equal(value.dependencies, current.dependencies), 'HANDOFF_REVALIDATION', 'Consumed code/input pins changed or are missing; synchronize and rerun affected checks');
    ancestor(root, value.baseCommit, current.head);
    if (value.baseCommit !== current.head) {
      ensure(value.impactReview && value.impactReview.reviewedCommit === current.head && text(value.impactReview.reason), 'HANDOFF_IMPACT_REVIEW', 'A different current HEAD requires an explicit dependency impact review');
      checkPins(root, [value.impactReview.evidence], 'impact review');
    }
    checkPins(root, value.inputs, 'input'); checkPins(root, value.outputs, 'output');
    ensure(value.producer && value.source && value.ownership && value.quality && value.revalidation, 'HANDOFF_SCHEMA', 'Missing preparation, ownership, quality or revalidation information');
    const {source, ownership, quality, producer} = value;
    ensure(Array.isArray(ownership.ownedPaths) && ownership.ownedPaths.every(p => typeof p === 'string' && /^[A-Za-z0-9._/-]+$/.test(p)
      && p.split('/').every(s => s && s !== '.' && s !== '..')) && Array.isArray(ownership.sharedChanges)
      && ownership.sharedChanges.every(text) && text(ownership.nonTargetImpact), 'HANDOFF_SCHEMA', 'Ownership and known non-target impact must be explicit');
    const countryPrefixes = ['data/raw/country-prep/', 'data/source-locks/country-prep/', 'data/derived/country-prep/', 'reports/country-prep/']
      .map(p => `${p}${value.countryId}/`);
    ensure(ownership.ownedPaths.every(p => countryPrefixes.some(prefix => p.startsWith(prefix))), 'HANDOFF_OWNERSHIP', 'Ownership must stay inside the assigned country/run paths; shared paths require a change request');
    ensure(['names', 'parents', 'coverage'].every(k => ['unknown', 'verified', 'partial', 'unsupported'].includes(quality[k]))
      && Array.isArray(quality.limitations) && quality.limitations.every(text)
      && (['names', 'parents', 'coverage'].every(k => quality[k] === 'verified') || quality.limitations.length), 'HANDOFF_SCHEMA', 'Preserve unknown/partial/unsupported quality and its limitations');
    ensure(Array.isArray(value.revalidation.nextChecks) && value.revalidation.nextChecks.length && value.revalidation.nextChecks.every(text), 'HANDOFF_SCHEMA', 'List checks still required at integration');
    ensure(Array.isArray(source.hierarchyEvidence) && ['unresearched', 'researched'].includes(source.status), 'HANDOFF_SCHEMA', 'Source research state must be explicit');
    if (source.status === 'unresearched') {
      ensure(['publisher', 'directReference', 'asOf', 'license', 'sourceLock'].every(k => source[k] === null)
        && source.hierarchyEvidence.length === 0, 'HANDOFF_SCHEMA', 'Unresearched sources must not contain invented source facts');
    } else {
      ensure(['publisher', 'directReference', 'asOf', 'license'].every(k => text(source[k])) && source.sourceLock
        && source.hierarchyEvidence.length, 'HANDOFF_EVIDENCE', 'Researched source requires publisher/reference/date/license/source-lock/hierarchy evidence');
      checkPins(root, [source.sourceLock, ...source.hierarchyEvidence], 'source research');
      ensure([source.sourceLock, ...source.hierarchyEvidence].every(a => [...value.inputs, ...value.dependencies].some(p => equal(a, p))), 'HANDOFF_EVIDENCE', 'Source-lock and hierarchy evidence must be included in the consumed input/dependency inventory');
    }
    ensure(Array.isArray(value.verification) && value.verification.length, 'HANDOFF_EVIDENCE', 'Validation execution or explicit non-execution records are required');
    for (const record of value.verification) {
      ensure(record && text(record.check) && record.cwd === '.' && ['passed', 'failed', 'skipped', 'not-run'].includes(record.status), 'HANDOFF_EVIDENCE', 'Invalid validation record');
      checkPins(root, record.artifacts, 'validation evidence');
      if (record.status === 'passed') {
        ensure(text(record.command) && record.exitCode === 0 && record.artifacts.length && equal(record.dependencies, value.dependencies), 'HANDOFF_EVIDENCE', 'Passed validation requires command, exit 0, consumed pins and actual output evidence');
        codeCommit(root, record.codeCommit);
      } else {
        ensure(value.countryId === null && ['skipped', 'not-run'].includes(record.status) && text(record.reason) && record.exitCode === null && record.codeCommit === null
          && record.command === null && Array.isArray(record.dependencies) && !record.dependencies.length, 'HANDOFF_EVIDENCE', 'Failed/skipped/missing country validation cannot be accepted');
      }
    }
    if (value.countryId === null) {
      ensure(source.status === 'unresearched' && !value.inputs.length && !value.outputs.length && !ownership.ownedPaths.length
        && producer.command === null && producer.codeCommit === null, 'HANDOFF_COUNTRY', 'Unassigned preparation cannot start country research or produce country artifacts');
    } else {
      ensure(source.status === 'researched' && value.inputs.length && value.outputs.length && ownership.ownedPaths.length
        && text(producer.command), 'HANDOFF_EVIDENCE', 'Country preparation requires researched inputs, actual outputs and a producer command');
      codeCommit(root, producer.codeCommit);
      ensure(value.verification.every(r => r.status === 'passed'), 'HANDOFF_EVIDENCE', 'All submitted country checks must pass');
      ensure(value.outputs.every(a => ownership.ownedPaths.some(p => a.path === p || a.path.startsWith(`${p}/`))), 'HANDOFF_OWNERSHIP', 'Prepared output is outside the declared country-owned paths');
      if (value.stage === 'country-metadata-preparation') ensure(value.verification.some(r => r.check === 'country-metadata-input'), 'HANDOFF_EVIDENCE', 'Existing country metadata validator execution evidence is required');
    }
    return {ok: true, verdict: value.countryId === null ? 'accepted-unassigned' : value.stage === 'source-preparation'
      ? 'accepted-source-preparation' : 'accepted-country-metadata-preparation', head: current.head,
    semanticValidation: 'Envelope and byte evidence only; inspect/replay the shared country metadata validator for metadata semantics. No production admission or geometry validation.'};
  } catch (error) {
    return {ok: false, diagnostics: [{code: error.code || 'HANDOFF_SCHEMA', message: error.message}]};
  }
}
module.exports = {captureBaseline, validateCountryHandoff};
if (require.main === module) {
  try {
    const args = process.argv.slice(2), root = process.cwd();
    let result;
    const read = file => JSON.parse(fs.readFileSync(localFile(root, file), 'utf8').replace(/^\uFEFF/u, ''));
    if (args.length === 3 && args[0] === 'capture' && args[1] === '--dependencies') result = captureBaseline(root, read(args[2]));
    else if (args.length === 7 && args[0] === 'check' && args[1] === '--manifest' && args[3] === '--baseline' && args[5] === '--country') {
      result = validateCountryHandoff(read(args[2]), {root, baseline: read(args[4]), expectedCountryId: args[6] === 'null' ? null : args[6]});
      if (!result.ok) process.exitCode = 1;
    } else fail('HANDOFF_USAGE', 'Usage: capture --dependencies <relative-path-list.json> | check --manifest <relative.json> --baseline <relative.json> --country <CountryId|null>');
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ok: false, diagnostics: [{code: error.code || 'HANDOFF_SCHEMA', message: error.message}]}, null, 2) + '\n');
    process.exitCode = 1;
  }
}
