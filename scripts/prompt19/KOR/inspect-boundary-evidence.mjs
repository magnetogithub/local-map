// Local source evidence for C; never assigns a source feature or changes the pinned outline.
import fs from 'node:fs';
import polygonClipping from 'polygon-clipping';
import {geometryMetadata, normalizeGeometry, polygons} from '../../prompt14-catalog-core.mjs';

const source = JSON.parse(fs.readFileSync('data/raw/prompt19/KOR/normalized-boundaries.geojson'));
const parents = JSON.parse(fs.readFileSync('data/derived/prompt19/baseline-v1/coarse-parents.geojson')).features.filter(f => f.properties.countryId === 'KOR');
const island = parents.find(p => p.properties.kind === 'country-envelope-residual'), islandMetrics = geometryMetadata(island.geometry);
const contacts = [], holeSources = [];
for (const f of source.features) {
  const m = geometryMetadata(normalizeGeometry(f.geometry));
  if (m.holes) holeSources.push({sourceFeatureId: f.properties.sourceFeatureId, name: f.properties.name, holes: m.holes});
  if (m.bbox[2] < islandMetrics.bbox[0] || m.bbox[0] > islandMetrics.bbox[2] || m.bbox[3] < islandMetrics.bbox[1] || m.bbox[1] > islandMetrics.bbox[3]) continue;
  const coordinates = polygonClipping.intersection(polygons(f.geometry), polygons(island.geometry));
  if (coordinates.length) contacts.push({sourceFeatureId: f.properties.sourceFeatureId, name: f.properties.name,
    intersectionAreaDegrees2: geometryMetadata(normalizeGeometry({type: 'MultiPolygon', coordinates})).area});
}
const report = {stage: '19-02A', countryId: 'KOR', detachedCoarseIsland: {coarseTerritoryId: island.properties.coarseTerritoryId,
  parentKey: island.properties.parentKey, bbox: islandMetrics.bbox, areaDegrees2: islandMetrics.area, actualSourceIntersections: contacts,
  assignmentPerformed: false}, originalSourceHoleFeatures: holeSources,
  sharedBorderPolicy: 'The three pinned KOR/PRK chains remain unchanged. Intersection/coverage evidence does not grant A authority to move or fill the country outline.'};
fs.mkdirSync('reports/verification/prompt19/KOR', {recursive: true});
fs.writeFileSync('reports/verification/prompt19/KOR/boundary-evidence.json', JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
console.log(JSON.stringify(report));
