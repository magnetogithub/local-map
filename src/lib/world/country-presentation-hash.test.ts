import {describe, expect, it} from "vitest";

import {createCountryEntity} from "./country-entity";
import {createCountryIdRegistry, issueCountryId} from "./country-id";
import {countryPresentationLeafHash} from "./country-presentation-hash";

const country = (
  id: string,
  english: string,
  presentationOverride: unknown = null,
) =>
  createCountryEntity({
    id: issueCountryId(
      id,
      createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []}),
    ),
    names: {
      shortKo: english,
      officialKo: english,
      mapKo: english,
      english,
      searchAliases: [id],
    },
    politicalStatus: "sovereign",
    presentationOverride,
    moduleVersions: {core: 1, names: 1},
  });

describe("10-23 countryPresentation leaf hash", () => {
  it("uses only the automatic policy version and override", () => {
    const first = country("AAA", "Alpha");
    const second = country("BBB", "Beta");
    const firstWorld = {
      country: first,
      territory: {ownerCountryId: first.id},
    };
    const changedWorld = {
      country: second,
      territory: {ownerCountryId: null},
    };

    expect(countryPresentationLeafHash(firstWorld.country, "automatic-presentation-v3")).toBe(
      countryPresentationLeafHash(changedWorld.country, "automatic-presentation-v3"),
    );
  });

  it("changes when the automatic presentation policy version changes", () => {
    const entity = country("AAA", "Alpha");

    expect(countryPresentationLeafHash(entity, "automatic-presentation-v3")).not.toBe(
      countryPresentationLeafHash(entity, "automatic-presentation-v4"),
    );
  });

  it("changes for override values and override provenance", () => {
    const automatic = country("AAA", "Alpha");
    const reviewed = country("AAA", "Alpha", {
      center: [127.5, 36.5],
      labelScale: 0.9,
      policyVersion: "override-policy-v2",
      reason: "Reviewed dense-label placement.",
    });
    const moved = country("AAA", "Alpha", {
      center: [128, 36.5],
      labelScale: 0.9,
      policyVersion: "override-policy-v2",
      reason: "Reviewed dense-label placement.",
    });
    const reprovenanced = country("AAA", "Alpha", {
      center: [127.5, 36.5],
      labelScale: 0.9,
      policyVersion: "override-policy-v3",
      reason: "Reviewed dense-label placement again.",
    });

    expect(new Set([
      countryPresentationLeafHash(automatic, "automatic-presentation-v3"),
      countryPresentationLeafHash(reviewed, "automatic-presentation-v3"),
      countryPresentationLeafHash(moved, "automatic-presentation-v3"),
      countryPresentationLeafHash(reprovenanced, "automatic-presentation-v3"),
    ])).toHaveLength(4);
  });

  it.each(["", " ", " automatic-presentation-v3"])(
    "rejects a non-canonical automatic policy version: %j",
    (policyVersion) => {
      expect(() => countryPresentationLeafHash(country("AAA", "Alpha"), policyVersion)).toThrow(
        /policy version/i,
      );
    },
  );
});
