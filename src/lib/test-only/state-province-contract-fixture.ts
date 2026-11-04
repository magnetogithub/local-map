import {createWorldGeometryCatalogContract, readCatalogTerritoryId} from '../world/world-geometry-catalog-ref';
import {readWorldV3CountryId} from '../world/world-v3-validation';
import {createTerritoryEntityV3} from '../world/territory-entity-v3';
import type {OperationalAdministrativeParent, OperationalCell} from '../world/operational-catalog';
import {
  GEOGRAPHY_SCHEMA_VERSION, countGeographyCountry, createSourceRegionId, sealGeographyMetadata, stateIdSchema,
  type GeographyCoverage, type GeographyMetadataBody, type GeographyNames, type GeographyProvince, type GeographySource,
} from '../geography/state-province-contract';
import {geographyArtifactBytes, identifyGeographyArtifact, type GeographyAdmissionEvidence, type GeographyManifest} from '../geography/state-province-io';
import type {GeographyAdmissionContext} from '../geography/state-province-validation';

/** Fictional in-memory inputs only. These are neither adopted country data nor source locks. */
export function createStateProvinceContractFixture() {
  const sourceBytes = geographyArtifactBytes({fixture: true, source: 'fictional names and membership, no geometry'});
  const sourceArtifact = identifyGeographyArtifact('fixtures/geography/source.json', sourceBytes);
  const codeBytes = geographyArtifactBytes({fixture: true, generator: 'contract fixture v1'});
  const codeArtifact = identifyGeographyArtifact('fixtures/geography/code.json', codeBytes);
  const evidence = [{artifact: sourceArtifact, locator: 'fictional-crosswalk', method: 'synthetic-fixture-only'}];
  const source = (sourceId: string, sourceFeatureId: string): GeographySource => ({sourceId, sourceFeatureId,
    sourceVersion: 'fixture-v1', artifact: sourceArtifact, temporalStatus: 'unknown', temporalNotes: ['Fictional source; no historical claim']});
  const macroA = source('fixture-macros', 'AAA-east'), macroB = source('fixture-macros', 'BBB-east');
  const cityA = source('fixture-children', 'AAA-city'), unknownA = source('fixture-children', 'AAA-port');
  const names = (value: string, derived = false): GeographyNames => ({
    displayName: value, displayBasis: derived ? 'derived' : 'source', displayEvidence: evidence,
    sourceName: derived ? null : {value, basis: 'source', evidence},
    nameKo: null, nameEn: derived ? null : {value, basis: 'source', evidence},
    aliases: derived ? [] : [{value: value === 'Springfield' ? '스프링필드' : 'Old Harbour', language: value === 'Springfield' ? 'ko' : 'en', basis: 'verified-alias', evidence}],
  });
  const coverage = (status: GeographyCoverage['status'], known: number): GeographyCoverage => ({
    status, knownProvinceCount: known, expectedProvinceCount: status === 'complete' ? known : null,
    evidence: status === 'unsupported' ? [] : evidence,
    limitations: status === 'complete' ? [] : ['Only the known game membership is supported; geographic total unknown'],
  });
  const ids = ['1', '2', '3', '4', '5'].map(n => readCatalogTerritoryId(`territory:catalog:${n.repeat(64)}`));
  const stateA = stateIdSchema.parse('fine-macro:AAA:fixture-east'), stateB = stateIdSchema.parse('coarse:BBB:fixture-east');
  const catalog = createWorldGeometryCatalogContract({
    ref: {catalogVersion: 'synthetic-geography-v1', geometryRoot: '1'.repeat(64), topologyRoot: '2'.repeat(64), renderArtifactRoot: '3'.repeat(64), manifestPath: '/data/catalogs/synthetic-geography-v1/manifest.json'},
    territoryOrder: ids, territoriesById: Object.fromEntries(ids.map((id, i) => [id, {id, sourceCountryId: i < 3 ? 'AAA' : 'BBB'}])),
  });
  const administrativeParents: OperationalAdministrativeParent[] = [
    {ordinal: 1, parentKey: stateA, sourceCountryId: 'AAA', kind: 'administrative', adminId: stateA, name: 'Springfield', sourceFeatureId: 'runtime:AAA-east', sourceVersion: 'fixture-v1', restorationId: null, residualId: null, start: 0, count: 2},
    {ordinal: 2, parentKey: 'fine-macro-residual:AAA', sourceCountryId: 'AAA', kind: 'country-envelope-residual', adminId: null, name: null, sourceFeatureId: null, sourceVersion: null, restorationId: null, residualId: 'AAA-unknown', start: 2, count: 1},
    {ordinal: 3, parentKey: stateB, sourceCountryId: 'BBB', kind: 'administrative', adminId: stateB, name: 'Springfield', sourceFeatureId: 'BBB-east', sourceVersion: 'fixture-v1', restorationId: 'BBB-east', residualId: null, start: 3, count: 1},
    {ordinal: 4, parentKey: 'coarse-residual:BBB', sourceCountryId: 'BBB', kind: 'country-envelope-residual', adminId: null, name: null, sourceFeatureId: null, sourceVersion: null, restorationId: null, residualId: 'BBB-residual', start: 4, count: 1},
  ];
  const cells: OperationalCell[] = ids.map((id, i) => ({id, ordinal: i + 1, sourceCountryId: readWorldV3CountryId(i < 3 ? 'AAA' : 'BBB', 'fixture'), administrativeOrdinal: [1, 1, 2, 3, 4][i], previousParentOrdinal: i + 1}));
  const provinces: GeographyProvince[] = cells.map((cell, i) => ({
    kind: 'province', provinceId: cell.id, sourceCountryId: cell.sourceCountryId,
    names: names(i < 2 || i === 3 ? 'Springfield' : i === 2 ? 'Old Port' : 'BBB fragment 55555555', i === 4),
    precision: i < 3 ? 'fine' : i === 3 ? 'coarse' : 'residual',
    geometryStatus: i === 4 ? 'source-free' : i === 2 ? 'game-adjusted' : 'source-exact',
    sources: i === 4 ? [] : [i < 2 ? cityA : i === 2 ? unknownA : macroB], evidence, parentEvidence: evidence,
    ...(i < 2 || i === 3 ? {parentStatus: 'verified' as const, stateId: i < 2 ? stateA : stateB, unassignedReason: null}
      : {parentStatus: 'unassigned' as const, stateId: null, unassignedReason: 'No verified source parent; retain residual membership'}),
  }));
  const sourceRegions = [
    {country: 'AAA', source: cityA, name: 'Springfield', ids: ids.slice(0, 2), status: 'complete' as const},
    {country: 'AAA', source: unknownA, name: 'Old Port', ids: ids.slice(2, 3), status: 'partial' as const},
    {country: 'BBB', source: macroB, name: 'Springfield', ids: ids.slice(3, 4), status: 'unsupported' as const},
  ].map(r => ({kind: 'source-region' as const, sourceRegionId: createSourceRegionId(r.country, r.source.sourceId, r.source.sourceFeatureId),
    sourceCountryId: readWorldV3CountryId(r.country, 'fixture'), source: r.source, names: names(r.name), provinceIds: r.ids, coverage: coverage(r.status, r.ids.length), evidence}));
  const body: GeographyMetadataBody = {
    schemaVersion: GEOGRAPHY_SCHEMA_VERSION, catalogRef: catalog.ref,
    provenance: {scenarioDate: '2020-01-01', method: 'Synthetic contract fixture; no producer or country adoption', inputs: [sourceArtifact], code: [codeArtifact], limitations: ['Fictional fixture only']},
    states: [
      {kind: 'state', stateId: stateA, catalogParentKey: stateA, sourceCountryId: cells[0].sourceCountryId, source: macroA, names: names('Springfield'), coverage: coverage('complete', 2), evidence},
      {kind: 'state', stateId: stateB, catalogParentKey: stateB, sourceCountryId: cells[3].sourceCountryId, source: macroB, names: names('Springfield'), coverage: coverage('partial', 1), evidence},
    ], provinces, sourceRegions, countries: [],
  };
  body.countries = ['AAA', 'BBB'].map(country => ({sourceCountryId: readWorldV3CountryId(country, 'fixture'), counts: countGeographyCountry(body, country),
    sourceFeatureCount: country === 'AAA' ? 3 : null, officialSubdivisionCount: null,
    sourceFeatureCountEvidence: country === 'AAA' ? evidence : [], officialSubdivisionCountEvidence: [],
    nameSupport: 'source-and-derived', parentSupport: 'partial'}));
  const metadata = sealGeographyMetadata(body);
  const admission: GeographyAdmissionEvidence = {
    schemaVersion: 'geography-admission-v1', catalogRef: catalog.ref, metadataRef: metadata.metadataRef,
    parentSources: [{parentKey: stateA, source: macroA}, {parentKey: stateB, source: macroB}],
    sourceMemberships: sourceRegions.map(r => ({sourceCountryId: r.sourceCountryId, source: r.source, provinceIds: r.provinceIds})),
    coverageWitnesses: [
      {target: {kind: 'state', id: stateA}, provinceIds: ids.slice(0, 2), evidence},
      {target: {kind: 'source-region', id: sourceRegions[0].sourceRegionId}, provinceIds: ids.slice(0, 2), evidence},
    ],
  };
  const context: GeographyAdmissionContext = {catalog, countryIds: ['AAA', 'BBB'], cells, administrativeParents, ...admission};
  const metadataBytes = geographyArtifactBytes(metadata), admissionBytes = geographyArtifactBytes(admission);
  const manifest: GeographyManifest = {schemaVersion: 'state-province-manifest-v1', purpose: 'fixture', catalogRef: catalog.ref, metadataRef: metadata.metadataRef,
    metadata: identifyGeographyArtifact('fixtures/geography/metadata.json', metadataBytes), admission: identifyGeographyArtifact('fixtures/geography/admission.json', admissionBytes)};
  const manifestBytes = geographyArtifactBytes(manifest), manifestIdentity = identifyGeographyArtifact('fixtures/geography/manifest.json', manifestBytes);
  const files = new Map([[sourceArtifact.path, sourceBytes], [codeArtifact.path, codeBytes], [manifest.metadata.path, metadataBytes], [manifest.admission.path, admissionBytes], [manifestIdentity.path, manifestBytes]]);
  const worldBefore = {catalogRef: catalog.ref, revision: 0, territoriesById: Object.fromEntries(cells.map(c => [c.id, createTerritoryEntityV3({id: c.id, sourceCountryId: c.sourceCountryId, ownerCountryId: c.sourceCountryId, controllerCountryId: c.sourceCountryId})]))};
  const worldAfter = {...worldBefore, revision: 1, territoriesById: {...worldBefore.territoriesById,
    [ids[0]]: createTerritoryEntityV3({...worldBefore.territoriesById[ids[0]], ownerCountryId: 'BBB', controllerCountryId: 'BBB'})}};
  return {metadata, admission, context, catalog, manifest, manifestIdentity, files, ids, stateA, stateB, worldBefore, worldAfter};
}
