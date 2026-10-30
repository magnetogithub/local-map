import 'server-only';
import {createHash} from 'node:crypto';
import index from '../../../data/derived/chn-2020/province-render-f1c91c059cdb06f5234f/index.json';
import type {OperationalCatalog} from '../world/operational-catalog.server';
import {readProvincePresentation} from './province-presentation.server';

export const CHN_PROVINCE_PRESENTATION_IDENTITY = Object.freeze({
  path: 'data/derived/chn-2020/province-render-f1c91c059cdb06f5234f/index.json',
  sha256: 'f1c91c059cdb06f5234f22843e4739991f0036048ef8fb5da433ae345d70cd3f', byteLength: 631021,
});

/** The Node writer emits JSON.stringify + LF. Check the exact accepted bytes of
 * this server-only bundled projection, including its full artifact/proof pins. */
export function assertAcceptedProvincePresentation(value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length !== CHN_PROVINCE_PRESENTATION_IDENTITY.byteLength ||
      createHash('sha256').update(bytes).digest('hex') !== CHN_PROVINCE_PRESENTATION_IDENTITY.sha256) throw Error('PROVINCE_PRESENTATION_IDENTITY');
}

export function loadCHNProvincePresentation(catalog: OperationalCatalog) {
  assertAcceptedProvincePresentation(index);
  for (const [key, file] of [['metadata', 'metadata/countries/CHN.json.gz'], ['parents', 'metadata/parents.json.gz'], ['incidence', 'metadata/edge-incidence.bin.gz']] as const) {
    const actual = catalog.deliveryArtifact(file), expected = index.inputs[key];
    if (actual.sha256 !== expected.sha256 || actual.byteLength !== expected.byteLength) throw Error('PROVINCE_PRESENTATION_INPUT_CHANGED');
  }
  return {groups: readProvincePresentation(index, catalog), root: CHN_PROVINCE_PRESENTATION_IDENTITY.sha256,
    boundaryOrdinals: Object.freeze([...index.addedBoundaryOrdinals])};
}
