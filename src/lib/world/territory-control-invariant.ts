export const TERRITORY_EFFECTIVE_OWNER_FIELD = "ownerCountryId" as const;

export type TerritoryControlInvariantErrorCode =
  | "missing-territory-owner-field"
  | "multiple-territory-owners"
  | "overlapping-territory-control";

export class TerritoryControlInvariantError extends Error {
  readonly code: TerritoryControlInvariantErrorCode;
  readonly field: string;

  constructor(code: TerritoryControlInvariantErrorCode, field: string, message: string) {
    super(message);
    this.name = "TerritoryControlInvariantError";
    this.code = code;
    this.field = field;
  }
}

const overlappingControlFields = [
  "ownerCountryIds",
  "controllerCountryId",
  "controllerCountryIds",
  "controllingCountryId",
  "controllingCountryIds",
  "effectiveOwnerCountryId",
  "effectiveControllerCountryId",
  "control",
] as const;

const pluralControlFields = new Set([
  "ownerCountryIds",
  "controllerCountryIds",
  "controllingCountryIds",
]);

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

const throwMultipleOwners = (field: string): never => {
  throw new TerritoryControlInvariantError(
    "multiple-territory-owners",
    field,
    `Territory effective control must not contain multiple owners in ${field}`,
  );
};

const throwOverlappingControl = (field: string): never => {
  throw new TerritoryControlInvariantError(
    "overlapping-territory-control",
    field,
    `Territory effective control must use only ${TERRITORY_EFFECTIVE_OWNER_FIELD}; found ${field}`,
  );
};

export function assertSingleEffectiveControlRepresentation(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TerritoryControlInvariantError(
      "missing-territory-owner-field",
      TERRITORY_EFFECTIVE_OWNER_FIELD,
      "Territory control input must be an object with ownerCountryId",
    );
  }
  const input = value as Record<string, unknown>;

  if (Array.isArray(input.ownerCountryId)) {
    return throwMultipleOwners(TERRITORY_EFFECTIVE_OWNER_FIELD);
  }
  for (const field of overlappingControlFields) {
    if (!hasOwn(input, field)) continue;
    if (pluralControlFields.has(field) && Array.isArray(input[field]) && input[field].length > 1) {
      return throwMultipleOwners(field);
    }
    return throwOverlappingControl(field);
  }

  if (!hasOwn(input, TERRITORY_EFFECTIVE_OWNER_FIELD)) {
    throw new TerritoryControlInvariantError(
      "missing-territory-owner-field",
      TERRITORY_EFFECTIVE_OWNER_FIELD,
      "Territory control input must contain ownerCountryId",
    );
  }

  const properties = input.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties)) {
    const propertyRecord = properties as Record<string, unknown>;
    const controlFieldsInProperties = [
      TERRITORY_EFFECTIVE_OWNER_FIELD,
      ...overlappingControlFields,
    ];
    for (const field of controlFieldsInProperties) {
      if (!hasOwn(propertyRecord, field)) continue;
      if (
        pluralControlFields.has(field) &&
        Array.isArray(propertyRecord[field]) &&
        propertyRecord[field].length > 1
      ) {
        return throwMultipleOwners(`properties.${field}`);
      }
      return throwOverlappingControl(`properties.${field}`);
    }
  }
}
