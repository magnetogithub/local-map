import {z} from "zod";

import {COUNTRY_ID_PATTERN} from "@/lib/world/country-id";

export const countryIdV2Schema = z.string().regex(
  COUNTRY_ID_PATTERN,
  "CountryId must be exactly 3 uppercase alphanumeric characters and start with a letter",
);
