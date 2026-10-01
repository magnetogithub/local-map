import fs from "node:fs";
import path from "node:path";
import {describe, expect, it} from "vitest";

const sourceRoot = path.join(process.cwd(), "src");

function productionFiles(directory: string): string[] {
  return fs.readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    if (entry.name === "test-only" || entry.name === "__tests__") return [];
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(filePath);
    if (!/\.[cm]?[jt]sx?$/.test(entry.name) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      return [];
    }
    return [filePath];
  });
}

describe("11-12 legacy V1 isolation", () => {
  it("keeps V1 WorldState and its obsolete consumers out of production imports", () => {
    const violations = productionFiles(sourceRoot).filter((filePath) => {
      const imports = fs.readFileSync(filePath, "utf8").matchAll(/(?:from\s*|import\s*\()["']([^"']+)["']/g);
      return [...imports].some(([, specifier]) =>
        specifier.includes("legacy-v1") ||
        /(?:^|\/)world-state$/.test(specifier) ||
        /(?:^|\/)initial-world-state$/.test(specifier),
      );
    });

    expect(violations).toEqual([]);
    expect(fs.existsSync(path.join(sourceRoot, "lib/world/world-state.ts"))).toBe(false);
    expect(fs.existsSync(path.join(sourceRoot, "lib/test-only/legacy-v1/world-state.ts"))).toBe(true);
  });
});
