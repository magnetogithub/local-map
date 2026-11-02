import {z} from "zod";

const nonEmptyCommandText = z.string().trim().min(1);

export const mapCommandEnvelopeSchema = z.strictObject({
  commandId: nonEmptyCommandText,
  type: nonEmptyCommandText,
  expectedRevision: z.number().int().nonnegative().safe(),
  payload: z.record(z.string(), z.unknown()),
  issuedAt: z.iso.datetime({offset: true}),
  source: nonEmptyCommandText,
});

export type MapCommandEnvelope = z.infer<typeof mapCommandEnvelopeSchema>;
export type MapCommand = MapCommandEnvelope;

export const parseMapCommand = (input: unknown): MapCommand =>
  mapCommandEnvelopeSchema.parse(input);

export const safeParseMapCommand = (input: unknown) =>
  mapCommandEnvelopeSchema.safeParse(input);
