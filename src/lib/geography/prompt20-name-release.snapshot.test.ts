// @vitest-environment node
import fs from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {expect, it} from 'vitest';
import previousRelease from '../../../reports/maintenance/prompt20-03-metadata.json';
import namedRelease from '../../../reports/maintenance/prompt20-04-names.json';
import {verifyGeographyArtifact, type GeographyManifest} from './state-province-io';
import type {GeographyMetadata} from './state-province-contract';

// Deliberately frozen historical releases, independent of either active registry.
// Their pins and small-cell-merge examples must never define the live catalog's expected counts.
it('preserves identity across the pinned 20-03/20-04 name releases and their post-merge fixture', () => {
  const load = (pin: {path: string; sha256: string; byteLength: number}) => {
    const bytes = fs.readFileSync(pin.path); expect(verifyGeographyArtifact(pin, bytes).ok).toBe(true);
    const manifest: GeographyManifest = JSON.parse(bytes.toString('utf8'));
    const stored = fs.readFileSync(manifest.metadata.path); expect(verifyGeographyArtifact(manifest.metadata, stored).ok).toBe(true);
    return JSON.parse(gunzipSync(stored).toString('utf8')) as GeographyMetadata;
  };
  const previous = load(previousRelease.manifest), current = load(namedRelease.manifest);
  expect(previous.metadataRef).not.toEqual(current.metadataRef); expect(previous.catalogRef).toEqual(current.catalogRef);
  const identities = (metadata: GeographyMetadata) => ({
    states: metadata.states.map(s => [s.stateId, s.sourceCountryId, s.catalogParentKey, s.source, s.coverage]),
    provinces: metadata.provinces.map(p => [p.provinceId, p.sourceCountryId, p.stateId, p.parentStatus, p.precision, p.geometryStatus, p.sources]),
    sourceRegions: metadata.sourceRegions.map(s => [s.sourceRegionId, s.sourceCountryId, s.source, s.provinceIds, s.coverage]),
  });
  expect(identities(previous)).toEqual(identities(current));
  expect(previous.sourceRegions.some(s => s.names.aliases.some(a => a.value === '청진'))).toBe(false);
  expect(current.sourceRegions.some(s => s.names.aliases.some(a => a.value === '청진'))).toBe(true);
  const ids = new Set(current.provinces.map(p => p.provinceId as string));
  expect(ids.has('territory:catalog:931baa0ac0bdd543e1b491cf6515c1e8cb37fedaf6191ab993d16b49f5e29e8a')).toBe(true);
  expect(ids.has('territory:catalog:0719d07c04a63bb0c1dd4d7fe26bccc8972a767facb8d9ef02552dd4dacb99a3')).toBe(false);
});
