// @vitest-environment node
import {expect, it} from 'vitest';
import {GET} from './route';
import {POST} from '../../regions/route';
import {loadCatalogRegionIndex} from '@/lib/simulation/catalog-region.server';
import {loadOperationalCatalog} from '@/lib/world/operational-catalog.server';

const request = (body: unknown) => POST(new Request('http://localhost/api/world/regions', {method: 'POST', body: JSON.stringify(body)}));

it('serves coarse metadata and full source membership with catalog identity checks', async () => {
  const metadata = await GET();
  expect(metadata.status).toBe(200);
  const {catalogRef, schemaVersion} = await metadata.json();
  expect(schemaVersion).toBe('operational-catalog-v1');
  expect(catalogRef).toEqual(loadOperationalCatalog().ref);
  const query = {catalogRef, countryId: 'CHN', operation: 'occupy', query: 'Guangdong'};
  const found = await request(query), result = await found.json();
  expect(found.status).toBe(200); expect(result.ok).toBe(true);
  const body = {catalogRef, countryId: 'CHN', operation: 'occupy', reference: result.region.ref};
  const membership = await request({...body, mode: 'membership'}), full = await membership.json();
  expect(membership.status).toBe(200); expect(full.region.territoryIds).toHaveLength(1);
  const action = await request(body);
  expect(action.status).toBe(200);
  const wrongRoot = await request({...body, catalogRef: {...catalogRef, geometryRoot: '0'.repeat(64)}});
  expect(wrongRoot.status).toBe(400);
  const wrongCountry = await request({...body, countryId: 'KOR', mode: 'membership'});
  expect(wrongCountry.status).toBe(400); expect(await wrongCountry.json()).toMatchObject({code: 'REGION_COUNTRY_SCOPE'});
  const list = await request({catalogRef, countryId: 'SVN', operation: 'occupy', limit: 128});
  expect(await list.json()).toMatchObject({ok: true, clipped: false});
});

it('continues serving region queries for the current v1 world', async () => {
  const index = loadCatalogRegionIndex();
  const response = await request({catalogRef: index.catalogRef, countryId: 'CHN', operation: 'occupy', query: 'Guangdong'});
  expect(response.status).toBe(200);
  const {region} = await response.json();
  expect(region.ref).toEqual(index.search('CHN', 'Guangdong')[0].ref);
});
