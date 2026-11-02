export const COUNTRY_LABEL_QUALITY_THRESHOLDS=Object.freeze({
  mainland:0.85,
  vertical:0.75,
  archipelago:0.75,
  baseline:0.9,
  confidence:0.65,
});

export function insideRatioThresholdFor(shapeClass){
  return shapeClass==="vertical"||shapeClass==="archipelago"
    ? COUNTRY_LABEL_QUALITY_THRESHOLDS.vertical
    : COUNTRY_LABEL_QUALITY_THRESHOLDS.mainland;
}
