import {z} from "zod";

import {wrapCommandSchemaWithPlainDataBoundary} from "./plain-command-data-v2";

export const canonicalCommandTextSchema = z.string().min(1).refine(
  (value) => value === value.trim(),
  {message: "value must not contain surrounding whitespace"},
);

const reservedPayloadFields = new Set([
  "issuedAt",
  "source",
  "auditMetadata",
  "policyVersion",
  "geometryPolicy",
]);

const mapCommandV2PayloadObjectSchema = z
  .record(z.string(), z.unknown())
  .superRefine((payload, context) => {
    for (const field of reservedPayloadFields) {
      if (Object.hasOwn(payload, field)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} belongs outside the general command payload`,
        });
      }
    }
  });

export const mapCommandV2PayloadSchema = wrapCommandSchemaWithPlainDataBoundary(
  mapCommandV2PayloadObjectSchema,
);

const mapCommandV2EnvelopeObjectSchema = z.strictObject({
  commandId: canonicalCommandTextSchema,
  type: canonicalCommandTextSchema,
  expectedRevision: z.number().int().nonnegative().safe(),
  payload: mapCommandV2PayloadSchema,
});

export const mapCommandV2EnvelopeSchema = wrapCommandSchemaWithPlainDataBoundary(
  mapCommandV2EnvelopeObjectSchema,
);

export const createMapCommandV2Schema = <
  const CommandType extends string,
  PayloadSchema extends z.ZodType,
>(type: CommandType, payload: PayloadSchema) =>
  wrapCommandSchemaWithPlainDataBoundary(
    mapCommandV2EnvelopeObjectSchema.extend({
      type: z.literal(type),
      payload,
    }),
  );

export const mapCommandV2AuditMetadataSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    issuedAt: z.iso.datetime({offset: true}),
    source: canonicalCommandTextSchema,
  }),
);

export const mapCommandV2PolicyReferenceSchema = wrapCommandSchemaWithPlainDataBoundary(
  z.strictObject({
    policyVersion: canonicalCommandTextSchema,
  }),
);

export type MapCommandV2Envelope = z.infer<typeof mapCommandV2EnvelopeSchema>;
export type MapCommandV2AuditMetadata = z.infer<typeof mapCommandV2AuditMetadataSchema>;
export type MapCommandV2PolicyReference = z.infer<typeof mapCommandV2PolicyReferenceSchema>;

export const parseMapCommandV2Envelope = (input: unknown): MapCommandV2Envelope =>
  mapCommandV2EnvelopeSchema.parse(input);

export const safeParseMapCommandV2Envelope = (input: unknown) =>
  mapCommandV2EnvelopeSchema.safeParse(input);
