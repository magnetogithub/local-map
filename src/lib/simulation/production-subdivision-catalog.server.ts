import fs from "node:fs";
import path from "node:path";

import {
  createProductionSubdivisionCatalog,
  type ProductionSubdivisionAsset,
  type SerializedProductionSubdivisionCatalog,
} from "./subdivision-catalog";

const readAsset = (file: string): ProductionSubdivisionAsset =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), "public", "data", "simulation", file), "utf8")) as ProductionSubdivisionAsset;

export function loadProductionSubdivisionCatalog(): SerializedProductionSubdivisionCatalog {
  const serialized = Object.freeze({
    catalogVersion: "production-subdivision-catalog.v1" as const,
    assets: Object.freeze([
      readAsset("china-admin1-v1.geojson"),
      readAsset("usa-admin1-v1.geojson"),
    ]),
  });
  createProductionSubdivisionCatalog(serialized);
  return serialized;
}
