import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  benchmarkDeterministicDelivery,
  calculateProductionCoverage,
  evaluateHardGate,
  exitCodeForHardGate,
  resolveAdmin1Parents,
  runContainmentPolicyFixtures,
  sha256,
  summarizePackageVersions,
  validateCaps,
  validateBoundarySourceLockSchema,
  validateCanonicalProvenance,
  validatePolygonFeatureCollection,
  validateSourceLock,
  validateSourceLockManifestSchema,
  assertReportStatusConsistent,
} from "./prompt14-source-gate.mjs";

const clockwiseSquare = [[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]];
const polygonFeature = (id = "AAA", coordinates = clockwiseSquare) => ({type: "Feature", properties: {countryId: id}, geometry: {type: "Polygon", coordinates: [coordinates]}});
const collection = (features) => ({type: "FeatureCollection", features});

test("missing source file produces a failed lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt14-missing-"));
  try {
    const result = validateSourceLock({sourceId: "x", release: "1", sourceVersion: "1", license: "MIT", attribution: "x", acquiredFrom: "https://authority.example/releases/1/source.geojson", repositoryPath: "missing.geojson", sha256: "0".repeat(64), byteLength: 1, geometryTypes: ["Polygon"], coveredCountryIds: ["AAA"], boundaryKind: "administrative-operational", operationalOnly: true}, root);
    assert.equal(result.pass, false);
    assert.equal(result.fileExists, false);
    assert.equal(exitCodeForHardGate(evaluateHardGate({requiredSource: result})), 2);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("source SHA-256 mismatch produces a failed lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt14-sha-"));
  try {
    fs.writeFileSync(path.join(root, "source.geojson"), "{}");
    const result = validateSourceLock({sourceId: "x", release: "1", sourceVersion: "1", license: "MIT", attribution: "x", acquiredFrom: "https://authority.example/releases/1/source.geojson", repositoryPath: "source.geojson", sha256: "0".repeat(64), byteLength: 2, geometryTypes: ["Polygon"], coveredCountryIds: ["AAA"], boundaryKind: "administrative-operational", operationalOnly: true}, root);
    assert.equal(result.pass, false);
    assert.equal(result.bytesMatch, false);
    assert.equal(exitCodeForHardGate(evaluateHardGate({sourceHash: result})), 2);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("wrong geometry type and open ring are rejected", () => {
  const wrong = validatePolygonFeatureCollection(collection([{type: "Feature", properties: {}, geometry: {type: "LineString", coordinates: [[0, 0], [1, 1]]}}]));
  const open = validatePolygonFeatureCollection(collection([polygonFeature("AAA", [[0, 0], [0, 1], [1, 1], [1, 0]])]));
  assert.equal(wrong.pass, false);
  assert.equal(open.pass, false);
});

test("self-intersecting polygon is rejected", () => {
  const bowTie = [[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]];
  const result = validatePolygonFeatureCollection(collection([polygonFeature("AAA", bowTie)]));
  assert.equal(result.pass, false);
  assert.match(result.errors.join("\n"), /degenerate|boolean-valid|OGC/);
});

test("a hole outside its exterior and overlapping MultiPolygon components are rejected", () => {
  const outsideHole = collection([{type: "Feature", properties: {}, geometry: {type: "Polygon", coordinates: [
    [[0, 0], [0, 4], [4, 4], [4, 0], [0, 0]],
    [[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]],
  ]}}]);
  const overlappingComponents = collection([{type: "Feature", properties: {}, geometry: {type: "MultiPolygon", coordinates: [
    [[ [0, 0], [0, 2], [2, 2], [2, 0], [0, 0] ]],
    [[ [1, 1], [1, 3], [3, 3], [3, 1], [1, 1] ]],
  ]}}]);
  const holeResult = validatePolygonFeatureCollection(outsideHole);
  const componentResult = validatePolygonFeatureCollection(overlappingComponents);
  assert.equal(holeResult.pass, false);
  assert.match(holeResult.errors.join("\n"), /hole is not contained/);
  assert.equal(componentResult.pass, false);
});

test("unknown Admin-1 parent is unresolved", () => {
  const source = collection([{type: "Feature", properties: {ne_id: 1, adm0_a3: "ZZZ", sov_a3: "ZZZ", gu_a3: "ZZZ"}, geometry: {type: "Polygon", coordinates: [clockwiseSquare]}}]);
  const result = resolveAdmin1Parents(source, ["AAA"], [{id: "AAA", flagCode: "AA"}]);
  assert.equal(result.allResolved, false);
  assert.equal(result.unresolved.length, 1);
});

test("production coverage rejects a missing and zero-atom country", () => {
  const p0 = collection([polygonFeature("AAA")]);
  const resolution = {entries: [], allResolved: true};
  const result = calculateProductionCoverage(p0, resolution, [{pass: true}], ["AAA", "BBB"]);
  assert.equal(result.fullCoverage, false);
  assert.deepEqual(result.missingCountries.map((entry) => entry.countryId), ["BBB"]);
  assert.deepEqual(result.zeroAtomCountries.map((entry) => entry.countryId), ["BBB"]);
});

test("production coverage uses the explicit production set and rejects duplicate or unknown P0 IDs", () => {
  const p0 = collection([polygonFeature("AAA"), polygonFeature("AAA"), polygonFeature("CCC")]);
  const resolution = {entries: [], allResolved: true};
  const result = calculateProductionCoverage(p0, resolution, [{pass: true}], ["AAA", "BBB"]);
  assert.equal(result.fullCoverage, false);
  assert.deepEqual(result.canonicalProductionCountryIds, ["AAA", "BBB"]);
  assert.deepEqual(result.duplicateP0CountryIds, ["AAA"]);
  assert.deepEqual(result.unknownP0CountryIds, ["CCC"]);
});

test("cap overflow is rejected", () => {
  const result = validateCaps({totalAtoms: 2, countries: [{countryId: "AAA", atomCount: 2}]}, 10, {worldAtoms: 1, countryAtoms: 1, authoritativeVertices: 5});
  assert.equal(result.pass, false);
});

test("source lock rejects missing required fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt14-lock-"));
  try {
    const bytes = Buffer.from("{}");
    fs.writeFileSync(path.join(root, "source.geojson"), bytes);
    const result = validateSourceLock({repositoryPath: "source.geojson", sha256: sha256(bytes), byteLength: bytes.length}, root);
    assert.equal(result.pass, false);
    assert.ok(result.missingFields.includes("release"));
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("source lock rejects unknown boundary kinds and semantic operationalOnly mismatches", () => {
  const base = {sourceId: "p0", release: "2020", sourceVersion: "1", license: "public-domain", attribution: "authority", acquiredFrom: "https://authority.example/releases/2020/source.geojson", repositoryPath: "source.geojson", sha256: "0".repeat(64), byteLength: 1, geometryTypes: ["Polygon"], coveredCountryIds: ["AAA"]};
  assert.equal(validateBoundarySourceLockSchema({...base, boundaryKind: "legal-canonical", operationalOnly: false}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, boundaryKind: "legal-2020", operationalOnly: true}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, boundaryKind: "administrative-operational", operationalOnly: false}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, boundaryKind: "legal-2020", operationalOnly: false}, process.cwd()).pass, true);
});

test("source lock rejects floating identities and non-canonical arrays", () => {
  const base = {sourceId: "p0", release: "v5.1.2", sourceVersion: "f1890d9f152c896d250a77557a5751a93d494776", license: "public-domain", attribution: "authority", acquiredFrom: "https://authority.example/blob/f1890d9f152c896d250a77557a5751a93d494776/source.geojson", repositoryPath: "source.geojson", sha256: "0".repeat(64), byteLength: 1, geometryTypes: ["Polygon", "MultiPolygon"], coveredCountryIds: ["AAA", "BBB"], boundaryKind: "legal-2020", operationalOnly: false};
  assert.equal(validateBoundarySourceLockSchema({...base, release: "latest"}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, sourceVersion: "main"}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, acquiredFrom: "https://authority.example/main/source.geojson"}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, geometryTypes: ["MultiPolygon", "Polygon"]}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema({...base, coveredCountryIds: ["BBB", "AAA"]}, process.cwd()).pass, false);
  assert.equal(validateBoundarySourceLockSchema(base, process.cwd()).pass, true);
});

test("top-level source-lock manifest enforces schema version, strict fields, and ordering", () => {
  const provenance = {sourceId: "p0", authorityDate: "2020-01-01", boundaryClaim: "legal-country-boundaries", verificationStatus: "unverified", evidenceFiles: [], unresolvedReason: "missing authority"};
  const source = (sourceId) => ({sourceId});
  const valid = {schemaVersion: "prompt14-production-polygon-source-lock-v1", canonicalProvenance: provenance, sources: [source("aaa"), source("bbb")]};
  assert.equal(validateSourceLockManifestSchema(valid).pass, true);
  assert.equal(validateSourceLockManifestSchema({...valid, schemaVersion: "latest"}).pass, false);
  assert.equal(validateSourceLockManifestSchema({...valid, unexpected: true}).pass, false);
  assert.equal(validateSourceLockManifestSchema({...valid, sources: [source("bbb"), source("aaa")]}).pass, false);
  const evidence = (authorityId) => ({evidenceKind: "authoritative-boundary-source", authorityId, sourceId: "p0", authorityDate: "2020-01-01", boundaryClaim: "legal-country-boundaries", release: "2020", sourceVersion: "1", acquiredFrom: "https://authority.example/releases/2020/source.geojson", repositoryPath: "source.geojson", sha256: "0".repeat(64), byteLength: 1, mediaType: "application/geo+json"});
  assert.equal(validateSourceLockManifestSchema({...valid, canonicalProvenance: {...provenance, evidenceFiles: [evidence("bbb"), evidence("aaa")]}}).pass, false);
});

test("canonical provenance requires a trusted source-bound authoritative GeoJSON artifact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt14-provenance-"));
  try {
    const sourceBytes = Buffer.from(JSON.stringify(collection([polygonFeature("AAA")])));
    fs.writeFileSync(path.join(root, "source.geojson"), sourceBytes);
    const acquiredFrom = "https://authority.example/releases/2020-fixed/source.geojson";
    const lock = {sourceId: "p0", release: "2020-fixed", sourceVersion: "1", license: "public-domain", attribution: "authority", acquiredFrom, repositoryPath: "source.geojson", sha256: sha256(sourceBytes), byteLength: sourceBytes.length, geometryTypes: ["Polygon"], coveredCountryIds: ["AAA"], boundaryKind: "legal-2020", operationalOnly: false};
    const evidence = {evidenceKind: "authoritative-boundary-source", authorityId: "test-authority", sourceId: "p0", authorityDate: "2020-01-01", boundaryClaim: "legal-country-boundaries", release: lock.release, sourceVersion: lock.sourceVersion, acquiredFrom, repositoryPath: lock.repositoryPath, sha256: lock.sha256, byteLength: lock.byteLength, mediaType: "application/geo+json"};
    const policy = {requiredAuthorityDate: "2020-01-01", requiredBoundaryClaim: "legal-country-boundaries", requiredEvidenceKind: "authoritative-boundary-source", requiredMediaType: "application/geo+json", trustedAuthorities: [{authorityId: "test-authority", sourceId: "p0", authorityDate: "2020-01-01", boundaryClaim: "legal-country-boundaries", release: lock.release, sourceVersion: lock.sourceVersion, acquiredFrom, sha256: lock.sha256, byteLength: lock.byteLength}]};
    const verified = validateCanonicalProvenance({sourceId: "p0", authorityDate: "2020-01-01", boundaryClaim: "legal-country-boundaries", verificationStatus: "verified", evidenceFiles: [evidence]}, [lock], root, policy);
    const unverified = validateCanonicalProvenance({sourceId: "p0", authorityDate: "2020-01-01", boundaryClaim: "legal-country-boundaries", verificationStatus: "unverified", evidenceFiles: []}, [lock], root);
    assert.equal(verified.pass, true);
    assert.equal(unverified.pass, false);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("verified arbitrary text cannot satisfy canonical provenance", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prompt14-fake-provenance-"));
  try {
    const bytes = Buffer.from("self-authored verification text");
    fs.writeFileSync(path.join(root, "source.geojson"), bytes);
    const acquiredFrom = "https://authority.example/releases/2020/source.geojson";
    const lock = {sourceId: "p0", release: "2020", sourceVersion: "1", license: "public-domain", attribution: "authority", acquiredFrom, repositoryPath: "source.geojson", sha256: sha256(bytes), byteLength: bytes.length, geometryTypes: ["Polygon"], coveredCountryIds: ["AAA"], boundaryKind: "legal-2020", operationalOnly: false};
    const evidence = {evidenceKind: "authoritative-boundary-source", authorityId: "test-authority", sourceId: "p0", authorityDate: "2020-01-01", boundaryClaim: "legal-country-boundaries", release: lock.release, sourceVersion: lock.sourceVersion, acquiredFrom, repositoryPath: lock.repositoryPath, sha256: lock.sha256, byteLength: lock.byteLength, mediaType: "application/geo+json"};
    const policy = {requiredAuthorityDate: "2020-01-01", requiredBoundaryClaim: "legal-country-boundaries", requiredEvidenceKind: "authoritative-boundary-source", requiredMediaType: "application/geo+json", trustedAuthorities: [{authorityId: "test-authority", sourceId: "p0", authorityDate: "2020-01-01", boundaryClaim: "legal-country-boundaries", release: lock.release, sourceVersion: lock.sourceVersion, acquiredFrom, sha256: lock.sha256, byteLength: lock.byteLength}]};
    const result = validateCanonicalProvenance({sourceId: "p0", authorityDate: "2020-01-01", boundaryClaim: "legal-country-boundaries", verificationStatus: "verified", evidenceFiles: [evidence]}, [lock], root, policy);
    assert.equal(result.pass, false);
    assert.equal(result.evidenceResults[0].geoJsonSource, false);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test("delivery direct dependency version mismatch is rejected", () => {
  const result = summarizePackageVersions({dependencies: {"polygon-clipping": "0.15.7"}, devDependencies: {"geojson-vt": "4.0.2", "@maplibre/vt-pbf": "4.3.2", "@turf/boolean-valid": "7.4.0"}});
  assert.equal(result.pass, false);
});

test("delivery lockfile version mismatch is rejected", () => {
  const manifest = {dependencies: {"polygon-clipping": "0.15.7"}, devDependencies: {"geojson-vt": "4.0.3", "@maplibre/vt-pbf": "4.3.2", "@turf/boolean-valid": "7.4.0"}};
  const lockPackages = {"": {dependencies: manifest.dependencies, devDependencies: manifest.devDependencies}};
  const installed = {};
  for (const [name, version, license] of [["geojson-vt", "4.0.2", "ISC"], ["@maplibre/vt-pbf", "4.3.2", "MIT"], ["@turf/boolean-valid", "7.4.0", "MIT"]]) {
    lockPackages[`node_modules/${name}`] = {version, license, integrity: "sha512-test"};
    installed[name] = {version: name === "geojson-vt" ? "4.0.3" : version, license};
  }
  lockPackages["node_modules/polygon-clipping"] = {version: "0.15.7", license: "MIT", integrity: "sha512-test"};
  installed["polygon-clipping"] = {version: "0.15.7", license: "MIT"};
  assert.equal(summarizePackageVersions(manifest, {packages: lockPackages}, installed).pass, false);
});

test("containment policy rejects gap, overlap, and cross-border fixtures", () => {
  const result = runContainmentPolicyFixtures();
  assert.equal(result.pass, true);
  assert.equal(result.cases.success.pass, true);
  assert.equal(result.cases.gap.pass, false);
  assert.equal(result.cases.overlap.pass, false);
  assert.equal(result.cases.crossBorder.pass, false);
});

test("independent delivery generations are deterministic", () => {
  const result = benchmarkDeterministicDelivery(collection([{type: "Feature", properties: {ne_id: 1, adm0_a3: "AAA"}, geometry: {type: "Polygon", coordinates: [clockwiseSquare]}}]), 1);
  assert.equal(result.pass, true);
  assert.equal(result.byteIdentical, true);
  assert.equal(result.first.manifestRoot, result.second.manifestRoot);
});

test("hardGate.pass is exactly the AND and status contradictions are rejected", () => {
  const success = evaluateHardGate({a: {pass: true}, b: {pass: true}});
  const failure = evaluateHardGate({a: {pass: true}, b: {pass: false, error: "blocked"}});
  assert.equal(success.pass, true);
  assert.equal(failure.pass, false);
  assert.deepEqual(failure.firstBlockingCondition, {gate: "b", reason: "blocked"});
  assert.doesNotThrow(() => assertReportStatusConsistent("blocked", failure));
  assert.throws(() => assertReportStatusConsistent("pass", failure));
  assert.equal(exitCodeForHardGate(success), 0);
  assert.equal(exitCodeForHardGate(failure), 2);
});
