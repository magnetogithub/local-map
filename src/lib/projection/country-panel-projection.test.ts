import {describe, expect, it} from "vitest";

import {createCountryEntity} from "../world/country-entity";
import {retireCountryId, type ActiveCountryId} from "../world/country-id";
import type {SeedCountryCapital} from "../world/seed-v1-to-v2";
import {createTerritoryEntity, type TerritoryGeometry} from "../world/territory-entity";
import {deriveTerritoryId, type TerritoryId} from "../world/territory-id";
import {createTopologyState} from "../world/topology-state";
import {
  createWorldStateV2,
  WORLD_STATE_V2_SCHEMA_VERSION,
  type WorldStateV2,
} from "../world/world-state-v2";
import {createCountryCapitalProjection} from "./country-capital-projection";
import {
  createCountryPanelProjection,
  getCountryPanelView,
} from "./country-panel-projection";

const activeCountryId = (countryId: "AAA" | "BBB") => countryId as ActiveCountryId;

const rectangle = (x: number): TerritoryGeometry => ({
  type: "Polygon",
  coordinates: [[
    [x, 0],
    [x + 2, 0],
    [x + 2, 2],
    [x, 2],
    [x, 0],
  ]],
});

const country = (id: "AAA" | "BBB", name: string) => createCountryEntity({
  id: activeCountryId(id),
  names: {
    shortKo: name,
    officialKo: `${name} Republic`,
    mapKo: name,
    english: `${name} English`,
    searchAliases: [id],
  },
  politicalStatus: "sovereign",
  presentationOverride: null,
  moduleVersions: {capital: 1, core: 1, names: 1},
});

const territoryId = (sourceFeatureId: string) =>
  deriveTerritoryId({kind: "seed", seedVersion: "11-6-test", sourceFeatureId});

const territory = (
  id: TerritoryId,
  ownerCountryId: "AAA" | "BBB" | null,
  geometry: TerritoryGeometry,
) => createTerritoryEntity({
  id,
  ownerCountryId: ownerCountryId === null ? null : activeCountryId(ownerCountryId),
  geometry,
  properties: {sourceFeatureId: id},
});

const world = ({
  revision,
  aaaName = "Alpha",
  includeAaa = true,
  alphaOwner = "AAA",
}: Readonly<{
  revision: number;
  aaaName?: string;
  includeAaa?: boolean;
  alphaOwner?: "AAA" | "BBB" | null;
}>): WorldStateV2 => {
  const alpha = territoryId("alpha");
  const beta = territoryId("beta");
  const countriesById = includeAaa
    ? {
      AAA: country("AAA", aaaName),
      BBB: country("BBB", "Beta"),
    }
    : {
      BBB: country("BBB", "Beta"),
    };

  return createWorldStateV2({
    schemaVersion: WORLD_STATE_V2_SCHEMA_VERSION,
    seedVersion: "11-6-test",
    policyVersion: "world-policy-v1",
    revision,
    countriesById,
    countryOrder: includeAaa ? [activeCountryId("AAA"), activeCountryId("BBB")] : [activeCountryId("BBB")],
    retiredCountryIds: includeAaa ? [] : [retireCountryId(activeCountryId("AAA"))],
    territoriesById: {
      [alpha]: territory(alpha, includeAaa ? alphaOwner : null, rectangle(0)),
      [beta]: territory(beta, "BBB", rectangle(4)),
    },
    territoryOrder: [alpha, beta],
    topology: createTopologyState([]),
    hashRoots: {
      countriesRootHash: null,
      presentationRootHash: null,
      territoriesRootHash: null,
      topologyRootHash: null,
    },
  });
};

const capitals: Readonly<Record<string, SeedCountryCapital>> = Object.freeze({
  AAA: Object.freeze({
    countryId: activeCountryId("AAA"),
    nameKo: "Alpha City",
    nameEn: "Alpha City",
    capitalType: "national",
    labelRank: 1,
    coordinates: Object.freeze([1, 1] as const),
  }),
  BBB: Object.freeze({
    countryId: activeCountryId("BBB"),
    nameKo: "Beta City",
    nameEn: "Beta City",
    capitalType: "national",
    labelRank: 1,
    coordinates: Object.freeze([5, 1] as const),
  }),
});

const presentation = Object.freeze({
  AAA: Object.freeze({
    countryId: activeCountryId("AAA"),
    iso3: "AAA",
    flagCode: "aa",
    region: "Test",
  }),
  BBB: Object.freeze({
    countryId: activeCountryId("BBB"),
    iso3: "BBB",
    flagCode: "bb",
    region: "Test",
  }),
});

const panelProjection = (state: WorldStateV2) =>
  createCountryPanelProjection(
    state,
    createCountryCapitalProjection(state, capitals),
    presentation,
  );

describe("11-6 country panel projection runtime", () => {
  it("updates panel names from the current WorldStateV2 country module", () => {
    const projection = panelProjection(world({revision: 31, aaaName: "Renamed Alpha"}));
    const view = getCountryPanelView(projection, "AAA");

    expect(view?.nameKo).toBe("Renamed Alpha");
    expect(view?.nameEn).toBe("Renamed Alpha English");
    expect(view?.capitalKo).toBe("Alpha City");
  });

  it("removes dissolved countries from panel views without static fallback", () => {
    const projection = panelProjection(world({revision: 32, includeAaa: false}));

    expect(getCountryPanelView(projection, "AAA")).toBeNull();
    expect(projection.coreById.has(activeCountryId("AAA"))).toBe(false);
    expect(getCountryPanelView(projection, "BBB")?.nameKo).toBe("Beta");
  });

  it("updates panel capital fields when capital ownership projection changes", () => {
    const projection = panelProjection(world({revision: 33, alphaOwner: "BBB"}));
    const view = getCountryPanelView(projection, "AAA");

    expect(view?.nameKo).toBe("Alpha");
    expect(view?.capitalKo).toBe("??");
    expect(view?.capitalEn).toBe("??");
  });
});
