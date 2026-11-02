export type PresentationPosition = readonly [longitude: number, latitude: number];

export type CountryPresentationOverride = Readonly<{
  center?: PresentationPosition;
  defaultZoom?: number;
  labelAnchor?: PresentationPosition;
  labelScale?: number;
  policyVersion: string;
  reason: string;
}>;

const allowedKeys = new Set([
  "center",
  "defaultZoom",
  "labelAnchor",
  "labelScale",
  "policyVersion",
  "reason",
]);

const readCanonicalText = (value: unknown, field: "policyVersion" | "reason") => {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`CountryPresentationOverride.${field} must be non-empty canonical text`);
  }
  return value;
};

const readPosition = (value: unknown, field: "center" | "labelAnchor"): PresentationPosition => {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    throw new Error(`CountryPresentationOverride.${field} must contain two finite coordinates`);
  }
  return Object.freeze([value[0], value[1]]) as PresentationPosition;
};

const readPositiveNumber = (value: unknown, field: "defaultZoom" | "labelScale") => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`CountryPresentationOverride.${field} must be a positive finite number`);
  }
  return value;
};

export function createCountryPresentationOverride(value: unknown): CountryPresentationOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CountryPresentationOverride must be an object");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
    throw new Error("CountryPresentationOverride contains an unknown field");
  }
  if (
    input.center === undefined &&
    input.defaultZoom === undefined &&
    input.labelAnchor === undefined &&
    input.labelScale === undefined
  ) {
    throw new Error("CountryPresentationOverride requires at least one manual value");
  }

  const override: {
    center?: PresentationPosition;
    defaultZoom?: number;
    labelAnchor?: PresentationPosition;
    labelScale?: number;
    policyVersion: string;
    reason: string;
  } = {
    policyVersion: readCanonicalText(input.policyVersion, "policyVersion"),
    reason: readCanonicalText(input.reason, "reason"),
  };
  if (input.center !== undefined) override.center = readPosition(input.center, "center");
  if (input.defaultZoom !== undefined) {
    override.defaultZoom = readPositiveNumber(input.defaultZoom, "defaultZoom");
  }
  if (input.labelAnchor !== undefined) {
    override.labelAnchor = readPosition(input.labelAnchor, "labelAnchor");
  }
  if (input.labelScale !== undefined) {
    override.labelScale = readPositiveNumber(input.labelScale, "labelScale");
  }

  return Object.freeze(override);
}
