/** Runtime action limits, independent of any polygon generator or grid size. */
export const operationalFrontierPolicy = Object.freeze({
  earthRadiusKm: 6371.0088,
  lookupCap: 512,
  ranges: {near: {depthKm: 36, widthKm: 36, maximumAreaKm2: 2800}, limited: {depthKm: 120, widthKm: 96, maximumAreaKm2: 22000}, deeper: {depthKm: 240, widthKm: 192, maximumAreaKm2: 80000}},
  sufficientlyLargeAdministrativeAreaKm2: 8000,
  nearMaximumParentAreaFraction: 0.35,
});
