// @vitest-environment node
import {describe, expect, it, vi} from 'vitest';
import {gzipSync} from 'node:zlib';
import {createStateProvinceContractFixture} from '../test-only/state-province-contract-fixture';
import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from '../world/world-geometry-catalog-ref';
import {readOperationalCellState} from '../world/operational-catalog';
import {sha256Hex} from '../world/sha256';
import {countGeographyCountry, sealGeographyMetadata, type GeographyMetadata} from './state-province-contract';
import {
  GEOGRAPHY_CACHE_LIMITS, geographyArtifactBytes, geographySummarySchema, identifyGeographyArtifact,
  type GeographyLoadResult, type GeographyLoaderDependencies, type GeographyManifest,
  type GeographyReference, type GeographySnapshot,
} from './state-province-io';
import type {GeographyResult} from './state-province-validation';
import {createGeographyLoader, loadGeographySnapshot} from './state-province-loader.server';
import {readAllGeographyMembers, readGeographyCountry} from './state-province-index.server';

type Fixture = ReturnType<typeof createStateProvinceContractFixture>;
const value = <T>(result: GeographyResult<T>): T => {
  if (!result.ok) throw Error(JSON.stringify(result.diagnostics));
  return result.value;
};
const available = (result: GeographyLoadResult) => {
  if (result.status !== 'available') throw Error(JSON.stringify(result));
  return result.snapshot;
};
const reseal = (doc: GeographyMetadata) => {
  const {metadataRef, ...body} = doc; void metadataRef;
  return sealGeographyMetadata(body);
};
function harness(f = createStateProvinceContractFixture()) {
  let manifestIdentity = f.manifestIdentity;
  const dependencies: GeographyLoaderDependencies = {
    locateManifest: vi.fn(async () => ({status: 'available' as const, manifest: manifestIdentity})),
    readArtifact: vi.fn(async artifact => {
      const bytes = f.files.get(artifact.path);
      if (!bytes) throw Error('Missing fixture artifact');
      return bytes;
    }),
    catalogView: vi.fn(async () => f.context),
  };
  const publish = (metadata = f.metadata, admission = {...f.admission, metadataRef: metadata.metadataRef}, manifestPatch: Partial<GeographyManifest> = {}) => {
    const metadataBytes = geographyArtifactBytes(metadata), admissionBytes = geographyArtifactBytes(admission);
    const manifest: GeographyManifest = {...f.manifest, metadataRef: metadata.metadataRef,
      metadata: identifyGeographyArtifact(f.manifest.metadata.path, metadataBytes),
      admission: identifyGeographyArtifact(f.manifest.admission.path, admissionBytes), ...manifestPatch};
    f.files.set(manifest.metadata.path, metadataBytes); f.files.set(manifest.admission.path, admissionBytes);
    const manifestBytes = geographyArtifactBytes(manifest);
    manifestIdentity = identifyGeographyArtifact(f.manifestIdentity.path, manifestBytes);
    f.files.set(manifestIdentity.path, manifestBytes);
  };
  const request = {catalogRef: f.catalog.ref, metadataRef: null};
  const loader = createGeographyLoader({allowFixture: true});
  return {f, dependencies, publish, request, loader, load: () => loader(request, dependencies)};
}
const ref = (snapshot: GeographySnapshot, target: GeographyReference['target']): GeographyReference =>
  ({catalogRef: snapshot.catalogRef, metadataRef: snapshot.metadataRef, target});

describe('version-pinned state/province loader and read index', () => {
  it('admits pinned gzip artifacts, rejects damaged bytes before decoding and malformed gzip after hashing', async () => {
    const h = harness();
    const bytes = gzipSync(h.f.files.get(h.f.manifest.metadata.path)!);
    const compressed = identifyGeographyArtifact(h.f.manifest.metadata.path + '.gz', bytes);
    h.publish(h.f.metadata, h.f.admission, {metadata: compressed});
    h.f.files.set(compressed.path, bytes);
    expect(available(await h.load()).metadata).toEqual(h.f.metadata);
    h.f.files.set(compressed.path, bytes.subarray(1));
    const fresh = createGeographyLoader({allowFixture: true});
    expect(await fresh(h.request, h.dependencies)).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_METADATA'}]});
    const malformed = identifyGeographyArtifact(compressed.path, new Uint8Array([1, 2, 3]));
    h.publish(h.f.metadata, h.f.admission, {metadata: malformed});
    h.f.files.set(malformed.path, new Uint8Array([1, 2, 3]));
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_SCHEMA'}]});
    h.publish(h.f.metadata, h.f.admission, {metadata: {...compressed, byteLength: 128 * 1024 * 1024 + 1}});
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_SCHEMA'}]});
  });
  it('loads independent pinned artifacts and a metadata-only catalog exactly once per cached release', async () => {
    const h = harness(), snapshot = available(await h.load());
    expect(snapshot.metadata).toEqual(h.f.metadata);
    expect(snapshot).toBe(available(await h.load()));
    expect(h.dependencies.catalogView).toHaveBeenCalledTimes(1);
    const paths = vi.mocked(h.dependencies.readArtifact).mock.calls.map(([artifact]) => artifact.path);
    expect(paths).toEqual([h.f.manifestIdentity.path, h.f.manifest.metadata.path, h.f.manifest.admission.path, h.f.manifestIdentity.path]);
    expect(paths.every(path => !path.includes('geometry') && !path.includes('source.json'))).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.metadata.provinces[0].names.aliases)).toBe(true);
  });

  it('rejects fixture use by production defaults while allowing injected production manifests', async () => {
    const h = harness();
    expect(await loadGeographySnapshot(h.request, h.dependencies)).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_SOURCE'}]});
    h.publish(h.f.metadata, h.f.admission, {purpose: 'production'});
    expect((await loadGeographySnapshot(h.request, h.dependencies)).status).toBe('available');
  });

  it.each(['manifest', 'metadata', 'admission'] as const)('checks %s byte identity before admission', async part => {
    const h = harness();
    const path = part === 'manifest' ? h.f.manifestIdentity.path : h.f.manifest[part].path;
    h.f.files.set(path, new Uint8Array([...h.f.files.get(path)!, 32]));
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_METADATA', path}]});
  });

  it.each(['geometryRoot', 'topologyRoot', 'renderArtifactRoot', 'manifestPath'] as const)('rejects a different %s without falling back to latest', async field => {
    const h = harness();
    const request = {catalogRef: {...h.f.catalog.ref, [field]: field === 'manifestPath'
      ? '/data/other/synthetic-geography-v1/manifest.json' : 'f'.repeat(64)}, metadataRef: null};
    expect(await h.loader(request, h.dependencies)).toMatchObject({status: 'stale', diagnostics: [{code: 'GEOGRAPHY_CATALOG'}]});
    expect(h.dependencies.catalogView).not.toHaveBeenCalled();
  });

  it('rejects requested stale metadata, mixed admission and mismatched catalog views', async () => {
    const h = harness();
    expect(await h.loader({...h.request, metadataRef: {...h.f.metadata.metadataRef, contentRoot: 'f'.repeat(64)}}, h.dependencies))
      .toMatchObject({status: 'stale', diagnostics: [{code: 'GEOGRAPHY_METADATA'}]});
    h.publish(h.f.metadata, {...h.f.admission, metadataRef: {...h.f.metadata.metadataRef, contentRoot: 'f'.repeat(64)}});
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_METADATA'}]});
    h.publish();
    vi.mocked(h.dependencies.catalogView).mockResolvedValue({...h.f.context, catalog: {...h.f.catalog, ref: {...h.f.catalog.ref, topologyRoot: 'f'.repeat(64)}}});
    expect(await h.load()).toMatchObject({status: 'stale', diagnostics: [{code: 'GEOGRAPHY_CATALOG'}]});
  });

  it('runs semantic validation rather than trusting hashes or a warm cache with new admission', async () => {
    const h = harness();
    available(await h.load());
    h.publish(h.f.metadata, {...h.f.admission, sourceMemberships: []});
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_SOURCE'}]});
    const bad = structuredClone(h.f.metadata); bad.provinces.pop();
    h.publish(reseal(bad));
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_MEMBERSHIP'}]});
    const changed = structuredClone(h.f.metadata); changed.provinces[0].names.displayName = 'Unsealed edit';
    h.publish(changed);
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_METADATA'}]});
  });

  it('returns unavailable for missing or malformed artifacts, invalid requests and dependency errors', async () => {
    const h = harness();
    h.f.files.delete(h.f.manifest.metadata.path);
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{path: h.f.manifest.metadata.path}]});
    const bytes = new TextEncoder().encode('{invalid-json');
    h.f.files.set(h.f.manifestIdentity.path, bytes);
    vi.mocked(h.dependencies.locateManifest).mockResolvedValue({status: 'available', manifest: identifyGeographyArtifact(h.f.manifestIdentity.path, bytes)});
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{code: 'GEOGRAPHY_SCHEMA'}]});
    vi.mocked(h.dependencies.locateManifest).mockRejectedValue(Error('Private failure detail'));
    expect(await h.load()).toMatchObject({status: 'unavailable', diagnostics: [{message: 'Metadata manifest locator is unavailable'}]});
    expect(await h.loader({...h.request, metadataRef: {schemaVersion: 'geography-metadata-ref-v1', contentRoot: 'invalid'}}, h.dependencies))
      .toMatchObject({status: 'unavailable', diagnostics: [{path: 'request'}]});
  });

  it.each(['stale', 'unavailable'] as const)('preserves explicit %s locator results', async status => {
    const h = harness();
    vi.mocked(h.dependencies.locateManifest).mockResolvedValue({status, diagnostics: [{code: 'GEOGRAPHY_METADATA', path: 'registry', message: 'No compatible pinned release', remedy: 'pin-metadata'}]});
    expect(await h.load()).toMatchObject({status, diagnostics: [{path: 'registry'}]});
    expect(h.dependencies.readArtifact).not.toHaveBeenCalled();
  });

  it('looks up IDs, source countries, names and aliases while preserving ambiguity across pages', async () => {
    const h = harness(), snapshot = available(await h.load());
    const query = {sourceCountryId: null, kind: 'source-region' as const, query: '  ＳＰＲＩＮＧＦＩＥＬＤ  ', page: {offset: 0, limit: 1}};
    const result = value(snapshot.search(query));
    expect(result).toMatchObject({totalMatches: 2, ambiguous: true, truncated: true});
    expect(result.items).toHaveLength(1);
    expect(value(snapshot.search({...query, query: '스프링필드'})).items).toEqual(result.items);
    expect(value(snapshot.search({...query, sourceCountryId: h.f.metadata.countries[0].sourceCountryId}))).toMatchObject({totalMatches: 1, ambiguous: false, truncated: false});
    expect(value(snapshot.search({...query, query: 'spring'}))).toMatchObject({totalMatches: 2, ambiguous: true});
    expect(value(snapshot.search({...query, query: 'Spring-field'})).totalMatches).toBe(0);
    expect(value(snapshot.search({...query, query: ' ＯＬＤ   HARBOUR '}))).toMatchObject({totalMatches: 1, ambiguous: false});
    expect(value(snapshot.search({...query, query: 'missing'}))).toMatchObject({totalMatches: 0, truncated: false, ambiguous: false});
    const sourceRef = ref(snapshot, {kind: 'source-region', id: h.f.metadata.sourceRegions[0].sourceRegionId});
    expect(value(snapshot.inspect(sourceRef)).knownProvinceCount).toBe(2);
    const provinceRef = ref(snapshot, {kind: 'province', id: h.f.ids[2]});
    expect(value(snapshot.inspect(provinceRef))).toMatchObject({parentStatus: 'unassigned', stateId: null, precision: 'fine', geometryStatus: 'game-adjusted', materialization: {status: 'unsupported'}});
    expect(value(readGeographyCountry(snapshot, 'AAA')).counts.provinces).toBe(3);
    expect(readGeographyCountry(snapshot, 'ZZZ')).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_CATALOG'}]});
    for (const summary of value(snapshot.list({sourceCountryId: null, kind: null, page: {offset: 0, limit: 128}})).items) {
      expect(geographySummarySchema.safeParse(summary).success).toBe(true);
      expect(Object.isFrozen(summary.reference.target)).toBe(true);
      expect(summary).not.toHaveProperty('materializable');
    }
  });

  it('groups unfiltered place representations before pagination while retaining distinct source identities', async () => {
    const h = harness(), snapshot = available(await h.load());
    const search = (query: string, country: string | null, kind: 'state' | 'province' | 'source-region' | null = null, limit = 128) =>
      value(snapshot.search({query, sourceCountryId: country as never, kind, page: {offset: 0, limit}}));
    const port = search('Old Harbour', 'AAA');
    expect(port).toMatchObject({totalMatches: 1, ambiguous: false, truncated: false});
    expect(port.items[0]).toMatchObject({reference: {target: {kind: 'source-region', id: h.f.metadata.sourceRegions[1].sourceRegionId}},
      stateId: null, parentStatus: 'unassigned', knownProvinceCount: 1, coverage: {status: 'partial'}});

    // Equal names and known membership do not merge different raw places.
    const sameCountry = search('Springfield', 'AAA');
    expect(sameCountry).toMatchObject({totalMatches: 2, ambiguous: true});
    expect(sameCountry.items.map(s => s.reference.target.kind)).toEqual(['source-region', 'state']);
    expect(search('Springfield', null, null, 1)).toMatchObject({totalMatches: 3, ambiguous: true, truncated: true});
    expect(search('Springfield', 'AAA', 'source-region')).toMatchObject({totalMatches: 1, ambiguous: false});
    expect(search('Springfield', 'AAA', 'province').items.map(s => s.reference.target.id)).toEqual(h.f.ids.slice(0, 2));
    expect(search('Springfield', 'AAA', 'state').items[0].reference.target.id).toBe(h.f.stateA);
    expect(value(snapshot.members(sameCountry.items[0].reference, {offset: 0, limit: 128})).items).toEqual(h.f.ids.slice(0, 2));
  });

  it('prefers an equivalent state while leaving explicit kinds and source-free cells readable', async () => {
    const h = harness(), snapshot = available(await h.load());
    const query = {query: 'Springfield', sourceCountryId: h.f.metadata.countries[1].sourceCountryId,
      kind: null, page: {offset: 0, limit: 128}};
    const result = value(snapshot.search(query));
    expect(result).toMatchObject({totalMatches: 1, ambiguous: false});
    expect(result.items[0]).toMatchObject({reference: {target: {kind: 'state', id: h.f.stateB}}, coverage: {status: 'partial'}});
    expect(value(snapshot.search({...query, kind: 'source-region'})).items[0].reference.target.id).toBe(h.f.metadata.sourceRegions[2].sourceRegionId);
    expect(value(snapshot.search({...query, kind: 'province'})).items[0].reference.target.id).toBe(h.f.ids[3]);
    const residual = value(snapshot.search({...query, query: 'BBB fragment'}));
    expect(residual).toMatchObject({totalMatches: 1, ambiguous: false});
    expect(residual.items[0].reference.target).toEqual({kind: 'province', id: h.f.ids[4]});
  });

  it('retains a cell-specific alias when its broader source group did not match the query', async () => {
    const h = harness(), changed = structuredClone(h.f.metadata);
    changed.provinces[0].names.aliases.push({value: 'Cell-only alias', language: 'en', basis: 'verified-alias', evidence: changed.provinces[0].evidence});
    h.publish(reseal(changed));
    const snapshot = available(await h.load());
    const result = value(snapshot.search({query: 'Cell-only alias', sourceCountryId: h.f.metadata.countries[0].sourceCountryId,
      kind: null, page: {offset: 0, limit: 128}}));
    expect(result).toMatchObject({totalMatches: 1, ambiguous: false});
    expect(result.items[0].reference.target).toEqual({kind: 'province', id: h.f.ids[0]});
  });

  it('separates page completeness from partial/unsupported geography and never slices silently', async () => {
    const h = harness(), snapshot = available(await h.load());
    const partialRef = ref(snapshot, {kind: 'state', id: h.f.stateB});
    const partial = value(snapshot.members(partialRef, {offset: 0, limit: 128}));
    expect(partial).toMatchObject({totalMatches: 1, truncated: false, ambiguous: false, coverage: {status: 'partial', expectedProvinceCount: null}});
    const all = value(readAllGeographyMembers(snapshot, partialRef));
    expect(all).toMatchObject({knownMembershipComplete: true, coverage: {status: 'partial'}});
    expect(all.provinceIds).toEqual([h.f.ids[3]]);
    const source = value(snapshot.inspect(ref(snapshot, {kind: 'source-region', id: h.f.metadata.sourceRegions[2].sourceRegionId})));
    expect(source).toMatchObject({coverage: {status: 'unsupported'}, materialization: {status: 'unsupported'}});
    const first = value(snapshot.members(ref(snapshot, {kind: 'state', id: h.f.stateA}), {offset: 0, limit: 1}));
    expect(first).toMatchObject({truncated: true, coverage: {status: 'complete'}});
    expect(value(snapshot.members(first.reference, {offset: 1, limit: 1}))).toMatchObject({items: [h.f.ids[1]], truncated: true});
    expect(value(snapshot.members(first.reference, {offset: 99, limit: 1}))).toMatchObject({items: [], totalMatches: 2, truncated: true});
    expect(Object.isFrozen(first.items)).toBe(true);
  });

  it('rejects stale/unknown references and invalid pagination or country filters', async () => {
    const h = harness(), snapshot = available(await h.load());
    const reference = ref(snapshot, {kind: 'province', id: h.f.ids[0]});
    expect(snapshot.inspect({...reference, metadataRef: {...snapshot.metadataRef, contentRoot: 'f'.repeat(64)}})).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_METADATA'}]});
    expect(snapshot.inspect({...reference, catalogRef: {...snapshot.catalogRef, geometryRoot: 'f'.repeat(64)}})).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_CATALOG'}]});
    expect(snapshot.inspect(ref(snapshot, {kind: 'province', id: readCatalogTerritoryId(`territory:catalog:${'f'.repeat(64)}`)}))).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_MEMBERSHIP'}]});
    expect(snapshot.members(reference, {offset: 0, limit: 129})).toMatchObject({ok: false});
    expect(snapshot.list({sourceCountryId: null, kind: null, page: {offset: -1, limit: 128}})).toMatchObject({ok: false});
    expect(snapshot.list({sourceCountryId: 'ZZZ' as never, kind: null, page: {offset: 0, limit: 128}})).toMatchObject({ok: false, diagnostics: [{code: 'GEOGRAPHY_CATALOG'}]});
    expect(snapshot.search({sourceCountryId: null, kind: null, query: '  ', page: {offset: 0, limit: 1}})).toMatchObject({ok: false});
  });

  it('keeps prepared snapshots stable through alias updates and reads current ownership only from the supplied world', async () => {
    const h = harness(), before = available(await h.load()), beforeBytes = geographyArtifactBytes(before.metadata);
    const changed = structuredClone(h.f.metadata);
    changed.sourceRegions[0].names.aliases.push({value: 'New spelling', language: 'en', basis: 'verified-alias', evidence: changed.sourceRegions[0].evidence});
    h.publish(reseal(changed));
    const after = available(await h.load());
    expect(after.metadataRef).not.toEqual(before.metadataRef);
    const query = {sourceCountryId: null, kind: 'source-region' as const, query: 'New spelling', page: {offset: 0, limit: 128}};
    expect(value(before.search(query)).totalMatches).toBe(0);
    expect(value(after.search(query)).totalMatches).toBe(1);
    expect(after.metadata.provinces.map(p => p.provinceId)).toEqual(before.metadata.provinces.map(p => p.provinceId));
    expect(after.catalogRef).toEqual(before.catalogRef);
    expect(geographyArtifactBytes(before.metadata)).toEqual(beforeBytes);
    expect(readOperationalCellState(h.f.worldAfter, before.catalogRef, h.f.ids[0])).toMatchObject({sourceCountryId: 'AAA', ownerCountryId: 'BBB', controllerCountryId: 'BBB'});
    expect(value(before.list({sourceCountryId: h.f.metadata.countries[0].sourceCountryId, kind: 'province', page: {offset: 0, limit: 128}})).totalMatches).toBe(3);
    expect(() => readOperationalCellState({...h.f.worldAfter, catalogRef: {...before.catalogRef, topologyRoot: 'f'.repeat(64)}}, before.catalogRef, h.f.ids[0])).toThrow();
    expect(h.f.worldBefore.revision).toBe(0); expect(h.f.worldAfter.revision).toBe(1);
  });

  it('copies load requests before awaiting a changing registry and shares concurrent admission', async () => {
    const h = harness(), request = {catalogRef: {...h.f.catalog.ref}, metadataRef: {...h.f.metadata.metadataRef}};
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    vi.mocked(h.dependencies.locateManifest).mockImplementation(async pinned => {
      await gate; expect(pinned.catalogRef.geometryRoot).toBe(h.f.catalog.ref.geometryRoot);
      expect(pinned.metadataRef).toEqual(h.f.metadata.metadataRef);
      return {status: 'available', manifest: h.f.manifestIdentity};
    });
    const first = h.loader(request, h.dependencies), second = h.loader({catalogRef: h.f.catalog.ref, metadataRef: h.f.metadata.metadataRef}, h.dependencies);
    request.catalogRef.geometryRoot = 'f'.repeat(64); request.metadataRef.contentRoot = 'f'.repeat(64);
    release();
    expect(available(await first)).toBe(available(await second));
    vi.mocked(h.dependencies.locateManifest).mockResolvedValue({status: 'available', manifest: h.f.manifestIdentity});
    const [a, b] = await Promise.all([h.load(), h.load()]);
    expect(available(a)).toBe(available(b));
    expect(h.dependencies.catalogView).toHaveBeenCalledTimes(1);
  });

  it('expires and bounds release caches without invalidating retained snapshots or crossing dependency scopes', async () => {
    const h = harness(); let time = 0;
    const loader = createGeographyLoader({allowFixture: true, now: () => time});
    const first = available(await loader(h.request, h.dependencies));
    time += GEOGRAPHY_CACHE_LIMITS.ttlMs + 1;
    expect(available(await loader(h.request, h.dependencies))).not.toBe(first);
    const releases = [];
    for (let i = 0; i <= GEOGRAPHY_CACHE_LIMITS.maxEntries; i++) {
      const doc = structuredClone(h.f.metadata);
      doc.provenance.limitations.push(`Fictional release ${i}`);
      const metadata = reseal(doc); releases.push(metadata);
      h.publish(metadata); available(await loader(h.request, h.dependencies));
    }
    const calls = vi.mocked(h.dependencies.catalogView).mock.calls.length;
    h.publish(releases[0]); available(await loader(h.request, h.dependencies));
    expect(h.dependencies.catalogView).toHaveBeenCalledTimes(calls + 1);
    expect(value(first.members(ref(first, {kind: 'state', id: h.f.stateA}), {offset: 0, limit: 128})).items).toEqual(h.f.ids.slice(0, 2));
    const other = harness(); available(await loader(other.request, other.dependencies));
    expect(other.dependencies.catalogView).toHaveBeenCalledTimes(1);
  });
});

/** Expand only synthetic metadata to prove reads do not inherit the action execution cap. */
function largeFixture(): Fixture {
  const f = createStateProvinceContractFixture(), doc = structuredClone(f.metadata);
  const extra = Array.from({length: 598}, (_, i) => readCatalogTerritoryId(`territory:catalog:${sha256Hex(new TextEncoder().encode(`synthetic-large:${i}`))}`));
  for (const id of extra) doc.provinces.push({...structuredClone(doc.provinces[0]), provinceId: id});
  doc.provinces.sort((a, b) => a.provinceId < b.provinceId ? -1 : 1);
  doc.states[0].coverage.knownProvinceCount = 600; doc.states[0].coverage.expectedProvinceCount = 600;
  doc.sourceRegions[0].provinceIds.push(...extra);
  doc.sourceRegions[0].coverage.knownProvinceCount = 600; doc.sourceRegions[0].coverage.expectedProvinceCount = 600;
  doc.countries[0].counts = countGeographyCountry(doc, 'AAA');
  f.metadata = reseal(doc);
  f.catalog = createWorldGeometryCatalogContract({ref: f.catalog.ref,
    territoryOrder: doc.provinces.map(p => p.provinceId),
    territoriesById: Object.fromEntries(doc.provinces.map(p => [p.provinceId, {id: p.provinceId, sourceCountryId: p.sourceCountryId}]))});
  f.admission = {...f.admission, metadataRef: f.metadata.metadataRef,
    sourceMemberships: f.admission.sourceMemberships.map((s, i) => i === 0 ? {...s, provinceIds: doc.sourceRegions[0].provinceIds} : s),
    coverageWitnesses: f.admission.coverageWitnesses.map(w => ({...w, provinceIds: doc.sourceRegions[0].provinceIds}))};
  f.context = {...f.context, ...f.admission, catalog: f.catalog, cells: doc.provinces.map((p, i) => ({
    id: p.provinceId, ordinal: i + 1, sourceCountryId: p.sourceCountryId,
    administrativeOrdinal: p.stateId === f.stateA ? 1 : p.stateId === f.stateB ? 3 : p.sourceCountryId === 'AAA' ? 2 : 4,
    previousParentOrdinal: 1,
  }))};
  return f;
}

it('paginates all 600 known members for host reads, beyond the unchanged 512-cell action limit', async () => {
  const h = harness(largeFixture()); h.publish();
  const snapshot = available(await h.load()), reference = ref(snapshot, {kind: 'state', id: h.f.stateA});
  expect(value(snapshot.members(reference, {offset: 0, limit: 128}))).toMatchObject({totalMatches: 600, truncated: true, limit: 128});
  const all = value(readAllGeographyMembers(snapshot, reference));
  expect(all.provinceIds).toHaveLength(600);
  expect(new Set(all.provinceIds).size).toBe(600);
  expect(all).toMatchObject({knownMembershipComplete: true, coverage: {status: 'complete'}});
  expect(snapshot.members(reference, {offset: 0, limit: 600})).toMatchObject({ok: false});
});
