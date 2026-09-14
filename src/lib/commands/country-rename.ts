import {z} from "zod";

import {
  replaceCountryNames,
  type CountryNames,
  type WorldState,
} from "@/lib/world/world-state";

import {mapCommandEnvelopeSchema} from "./map-command";

const nonEmptyText = z.string().trim().min(1);

export const countryRenameChangesSchema = z
  .strictObject({
    shortKo: nonEmptyText.optional(),
    officialKo: nonEmptyText.optional(),
    mapKo: nonEmptyText.optional(),
    english: nonEmptyText.optional(),
    aliases: z.array(nonEmptyText).optional(),
  })
  .refine((changes) => Object.values(changes).some((value) => value !== undefined), {
    message: "At least one country name field must be supplied",
  });

export const countryRenamePayloadSchema = z.strictObject({
  countryId: nonEmptyText,
  changes: countryRenameChangesSchema,
});

export const countryRenameCommandSchema = mapCommandEnvelopeSchema.extend({
  type: z.literal("country.rename"),
  payload: countryRenamePayloadSchema,
});

export type CountryRenameChanges = z.infer<typeof countryRenameChangesSchema>;
export type CountryRenamePayload = z.infer<typeof countryRenamePayloadSchema>;
export type CountryRenameCommand = z.infer<typeof countryRenameCommandSchema>;

const hasOwn = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

export const countryRenameCommandSchemaFor = (
  state: Pick<WorldState, "countriesById">,
) =>
  countryRenameCommandSchema.superRefine((command, context) => {
    const countryId = command.payload.countryId;
    if (!hasOwn(state.countriesById, countryId)) {
      context.addIssue({
        code: "custom",
        path: ["payload", "countryId"],
        message: `Country does not exist: ${countryId}`,
      });
    }
  });

export const parseCountryRenameCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById">,
): CountryRenameCommand => countryRenameCommandSchemaFor(state).parse(input);

export const safeParseCountryRenameCommand = (
  input: unknown,
  state: Pick<WorldState, "countriesById">,
) => countryRenameCommandSchemaFor(state).safeParse(input);

export function applyCountryRenameCommand(state: WorldState, input: unknown): WorldState {
  const command = parseCountryRenameCommand(input, state);
  const country = state.countriesById[command.payload.countryId];
  const {changes} = command.payload;
  const names: CountryNames = {...country.names};

  if (changes.shortKo !== undefined) names.shortKo = changes.shortKo;
  if (changes.officialKo !== undefined) names.officialKo = changes.officialKo;
  if (changes.mapKo !== undefined) names.mapKo = changes.mapKo;
  if (changes.english !== undefined) names.english = changes.english;
  if (changes.aliases !== undefined) names.searchAliases = changes.aliases;

  return replaceCountryNames(state, country.id, names);
}
