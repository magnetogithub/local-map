import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const targets = [
  ["public/data/maps/china-province-countries-test.geojson", "public/data/simulation/china-admin1-v1.geojson", "china-admin1-v1", "CHN", 31],
  ["public/data/maps/usa-state-countries-test.geojson", "public/data/simulation/usa-admin1-v1.geojson", "usa-admin1-v1", "USA", 50],
];
fs.mkdirSync(path.join(root, "public/data/simulation"), {recursive: true});
for (const [sourcePath, targetPath, scenario, countryId, expectedCount] of targets) {
  const source = JSON.parse(fs.readFileSync(path.join(root, sourcePath), "utf8"));
  if (source.features?.length !== expectedCount || source.rollbackCountryId !== countryId) {
    throw new Error(`Invalid source boundary set for ${countryId}`);
  }
  const output = {...source, scenario};
  fs.writeFileSync(path.join(root, targetPath), JSON.stringify(output));
}
console.log(JSON.stringify({status: "PASS", countries: 2, subdivisions: 81}));
