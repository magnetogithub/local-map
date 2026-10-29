// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import nextConfig from '../../../next.config';
import {OPERATIONAL_CATALOG_PATHS, OPERATIONAL_CATALOG_RUNTIME_PATHS, prepareOperationalCatalog} from './operational-catalog.server';
import {OPERATIONAL_CATALOG_VERSION} from './operational-catalog';

describe('current operational catalog deployment', () => {
  it('boots with only new runtime assets and rejects any attempt to read the old grid or historical reports', () => {
    const reads: string[] = [];
    const catalog = prepareOperationalCatalog(process.cwd(), file => {
      const relative = path.relative(process.cwd(), file).replaceAll('\\', '/'); reads.push(relative);
      if (!relative.startsWith('data/derived/prompt19/') && relative !== OPERATIONAL_CATALOG_RUNTIME_PATHS.current) throw Error('LEGACY_READ');
      return fs.readFileSync(file);
    });
    expect(catalog.ref.catalogVersion).toBe(OPERATIONAL_CATALOG_VERSION);
    expect(catalog.worldContract().territoryOrder).toHaveLength(catalog.descriptor.counts.cells);
    expect(catalog.loadCountry('KOR')).toHaveLength(catalog.countryDetail('KOR').cellCount);
    expect(catalog.loadCountry('PRK')).toHaveLength(catalog.countryDetail('PRK').cellCount);
    expect(reads.some(file => /detail\/|tiles\/|edge-incidence|adjacency/.test(file))).toBe(false);
  });
  it('fails closed when the current pointer or catalog index is missing/corrupted', () => {
    for (const missing of [OPERATIONAL_CATALOG_RUNTIME_PATHS.current, `${OPERATIONAL_CATALOG_PATHS.delivery}/artifact-index.json`]) {
      expect(() => prepareOperationalCatalog(process.cwd(), file => {
        if (path.relative(process.cwd(), file).replaceAll('\\', '/') === missing) throw Error('MISSING_ASSET');
        return fs.readFileSync(file);
      })).toThrow('MISSING_ASSET');
    }
    expect(() => prepareOperationalCatalog(process.cwd(), file => {
      const bytes = fs.readFileSync(file);
      return file.endsWith('artifact-index.json') ? Buffer.concat([bytes, Buffer.from('x')]) : bytes;
    })).toThrow('OPERATIONAL_ASSET_IDENTITY');
  });
  it('traces the new world without retaining any Prompt15 artifact dependency', () => {
    const includes = Object.values(nextConfig.outputFileTracingIncludes ?? {}).flat();
    expect(includes).toContain(OPERATIONAL_CATALOG_RUNTIME_PATHS.current);
    expect(includes).toContain(`${OPERATIONAL_CATALOG_PATHS.delivery}/**/*`);
    expect(includes.some(file => /data\/derived\/prompt15|56fc6c79c216e6bd1a11/.test(file))).toBe(false);
  });
});
