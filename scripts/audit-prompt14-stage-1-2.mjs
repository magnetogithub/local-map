import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";

import {
  CAPS, CANONICAL_P0_VALIDATOR_POLICY, DELIVERY_POLICY, UPSTREAM_RELEASE, VALIDATOR_POLICY,
  benchmarkDeterministicDelivery, calculateProductionCoverage, evaluateHardGate, exitCodeForHardGate, gate,
  readJson, resolveAdmin1Parents, runContainmentPolicyFixtures, sha256,
  summarizePackageVersions, validateCaps, validatePolygonFeatureCollection, validateSourceLockManifestSchema,
  validateCanonicalProvenance, validateSourceLock, assertReportStatusConsistent,
} from "./prompt14-source-gate.mjs";

const root = process.cwd();
const reportDirectory = path.join(root, "reports", "prompt14");
const reportPath = path.join(reportDirectory, "14-02-source-generation-delivery-decision.json");
const parentManifestPath = path.join(reportDirectory, "14-02-admin1-parent-resolution.json");
const baselinePath = path.join(reportDirectory, "14-01-baseline-runtime-data-audit.json");
const relative = (target) => path.relative(root, target).replaceAll("\\", "/");
const readBytes = (repositoryPath) => fs.readFileSync(path.join(root, repositoryPath));
const fileEvidence = (repositoryPath) => {
  const target = path.join(root, repositoryPath);
  if (!fs.existsSync(target)) return {repositoryPath, exists: false, sha256: null, byteLength: null};
  const bytes = fs.readFileSync(target);
  return {repositoryPath, exists: true, sha256: sha256(bytes), byteLength: bytes.length};
};
const gitBlobSha1 = (repositoryPath) => spawnSync("git", ["hash-object", repositoryPath], {cwd: root, encoding: "utf8"}).stdout.trim();

function safeReadJson(repositoryPath) {
  try { return {ok: true, value: readJson(root, repositoryPath), error: null}; }
  catch (error) { return {ok: false, value: null, error: error instanceof Error ? error.message : String(error)}; }
}

function runIsolatedNpmCi() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "prompt14-npm-ci-"));
  try {
    fs.copyFileSync(path.join(root, "package.json"), path.join(directory, "package.json"));
    fs.copyFileSync(path.join(root, "package-lock.json"), path.join(directory, "package-lock.json"));
    const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd ci --ignore-scripts"] : ["ci", "--ignore-scripts"];
    const result = spawnSync(executable, args, {cwd: directory, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
    return {command: `${process.platform === "win32" ? "npm.cmd" : "npm"} ci --ignore-scripts (isolated temporary directory)`, exitCode: result.status, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim(), ...(result.error ? {error: result.error.message} : {})};
  } finally {
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

function inspectGeometryTypes(collection) {
  const counts = {};
  for (const feature of collection?.features ?? []) {
    const type = feature?.geometry?.type ?? "null";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function broadRegion(region) {
  const value = String(region ?? "unknown");
  if (/Africa/.test(value)) return "Africa";
  if (/Asia/.test(value)) return "Asia";
  if (/Europe/.test(value)) return "Europe";
  if (/America|Caribbean/.test(value)) return "Americas";
  if (/Australia|Melanesia|Micronesia|Polynesia/.test(value)) return "Oceania";
  if (/Antarctic/.test(value)) return "Antarctica";
  return "Other";
}

function baselineDrift(baseline) {
  const changed = [];
  for (const entry of [...baseline.baseline.trackedModifiedOrDeleted, ...baseline.baseline.untracked]) {
    const target = path.join(root, entry.path);
    const currentHash = fs.existsSync(target) && fs.statSync(target).isFile() ? sha256(fs.readFileSync(target)) : null;
    if (currentHash !== entry.workingTreeSha256) changed.push({path: entry.path, baselineSha256: entry.workingTreeSha256, currentSha256: currentHash, prompt14Expected: entry.path === "package.json"});
  }
  const currentHead = spawnSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).stdout.trim();
  return {baselineReportSha256: sha256(fs.readFileSync(baselinePath)), currentHead, startHead: baseline.startHead, headUnchanged: baseline.startHead === currentHead, changedEntryCount: changed.length, changedEntries: changed};
}

fs.mkdirSync(reportDirectory, {recursive: true});
const startedAt = new Date().toISOString();
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const baselineAudit = baselineDrift(baseline);
const packageJson = readJson(root, "package.json");
const packageLock = readJson(root, "package-lock.json");
const installedPackages = Object.fromEntries(["geojson-vt", "@maplibre/vt-pbf", "@turf/boolean-valid", "polygon-clipping"].map((name) => [name, readJson(root, `node_modules/${name}/package.json`)]));
const packageVersions = summarizePackageVersions(packageJson, packageLock, installedPackages);
const npmCiResult = runIsolatedNpmCi();
const testResult = spawnSync(process.execPath, ["--test", "scripts/prompt14-source-gate.test.mjs"], {cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024});
const assetPaths = {
  rawAdmin0: "data/raw/ne_10m_admin_0_countries.geojson",
  rawAdmin1: "data/raw/ne_10m_admin_1_states_provinces.geojson",
  canonicalP0: "public/data/maps/countries-10m.geojson",
  metadata: "src/data/countries-2020.json",
  attribution: "data/ATTRIBUTION.md",
  sourceLockManifest: "data/source-locks/prompt14-production-polygon-sources.json",
};
const assetEvidence = Object.fromEntries(Object.entries(assetPaths).map(([name, repositoryPath]) => [name, fileEvidence(repositoryPath)]));
const rawAdmin0Read = safeReadJson(assetPaths.rawAdmin0);
const rawAdmin1Read = safeReadJson(assetPaths.rawAdmin1);
const canonicalP0Read = safeReadJson(assetPaths.canonicalP0);
const metadataRead = safeReadJson(assetPaths.metadata);
const sourceLockManifestRead = safeReadJson(assetPaths.sourceLockManifest);
const rawAdmin0Validation = rawAdmin0Read.ok ? validatePolygonFeatureCollection(rawAdmin0Read.value, "rawAdmin0") : {pass: false, counts: {}, errors: [rawAdmin0Read.error]};
const rawAdmin1Validation = rawAdmin1Read.ok ? validatePolygonFeatureCollection(rawAdmin1Read.value, "rawAdmin1") : {pass: false, counts: {}, errors: [rawAdmin1Read.error]};
const canonicalP0Validation = canonicalP0Read.ok ? validatePolygonFeatureCollection(canonicalP0Read.value, "canonicalP0", CANONICAL_P0_VALIDATOR_POLICY) : {pass: false, counts: {}, errors: [canonicalP0Read.error]};
const geometryValidations = {rawAdmin0: rawAdmin0Validation, rawAdmin1: rawAdmin1Validation, canonicalP0: canonicalP0Validation};

const canonicalIds = canonicalP0Read.ok ? [...new Set(canonicalP0Read.value.features.map((feature) => feature.properties?.countryId).filter((value) => typeof value === "string"))].sort() : [];
const metadata = metadataRead.ok ? metadataRead.value : [];
const parentResolution = rawAdmin1Read.ok ? resolveAdmin1Parents(rawAdmin1Read.value, canonicalIds, metadata) : {entries: [], rawParentIds: [], normalizedParentIds: [], unresolved: [{error: rawAdmin1Read.error}], duplicates: [], excludedCount: 0, allResolved: false};
const parentManifest = {
  schemaVersion: "prompt14-admin1-parent-resolution-v1", source: assetEvidence.rawAdmin1,
  normalization: {fields: ["adm0_a3", "sov_a3", "gu_a3", "iso_3166_2 prefix", "iso_a2"], fixedOverridePolicy: "scripts/prompt14-source-gate.mjs#ID_OVERRIDES", exclusionPolicy: "scripts/prompt14-source-gate.mjs#REMOVED_MAP_UNIT_IDS"},
  summary: {featureCount: parentResolution.entries.length, resolvedCount: parentResolution.entries.filter((entry) => entry.normalizedParentCountryId).length, excludedCount: parentResolution.excludedCount, unresolvedCount: parentResolution.unresolved.length, duplicateSourceFeatureIdCount: parentResolution.duplicates.length},
  entries: parentResolution.entries, unresolved: parentResolution.unresolved, duplicates: parentResolution.duplicates,
};
fs.writeFileSync(parentManifestPath, `${JSON.stringify(parentManifest, null, 2)}\n`);
const parentManifestEvidence = fileEvidence(relative(parentManifestPath));
const productionCountryIds = metadata.map((country) => country.id);
const coverage = canonicalP0Read.ok ? calculateProductionCoverage(canonicalP0Read.value, parentResolution, [rawAdmin1Validation, canonicalP0Validation], productionCountryIds) : {canonicalProductionCountryIds: productionCountryIds, countries: [], admin1Countries: [], p0FallbackCountries: [], missingCountries: [{error: canonicalP0Read.error}], zeroAtomCountries: [], sourceOutsideCanonical: [], duplicateProductionCountryIds: [], invalidProductionCountryIds: [], duplicateP0CountryIds: [], unknownP0CountryIds: [], totalAtoms: 0, fullCoverage: false};
const capValidation = validateCaps(coverage, rawAdmin1Validation.counts?.vertices ?? Number.POSITIVE_INFINITY, CAPS);
const containmentFixtures = runContainmentPolicyFixtures();
const delivery = rawAdmin1Read.ok && packageVersions.pass ? benchmarkDeterministicDelivery(rawAdmin1Read.value, 3) : {pass: false, error: rawAdmin1Read.error ?? "delivery dependency/version mismatch"};
const rawAdmin0Blob = assetEvidence.rawAdmin0.exists ? gitBlobSha1(assetPaths.rawAdmin0) : null;
const rawAdmin1Blob = assetEvidence.rawAdmin1.exists ? gitBlobSha1(assetPaths.rawAdmin1) : null;
const exactUpstream = rawAdmin0Blob === UPSTREAM_RELEASE.admin0Blob && rawAdmin1Blob === UPSTREAM_RELEASE.admin1Blob && assetEvidence.rawAdmin0.sha256 === UPSTREAM_RELEASE.admin0Sha256 && assetEvidence.rawAdmin1.sha256 === UPSTREAM_RELEASE.admin1Sha256;
const sourceLockManifest = sourceLockManifestRead.ok ? sourceLockManifestRead.value : {schemaVersion: null, canonicalProvenance: null, sources: []};
const sourceLockManifestSchema = validateSourceLockManifestSchema(sourceLockManifest);
const sourceLocks = Array.isArray(sourceLockManifest.sources) ? sourceLockManifest.sources : [];
const actualSourceFacts = {
  "canonical-country-p0-2020": {geometryTypes: Object.keys(inspectGeometryTypes(canonicalP0Read.value)), coveredCountryIds: canonicalIds},
  "natural-earth-admin1-states-provinces-10m": {geometryTypes: Object.keys(inspectGeometryTypes(rawAdmin1Read.value)), coveredCountryIds: parentResolution.normalizedParentIds},
};
const sourceLockValidation = sourceLocks.map((lock) => ({sourceId: lock.sourceId, result: validateSourceLock(lock, root, actualSourceFacts[lock.sourceId] ?? {geometryTypes: [], coveredCountryIds: []})}));
const expectedSourceIds = ["canonical-country-p0-2020", "natural-earth-admin1-states-provinces-10m"];
const sourceLockSetComplete = sourceLockManifestRead.ok
  && sourceLockManifestSchema.pass
  && JSON.stringify(sourceLocks.map((lock) => lock.sourceId).sort()) === JSON.stringify(expectedSourceIds.sort())
  && sourceLockValidation.every((entry) => entry.result.pass);
const provenanceValidation = validateCanonicalProvenance(sourceLockManifest.canonicalProvenance, sourceLocks, root);
const attributionText = assetEvidence.attribution.exists ? readBytes(assetPaths.attribution).toString("utf8") : "";
const groupedRegions = Object.groupBy(metadata, (country) => broadRegion(country.region));
const regions = Object.fromEntries(Object.entries(groupedRegions).map(([region, countries]) => [region, countries.length]));
const requiredGeometryTypesOnly = [rawAdmin0Read.value, rawAdmin1Read.value, canonicalP0Read.value].every((collection) => collection && Object.keys(inspectGeometryTypes(collection)).every((type) => type === "Polygon" || type === "MultiPolygon"));

const gates = {
  requiredPolygonAssetsPresent: gate([assetEvidence.rawAdmin0, assetEvidence.rawAdmin1, assetEvidence.canonicalP0].every((asset) => asset.exists), assetEvidence, "one or more required polygon assets are missing"),
  polygonGeometryTypesOnly: gate(requiredGeometryTypesOnly, {rawAdmin0: inspectGeometryTypes(rawAdmin0Read.value), rawAdmin1: inspectGeometryTypes(rawAdmin1Read.value), canonicalP0: inspectGeometryTypes(canonicalP0Read.value)}, "a source contains a non-polygon geometry"),
  polygonGeometryValid: gate(Object.values(geometryValidations).every((validation) => validation.pass), {policies: {rawSources: VALIDATOR_POLICY, canonicalP0: CANONICAL_P0_VALIDATOR_POLICY}, sources: Object.fromEntries(Object.entries(geometryValidations).map(([name, validation]) => [name, {pass: validation.pass, counts: validation.counts, errorCount: validation.errors.length, errorSamples: validation.errors.slice(0, 20)}]))}, "one or more polygon sources fail strict structural or OGC validity"),
  multiContinentCoveragePresent: gate(["Africa", "Asia", "Europe", "Americas", "Oceania"].every((region) => (regions[region] ?? 0) > 0 && coverage.countries.some((country) => broadRegion(metadata.find((entry) => entry.id === country.countryId)?.region) === region)), {regions}, "canonical production coverage does not span all required inhabited continents"),
  fullProductionCoveragePresent: gate(coverage.fullCoverage, {countryCount: coverage.countries.length, admin1CountryCount: coverage.admin1Countries.length, p0FallbackCountryCount: coverage.p0FallbackCountries.length, missingCountries: coverage.missingCountries, zeroAtomCountries: coverage.zeroAtomCountries, duplicateProductionCountryIds: coverage.duplicateProductionCountryIds, invalidProductionCountryIds: coverage.invalidProductionCountryIds, duplicateP0CountryIds: coverage.duplicateP0CountryIds, unknownP0CountryIds: coverage.unknownP0CountryIds, totalAtoms: coverage.totalAtoms}, "one or more production countries have neither selected valid Admin-1 polygons nor a P0 fallback, or parent resolution/geometry validity failed"),
  hashesByteLengthsAndRepositoryPathsRecorded: gate([assetEvidence.rawAdmin0, assetEvidence.rawAdmin1, assetEvidence.canonicalP0, assetEvidence.attribution].every((asset) => asset.repositoryPath && asset.exists && asset.sha256 && Number.isSafeInteger(asset.byteLength)), assetEvidence, "asset identity evidence is incomplete"),
  licenseAndAttributionRecorded: gate(/Natural Earth/.test(attributionText) && /public domain/i.test(attributionText), {path: assetPaths.attribution, sha256: assetEvidence.attribution.sha256}, "Natural Earth license/attribution evidence is missing"),
  fixedReleaseAndAcquisitionIdentifierRecorded: gate(Boolean(UPSTREAM_RELEASE.release && UPSTREAM_RELEASE.commit && UPSTREAM_RELEASE.repository), UPSTREAM_RELEASE, "fixed upstream release evidence is missing"),
  exactUpstreamGitBlobMatch: gate(exactUpstream, {admin0: {expectedBlob: UPSTREAM_RELEASE.admin0Blob, actualBlob: rawAdmin0Blob, expectedSha256: UPSTREAM_RELEASE.admin0Sha256, actualSha256: assetEvidence.rawAdmin0.sha256}, admin1: {expectedBlob: UPSTREAM_RELEASE.admin1Blob, actualBlob: rawAdmin1Blob, expectedSha256: UPSTREAM_RELEASE.admin1Sha256, actualSha256: assetEvidence.rawAdmin1.sha256}}, "checked-in raw source bytes do not exactly match the pinned upstream release"),
  allAdmin1ParentsResolved: gate(parentResolution.allResolved, {manifest: parentManifestEvidence, resolvedCount: parentManifest.summary.resolvedCount, excludedCount: parentResolution.excludedCount, unresolved: parentResolution.unresolved, duplicateSourceFeatureIds: parentResolution.duplicates}, "an unexcluded Admin-1 feature has no canonical parent or a duplicate source feature ID"),
  containmentAndCoveragePolicyValidated: gate(containmentFixtures.pass, {policy: VALIDATOR_POLICY, fixtures: containmentFixtures}, "gap, overlap, or cross-border fixture did not fail as required"),
  deliveryTechnologySelectedAndMeasured: gate(packageVersions.pass && delivery.pass, {policy: DELIVERY_POLICY, directDependencies: packageVersions, measurement: delivery}, "delivery dependencies are not exact direct devDependencies or independent generation was not byte-identical"),
  scopeAndCapsWithinLimits: gate(capValidation.pass, capValidation, "selected scope exceeds a hard cap"),
  canonical2020ProvenanceEstablished: gate(provenanceValidation.pass, {manifest: assetEvidence.sourceLockManifest, validation: provenanceValidation}, provenanceValidation.error ?? "canonical P0 legal-2020 provenance is not established"),
  sourceLockManifestSchemaValid: gate(sourceLockManifestRead.ok && sourceLockManifestSchema.pass, {manifest: assetEvidence.sourceLockManifest, validation: sourceLockManifestSchema}, sourceLockManifestRead.ok ? "source-lock manifest schema/version/order is invalid" : sourceLockManifestRead.error),
  sourceLocksComplete: gate(sourceLockSetComplete, {manifest: assetEvidence.sourceLockManifest, manifestSchema: sourceLockManifestSchema, expectedSourceIds, validation: sourceLockValidation}, sourceLockManifestRead.ok ? "at least one production polygon source lock has an invalid schema, floating identity, mismatched bytes, geometry types, or coverage" : sourceLockManifestRead.error),
  npmCiReproducible: gate(npmCiResult.exitCode === 0, npmCiResult, "isolated npm ci did not reproduce the pinned dependency tree"),
  automatedRegressionSuitePasses: gate(testResult.status === 0, {command: "node --test scripts/prompt14-source-gate.test.mjs", exitCode: testResult.status, stdout: testResult.stdout.trim(), stderr: testResult.stderr.trim()}, "Prompt 14 source-gate regression suite failed"),
};
const hardGateSummary = evaluateHardGate(gates);
const status = hardGateSummary.pass ? "pass" : "blocked";
assertReportStatusConsistent(status, hardGateSummary);
const unresolvedIssues = Object.entries(gates).filter(([, result]) => !result.pass).map(([name, result]) => ({gate: name, error: result.error}));
const resumeConditions = unresolvedIssues.map((issue) => ({gate: issue.gate, condition: ({
  polygonGeometryValid: "Provide valid, release-locked polygon sources or approve an explicit repair policy; do not auto-repair during validation.",
  fullProductionCoveragePresent: "Make every metadata-defined production country resolve to exactly one valid Admin-1 selection or an existing canonical P0 fallback with a non-zero atom count.",
  canonical2020ProvenanceEstablished: "Provide the actual externally authoritative 2020-01-01 boundary GeoJSON, complete its legal-2020 source lock, and add its authority identity, acquisition URL, release/version, and exact digest to the reviewed trusted-authority policy; a local verified declaration or self-authored document is insufficient.",
  sourceLocksComplete: "Complete every required source-lock field with values backed by the checked-in source bytes.",
  npmCiReproducible: "Fix package manifests/lock or installation constraints until isolated npm ci exits 0.",
  automatedRegressionSuitePasses: "Fix the Prompt 14 source-gate regression suite until node --test exits 0.",
}[issue.gate] ?? `Resolve ${issue.gate} and rerun the computed audit.`)}));
const report = {
  stage: "14-2", status, startedAt, completedAt: new Date().toISOString(), startHead: baseline.startHead,
  baselineReference: {path: relative(baselinePath), preserved: true, ...baselineAudit},
  performedStages: ["Preserved and drift-checked the existing 14-1 baseline.", "Validated every Admin-0, Admin-1, and canonical P0 polygon with explicit structural, winding, range, and OGC checks.", "Executed the repository parent normalization and exclusion policy for every Admin-1 feature.", "Computed full production coverage, zero-atom, and cap gates.", "Executed success/gap/overlap/cross-border containment-policy fixtures.", "Performed two independent vector-tile generations and compared every tile hash and byte length.", "Blocked on unproven canonical 2020 P0 provenance and incomplete P0 source lock."],
  commands: [
    npmCiResult,
    {command: "node --test scripts/prompt14-source-gate.test.mjs", exitCode: testResult.status, stdout: testResult.stdout.trim(), stderr: testResult.stderr.trim()},
    {command: "node scripts/audit-prompt14-stage-1-2.mjs", exitCode: exitCodeForHardGate(hardGateSummary)},
  ],
  sourceLockManifest: {path: assetPaths.sourceLockManifest, identity: assetEvidence.sourceLockManifest, schemaVersion: sourceLockManifest.schemaVersion}, sourceLocks, sourceLockValidation,
  hardGate: {...gates, pass: hardGateSummary.pass, firstBlockingCondition: hardGateSummary.firstBlockingCondition},
  geometryValidation: {policies: {rawSources: VALIDATOR_POLICY, canonicalP0: CANONICAL_P0_VALIDATOR_POLICY}, sources: geometryValidations},
  productionCoverage: {...coverage, rawAdmin1ParentIds: parentResolution.rawParentIds, normalizedAdmin1ParentIds: parentResolution.normalizedParentIds, parentResolutionManifest: parentManifestEvidence},
  parentResolution: {summary: parentManifest.summary, unresolved: parentResolution.unresolved, duplicates: parentResolution.duplicates, manifest: parentManifestEvidence},
  scopeAndCaps: capValidation,
  selectionPolicy: {p0: "Canonical production country polygon for countries without selected Admin-1; no generated filler.", p1: "Every valid, non-excluded, release-locked Admin-1 polygon with a resolved canonical parent.", excluded: parentResolution.entries.filter((entry) => entry.excluded), boundaryLock: "Generation must clip to P0 and reject gaps, overlap, cross-border area, cap overflow, or boundary crossing."},
  containmentPolicy: {status: containmentFixtures.pass ? "fixture-validated; full-world generation equality remains a mandatory 14-6/14-7 gate" : "invalid", policy: VALIDATOR_POLICY, fixtures: containmentFixtures},
  deliveryDecision: {status: packageVersions.pass && delivery.pass ? "selected-and-measured" : "blocked", selectedOption: DELIVERY_POLICY.option, policy: DELIVERY_POLICY, directDependencies: packageVersions, installWindowsAndCi: "npm ci", auditCommand: "node scripts/audit-prompt14-stage-1-2.mjs", plannedInput: "14-7 canonical territory and edge FeatureCollections", plannedOutput: "public/data/territory-catalog/<catalogVersion>/tiles/{z}/{x}/{y}.pbf and content manifest", performedVerification: delivery, futureVerification: "14-7 must generate the complete selected zoom range twice and compare every output byte/hash; this 14-2 measurement covers zooms 0-3 only.", failurePolicy: "Any dependency, deterministic encoding, Windows/CI, or complete-output verification failure blocks generation; no silent GeoJSON fallback."},
  unresolvedIssues, resumeConditions,
  filesChanged: ["package.json", "package-lock.json", assetPaths.sourceLockManifest, "scripts/audit-prompt14-stage-1-2.mjs", "scripts/prompt14-source-gate.mjs", "scripts/prompt14-source-gate.test.mjs", relative(parentManifestPath), relative(reportPath)],
  nextStage: hardGateSummary.pass ? "REVIEW A" : "Resolve every resume condition and rerun 14-2. Do not request REVIEW A or begin 14-3.",
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({stage: report.stage, status: report.status, hardGatePass: report.hardGate.pass, firstBlockingCondition: report.hardGate.firstBlockingCondition, failedGates: unresolvedIssues.map((issue) => issue.gate), testExitCode: testResult.status, report: relative(reportPath)}));
process.exitCode = exitCodeForHardGate(hardGateSummary);
