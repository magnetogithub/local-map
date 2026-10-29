// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {describe, expect, it} from 'vitest';
import nextConfig from '../../../next.config';
import {OPERATIONAL_CATALOG_PATHS, OPERATIONAL_CATALOG_RUNTIME_PATHS, prepareOperationalCatalog} from './operational-catalog.server';
import {OPERATIONAL_CATALOG_VERSION} from './operational-catalog';

const require = createRequire(import.meta.url);
const picomatch = require('next/dist/compiled/picomatch') as (patterns: string | string[], options: {dot: boolean; contains: boolean}) => (file: string) => boolean;
const relative = (file: string) => path.relative(process.cwd(), file).replaceAll('\\', '/');

describe('F10 operational catalog deployment inputs', () => {
  it('preserves the exact admitted bytes and their original logical verdict path', () => {
    for (const key of ['admission', 'verdict'] as const) {
      expect(fs.readFileSync(OPERATIONAL_CATALOG_RUNTIME_PATHS[key])).toEqual(fs.readFileSync(OPERATIONAL_CATALOG_PATHS[key]));
    }
    expect(fs.readFileSync(OPERATIONAL_CATALOG_RUNTIME_PATHS.deliveryIndex)).toEqual(
      fs.readFileSync(`${OPERATIONAL_CATALOG_PATHS.delivery}/artifact-index.json`));
    const admission = JSON.parse(fs.readFileSync(OPERATIONAL_CATALOG_RUNTIME_PATHS.admission, 'utf8'));
    expect(admission.authoritativeVerdict).toBe(OPERATIONAL_CATALOG_PATHS.verdict);
  });

  it('loads current catalog metadata without access to archived Prompt 15 reports', () => {
    const reads: string[] = [];
    const catalog = prepareOperationalCatalog(process.cwd(), file => {
      const rel = relative(file); reads.push(rel);
      if (rel.startsWith('reports/prompt15/')) throw Error('ARCHIVED_REPORT_NOT_DEPLOYED');
      if (rel === `${OPERATIONAL_CATALOG_PATHS.delivery}/artifact-index.json`) throw Error('SOURCE_INDEX_NOT_DEPLOYED');
      return fs.readFileSync(file);
    });
    expect(catalog.ref.catalogVersion).toBe(OPERATIONAL_CATALOG_VERSION);
    expect(catalog.descriptor.counts.cells).toBe(923443);
    expect(catalog.loadCountry('KOR')).toHaveLength(1250);
    expect(reads).toEqual(expect.arrayContaining(Object.values(OPERATIONAL_CATALOG_RUNTIME_PATHS)));
    expect(reads.some(file => file.startsWith('reports/'))).toBe(false);
  });

  it.each(['admission', 'verdict', 'deliveryIndex'] as const)('rejects missing runtime %s instead of falling back to archived reports', key => {
    expect(() => prepareOperationalCatalog(process.cwd(), file => {
      if (relative(file) === OPERATIONAL_CATALOG_RUNTIME_PATHS[key]) throw Error('RUNTIME_APPROVAL_MISSING');
      return fs.readFileSync(file);
    })).toThrow('RUNTIME_APPROVAL_MISSING');
  });

  it('rejects a different logical verdict even if a deployment copy is present', () => {
    expect(() => prepareOperationalCatalog(process.cwd(), file => {
      const bytes = fs.readFileSync(file);
      return relative(file) === OPERATIONAL_CATALOG_RUNTIME_PATHS.admission
        ? Buffer.from(JSON.stringify({...JSON.parse(bytes.toString()), authoritativeVerdict: OPERATIONAL_CATALOG_RUNTIME_PATHS.verdict})) : bytes;
    })).toThrow('OPERATIONAL_CATALOG_NOT_ADMITTED');
  });

  it('rejects changed deployment index bytes with the original admitted identity', () => {
    expect(() => prepareOperationalCatalog(process.cwd(), file => {
      const bytes = fs.readFileSync(file);
      if (relative(file) === OPERATIONAL_CATALOG_RUNTIME_PATHS.deliveryIndex) bytes[0] ^= 1;
      return bytes;
    })).toThrow('OPERATIONAL_ASSET_IDENTITY');
  });

  it('keeps mandatory JSON after includes then excludes on POSIX paths, while omitting archives', () => {
    const includes = Object.values(nextConfig.outputFileTracingIncludes ?? {}).flat();
    const excludes = Object.values(nextConfig.outputFileTracingExcludes ?? {}).flat();
    const matches = (patterns: string[], file: string) => picomatch(patterns.map(pattern => path.posix.join('/workspace', pattern)),
      {dot: true, contains: true})(path.posix.join('/workspace', file));
    const runtimeFiles = [...Object.values(OPERATIONAL_CATALOG_RUNTIME_PATHS),
      `${OPERATIONAL_CATALOG_PATHS.catalog}/artifact-index.json`, `${OPERATIONAL_CATALOG_PATHS.catalog}/countries/KOR/catalog.json.gz`,
      `${OPERATIONAL_CATALOG_PATHS.indices}/index-root.json`, `${OPERATIONAL_CATALOG_PATHS.indices}/administrative-membership.json.gz`,
      `${OPERATIONAL_CATALOG_PATHS.indices}/topology/000.json.gz`, `${OPERATIONAL_CATALOG_PATHS.delivery}/manifest.json`,
      `${OPERATIONAL_CATALOG_PATHS.delivery}/metadata/countries/KOR.json.gz`, `${OPERATIONAL_CATALOG_PATHS.delivery}/tiles/0/0/0.pbf.gz`,
      'data/raw/ne_10m_admin_1_states_provinces.geojson', 'data/source-locks/prompt14-derived-game-input-lock.json',
      'data/catalogs/prompt14/frozen-catalog-ref.json',
      'data/catalog-consumers/prompt14/catalog-v1-73e30c25c9637d6376cb65afa82483c6/consumer-approval.json',
      'public/data/territory-catalog/catalog-v1-73e30c25c9637d6376cb65afa82483c6/tiles/0/0/0.pbf'];
    for (const file of runtimeFiles) {
      expect(matches(includes, file)).toBe(true);
      expect(matches(excludes, file)).toBe(false);
    }
    for (const file of [OPERATIONAL_CATALOG_PATHS.admission, OPERATIONAL_CATALOG_PATHS.verdict,
      'reports/maintenance/private.json', 'reports/verification/probe.json', '.tmp/probe.json', 'scripts/prompt15-orchestrator/state-machine.mjs']) {
      expect(matches(excludes, file)).toBe(true);
    }
  });
});
