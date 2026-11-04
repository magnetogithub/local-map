import 'server-only';
import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {canonicalStringify} from '../world/canonical-serializer';
import {loadOperationalCatalog} from '../world/operational-catalog.server';
import {geographyArtifactSchema, geographyCatalogRefSchema, geographyMetadataRefSchema} from './state-province-contract';
import {loadGeographySnapshot} from './state-province-loader.server';
import {geographyFailure} from './state-province-validation';
import type {GeographyLoaderDependencies, GeographyLoadRequest, GeographyLoadResult} from './state-province-io';

export const PRODUCTION_GEOGRAPHY_POINTER = 'data/runtime/geography/current.json';
const registrySchema = z.strictObject({schemaVersion: z.literal('geography-registry-v1'),
  catalogRef: geographyCatalogRefSchema, metadataRef: geographyMetadataRefSchema, manifest: geographyArtifactSchema});
const artifactPath = /^data\/derived\/geography\/[a-f0-9]{64}\/(?:manifest\.json|(?:metadata|admission)\.json(?:\.gz)?)$/;

/** The registry selects immutable outputs; neither clients nor the generator select runtime paths. */
export function createProductionGeographyLoader(options: Readonly<{
  root?: string;
  readFile?: (absolutePath: string) => Promise<Uint8Array>;
  catalog?: typeof loadOperationalCatalog;
}> = {}) {
  const root = options.root ?? process.cwd(), read = options.readFile ?? fs.readFile;
  const catalog = options.catalog ?? loadOperationalCatalog;
  const reject = (code: 'GEOGRAPHY_METADATA' | 'GEOGRAPHY_CATALOG', message: string, status: 'stale' | 'unavailable') => {
    const result = geographyFailure(code, 'registry', message);
    if (result.ok) throw Error('Unexpected geography success');
    return {status, diagnostics: result.diagnostics};
  };
  const dependencies: GeographyLoaderDependencies = {
    async locateManifest(request) {
      let registry;
      try {registry = registrySchema.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(await read(path.join(root, PRODUCTION_GEOGRAPHY_POINTER)))));}
      catch {return reject('GEOGRAPHY_METADATA', 'Production geography registry is unavailable or invalid', 'unavailable');}
      try {catalog().assertRef(request.catalogRef); catalog().assertRef(registry.catalogRef);}
      catch {return reject('GEOGRAPHY_CATALOG', 'Production metadata requires the active full catalog reference', 'stale');}
      if (request.metadataRef && canonicalStringify(request.metadataRef) !== canonicalStringify(registry.metadataRef))
        return reject('GEOGRAPHY_METADATA', 'Requested metadata is not the selected production snapshot', 'stale');
      if (registry.manifest.path !== `data/derived/geography/${registry.metadataRef.contentRoot}/manifest.json`)
        return reject('GEOGRAPHY_METADATA', 'Registry manifest is outside its metadata version', 'unavailable');
      return {status: 'available', manifest: registry.manifest};
    },
    async readArtifact(artifact) {
      if (!artifactPath.test(artifact.path)) throw Error('UNSAFE_GEOGRAPHY_PATH');
      const bytes = await read(path.join(root, artifact.path));
      if (artifact.path.endsWith('/manifest.json')) {
        const manifest = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
        const directory = artifact.path.slice(0, artifact.path.lastIndexOf('/'));
        if (manifest.metadataRef?.contentRoot !== directory.split('/').at(-1) ||
            ![`${directory}/metadata.json`, `${directory}/metadata.json.gz`].includes(manifest.metadata?.path) ||
            ![`${directory}/admission.json`, `${directory}/admission.json.gz`].includes(manifest.admission?.path))
          throw Error('GEOGRAPHY_VERSION_PATH_MISMATCH');
      }
      return bytes;
    },
    async catalogView(ref) {
      const selected = catalog(); selected.assertRef(ref);
      return {catalog: selected.worldContract(), countryIds: selected.descriptor.countryOrder,
        cells: selected.descriptor.countryOrder.flatMap(id => [...selected.loadCountry(id)]), administrativeParents: selected.administrativeParents};
    },
  };
  return (request: GeographyLoadRequest): Promise<GeographyLoadResult> => loadGeographySnapshot(request, dependencies);
}

export const loadProductionGeography = createProductionGeographyLoader();
