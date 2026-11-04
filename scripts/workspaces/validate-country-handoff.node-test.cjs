const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync, spawnSync} = require('node:child_process');
const ts = require('typescript');
const {captureBaseline, validateCountryHandoff} = require('./validate-country-handoff.cjs');
const repository = path.resolve(__dirname, '../..');
const fixtureParent = path.join(repository, '.tmp/prompt21/handoff-unit');
fs.mkdirSync(fixtureParent, {recursive: true});
const roots = [];
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {encoding: 'utf8', windowsHide: true}).trim();
const commit = root => {git(root, 'add', '.'); git(root, '-c', 'core.hooksPath=NUL', 'commit', '-qm', 'Synthetic handoff fixture'); return git(root, 'rev-parse', 'HEAD');};
function write(root, file, value) {
  fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
  fs.writeFileSync(path.join(root, file), typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
function pin(root, file) {
  const bytes = fs.readFileSync(path.join(root, file));
  return {path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length};
}
// Copy real common modules only as fixture infrastructure; artifact/catalog data below are tiny and fictional.
function copyModule(root, file, copied = new Set()) {
  if (copied.has(file)) return;
  copied.add(file);
  const absolute = path.join(repository, file), bytes = fs.readFileSync(absolute);
  write(root, file, bytes);
  for (const imported of ts.preProcessFile(bytes.toString('utf8'), true, true).importedFiles) {
    if (!imported.fileName.startsWith('.')) continue;
    const resolved = ts.resolveModuleName(imported.fileName, absolute, {moduleResolution: ts.ModuleResolutionKind.Node10, resolveJsonModule: true}, ts.sys).resolvedModule;
    assert.ok(resolved, `${file}:${imported.fileName}`);
    copyModule(root, path.relative(repository, resolved.resolvedFileName).split(path.sep).join('/'), copied);
  }
}
function fixture() {
  const root = fs.mkdtempSync(path.join(fixtureParent, 'case-')); roots.push(root);
  copyModule(root, 'src/lib/geography/country-metadata-input.ts');
  copyModule(root, 'src/lib/geography/state-province-io.ts');
  for (const file of ['package.json', 'package-lock.json', 'scripts/workspaces/validate-country-handoff.cjs',
    'docs/geography/country-metadata-handoff-v1.md', 'docs/development/workspace-ownership-v1.md',
    'docs/development/workspace-layout-v1.md', 'docs/development/country-workspace-handoff-v1.md']) {
    write(root, file, fs.readFileSync(path.join(repository, file)));
  }
  write(root, '.gitattributes', '* -text\n');
  write(root, 'fixture/shared-rule.txt', 'A compatible synthetic input rule.\n');
  const catalogRef = {catalogVersion: 'synthetic-handoff-v1', geometryRoot: '1'.repeat(64), topologyRoot: '2'.repeat(64),
    renderArtifactRoot: '3'.repeat(64), manifestPath: '/data/territory-catalog/synthetic-handoff-v1/manifest.json'};
  const metadataRef = {schemaVersion: 'geography-metadata-ref-v1', contentRoot: '4'.repeat(64)};
  const catalogRoot = 'data/catalogs/synthetic-handoff-v1';
  write(root, `${catalogRoot}/catalog.json`, {catalogRef, countryOrder: ['AAA', 'BBB']});
  const {manifestPath: ignored, ...ref} = catalogRef; void ignored;
  write(root, `${catalogRoot}/manifest.json`, {ref: {...ref, catalogOrderRoot: '5'.repeat(64)}});
  write(root, `${catalogRoot}/artifact-index.json`, {schemaVersion: 'operational-world-delivery-v2', artifacts:
    ['catalog.json', 'manifest.json'].map(file => ({...pin(root, `${catalogRoot}/${file}`), path: file}))});
  const index = pin(root, `${catalogRoot}/artifact-index.json`);
  write(root, 'data/runtime/operational-catalog/current.json', {catalogVersion: catalogRef.catalogVersion, root: catalogRoot,
    index: {sha256: index.sha256, byteLength: index.byteLength}});
  write(root, 'data/geography/metadata.json', {fictional: 'not a semantic metadata fixture'});
  write(root, 'data/geography/admission.json', {fictional: 'independent artifact placeholder'});
  write(root, 'data/geography/manifest.json', {schemaVersion: 'state-province-manifest-v1', purpose: 'production', catalogRef, metadataRef,
    metadata: pin(root, 'data/geography/metadata.json'), admission: pin(root, 'data/geography/admission.json')});
  write(root, 'data/runtime/geography/current.json', {schemaVersion: 'geography-registry-v1', catalogRef, metadataRef,
    manifest: pin(root, 'data/geography/manifest.json')});
  for (const file of ['source-lock.json', 'hierarchy.json', 'input.json', 'prepared.json', 'check.json']) write(root, `data/derived/country-prep/AAA/synthetic/${file}`, {fictional: file});
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Synthetic Fixture'); git(root, 'config', 'user.email', 'fixture@invalid');
  const head = commit(root), baseline = captureBaseline(root, ['fixture/shared-rule.txt']);
  const manifest = {schemaVersion: 'country-workspace-handoff-v1', countryId: 'AAA', stage: 'source-preparation', baseCommit: head,
    contracts: baseline.contracts, catalogRef, metadataRef, dependencies: baseline.dependencies,
    inputs: ['input.json', 'source-lock.json', 'hierarchy.json'].map(file => pin(root, `data/derived/country-prep/AAA/synthetic/${file}`)), outputs: [pin(root, 'data/derived/country-prep/AAA/synthetic/prepared.json')],
    producer: {command: 'synthetic-prepare --country AAA', codeCommit: head},
    source: {status: 'researched', publisher: 'Fictional publisher', directReference: 'https://example.invalid/AAA',
      asOf: '2000-01-01', license: 'Synthetic fixture only', sourceLock: pin(root, 'data/derived/country-prep/AAA/synthetic/source-lock.json'),
      hierarchyEvidence: [pin(root, 'data/derived/country-prep/AAA/synthetic/hierarchy.json')]},
    ownership: {ownedPaths: ['data/derived/country-prep/AAA/synthetic'], sharedChanges: [], nonTargetImpact: 'Synthetic AAA only.'},
    quality: {names: 'partial', parents: 'unknown', coverage: 'unsupported', limitations: ['No geography facts or generated IDs.']},
    verification: [{check: 'source-preparation', command: 'synthetic-check AAA', cwd: '.', codeCommit: head, status: 'passed',
      exitCode: 0, dependencies: baseline.dependencies, artifacts: [pin(root, 'data/derived/country-prep/AAA/synthetic/check.json')], reason: null}],
    revalidation: {nextChecks: ['Independently inspect raw source facts before any integration.']}, impactReview: null};
  return {root, baseline, manifest};
}
function check(f, expectedCountryId = f.manifest.countryId, baseline = f.baseline) {
  return validateCountryHandoff(f.manifest, {root: f.root, baseline, expectedCountryId});
}
after(() => {
  for (const root of roots) {
    const absolute = fs.realpathSync(root), parent = fs.realpathSync(fixtureParent);
    assert.ok(absolute.startsWith(parent + path.sep) && path.basename(absolute).startsWith('case-'));
    fs.rmSync(absolute, {recursive: true, force: true});
  }
});
test('accepts an evidence-backed source envelope without claiming production semantics', () => {
  const result = check(fixture());
  assert.equal(result.verdict, 'accepted-source-preparation');
  assert.match(result.semanticValidation, /No production admission/);
});
test('accepts explicit unassigned non-execution and rejects unassigned country artifacts', () => {
  const f = fixture();
  Object.assign(f.manifest, {countryId: null, stage: 'unassigned', inputs: [], outputs: [], producer: {command: null, codeCommit: null},
    source: {status: 'unresearched', publisher: null, directReference: null, asOf: null, license: null, sourceLock: null, hierarchyEvidence: []}});
  f.manifest.ownership.ownedPaths = [];
  f.manifest.verification = [{check: 'country-research', cwd: '.', status: 'not-run', exitCode: null, codeCommit: null, command: null,
    dependencies: [], artifacts: [], reason: 'No country has been assigned.'}];
  assert.equal(check(f, null).verdict, 'accepted-unassigned');
  f.manifest.inputs.push(pin(f.root, 'data/derived/country-prep/AAA/synthetic/input.json'));
  assert.equal(check(f, null).ok, false);
});
test('rejects stale full references and schema versions', () => {
  const f = fixture();
  for (const field of ['geometryRoot', 'topologyRoot', 'renderArtifactRoot', 'manifestPath', 'catalogVersion']) {
    const original = f.manifest.catalogRef;
    f.manifest.catalogRef = {...original, [field]: field === 'manifestPath' ? '/data/other/synthetic-handoff-v1/manifest.json'
      : field === 'catalogVersion' ? 'other-v1' : 'a'.repeat(64)};
    assert.equal(check(f).ok, false, field); f.manifest.catalogRef = original;
  }
  f.manifest.metadataRef = {...f.manifest.metadataRef, contentRoot: 'b'.repeat(64)};
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_STALE_REF');
  f.manifest.metadataRef = f.baseline.metadataRef;
  f.manifest.contracts = {...f.manifest.contracts, geography: 'future-v9'};
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_SCHEMA');
});
test('rejects changed or omitted consumed dependencies against a fresh integration capture', () => {
  const f = fixture();
  write(f.root, 'fixture/shared-rule.txt', 'Compatible rule changed after preparation.\n'); commit(f.root);
  const latest = captureBaseline(f.root, ['fixture/shared-rule.txt']);
  assert.equal(check(f, 'AAA', latest).diagnostics[0].code, 'HANDOFF_REVALIDATION');
  f.manifest.dependencies = latest.dependencies.slice(1);
  assert.equal(check(f, 'AAA', latest).diagnostics[0].code, 'HANDOFF_REVALIDATION');
});
test('rejects dirty common code but permits unrelated working-tree edits', () => {
  const f = fixture();
  write(f.root, 'unrelated-note.txt', 'In-progress unrelated document.');
  assert.equal(check(f).ok, true);
  fs.appendFileSync(path.join(f.root, 'src/lib/geography/country-metadata-input.ts'), '\n// changed validator\n');
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_DIRTY_DEPENDENCY');
});
test('rejects another assigned country even when its envelope is internally consistent', () => {
  assert.equal(check(fixture(), 'BBB').diagnostics[0].code, 'HANDOFF_COUNTRY');
});
test('rejects missing, changed, failed and skipped validation evidence', () => {
  const f = fixture(), record = f.manifest.verification[0];
  for (const status of ['failed', 'skipped', 'not-run']) {
    record.status = status;
    assert.equal(check(f).ok, false, status);
  }
  record.status = 'passed';
  const artifacts = record.artifacts; record.artifacts = [];
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_EVIDENCE'); record.artifacts = artifacts;
  write(f.root, artifacts[0].path, {changed: true});
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_PIN');
  fs.unlinkSync(path.join(f.root, artifacts[0].path));
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_MISSING_ARTIFACT');
});
test('rejects missing input/output files and path traversal', () => {
  const f = fixture(), original = f.manifest.outputs[0];
  f.manifest.outputs[0] = {...original, path: '../outside.json'};
  assert.equal(check(f).ok, false);
  f.manifest.outputs[0] = original;
  fs.unlinkSync(path.join(f.root, original.path));
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_MISSING_ARTIFACT');
  f.manifest.outputs = [];
  fs.unlinkSync(path.join(f.root, f.manifest.inputs[0].path));
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_MISSING_ARTIFACT');
});
test('requires the existing country metadata helper evidence for the metadata stage', () => {
  const f = fixture(); f.manifest.stage = 'country-metadata-preparation';
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_EVIDENCE');
  f.manifest.verification[0].check = 'country-metadata-input';
  assert.equal(check(f).verdict, 'accepted-country-metadata-preparation');
});
test('rejects active-pointer or another-country ownership and undeclared source evidence', () => {
  const f = fixture(), owned = f.manifest.ownership.ownedPaths;
  for (const invalid of ['data/runtime/geography/current.json', 'data/derived/country-prep/BBB/synthetic']) {
    f.manifest.ownership.ownedPaths = [invalid];
    assert.equal(check(f).diagnostics[0].code, 'HANDOFF_OWNERSHIP');
  }
  f.manifest.ownership.ownedPaths = owned;
  f.manifest.inputs = f.manifest.inputs.filter(a => !a.path.endsWith('source-lock.json'));
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_EVIDENCE');
});
test('reuses unchanged dependency evidence after a reviewed unrelated document commit', () => {
  const f = fixture();
  write(f.root, 'unrelated-note.txt', 'A document outside consumed contracts.'); const head = commit(f.root);
  assert.equal(check(f).diagnostics[0].code, 'HANDOFF_STALE_BASELINE');
  const latest = captureBaseline(f.root, ['fixture/shared-rule.txt']);
  assert.equal(check(f, 'AAA', latest).diagnostics[0].code, 'HANDOFF_IMPACT_REVIEW');
  f.manifest.impactReview = {reviewedCommit: head, reason: 'Only unrelated-note.txt changed; consumed dependencies are identical.', evidence: pin(f.root, 'unrelated-note.txt')};
  assert.equal(check(f, 'AAA', latest).ok, true);
});
test('CLI supports BOM JSON and exits with failure on a rejected manifest', () => {
  const f = fixture(), cli = path.join(repository, 'scripts/workspaces/validate-country-handoff.cjs');
  write(f.root, 'dependency-list.json', '\uFEFF' + JSON.stringify(['fixture/shared-rule.txt']));
  const captured = spawnSync(process.execPath, [cli, 'capture', '--dependencies', 'dependency-list.json'], {cwd: f.root, encoding: 'utf8', windowsHide: true});
  assert.equal(captured.status, 0, captured.stderr + captured.stdout);
  write(f.root, 'baseline.json', captured.stdout); write(f.root, 'handoff.json', f.manifest);
  const rejected = spawnSync(process.execPath, [cli, 'check', '--manifest', 'handoff.json', '--baseline', 'baseline.json', '--country', 'BBB'], {cwd: f.root, encoding: 'utf8', windowsHide: true});
  assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stdout).diagnostics[0].code, 'HANDOFF_COUNTRY');
});
