// @vitest-environment node
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {prepareOperationalCatalog, OPERATIONAL_CATALOG_PATHS, OPERATIONAL_CATALOG_RUNTIME_PATHS} from './operational-catalog.server';
import {OPERATIONAL_CATALOG_VERSION} from './operational-catalog';
import {inheritOperationalSeedTerritories} from './operational-game.server';
import {createTerritoryEntityV3} from './territory-entity-v3';

const id = (digit: string) => `territory:catalog:${digit.repeat(64)}`;
const encode = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Three interleaved fine cells inherit two different coarse parents. No disk writes. */
function fixture(changeParents?: (parents: {administrative: Record<string, unknown>[]; previous: Record<string, unknown>[]}) => void) {
  const assets = new Map<string, Buffer>(), territoryOrder = [id('1'), id('2'), id('3')];
  const pin = (file: string, value: unknown) => {
    const raw = encode(value), bytes = file.endsWith('.gz') ? gzipSync(raw) : raw;
    assets.set(`${OPERATIONAL_CATALOG_PATHS.delivery}/${file}`, bytes);
    return {path: file, sha256: sha(bytes), byteLength: bytes.length};
  };
  const parents = {
    administrative: [1, 2].map(n => ({parentKey: `coarse:KOR:parent-${n}`, sourceCountryId: 'KOR', kind: 'administrative',
      adminId: String(n), name: `Parent ${n}`, sourceFeatureId: String(n), sourceVersion: 'fixture', restorationId: String(n), residualId: null,
      start: n === 1 ? 0 : 1, count: 1})),
    previous: [1, 2].map(n => ({oldTerritoryId: id(String(n + 6)), sourceCountryId: 'KOR', start: n === 1 ? 0 : 1, count: 1})),
  };
  changeParents?.(parents);
  const metadata = pin('metadata/countries/KOR.json.gz', {countryId: 'KOR', columns: ['cellOrdinal', 'cellId', 'administrativeOrdinal', 'previousParentOrdinal'],
    rows: [[1, territoryOrder[0], 1, 1], [2, territoryOrder[1], 2, 2], [3, territoryOrder[2], 1, 1]]});
  const detail = pin('detail/countries/KOR.geojson.gz', {type: 'FeatureCollection', features: []});
  pin('metadata/parents.json.gz', parents);
  const ref = {catalogVersion: OPERATIONAL_CATALOG_VERSION, geometryRoot: 'a'.repeat(64), topologyRoot: 'b'.repeat(64), renderArtifactRoot: 'c'.repeat(64),
    manifestPath: `/data/territory-catalog/${OPERATIONAL_CATALOG_VERSION}/manifest.json`};
  pin('catalog.json', {schemaVersion: 'operational-catalog-v1', catalogRef: ref,
    indexRoots: {catalogOrder: sha(encode(territoryOrder)), administrativeMembership: 'd'.repeat(64), previousParent: 'e'.repeat(64)},
    counts: {countries: 1, cells: 3, edges: 1, administrativeParents: 2, previousParents: 2}, countryOrder: ['KOR']});
  pin('detail-index.json', {schemaVersion: 'operational-world-delivery-v2', ref, countries: [{countryId: 'KOR', cellCount: 3, metadata, detail}], edgeDetails: []});
  const artifacts = [...assets].map(([file, bytes]) => ({path: file.slice(OPERATIONAL_CATALOG_PATHS.delivery.length + 1), sha256: sha(bytes), byteLength: bytes.length}));
  const index = pin('artifact-index.json', {schemaVersion: 'operational-world-delivery-v2', artifacts});
  assets.set(OPERATIONAL_CATALOG_RUNTIME_PATHS.current, encode({catalogVersion: OPERATIONAL_CATALOG_VERSION, root: OPERATIONAL_CATALOG_PATHS.delivery, index}));
  return prepareOperationalCatalog(process.cwd(), file => {
    const bytes = assets.get(path.relative(process.cwd(), file).replaceAll('\\', '/'));
    if (!bytes) throw Error(`UNEXPECTED_FIXTURE_READ: ${file}`); return bytes;
  });
}

describe('mixed operational catalog membership and seed lineage', () => {
  it('resolves interleaved administrative and previous members independently of interval hints', () => {
    const catalog = fixture(parents => {parents.administrative[0].count = 999; parents.previous[0].start = 99;});
    expect(catalog.administrativeMembership('coarse:KOR:parent-1').map(c => c.ordinal)).toEqual([1, 3]);
    expect(catalog.previousMembership(id('7')).map(c => c.ordinal)).toEqual([1, 3]);
    expect(catalog.administrativeMembership('coarse:KOR:parent-2').map(c => c.ordinal)).toEqual([2]);
    expect(catalog.worldContract().territoryOrder).toEqual([id('1'), id('2'), id('3')]);
  });

  it('inherits owner/controller through the coarse previous parent while keeping each new ID', () => {
    const catalog = fixture(), first = createTerritoryEntityV3({id: id('7'), sourceCountryId: 'KOR', ownerCountryId: 'KOR', controllerCountryId: 'PRK'});
    const second = createTerritoryEntityV3({id: id('8'), sourceCountryId: 'KOR', ownerCountryId: null, controllerCountryId: null});
    const source = {territoriesById: {[first.id]: first, [second.id]: second}}, inherited = inheritOperationalSeedTerritories(source, catalog);
    expect(Object.keys(inherited)).toEqual([id('1'), id('2'), id('3')]);
    expect(inherited[id('1')]).toEqual({...first, id: id('1')});
    expect(inherited[id('3')]).toEqual({...first, id: id('3')});
    expect(inherited[id('2')]).toEqual({...second, id: id('2')});
    expect(inherited[id('1')]).not.toBe(first);
    expect(Object.isFrozen(inherited)).toBe(true);
    expect(source.territoriesById[first.id]).toBe(first);
  });

  it('rejects missing or wrong-country coarse seed lineage before creating a game', () => {
    const catalog = fixture();
    expect(() => inheritOperationalSeedTerritories({territoriesById: {}}, catalog)).toThrow('OPERATIONAL_SEED_SOURCE_MISMATCH');
    const wrong = createTerritoryEntityV3({id: id('7'), sourceCountryId: 'PRK', ownerCountryId: 'PRK', controllerCountryId: 'PRK'});
    expect(() => inheritOperationalSeedTerritories({territoriesById: {[wrong.id]: wrong}}, catalog)).toThrow('OPERATIONAL_SEED_SOURCE_MISMATCH');
  });

  it('rejects duplicate parent identities rather than silently replacing their memberships', () => {
    expect(() => fixture(parents => {parents.administrative[1].parentKey = parents.administrative[0].parentKey;})).toThrow('OPERATIONAL_PARENT_MAPPING');
    expect(() => fixture(parents => {parents.previous[1].oldTerritoryId = parents.previous[0].oldTerritoryId;})).toThrow('OPERATIONAL_PARENT_MAPPING');
  });
});
