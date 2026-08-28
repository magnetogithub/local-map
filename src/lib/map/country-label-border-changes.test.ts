import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {describe,expect,it} from "vitest";

const reportPath=path.join(process.cwd(),"reports/fix07-border-recomputation.json");

describe("actual country geometry border-change recomputation",()=>{
  it("recomputes and records all five real-geometry scenarios with valid incremental layouts",()=>{
    const started=Date.now();execFileSync(process.execPath,[path.join(process.cwd(),"scripts/validate-border-recomputation.mjs")],{cwd:process.cwd(),stdio:"pipe"});
    expect(fs.statSync(reportPath).mtimeMs).toBeGreaterThanOrEqual(started-1000);
    const report=JSON.parse(fs.readFileSync(reportPath,"utf8"));
    expect(report.status).toBe("passed");
    expect(report.source).toContain("1:10m");
    expect(Date.parse(report.validationStartedAt)).toBeGreaterThanOrEqual(started-1000);
    expect(report.results.map((result:{scenario:string})=>result.scenario)).toEqual(["east-territory-removed","adjacent-territory-annexed","territory-split","two-polygons-merged","narrow-corridor-added"]);
    expect(report.unchangedCountriesRecomputed).toBe(false);
    expect(report.unchangedCountryIds).toContain("CHN");
    expect(report.stabilityImprovementCount).toBeGreaterThanOrEqual(0);
    for(const result of report.results){
      expect(result.coordinateOverride).toBe(false);
      expect(result.before.geometryHash).not.toBe(result.withPrevious.geometryHash);
      expect(result.withPrevious.geometryHash).toBe(result.withoutPrevious.geometryHash);
      expect(result.withPrevious.anchorInside).toBe(true);
      expect(result.withoutPrevious.anchorInside).toBe(true);
      expect(result.withPrevious.insideRatio).toBeGreaterThanOrEqual(["CHL","IDN"].includes(result.countryId)?.75:.85);
      expect(result.withoutPrevious.insideRatio).toBeGreaterThanOrEqual(["CHL","IDN"].includes(result.countryId)?.75:.85);
      expect(result.qualityDifference).toBeLessThanOrEqual(.05);
    }
    expect(report.results.find((result:{scenario:string})=>result.scenario==="territory-split").withPrevious.polygonCount).toBeGreaterThan(report.results.find((result:{scenario:string})=>result.scenario==="territory-split").before.polygonCount);
    expect(report.results.find((result:{scenario:string})=>result.scenario==="two-polygons-merged").withPrevious.polygonCount).toBeLessThan(report.results.find((result:{scenario:string})=>result.scenario==="two-polygons-merged").before.polygonCount);
  },60_000);
});
