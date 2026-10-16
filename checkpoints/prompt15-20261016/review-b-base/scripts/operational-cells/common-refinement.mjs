import clipping from 'polygon-clipping';
import GeoJSONReader from 'jsts/org/locationtech/jts/io/GeoJSONReader.js';
import IsValidOp from 'jsts/org/locationtech/jts/operation/valid/IsValidOp.js';
import {administrativeKey, generationInputSchema, refinementFaceSchema} from '../../src/lib/operational-cells/model.ts';

const coordinates = g => g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
const reader = new GeoJSONReader();
const fail = (code, detail) => { throw new Error(`${code}: ${detail}`); };
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const union = geometries => {
  if (!geometries.length) return [];
  return clipping.union(...geometries.map(coordinates));
};
const equal = (a, b) => clipping.xor(a, b).length === 0;
const validate = geometry => {
  const parsed = reader.read(geometry);
  if (parsed.isEmpty() || !new IsValidOp(parsed).isValid() || !(parsed.getArea() > 0)) {
    fail('INVALID_GEOMETRY', 'Nonempty valid polygon required; no repair or component removal');
  }
};
function assertPartition(parent, children, context) {
  if (!children.length) fail('MISSING_PARTITION', context);
  for (let i = 0; i < children.length; i++) {
    if (clipping.difference(coordinates(children[i]), coordinates(parent)).length) fail('OUTSIDE_PARENT', context);
    for (let j = 0; j < i; j++) {
      if (clipping.intersection(coordinates(children[i]), coordinates(children[j])).length) fail('OVERLAPPING_PARTITION', context);
    }
  }
  if (!equal(union(children), coordinates(parent))) fail('INCOMPLETE_COVERAGE', context);
}

/** Small offline contract experiment. Intersect both complete partitions BEFORE
 * any mesh subdivision. No centroid assignment, residual allocation or state migration.
 * Exact empty residual is required here; this does not establish a rollout tolerance.
 * Production common edge noding and resolution policies belong to later generators. */
export function buildProtectedRefinement(value) {
  const input = generationInputSchema.parse(value); // detached copy; caller's bytes/state remain untouched
  const faces = [];
  for (const item of [...input.envelopes, ...input.administrativeRegions, ...input.previousTerritories]) validate(item.geometry);
  for (let i = 0; i < input.envelopes.length; i++) {
    for (let j = 0; j < i; j++) {
      if (clipping.intersection(coordinates(input.envelopes[i].geometry), coordinates(input.envelopes[j].geometry)).length) {
        fail('CROSS_COUNTRY_OVERLAP', input.envelopes[i].sourceCountryId);
      }
    }
  }
  for (const envelope of input.envelopes) {
    const country = envelope.sourceCountryId;
    const noSource = input.noAdministrativeSource.find(c => c.sourceCountryId === country);
    const admins = input.administrativeRegions.filter(a => a.identity.sourceCountryId === country);
    const old = input.previousTerritories.filter(t => t.sourceCountryId === country);
    const parents = noSource ? [{geometry: envelope.geometry, parent: {
      kind: 'no-administrative-source', sourceCountryId: country, evidence: noSource.evidence,
    }}] : admins.map(a => ({geometry: a.geometry, parent: {kind: 'administrative-region', identity: a.identity}}));
    assertPartition(envelope.geometry, parents.map(a => a.geometry), `${country} administrative`);
    assertPartition(envelope.geometry, old.map(t => t.geometry), `${country} previous`);
    for (const admin of parents) for (const previous of old) {
      const intersection = clipping.intersection(coordinates(admin.geometry), coordinates(previous.geometry));
      // Each disconnected polygon remains a distinct face, with its holes retained.
      for (const polygon of intersection) {
        const geometry = {type: 'Polygon', coordinates: polygon};
        validate(geometry);
        faces.push(refinementFaceSchema.parse({sourceCountryId: country, administrativeParent: admin.parent,
          previousGeometryParent: {catalogRef: input.previousCatalogRef, territoryId: previous.id}, geometry}));
      }
    }
    const selected = faces.filter(f => f.sourceCountryId === country);
    for (const admin of parents) {
      const key = admin.parent.kind === 'administrative-region' ? administrativeKey(admin.parent.identity) : null;
      assertPartition(admin.geometry, selected.filter(f => key === null ||
        (f.administrativeParent.kind === 'administrative-region' && administrativeKey(f.administrativeParent.identity) === key))
        .map(f => f.geometry), `${country} refined administrative union`);
    }
    for (const previous of old) assertPartition(previous.geometry,
      selected.filter(f => f.previousGeometryParent.territoryId === previous.id).map(f => f.geometry),
      `${country} refined previous union`);
  }
  return freeze({version: 1, kind: 'protected-refinement-base', targetCatalogVersion: input.targetCatalogVersion,
    previousCatalogRef: input.previousCatalogRef, provenance: input.provenance, faces});
}
