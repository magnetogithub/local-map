import {describe, expect, it} from "vitest";
import {
  applyCountryReplacement,
  type CountryEntity,
  type WorldState,
} from "@/lib/world/world-state";
import {
  createWorldStateStore,
  getCountryById,
  selectCountryById,
} from "./world-state-store";

const country = (id: string): CountryEntity => ({
  id,
  iso3: id,
  names: {
    shortKo: id,
    officialKo: id,
    mapKo: id,
    english: id,
    searchAliases: [id],
  },
  geometry: {
    type: "Polygon",
    coordinates: [[[0, 0], [2, 0], [2, 2], [0, 0]]],
  },
  mapColor: "#ffffff",
  playable: true,
  unitType: "sovereign-country",
  capital: null,
  presentation: {
    flagCode: id,
    region: "Test",
    center: [1, 1],
    defaultZoom: 4,
    labelRank: 1,
  },
});

const initialWorldState = (): WorldState => ({
  schemaVersion: 1,
  revision: 0,
  countriesById: {USA: country("USA")},
  countryOrder: ["USA"],
});

describe("9-7 dynamic getCountryById selector", () => {
  it("returns a newly created country immediately from the committed revision", () => {
    const controller = createWorldStateStore(initialWorldState());
    const synthetic = country("SYN-NEW");
    const selector = selectCountryById(synthetic.id);

    expect(getCountryById(controller.store.getState(), synthetic.id)).toBeNull();
    expect(selector(controller.store.getState())).toBeNull();

    const created = applyCountryReplacement(controller.store.getState(), {
      removeCountryIds: [],
      upsertCountries: [synthetic],
    }).state;
    controller.replaceWorldState(created);

    expect(getCountryById(controller.store.getState(), synthetic.id)).toBe(synthetic);
    expect(selector(controller.store.getState())).toBe(synthetic);
  });

  it("returns null immediately after deletion without a static-index fallback", () => {
    const controller = createWorldStateStore(initialWorldState());
    expect(getCountryById(controller.store.getState(), "USA")?.id).toBe("USA");

    const deleted = applyCountryReplacement(controller.store.getState(), {
      removeCountryIds: ["USA"],
      upsertCountries: [],
    }).state;
    controller.replaceWorldState(deleted);

    expect(getCountryById(controller.store.getState(), "USA")).toBeNull();
    expect(selectCountryById("USA")(controller.store.getState())).toBeNull();
  });
});
