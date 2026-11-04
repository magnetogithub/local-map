import 'server-only';
import {gunzipSync} from 'node:zlib';
import {z} from 'zod';
import {canonicalStringify} from '../world/canonical-serializer';
import {geographyArtifactSchema, geographyCatalogRefSchema, geographyMetadataRefSchema, type GeographyArtifact} from './state-province-contract';
import {
  GEOGRAPHY_CACHE_LIMITS, geographySnapshotKey, validateGeographyAdmissionEvidence,
  validateGeographyManifest, verifyGeographyArtifact,
  type GeographyLoader, type GeographyLoaderDependencies, type GeographyLoadResult,
} from './state-province-io';
import {geographyFailure, validateGeographyMetadata, type GeographyDiagnosticCode, type GeographyResult} from './state-province-validation';
import {createGeographySnapshot} from './state-province-index.server';

const requestSchema = z.strictObject({catalogRef: geographyCatalogRefSchema, metadataRef: geographyMetadataRefSchema.nullable()});
const rejected = (result: Extract<GeographyResult<unknown>, {ok: false}>, status: 'stale' | 'unavailable' = 'unavailable'): GeographyLoadResult =>
  ({status, diagnostics: result.diagnostics});
const failure = (code: GeographyDiagnosticCode, path: string, message: string, status: 'stale' | 'unavailable' = 'unavailable') =>
  rejected(geographyFailure(code, path, message) as Extract<GeographyResult<never>, {ok: false}>, status);

/** No current pointer, builder, polygons or world state. Dependencies are a trusted artifact registry. */
export function createGeographyLoader(options: Readonly<{allowFixture?: boolean; now?: () => number}> = {}): GeographyLoader {
  type Entry = {expiresAt: number; result: Promise<GeographyLoadResult>};
  const caches = new WeakMap<GeographyLoaderDependencies, Map<string, Entry>>();
  const now = options.now ?? Date.now;
  const allowFixture = options.allowFixture === true;
  const readJson = async (dependencies: GeographyLoaderDependencies, artifact: GeographyArtifact): Promise<GeographyResult<unknown>> => {
    if (artifact.byteLength > 128 * 1024 * 1024) return geographyFailure('GEOGRAPHY_SCHEMA', artifact.path, 'Stored metadata exceeds the read limit');
    let bytes: Uint8Array;
    try {bytes = await dependencies.readArtifact(artifact);}
    catch {return geographyFailure('GEOGRAPHY_METADATA', artifact.path, 'Pinned artifact is unavailable');}
    const checked = verifyGeographyArtifact(artifact, bytes);
    if (!checked.ok) return checked;
    try {
      // Identity is over the stored bytes. Decode only after checking the pin.
      const decoded = artifact.path.endsWith('.gz') ? gunzipSync(bytes, {maxOutputLength: 128 * 1024 * 1024}) : bytes;
      return {ok: true, value: JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(decoded))};
    } catch {return geographyFailure('GEOGRAPHY_SCHEMA', artifact.path, 'Pinned artifact is not bounded UTF-8 JSON or gzip JSON');}
  };
  return async (request, dependencies) => {
    // Copy and validate before awaiting the locator; caller mutations cannot retarget this load.
    const parsed = requestSchema.safeParse(request);
    if (!parsed.success) return failure('GEOGRAPHY_SCHEMA', 'request', parsed.error.issues[0].message);
    const pinnedRequest = parsed.data;
    Object.freeze(pinnedRequest.metadataRef); Object.freeze(pinnedRequest);
    let location;
    try {location = await dependencies.locateManifest(pinnedRequest);}
    catch {return failure('GEOGRAPHY_METADATA', 'manifest', 'Metadata manifest locator is unavailable');}
    if (location.status !== 'available') return {status: location.status, diagnostics: Object.freeze([...location.diagnostics])};
    const artifact = geographyArtifactSchema.safeParse(location.manifest);
    if (!artifact.success) return failure('GEOGRAPHY_SCHEMA', 'manifest', artifact.error.issues[0].message);
    const rawManifest = await readJson(dependencies, artifact.data);
    if (!rawManifest.ok) return rejected(rawManifest);
    const validated = validateGeographyManifest(rawManifest.value, pinnedRequest, allowFixture);
    if (!validated.ok) return rejected(validated, validated.diagnostics.some(d => d.code === 'GEOGRAPHY_CATALOG' || d.code === 'GEOGRAPHY_METADATA') ? 'stale' : 'unavailable');
    const manifest = validated.value;
    // Admission bytes must be revalidated if the selected manifest changes, even for the same metadataRef.
    const key = `${geographySnapshotKey(manifest.catalogRef, manifest.metadataRef)}:${canonicalStringify(artifact.data)}`;
    let cache = caches.get(dependencies);
    if (!cache) {cache = new Map(); caches.set(dependencies, cache);}
    for (const [key, entry] of cache) if (entry.expiresAt <= now()) cache.delete(key);
    const cached = cache.get(key);
    if (cached) {cache.delete(key); cache.set(key, cached); return cached.result;}
    const load = async (): Promise<GeographyLoadResult> => {
      const rawMetadata = await readJson(dependencies, manifest.metadata);
      if (!rawMetadata.ok) return rejected(rawMetadata);
      const rawAdmission = await readJson(dependencies, manifest.admission);
      if (!rawAdmission.ok) return rejected(rawAdmission);
      const admission = validateGeographyAdmissionEvidence(rawAdmission.value, manifest);
      if (!admission.ok) return rejected(admission);
      let catalogView;
      try {catalogView = await dependencies.catalogView(manifest.catalogRef);}
      catch {return failure('GEOGRAPHY_CATALOG', 'catalogView', 'Pinned metadata-only catalog view is unavailable');}
      const metadata = validateGeographyMetadata(rawMetadata.value, {...catalogView,
        parentSources: admission.value.parentSources, sourceMemberships: admission.value.sourceMemberships,
        coverageWitnesses: admission.value.coverageWitnesses,
      }, manifest.metadataRef);
      if (!metadata.ok) return rejected(metadata, metadata.diagnostics.some(d => d.code === 'GEOGRAPHY_CATALOG') ? 'stale' : 'unavailable');
      return Object.freeze({status: 'available', snapshot: createGeographySnapshot(metadata.value)});
    };
    const entry: Entry = {expiresAt: now() + GEOGRAPHY_CACHE_LIMITS.ttlMs, result: load().catch(() =>
      failure('GEOGRAPHY_SCHEMA', 'snapshot', 'Pinned metadata or catalog admission could not be evaluated'))};
    cache.set(key, entry);
    while (cache.size > GEOGRAPHY_CACHE_LIMITS.maxEntries) cache.delete(cache.keys().next().value!);
    const result = await entry.result;
    if (cache.get(key) === entry) {
      if (result.status !== 'available') cache.delete(key);
      else entry.expiresAt = now() + GEOGRAPHY_CACHE_LIMITS.ttlMs;
    }
    return result;
  };
}

/** Production defaults reject fixture manifests. Test callers opt in on a separate loader instance. */
export const loadGeographySnapshot: GeographyLoader = createGeographyLoader();
