import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {performance} from "node:perf_hooks";

import booleanValid from "@turf/boolean-valid";
import {fromGeojsonVt} from "@maplibre/vt-pbf";
import geojsonVt from "geojson-vt";
import polygonClipping from "polygon-clipping";

export const VALIDATOR_POLICY = Object.freeze({
  version: "prompt14-polygon-validity-v1",
  coordinatePrecision: 6,
  exteriorWinding: "clockwise",
  interiorWinding: "counterclockwise",
  coverageAbsoluteTolerance: 1e-9,
  coverageRelativeTolerance: 1e-9,
  validator: {name: "@turf/boolean-valid", version: "7.4.0", license: "MIT"},
  clipping: {name: "polygon-clipping", version: "0.15.7", license: "MIT"},
});
export const CANONICAL_P0_VALIDATOR_POLICY = Object.freeze({
  ...VALIDATOR_POLICY,
  version: "prompt14-canonical-p0-validity-v1",
  exteriorWinding: "counterclockwise",
  interiorWinding: "clockwise",
});

export const DELIVERY_POLICY = Object.freeze({
  option: "repository-pinned Node vector tile generator",
  geojsonVt: {version: "4.0.3", license: "ISC"},
  vtPbf: {version: "4.3.2", license: "MIT"},
  tileOptions: Object.freeze({
    maxZoom: 6,
    indexMaxZoom: 5,
    indexMaxPoints: 100_000,
    tolerance: 3,
    extent: 4096,
    buffer: 64,
    promoteId: "sourceFeatureId",
  }),
});

export const DELIVERY_DEPENDENCIES = Object.freeze({
  "geojson-vt": Object.freeze({version: "4.0.3", license: "ISC", section: "devDependencies"}),
  "@maplibre/vt-pbf": Object.freeze({version: "4.3.2", license: "MIT", section: "devDependencies"}),
  "@turf/boolean-valid": Object.freeze({version: "7.4.0", license: "MIT", section: "devDependencies"}),
  "polygon-clipping": Object.freeze({version: "0.15.7", license: "MIT", section: "dependencies"}),
});

export const UPSTREAM_RELEASE = Object.freeze({
  release: "v5.1.2",
  commit: "f1890d9f152c896d250a77557a5751a93d494776",
  releasedAt: "2022-05-13T16:22:31-07:00",
  repository: "https://github.com/nvkelso/natural-earth-vector",
  admin0Blob: "5ebc66e25fc1af01edaebe9375c546655e04cf1e",
  admin1Blob: "4a8438f98ac7dfec7dc1739b1eaf91398ad33f22",
  admin0Sha256: "c7c969a764055d98b041549e264f60285e07f7d5221265c517cbc22e16222464",
  admin1Sha256: "2fb8789f2135d17c3ffac85a5e2e417dd74e5f6725bbe999f6721a50baa3678c",
});

export const BOUNDARY_KINDS = Object.freeze(["legal-2020", "administrative-operational"]);
export const SOURCE_LOCK_MANIFEST_SCHEMA_VERSION = "prompt14-production-polygon-source-lock-v1";
export const CANONICAL_PROVENANCE_POLICY = Object.freeze({
  version: "prompt14-canonical-provenance-v2",
  requiredAuthorityDate: "2020-01-01",
  requiredBoundaryClaim: "legal-country-boundaries",
  requiredEvidenceKind: "authoritative-boundary-source",
  requiredMediaType: "application/geo+json",
  trustedAuthorities: Object.freeze([]),
  trustPolicy: "Fail closed: a local declaration is not authority. A reviewed code change must pin an external authority identity, acquisition URL, release/version, and exact source digest before evidence can verify.",
});

export const ID_OVERRIDES = Object.freeze({
  KOS: "XKX", SAH: "ESH", US1: "USA", CH1: "CHN", FI1: "FIN", KA1: "KAZ",
  GB1: "GBR", FR1: "FRA", KAS: "IND", KAB: "KAZ", SPI: "CHL", BRT: "SDN",
  BRI: "URY", ESB: "GBR", WSB: "GBR", USG: "USA",
});
export const MERGED_MAP_UNIT_IDS = new Set(["KAS", "KAB", "SPI", "BRT", "BRI", "ESB", "WSB", "USG"]);
export const EXCLUDED_MAP_UNIT_IDS = new Set(["BJN", "SER", "SCR"]);
export const REMOVED_MAP_UNIT_IDS = new Set([...MERGED_MAP_UNIT_IDS, ...EXCLUDED_MAP_UNIT_IDS]);
export const CAPS = Object.freeze({worldAtoms: 6000, countryAtoms: 512, authoritativeVertices: 2_000_000});

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const uniqueSorted = (values) => [...new Set(values)].sort(canonicalCompare);
const gate = (pass, evidence, error) => ({pass: Boolean(pass), evidence, ...(pass ? {} : {error: error ?? "gate failed"})});

const signedArea = (ring) => ring.slice(0, -1).reduce((sum, position, index) => {
  const next = ring[index + 1];
  return sum + position[0] * next[1] - next[0] * position[1];
}, 0) / 2;

const polygonArea = (polygon) => Math.abs(signedArea(polygon[0]))
  - polygon.slice(1).reduce((sum, ring) => sum + Math.abs(signedArea(ring)), 0);
const multiPolygonArea = (multiPolygon) => multiPolygon.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
const geometryAsMultiPolygon = (geometry) => geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
const roundCoordinate = (value, precision) => Number(value.toFixed(precision));
const quantizeCoordinates = (value, precision) => Array.isArray(value)
  ? value.map((entry) => Array.isArray(entry) ? quantizeCoordinates(entry, precision) : roundCoordinate(entry, precision))
  : value;

function inspectRing(ring, expectedWinding, context) {
  const errors = [];
  if (!Array.isArray(ring) || ring.length < 4) return [`${context}: ring must have at least four positions`];
  for (let index = 0; index < ring.length; index += 1) {
    const position = ring[index];
    if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) {
      errors.push(`${context}[${index}]: position must contain two finite coordinates`);
      continue;
    }
    if (position[0] < -180 || position[0] > 180 || position[1] < -90 || position[1] > 90) {
      errors.push(`${context}[${index}]: coordinate is outside longitude/latitude range`);
    }
    if (index > 0 && position[0] === ring[index - 1][0] && position[1] === ring[index - 1][1]) {
      errors.push(`${context}[${index}]: consecutive duplicate coordinate`);
    }
  }
  const first = ring[0];
  const last = ring.at(-1);
  if (first?.[0] !== last?.[0] || first?.[1] !== last?.[1]) errors.push(`${context}: ring is not closed`);
  const distinct = new Set(ring.slice(0, -1).map((position) => `${position?.[0]}\0${position?.[1]}`));
  if (distinct.size < 3) errors.push(`${context}: ring has fewer than three distinct vertices`);
  const area = signedArea(ring);
  if (!Number.isFinite(area) || Math.abs(area) <= Number.EPSILON) errors.push(`${context}: ring is degenerate`);
  if (expectedWinding === "clockwise" && area >= 0) errors.push(`${context}: ring must be clockwise`);
  if (expectedWinding === "counterclockwise" && area <= 0) errors.push(`${context}: ring must be counterclockwise`);
  return errors;
}

export function validatePolygonFeatureCollection(collection, label = "asset", policy = VALIDATOR_POLICY) {
  const errors = [];
  const counts = {features: 0, polygons: 0, rings: 0, vertices: 0, polygon: 0, multiPolygon: 0};
  if (!collection || collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    return {pass: false, counts, errors: [`${label}: root must be a GeoJSON FeatureCollection`]};
  }
  collection.features.forEach((feature, featureIndex) => {
    const context = `${label}.features[${featureIndex}]`;
    counts.features += 1;
    if (!feature || feature.type !== "Feature" || !feature.properties || typeof feature.properties !== "object") {
      errors.push(`${context}: invalid Feature structure`);
      return;
    }
    const geometry = feature.geometry;
    if (!geometry || !["Polygon", "MultiPolygon"].includes(geometry.type)) {
      errors.push(`${context}: geometry must be Polygon or MultiPolygon`);
      return;
    }
    if (geometry.type === "Polygon") counts.polygon += 1;
    else counts.multiPolygon += 1;
    const polygons = geometryAsMultiPolygon(geometry);
    if (!Array.isArray(polygons) || polygons.length === 0) {
      errors.push(`${context}: geometry is empty`);
      return;
    }
    counts.polygons += polygons.length;
    polygons.forEach((polygon, polygonIndex) => {
      if (!Array.isArray(polygon) || polygon.length === 0) {
        errors.push(`${context}.polygon[${polygonIndex}]: polygon has no exterior ring`);
        return;
      }
      polygon.forEach((ring, ringIndex) => {
        counts.rings += 1;
        if (Array.isArray(ring)) counts.vertices += ring.length;
        errors.push(...inspectRing(ring, ringIndex === 0 ? policy.exteriorWinding : policy.interiorWinding, `${context}.polygon[${polygonIndex}].ring[${ringIndex}]`));
      });
      if (Array.isArray(polygon[0])) {
        for (let ringIndex = 1; ringIndex < polygon.length; ringIndex += 1) {
          const hole = polygon[ringIndex];
          if (!Array.isArray(hole) || hole.length < 4) continue;
          try {
            const holeArea = Math.abs(signedArea(hole));
            const inside = polygonClipping.intersection([polygon[0]], [hole]);
            const insideArea = multiPolygonArea(inside);
            const tolerance = Math.max(policy.coverageAbsoluteTolerance, holeArea * policy.coverageRelativeTolerance);
            if (Math.abs(holeArea - insideArea) > tolerance) errors.push(`${context}.polygon[${polygonIndex}].ring[${ringIndex}]: hole is not contained by its exterior ring`);
          } catch (error) {
            errors.push(`${context}.polygon[${polygonIndex}].ring[${ringIndex}]: hole containment validator exception: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    });
    try {
      if (!booleanValid(feature)) errors.push(`${context}: @turf/boolean-valid rejected OGC geometry validity`);
    } catch (error) {
      errors.push(`${context}: validator exception: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return {pass: errors.length === 0, counts, errors};
}

const validCountryId = (value) => typeof value === "string" && /^[A-Z][A-Z0-9]{2}$/.test(value) && value !== "-99";
export const normalizeCountryId = (value) => validCountryId(value) ? (ID_OVERRIDES[value] ?? value) : null;

export function resolveAdmin1Parents(collection, canonicalCountryIds, metadata) {
  const canonical = new Set(canonicalCountryIds);
  const byFlag = new Map(metadata.filter((country) => /^[A-Z]{2}$/.test(country.flagCode)).map((country) => [country.flagCode, country.id]));
  const entries = [];
  const normalizedParentIds = [];
  const unresolved = [];
  const duplicates = [];
  const sourceIds = new Set();
  for (let index = 0; index < collection.features.length; index += 1) {
    const feature = collection.features[index];
    const properties = feature.properties ?? {};
    const raw = {adm0_a3: properties.adm0_a3 ?? null, sov_a3: properties.sov_a3 ?? null, gu_a3: properties.gu_a3 ?? null, iso_3166_2: properties.iso_3166_2 ?? null, iso_a2: properties.iso_a2 ?? null};
    const sourceFeatureId = String(properties.ne_id ?? properties.adm1_code ?? index);
    if (sourceIds.has(sourceFeatureId)) duplicates.push(sourceFeatureId);
    sourceIds.add(sourceFeatureId);
    const rawAdmin0 = typeof properties.adm0_a3 === "string" ? properties.adm0_a3 : null;
    if (rawAdmin0 && REMOVED_MAP_UNIT_IDS.has(rawAdmin0)) {
      entries.push({sourceFeatureId, rawParentIds: raw, normalizedParentCountryId: null, resolutionRule: null, excluded: true, exclusionReason: MERGED_MAP_UNIT_IDS.has(rawAdmin0) ? "map-unit-merged-into-parent" : "map-unit-explicitly-excluded"});
      continue;
    }
    let resolved = null;
    let resolutionRule = null;
    for (const key of ["adm0_a3", "sov_a3", "gu_a3"]) {
      const normalized = normalizeCountryId(properties[key]);
      if (normalized && canonical.has(normalized)) {
        resolved = normalized;
        resolutionRule = `${key}${normalized !== properties[key] ? "+fixed-override" : ""}`;
        break;
      }
    }
    if (!resolved) {
      const iso2 = typeof properties.iso_3166_2 === "string" ? properties.iso_3166_2.split("-")[0] : null;
      const isoMatch = iso2 ? byFlag.get(iso2) : null;
      if (isoMatch && canonical.has(isoMatch)) {
        resolved = isoMatch;
        resolutionRule = "iso_3166_2-prefix";
      }
    }
    if (!resolved && typeof properties.iso_a2 === "string") {
      const isoMatch = byFlag.get(properties.iso_a2);
      if (isoMatch && canonical.has(isoMatch)) {
        resolved = isoMatch;
        resolutionRule = "iso_a2";
      }
    }
    const entry = {sourceFeatureId, rawParentIds: raw, normalizedParentCountryId: resolved, resolutionRule, excluded: false, exclusionReason: null};
    entries.push(entry);
    if (resolved) normalizedParentIds.push(resolved);
    else unresolved.push(entry);
  }
  return {
    entries,
    rawParentIds: uniqueSorted(collection.features.map((feature) => feature.properties?.adm0_a3).filter((value) => typeof value === "string")),
    normalizedParentIds: uniqueSorted(normalizedParentIds),
    unresolved,
    duplicates: uniqueSorted(duplicates),
    excludedCount: entries.filter((entry) => entry.excluded).length,
    allResolved: unresolved.length === 0 && duplicates.length === 0,
  };
}

export function calculateProductionCoverage(canonicalCollection, parentResolution, geometryValidationBySource, productionCountryIds = null) {
  const p0Counts = new Map();
  for (const feature of canonicalCollection.features) {
    const countryId = feature.properties?.countryId;
    if (typeof countryId === "string") p0Counts.set(countryId, (p0Counts.get(countryId) ?? 0) + 1);
  }
  const adminCounts = new Map();
  for (const entry of parentResolution.entries) {
    if (!entry.excluded && entry.normalizedParentCountryId) adminCounts.set(entry.normalizedParentCountryId, (adminCounts.get(entry.normalizedParentCountryId) ?? 0) + 1);
  }
  const requestedProductionIds = productionCountryIds === null ? [...p0Counts.keys()] : productionCountryIds;
  const countryIds = uniqueSorted(requestedProductionIds);
  const duplicateProductionCountryIds = uniqueSorted(requestedProductionIds.filter((countryId, index) => requestedProductionIds.indexOf(countryId) !== index));
  const invalidProductionCountryIds = uniqueSorted(requestedProductionIds.filter((countryId) => !validCountryId(countryId)));
  const duplicateP0CountryIds = uniqueSorted([...p0Counts].filter(([, count]) => count > 1).map(([countryId]) => countryId));
  const unknownP0CountryIds = uniqueSorted([...p0Counts.keys()].filter((countryId) => !countryIds.includes(countryId)));
  const countries = countryIds.map((countryId) => {
    const admin1Count = adminCounts.get(countryId) ?? 0;
    const p0PolygonCount = p0Counts.get(countryId) ?? 0;
    const classification = admin1Count > 0 ? "admin1" : p0PolygonCount > 0 ? "p0-fallback" : "missing";
    const atomCount = classification === "admin1" ? admin1Count : classification === "p0-fallback" ? p0PolygonCount : 0;
    return {countryId, admin1Count, p0PolygonCount, classification, atomCount};
  });
  const missing = countries.filter((country) => country.classification === "missing");
  const zeroAtoms = countries.filter((country) => country.atomCount === 0);
  const sourceOutsideCanonical = parentResolution.entries
    .filter((entry) => entry.excluded || (!entry.normalizedParentCountryId && !entry.excluded))
    .map((entry) => ({...entry, handlingReason: entry.excluded ? entry.exclusionReason : "unresolved-parent"}));
  const geometryValid = geometryValidationBySource.every((validation) => validation.pass);
  return {
    canonicalProductionCountryIds: countries.map((country) => country.countryId),
    countries,
    admin1Countries: countries.filter((country) => country.classification === "admin1").map((country) => country.countryId),
    p0FallbackCountries: countries.filter((country) => country.classification === "p0-fallback").map((country) => country.countryId),
    missingCountries: missing,
    zeroAtomCountries: zeroAtoms,
    sourceOutsideCanonical,
    duplicateProductionCountryIds,
    invalidProductionCountryIds,
    duplicateP0CountryIds,
    unknownP0CountryIds,
    totalAtoms: countries.reduce((sum, country) => sum + country.atomCount, 0),
    fullCoverage: geometryValid && missing.length === 0 && zeroAtoms.length === 0
      && duplicateProductionCountryIds.length === 0 && invalidProductionCountryIds.length === 0
      && duplicateP0CountryIds.length === 0 && unknownP0CountryIds.length === 0
      && parentResolution.allResolved,
  };
}

export function validateCaps(coverage, authoritativeVertices, caps = CAPS) {
  const largest = coverage.countries.reduce((current, country) => country.atomCount > current.atomCount ? country : current, {countryId: null, atomCount: 0});
  const pass = coverage.totalAtoms <= caps.worldAtoms && largest.atomCount <= caps.countryAtoms && authoritativeVertices <= caps.authoritativeVertices;
  return {pass, caps, observed: {worldAtoms: coverage.totalAtoms, largestCountry: largest, authoritativeVertices}};
}

export function validatePartitionCoverage(p0Geometry, partitionGeometries, policy = VALIDATOR_POLICY) {
  try {
    const p0 = quantizeCoordinates(geometryAsMultiPolygon(p0Geometry), policy.coordinatePrecision);
    const p0Area = multiPolygonArea(p0);
    const parts = partitionGeometries.map((geometry) => quantizeCoordinates(geometryAsMultiPolygon(geometry), policy.coordinatePrecision));
    const clipped = parts.map((part) => polygonClipping.intersection(part, p0));
    const originalArea = parts.reduce((sum, part) => sum + multiPolygonArea(part), 0);
    const clippedArea = clipped.reduce((sum, part) => sum + multiPolygonArea(part), 0);
    const union = clipped.length ? polygonClipping.union(...clipped) : [];
    const unionArea = multiPolygonArea(union);
    const gapArea = Math.max(0, p0Area - unionArea);
    const overlapArea = Math.max(0, clippedArea - unionArea);
    const outOfCountryArea = Math.max(0, originalArea - clippedArea);
    const tolerance = Math.max(policy.coverageAbsoluteTolerance, p0Area * policy.coverageRelativeTolerance);
    return {pass: gapArea <= tolerance && overlapArea <= tolerance && outOfCountryArea <= tolerance, p0Area, unionArea, gapArea, overlapArea, outOfCountryArea, tolerance};
  } catch (error) {
    return {pass: false, p0Area: null, unionArea: null, gapArea: null, overlapArea: null, outOfCountryArea: null, tolerance: null, error: error instanceof Error ? error.message : String(error)};
  }
}

export function runContainmentPolicyFixtures() {
  const polygon = (coordinates) => ({type: "Polygon", coordinates: [coordinates]});
  const p0 = polygon([[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]]);
  const cases = {
    success: validatePartitionCoverage(p0, [
      polygon([[0, 0], [0, 10], [5, 10], [5, 0], [0, 0]]),
      polygon([[5, 0], [5, 10], [10, 10], [10, 0], [5, 0]]),
    ]),
    gap: validatePartitionCoverage(p0, [polygon([[0, 0], [0, 10], [4, 10], [4, 0], [0, 0]])]),
    overlap: validatePartitionCoverage(p0, [
      polygon([[0, 0], [0, 10], [6, 10], [6, 0], [0, 0]]),
      polygon([[5, 0], [5, 10], [10, 10], [10, 0], [5, 0]]),
    ]),
    crossBorder: validatePartitionCoverage(p0, [polygon([[-1, 0], [-1, 10], [10, 10], [10, 0], [-1, 0]])]),
  };
  return {pass: cases.success.pass && !cases.gap.pass && !cases.overlap.pass && !cases.crossBorder.pass, cases};
}

function projectDeliveryFeatures(collection) {
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature, index) => ({
      type: "Feature",
      id: String(feature.properties?.ne_id ?? index),
      properties: {
        sourceCountryId: feature.properties?.adm0_a3 ?? "UNK",
        sourceFeatureId: String(feature.properties?.ne_id ?? feature.properties?.adm1_code ?? index),
      },
      geometry: feature.geometry,
    })),
  };
}

function generateMeasuredTiles(projected, maximumMeasuredZoom = 3) {
  const started = performance.now();
  const index = geojsonVt(structuredClone(projected), DELIVERY_POLICY.tileOptions);
  const tiles = [];
  for (let zoom = 0; zoom <= maximumMeasuredZoom; zoom += 1) {
    for (let x = 0; x < 2 ** zoom; x += 1) {
      for (let y = 0; y < 2 ** zoom; y += 1) {
        const tile = index.getTile(zoom, x, y);
        if (!tile) continue;
        const bytes = fromGeojsonVt({territories: tile}, {version: 2, extent: DELIVERY_POLICY.tileOptions.extent});
        tiles.push({path: `${zoom}/${x}/${y}.pbf`, sha256: sha256(bytes), byteLength: bytes.length, featureInstances: tile.features.length});
      }
    }
  }
  const manifestBytes = Buffer.from(tiles.map((tile) => `${tile.path}\0${tile.sha256}\0${tile.byteLength}`).join("\n"));
  return {tiles, manifestRoot: sha256(manifestBytes), totalBytes: tiles.reduce((sum, tile) => sum + tile.byteLength, 0), durationMilliseconds: Number((performance.now() - started).toFixed(3))};
}

export function benchmarkDeterministicDelivery(collection, maximumMeasuredZoom = 3) {
  const projected = projectDeliveryFeatures(collection);
  const first = generateMeasuredTiles(projected, maximumMeasuredZoom);
  const second = generateMeasuredTiles(projected, maximumMeasuredZoom);
  const byteIdentical = JSON.stringify(first.tiles.map(({path, sha256: hash, byteLength}) => ({path, sha256: hash, byteLength})))
    === JSON.stringify(second.tiles.map(({path, sha256: hash, byteLength}) => ({path, sha256: hash, byteLength})));
  return {
    pass: byteIdentical && first.manifestRoot === second.manifestRoot,
    environment: {node: process.version, platform: process.platform, arch: process.arch},
    packages: {geojsonVt: DELIVERY_POLICY.geojsonVt, vtPbf: DELIVERY_POLICY.vtPbf},
    inputFeatureCount: projected.features.length,
    measuredZooms: Array.from({length: maximumMeasuredZoom + 1}, (_, index) => index),
    tileOptions: DELIVERY_POLICY.tileOptions,
    first,
    second,
    byteIdentical,
  };
}

const SOURCE_LOCK_FIELDS = Object.freeze(["sourceId", "release", "sourceVersion", "license", "attribution", "acquiredFrom", "repositoryPath", "sha256", "byteLength", "geometryTypes", "coveredCountryIds", "boundaryKind", "operationalOnly"]);
const MANIFEST_FIELDS = Object.freeze(["schemaVersion", "canonicalProvenance", "sources"]);
const PROVENANCE_FIELDS = Object.freeze(["sourceId", "authorityDate", "boundaryClaim", "verificationStatus", "evidenceFiles", "unresolvedReason"]);
const EVIDENCE_FIELDS = Object.freeze(["evidenceKind", "authorityId", "sourceId", "authorityDate", "boundaryClaim", "release", "sourceVersion", "acquiredFrom", "repositoryPath", "sha256", "byteLength", "mediaType"]);
const FLOATING_IDENTIFIER_PATTERN = /(?:^|[\/@?&=._:-])(latest|current|head|main|master|trunk|develop|development|nightly|snapshot)(?:$|[\/@?&=._:-])/i;
const RANGE_IDENTIFIER_PATTERN = /(?:\^|~|\*|\|\||\s(?:<|>|<=|>=)|(?:^|[._-])[xX](?:$|[._-]))/;
const geometryTypeOrder = new Map([["Polygon", 0], ["MultiPolygon", 1]]);
const isBytewiseSorted = (values) => values.every((value, index) => index === 0 || canonicalCompare(values[index - 1], value) <= 0);
const isGeometryTypeSorted = (values) => values.every((value, index) => index === 0 || geometryTypeOrder.get(values[index - 1]) <= geometryTypeOrder.get(value));
const isFixedIdentifier = (value) => typeof value === "string" && value.trim() !== "" && !FLOATING_IDENTIFIER_PATTERN.test(value) && !RANGE_IDENTIFIER_PATTERN.test(value);

function validateFixedAcquisitionUrl(value, release, sourceVersion) {
  if (!isFixedIdentifier(value)) return false;
  try {
    const url = new URL(value);
    const identityTokens = [...url.pathname.split("/").filter(Boolean), ...url.searchParams.values()].map((token) => decodeURIComponent(token));
    const identityBound = [release, sourceVersion].some((identifier) => typeof identifier === "string" && identityTokens.includes(identifier));
    return url.protocol === "https:" && !url.username && !url.password && !url.hash && identityBound;
  } catch {
    return false;
  }
}

export function validateSourceLockManifestSchema(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return {pass: false, errors: ["manifest must be an object"], unknownFields: []};
  const unknownFields = Object.keys(manifest).filter((field) => !MANIFEST_FIELDS.includes(field));
  if (unknownFields.length) errors.push(`unknown top-level fields: ${unknownFields.join(", ")}`);
  if (manifest.schemaVersion !== SOURCE_LOCK_MANIFEST_SCHEMA_VERSION) errors.push(`schemaVersion must equal ${SOURCE_LOCK_MANIFEST_SCHEMA_VERSION}`);
  if (!manifest.canonicalProvenance || typeof manifest.canonicalProvenance !== "object" || Array.isArray(manifest.canonicalProvenance)) errors.push("canonicalProvenance must be an object");
  else {
    const provenanceUnknownFields = Object.keys(manifest.canonicalProvenance).filter((field) => !PROVENANCE_FIELDS.includes(field));
    if (provenanceUnknownFields.length) errors.push(`unknown canonicalProvenance fields: ${provenanceUnknownFields.join(", ")}`);
    for (const field of ["sourceId", "authorityDate", "boundaryClaim", "verificationStatus"]) {
      if (typeof manifest.canonicalProvenance[field] !== "string" || manifest.canonicalProvenance[field].trim() === "") errors.push(`canonicalProvenance.${field} must be a non-empty string`);
    }
    if (!['verified', 'unverified'].includes(manifest.canonicalProvenance.verificationStatus)) errors.push("canonicalProvenance.verificationStatus must be verified or unverified");
    if (!Array.isArray(manifest.canonicalProvenance.evidenceFiles)) errors.push("canonicalProvenance.evidenceFiles must be an array");
    else {
      const keys = manifest.canonicalProvenance.evidenceFiles.map((evidence) => `${evidence?.authorityId ?? ""}\0${evidence?.sourceId ?? ""}\0${evidence?.repositoryPath ?? ""}\0${evidence?.sha256 ?? ""}`);
      if (!isBytewiseSorted(keys)) errors.push("canonicalProvenance.evidenceFiles must be canonically sorted");
      for (const [index, evidence] of manifest.canonicalProvenance.evidenceFiles.entries()) {
        if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) errors.push(`canonicalProvenance.evidenceFiles[${index}] must be an object`);
        else {
          const unknown = Object.keys(evidence).filter((field) => !EVIDENCE_FIELDS.includes(field));
          if (unknown.length) errors.push(`canonicalProvenance.evidenceFiles[${index}] has unknown fields: ${unknown.join(", ")}`);
          const missing = EVIDENCE_FIELDS.filter((field) => evidence[field] === null || evidence[field] === undefined || evidence[field] === "");
          if (missing.length) errors.push(`canonicalProvenance.evidenceFiles[${index}] is missing fields: ${missing.join(", ")}`);
        }
      }
    }
  }
  if (!Array.isArray(manifest.sources) || manifest.sources.length === 0) errors.push("sources must be a non-empty array");
  else {
    const sourceIds = manifest.sources.map((source) => source?.sourceId ?? "");
    if (!isBytewiseSorted(sourceIds)) errors.push("sources must be canonically sorted by sourceId");
    if (new Set(sourceIds).size !== sourceIds.length) errors.push("sources must not contain duplicate sourceId values");
  }
  return {pass: errors.length === 0, errors, unknownFields, expectedSchemaVersion: SOURCE_LOCK_MANIFEST_SCHEMA_VERSION};
}

export function validateBoundarySourceLockSchema(lock, root) {
  const errors = [];
  if (!lock || typeof lock !== "object" || Array.isArray(lock)) return {pass: false, errors: ["source lock must be an object"], missingFields: SOURCE_LOCK_FIELDS};
  const missingFields = SOURCE_LOCK_FIELDS.filter((field) => lock[field] === null || lock[field] === undefined || lock[field] === "" || (Array.isArray(lock[field]) && lock[field].length === 0));
  const unknownFields = Object.keys(lock).filter((field) => !SOURCE_LOCK_FIELDS.includes(field));
  if (missingFields.length) errors.push(`missing required fields: ${missingFields.join(", ")}`);
  if (unknownFields.length) errors.push(`unknown fields: ${unknownFields.join(", ")}`);
  for (const field of ["sourceId", "release", "sourceVersion", "license", "attribution", "acquiredFrom", "repositoryPath"]) {
    if (lock[field] !== null && lock[field] !== undefined && (typeof lock[field] !== "string" || lock[field].trim() === "")) errors.push(`${field} must be a non-empty string`);
  }
  if (lock.release !== null && lock.release !== undefined && !isFixedIdentifier(lock.release)) errors.push("release must be an exact non-floating identifier");
  if (lock.sourceVersion !== null && lock.sourceVersion !== undefined && !isFixedIdentifier(lock.sourceVersion)) errors.push("sourceVersion must be an exact non-floating identifier");
  if (lock.acquiredFrom !== null && lock.acquiredFrom !== undefined && !validateFixedAcquisitionUrl(lock.acquiredFrom, lock.release, lock.sourceVersion)) errors.push("acquiredFrom must be a fixed HTTPS URL bound to the exact release or sourceVersion and without floating refs, credentials, or fragments");
  if (typeof lock.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(lock.sha256)) errors.push("sha256 must be 64 lowercase hexadecimal characters");
  if (!Number.isSafeInteger(lock.byteLength) || lock.byteLength <= 0) errors.push("byteLength must be a positive safe integer");
  if (!Array.isArray(lock.geometryTypes) || lock.geometryTypes.length === 0 || lock.geometryTypes.some((type) => !["Polygon", "MultiPolygon"].includes(type)) || new Set(lock.geometryTypes).size !== lock.geometryTypes.length) errors.push("geometryTypes must be a non-empty unique array containing only Polygon or MultiPolygon");
  else if (!isGeometryTypeSorted(lock.geometryTypes)) errors.push("geometryTypes must use canonical Polygon, MultiPolygon order");
  if (!Array.isArray(lock.coveredCountryIds) || lock.coveredCountryIds.length === 0 || lock.coveredCountryIds.some((countryId) => !validCountryId(countryId)) || new Set(lock.coveredCountryIds).size !== lock.coveredCountryIds.length) errors.push("coveredCountryIds must be a non-empty unique CountryId array");
  else if (!isBytewiseSorted(lock.coveredCountryIds)) errors.push("coveredCountryIds must be bytewise sorted");
  if (!BOUNDARY_KINDS.includes(lock.boundaryKind)) errors.push(`boundaryKind must be one of: ${BOUNDARY_KINDS.join(", ")}`);
  if (typeof lock.operationalOnly !== "boolean") errors.push("operationalOnly must be boolean");
  if (lock.boundaryKind === "legal-2020" && lock.operationalOnly !== false) errors.push("legal-2020 sources must set operationalOnly=false");
  if (lock.boundaryKind === "administrative-operational" && lock.operationalOnly !== true) errors.push("administrative-operational sources must set operationalOnly=true");
  if (typeof lock.repositoryPath === "string") {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(root, lock.repositoryPath);
    if (path.isAbsolute(lock.repositoryPath) || (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`))) errors.push("repositoryPath must be a relative path contained by the repository root");
  }
  return {pass: errors.length === 0, errors, missingFields, unknownFields};
}

export function validateSourceLock(lock, root, actualSource = null) {
  const schema = validateBoundarySourceLockSchema(lock, root);
  const target = schema.pass ? path.resolve(root, lock.repositoryPath) : null;
  if (!target || !fs.existsSync(target)) return {pass: false, schema, missingFields: schema.missingFields, fileExists: false, error: schema.pass ? "source file is missing" : "source lock schema is invalid"};
  const bytes = fs.readFileSync(target);
  const actual = {sha256: sha256(bytes), byteLength: bytes.length};
  const bytesMatch = actual.sha256 === lock.sha256 && actual.byteLength === lock.byteLength;
  const geometryTypesMatch = actualSource === null || JSON.stringify(uniqueSorted(lock.geometryTypes ?? [])) === JSON.stringify(uniqueSorted(actualSource.geometryTypes ?? []));
  const coveredCountryIdsMatch = actualSource === null || JSON.stringify(uniqueSorted(lock.coveredCountryIds ?? [])) === JSON.stringify(uniqueSorted(actualSource.coveredCountryIds ?? []));
  const pass = schema.pass && bytesMatch && geometryTypesMatch && coveredCountryIdsMatch;
  return {
    pass, schema, missingFields: schema.missingFields, fileExists: true, bytesMatch, geometryTypesMatch, coveredCountryIdsMatch,
    expected: {sha256: lock.sha256, byteLength: lock.byteLength, geometryTypes: lock.geometryTypes, coveredCountryIds: lock.coveredCountryIds},
    actual: {...actual, ...(actualSource ?? {})},
    ...(pass ? {} : {error: !schema.pass ? "source lock schema is invalid" : !bytesMatch ? "source bytes do not match lock" : !geometryTypesMatch ? "source geometry types do not match lock" : "source coverage does not match lock"}),
  };
}

export function validateCanonicalProvenance(provenance, sourceLocks, root, policy = CANONICAL_PROVENANCE_POLICY) {
  const requiredFields = ["sourceId", "authorityDate", "boundaryClaim", "verificationStatus", "evidenceFiles"];
  const missingFields = requiredFields.filter((field) => provenance?.[field] === null || provenance?.[field] === undefined || provenance?.[field] === "");
  const sourceLock = sourceLocks.find((lock) => lock.sourceId === provenance?.sourceId) ?? null;
  const sourceLockResult = sourceLock ? validateSourceLock(sourceLock, root) : {pass: false, error: "canonical provenance sourceId has no source lock"};
  const evidenceResults = Array.isArray(provenance?.evidenceFiles) ? provenance.evidenceFiles.map((evidence) => {
    const missing = EVIDENCE_FIELDS.filter((field) => evidence?.[field] === null || evidence?.[field] === undefined || evidence?.[field] === "");
    const trustAnchor = policy.trustedAuthorities.find((authority) => authority.authorityId === evidence?.authorityId) ?? null;
    const target = typeof evidence?.repositoryPath === "string" && !path.isAbsolute(evidence.repositoryPath) ? path.resolve(root, evidence.repositoryPath) : null;
    if (!target || !fs.existsSync(target)) return {pass: false, missingFields: missing, fileExists: false, error: "provenance evidence file is missing"};
    const bytes = fs.readFileSync(target);
    const actual = {sha256: sha256(bytes), byteLength: bytes.length};
    const bytesMatch = actual.sha256 === evidence.sha256 && actual.byteLength === evidence.byteLength;
    let geoJsonSource = false;
    try {
      const parsed = JSON.parse(bytes.toString("utf8"));
      geoJsonSource = parsed?.type === "FeatureCollection" && Array.isArray(parsed.features) && parsed.features.length > 0;
    } catch {}
    const sourceBindingMatches = Boolean(sourceLock)
      && evidence.sourceId === sourceLock.sourceId && evidence.repositoryPath === sourceLock.repositoryPath
      && evidence.sha256 === sourceLock.sha256 && evidence.byteLength === sourceLock.byteLength
      && evidence.release === sourceLock.release && evidence.sourceVersion === sourceLock.sourceVersion
      && evidence.acquiredFrom === sourceLock.acquiredFrom;
    const trustAnchorMatches = Boolean(trustAnchor)
      && trustAnchor.sourceId === evidence.sourceId && trustAnchor.authorityDate === evidence.authorityDate
      && trustAnchor.boundaryClaim === evidence.boundaryClaim && trustAnchor.release === evidence.release
      && trustAnchor.sourceVersion === evidence.sourceVersion && trustAnchor.acquiredFrom === evidence.acquiredFrom
      && trustAnchor.sha256 === evidence.sha256 && trustAnchor.byteLength === evidence.byteLength;
    const semanticContractMatches = evidence.evidenceKind === policy.requiredEvidenceKind
      && evidence.mediaType === policy.requiredMediaType && evidence.authorityDate === policy.requiredAuthorityDate
      && evidence.boundaryClaim === policy.requiredBoundaryClaim;
    const pass = missing.length === 0 && bytesMatch && geoJsonSource && sourceBindingMatches && trustAnchorMatches && semanticContractMatches;
    return {pass, missingFields: missing, fileExists: true, bytesMatch, geoJsonSource, sourceBindingMatches, trustAnchorMatches, semanticContractMatches, trustAnchorFound: Boolean(trustAnchor), expected: {sha256: evidence.sha256, byteLength: evidence.byteLength}, actual, ...(pass ? {} : {error: "evidence is not a trusted, source-bound authoritative GeoJSON artifact"})};
  }) : [];
  const pass = missingFields.length === 0
    && provenance.authorityDate === policy.requiredAuthorityDate
    && provenance.boundaryClaim === policy.requiredBoundaryClaim
    && provenance.verificationStatus === "verified"
    && evidenceResults.length > 0
    && evidenceResults.every((result) => result.pass)
    && sourceLockResult.pass
    && sourceLock?.boundaryKind === "legal-2020"
    && sourceLock?.operationalOnly === false;
  return {pass, policy, missingFields, sourceLockResult, evidenceResults, provenance, ...(pass ? {} : {error: provenance?.unresolvedReason ?? "canonical legal-boundary provenance is incomplete or unverifiable"})};
}

export function evaluateHardGate(gates) {
  const entries = Object.entries(gates);
  const firstFailure = entries.find(([, result]) => !result.pass);
  const pass = !firstFailure;
  return {pass, firstBlockingCondition: firstFailure ? {gate: firstFailure[0], reason: firstFailure[1].error ?? "gate failed"} : null};
}

export function assertReportStatusConsistent(status, hardGate) {
  if ((status === "pass") !== hardGate.pass) throw new Error(`Report status ${status} contradicts hardGate.pass=${hardGate.pass}`);
}

export function exitCodeForHardGate(hardGate) {
  return hardGate.pass ? 0 : 2;
}

export function readJson(root, repositoryPath) {
  return JSON.parse(fs.readFileSync(path.join(root, repositoryPath), "utf8"));
}

export function summarizePackageVersions(packageJson, packageLock = null, installedPackages = null) {
  const packages = Object.fromEntries(Object.entries(DELIVERY_DEPENDENCIES).map(([name, expected]) => {
    const direct = packageJson[expected.section] ?? {};
    const lockDirect = packageLock?.packages?.[""]?.[expected.section] ?? null;
    const lockEntry = packageLock?.packages?.[`node_modules/${name}`] ?? null;
    const installed = installedPackages?.[name] ?? null;
    const evidence = {
      expected,
      packageJson: direct[name] ?? null,
      packageLockDirect: lockDirect?.[name] ?? null,
      packageLockResolved: lockEntry ? {version: lockEntry.version ?? null, license: lockEntry.license ?? null, integrity: lockEntry.integrity ?? null} : null,
      installed: installed ? {version: installed.version ?? null, license: installed.license ?? null} : null,
    };
    const exactInManifest = evidence.packageJson === expected.version;
    const lockMatches = packageLock === null || (evidence.packageLockDirect === expected.version
      && evidence.packageLockResolved?.version === expected.version
      && evidence.packageLockResolved?.license === expected.license
      && typeof evidence.packageLockResolved?.integrity === "string");
    const installedMatches = installedPackages === null || (evidence.installed?.version === expected.version && evidence.installed?.license === expected.license);
    return [name, {...evidence, pass: exactInManifest && lockMatches && installedMatches}];
  }));
  return {pass: Object.values(packages).every((entry) => entry.pass), packages};
}

export {gate};
