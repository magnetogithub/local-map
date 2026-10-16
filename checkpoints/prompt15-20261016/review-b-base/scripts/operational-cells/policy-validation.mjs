import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {z} from 'zod';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// This digest is the pre-experiment criterion identity, never supplied by measurements.
export const EXPECTED_POLICY_SHA256 = 'e543d125efc8469dd38ac56d8f1d0721e8de7b6b4bd35ca8f1485d14015b4918';
const policyBytes = fs.readFileSync(new URL('./scoring-policy.json', import.meta.url));
export function validatePolicyBytes(bytes) {
  if (hash(bytes) !== EXPECTED_POLICY_SHA256) throw new Error('POLICY_CHANGED: invalidate dependent evidence and return to 15-12');
  return JSON.parse(bytes.toString('utf8'));
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export const policy = freeze(validatePolicyBytes(policyBytes));
export const policyIdentity = freeze({sha256: hash(policyBytes), byteLength: policyBytes.length,
  version: policy.version});

const nonnegative = z.number().finite().nonnegative();
const positive = z.number().finite().positive();
const fraction = nonnegative.max(1);
const integer = nonnegative.int();
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const artifact = z.strictObject({path: z.string().min(1), sha256: sha, byteLength: integer.positive()});
export const freezeReceiptSchema = z.strictObject({
  version: z.literal(1), taskId: z.literal('15-12'), phase: z.literal('before-candidate-scoring'),
  policySha256: z.literal(EXPECTED_POLICY_SHA256), policyByteLength: z.literal(policyBytes.length),
  sourceInputs: z.array(artifact).min(1), candidateResultsConsumed: z.literal(0),
});
export function createFreezeReceipt(sourceInputs) {
  return freezeReceiptSchema.parse({version: 1, taskId: '15-12', phase: 'before-candidate-scoring',
    policySha256: EXPECTED_POLICY_SHA256, policyByteLength: policyBytes.length,
    sourceInputs, candidateResultsConsumed: 0});
}
export function freezeReceiptDigest(receipt) {
  return hash(JSON.stringify(freezeReceiptSchema.parse(receipt)));
}
const metric = z.strictObject({
  distanceUnit: z.literal('km'), areaUnit: z.literal('km2'),
  method: z.enum(['ellipsoidal-geodesic', 'bounded-metric-projection']),
  definition: artifact, relativeErrorBound: nonnegative.max(policy.physical.maxMetricRelativeError),
  handlesAntimeridian: z.literal(true), handlesHighLatitude: z.literal(true),
});
const cellMetrics = z.strictObject({maxDiameterKm: positive, maxAreaKm2: positive,
  maxAspectRatio: positive.min(1), distinctDepthStages: integer.positive()});
const common = {
  policySha256: z.literal(EXPECTED_POLICY_SHA256), freezeReceiptSha256: sha,
  geometryEvidence: artifact, metric,
};
const physicalSchema = z.strictObject({...common, kind: z.literal('physical'),
  border: cellMetrics, interior: cellMetrics,
  sliverCountFraction: fraction, sliverAreaFraction: fraction,
  unsplitExceptions: z.array(z.strictObject({geometrySha256: sha, sourceComponentAreaKm2: positive,
    sourceComponentDiameterKm: positive, reason: z.literal(policy.exceptions.eligibleReason),
    wholeCountry: z.literal(false)})), exceptionCountryAreaFraction: fraction,
  exceptionCellCountFraction: fraction,
});
const selectionSchema = z.strictObject({...common, kind: z.literal('selection'),
  extent: z.enum(['near', 'limited', 'deeper']), frontier: z.enum(['source-border', 'current-control']),
  depthLowerKm: positive, depthUpperKm: positive, widthLowerKm: positive, widthUpperKm: positive, areaKm2: positive,
  administrativeAreaKm2: positive, administrativeDiameterKm: positive,
  retainedInteriorAreaKm2: nonnegative, connectedByPositiveLandEdges: z.literal(true),
  equalsWholeAdministrativeMembership: z.literal(false), selectedCells: integer.positive(),
  aggregateChangedCells: integer.positive(), truncatedOrPaginatedCommit: z.literal(false),
  conservativeGeometryBounds: z.literal(true),
});
const costSchema = z.strictObject({kind: z.literal('cost'), policySha256: z.literal(EXPECTED_POLICY_SHA256),
  freezeReceiptSha256: sha, measurementEvidence: artifact,
  metrics: z.strictObject(Object.fromEntries(Object.keys(policy.budget).map(key => [key, nonnegative]))),
});
const measurementSchema = z.discriminatedUnion('kind', [physicalSchema, selectionSchema, costSchema]);

/** Scores supplied measurements only; does not generate geometry or certify evidence bytes.
 * Caller must verify artifact pins and independent physical measurements. Missing data fails.
 */
export function assessMeasurement(receipt, input) {
  const sealed = freezeReceiptSchema.parse(receipt);
  const value = measurementSchema.parse(input);
  if (value.freezeReceiptSha256 !== freezeReceiptDigest(sealed)) throw new Error('UNPINNED_EXPERIMENT');
  const failures = [];
  const upper = (name, actual, maximum) => { if (actual > maximum) failures.push(name); };
  const lower = (name, actual, minimum) => { if (actual < minimum) failures.push(name); };
  if (value.kind === 'physical') {
    for (const zone of ['border', 'interior']) {
      upper(`${zone}.diameter`, value[zone].maxDiameterKm, policy.physical[zone].maxDiameterKm);
      upper(`${zone}.area`, value[zone].maxAreaKm2, policy.physical[zone].maxAreaKm2);
      upper(`${zone}.diameter/W`, value[zone].maxDiameterKm / policy.physical.representativeAdvanceWKm,
        policy.physical.maxDiameterToWRatio);
      upper(`${zone}.aspect`, value[zone].maxAspectRatio, policy.physical.maxAspectRatio);
      lower(`${zone}.depth-stages`, value[zone].distinctDepthStages, policy.physical.minDistinctDepthStages);
    }
    upper('sliver.count', value.sliverCountFraction, policy.physical.maxSliverCountFraction);
    upper('sliver.area', value.sliverAreaFraction, policy.physical.maxSliverAreaFraction);
    upper('exception.country-area', value.exceptionCountryAreaFraction, policy.exceptions.maxCountryAreaFraction);
    upper('exception.cell-count', value.exceptionCellCountFraction, policy.exceptions.maxCellCountFraction);
    if (!value.unsplitExceptions.length && (value.exceptionCountryAreaFraction || value.exceptionCellCountFraction)) {
      failures.push('exception.missing-inventory');
    }
    for (const exception of value.unsplitExceptions) {
      upper('exception.source-area', exception.sourceComponentAreaKm2, policy.exceptions.maxSourceComponentAreaKm2);
      upper('exception.source-diameter', exception.sourceComponentDiameterKm, policy.exceptions.maxSourceComponentDiameterKm);
      if (!policy.exceptions.approvedGeometryPins.includes(exception.geometrySha256)) failures.push('exception.unapproved-geometry');
    }
  } else if (value.kind === 'selection') {
    const limits = policy.extent[value.extent];
    upper('extent.depth', value.depthUpperKm, limits.maxDepthKm);
    lower('extent.depth-min', value.depthLowerKm, limits.minDepthKm);
    upper('extent.depth-bounds', value.depthLowerKm, value.depthUpperKm);
    upper('extent.width', value.widthUpperKm, limits.maxWidthKm);
    lower('extent.width-min', value.widthLowerKm, limits.minWidthKm);
    upper('extent.width-bounds', value.widthLowerKm, value.widthUpperKm);
    upper('extent.area', value.areaKm2, limits.maxAreaKm2);
    // Ratio gates apply even to small regions; no country-specific waiver.
    upper('extent.admin-area-fraction', value.areaKm2 / value.administrativeAreaKm2, limits.maxAdminAreaFraction);
    lower('extent.retained-interior', value.retainedInteriorAreaKm2 / value.administrativeAreaKm2,
      limits.minRetainedInteriorFraction);
    upper('extent.area-accounting', value.areaKm2 + value.retainedInteriorAreaKm2, value.administrativeAreaKm2);
    upper('extent.aggregate-cap', value.aggregateChangedCells, policy.budget.aggregateChangedCells);
    upper('extent.selection-in-aggregate', value.selectedCells, value.aggregateChangedCells);
  } else {
    for (const [name, maximum] of Object.entries(policy.budget)) upper(`budget.${name}`, value.metrics[name], maximum);
    for (const name of ['worldCells', 'countryCells', 'authoritativeVertices', 'positiveSharedEdges',
      'membershipEntries', 'tileCount', 'lookupCalls', 'submitCalls', 'repairCalls', 'aggregateChangedCells']) {
      if (!Number.isInteger(value.metrics[name])) failures.push(`budget.${name}.integer`);
    }
  }
  return {policySha256: EXPECTED_POLICY_SHA256, kind: value.kind,
    accepted: failures.length === 0, failures};
}
