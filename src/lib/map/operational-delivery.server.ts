import 'server-only';
import {gunzipSync} from 'node:zlib';
import {loadOperationalCatalog, type OperationalCatalog} from '../world/operational-catalog.server';
import {readOperationalMapBootstrap, type OperationalMapBootstrap} from './operational-delivery-contract';

// Only render transport is public. Admission, provenance and build artifacts stay local.
const publicAsset = /^(?:(?:manifest|tile-index|detail-index)\.json|lod-coverage\.json\.gz|tiles\/[0-6]\/\d+\/\d+\.pbf\.gz|metadata\/(?:parents\.json\.gz|edge-incidence\.bin\.gz|countries\/[A-Z]{3}\.json\.gz)|detail\/(?:countries\/[A-Z]{3}\.geojson\.gz|topology\/\d{3}\.json\.gz))$/;
export function prepareOperationalMapDelivery(catalog: OperationalCatalog = loadOperationalCatalog()) {
  const identity = (file: string) => ({...catalog.deliveryArtifact(file), path: `/data/territory-catalog/${catalog.ref.catalogVersion}/${file}`});
  // Classify immutable lineage once from small metadata and numeric incidence.
  // Reading full topology geometry or raw ADM1 GeoJSON here would slow map startup.
  for (const countryId of catalog.descriptor.countryOrder) catalog.loadCountry(countryId);
  const incidence = gunzipSync(catalog.readDeliveryAsset('metadata/edge-incidence.bin.gz'));
  if (incidence.length !== catalog.descriptor.counts.edges * 8) throw Error('INVALID_OPERATIONAL_BOUNDARY_INCIDENCE');
  const legacyBoundaryOrdinals: number[] = [];
  for (let n = 1; n <= catalog.descriptor.counts.edges; n++) {
    const left = catalog.cell(incidence.readUInt32LE((n - 1) * 8));
    const rightOrdinal = incidence.readUInt32LE((n - 1) * 8 + 4);
    if (!rightOrdinal) continue;
    const right = catalog.cell(rightOrdinal);
    if (left.ordinal === right.ordinal) throw Error('INVALID_OPERATIONAL_BOUNDARY_INCIDENCE');
    if (left.sourceCountryId !== right.sourceCountryId || left.administrativeOrdinal === right.administrativeOrdinal) continue;
    if (catalog.administrativeParents[left.administrativeOrdinal - 1]?.kind === 'administrative' &&
        catalog.administrativeParents[right.administrativeOrdinal - 1]?.kind === 'administrative') legacyBoundaryOrdinals.push(n);
  }
  const bootstrap: OperationalMapBootstrap = readOperationalMapBootstrap({schemaVersion: 'operational-map-bootstrap-v1', catalog: catalog.descriptor,
    manifest: identity('manifest.json'), tileIndex: identity('tile-index.json'), detailIndex: identity('detail-index.json'),
    parents: identity('metadata/parents.json.gz'), coverage: identity('lod-coverage.json.gz'), legacyBoundaryOrdinals}, catalog.ref);
  return Object.freeze({bootstrap, asset: (version: string, file: string) => {
    if (version !== catalog.ref.catalogVersion || !publicAsset.test(file)) return null;
    let artifact;
    try {artifact = catalog.deliveryArtifact(file);} catch {return null;}
    return {identity: artifact, bytes: catalog.readDeliveryAsset(file)};
  }});
}
let delivery: ReturnType<typeof prepareOperationalMapDelivery> | undefined;
export const loadOperationalMapDelivery = () => delivery ??= prepareOperationalMapDelivery();
