import 'server-only';
import {createHash} from 'node:crypto';
import index from '../../../data/derived/chn-2020/internal-line-delivery-669848e00a0d5612b2aa/delivery.json';
import type {OperationalCatalog} from '../world/operational-catalog.server';
import {assertWorldGeometryCatalogRefMatches} from '../world/world-geometry-catalog-ref';

export const CHN_BOUNDARY_DISPLAY_LOD_IDENTITY = Object.freeze({
  path: 'data/derived/chn-2020/internal-line-delivery-669848e00a0d5612b2aa/delivery.json',
  sha256: '669848e00a0d5612b2aa1823aa7a1be1227ad069a80ef222f5f2a967dd6ff4d2', byteLength: 4572047,
});
export function assertAcceptedBoundaryDisplayLod(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== CHN_BOUNDARY_DISPLAY_LOD_IDENTITY.byteLength || hash !== CHN_BOUNDARY_DISPLAY_LOD_IDENTITY.sha256) throw Error(`BOUNDARY_DISPLAY_LOD_IDENTITY:${bytes.length}:${hash}`);
}
let accepted = false;
const payloads = new Map<string, Buffer>();

/** A separate, proof-pinned presentation. No operational artifact or save changes. */
export function loadCHNBoundaryDisplayLod(catalog: OperationalCatalog, provinceOrdinals: readonly number[], microOrdinals: readonly number[]) {
  if (!accepted) {assertAcceptedBoundaryDisplayLod(index); accepted = true;}
  assertWorldGeometryCatalogRefMatches(index.catalogRef, catalog.ref);
  for (const [key, file] of [['metadata', 'metadata/countries/CHN.json.gz'], ['parents', 'metadata/parents.json.gz'],
    ['incidence', 'metadata/edge-incidence.bin.gz'], ['catalog', 'catalog.json'], ['detailIndex', 'detail-index.json']] as const) {
    const actual = catalog.deliveryArtifact(file), expected = index.inputs[key];
    if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) throw Error('BOUNDARY_DISPLAY_LOD_INPUT_CHANGED');
  }
  for (const [entry, ordinals] of [[index.province, provinceOrdinals], [index.micro, microOrdinals]] as const) {
    if (entry.edgeOrdinals.length !== ordinals.length || entry.edgeOrdinals.some((id, i) => id !== ordinals[i])) throw Error('BOUNDARY_DISPLAY_LOD_INCIDENCE_CHANGED');
  }
  const descriptor = (entry: typeof index.province) => ({artifact: {...entry.artifact,
    path: `/data/territory-catalog/${catalog.ref.catalogVersion}/${entry.artifact.path}`},
    bounds: entry.bounds.map(Number) as [number, number, number, number], minZoom: 2.2 as const, maxZoom: 7 as const});
  return {
    provinceBoundaryLod: descriptor(index.province),
    microBoundaryLod: {...descriptor(index.micro), edgeOrdinals: index.micro.edgeOrdinals},
    asset: (file: string) => {
      const entry = [index.province, index.micro].find(entry => entry.artifact.path === file);
      if (!entry) return null;
      let bytes = payloads.get(file);
      if (!bytes) {
        bytes = Buffer.from(entry.payloadBase64, 'base64');
        if (bytes.length !== entry.artifact.byteLength || createHash('sha256').update(bytes).digest('hex') !== entry.artifact.sha256) throw Error('BOUNDARY_DISPLAY_LOD_PAYLOAD_CHANGED');
        payloads.set(file, bytes);
      }
      return {identity: entry.artifact, bytes};
    },
  };
}
