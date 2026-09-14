import {createHash} from "node:crypto";

import {describe, expect, it} from "vitest";

import {createCountryEntity} from "./country-entity";
import {countryCoreLeafHash} from "./country-core-hash";
import {createCountryIdRegistry, issueCountryId} from "./country-id";
import {sha256Hex} from "./sha256";

const country = (presentationOverride: unknown = null) =>
  createCountryEntity({
    id: issueCountryId(
      "EXA",
      createCountryIdRegistry({activeCountryIds: [], retiredCountryIds: []}),
    ),
    names: {
      shortKo: "예시국",
      officialKo: "예시 공화국",
      mapKo: "예시국",
      english: "Example Republic",
      searchAliases: ["EXA", "Example"],
    },
    politicalStatus: "sovereign",
    presentationOverride,
    moduleVersions: {names: 2, core: 1},
  });

describe("10-22 countryCore leaf hash", () => {
  it("implements standard lowercase SHA-256 without a Node-only production dependency", () => {
    const encoded = new TextEncoder().encode("abc");
    expect(sha256Hex(encoded)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Hex(encoded)).toBe(createHash("sha256").update(encoded).digest("hex"));

    const multiBlock = new TextEncoder().encode("canonical-world-state:".repeat(100));
    expect(sha256Hex(multiBlock)).toBe(
      createHash("sha256").update(multiBlock).digest("hex"),
    );
  });

  it("is deterministic across core object insertion order", () => {
    const first = country();
    const reordered = createCountryEntity({
      moduleVersions: {core: 1, names: 2},
      presentationOverride: null,
      politicalStatus: "sovereign",
      names: {
        searchAliases: ["EXA", "Example"],
        english: "Example Republic",
        mapKo: "예시국",
        officialKo: "예시 공화국",
        shortKo: "예시국",
      },
      id: first.id,
    });

    expect(countryCoreLeafHash(first)).toBe(countryCoreLeafHash(reordered));
    expect(countryCoreLeafHash(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("ignores presentation override and territory ownership or geometry changes", () => {
    const withoutOverride = country();
    const withOverride = country({
      center: [127.5, 36.5],
      policyVersion: "presentation-v2",
      reason: "Reviewed anchor.",
    });
    const firstWorld = {
      country: withoutOverride,
      territory: {ownerCountryId: withoutOverride.id, geometry: {coordinates: [0]}},
    };
    const changedWorld = {
      country: withOverride,
      territory: {ownerCountryId: null, geometry: {coordinates: [999]}},
    };

    expect(countryCoreLeafHash(firstWorld.country)).toBe(
      countryCoreLeafHash(changedWorld.country),
    );
  });

  it("changes for each country core module input", () => {
    const original = country();
    const renamed = createCountryEntity({
      ...original,
      names: {...original.names, english: "Renamed Republic"},
    });
    const reclassified = createCountryEntity({...original, politicalStatus: "dependent"});
    const versioned = createCountryEntity({...original, moduleVersions: {core: 2, names: 2}});

    expect(new Set([
      countryCoreLeafHash(original),
      countryCoreLeafHash(renamed),
      countryCoreLeafHash(reclassified),
      countryCoreLeafHash(versioned),
    ])).toHaveLength(4);
  });
});
