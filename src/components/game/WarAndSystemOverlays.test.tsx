import {cleanup, render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, describe, expect, it, vi} from "vitest";

import type {WarsViewModel} from "@/lib/game-ui/contracts";
import {DEFAULT_GAME_UI_SETTINGS} from "@/lib/game-ui/ui-settings";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {SaveOverlay, SettingsOverlay, WarsOverlay} from "./WarAndSystemOverlays";

const country = (id: string) => ({
  countryId: id as ActiveCountryId,
  nameKo: id,
  code: id,
  flagUrl: null,
  mapColor: null,
});

afterEach(cleanup);

describe("13-18 through 13-20 war and system overlays", () => {
  it("renders a distinct loading war fixture", () => {
    render(<WarsOverlay model={{loading: true, dataAvailable: false, unavailableReason: "불러오는 중", wars: []}}/>);
    expect(screen.getByRole("status", {name: "전쟁 데이터 불러오는 중"})).toBeVisible();
  });

  it("renders the production-equivalent empty war state and reserved legend", () => {
    render(<WarsOverlay model={{dataAvailable: false, unavailableReason: "전쟁 도메인 연결 예정", wars: []}}/>);
    expect(screen.getByRole("heading", {name: "진행 중인 전쟁 데이터 없음"})).toBeVisible();
    expect(screen.getByRole("region", {name: "전쟁 지도 범례"})).toBeVisible();
    expect(screen.queryByText(/병력|사단|전투력/)).not.toBeInTheDocument();
  });

  it("renders an injected populated war fixture and toggles only its view layer state", async () => {
    const user = userEvent.setup();
    const model: WarsViewModel = {
      dataAvailable: true,
      unavailableReason: null,
      wars: [{
        warId: "war.fixture",
        name: "테스트 분쟁",
        belligerents: [country("AAA"), country("BBB")],
        startDate: "2020-01-02",
        status: "ongoing",
        recentEvents: [],
        mapLayerAvailable: true,
        mapLayerVisible: false,
      }],
    };
    render(<WarsOverlay model={model}/>);
    expect(screen.getByText("AAA · BBB")).toBeVisible();
    const toggle = screen.getByRole("button", {name: "전쟁 지도 표시"});
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("reports that save did not happen instead of displaying success", async () => {
    const user = userEvent.setup();
    render(<SaveOverlay countryName="AAA" currentDate="2020-01-03" turnNumber={2}/>);
    await user.click(screen.getByRole("button", {name: "게임 저장"}));
    expect(screen.getByRole("status")).toHaveTextContent("저장되지 않았습니다");
    expect(screen.queryByText(/저장 완료|성공/)).not.toBeInTheDocument();
  });

  it("exposes session-only settings as controlled accessible checkboxes", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<SettingsOverlay settings={DEFAULT_GAME_UI_SETTINGS} onChange={onChange}/>);
    const labels = screen.getByRole("checkbox", {name: /지도 국가명/});
    const borders = screen.getByRole("checkbox", {name: /국경선 강조/});
    const reduceMotion = screen.getByRole("checkbox", {name: /움직임 줄이기/});
    expect(labels).toBeChecked();
    expect(borders).not.toBeChecked();
    expect(reduceMotion).not.toBeChecked();
    await user.click(borders);
    expect(onChange).toHaveBeenCalledWith("emphasizeBorders", true);
    await user.click(reduceMotion);
    expect(onChange).toHaveBeenCalledWith("reduceMotion", true);
    expect(screen.getByText(/현재 세션에만 적용/)).toBeVisible();
  });
});
