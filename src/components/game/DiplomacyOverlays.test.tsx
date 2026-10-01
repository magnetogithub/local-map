import {cleanup, render, screen, waitFor} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, describe, expect, it, vi} from "vitest";

import type {CountrySummaryViewModel, CountryViewModel, DiplomacyChannelViewModel} from "@/lib/game-ui/contracts";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {CountryOverlay, DiplomacyOverlay} from "./DiplomacyOverlays";

const summary = (id: string): CountrySummaryViewModel => ({
  countryId: id as ActiveCountryId,
  nameKo: id,
  code: id,
  flagUrl: null,
  mapColor: "#557799",
});
const player = summary("AAA");
const foreign = summary("BBB");
const relationship = {
  playerToForeign: {fromCountry: player, toCountry: foreign, score: null, dataAvailable: false},
  foreignToPlayer: {fromCountry: foreign, toCountry: player, score: null, dataAvailable: false},
} as const;
const channel = (
  connectionState: DiplomacyChannelViewModel["connectionState"],
  overrides: Partial<DiplomacyChannelViewModel> = {},
): DiplomacyChannelViewModel => ({
  availableCounterparts: [foreign],
  counterpart: foreign,
  relationship,
  connectionState,
  connectionMessage: `상태 상세: ${connectionState}`,
  transcript: [],
  quickIntents: [{id: "proposal", label: "제안"}],
  canSend: connectionState === "ready",
  ...overrides,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("13-16 and 13-17 diplomacy overlays", () => {
  it("shows both relationship directions as unavailable and opens diplomacy", async () => {
    const user = userEvent.setup();
    const onOpenDiplomacy = vi.fn();
    const model: CountryViewModel = {
      country: foreign,
      officialNameKo: "BBB 공식 국호",
      englishName: "BBB",
      politicalStatus: "주권 국가",
      capitalKo: "베타 수도",
      capitalEn: "Beta Capital",
      region: "테스트 지역",
      isPlayerCountry: false,
      relationship,
      recentEvents: [],
      relatedWars: [],
      warsDataAvailable: false,
    };
    render(<CountryOverlay model={model} onOpenPolitics={vi.fn()} onOpenDiplomacy={onOpenDiplomacy}/>);
    expect(screen.getByText("AAA → BBB")).toBeVisible();
    expect(screen.getByText("BBB → AAA")).toBeVisible();
    expect(screen.getByText("베타 수도")).toBeVisible();
    expect(screen.getByText("Beta Capital")).toBeVisible();
    expect(screen.getByText("테스트 지역")).toBeVisible();
    expect(screen.getAllByText("관계 데이터 연결 예정")).toHaveLength(2);
    expect(screen.queryByRole("meter")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", {name: "외교 채널 열기"}));
    expect(onOpenDiplomacy).toHaveBeenCalledWith("BBB");
  });

  it("routes the player country to politics", async () => {
    const user = userEvent.setup();
    const onOpenPolitics = vi.fn();
    const model: CountryViewModel = {
      country: player,
      officialNameKo: "AAA 공식 국호",
      englishName: "AAA",
      politicalStatus: "주권 국가",
      capitalKo: null,
      capitalEn: null,
      region: null,
      isPlayerCountry: true,
      relationship: null,
      recentEvents: [],
      relatedWars: [],
      warsDataAvailable: false,
    };
    render(<CountryOverlay model={model} onOpenPolitics={onOpenPolitics} onOpenDiplomacy={vi.fn()}/>);
    expect(screen.getAllByText("데이터 연결 예정")).toHaveLength(3);
    await user.click(screen.getByRole("button", {name: "정치 화면 열기"}));
    expect(onOpenPolitics).toHaveBeenCalledOnce();
  });

  it("keeps populated relationship meter directions and boundary values exact", () => {
    const model: CountryViewModel = {
      country: foreign,
      officialNameKo: "BBB 공식 국호",
      englishName: "BBB",
      politicalStatus: "주권 국가",
      capitalKo: "베타 수도",
      capitalEn: "Beta Capital",
      region: "테스트 지역",
      isPlayerCountry: false,
      relationship: {
        playerToForeign: {...relationship.playerToForeign, score: -100, dataAvailable: true},
        foreignToPlayer: {...relationship.foreignToPlayer, score: 100, dataAvailable: true},
      },
      recentEvents: [], relatedWars: [], warsDataAvailable: false,
    };
    const {rerender} = render(<CountryOverlay model={model} onOpenPolitics={vi.fn()} onOpenDiplomacy={vi.fn()}/>);
    expect(screen.getByRole("meter", {name: "AAA → BBB 관계"})).toHaveAttribute("aria-valuenow", "-100");
    expect(screen.getByRole("meter", {name: "BBB → AAA 관계"})).toHaveAttribute("aria-valuenow", "100");
    for (const meter of screen.getAllByRole("meter")) {
      expect(meter).toHaveAttribute("aria-valuemin", "-100");
      expect(meter).toHaveAttribute("aria-valuemax", "100");
    }
    rerender(<CountryOverlay model={{...model, relationship: {
      playerToForeign: {...relationship.playerToForeign, score: 0, dataAvailable: true},
      foreignToPlayer: {...relationship.foreignToPlayer, score: null, dataAvailable: false},
    }}} onOpenPolitics={vi.fn()} onOpenDiplomacy={vi.fn()}/>);
    expect(screen.getByRole("meter", {name: "AAA → BBB 관계"})).toHaveAttribute("aria-valuenow", "0");
    expect(screen.queryByRole("meter", {name: "BBB → AAA 관계"})).not.toBeInTheDocument();
  });

  it("renders the no-target empty state", () => {
    render(<DiplomacyOverlay model={channel("disconnected", {counterpart: null, relationship: null})} onSelectCountry={vi.fn()}/>);
    expect(screen.getByRole("heading", {name: "외교 대상 선택"})).toBeVisible();
  });

  it("allows a local draft but never sends through a missing port", async () => {
    const user = userEvent.setup();
    const onSelectCountry = vi.fn();
    const model = channel("disconnected", {connectionMessage: "외교 채널 API 연결 예정"});
    render(<DiplomacyOverlay model={model} onSelectCountry={onSelectCountry}/>);
    const composer = screen.getByRole("textbox", {name: "외교 메시지"});
    await user.type(composer, "협상을 제안합니다.");
    expect(composer).toHaveValue("협상을 제안합니다.");
    await user.click(screen.getByRole("button", {name: "제안"}));
    expect(screen.getByRole("button", {name: "제안"})).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", {name: "전송"})).toBeDisabled();
    expect(screen.getByText("외교 채널 API 연결 예정")).toBeVisible();
  });

  it.each([
    ["disconnected", "외교 채널 API 연결 예정"],
    ["connecting", "외교 채널 연결 중"],
    ["ready", "외교 채널 사용 가능"],
    ["sending", "메시지 전달 중"],
    ["error", "외교 채널 오류"],
  ] as const)("renders the %s connection state without a production send handler", (state, label) => {
    render(<DiplomacyOverlay model={channel(state)} onSelectCountry={vi.fn()}/>);
    expect(screen.getByText(label)).toBeVisible();
    expect(screen.getByText(`상태 상세: ${state}`)).toBeVisible();
    expect(screen.getByRole("button", {name: "전송"})).toBeDisabled();
    if (state === "error") expect(screen.queryByText("미연결")).not.toBeInTheDocument();
  });

  it("locks composer and quick intent changes while sending", () => {
    render(<DiplomacyOverlay model={channel("sending")} onSelectCountry={vi.fn()} onSend={vi.fn()}/>);
    expect(screen.getByRole("textbox", {name: "외교 메시지"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "제안"})).toBeDisabled();
    expect(screen.getByRole("button", {name: "전송"})).toBeDisabled();
  });

  it("renders player, foreign and system transcript roles with timestamps", () => {
    const transcript = [
      {messageId: "hidden.player", role: "player", text: "플레이어 메시지", createdAt: "2020-01-02T10:00:00Z"},
      {messageId: "hidden.foreign", role: "foreign", text: "상대국 메시지", createdAt: "2020-01-02T10:01:00Z"},
      {messageId: "hidden.system", role: "system", text: "시스템 메시지", createdAt: "2020-01-02T10:02:00Z"},
    ] as const;
    const {container} = render(<DiplomacyOverlay model={channel("ready", {transcript})} onSelectCountry={vi.fn()}/>);
    expect(container.querySelectorAll('[data-role="player"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-role="foreign"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-role="system"]')).toHaveLength(1);
    expect(screen.getByText("플레이어")).toBeVisible();
    expect(screen.getByText("상대국")).toBeVisible();
    expect(screen.getByText("시스템")).toBeVisible();
    expect(screen.getByText("2020-01-02T10:00:00Z")).toHaveAttribute("datetime", "2020-01-02T10:00:00Z");
    expect(screen.queryByText("hidden.player")).not.toBeInTheDocument();
  });

  it("sends the exact ready request through only the optional diplomacy boundary", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    render(<DiplomacyOverlay model={channel("ready")} onSelectCountry={vi.fn()} onSend={onSend}/>);
    const send = screen.getByRole("button", {name: "전송"});
    expect(send).toBeDisabled();
    await user.type(screen.getByRole("textbox", {name: "외교 메시지"}), "원문 그대로 전달");
    await user.click(screen.getByRole("button", {name: "제안"}));
    expect(send).toBeEnabled();
    await user.click(send);
    await waitFor(() => expect(onSend).toHaveBeenCalledOnce());
    expect(onSend.mock.calls[0][0]).toEqual({counterpartCountryId: "BBB", text: "원문 그대로 전달", intentId: "proposal"});
    expect(onSend.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", {name: "대화 기록 없음"})).toBeVisible();
    expect(screen.getByRole("region", {name: "외교 대화 기록"})).not.toHaveTextContent("원문 그대로 전달");
  });

  it("requires model permission in addition to a ready channel, target, draft and handler", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<DiplomacyOverlay model={channel("ready", {canSend: false})} onSelectCountry={vi.fn()} onSend={onSend}/>);
    await user.type(screen.getByRole("textbox", {name: "외교 메시지"}), "권한 없는 요청");
    const send = screen.getByRole("button", {name: "전송"});
    expect(send).toBeDisabled();
    await user.click(send);
    expect(onSend).not.toHaveBeenCalled();
  });
});
