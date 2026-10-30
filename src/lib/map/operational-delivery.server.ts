import 'server-only';
import {gunzipSync} from 'node:zlib';
import {loadOperationalCatalog, type OperationalCatalog} from '../world/operational-catalog.server';
import {readOperationalMapBootstrap, type OperationalMapBootstrap} from './operational-delivery-contract';
import {loadCHNProvincePresentation} from './chn-province-presentation.server';
import {isProvincePresentationBoundary} from './province-presentation.server';
import {loadCHNBoundaryDisplayLod} from './chn-boundary-display-lod.server';

// Only render transport is public. Admission, provenance and build artifacts stay local.
const publicAsset = /^(?:(?:manifest|tile-index|detail-index)\.json|lod-coverage\.json\.gz|tiles\/[0-6]\/\d+\/\d+\.pbf\.gz|metadata\/(?:parents\.json\.gz|edge-incidence\.bin\.gz|countries\/[A-Z]{3}\.json\.gz)|detail\/(?:countries\/[A-Z]{3}\.geojson\.gz|cells\/[A-Z]{3}\/\d{4,}\.geojson\.gz|topology\/\d{3}\.json\.gz))$/;
export function prepareOperationalMapDelivery(catalog: OperationalCatalog = loadOperationalCatalog()) {
  const identity = (file: string) => ({...catalog.deliveryArtifact(file), path: `/data/territory-catalog/${catalog.ref.catalogVersion}/${file}`});
  // Classify immutable lineage once from small metadata and numeric incidence.
  // Reading full topology geometry or raw ADM1 GeoJSON here would slow map startup.
  for (const countryId of catalog.descriptor.countryOrder) catalog.loadCountry(countryId);
  const incidence = gunzipSync(catalog.readDeliveryAsset('metadata/edge-incidence.bin.gz'));
  if (incidence.length !== catalog.descriptor.counts.edges * 8) throw Error('INVALID_OPERATIONAL_BOUNDARY_INCIDENCE');
  const legacyBoundaryOrdinals: number[] = [];
  const provincePresentation = catalog.descriptor.countryOrder.includes('CHN') ? loadCHNProvincePresentation(catalog) : null;
  const provincePresentationBoundaryOrdinals: number[] = [];
  const chnInternalBoundaryOrdinals: number[] = [];
  for (let n = 1; n <= catalog.descriptor.counts.edges; n++) {
    const left = catalog.cell(incidence.readUInt32LE((n - 1) * 8));
    const rightOrdinal = incidence.readUInt32LE((n - 1) * 8 + 4);
    if (!rightOrdinal) continue;
    const right = catalog.cell(rightOrdinal);
    if (left.ordinal === right.ordinal) throw Error('INVALID_OPERATIONAL_BOUNDARY_INCIDENCE');
    if (left.sourceCountryId !== right.sourceCountryId) continue;
    if (left.sourceCountryId === 'CHN') chnInternalBoundaryOrdinals.push(n);
    if (provincePresentation && isProvincePresentationBoundary(left, right, provincePresentation.groups)) provincePresentationBoundaryOrdinals.push(n);
    if (left.administrativeOrdinal === right.administrativeOrdinal) continue;
    if (catalog.administrativeParents[left.administrativeOrdinal - 1]?.kind === 'administrative' &&
        catalog.administrativeParents[right.administrativeOrdinal - 1]?.kind === 'administrative') legacyBoundaryOrdinals.push(n);
  }
  if (provincePresentation && (provincePresentationBoundaryOrdinals.length !== provincePresentation.boundaryOrdinals.length ||
      provincePresentationBoundaryOrdinals.some((n, i) => n !== provincePresentation.boundaryOrdinals[i]))) throw Error('PROVINCE_PRESENTATION_INCIDENCE_CHANGED');
  const provinceIds = new Set(provincePresentationBoundaryOrdinals);
  const displayLod = provincePresentation ? loadCHNBoundaryDisplayLod(catalog, provincePresentationBoundaryOrdinals, chnInternalBoundaryOrdinals.filter(id => !provinceIds.has(id))) : null;
  const bootstrap: OperationalMapBootstrap = readOperationalMapBootstrap({schemaVersion: 'operational-map-bootstrap-v1', catalog: catalog.descriptor,
    manifest: identity('manifest.json'), tileIndex: identity('tile-index.json'), detailIndex: identity('detail-index.json'),
    parents: identity('metadata/parents.json.gz'), coverage: identity('lod-coverage.json.gz'), legacyBoundaryOrdinals,
    provincePresentationBoundaryOrdinals, ...(provincePresentation ? {provincePresentationRoot: provincePresentation.root} : {}),
    ...(displayLod ? {provinceBoundaryLod: displayLod.provinceBoundaryLod, microBoundaryLod: displayLod.microBoundaryLod} : {})}, catalog.ref);
  return Object.freeze({bootstrap, asset: (version: string, file: string) => {
    if (version !== catalog.ref.catalogVersion) return null;
    const displayAsset = displayLod?.asset(file); if (displayAsset) return displayAsset;
    if (!publicAsset.test(file)) return null;
    let artifact;
    try {artifact = catalog.deliveryArtifact(file);} catch {return null;}
    return {identity: artifact, bytes: catalog.readDeliveryAsset(file)};
  }});
}
let delivery: ReturnType<typeof prepareOperationalMapDelivery> | undefined;
export const loadOperationalMapDelivery = () => delivery ??= prepareOperationalMapDelivery();
