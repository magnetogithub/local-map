import {cleanup, render, screen} from "@testing-library/react";
import {afterEach, describe, expect, it} from "vitest";

import type {EconomyViewModel, PoliticsViewModel} from "@/lib/game-ui/contracts";
import type {CountryId} from "@/lib/world/country-id";
import {EconomyOverlay, PoliticsOverlay} from "./CountryManagementOverlays";

const country = {
  countryId: "KOR" as CountryId,
  nameKo: "대한민국",
  code: "KOR",
  flagUrl: null,
  mapColor: "#4f7f9f",
};

afterEach(cleanup);

describe("13-14 and 13-15 management overlays", () => {
  it("renders distinct loading fixtures for politics and economy", () => {
    const politics: PoliticsViewModel = {loading: true, dataAvailable: false, unavailableReason: "불러오는 중", country, regimeName: null, leaderName: null, domesticSituation: null, recentDomesticEvents: []};
    const economy: EconomyViewModel = {loading: true, dataAvailable: false, unavailableReason: "불러오는 중", country, population: null, summary: null, metrics: [], recentEconomicEvents: []};
    const {rerender} = render(<PoliticsOverlay model={politics}/>);
    expect(screen.getByRole("status", {name: "정치 데이터 불러오는 중"})).toBeVisible();
    rerender(<EconomyOverlay model={economy}/>);
    expect(screen.getByRole("status", {name: "경제 데이터 불러오는 중"})).toBeVisible();
  });

  it("renders politics structure with explicit unavailable values and an empty event state", () => {
    const model: PoliticsViewModel = {
      dataAvailable: false,
      unavailableReason: "정치 체제·지도자 데이터 연결 예정",
      country,
      regimeName: null,
      leaderName: null,
      domesticSituation: null,
      recentDomesticEvents: [],
    };
    render(<PoliticsOverlay model={model}/>);
    expect(screen.getByTestId("politics-overlay")).toHaveTextContent("대한민국");
    expect(screen.getByRole("heading", {name: "정치 개요"})).toBeVisible();
    expect(screen.getByText("정치 체제").nextElementSibling).toHaveTextContent("데이터 연결 예정");
    expect(screen.getByRole("heading", {name: "기록된 사건 없음"})).toBeVisible();
    expect(screen.getByRole("heading", {name: "후속 확장"})).toBeVisible();
  });

  it("renders economy metrics as unavailable rather than zero", () => {
    const model: EconomyViewModel = {
      dataAvailable: false,
      unavailableReason: "인구·경제 지표 데이터 연결 예정",
      country,
      population: null,
      summary: null,
      metrics: [
        {key: "production", label: "생산", value: null, unit: null, dataAvailable: false},
        {key: "finance", label: "재정", value: null, unit: null, dataAvailable: false},
        {key: "trade", label: "무역", value: null, unit: null, dataAvailable: false},
      ],
      recentEconomicEvents: [{
        eventId: "event.economy",
        date: "2020-01-02",
        title: "경제 사건",
        narrative: "공개된 경제 사건 기록",
        category: "economic",
        significance: "notable",
        relatedCountryIds: [country.countryId],
        acknowledged: false,
      }],
    };
    render(<EconomyOverlay model={model}/>);
    expect(screen.getByTestId("economy-overlay")).toHaveTextContent("대한민국");
    expect(screen.getAllByText("—")).toHaveLength(3);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getByText("경제 사건")).toBeVisible();
    expect(screen.getByText("공개된 경제 사건 기록")).toBeVisible();
  });

  it("renders injected populated politics values and domestic events", () => {
    const model: PoliticsViewModel = {
      dataAvailable: true,
      unavailableReason: null,
      country,
      regimeName: "테스트 체제",
      leaderName: "테스트 지도자",
      domesticSituation: "테스트 국내 상황",
      recentDomesticEvents: [{
        eventId: "event.domestic",
        date: "2020-01-03",
        title: "국내 사건",
        narrative: "국내 사건 공개 기록",
        category: "domestic",
        significance: "minor",
        relatedCountryIds: [country.countryId],
        acknowledged: false,
      }],
    };
    render(<PoliticsOverlay model={model}/>);
    expect(screen.getByText("테스트 체제")).toBeVisible();
    expect(screen.getByText("테스트 지도자")).toBeVisible();
    expect(screen.getByText("국내 사건 공개 기록")).toBeVisible();
  });
});
