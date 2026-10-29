// Independent real-source precision evidence. No candidate cells/IDs or ownership are produced.
import fs from 'node:fs';
import polygonClipping from 'polygon-clipping';
import {geometryMetadata, normalizeGeometry, polygons} from '../../prompt14-catalog-core.mjs';

const source = JSON.parse(fs.readFileSync('data/raw/prompt19/KOR/normalized-boundaries.geojson'));
const parents = JSON.parse(fs.readFileSync('data/derived/prompt19/baseline-v1/coarse-parents.geojson')).features.filter(f => f.properties.countryId === 'KOR');
const prepared = source.features.map(f => ({feature: f, bbox: geometryMetadata(normalizeGeometry(f.geometry)).bbox}));
const results = [];
for (const parent of parents) {
  const box = geometryMetadata(parent.geometry).bbox, sources = [], errors = [];
  for (const {feature, bbox} of prepared) {
    if (bbox[2] < box[0] || bbox[0] > box[2] || bbox[3] < box[1] || bbox[1] > box[3]) continue;
    try {
      const intersection = polygonClipping.intersection(polygons(feature.geometry), polygons(parent.geometry));
      if (intersection.length) {
        const metrics = geometryMetadata(normalizeGeometry({type: 'MultiPolygon', coordinates: intersection}));
        if (metrics.area > 0) sources.push({sourceFeatureId: feature.properties.sourceFeatureId, name: feature.properties.name, intersectingAreaDegrees2: metrics.area});
      }
    } catch (error) {errors.push({sourceFeatureId: feature.properties.sourceFeatureId, error: error.message});}
  }
  results.push({coarseTerritoryId: parent.properties.coarseTerritoryId, parentKey: parent.properties.parentKey,
    name: parent.properties.name, kind: parent.properties.kind, distinctRealSourceFeatures: sources.length, sources, errors});
}
const report = {stage: '19-02A', countryId: 'KOR', method: 'Positive-area exact source/coarse-parent intersections, bbox-pruned; diagnostic only, no centroid assignment or final membership.',
  everyAdministrativeParentHasMultipleRealSourceFeatures: results.filter(p => p.kind === 'administrative').every(p => p.distinctRealSourceFeatures > 1 && p.errors.length === 0),
  errors: results.reduce((n, p) => n + p.errors.length, 0), parents: results,
  doesNotCertify: ['Complete source/P0 coverage', 'Final fine cell validity/topology', 'Shared border alignment', 'Actual gameplay']};
fs.writeFileSync('reports/verification/prompt19/KOR/parent-precision.json', JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify({...report, parents: results.map(({name, distinctRealSourceFeatures, errors}) => ({name, distinctRealSourceFeatures, errors: errors.length}))}));
