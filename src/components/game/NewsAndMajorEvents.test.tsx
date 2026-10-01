import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {afterEach, describe, expect, it, vi} from "vitest";

import type {GameNewsViewModel, ProjectedNewsItem} from "@/lib/game-ui/news-projection";
import type {MajorEventQueueEntry} from "@/lib/game-ui/major-event-queue";
import type {ActiveCountryId} from "@/lib/world/country-id";
import {MajorEventModal} from "./MajorEventModal";
import {NewsOverlay} from "./NewsOverlay";

afterEach(cleanup);

const newsItems: readonly ProjectedNewsItem[] = [
  {eventId: "major", date: "2020-01-03", title: "Major title", narrative: "Major narrative", category: "military", significance: "major", relatedCountryIds: ["AAA" as ActiveCountryId], acknowledged: true, mapChangeAvailable: true},
  {eventId: "minor", date: "2020-01-02", title: "Minor title", narrative: "Minor narrative", category: "domestic", significance: "minor", relatedCountryIds: ["BBB" as ActiveCountryId], acknowledged: false, mapChangeAvailable: false},
];

const newsModel: GameNewsViewModel = {
  dataAvailable: true,
  unavailableReason: null,
  selectedEventId: "major",
  selected: null,
  items: newsItems,
  turnResult: {turnId: "turn", period: "period", outcomes: ["outcome"], eventIds: ["major"], reactions: ["reaction"], mapChanges: ["map change"], continuing: ["continuing"], advisorSummary: "advisor"},
};

describe("13-24 news UI", () => {
  it("filters the list, keeps detail within the filter, navigates countries, and renders the split result", async () => {
    const user = userEvent.setup();
    const onOpenCountry = vi.fn();
    render(<NewsOverlay model={newsModel} onSelectEvent={vi.fn()} onOpenCountry={onOpenCountry}/>);
    await user.click(screen.getByRole("button", {name: "일반"}));
    expect(screen.queryByText("Major title")).not.toBeInTheDocument();
    expect(screen.getAllByText("Minor title")).toHaveLength(2);
    await user.click(screen.getByRole("button", {name: "BBB 보기"}));
    expect(onOpenCountry).toHaveBeenCalledWith("BBB");
    expect(screen.getByRole("heading", {name: "period"})).toBeInTheDocument();
    expect(screen.getByText("outcome")).toBeInTheDocument();
    expect(screen.getByText("reaction")).toBeInTheDocument();
    expect(screen.getByText("map change")).toBeInTheDocument();
    expect(screen.getByText("continuing")).toBeInTheDocument();
    expect(screen.getByText("advisor")).toBeInTheDocument();
  });

  it("shows retired related countries without opening a stale country overlay", async () => {
    const user = userEvent.setup();
    const onOpenCountry = vi.fn();
    render(<NewsOverlay model={newsModel} activeCountryIds={new Set(["AAA"])} onSelectEvent={vi.fn()} onOpenCountry={onOpenCountry}/>);
    await user.click(screen.getByRole("button", {name: "일반"}));
    const retired = screen.getByRole("button", {name: "BBB · 퇴역 국가"});
    expect(retired).toBeDisabled();
    await user.click(retired);
    expect(onOpenCountry).not.toHaveBeenCalled();
  });
});

const entry: MajorEventQueueEntry = {
  key: "turn:event",
  turnId: "turn",
  ordinal: 2,
  total: 3,
  event: {eventId: "event", date: "2020-02-02", title: "Blocking event", narrative: "Blocking narrative", countryIds: ["AAA"], category: "territorial", significance: "transformative", hasMapChanges: true},
};

describe("13-26 blocking major event modal", () => {
  it("traps focus, ignores Escape, exposes progress/map context, and acknowledges explicitly", async () => {
    const user = userEvent.setup();
    const onViewOnMap = vi.fn();
    const onAcknowledge = vi.fn();
    render(<MajorEventModal entry={entry} countryNames={{AAA: "Alpha"}} onViewOnMap={onViewOnMap} onAcknowledge={onAcknowledge}/>);
    const acknowledge = screen.getByRole("button", {name: "확인"});
    const viewMap = screen.getByRole("button", {name: "지도에서 보기"});
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    expect(screen.getByText(/2 \/ 3/)).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(acknowledge).toHaveFocus();
    fireEvent.keyDown(document, {key: "Escape"});
    expect(onAcknowledge).not.toHaveBeenCalled();
    expect(acknowledge).toHaveFocus();
    await user.tab();
    expect(viewMap).toHaveFocus();
    await user.click(viewMap);
    expect(onViewOnMap).toHaveBeenCalledWith("AAA");
    await user.click(acknowledge);
    expect(onAcknowledge).toHaveBeenCalledOnce();
  });

  it("restores focus when the modal is removed", () => {
    const launcher = document.createElement("button");
    document.body.append(launcher);
    launcher.focus();
    const {unmount} = render(<MajorEventModal entry={entry} countryNames={{AAA: "Alpha"}} onViewOnMap={vi.fn()} onAcknowledge={vi.fn()}/>);
    unmount();
    expect(launcher).toHaveFocus();
    launcher.remove();
  });
});
