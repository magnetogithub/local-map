import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = JSON.parse(fs.readFileSync(
  path.join(root, "data/raw/ne_10m_admin_1_states_provinces.geojson"),
  "utf8",
));

const vertices = (value) => {
  const result = [];
  const visit = (item) => {
    if (Array.isArray(item) && item.length === 2 && item.every(Number.isFinite)) {
      result.push(item);
    } else if (Array.isArray(item)) {
      item.forEach(visit);
    }
  };
  visit(value);
  return result;
};

const features = source.features
  .filter((feature) =>
    feature.properties.adm0_a3 === "USA" &&
    feature.properties.type_en === "State" &&
    /^US-[A-Z]{2}$/.test(feature.properties.iso_3166_2)
  )
  .map((feature) => {
    const stateCode = feature.properties.iso_3166_2.slice(3);
    const points = vertices(feature.geometry.coordinates);
    const west = Math.min(...points.map(([longitude]) => longitude));
    const east = Math.max(...points.map(([longitude]) => longitude));
    const south = Math.min(...points.map(([, latitude]) => latitude));
    const north = Math.max(...points.map(([, latitude]) => latitude));
    return {
      type: "Feature",
      properties: {
        countryId: `USA-${stateCode}`,
        stateCode,
        nameKo: feature.properties.name_en,
        nameEn: feature.properties.name_en,
        mapLabelKo: feature.properties.name_en,
        parentCountryId: "USA",
        center: [(west + east) / 2, (south + north) / 2],
      },
      geometry: feature.geometry,
    };
  })
  .sort((left, right) => left.properties.countryId.localeCompare(right.properties.countryId));

if (features.length !== 50) {
  throw new Error(`Expected 50 US state polygons, got ${features.length}`);
}

const output = {
  type: "FeatureCollection",
  scenario: "usa-50-states-test-v1",
  rollbackCountryId: "USA",
  features,
};

fs.writeFileSync(
  path.join(root, "public/data/maps/usa-state-countries-test.geojson"),
  JSON.stringify(output),
);
console.log(JSON.stringify({scenario: output.scenario, countries: features.length}));
