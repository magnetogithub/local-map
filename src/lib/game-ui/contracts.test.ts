import {describe, expect, expectTypeOf, it} from "vitest";

import {
  assertRelationshipScore,
  isBlockingNewsItem,
  type BilateralRelationshipViewModel,
  type DiplomacyChannelPort,
  type EconomyViewModel,
  type GameSavePort,
  type NewsItemViewModel,
  type PoliticsViewModel,
  type WarsViewModel,
} from "./contracts";
import type {CountryId} from "@/lib/world/country-id";

const country = (countryId: string, nameKo: string) => ({
  countryId: countryId as CountryId,
  nameKo,
  code: countryId,
  flagUrl: null,
  mapColor: null,
});

describe("game UI contracts", () => {
  it("represents unavailable domains without production placeholder values", () => {
    const player = country("KOR", "대한민국");
    const politics: PoliticsViewModel = {
      dataAvailable: false,
      unavailableReason: "데이터 연결 예정",
      country: player,
      regimeName: null,
      leaderName: null,
      domesticSituation: null,
      recentDomesticEvents: [],
    };
    const economy: EconomyViewModel = {
      dataAvailable: false,
      unavailableReason: "데이터 연결 예정",
      country: player,
      population: null,
      summary: null,
      metrics: [],
      recentEconomicEvents: [],
    };
    const wars: WarsViewModel = {
      dataAvailable: false,
      unavailableReason: "전쟁 데이터 연결 예정",
      wars: [],
    };

    expect([politics.regimeName, politics.leaderName, economy.population]).toEqual([null, null, null]);
    expect(wars.wars).toEqual([]);
    expectTypeOf<DiplomacyChannelPort | null>().not.toEqualTypeOf<DiplomacyChannelPort>();
    expectTypeOf<GameSavePort | null>().not.toEqualTypeOf<GameSavePort>();
  });

  it.each([-100, 0, 100, null])("accepts relationship boundary %s", (score) => {
    expect(assertRelationshipScore(score)).toBe(score);
  });

  it.each([-101, 101, 0.5, Number.NaN])("rejects invalid relationship score %s", (score) => {
    expect(() => assertRelationshipScore(score)).toThrow(RangeError);
  });

  it("keeps both relationship directions explicit", () => {
    const player = country("KOR", "대한민국");
    const foreign = country("JPN", "일본");
    const relationship: BilateralRelationshipViewModel = {
      playerToForeign: {fromCountry: player, toCountry: foreign, score: 20, dataAvailable: true},
      foreignToPlayer: {fromCountry: foreign, toCountry: player, score: -15, dataAvailable: true},
    };

    expect(relationship.playerToForeign).toMatchObject({fromCountry: player, toCountry: foreign, score: 20});
    expect(relationship.foreignToPlayer).toMatchObject({fromCountry: foreign, toCountry: player, score: -15});
  });

  it.each([
    ["minor", false],
    ["notable", false],
    ["major", true],
    ["transformative", true],
  ] as const)("blocks only an unacknowledged %s event", (significance, expected) => {
    const item: NewsItemViewModel = {
      eventId: `event.${significance}`,
      date: "2020-01-02",
      title: "사건",
      narrative: "사건 설명",
      category: "other",
      significance,
      relatedCountryIds: [],
      acknowledged: false,
    };
    expect(isBlockingNewsItem(item)).toBe(expected);
    expect(isBlockingNewsItem({...item, acknowledged: true})).toBe(false);
  });
});

