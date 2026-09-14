import {z} from "zod";

import type {WorldState} from "@/lib/world/world-state";

import {mapCommandEnvelopeSchema} from "./map-command";

const nonEmptyCountryId = z.string().trim().min(1);

export const countryDeletePolicySchema = z.strictObject({
  ifMissing: z.literal("reject"),
  ifLastCountry: z.enum(["reject", "allow-empty-world"]),
});

export const countryDeletePayloadSchema = z.strictObject({
  countryId: nonEmptyCountryId,
  policy: countryDeletePolicySchema,
});

export const countryDeleteCommandSchema = mapCommandEnvelopeSchema.extend({
  type: z.literal("country.delete"),
  payload: countryDeletePayloadSchema,
});

export type CountryDeletePolicy = z.infer<typeof countryDeletePolicySchema>;
export type CountryDeletePayload = z.infer<typeof countryDeletePayloadSchema>;
export type CountryDeleteCommand = z.infer<typeof countryDeleteCommandSchema>;

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export const countryDeleteCommandSchemaFor = (
  state: Pick<WorldState, "countriesById" | "countryOrder">,
) =>
  countryDeleteCommandSchema.superRefine((command, context) => {
    const {countryId, policy} = command.payload;
    if (!hasOwn(state.countriesById, countryId)) {
      context.addIssue({
        code: "custom",
        path: ["payload", "countryId"],
        message: `Country does not exist: ${countryId}`,
      });
      return;
    }

    const deletingLastCountry =
      state.countryOrder.length === 1 && state.countryOrder[0] === countryId;
    if (deletingLastCountry && policy.ifLastCountry === "reject") {
      context.addIssue({
        code: "custom",
        path: ["payload", "policy", "ifLastCountry"],
        message: `Deleting the last country is rejected by policy: ${countryId}`,
      });
    }
  });

export const parseCountryDeleteCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById" | "countryOrder">,
): CountryDeleteCommand => countryDeleteCommandSchemaFor(state).parse(input);

export const safeParseCountryDeleteCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById" | "countryOrder">,
) => countryDeleteCommandSchemaFor(state).safeParse(input);
