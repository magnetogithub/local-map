import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

const root = path.join(process.cwd(), "src");
const seedMetadataModules = new Set([
  "src/lib/world/initial-world-state-v2.ts",
  "src/lib/country/country-index.ts", // Unused legacy lookup; importing it in runtime is forbidden.
]);
const labelSeedUrls = new Set([
  "/data/maps/country-labels-2020.geojson",
  "/data/maps/country-label-glyph-fills-2020.geojson",
  "/data/maps/country-label-glyph-outlines-2020.geojson",
]);

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    if (entry.name === "test-only" || entry.name === "__tests__") return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(file);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)
      ? [file] : [];
  });
}

const importSpecifiers = (source: string) => [
  ...source.matchAll(/(?:from\s*|import\s*\(|import\s*|require\s*\()["']([^"']+)["']/g),
].map((match) => match[1]);

function violations(file: string, source: string): string[] {
  const issues: string[] = [];
  for (const specifier of importSpecifiers(source)) {
    if (specifier.endsWith("/countries-2020.json") && !seedMetadataModules.has(file)) {
      issues.push("static country metadata import");
    }
    if (/(?:^|\/)country-index$/.test(specifier)) issues.push("static country lookup import");
    if (specifier.includes("legacy-v1") || /(?:^|\/)(?:world-state|initial-world-state)$/.test(specifier)) {
      issues.push("V1 WorldState import");
    }
  }

  const runtimeUrls = [...source.matchAll(/["'](\/data\/maps\/[^"']+)["']/g)].map((match) => match[1]);
  for (const url of runtimeUrls) {
    if (/^\/data\/maps\/countries-.*\.geojson$/.test(url)) {
      issues.push("static country geometry URL");
    }
    if (url === "/data/maps/capitals-2020.geojson") {
      issues.push("static capital URL");
    }
    if (url.startsWith("/data/maps/country-label") && url.endsWith(".geojson")) {
      const isProjectionSeed = file === "src/components/map/WorldMap.tsx" &&
        labelSeedUrls.has(url) && source.includes("projectLabelMapSources(") &&
        source.includes("setSourceData(S.labels,sources.placements)") &&
        source.includes("setSourceData(S.glyphLabelFills,sources.fills)") &&
        source.includes("setSourceData(S.glyphLabelOutlines,sources.outlines)");
      if (!isProjectionSeed) issues.push("static label URL outside projection seed cache");
    }
  }
  if (/setSourceData\(S\.(?:labels|glyphLabelFills|glyphLabelOutlines|capitals),\s*(?:labelSeedCache|seed)\b/.test(source)) {
    issues.push("static label or capital data applied directly to MapLibre");
  }
  return issues;
}

describe("11-13 static runtime source guard", () => {
  it("rejects representative forbidden imports and direct static GeoJSON paths", () => {
    const samples = [
      'import countries from "@/data/countries-2020.json";',
      'import {countryById} from "@/lib/country/country-index";',
      'import type {WorldState} from "@/lib/world/world-state";',
      'await fetch("/data/maps/countries-10m.geojson");',
      'await fetch("/data/maps/capitals-2020.geojson");',
      'await fetch("/data/maps/country-labels-2020.geojson");',
    ];
    for (const sample of samples) {
      expect(violations("src/components/map/Sample.tsx", sample), sample).not.toEqual([]);
    }
  });

  it("keeps the existing seed exceptions narrow", () => {
    expect(violations("src/lib/world/initial-world-state-v2.ts", 'import data from "@/data/countries-2020.json";')).toEqual([]);
    expect(violations("src/components/map/WorldMap.tsx", 'setSourceData(S.labels,labelSeedCache.placements)')).not.toEqual([]);
  });

  it("finds no forbidden source in production files", () => {
    const findings = productionFiles(root).flatMap((absolute) => {
      const file = path.relative(process.cwd(), absolute).replaceAll("\\", "/");
      return violations(file, fs.readFileSync(absolute, "utf8")).map((issue) => `${file}: ${issue}`);
    });
    expect(findings).toEqual([]);
  });
});
