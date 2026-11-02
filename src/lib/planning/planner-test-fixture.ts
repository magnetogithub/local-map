import {parseCountryCreateV2Command, type CountryCreateV2Command} from "../commands/country-create-v2";
import {countryCoreLeafHash} from "../world/country-core-hash";
import {createCountryEntity} from "../world/country-entity";
import {createCountryIdRegistry, issueCountryId} from "../world/country-id";
import {countryPresentationLeafHash} from "../world/country-presentation-hash";
import {buildDomainRootHash} from "../world/domain-hash-root";
import {createTopologyState} from "../world/topology-state";
import {createWorldStateV2, WORLD_STATE_V2_SCHEMA_VERSION} from "../world/world-state-v2";

export const plannerStateFixture = () => {
  const registry = createCountryIdRegistry({
    activeCountryIds: [],
    retiredCountryIds: ["OLD"],
  });
  const countryId = issueCountryId("AAA", registry);
  const country = createCountryEntity({
    id: countryId,
    names: {
      shortKo: "기존국",
      officialKo: "기존국 공화국",
      mapKo: "기존국",
      english: "Existing Republic",
      searchAliases: ["AAA"],
    },
    politicalStatus: "sovereign",
    presentationOverride: null,
    moduleVersions: {core: 1, names: 1},
  });
  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "planner-test-v1",
    policyVersion: "world-policy-v1",
    revision: 7,
    countriesById: {[countryId]: country},
    countryOrder: [countryId],
    retiredCountryIds: registry.retiredCountryIds,
    territoriesById: {},
    territoryOrder: [],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: buildDomainRootHash("countries", {[countryId]: countryCoreLeafHash(country)}),
      presentationRootHash: buildDomainRootHash("presentation", {
        [countryId]: countryPresentationLeafHash(country, "world-policy-v1"),
      }),
      territoriesRootHash: buildDomainRootHash("territories", {}),
      topologyRootHash: buildDomainRootHash("topology", {}),
    },
  });
};

export const countryCreateCommandFixture = (
  countryId = "BBB",
  overrides: Partial<Pick<CountryCreateV2Command, "commandId" | "expectedRevision">> = {},
) => parseCountryCreateV2Command({
  commandId: overrides.commandId ?? `create-${countryId}`,
  type: "country.create",
  expectedRevision: overrides.expectedRevision ?? 7,
  payload: {
    country: {
      id: countryId,
      names: {
        shortKo: "신규국",
        officialKo: "신규국 공화국",
        mapKo: "신규국",
        english: "New Republic",
        searchAliases: [countryId],
      },
      politicalStatus: "sovereign",
      presentationOverride: null,
      moduleVersions: {core: 1, names: 1},
    },
  },
});
