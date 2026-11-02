import {describe,expect,it} from "vitest";
import metrics from "@/data/country-label-metrics-2020.json";
import {POINT_LABEL_MIN_WORLD_UNITS,worldSpaceFontSize,worldSpaceTextSizeExpression} from "./country-label-size";
describe("8A-R3 world-space label sizing",()=>{
  it("doubles and halves throughout the supported zoom range",()=>{for(let zoom=1;zoom<9;zoom++){const mid=worldSpaceFontSize(.5,zoom);expect(worldSpaceFontSize(.5,zoom+1)/mid).toBeCloseTo(2,12);expect(worldSpaceFontSize(.5,zoom-1)/mid).toBeCloseTo(.5,12)}});
  it("does not replace geometry-relative sizing with a fixed pixel cap",()=>{expect(worldSpaceFontSize(20,9)).toBe(10_240);expect(JSON.stringify(worldSpaceTextSizeExpression())).not.toContain('"min"')});
  it("keeps label to territory width ratio invariant",()=>{for(const metric of metrics){const ratios=[1,2,3,4].map(zoom=>metric.targetTextWidthWorld*2**zoom/(metric.availableWidthWorld*2**zoom));expect(Math.max(...ratios)-Math.min(...ratios)).toBeLessThanOrEqual(.000001)}});
  it("uses one top-level zoom interpolate expression",()=>{const expression=worldSpaceTextSizeExpression() as unknown[];expect(expression.slice(0,3)).toEqual(["interpolate",["exponential",2],["zoom"]]);expect(JSON.stringify(expression).match(/"zoom"/g)).toHaveLength(1)});
  it("keeps point fallback readable without becoming fixed-pixel text",()=>{const at7=worldSpaceFontSize(.000184,7,POINT_LABEL_MIN_WORLD_UNITS);expect(at7).toBeCloseTo(12.8);expect(worldSpaceFontSize(.000184,8,POINT_LABEL_MIN_WORLD_UNITS)/at7).toBe(2)});
});
